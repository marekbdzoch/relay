import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import { addUser, api, closeApp, createApp, png, setupOwner, waitFor, type Session } from './helpers.ts';

// ---------- a tiny ZIP writer (deflate, UTF-8 names) ----------

function zip(files: Record<string, string | Buffer>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const n = Object.keys(files).length;
  end.writeUInt16LE(n, 8);
  end.writeUInt16LE(n, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------- fixtures ----------

let app: FastifyInstance;
let url: string;
let owner: Session;
let alice: Session;
let db: typeof import('../src/db.ts');
let fileServer: http.Server;
let base: string;
const sockets: Socket[] = [];
const PIC = png(4, 5);
let job1: any;

const T0 = 1577869200; // 2020-01-01 09:00 UTC
const ts = (sec: number, micro = 0) => `${T0 + sec}.${String(micro).padStart(6, '0')}`;
const json = (v: unknown) => JSON.stringify(v);

function exportFiles(extra: Record<string, string> = {}) {
  const users = [
    { id: 'U001', name: 'olivia', real_name: 'Olivia Owner', tz: 'Europe/Prague', profile: { real_name: 'Olivia Owner', email: 'OWNER@example.com' } },
    { id: 'U002', name: 'alice', real_name: 'Alice A', profile: { real_name: 'Alice A', email: 'alice@example.com' } },
    {
      id: 'U003',
      name: 'bob',
      real_name: 'Bob Builder',
      tz: 'America/New_York',
      profile: {
        real_name: 'Bob Builder',
        display_name: 'bobby',
        title: 'Engineer',
        email: 'bob@example.com',
        image_192: `${base}/avatar.png`,
        is_custom_image: true,
      },
    },
    { id: 'U004', name: 'dan', deleted: true, real_name: 'Dan Departed', profile: { real_name: 'Dan Departed', email: 'dan@example.com' } },
    { id: 'U005', name: 'gina', is_restricted: true, real_name: 'Gina Guest', profile: { real_name: 'Gina Guest', email: 'gina@example.com' } },
    { id: 'UBOT1', name: 'github', is_bot: true, real_name: 'GitHub', profile: { real_name: 'GitHub' } },
  ];
  const channels = [
    {
      id: 'C001',
      name: 'company',
      is_general: true,
      created: T0 - 1000,
      creator: 'U001',
      members: ['U001', 'U002', 'U003', 'U004', 'U005'],
      topic: { value: '' },
      purpose: { value: 'Everyone' },
    },
    {
      id: 'C002',
      name: 'dev',
      created: T0 - 900,
      creator: 'U003',
      members: ['U001', 'U003'],
      topic: { value: 'Ship it' },
      purpose: { value: 'Development &amp; ops' },
    },
    { id: 'C003', name: 'old-stuff', created: T0 - 800, creator: 'U001', is_archived: true, members: ['U001'] },
  ];
  const groups = [{ id: 'G001', name: 'secret', created: T0 - 700, creator: 'U002', members: ['U002', 'U003'] }];
  const dms = [{ id: 'D001', created: T0 - 600, members: ['U002', 'U003'] }];
  const mpims = [{ id: 'G002', name: 'mpdm-olivia--alice--bob-1', created: T0 - 500, creator: 'U001', members: ['U001', 'U002', 'U003'] }];

  const general1 = [
    // out of order on purpose: the importer sorts by ts
    { type: 'message', user: 'U003', text: 'Reply in thread', ts: ts(30), thread_ts: ts(20), parent_user_id: 'U002' },
    { type: 'message', subtype: 'channel_join', user: 'U003', text: '<@U003> has joined the channel', ts: ts(1), inviter: 'U001' },
    {
      type: 'message',
      user: 'U001',
      text: 'Hello <@U002> &amp; <!here>, see <#C002|dev> and <https://example.com|our site> &lt;3 <@UBOT1>',
      ts: ts(10),
      reactions: [
        { name: '+1', users: ['U002', 'U003'], count: 2 },
        { name: 'thumbsup', users: ['U002'], count: 1 },
        { name: 'wave::skin-tone-2', users: ['U003'], count: 1 },
      ],
      pinned_to: ['C001'],
    },
    { type: 'message', user: 'U002', text: 'Thread root', ts: ts(20), thread_ts: ts(20), reply_count: 2, replies: [{ user: 'U003', ts: ts(30) }] },
    { type: 'message', subtype: 'thread_broadcast', user: 'U001', text: 'Broadcast reply', ts: ts(40), thread_ts: ts(20) },
    { type: 'message', subtype: 'bot_message', bot_id: 'B001', username: 'GitHub', text: 'Build passed', ts: ts(50) },
    { type: 'message', user: 'U004', text: 'bye everyone', ts: ts(60) },
    { type: 'message', user: 'U999', text: 'hello from outside', ts: ts(70), user_profile: { real_name: 'Ext Person', display_name: 'ext' } },
    {
      type: 'message',
      user: 'U001',
      text: 'a picture',
      ts: ts(80),
      edited: { user: 'U001', ts: ts(85) },
      files: [
        {
          id: 'F001',
          name: 'pic.png',
          title: 'pic',
          mimetype: 'image/png',
          size: PIC.length,
          url_private_download: `${base}/pic.png`,
          url_private: `${base}/pic.png`,
        },
      ],
    },
    {
      type: 'message',
      user: 'U001',
      text: 'broken file',
      ts: ts(90),
      files: [
        {
          id: 'F002',
          name: 'gone.pdf',
          mimetype: 'application/pdf',
          url_private_download: `${base}/missing.pdf`,
          permalink: 'https://acme.slack.com/files/U001/F002/gone.pdf',
        },
      ],
    },
    { type: 'message', subtype: 'channel_topic', user: 'U001', text: 'set the topic', topic: 'New topic', ts: ts(100) },
    { type: 'message', subtype: 'bot_add', user: 'U001', text: 'added an integration', ts: ts(110) },
    { type: 'message', user: 'UBOT1', text: 'I am a bot user', ts: ts(120) },
  ];
  const general2 = [{ type: 'message', user: 'U002', text: 'Next day message with zebra', ts: ts(86400) }];

  return {
    'users.json': json(users),
    'channels.json': json(channels),
    'groups.json': json(groups),
    'dms.json': json(dms),
    'mpims.json': json(mpims),
    'integration_logs.json': '[]',
    'company/2020-01-01.json': json(general1),
    'company/2020-01-02.json': json(general2),
    'dev/2020-01-01.json': json([{ type: 'message', user: 'U003', text: '<@U001> ping in <#C001>', ts: ts(200) }]),
    'old-stuff/2020-01-01.json': json([{ type: 'message', user: 'U001', text: 'archived talk', ts: ts(300) }]),
    'secret/2020-01-03.json': json([{ type: 'message', user: 'U002', text: 'private plans', ts: ts(2 * 86400) }]),
    'D001/2020-01-04.json': json([{ type: 'message', user: 'U002', text: 'psst bob', ts: ts(3 * 86400) }]),
    'mpdm-olivia--alice--bob-1/2020-01-05.json': json([{ type: 'message', user: 'U003', text: 'group chat', ts: ts(4 * 86400) }]),
    ...extra,
  };
}

function connect(token: string): Promise<{ socket: Socket; events: [string, any][] }> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, forceNew: true, auth: { token } });
    sockets.push(socket);
    const events: [string, any][] = [];
    socket.onAny((name, payload) => events.push([name, payload]));
    socket.on('connect', () => resolve({ socket, events }));
    socket.on('connect_error', reject);
  });
}

async function runImport(token: string, data: Buffer, fields: Record<string, string> = {}) {
  const res = await api(app, token).upload('/api/admin/import/slack', [{ filename: 'export.zip', content: data, contentType: 'application/zip' }], fields);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.jobId);
  return waitFor(
    async () => {
      const r = await api(app, token).get(`/api/admin/import/slack/${res.body.jobId}`);
      return r.body.state === 'done' || r.body.state === 'error' ? r.body : null;
    },
    20000,
    20,
  );
}

const count = (sql: string, ...p: any[]) => (db.get<{ n: number }>(sql, ...p)?.n ?? 0) as number;
const userByEmail = (email: string) => db.get<any>('SELECT * FROM users WHERE email = ?', email);
const generalId = () => db.get<{ id: string }>("SELECT id FROM channels WHERE name = 'general'")!.id;
const msgByText = (text: string) => db.get<any>('SELECT * FROM messages WHERE text LIKE ?', `%${text}%`);

before(async () => {
  ({ app } = await createApp());
  db = await import('../src/db.ts');
  const imp = await import('../src/import/slack.ts');
  imp._internals.allowAnyHost = true;
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  fileServer = http.createServer((req, res) => {
    if (req.url === '/pic.png' || req.url === '/avatar.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PIC);
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise<void>((r) => fileServer.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fileServer.address() as AddressInfo).port}`;
  owner = await setupOwner(app);
  alice = await addUser(app, owner.token, { name: 'Alice', email: 'alice@example.com' });
});

after(async () => {
  for (const s of sockets) s.disconnect();
  fileServer.close();
  await closeApp(app);
});

describe('access', () => {
  test('only admins can import', async () => {
    const res = await api(app, alice.token).upload('/api/admin/import/slack', [{ filename: 'export.zip', content: zip(exportFiles()) }]);
    assert.equal(res.status, 403);
    assert.equal((await api(app, alice.token).get('/api/admin/import/slack')).status, 403);
    assert.equal((await api(app).get('/api/admin/import/slack')).status, 401);
  });

  test('rejects files that are not a Slack export', async () => {
    const notZip = await api(app, owner.token).upload('/api/admin/import/slack', [{ filename: 'x.zip', content: 'hello' }]);
    assert.equal(notZip.status, 400);
    assert.equal(notZip.body.error, 'not_a_slack_export');
    const otherZip = await api(app, owner.token).upload('/api/admin/import/slack', [{ filename: 'x.zip', content: zip({ 'readme.txt': 'hi' }) }]);
    assert.equal(otherZip.status, 400);
    assert.equal(otherZip.body.error, 'not_a_slack_export');
    const noFile = await api(app, owner.token).upload('/api/admin/import/slack', [], { importFiles: 'false' });
    assert.equal(noFile.status, 400);
    assert.equal((await api(app, owner.token).get('/api/admin/import/slack/JNOPE')).status, 404);
  });
});

describe('first import', () => {
  let ownerSock: { events: [string, any][] };
  let aliceSock: { events: [string, any][] };
  let activityBefore: number;
  const unreadBefore = new Map<string, number>();

  before(async () => {
    for (const s of [owner, alice]) {
      for (const m of (await api(app, s.token).get('/api/bootstrap')).body.memberships) unreadBefore.set(`${s.me.id}:${m.channelId}`, m.unread);
    }
    ownerSock = await connect(owner.token);
    aliceSock = await connect(alice.token);
    activityBefore = count('SELECT COUNT(*) AS n FROM activity');
    // nested in a folder, like a re-zipped download
    const files = Object.fromEntries(Object.entries(exportFiles()).map(([k, v]) => [`Acme Slack export/${k}`, v]));
    job1 = await runImport(owner.token, zip(files));
  });

  test('finishes with counts and warnings', () => {
    assert.equal(job1.state, 'done', job1.error);
    assert.equal(job1.progress, 1);
    assert.ok(job1.finishedAt >= job1.startedAt);
    // olivia, alice (matched), bob, dan, gina (placeholders) + the unknown U999
    assert.equal(job1.counts.users, 6);
    // general (merged), dev, old-stuff, secret, the DM and the group DM
    assert.equal(job1.counts.channels, 6);
    assert.equal(job1.counts.files, 1);
    // +1 by alice & bob (alice's "thumbsup" is the same emoji) + wave
    assert.equal(job1.counts.reactions, 3);
    // 12 + 1 in #company (bot_add skipped) + 1 each in dev, old-stuff, secret, the DM and the group DM
    assert.equal(job1.counts.messages, 13 + 5);
    assert.ok(job1.warnings.some((w: string) => w.includes('gone.pdf')));
    assert.ok(job1.warnings.some((w: string) => w.includes('system messages')));
  });

  test('matches people by e-mail and creates placeholders for the rest', () => {
    const o = userByEmail('owner@example.com');
    assert.equal(o.id, owner.me.id);
    assert.equal(o.imported, 0);
    assert.equal(userByEmail('alice@example.com').id, alice.me.id);
    const bob = userByEmail('bob@example.com');
    assert.equal(bob.imported, 1);
    assert.equal(bob.full_name, 'Bob Builder');
    assert.equal(bob.display_name, 'bobby');
    assert.equal(bob.title, 'Engineer');
    assert.equal(bob.timezone, 'America/New_York');
    assert.equal(bob.deactivated, 0);
    assert.ok(bob.avatar_path, 'avatar downloaded');
    assert.equal(userByEmail('dan@example.com').deactivated, 1);
    assert.equal(userByEmail('gina@example.com').role, 'guest');
    const ext = db.get<any>("SELECT * FROM users WHERE full_name = 'Ext Person'");
    assert.ok(ext);
    assert.equal(ext.deactivated, 1);
    // bots get no account
    assert.equal(count("SELECT COUNT(*) AS n FROM users WHERE full_name = 'GitHub'"), 0);
  });

  test('imported placeholders are exposed as such and cannot sign in', async () => {
    const users = (await api(app, owner.token).get('/api/users')).body as any[];
    const bob = users.find((u) => u.email === 'bob@example.com');
    assert.equal(bob.imported, true);
    assert.ok(bob.avatarUrl);
    assert.equal(users.find((u) => u.id === owner.me.id).imported, undefined);
    const login = await api(app).post('/api/auth/login', { email: 'bob@example.com', password: '!' });
    assert.equal(login.status, 401);
  });

  test('merges Slack’s general channel into #general and creates the others', () => {
    const gid = generalId();
    assert.equal(count("SELECT COUNT(*) AS n FROM channels WHERE kind = 'public' AND name IN ('general', 'company')"), 1);
    const general = db.get<any>('SELECT * FROM channels WHERE id = ?', gid);
    assert.equal(general.is_default, 1);
    const dev = db.get<any>("SELECT * FROM channels WHERE name = 'dev'");
    assert.equal(dev.kind, 'public');
    assert.equal(dev.topic, 'Ship it');
    assert.equal(dev.description, 'Development & ops');
    assert.equal(dev.created_by, userByEmail('bob@example.com').id);
    assert.equal(dev.created_at, (T0 - 900) * 1000);
    assert.equal(db.get<any>("SELECT archived FROM channels WHERE name = 'old-stuff'").archived, 1);
    const secret = db.get<any>("SELECT * FROM channels WHERE name = 'secret'");
    assert.equal(secret.kind, 'private');
    const secretMembers = db
      .all<{ user_id: string }>('SELECT user_id FROM channel_members WHERE channel_id = ?', secret.id)
      .map((r) => r.user_id)
      .sort();
    assert.deepEqual(secretMembers, [alice.me.id, userByEmail('bob@example.com').id].sort());
    // deactivated people are not added to channels
    assert.equal(count('SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ? AND user_id = ?', gid, userByEmail('dan@example.com').id), 0);
    const dm = db.get<any>('SELECT * FROM channels WHERE dm_key = ?', [alice.me.id, userByEmail('bob@example.com').id].sort().join(','));
    assert.equal(dm.kind, 'dm');
    const group = db.get<any>('SELECT * FROM channels WHERE dm_key = ?', [owner.me.id, alice.me.id, userByEmail('bob@example.com').id].sort().join(','));
    assert.equal(group.kind, 'group');
  });

  test('history is in chronological order, before messages that were already there', async () => {
    const page = (await api(app, owner.token).get(`/api/channels/${generalId()}/messages?limit=200`)).body;
    const msgs = page.messages as any[];
    for (let i = 1; i < msgs.length; i++) assert.ok(msgs[i].createdAt >= msgs[i - 1].createdAt, `ordered at ${i}`);
    // the "joined" notices from the setup / alice's signup moved behind the history
    assert.deepEqual(
      msgs.slice(-2).map((x) => [x.subtype, x.userId]),
      [
        ['join', owner.me.id],
        ['join', alice.me.id],
      ],
    );
    assert.ok(msgs[msgs.length - 2].createdAt > (T0 + 86400) * 1000);
    assert.equal(msgs[0].subtype, 'join');
    assert.equal(msgs[0].userId, userByEmail('bob@example.com').id);
    assert.equal(msgs[0].text, `<@${owner.me.id}>`);
  });

  test('converts text, mentions, reactions and pins', async () => {
    const m = msgByText('Hello');
    const devId = db.get<{ id: string }>("SELECT id FROM channels WHERE name = 'dev'")!.id;
    assert.equal(m.text, `Hello <@${alice.me.id}> & <!here>, see <#${devId}|dev> and <https://example.com|our site> <3 @GitHub`);
    assert.equal(m.created_at, (T0 + 10) * 1000);
    const full = (await api(app, owner.token).get(`/api/messages/${m.id}`)).body;
    const plus = full.reactions.find((r: any) => r.emoji === '+1');
    assert.deepEqual(plus.userIds.sort(), [alice.me.id, userByEmail('bob@example.com').id].sort());
    assert.ok(full.reactions.some((r: any) => r.emoji === 'wave::skin-tone-2'));
    assert.equal(full.pinnedBy, owner.me.id);
    assert.equal(msgByText('ping in').text, `<@${owner.me.id}> ping in <#${generalId()}|general>`);
  });

  test('threads, broadcasts, bots, edits, unknown and deleted authors', async () => {
    const root = msgByText('Thread root');
    assert.equal(root.reply_count, 2);
    const thread = (await api(app, owner.token).get(`/api/messages/${root.id}/thread`)).body;
    assert.deepEqual(
      thread.replies.map((r: any) => r.text),
      ['Reply in thread', 'Broadcast reply'],
    );
    assert.equal(thread.replies[1].alsoInChannel, true);
    const page = (await api(app, owner.token).get(`/api/channels/${generalId()}/messages?limit=200`)).body.messages as any[];
    assert.ok(page.some((x) => x.text === 'Broadcast reply'));
    assert.ok(!page.some((x) => x.text === 'Reply in thread'));
    const bot = page.find((x) => x.text === 'Build passed');
    assert.equal(bot.userId, null);
    assert.equal(bot.botName, 'GitHub');
    assert.equal(bot.subtype, 'bot');
    const botUser = page.find((x) => x.text === 'I am a bot user');
    assert.equal(botUser.botName, 'GitHub');
    assert.equal(page.find((x) => x.text === 'bye everyone').userId, userByEmail('dan@example.com').id);
    assert.ok(page.find((x) => x.text === 'hello from outside').userId);
    const pic = page.find((x) => x.text === 'a picture');
    assert.equal(pic.editedAt, (T0 + 85) * 1000);
    const topic = page.find((x) => x.subtype === 'topic');
    assert.equal(topic.text, 'New topic');
    assert.ok(!page.some((x) => /integration/.test(x.text)));
    // thread participants follow the (already read) thread
    const follow = db.get<any>('SELECT * FROM thread_follows WHERE user_id = ? AND root_id = ?', alice.me.id, root.id);
    assert.ok(follow);
    assert.equal(follow.last_read, db.get<{ id: number }>('SELECT MAX(id) AS id FROM messages WHERE thread_root_id = ?', root.id)!.id);
  });

  test('copies files and keeps a link when that fails', async () => {
    const pic = (await api(app, owner.token).get(`/api/messages/${msgByText('a picture').id}`)).body;
    assert.equal(pic.files.length, 1);
    assert.equal(pic.files[0].name, 'pic.png');
    assert.equal(pic.files[0].width, 4);
    const dl = await app.inject({ method: 'GET', url: pic.files[0].url, headers: { authorization: `Bearer ${owner.token}` } });
    assert.equal(dl.statusCode, 200);
    assert.deepEqual(dl.rawPayload, PIC);
    const broken = msgByText('broken file');
    assert.equal(broken.text, 'broken file\n:paperclip: <https://acme.slack.com/files/U001/F002/gone.pdf|gone.pdf>');
  });

  test('everything counts as read and nobody got notified', async () => {
    assert.equal(count('SELECT COUNT(*) AS n FROM activity'), activityBefore);
    for (const s of [owner, alice]) {
      const boot = (await api(app, s.token).get('/api/bootstrap')).body;
      // imported history is read; what was unread before (alice's join notice for the owner) stays unread
      for (const m of boot.memberships) assert.equal(m.unread, unreadBefore.get(`${s.me.id}:${m.channelId}`) ?? 0, `unread in ${m.channelId}`);
      assert.equal(boot.activityUnread, 0);
      assert.equal(boot.threadsUnread, 0);
    }
    // alice sees the imported DM and the private channel
    const boot = (await api(app, alice.token).get('/api/bootstrap')).body;
    assert.ok(boot.channels.some((c: any) => c.name === 'secret'));
    assert.ok(boot.channels.some((c: any) => c.kind === 'dm' && c.memberIds.length === 2 && c.memberIds.includes(userByEmail('bob@example.com').id)));
  });

  test('searchable', async () => {
    const r = (await api(app, alice.token).get('/api/search?q=zebra')).body;
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].text, 'Next day message with zebra');
    const priv = (await api(app, owner.token).get('/api/search?q=private plans')).body;
    assert.equal(priv.messages.length, 0, 'owner is not in the private channel');
  });

  test('realtime: progress to the admin, one done signal, no message storm', async () => {
    await waitFor(() => aliceSock.events.some((e) => e[0] === 'import:done'));
    assert.ok(ownerSock.events.some((e) => e[0] === 'import:progress' && e[1].id === job1.id));
    assert.ok(ownerSock.events.some((e) => e[0] === 'import:progress' && e[1].state === 'done'));
    assert.ok(!aliceSock.events.some((e) => e[0] === 'import:progress'));
    for (const s of [ownerSock, aliceSock]) {
      assert.ok(!s.events.some((e) => e[0] === 'message:new' || e[0] === 'activity:new'), JSON.stringify(s.events.map((e) => e[0])));
    }
  });

  test('the latest job can be fetched', async () => {
    const r = await api(app, owner.token).get('/api/admin/import/slack');
    assert.equal(r.body.job.id, job1.id);
  });
});

describe('re-import', () => {
  test('the same export adds nothing', async () => {
    const before = {
      users: count('SELECT COUNT(*) AS n FROM users'),
      channels: count('SELECT COUNT(*) AS n FROM channels'),
      messages: count('SELECT COUNT(*) AS n FROM messages'),
      reactions: count('SELECT COUNT(*) AS n FROM reactions'),
      files: count('SELECT COUNT(*) AS n FROM files'),
      members: count('SELECT COUNT(*) AS n FROM channel_members'),
    };
    const job = await runImport(owner.token, zip(exportFiles()));
    assert.equal(job.state, 'done', job.error);
    assert.deepEqual(job.counts, { users: 0, channels: 0, messages: 0, files: 0, reactions: 0 });
    assert.deepEqual(
      {
        users: count('SELECT COUNT(*) AS n FROM users'),
        channels: count('SELECT COUNT(*) AS n FROM channels'),
        messages: count('SELECT COUNT(*) AS n FROM messages'),
        reactions: count('SELECT COUNT(*) AS n FROM reactions'),
        files: count('SELECT COUNT(*) AS n FROM files'),
        members: count('SELECT COUNT(*) AS n FROM channel_members'),
      },
      before,
    );
    // the failed file link is not duplicated
    assert.equal(msgByText('broken file').text.match(/:paperclip:/g).length, 1);
  });

  test('a newer export adds only what is new, keeping order and read state', async () => {
    const gid = generalId();
    // somebody wrote here in the meantime: the newer Slack history (older timestamps) must go before it
    const local = await api(app, owner.token).post(`/api/channels/${gid}/messages`, { text: 'written in Relay' });
    assert.equal(local.status, 200);
    const newer = exportFiles({
      'company/2020-01-03.json': json([
        { type: 'message', user: 'U003', text: 'late Slack message', ts: ts(2 * 86400 + 5), reactions: [{ name: 'tada', users: ['U002'], count: 1 }] },
        { type: 'message', user: 'U002', text: 'late reply', ts: ts(2 * 86400 + 6), thread_ts: ts(20) },
      ]),
    });
    const job = await runImport(owner.token, zip(newer), { importFiles: 'false' });
    assert.equal(job.state, 'done', job.error);
    assert.equal(job.counts.messages, 2);
    assert.equal(job.counts.reactions, 1);
    assert.equal(job.counts.users, 0);
    const msgs = (await api(app, owner.token).get(`/api/channels/${gid}/messages?limit=200`)).body.messages as any[];
    for (let i = 1; i < msgs.length; i++) assert.ok(msgs[i].createdAt >= msgs[i - 1].createdAt, `ordered at ${i}`);
    assert.equal(msgs[msgs.length - 1].text, 'written in Relay');
    assert.equal(msgByText('Thread root').reply_count, 3);
    // alice hadn't read the Relay message: still unread; the imported one isn't
    const m = (await api(app, alice.token).get('/api/bootstrap')).body.memberships.find((x: any) => x.channelId === gid);
    assert.equal(m.unread, 1);
    const o = (await api(app, owner.token).get('/api/bootstrap')).body.memberships.find((x: any) => x.channelId === gid);
    assert.equal(o.unread, 0, 'posting marked everything before it as read');
  });
});

describe('claiming imported accounts', () => {
  test('needs a personal invite from an admin', async () => {
    const generic = (await api(app, owner.token).post('/api/invites', { role: 'member' })).body;
    const r1 = await api(app).post('/api/auth/signup', { inviteCode: generic.code, fullName: 'Bob', email: 'bob@example.com', password: 'password123' });
    assert.equal(r1.status, 409);
    assert.equal(r1.body.error, 'claim_needs_personal_invite');
    const byMember = (await api(app, alice.token).post('/api/invites', { email: 'bob@example.com' })).body;
    const r2 = await api(app).post('/api/auth/signup', { inviteCode: byMember.code, fullName: 'Bob', email: 'bob@example.com', password: 'password123' });
    assert.equal(r2.status, 409);
    // a real account is still "taken"
    const forAlice = (await api(app, owner.token).post('/api/invites', { email: 'alice@example.com' })).body;
    const r3 = await api(app).post('/api/auth/signup', { inviteCode: forAlice.code, fullName: 'Alice', email: 'alice@example.com', password: 'password123' });
    assert.equal(r3.status, 409);
    assert.equal(r3.body.error, 'email_taken');
  });

  test('signing up with an admin’s personal invite takes over the account and its history', async () => {
    const bobId = userByEmail('bob@example.com').id;
    const inv = (await api(app, owner.token).post('/api/invites', { email: 'Bob@Example.com' })).body;
    const r = await api(app).post('/api/auth/signup', { inviteCode: inv.code, fullName: 'Robert Builder', email: 'bob@example.com', password: 'password123' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.me.id, bobId);
    assert.equal(r.body.me.fullName, 'Robert Builder');
    assert.equal(r.body.me.imported, undefined);
    const row = userByEmail('bob@example.com');
    assert.equal(row.imported, 0);
    assert.equal(row.title, 'Engineer');
    const boot = (await api(app, r.body.token).get('/api/bootstrap')).body;
    assert.ok(boot.channels.some((c: any) => c.name === 'secret'));
    assert.ok(boot.channels.some((c: any) => c.kind === 'dm'));
    const login = await api(app).post('/api/auth/login', { email: 'bob@example.com', password: 'password123' });
    assert.equal(login.status, 200);
  });

  test('a deleted Slack user is reactivated when claimed', async () => {
    const inv = (await api(app, owner.token).post('/api/invites', { email: 'dan@example.com' })).body;
    const r = await api(app).post('/api/auth/signup', { inviteCode: inv.code, fullName: 'Dan', email: 'dan@example.com', password: 'password123' });
    assert.equal(r.status, 200);
    assert.equal(userByEmail('dan@example.com').deactivated, 0);
  });
});

describe('options', () => {
  test('private channels and DMs can be left out', async () => {
    const files = exportFiles();
    const data: Record<string, string> = {
      'users.json': files['users.json'],
      'channels.json': json([{ id: 'C900', name: 'only-public', created: T0, members: ['U001'] }]),
      'groups.json': json([{ id: 'G900', name: 'hidden-private', created: T0, members: ['U001'] }]),
      'dms.json': json([{ id: 'D900', created: T0, members: ['U001', 'U005'] }]),
      'only-public/2020-01-01.json': json([{ type: 'message', user: 'U001', text: 'public hello', ts: ts(500) }]),
      'hidden-private/2020-01-01.json': json([{ type: 'message', user: 'U001', text: 'private hello', ts: ts(500) }]),
      'D900/2020-01-01.json': json([{ type: 'message', user: 'U001', text: 'dm hello', ts: ts(500) }]),
    };
    const job = await runImport(owner.token, zip(data), { importPrivate: 'false', importDms: 'false', importFiles: 'false' });
    assert.equal(job.state, 'done', job.error);
    assert.equal(job.counts.messages, 1);
    assert.ok(msgByText('public hello'));
    assert.equal(msgByText('private hello'), undefined);
    assert.equal(msgByText('dm hello'), undefined);
    assert.ok(job.warnings.some((w: string) => w.includes('private channels were skipped')));
  });
});
