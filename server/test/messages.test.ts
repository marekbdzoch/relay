import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { addUser, api, closeApp, createApp, png, setupOwner, type Session } from './helpers.ts';

let app: FastifyInstance;
let dataDir: string;
let owner: Session;
let alice: Session;
let bob: Session;
let carol: Session;
let db: typeof import('../src/db.ts');
let jobs: typeof import('../src/jobs.ts');

before(async () => {
  ({ app, dataDir } = await createApp());
  db = await import('../src/db.ts');
  jobs = await import('../src/jobs.ts');
  owner = await setupOwner(app);
  alice = await addUser(app, owner.token, { name: 'Alice', email: 'alice@example.com' });
  bob = await addUser(app, owner.token, { name: 'Bob', email: 'bob@example.com' });
  carol = await addUser(app, owner.token, { name: 'Carol', email: 'carol@example.com' });
});
after(() => closeApp(app));

const send = (s: Session, channelId: string, text: string, extra: Record<string, unknown> = {}) => api(app, s.token).post(`/api/channels/${channelId}/messages`, { text, ...extra });
const newChannel = async (name: string, creator: Session, members: Session[] = [], isPrivate = false) =>
  (await api(app, creator.token).post('/api/channels', { name, isPrivate, memberIds: members.map((m) => m.me.id) })).body;
const listMsgs = async (s: Session, channelId: string, q = '') => (await api(app, s.token).get(`/api/channels/${channelId}/messages${q}`)).body;

describe('posting', () => {
  test('validation and membership', async () => {
    const ch = await newChannel('posting', alice, [bob]);
    assert.equal((await send(alice, ch.id, '   ')).body.error, 'empty_message');
    assert.equal((await send(alice, ch.id, 'x'.repeat(40001))).status, 400);
    assert.equal((await send(carol, ch.id, 'not a member')).body.error, 'not_in_channel');
    assert.equal((await send(alice, 'NOPE', 'x')).status, 404);
    const r = await send(alice, ch.id, 'Hello *world*', { clientId: 'c-123' });
    assert.equal(r.status, 200);
    assert.equal(r.body.text, 'Hello *world*');
    assert.equal(r.body.clientId, 'c-123');
    assert.equal(r.body.userId, alice.me.id);
    assert.equal(r.body.threadRootId, null);
    assert.deepEqual(r.body.reactions, []);
    const one = await api(app, bob.token).get(`/api/messages/${r.body.id}`);
    assert.equal(one.body.id, r.body.id);
    assert.equal((await api(app, bob.token).get('/api/messages/999999')).status, 404);
    // reading a message in a private channel requires membership
    const priv = await newChannel('posting-private', alice, [], true);
    const pm = (await send(alice, priv.id, 'secret')).body;
    assert.equal((await api(app, bob.token).get(`/api/messages/${pm.id}`)).status, 403);
  });

  test('pagination: latest, before, after, around', async () => {
    const ch = await newChannel('paging', alice);
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) ids.push((await send(alice, ch.id, `m${i}`)).body.id);
    const latest = await listMsgs(alice, ch.id, '?limit=3');
    assert.deepEqual(latest.messages.map((m: any) => m.text), ['m7', 'm8', 'm9']);
    assert.equal(latest.hasMoreBefore, true);
    assert.equal(latest.hasMoreAfter, false);

    const before = await listMsgs(alice, ch.id, `?limit=3&before=${ids[3]}`);
    assert.deepEqual(before.messages.map((m: any) => m.text), ['m0', 'm1', 'm2']);
    assert.equal(before.hasMoreBefore, false);

    const afterPage = await listMsgs(alice, ch.id, `?limit=4&after=${ids[5]}`);
    assert.deepEqual(afterPage.messages.map((m: any) => m.text), ['m6', 'm7', 'm8', 'm9']);
    assert.equal(afterPage.hasMoreAfter, false);
    const afterPage2 = await listMsgs(alice, ch.id, `?limit=2&after=${ids[5]}`);
    assert.equal(afterPage2.hasMoreAfter, true);
    assert.equal(afterPage2.hasMoreBefore, true);

    const around = await listMsgs(alice, ch.id, `?limit=4&around=${ids[5]}`);
    assert.deepEqual(around.messages.map((m: any) => m.text), ['m4', 'm5', 'm6', 'm7']);
    assert.equal(around.hasMoreBefore, true);
    assert.equal(around.hasMoreAfter, true);

    assert.equal((await api(app, alice.token).get(`/api/channels/${ch.id}/messages?limit=500`)).status, 400);
    assert.equal((await api(app, alice.token).get(`/api/channels/${ch.id}/messages?before=abc`)).status, 400);
  });
});

describe('edit & delete', () => {
  test('only the author edits; system messages are immutable', async () => {
    const ch = await newChannel('editing', alice, [bob]);
    const m = (await send(alice, ch.id, 'tpyo')).body;
    assert.equal((await api(app, bob.token).patch(`/api/messages/${m.id}`, { text: 'hacked' })).body.error, 'not_author');
    assert.equal((await api(app, owner.token).patch(`/api/messages/${m.id}`, { text: 'admin' })).status, 403);
    const e = await api(app, alice.token).patch(`/api/messages/${m.id}`, { text: 'typo' });
    assert.equal(e.body.text, 'typo');
    assert.ok(e.body.editedAt);
    const join = (await listMsgs(bob, ch.id)).messages.find((x: any) => x.subtype === 'join');
    assert.equal((await api(app, bob.token).patch(`/api/messages/${join.id}`, { text: 'x' })).status, 403);
    assert.equal((await api(app, alice.token).patch('/api/messages/999999', { text: 'x' })).status, 404);
  });

  test('delete: author or admin; placeholder kept while replies exist', async () => {
    const ch = await newChannel('deleting', alice, [bob, carol]);
    const plain = (await send(bob, ch.id, 'bye')).body;
    assert.equal((await api(app, carol.token).del(`/api/messages/${plain.id}`)).status, 403);
    assert.equal((await api(app, owner.token).post(`/api/channels/${ch.id}/join`)).status, 200);
    assert.equal((await api(app, owner.token).del(`/api/messages/${plain.id}`)).status, 200); // admin
    assert.equal((await api(app, bob.token).del(`/api/messages/${plain.id}`)).status, 404); // already gone
    assert.ok(!(await listMsgs(alice, ch.id)).messages.some((m: any) => m.id === plain.id));

    const root = (await send(alice, ch.id, 'root')).body;
    const r1 = (await send(bob, ch.id, 'reply 1', { threadRootId: root.id })).body;
    const r2 = (await send(carol, ch.id, 'reply 2', { threadRootId: root.id })).body;
    await api(app, bob.token).post(`/api/messages/${root.id}/reactions`, { emoji: 'tada' });
    await api(app, bob.token).post(`/api/messages/${root.id}/pin`);
    await api(app, bob.token).post(`/api/messages/${root.id}/save`);

    assert.equal((await api(app, alice.token).del(`/api/messages/${root.id}`)).status, 200);
    let rootMsg = (await listMsgs(alice, ch.id)).messages.find((m: any) => m.id === root.id);
    assert.equal(rootMsg.deleted, true);
    assert.equal(rootMsg.text, '');
    assert.deepEqual(rootMsg.reactions, []);
    assert.equal(rootMsg.pinnedBy, null);
    assert.equal(rootMsg.replyCount, 2);
    assert.equal((await api(app, bob.token).get('/api/saved/count')).body.count, 0);

    // deleting a reply updates the root counters
    await api(app, carol.token).del(`/api/messages/${r2.id}`);
    rootMsg = (await api(app, alice.token).get(`/api/messages/${root.id}`)).body;
    assert.equal(rootMsg.replyCount, 1);
    assert.deepEqual(rootMsg.replyUserIds, [bob.me.id]);
    assert.equal(rootMsg.lastReplyAt, r1.createdAt);
    // last reply gone -> the deleted root disappears from the channel
    await api(app, bob.token).del(`/api/messages/${r1.id}`);
    assert.ok(!(await listMsgs(alice, ch.id)).messages.some((m: any) => m.id === root.id));
    rootMsg = (await api(app, alice.token).get(`/api/messages/${root.id}`)).body;
    assert.equal(rootMsg.replyCount, 0);
    assert.equal(rootMsg.lastReplyAt, null);
  });
});

describe('threads', () => {
  test('replies, followers, alsoInChannel, read state and the threads view', async () => {
    const ch = await newChannel('threads', alice, [bob, carol]);
    const root = (await send(alice, ch.id, 'Discuss')).body;
    const r1 = (await send(bob, ch.id, 'my take', { threadRootId: root.id })).body;
    assert.equal(r1.threadRootId, root.id);
    const r2 = (await send(carol, ch.id, `also in channel <@${alice.me.id}>`, { threadRootId: root.id, alsoInChannel: true })).body;
    assert.equal(r2.alsoInChannel, true);
    const r3 = (await send(bob, ch.id, 'second take', { threadRootId: root.id })).body;

    // replies are not in the channel unless broadcast
    const texts = (await listMsgs(alice, ch.id)).messages.map((m: any) => m.text);
    assert.ok(texts.includes(r2.text));
    assert.ok(!texts.includes('my take'));

    const thread = await api(app, alice.token).get(`/api/messages/${root.id}/thread`);
    assert.equal(thread.body.root.replyCount, 3);
    assert.deepEqual(thread.body.root.replyUserIds, [carol.me.id, bob.me.id]);
    assert.deepEqual(thread.body.replies.map((r: any) => r.id), [r1.id, r2.id, r3.id]);
    assert.equal(thread.body.following, true); // root author follows automatically
    assert.equal(thread.body.lastRead, 0);

    // replying to a reply / to a root of another channel is invalid
    assert.equal((await send(bob, ch.id, 'nested', { threadRootId: r1.id })).body.error, 'invalid_thread');
    const other = await newChannel('threads-other', bob);
    assert.equal((await send(bob, other.id, 'cross', { threadRootId: root.id })).body.error, 'invalid_thread');
    assert.equal((await send(bob, ch.id, 'missing', { threadRootId: 999999 })).body.error, 'invalid_thread');

    // activity: alice gets thread replies (+ a mention for r2), bob gets carol's reply
    const aliceAct = (await api(app, alice.token).get('/api/activity?filter=threads')).body;
    assert.deepEqual(aliceAct.map((a: any) => a.message.id).sort(), [r1.id, r3.id].sort());
    const aliceMentions = (await api(app, alice.token).get('/api/activity?filter=mentions')).body;
    assert.deepEqual(aliceMentions.map((a: any) => a.message.id), [r2.id]);
    const bobAct = (await api(app, bob.token).get('/api/activity?filter=threads')).body;
    assert.deepEqual(bobAct.map((a: any) => a.message.id), [r2.id]);

    // threads view + counts
    let threads = (await api(app, alice.token).get('/api/threads')).body;
    const t = threads.find((x: any) => x.root.id === root.id);
    assert.equal(t.unread, 3);
    assert.equal(t.replies.length, 3);
    assert.equal((await api(app, alice.token).get('/api/counts')).body.threadsUnread, 1);
    assert.equal((await api(app, bob.token).get('/api/counts')).body.threadsUnread, 0); // bob's last reply is the newest... except carol's? no: r3 after r2

    // read the thread
    assert.equal((await api(app, alice.token).put(`/api/messages/${root.id}/thread/read`, { messageId: r3.id })).status, 200);
    threads = (await api(app, alice.token).get('/api/threads')).body;
    assert.equal(threads.find((x: any) => x.root.id === root.id).unread, 0);
    assert.equal((await api(app, alice.token).get('/api/counts')).body.threadsUnread, 0);
    assert.ok((await api(app, alice.token).get('/api/activity?filter=threads')).body.every((a: any) => a.read));

    // mark a thread reply unread
    await api(app, alice.token).post(`/api/messages/${r3.id}/unread`);
    assert.equal((await api(app, alice.token).get(`/api/messages/${root.id}/thread`)).body.lastRead, r3.id - 1);

    // unfollow: no more activity
    assert.deepEqual((await api(app, alice.token).put(`/api/messages/${root.id}/thread/follow`, { following: false })).body, { ok: true, following: false });
    await send(bob, ch.id, 'third take', { threadRootId: root.id });
    assert.equal((await api(app, alice.token).get('/api/activity?filter=threads')).body.length, 2);
    assert.ok(!(await api(app, alice.token).get('/api/threads')).body.some((x: any) => x.root.id === root.id));
    // follow without having replied
    await api(app, owner.token).post(`/api/channels/${ch.id}/join`);
    await api(app, owner.token).put(`/api/messages/${root.id}/thread/follow`, { following: true });
    const ownerThread = (await api(app, owner.token).get(`/api/messages/${root.id}/thread`)).body;
    assert.equal(ownerThread.following, true);
    assert.ok(ownerThread.lastRead > r3.id);

    for (const url of [`/api/messages/999999/thread`]) assert.equal((await api(app, alice.token).get(url)).status, 404);
    assert.equal((await api(app, alice.token).put('/api/messages/999999/thread/read', { messageId: 1 })).status, 404);
    assert.equal((await api(app, alice.token).put('/api/messages/999999/thread/follow', { following: true })).status, 404);
  });

  test('mentioned people follow the thread; DM thread replies notify everybody', async () => {
    const ch = await newChannel('threads-mention', alice, [bob, carol]);
    const root = (await send(alice, ch.id, 'root')).body;
    await send(bob, ch.id, `<@${carol.me.id}> what do you think?`, { threadRootId: root.id });
    const carolThread = (await api(app, carol.token).get(`/api/messages/${root.id}/thread`)).body;
    assert.equal(carolThread.following, true);
    // the mention is not also reported as a thread reply
    const carolAll = (await api(app, carol.token).get('/api/activity')).body.filter((a: any) => a.channelId === ch.id && a.kind !== 'channel_invite');
    assert.deepEqual(carolAll.map((a: any) => a.kind), ['mention']);

    const dm = (await api(app, alice.token).post('/api/dms', { userIds: [bob.me.id] })).body.channel;
    const droot = (await send(alice, dm.id, 'dm root')).body;
    await send(bob, dm.id, `<@${alice.me.id}> reply`, { threadRootId: droot.id });
    const act = (await api(app, alice.token).get('/api/activity?filter=threads')).body;
    assert.ok(act.some((a: any) => a.channelId === dm.id && a.kind === 'thread_reply'));
  });
});

describe('reactions & pins', () => {
  test('add/remove reactions with activity and limits', async () => {
    const ch = await newChannel('reacting', alice, [bob]);
    const m = (await send(alice, ch.id, 'react to me')).body;
    const r = await api(app, bob.token).post(`/api/messages/${m.id}/reactions`, { emoji: 'thumbsup' });
    assert.deepEqual(r.body.reactions, [{ emoji: 'thumbsup', userIds: [bob.me.id] }]);
    await api(app, alice.token).post(`/api/messages/${m.id}/reactions`, { emoji: 'thumbsup' });
    const twice = await api(app, bob.token).post(`/api/messages/${m.id}/reactions`, { emoji: 'thumbsup' });
    assert.deepEqual(twice.body.reactions, [{ emoji: 'thumbsup', userIds: [bob.me.id, alice.me.id] }]);

    const act = (await api(app, alice.token).get('/api/activity?filter=reactions')).body;
    assert.equal(act.length, 1);
    assert.equal(act[0].emoji, 'thumbsup');
    assert.equal(act[0].actorId, bob.me.id);

    assert.equal((await api(app, carol.token).post(`/api/messages/${m.id}/reactions`, { emoji: 'x' })).status, 403);
    assert.equal((await api(app, bob.token).post(`/api/messages/${m.id}/reactions`, { emoji: '' })).status, 400);
    assert.equal((await api(app, bob.token).post('/api/messages/999999/reactions', { emoji: 'x' })).status, 404);

    const del = await api(app, bob.token).del(`/api/messages/${m.id}/reactions/thumbsup`);
    assert.deepEqual(del.body.reactions, [{ emoji: 'thumbsup', userIds: [alice.me.id] }]);
    assert.equal((await api(app, alice.token).get('/api/activity?filter=reactions')).body.length, 0);
    assert.equal((await api(app, bob.token).del('/api/messages/999999/reactions/x')).status, 404);
    // removing a reaction you don't have is a no-op without events
    const events: unknown[] = [];
    const { bus } = await import('../src/services.ts');
    const listener = (e: unknown) => events.push(e);
    bus.on('reaction', listener);
    const noop = await api(app, carol.token).del(`/api/messages/${m.id}/reactions/thumbsup`);
    bus.off('reaction', listener);
    assert.deepEqual(noop.body.reactions, [{ emoji: 'thumbsup', userIds: [alice.me.id] }]);
    assert.deepEqual(events, []);

    // 50 distinct emoji at most
    for (let i = 0; i < 50; i++) db.run('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', m.id, bob.me.id, `e${i}`, Date.now());
    assert.equal((await api(app, bob.token).post(`/api/messages/${m.id}/reactions`, { emoji: 'one-more' })).body.error, 'too_many_reactions');
  });

  test('pin and unpin', async () => {
    const ch = await newChannel('pinning', alice, [bob]);
    const m = (await send(alice, ch.id, 'pin me')).body;
    assert.equal((await api(app, carol.token).post(`/api/messages/${m.id}/pin`)).status, 403);
    const p = await api(app, bob.token).post(`/api/messages/${m.id}/pin`);
    assert.equal(p.body.pinnedBy, bob.me.id);
    const u = await api(app, alice.token).del(`/api/messages/${m.id}/pin`);
    assert.equal(u.body.pinnedBy, null);
    assert.equal((await api(app, alice.token).post('/api/messages/999999/pin')).status, 404);
    assert.equal((await api(app, alice.token).del('/api/messages/999999/pin')).status, 404);
    assert.equal((await api(app, carol.token).del(`/api/messages/${m.id}/pin`)).status, 403);
  });
});

describe('saved for later', () => {
  test('save, states, reminders, count', async () => {
    const ch = await newChannel('saving', alice, [bob]);
    const m1 = (await send(alice, ch.id, 'save me')).body;
    const m2 = (await send(alice, ch.id, 'remind me')).body;
    const b = api(app, bob.token);
    assert.equal((await b.post(`/api/messages/${m1.id}/save`)).status, 200);
    const remindAt = Date.now() + 3600_000;
    await b.post(`/api/messages/${m2.id}/save`, { remindAt });
    assert.equal((await b.get('/api/saved/count')).body.count, 2);
    let list = (await b.get('/api/saved')).body;
    // items with a reminder come first
    assert.deepEqual(list.map((s: any) => s.message.id), [m2.id, m1.id]);
    assert.equal(list[0].remindAt, remindAt);
    assert.equal(list[0].state, 'progress');
    assert.ok((await b.get('/api/bootstrap')).body.savedIds.includes(m1.id));

    await b.put(`/api/messages/${m1.id}/save`, { state: 'completed' });
    assert.deepEqual((await b.get('/api/saved?state=completed')).body.map((s: any) => s.message.id), [m1.id]);
    await b.put(`/api/messages/${m1.id}/save`, { state: 'archived' });
    assert.equal((await b.get('/api/saved?state=archived')).body[0].state, 'archived');
    assert.equal((await b.get('/api/saved/count')).body.count, 1);
    // saving again moves it back to "in progress"
    await b.post(`/api/messages/${m1.id}/save`);
    assert.equal((await b.get('/api/saved/count')).body.count, 2);

    // reminders fire once
    await b.put(`/api/messages/${m2.id}/save`, { remindAt: Date.now() - 1000 });
    jobs.sendReminders();
    jobs.sendReminders();
    const reminders = (await b.get('/api/activity?filter=reminders')).body;
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].message.id, m2.id);
    assert.equal(reminders[0].actorId, null);
    // a new reminder time re-arms it
    await b.post(`/api/messages/${m2.id}/save`, { remindAt: Date.now() - 500 });
    jobs.sendReminders();
    assert.equal((await b.get('/api/activity?filter=reminders')).body.length, 2);

    await b.del(`/api/messages/${m1.id}/save`);
    assert.equal((await b.get('/api/saved/count')).body.count, 1);
    assert.equal((await b.post('/api/messages/999999/save')).status, 404);
    assert.equal((await b.put(`/api/messages/${m1.id}/save`, { state: 'bogus' })).status, 400);
  });
});

describe('mark unread', () => {
  test('sets the read marker just before a message', async () => {
    const ch = await newChannel('mark-unread', alice, [bob]);
    await send(alice, ch.id, 'a');
    const m2 = (await send(alice, ch.id, `b <@${bob.me.id}>`)).body;
    await send(alice, ch.id, 'c');
    const b = api(app, bob.token);
    const read = await b.put(`/api/channels/${ch.id}/read`, { messageId: m2.id + 1 });
    assert.equal(read.body.unread, 0);
    assert.equal((await b.post(`/api/messages/${m2.id}/unread`)).status, 200);
    const mem = (await b.get(`/api/channels/${ch.id}`)).body.membership;
    assert.equal(mem.unread, 2);
    assert.equal(mem.mentions, 1);
    assert.equal(mem.lastRead, m2.id - 1);
    assert.equal((await api(app, carol.token).post(`/api/messages/${m2.id}/unread`)).status, 403);
    assert.equal((await b.post('/api/messages/999999/unread')).status, 404);
  });
});

describe('files', () => {
  test('upload, attach, download headers, ranges and access control', async () => {
    const priv = await newChannel('files-private', alice, [bob], true);
    const up = await api(app, alice.token).upload('/api/files', [
      { filename: 'pic.png', content: png(7, 9), contentType: 'image/png' },
      { filename: 'page.html', content: '<script>alert(1)</script>', contentType: 'text/html' },
      { filename: 'notes.txt', content: '0123456789', contentType: 'text/plain' },
      { filename: '../../evil\\name.bin', content: 'x' },
    ]);
    assert.equal(up.status, 200);
    assert.equal(up.body.length, 4);
    const [pic, html, txt, bin] = up.body;
    assert.equal(pic.width, 7);
    assert.equal(pic.height, 9);
    assert.equal(pic.mime, 'image/png');
    assert.equal(txt.size, 10);
    assert.equal(html.width, null);
    assert.ok(!bin.name.includes('/') && !bin.name.includes('\\'));
    assert.ok(fs.existsSync(path.join(dataDir, 'uploads', new Date().toISOString().slice(0, 7))));

    // before it is attached only the uploader can fetch it
    assert.equal((await api(app, alice.token).get(pic.url)).status, 200);
    assert.equal((await api(app, bob.token).get(pic.url)).status, 403);

    const msg = (await send(alice, priv.id, 'files!', { fileIds: [pic.id, html.id, txt.id, bin.id] })).body;
    assert.equal(msg.files.length, 4);

    const img = await api(app, bob.token).get(pic.url);
    assert.equal(img.status, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.match(img.headers['content-disposition'], /^inline; filename\*=UTF-8''pic\.png$/);
    assert.equal(img.headers['x-content-type-options'], 'nosniff');
    assert.match(img.headers['content-security-policy'], /sandbox/);
    assert.deepEqual(img.raw.rawPayload, png(7, 9));

    const dl = await api(app, bob.token).get(`${pic.url}?download=1`);
    assert.equal(dl.headers['content-type'], 'application/octet-stream');
    assert.match(dl.headers['content-disposition'], /^attachment/);

    // never render active content inline
    const h = await api(app, bob.token).get(html.url);
    assert.equal(h.headers['content-type'], 'application/octet-stream');
    assert.match(h.headers['content-disposition'], /^attachment/);

    // ranges
    const r1 = await api(app, bob.token).get(txt.url, { range: 'bytes=2-5' });
    assert.equal(r1.status, 206);
    assert.equal(r1.body, '2345');
    assert.equal(r1.headers['content-range'], 'bytes 2-5/10');
    const r2 = await api(app, bob.token).get(txt.url, { range: 'bytes=-3' });
    assert.equal(r2.status, 206);
    assert.equal(r2.body, '789');
    const r3 = await api(app, bob.token).get(txt.url, { range: 'bytes=7-' });
    assert.equal(r3.body, '789');
    const r4 = await api(app, bob.token).get(txt.url, { range: 'bytes=20-30' });
    assert.equal(r4.status, 200);
    assert.equal(r4.body, '0123456789');
    const r5 = await api(app, bob.token).get(txt.url, { range: 'bytes=5-100' });
    assert.equal(r5.body, '56789');
    const full = await api(app, bob.token).get(txt.url, { range: 'items=1-2' });
    assert.equal(full.status, 200);
    assert.equal(full.headers['accept-ranges'], 'bytes');

    // non-members of the private channel can't download
    assert.equal((await api(app, carol.token).get(pic.url)).status, 403);
    assert.equal((await api(app, carol.token).get('/api/files/NOPE/x')).status, 404);

    // files listing endpoint
    const all = (await api(app, bob.token).get('/api/files')).body;
    assert.equal(all.length, 4);
    assert.deepEqual((await api(app, bob.token).get('/api/files?type=images')).body.map((f: any) => f.id), [pic.id]);
    assert.deepEqual((await api(app, bob.token).get('/api/files?type=documents')).body.map((f: any) => f.id).sort(), [html.id, txt.id].sort());
    assert.deepEqual((await api(app, bob.token).get('/api/files?type=other')).body.map((f: any) => f.id), [bin.id]);
    assert.equal((await api(app, bob.token).get('/api/files?type=pdfs')).body.length, 0);
    assert.equal((await api(app, bob.token).get('/api/files?mine=1')).body.length, 0);
    assert.equal((await api(app, bob.token).get('/api/files?shared=1')).body.length, 4);
    assert.equal((await api(app, alice.token).get('/api/files?mine=1')).body.length, 4);
    assert.equal((await api(app, alice.token).get('/api/files?mine=true')).body.length, 4);
    // "false" must not be read as true
    assert.equal((await api(app, bob.token).get('/api/files?mine=0')).body.length, 4);
    assert.equal((await api(app, bob.token).get('/api/files?mine=false&shared=false')).body.length, 4);
    assert.equal((await api(app, bob.token).get('/api/files?mine=maybe')).status, 400);
    assert.deepEqual((await api(app, bob.token).get('/api/files?q=notes')).body.map((f: any) => f.id), [txt.id]);
    assert.equal((await api(app, bob.token).get('/api/files?sort=name')).body[0].name, 'name.bin');
    assert.equal((await api(app, bob.token).get('/api/files?sort=size')).body[0].id, pic.id);
    assert.equal((await api(app, bob.token).get('/api/files?sort=oldest')).body.length, 4);
    assert.equal((await api(app, bob.token).get(`/api/files?channelId=${priv.id}`)).body.length, 4);
    assert.equal((await api(app, carol.token).get(`/api/files?channelId=${priv.id}`)).body.length, 0);

    // deleting files
    assert.equal((await api(app, bob.token).del(`/api/files/${pic.id}`)).status, 403);
    assert.equal((await api(app, alice.token).del('/api/files/NOPE')).status, 404);
    assert.equal((await api(app, alice.token).del(`/api/files/${pic.id}`)).status, 200);
    const after = (await api(app, bob.token).get(`/api/messages/${msg.id}`)).body;
    assert.equal(after.files.length, 3);
    assert.equal((await api(app, bob.token).get(pic.url)).status, 404);

    // a file-only message disappears with its last file
    const up2 = await api(app, bob.token).upload('/api/files', [{ filename: 'only.txt', content: 'x', contentType: 'text/plain' }]);
    const fileMsg = (await send(bob, priv.id, '', { fileIds: [up2.body[0].id] })).body;
    assert.equal(fileMsg.files.length, 1);
    assert.equal((await api(app, owner.token).del(`/api/files/${up2.body[0].id}`)).status, 200); // admin
    assert.ok(!(await listMsgs(bob, priv.id)).messages.some((m: any) => m.id === fileMsg.id));

    // a missing file on disk gives 404
    const up3 = await api(app, bob.token).upload('/api/files', [{ filename: 'gone.txt', content: 'x', contentType: 'text/plain' }]);
    const row = db.get<{ path: string }>('SELECT path FROM files WHERE id = ?', up3.body[0].id)!;
    fs.rmSync(path.join(dataDir, 'uploads', row.path));
    assert.equal((await api(app, bob.token).get(up3.body[0].url)).status, 404);
  });

  test('cannot attach somebody else’s file; deleting a message removes its files', async () => {
    const ch = await newChannel('files-attach', alice, [bob]);
    const up = await api(app, alice.token).upload('/api/files', [{ filename: 'a.txt', content: 'alice', contentType: 'text/plain' }]);
    const stolen = (await send(bob, ch.id, 'look', { fileIds: [up.body[0].id] })).body;
    assert.equal(stolen.files.length, 0);
    const mine = (await send(alice, ch.id, 'mine', { fileIds: [up.body[0].id] })).body;
    assert.equal(mine.files.length, 1);
    const row = db.get<{ path: string }>('SELECT path FROM files WHERE id = ?', up.body[0].id)!;
    await api(app, alice.token).del(`/api/messages/${mine.id}`);
    assert.equal(fs.existsSync(path.join(dataDir, 'uploads', row.path)), false);
    assert.equal(db.get('SELECT 1 FROM files WHERE id = ?', up.body[0].id), undefined);
  });

  test('upload size limit', async () => {
    // MAX_UPLOAD_MB defaults to 100; a truncated stream must be rejected – simulate with a tiny limit
    const { saveUpload } = await import('../src/lib/files.ts');
    const { Readable } = await import('node:stream');
    const file = Readable.from([Buffer.from('abc')]) as any;
    file.truncated = true;
    await assert.rejects(saveUpload({ filename: 'x.bin', file } as any, 'tmp'), /file_too_large/);
  });
});

describe('activity', () => {
  test('filters, dms, paging and read state', async () => {
    const ch = await newChannel('activity', alice, [carol]);
    const dm = (await api(app, bob.token).post('/api/dms', { userIds: [carol.me.id] })).body.channel;
    const items: number[] = [];
    for (let i = 0; i < 3; i++) {
      items.push((await send(alice, ch.id, `<@${carol.me.id}> mention ${i}`)).body.id);
      await new Promise((r) => setTimeout(r, 2));
    }
    const dmMsg = (await send(bob, dm.id, 'direct hello')).body;
    await send(carol, dm.id, 'my own dm is not activity');

    const c = api(app, carol.token);
    const allItems = (await c.get('/api/activity')).body;
    assert.equal(allItems[0].kind, 'dm');
    assert.equal(allItems[0].message.id, dmMsg.id);
    assert.equal(allItems[0].id, -dmMsg.id);
    // carol answered after bob, so the DM counts as read
    assert.equal(allItems[0].read, true);

    const dms = (await c.get('/api/activity?filter=dms')).body;
    assert.deepEqual(dms.map((a: any) => a.message.text), ['direct hello']);
    const unread = (await c.get('/api/activity?filter=unread')).body;
    assert.ok(unread.every((a: any) => !a.read));
    assert.ok(!unread.some((a: any) => a.kind === 'dm'));

    const mentions = (await c.get('/api/activity?filter=mentions')).body.filter((a: any) => a.channelId === ch.id);
    assert.deepEqual(mentions.map((a: any) => a.message.id), [...items].reverse());
    // paging by createdAt
    const page = (await c.get(`/api/activity?filter=mentions&before=${mentions[0].createdAt}`)).body.filter((a: any) => a.channelId === ch.id);
    assert.deepEqual(page.map((a: any) => a.message.id), [items[1], items[0]]);

    // mark read / unread / all
    const before = (await c.get('/api/counts')).body.activityUnread;
    await c.put('/api/activity/read', { ids: [mentions[0].id] });
    assert.equal((await c.get('/api/counts')).body.activityUnread, before - 1);
    await c.put('/api/activity/read', { ids: [mentions[0].id], read: false });
    assert.equal((await c.get('/api/counts')).body.activityUnread, before);
    await c.put('/api/activity/read', { all: true });
    assert.equal((await c.get('/api/counts')).body.activityUnread, 0);
    assert.equal((await c.put('/api/activity/read', {})).status, 200);
    assert.equal((await c.get('/api/activity?filter=bogus')).status, 400);
  });
});

describe('drafts', () => {
  test('save, update and clear drafts', async () => {
    const ch = await newChannel('drafts', alice);
    const a = api(app, alice.token);
    await a.put('/api/drafts', { channelId: ch.id, text: 'half written' });
    await a.put('/api/drafts', { channelId: ch.id, text: 'half written, more' });
    await a.put('/api/drafts', { channelId: ch.id, threadRootId: 5, text: 'thread draft' });
    let drafts = (await a.get('/api/bootstrap')).body.drafts.filter((d: any) => d.channelId === ch.id);
    assert.deepEqual(
      drafts.map((d: any) => [d.threadRootId, d.text]).sort((x: any, y: any) => x[1].localeCompare(y[1])),
      [
        [null, 'half written, more'],
        [5, 'thread draft'],
      ],
    );
    await a.put('/api/drafts', { channelId: ch.id, text: '  ' });
    drafts = (await a.get('/api/bootstrap')).body.drafts.filter((d: any) => d.channelId === ch.id);
    assert.equal(drafts.length, 1);
    assert.equal((await api(app, bob.token).put('/api/drafts', { channelId: ch.id, text: 'x' })).status, 403);
  });
});

describe('scheduled messages', () => {
  test('create, edit, delete and send', async () => {
    const ch = await newChannel('scheduled', alice, [bob]);
    const a = api(app, alice.token);
    assert.equal((await a.post('/api/scheduled', { channelId: ch.id, text: 'too soon', sendAt: Date.now() + 1000 })).body.error, 'send_at_in_past');
    assert.equal((await api(app, carol.token).post('/api/scheduled', { channelId: ch.id, text: 'x', sendAt: Date.now() + 60_000 })).status, 403);
    const s = (await a.post('/api/scheduled', { channelId: ch.id, text: 'later', sendAt: Date.now() + 60_000 })).body;
    assert.equal(s.text, 'later');
    const root = (await send(alice, ch.id, 'root')).body;
    const s2 = (await a.post('/api/scheduled', { channelId: ch.id, threadRootId: root.id, text: 'in thread', sendAt: Date.now() + 120_000 })).body;
    const s3 = (await a.post('/api/scheduled', { channelId: ch.id, text: 'cancel me', sendAt: Date.now() + 120_000 })).body;

    const edited = (await a.patch(`/api/scheduled/${s.id}`, { text: 'later (edited)', sendAt: Date.now() + 90_000 })).body;
    assert.equal(edited.text, 'later (edited)');
    assert.equal((await api(app, bob.token).patch(`/api/scheduled/${s.id}`, { text: 'mine now' })).status, 404);
    assert.deepEqual((await a.get('/api/scheduled')).body.map((x: any) => x.id), [s.id, s2.id, s3.id]);
    await api(app, bob.token).del(`/api/scheduled/${s3.id}`); // not his: no effect
    assert.equal((await a.get('/api/scheduled')).body.length, 3);
    await a.del(`/api/scheduled/${s3.id}`);
    assert.equal((await a.get('/api/scheduled')).body.length, 2);

    // nothing is due yet
    jobs.sendScheduled();
    assert.equal((await a.get('/api/scheduled')).body.length, 2);
    db.run('UPDATE scheduled SET send_at = ? WHERE user_id = ?', Date.now() - 1, alice.me.id);
    jobs.sendScheduled();
    assert.equal((await a.get('/api/scheduled')).body.length, 0);
    const texts = (await listMsgs(bob, ch.id)).messages.map((m: any) => m.text);
    assert.ok(texts.includes('later (edited)'));
    const thread = (await a.get(`/api/messages/${root.id}/thread`)).body;
    assert.deepEqual(thread.replies.map((r: any) => r.text), ['in thread']);
  });

  test('scheduled messages are dropped when the author left or the channel is archived', async () => {
    const ch = await newChannel('scheduled-drop', alice, [bob]);
    const ch2 = await newChannel('scheduled-arch', alice, [bob]);
    await api(app, bob.token).post('/api/scheduled', { channelId: ch.id, text: 'left before sending', sendAt: Date.now() + 60_000 });
    await api(app, bob.token).post('/api/scheduled', { channelId: ch2.id, text: 'archived before sending', sendAt: Date.now() + 60_000 });
    // invalid thread -> the error is swallowed
    await api(app, bob.token).post('/api/scheduled', { channelId: ch2.id, threadRootId: 999999, text: 'bad thread', sendAt: Date.now() + 60_000 });
    await api(app, bob.token).post(`/api/channels/${ch.id}/leave`);
    await api(app, alice.token).post(`/api/channels/${ch2.id}/archive`);
    db.run('UPDATE scheduled SET send_at = ? WHERE user_id = ?', Date.now() - 1, bob.me.id);
    const orig = console.error;
    console.error = () => {};
    try {
      jobs.sendScheduled();
    } finally {
      console.error = orig;
    }
    assert.equal((await api(app, bob.token).get('/api/scheduled')).body.length, 0);
    for (const c of [ch, ch2]) {
      assert.ok(!(await listMsgs(alice, c.id)).messages.some((m: any) => m.userId === bob.me.id && !m.subtype));
    }
  });
});

describe('misc views', () => {
  test('unreads view groups unread messages per channel', async () => {
    const ch = await newChannel('unreads', alice, [carol]);
    const muted = await newChannel('unreads-muted', alice, [carol]);
    await api(app, carol.token).put(`/api/channels/${muted.id}/prefs`, { muted: true });
    await send(alice, ch.id, 'u1');
    await send(alice, ch.id, 'u2');
    await send(alice, muted.id, 'muted');
    const groups = (await api(app, carol.token).get('/api/unreads')).body;
    const g = groups.find((x: any) => x.channelId === ch.id);
    assert.equal(g.total, 2);
    assert.deepEqual(g.messages.map((m: any) => m.text), ['u1', 'u2']);
    assert.ok(!groups.some((x: any) => x.channelId === muted.id));
    assert.ok(!(await api(app, alice.token).get('/api/unreads')).body.some((x: any) => x.channelId === ch.id));
  });

  test('sent messages', async () => {
    const sent = (await api(app, alice.token).get('/api/sent')).body;
    assert.ok(sent.length > 0);
    assert.ok(sent.every((m: any) => m.userId === alice.me.id && !m.subtype));
  });

  test('huddle history only for channel members', async () => {
    const ch = await newChannel('huddle-history', alice, [bob], true);
    db.run('INSERT INTO huddle_sessions (channel_id, started_by, started_at, ended_at, participants) VALUES (?, ?, ?, ?, ?)', ch.id, alice.me.id, 1000, 2000, JSON.stringify([alice.me.id, bob.me.id]));
    const h = (await api(app, bob.token).get('/api/huddles')).body;
    assert.deepEqual(h, [{ id: h[0].id, channelId: ch.id, startedBy: alice.me.id, startedAt: 1000, endedAt: 2000, participantIds: [alice.me.id, bob.me.id] }]);
    assert.deepEqual((await api(app, carol.token).get('/api/huddles')).body, []);
  });
});

describe('services', () => {
  test('systemText helper', async () => {
    const { systemText } = await import('../src/services.ts');
    assert.deepEqual(systemText('topic', 'x'), { subtype: 'topic', text: 'x' });
  });
});

describe('jobs', () => {
  test('expired statuses and dnd are cleared; cleanup removes old data', async () => {
    const d = api(app, carol.token);
    await d.put('/api/users/me/status', { emoji: 'x', text: 'gone', expiresAt: Date.now() + 60_000 });
    await d.put('/api/users/me/dnd', { until: Date.now() + 60_000 });
    db.run('UPDATE users SET status_expires_at = ?, dnd_until = ? WHERE id = ?', Date.now() - 1, Date.now() - 1, carol.me.id);
    jobs.expireStatuses();
    const row = db.get<any>('SELECT status_text, status_expires_at, dnd_until FROM users WHERE id = ?', carol.me.id);
    assert.deepEqual({ ...row }, { status_text: '', status_expires_at: null, dnd_until: null });

    const old = Date.now() - 100 * 86400_000;
    db.run("INSERT INTO activity (user_id, kind, channel_id, created_at, read) VALUES (?, 'mention', 'C', ?, 1)", carol.me.id, old);
    db.run("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES ('oldhash', ?, ?, ?)", carol.me.id, old, old);
    const ch = await newChannel('cleanup', carol);
    db.run('INSERT INTO huddle_sessions (channel_id, started_at) VALUES (?, ?)', ch.id, Date.now() - 2 * 86400_000);
    jobs.cleanup();
    assert.equal(db.get('SELECT 1 FROM activity WHERE created_at = ?', old), undefined);
    assert.equal(db.get("SELECT 1 FROM sessions WHERE token_hash = 'oldhash'"), undefined);
    assert.equal(db.get('SELECT 1 FROM huddle_sessions WHERE channel_id = ? AND ended_at IS NULL', ch.id), undefined);
  });
});
