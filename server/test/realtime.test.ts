import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import { addUser, api, closeApp, createApp, setupOwner, waitFor, type Session } from './helpers.ts';

let app: FastifyInstance;
let url: string;
let owner: Session;
let alice: Session;
let bob: Session;
let carol: Session;
let db: typeof import('../src/db.ts');
const sockets: Socket[] = [];

interface Client {
  socket: Socket;
  events: [string, any][];
  /** events of a kind received so far */
  of(name: string): any[];
  /** waits for an event matching the predicate (also considers already received ones) */
  wait(name: string, pred?: (p: any) => boolean, timeout?: number): Promise<any>;
  clear(): void;
}

function connect(token: string | undefined, opts: Record<string, any> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, forceNew: true, auth: token ? { token } : {}, ...opts });
    sockets.push(socket);
    const events: [string, any][] = [];
    socket.onAny((name, payload) => events.push([name, payload]));
    const client: Client = {
      socket,
      events,
      of: (name) => events.filter((e) => e[0] === name).map((e) => e[1]),
      wait: async (name, pred = () => true, timeout = 3000) => (await waitFor(() => events.find((e) => e[0] === name && pred(e[1])), timeout))[1],
      clear: () => {
        events.length = 0;
      },
    };
    socket.on('connect', () => resolve(client));
    socket.on('connect_error', (e) => reject(e));
  });
}

before(async () => {
  ({ app } = await createApp());
  db = await import('../src/db.ts');
  const { startJobs } = await import('../src/jobs.ts');
  startJobs();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  url = `http://127.0.0.1:${addr.port}`;
  owner = await setupOwner(app);
  alice = await addUser(app, owner.token, { name: 'Alice', email: 'alice@example.com' });
  bob = await addUser(app, owner.token, { name: 'Bob', email: 'bob@example.com' });
  carol = await addUser(app, owner.token, { name: 'Carol', email: 'carol@example.com' });
});
after(async () => {
  for (const s of sockets) s.disconnect();
  await closeApp(app);
});

const send = (s: Session, channelId: string, text: string, extra: Record<string, unknown> = {}) => api(app, s.token).post(`/api/channels/${channelId}/messages`, { text, ...extra });

describe('connection', () => {
  test('rejects missing or invalid tokens', async () => {
    await assert.rejects(connect(undefined), /not_authenticated/);
    await assert.rejects(connect('bogus'), /not_authenticated/);
  });

  test('a malformed cookie is rejected without crashing the server', async () => {
    await assert.rejects(connect(undefined, { extraHeaders: { cookie: 'relay_session=%E0%A4%A' } }), /not_authenticated/);
    assert.equal((await api(app).get('/api/health')).status, 200);
  });

  test('a cookie header without the session cookie is rejected', async () => {
    await assert.rejects(connect(undefined, { extraHeaders: { cookie: 'theme=dark; lang=en' } }), /not_authenticated/);
  });

  test('accepts the session cookie', async () => {
    const c = await connect(undefined, { extraHeaders: { cookie: `other=1; relay_session=${encodeURIComponent(alice.token)}` } });
    assert.ok(c.socket.connected);
    c.socket.disconnect();
  });
});

describe('messages & typing', () => {
  test('message:new only reaches channel members', async () => {
    const a = await connect(alice.token);
    const b = await connect(bob.token);
    const c = await connect(carol.token);
    const priv = (await api(app, alice.token).post('/api/channels', { name: 'rt-private', isPrivate: true, memberIds: [bob.me.id] })).body;
    // bob was added after connecting -> his socket joined the room
    await b.wait('channel:upsert', (ch) => ch.id === priv.id);
    const m = (await send(alice, priv.id, 'secret sauce')).body;
    const got = await b.wait('message:new', (x) => x.id === m.id);
    assert.equal(got.text, 'secret sauce');
    await a.wait('message:new', (x) => x.id === m.id);
    // marker message in a public channel carol is in proves ordering: carol received that but not the private one
    const general = (await api(app, carol.token).get('/api/bootstrap')).body.channels.find((x: any) => x.name === 'general');
    const marker = (await send(alice, general.id, 'marker')).body;
    await c.wait('message:new', (x) => x.id === marker.id);
    assert.ok(!c.of('message:new').some((x) => x.id === m.id));
    assert.ok(!c.of('channel:upsert').some((x) => x.id === priv.id));

    // membership update for the author (own message marks the channel read)
    await a.wait('membership:upsert', (x) => x.channelId === priv.id && x.lastRead === m.id);

    // edits and deletes
    await api(app, alice.token).patch(`/api/messages/${m.id}`, { text: 'secret sauce v2' });
    assert.equal((await b.wait('message:updated', (x) => x.id === m.id)).text, 'secret sauce v2');
    await api(app, alice.token).del(`/api/messages/${m.id}`);
    assert.deepEqual(await b.wait('message:deleted', (x) => x.id === m.id), { id: m.id, channelId: priv.id, threadRootId: null });

    // removed from a private channel -> channel:removed and no more messages
    await api(app, alice.token).del(`/api/channels/${priv.id}/members/${bob.me.id}`);
    await b.wait('channel:removed', (x) => x.channelId === priv.id);
    const m2 = (await send(alice, priv.id, 'after bob left')).body;
    const marker2 = (await send(alice, general.id, 'marker 2')).body;
    await b.wait('message:new', (x) => x.id === marker2.id);
    assert.ok(!b.of('message:new').some((x) => x.id === m2.id));

    // leaving a public channel sends the channel again (not removed)
    const pub = (await api(app, alice.token).post('/api/channels', { name: 'rt-public', memberIds: [bob.me.id] })).body;
    b.clear();
    await api(app, bob.token).post(`/api/channels/${pub.id}/leave`);
    await b.wait('channel:upsert', (x) => x.id === pub.id && !x.memberIds.includes(bob.me.id));
    a.socket.disconnect();
    b.socket.disconnect();
    c.socket.disconnect();
  });

  test('typing is relayed to other members only', async () => {
    const a = await connect(alice.token);
    const b = await connect(bob.token);
    const c = await connect(carol.token);
    const ch = (await api(app, alice.token).post('/api/channels', { name: 'rt-typing', memberIds: [bob.me.id] })).body;
    await b.wait('channel:upsert', (x) => x.id === ch.id);
    a.socket.emit('typing', { channelId: ch.id, threadRootId: null });
    assert.deepEqual(await b.wait('typing'), { channelId: ch.id, threadRootId: null, userId: alice.me.id });
    // carol is not a member: emitting is ignored, and she does not receive alice's
    c.socket.emit('typing', { channelId: ch.id, threadRootId: null });
    c.socket.emit('typing', null);
    a.socket.emit('typing', { channelId: ch.id, threadRootId: 7 });
    await b.wait('typing', (p) => p.threadRootId === 7);
    assert.equal(c.of('typing').length, 0);
    assert.ok(b.of('typing').every((p) => p.userId === alice.me.id));
    assert.equal(a.of('typing').length, 0); // not echoed to the sender
    a.socket.disconnect();
    b.socket.disconnect();
    c.socket.disconnect();
  });

  test('read markers and saved items are pushed to all of the user’s sockets', async () => {
    const b1 = await connect(bob.token);
    const b2 = await connect(bob.token);
    const general = (await api(app, bob.token).get('/api/bootstrap')).body.channels.find((x: any) => x.name === 'general');
    const m = (await send(alice, general.id, 'read me')).body;
    await api(app, bob.token).put(`/api/channels/${general.id}/read`, { messageId: m.id });
    for (const s of [b1, b2]) await s.wait('membership:upsert', (x) => x.channelId === general.id && x.lastRead === m.id && x.unread === 0);
    await api(app, bob.token).post(`/api/messages/${m.id}/save`);
    await b2.wait('saved:changed', (x) => x.messageId === m.id && x.saved);
    await api(app, bob.token).put('/api/drafts', { channelId: general.id, text: 'draft' });
    await b1.wait('draft:changed', (x) => x.text === 'draft');
    await api(app, bob.token).put(`/api/messages/${m.id}/thread/read`, { messageId: m.id });
    await b1.wait('thread:read', (x) => x.rootId === m.id);
    b1.socket.disconnect();
    b2.socket.disconnect();
  });

  test('mentions create live activity; @here only reaches online members', async () => {
    const ch = (await api(app, alice.token).post('/api/channels', { name: 'rt-here', memberIds: [bob.me.id, carol.me.id] })).body;
    const b = await connect(bob.token);
    await send(alice, ch.id, 'ping <!here>');
    const act = await b.wait('activity:new', (x) => x.kind === 'mention' && x.channelId === ch.id);
    assert.equal(act.actorId, alice.me.id);
    assert.equal((await api(app, bob.token).get(`/api/channels/${ch.id}`)).body.membership.mentions, 1);
    assert.equal((await api(app, carol.token).get(`/api/channels/${ch.id}`)).body.membership.mentions, 0);
    b.socket.disconnect();
  });
});

describe('presence', () => {
  test('connect/disconnect, manual away and presence:active', async () => {
    const o = await connect(owner.token);
    const c = await connect(carol.token);
    await o.wait('presence', (p) => p.userId === carol.me.id && p.presence === 'active');
    const boot = (await api(app, owner.token).get('/api/bootstrap')).body;
    assert.equal(boot.presence[carol.me.id], 'active');

    // second socket of the same user does not re-broadcast; closing one keeps them online
    const c2 = await connect(carol.token);
    c2.socket.disconnect();
    await api(app, carol.token).put('/api/users/me/presence', { away: true });
    await o.wait('presence', (p) => p.userId === carol.me.id && p.presence === 'away');
    await c.wait('me:updated', (m) => m.awayManual === true);
    await api(app, carol.token).put('/api/users/me/presence', { away: false });
    o.clear();
    c.socket.emit('presence:active');
    await o.wait('presence', (p) => p.userId === carol.me.id && p.presence === 'active');

    o.clear();
    c.socket.disconnect();
    await o.wait('presence', (p) => p.userId === carol.me.id && p.presence === 'away');
    assert.equal((await api(app, owner.token).get('/api/bootstrap')).body.presence[carol.me.id], undefined);
    o.socket.disconnect();
  });

  test('profile changes are broadcast', async () => {
    const o = await connect(owner.token);
    await api(app, carol.token).patch('/api/users/me', { title: 'Boss' });
    assert.equal((await o.wait('user:upsert', (u) => u.id === carol.me.id && u.title === 'Boss')).email, undefined);
    await api(app, owner.token).patch('/api/workspace', { name: 'Renamed' });
    await o.wait('workspace:updated', (w) => w.name === 'Renamed');
    o.socket.disconnect();
  });
});

describe('huddles', () => {
  test('join, state, media, signal, leave, history and automatic status', async () => {
    const ch = (await api(app, alice.token).post('/api/channels', { name: 'rt-huddle', memberIds: [bob.me.id] })).body;
    const a = await connect(alice.token);
    const b = await connect(bob.token);
    const c = await connect(carol.token);

    // non-members can't join
    const denied = await c.socket.emitWithAck('huddle:join', { channelId: ch.id });
    assert.deepEqual(denied, { ok: false, error: 'not_in_channel' });

    assert.deepEqual(await a.socket.emitWithAck('huddle:join', { channelId: ch.id }), { ok: true });
    const st = await b.wait('huddle:state', (h) => h.channelId === ch.id);
    const rt = await import('../src/realtime.ts');
    assert.equal(rt.huddleOf(alice.me.id), ch.id);
    assert.equal(rt.huddleOf(carol.me.id), null);
    assert.equal(rt.isOnline(alice.me.id), true);
    assert.equal(rt.isOnline(owner.me.id), false);
    assert.deepEqual(st.participants, [{ userId: alice.me.id, muted: false, sharing: false, video: false }]);
    // channels have a permanent voice room: a session row is started, but no "huddle" system message is posted
    assert.equal(db.get("SELECT 1 FROM messages WHERE channel_id = ? AND subtype = 'huddle'", ch.id), undefined);
    const session = db.get<any>('SELECT * FROM huddle_sessions WHERE channel_id = ?', ch.id);
    assert.equal(session.started_by, alice.me.id);
    assert.equal(session.ended_at, null);
    // automatic status
    const me = await a.wait('me:updated', (m) => m.statusText === 'In a huddle');
    assert.equal(me.statusEmoji, 'headphones');
    // the active huddle is part of bootstrap for members only
    assert.equal((await api(app, bob.token).get('/api/bootstrap')).body.huddles.length, 1);
    assert.equal((await api(app, carol.token).get('/api/bootstrap')).body.huddles.length, 0);

    // bob has a custom status that must survive
    await api(app, bob.token).put('/api/users/me/status', { emoji: 'coffee', text: 'Coffee' });
    assert.deepEqual(await b.socket.emitWithAck('huddle:join', { channelId: ch.id }), { ok: true });
    await a.wait('huddle:state', (h) => h.participants.length === 2);
    const participants = JSON.parse(db.get<any>('SELECT participants FROM huddle_sessions WHERE channel_id = ?', ch.id).participants);
    assert.deepEqual(participants.sort(), [alice.me.id, bob.me.id].sort());
    // joining twice is idempotent
    await b.socket.emitWithAck('huddle:join', { channelId: ch.id });
    assert.equal((await a.wait('huddle:state', (h) => h.participants.length === 2)).participants.length, 2);

    b.socket.emit('huddle:media', { channelId: ch.id, muted: true, sharing: true, video: true });
    const media = await a.wait('huddle:state', (h) => h.participants.some((p: any) => p.userId === bob.me.id && p.muted && p.sharing && p.video));
    assert.ok(media);
    c.socket.emit('huddle:media', { channelId: ch.id, muted: true, sharing: false }); // not a participant: ignored

    a.socket.emit('huddle:signal', { to: bob.me.id, channelId: ch.id, data: { sdp: 'offer' } });
    assert.deepEqual(await b.wait('huddle:signal'), { from: alice.me.id, channelId: ch.id, data: { sdp: 'offer' } });
    c.socket.emit('huddle:signal', { to: bob.me.id, channelId: ch.id, data: 'spoof' });
    c.socket.emit('huddle:signal', { to: bob.me.id });

    // bob leaves -> his custom status is untouched
    b.socket.emit('huddle:leave', { channelId: ch.id });
    await a.wait('huddle:state', (h) => h.participants.length === 1);
    assert.equal(db.get<any>('SELECT status_text FROM users WHERE id = ?', bob.me.id).status_text, 'Coffee');
    assert.ok(!b.of('huddle:signal').some((s) => s.data === 'spoof'));

    // alice leaves -> huddle ends, session closed, status cleared
    a.socket.emit('huddle:leave', { channelId: ch.id });
    await b.wait('huddle:ended', (p) => p.channelId === ch.id);
    await waitFor(() => db.get<any>('SELECT ended_at FROM huddle_sessions WHERE channel_id = ?', ch.id).ended_at);
    await a.wait('me:updated', (m) => m.statusText === '' && m.statusEmoji === '');
    const history = (await api(app, bob.token).get('/api/huddles')).body.find((h: any) => h.channelId === ch.id);
    assert.ok(history.endedAt >= history.startedAt);

    a.socket.disconnect();
    b.socket.disconnect();
    c.socket.disconnect();
  });

  test('a call in a DM posts a "huddle" message', async () => {
    const a = await connect(alice.token);
    const b = await connect(bob.token);
    try {
      const dm = (await api(app, alice.token).post('/api/dms', { userIds: [bob.me.id] })).body.channel;
      await b.wait('channel:upsert', (c) => c.id === dm.id);
      assert.deepEqual(await a.socket.emitWithAck('huddle:join', { channelId: dm.id }), { ok: true });
      const m = await b.wait('message:new', (x) => x.channelId === dm.id && x.subtype === 'huddle');
      assert.equal(m.userId, alice.me.id);
      // joining an already running call does not post again
      await b.socket.emitWithAck('huddle:join', { channelId: dm.id });
      await a.wait('huddle:state', (h) => h.channelId === dm.id && h.participants.length === 2);
      assert.equal(db.all("SELECT 1 FROM messages WHERE channel_id = ? AND subtype = 'huddle'", dm.id).length, 1);
      a.socket.emit('huddle:leave', { channelId: dm.id });
      b.socket.emit('huddle:leave', { channelId: dm.id });
      await a.wait('huddle:ended', (p) => p.channelId === dm.id);
      await waitFor(() => db.get('SELECT 1 FROM huddle_sessions WHERE channel_id = ? AND ended_at IS NOT NULL', dm.id));
    } finally {
      a.socket.disconnect();
      b.socket.disconnect();
    }
  });

  test('switching huddles leaves the previous one; disconnect and leaving the channel end it', async () => {
    const ch1 = (await api(app, alice.token).post('/api/channels', { name: 'rt-huddle-1' })).body;
    const ch2 = (await api(app, alice.token).post('/api/channels', { name: 'rt-huddle-2', memberIds: [bob.me.id] })).body;
    const a = await connect(alice.token);
    await a.socket.emitWithAck('huddle:join', { channelId: ch1.id });
    await a.socket.emitWithAck('huddle:join', { channelId: ch2.id });
    await a.wait('huddle:ended', (p) => p.channelId === ch1.id);
    await a.wait('me:updated', (m) => m.statusText === 'In a huddle');

    // leaving the channel ends the huddle in it
    const b = await connect(bob.token);
    await b.socket.emitWithAck('huddle:join', { channelId: ch2.id });
    await api(app, bob.token).post(`/api/channels/${ch2.id}/leave`);
    await a.wait('huddle:state', (h) => h.channelId === ch2.id && h.participants.length === 1 && h.participants[0].userId === alice.me.id);

    // disconnecting the last socket ends it as well
    a.socket.disconnect();
    const o = await connect(owner.token);
    await api(app, owner.token).post(`/api/channels/${ch2.id}/join`);
    await waitFor(() => db.get<any>('SELECT 1 AS x FROM huddle_sessions WHERE channel_id = ? AND ended_at IS NOT NULL', ch2.id));
    assert.equal(db.get<any>('SELECT status_text FROM users WHERE id = ?', alice.me.id).status_text, '');
    o.socket.disconnect();
    b.socket.disconnect();
  });
});

describe('session revocation', () => {
  test('logout revokes the socket of that session only', async () => {
    const s1 = (await api(app).post('/api/auth/login', { email: 'carol@example.com', password: 'password123' })).body.token;
    const s2 = (await api(app).post('/api/auth/login', { email: 'carol@example.com', password: 'password123' })).body.token;
    const c1 = await connect(s1);
    const c2 = await connect(s2);
    const disconnected = new Promise((r) => c1.socket.on('disconnect', r));
    await api(app, s1).post('/api/auth/logout');
    await c1.wait('session:revoked');
    await disconnected;
    assert.ok(c2.socket.connected);
    assert.equal(c2.of('session:revoked').length, 0);
    await assert.rejects(connect(s1), /not_authenticated/);

    // logout-others revokes the others
    const s3 = (await api(app).post('/api/auth/login', { email: 'carol@example.com', password: 'password123' })).body.token;
    await api(app, s3).post('/api/auth/logout-others');
    await c2.wait('session:revoked');
  });

  test('deactivating a user disconnects all of their sockets', async () => {
    const victim = await addUser(app, owner.token);
    const v = await connect(victim.token);
    await api(app, owner.token).patch(`/api/users/${victim.me.id}`, { deactivated: true });
    await v.wait('session:revoked');
    await waitFor(() => !v.socket.connected);
  });
});

describe('jobs on start', () => {
  test('startJobs closes stale huddle sessions and clears stale huddle statuses', async () => {
    const { startJobs } = await import('../src/jobs.ts');
    const ch = (await api(app, alice.token).post('/api/channels', { name: 'rt-stale' })).body;
    db.run('INSERT INTO huddle_sessions (channel_id, started_at) VALUES (?, ?)', ch.id, Date.now() - 1000);
    db.run("UPDATE users SET status_emoji = 'headphones', status_text = 'In a huddle', prefs = ? WHERE id = ?", JSON.stringify({ autoHuddleStatus: true }), carol.me.id);
    startJobs();
    assert.ok(db.get<any>('SELECT ended_at FROM huddle_sessions WHERE channel_id = ?', ch.id).ended_at);
    assert.equal(db.get<any>('SELECT status_text FROM users WHERE id = ?', carol.me.id).status_text, '');
  });
});
