import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { addUser, api, closeApp, createApp, png, setupOwner, waitFor, type Session } from './helpers.ts';

let app: FastifyInstance;
let owner: Session;
let alice: Session;
let bob: Session;
let db: typeof import('../src/db.ts');
let bridge: typeof import('../src/slack/bridge.ts');
let services: typeof import('../src/services.ts');
let SlackError: typeof import('../src/slack/api.ts').SlackError;
let SlackApi: typeof import('../src/slack/api.ts').SlackApi;
let general: any;
let linked: any;
let avatarUrl: string;
let avatarServer: http.Server;

const silence = async <T>(fn: () => Promise<T> | T) => {
  const e = console.error;
  const l = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.error = e;
    console.log = l;
  }
};

// ---------- a fake Slack Web API (object handed to the bridge) ----------

class FakeSlack {
  calls: { method: string; params: any }[] = [];
  uploads: any[] = [];
  users: Record<string, any> = {};
  channels: Record<string, any> = {};
  history: Record<string, any[]> = {};
  replies: Record<string, any[]> = {};
  failNext: Record<string, string> = {};
  ts = Math.floor(Date.now() / 1000);
  async call(method: string, params: any = {}) {
    this.calls.push({ method, params });
    const err = this.failNext[method];
    if (err) {
      delete this.failNext[method];
      throw new SlackError(err, method);
    }
    switch (method) {
      case 'users.info': {
        const u = this.users[params.user];
        if (!u) throw new SlackError('user_not_found', method);
        return { ok: true, user: u };
      }
      case 'chat.postMessage':
        return { ok: true, ts: `${this.ts++}.000100` };
      case 'conversations.info': {
        const c = this.channels[params.channel];
        if (!c) throw new SlackError('channel_not_found', method);
        return { ok: true, channel: c };
      }
      case 'conversations.list': {
        const all = Object.values(this.channels);
        if (!params.cursor) return { ok: true, channels: all.slice(0, 1), response_metadata: { next_cursor: 'page2' } };
        return { ok: true, channels: all.slice(1), response_metadata: { next_cursor: '' } };
      }
      case 'conversations.history':
        return { ok: true, messages: [...(this.history[params.channel] ?? [])] };
      case 'conversations.replies':
        return { ok: true, messages: this.replies[params.ts] ?? [] };
      default:
        return { ok: true };
    }
  }
  async download(url: string) {
    if (url.includes('broken')) throw new Error('Slack file download failed: 404');
    return new Response(Buffer.from('slack file content'));
  }
  async uploadFile(o: any) {
    this.uploads.push(o);
    if (o.filename === 'fail.txt') throw new Error('upload failed');
    return { ok: true };
  }
  of(method: string) {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }
}

let fake: FakeSlack;
const SLACK_CH = 'CSLACK001';
const nextTs = () => `${fake.ts++}.000200`;
const relayMsgForTs = (ts: string) => db.get<{ relay_message_id: number }>('SELECT relay_message_id FROM slack_messages WHERE slack_ts = ?', ts)?.relay_message_id;
const msgRow = (id: number) => db.get<any>('SELECT * FROM messages WHERE id = ?', id);
const slackMessage = (extra: Record<string, unknown>) => ({ type: 'message', channel: SLACK_CH, ts: nextTs(), ...extra });

before(async () => {
  avatarServer = http.createServer((req, res) => {
    if (req.url === '/missing.png') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': req.url?.endsWith('.png') ? 'image/png' : 'image/jpeg' });
    res.end(png(3, 3));
  });
  await new Promise<void>((r) => avatarServer.listen(0, '127.0.0.1', r));
  avatarUrl = `http://127.0.0.1:${(avatarServer.address() as AddressInfo).port}`;

  ({ app } = await createApp({ PUBLIC_URL: 'https://relay.example.com/', SLACK_BOT_TOKEN: undefined, SLACK_APP_TOKEN: undefined }));
  db = await import('../src/db.ts');
  bridge = await import('../src/slack/bridge.ts');
  services = await import('../src/services.ts');
  ({ SlackError, SlackApi } = await import('../src/slack/api.ts'));
  owner = await setupOwner(app);
  alice = await addUser(app, owner.token, { name: 'Alice Liddell', email: 'alice@example.com' });
  bob = await addUser(app, owner.token, { name: 'Bob', email: 'bob@example.com' });
  general = (await api(app, owner.token).get('/api/bootstrap')).body.channels.find((c: any) => c.name === 'general');
  bridge.initSlackBridge(); // no tokens: registers the outbound listeners, does not connect
  bridge.initSlackBridge();
  fake = new FakeSlack();
  fake.channels = {
    [SLACK_CH]: { id: SLACK_CH, name: 'slack-general', is_member: false, is_private: false, num_members: 7 },
    CPRIV: { id: 'CPRIV', name: 'a-private', is_member: false, is_private: true },
  };
  fake.users = {
    UALICE: { id: 'UALICE', name: 'alice', real_name: 'Alice L', tz: 'Europe/London', profile: { email: 'ALICE@example.com', display_name: 'alice' } },
    USTRANGER: {
      id: 'USTRANGER',
      name: 'stranger',
      real_name: 'Sam Stranger',
      tz: 'America/New_York',
      profile: { email: 'sam@elsewhere.com', display_name: 'sammy', real_name: 'Sam Stranger', title: 'Consultant', image_192: `${avatarUrl}/sam.jpg` },
    },
    UNOAVATAR: { id: 'UNOAVATAR', name: 'nobody', profile: { image_72: `${avatarUrl}/missing.png` } },
    UBOTUSER: { id: 'UBOTUSER', name: 'helperbot', is_bot: true, profile: {} },
    UDOWN: { id: 'UDOWN', name: 'down', profile: { image_192: 'http://127.0.0.1:1/unreachable.png' } },
  };
  bridge._internals.setApi(fake, { botUserId: 'UBOT', botId: 'BBOT' });
});
after(async () => {
  bridge.stopSlackBridge();
  await closeApp(app);
  await new Promise((r) => avatarServer.close(r));
});

describe('admin routes & linking', () => {
  test('status, manifest and permissions', async () => {
    assert.equal((await api(app, alice.token).get('/api/slack')).status, 403);
    assert.equal((await api(app).get('/api/slack')).status, 401);
    const r = await api(app, owner.token).get('/api/slack');
    assert.equal(r.status, 200);
    assert.equal(r.body.connected, true);
    assert.equal(r.body.botTokenSet, false);
    assert.equal(r.body.fromEnv, false);
    assert.deepEqual(r.body.links, []);
    assert.match(r.body.manifest, /socket_mode_enabled: true/);
  });

  test('list Slack channels (paginated, sorted)', async () => {
    const r = await api(app, owner.token).get('/api/slack/channels');
    assert.deepEqual(r.body, [
      { id: 'CPRIV', name: 'a-private', isPrivate: true, isMember: false, members: 0 },
      { id: SLACK_CH, name: 'slack-general', isPrivate: false, isMember: false, members: 7 },
    ]);
    fake.failNext['conversations.list'] = 'ratelimited';
    const e = await api(app, owner.token).get('/api/slack/channels');
    assert.equal(e.status, 400);
    assert.equal(e.body.error, 'slack_error');
    assert.equal(e.body.message, 'Slack conversations.list: ratelimited');
  });

  test('link a channel (joins it and imports history), validation and errors', async () => {
    const o = api(app, owner.token);
    const dm = (await o.post('/api/dms', { userIds: [alice.me.id] })).body.channel;
    assert.equal((await o.post('/api/slack/links', { relayChannelId: dm.id, slackChannelId: SLACK_CH })).body.error, 'invalid_channel');
    assert.equal((await o.post('/api/slack/links', { relayChannelId: 'NOPE', slackChannelId: SLACK_CH })).body.error, 'invalid_channel');
    linked = (await o.post('/api/channels', { name: 'bridged', memberIds: [alice.me.id, bob.me.id] })).body;
    const priv = await o.post('/api/slack/links', { relayChannelId: linked.id, slackChannelId: 'CPRIV' });
    assert.equal(priv.status, 400);
    assert.match(priv.body.message, /Invite the Relay app/);

    // history: a root with a reply, plus a message of our own bot that must be skipped
    const rootTs = nextTs();
    fake.history[SLACK_CH] = [
      { type: 'message', user: 'UALICE', text: 'second from history', ts: nextTs() },
      { type: 'message', user: 'UALICE', text: 'first from history', ts: rootTs, reply_count: 1 },
      { type: 'message', bot_id: 'BBOT', text: 'echo of ours', ts: nextTs() },
    ].reverse();
    fake.replies[rootTs] = [
      { type: 'message', user: 'UALICE', text: 'first from history', ts: rootTs, thread_ts: rootTs },
      { type: 'message', user: 'UALICE', text: 'reply from history', ts: nextTs(), thread_ts: rootTs },
    ];
    const r = await o.post('/api/slack/links', { relayChannelId: linked.id, slackChannelId: SLACK_CH, importHistory: 10 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [{ relayChannelId: linked.id, slackChannelId: SLACK_CH, slackChannelName: 'slack-general' }]);
    assert.deepEqual(fake.of('conversations.join'), [{ channel: SLACK_CH }]);
    const ch = (await o.get(`/api/channels/${linked.id}`)).body.channel;
    assert.deepEqual(ch.bridge, { kind: 'slack', name: 'slack-general' });
    await waitFor(() => relayMsgForTs(fake.replies[rootTs][1].ts));
    const rootId = relayMsgForTs(rootTs)!;
    assert.equal(msgRow(rootId).text, 'first from history');
    assert.equal(msgRow(rootId).user_id, alice.me.id); // matched by email
    assert.equal(msgRow(relayMsgForTs(fake.replies[rootTs][1].ts)!).thread_root_id, rootId);
    const texts = (await o.get(`/api/channels/${linked.id}/messages`)).body.messages.map((m: any) => m.text);
    assert.ok(texts.includes('Slack #slack-general')); // bridge system message
    assert.ok(!texts.includes('echo of ours'));
    // the system message about the link is not sent to Slack
    assert.equal(fake.of('chat.postMessage').length, 0);

    // relinking another channel to the same Slack channel moves the link
    const other = (await o.post('/api/channels', { name: 'bridged-2' })).body;
    fake.channels[SLACK_CH].is_member = true;
    await o.post('/api/slack/links', { relayChannelId: other.id, slackChannelId: SLACK_CH });
    assert.deepEqual(bridge.listLinks().map((l) => l.relayChannelId), [other.id]);
    assert.deepEqual((await o.del(`/api/slack/links/${other.id}`)).body, []);
    await o.post('/api/slack/links', { relayChannelId: linked.id, slackChannelId: SLACK_CH });
    assert.equal(bridge.listLinks().length, 1);
  });
});

describe('text conversion', () => {
  test('relay -> Slack', async () => {
    db.run('INSERT OR REPLACE INTO slack_users (slack_user_id, relay_user_id) VALUES (?, ?)', 'UALICE', alice.me.id);
    const { relayToSlack } = bridge._internals;
    assert.equal(relayToSlack(`hi <@${alice.me.id}> and <@${bob.me.id}> and <@UNKNOWN1>`), 'hi <@UALICE> and @Bob and <@UNKNOWN1>');
    assert.equal(relayToSlack(`see <#${linked.id}> and <#${general.id}> and <#CNOPE>`), `see <#${SLACK_CH}> and #general and #channel`);
    assert.equal(relayToSlack('**bold** ~~gone~~ [docs](https://x.dev/a) a<b & c>d'), '*bold* ~gone~ <https://x.dev/a|docs> a&lt;b &amp; c&gt;d');
    assert.equal(relayToSlack('code `a<b && **x**` and ```\n<tag>\n```'), 'code `a&lt;b &amp;&amp; **x**` and ```\n&lt;tag&gt;\n```');
    assert.equal(relayToSlack('link <https://example.com> stays'), 'link <https://example.com> stays');
  });

  test('Slack -> relay', async () => {
    const { slackToRelay } = bridge._internals;
    assert.equal(await slackToRelay(''), '');
    const out = await slackToRelay(
      `<@UALICE> <@UGHOST|ghost> <@UBOT|relay> <#${SLACK_CH}|slack-general> <#COTHER|other> <!subteam^S1|@devs> <!subteam^S2> <!date^1700000000^{date}|Nov 14> <mailto:a@b.c|a@b.c> &lt;3 &amp; @bob (@nobody)`,
    );
    assert.equal(out, `<@${alice.me.id}> @ghost @relay <#${linked.id}> #other @devs @group Nov 14 a@b.c <3 & <@${bob.me.id}> (@nobody)`);
  });
});

describe('Slack -> relay events', () => {
  test('ignored events', async () => {
    const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')!.n;
    const h = bridge._internals.handleEvent;
    await h(null);
    await h({ type: 'unknown_event' });
    await h(slackMessage({ channel: 'CUNLINKED', user: 'UALICE', text: 'elsewhere' }));
    await h(slackMessage({ subtype: 'channel_join', user: 'UALICE', text: 'joined' }));
    await h(slackMessage({ hidden: true, user: 'UALICE', text: 'hidden' }));
    await h(slackMessage({ bot_id: 'BBOT', text: 'our own echo' }));
    await h(slackMessage({ user: 'UBOT', text: 'our own echo 2' }));
    await h(slackMessage({ user: 'UALICE', text: '' }));
    await h({ type: 'reaction_added', user: 'UBOT', reaction: 'x', item: { type: 'message', channel: SLACK_CH, ts: '1' } });
    await h({ type: 'reaction_added', user: 'UALICE', reaction: 'x', item: { type: 'file' } });
    await h({ type: 'reaction_added', user: 'UALICE', reaction: 'x', item: { type: 'message', channel: SLACK_CH, ts: 'unknown' } });
    await h({ type: 'message', subtype: 'message_changed', channel: SLACK_CH, message: { ts: 'unknown', text: 'x' } });
    await h({ type: 'message', subtype: 'message_changed', channel: SLACK_CH, message: { ts: 'x', bot_id: 'BBOT', text: 'x' } });
    await h({ type: 'message', subtype: 'message_changed', channel: SLACK_CH });
    await h({ type: 'message', subtype: 'message_deleted', channel: SLACK_CH, deleted_ts: 'unknown' });
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')!.n, before);
  });

  test('messages from a new Slack user create a puppet account', async () => {
    const ev = slackMessage({ user: 'USTRANGER', text: 'hello from slack' });
    // two concurrent events from the same new user create only one account
    await Promise.all([bridge._internals.handleEvent(ev), bridge.ensurePuppet('USTRANGER')]);
    const id = relayMsgForTs(ev.ts)!;
    const row = msgRow(id);
    assert.equal(row.text, 'hello from slack');
    assert.equal(JSON.parse(row.meta).source, 'slack');
    assert.equal(row.created_at, Math.round(Number(ev.ts) * 1000));
    const puppet = db.get<any>('SELECT * FROM users WHERE id = ?', row.user_id);
    assert.equal(puppet.external, 'slack');
    assert.equal(puppet.role, 'guest');
    assert.equal(puppet.full_name, 'Sam Stranger');
    assert.equal(puppet.display_name, 'sammy');
    assert.equal(puppet.username, 'sammy');
    assert.equal(puppet.title, 'Consultant');
    assert.equal(puppet.timezone, 'America/New_York');
    assert.match(puppet.avatar_path, /-slack-USTRANGER\.jpg$/);
    assert.equal(db.all('SELECT 1 FROM slack_users WHERE slack_user_id = ?', 'USTRANGER').length, 1);
    // joined silently
    assert.ok(db.get('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?', linked.id, puppet.id));
    assert.equal(db.get("SELECT 1 FROM messages WHERE channel_id = ? AND user_id = ? AND subtype = 'join'", linked.id, puppet.id), undefined);
    // puppets can't log in
    assert.equal((await api(app).post('/api/auth/login', { email: puppet.email, password: '!' })).status, 401);
    // not echoed back to Slack
    assert.equal(fake.of('chat.postMessage').length, 0);
    // the same ts again is ignored
    await bridge._internals.handleEvent(ev);
    assert.equal(db.all('SELECT 1 FROM slack_messages WHERE slack_ts = ?', ev.ts).length, 1);

    // a user without avatar / bot user
    const ev2 = slackMessage({ user: 'UNOAVATAR', text: 'no avatar' });
    await bridge._internals.handleEvent(ev2);
    const p2 = db.get<any>('SELECT * FROM users WHERE id = ?', msgRow(relayMsgForTs(ev2.ts)!).user_id);
    assert.equal(p2.avatar_path, null);
    assert.equal(p2.full_name, 'nobody');
    const ev4 = slackMessage({ user: 'UDOWN', text: 'avatar host down' });
    await bridge._internals.handleEvent(ev4);
    assert.equal(db.get<any>('SELECT avatar_path FROM users WHERE id = ?', msgRow(relayMsgForTs(ev4.ts)!).user_id).avatar_path, null);
    const ev3 = slackMessage({ user: 'UBOTUSER', text: 'beep' });
    await bridge._internals.handleEvent(ev3);
    assert.equal(db.get<any>('SELECT is_bot FROM users WHERE id = ?', msgRow(relayMsgForTs(ev3.ts)!).user_id).is_bot, 1);
  });

  test('threads, broadcasts, /me, bots, attachments and files', async () => {
    const h = bridge._internals.handleEvent;
    const root = slackMessage({ user: 'UALICE', text: 'root' });
    await h(root);
    const rootId = relayMsgForTs(root.ts)!;
    const reply = slackMessage({ user: 'USTRANGER', text: 'reply', thread_ts: root.ts });
    await h(reply);
    assert.equal(msgRow(relayMsgForTs(reply.ts)!).thread_root_id, rootId);
    const bc = slackMessage({ subtype: 'thread_broadcast', user: 'USTRANGER', text: 'broadcast', thread_ts: root.ts });
    await h(bc);
    assert.equal(msgRow(relayMsgForTs(bc.ts)!).also_in_channel, 1);
    assert.equal(msgRow(rootId).reply_count, 2);
    // a reply to an unknown root becomes a top-level message
    const orphan = slackMessage({ user: 'UALICE', text: 'orphan', thread_ts: 'unknown.1' });
    await h(orphan);
    assert.equal(msgRow(relayMsgForTs(orphan.ts)!).thread_root_id, null);

    const me = slackMessage({ subtype: 'me_message', user: 'UALICE', text: 'waves' });
    await h(me);
    assert.equal(msgRow(relayMsgForTs(me.ts)!).text, '_waves_');

    const bot = slackMessage({ subtype: 'bot_message', bot_id: 'BOTHER', username: 'Deploy Bot', text: 'deployed' });
    await h(bot);
    const botRow = msgRow(relayMsgForTs(bot.ts)!);
    assert.equal(botRow.user_id, null);
    assert.equal(botRow.subtype, 'bot');
    assert.equal(JSON.parse(botRow.meta).botName, 'Deploy Bot');
    const att = slackMessage({ bot_id: 'BOTHER', bot_profile: { name: 'Jira' }, text: '', attachments: [{ fallback: 'Issue created' }, { text: 'second' }, {}] });
    await h(att);
    const attRow = msgRow(relayMsgForTs(att.ts)!);
    assert.equal(attRow.text, 'Issue created\nsecond');
    assert.equal(JSON.parse(attRow.meta).botName, 'Jira');
    const anon = slackMessage({ bot_id: 'BOTHER', text: 'anon' });
    await h(anon);
    assert.equal(JSON.parse(msgRow(relayMsgForTs(anon.ts)!).meta).botName, 'Slack app');

    const withFiles = slackMessage({
      user: 'UALICE',
      text: '',
      files: [
        { name: 'report.pdf', mimetype: 'application/pdf', url_private_download: 'https://files.slack.com/report.pdf', size: 18 },
        { name: 'photo.png', mimetype: 'image/png', url_private: 'https://files.slack.com/photo.png', original_w: 640, original_h: 480 },
        { name: 'huge.bin', url_private: 'https://files.slack.com/huge', size: 10 ** 12 },
        { name: 'broken.txt', url_private: 'https://files.slack.com/broken' },
        { name: 'nourl.txt' },
      ],
    });
    await silence(() => h(withFiles));
    const fileMsg = (await api(app, alice.token).get(`/api/messages/${relayMsgForTs(withFiles.ts)}`)).body;
    assert.deepEqual(fileMsg.files.map((f: any) => [f.name, f.mime, f.width]), [
      ['report.pdf', 'application/pdf', null],
      ['photo.png', 'image/png', 640],
    ]);
    const dl = await api(app, alice.token).get(fileMsg.files[0].url);
    assert.equal(dl.body, 'slack file content');
    // file-less, text-less message after failed downloads is dropped
    const nothing = slackMessage({ user: 'UALICE', text: '', files: [{ name: 'broken2', url_private: 'https://files.slack.com/broken' }] });
    await silence(() => h(nothing));
    assert.equal(relayMsgForTs(nothing.ts), undefined);
  });

  test('edits, deletes and reactions from Slack', async () => {
    const h = bridge._internals.handleEvent;
    const ev = slackMessage({ user: 'USTRANGER', text: 'original' });
    await h(ev);
    const id = relayMsgForTs(ev.ts)!;
    await h({ type: 'message', subtype: 'message_changed', channel: SLACK_CH, message: { ts: ev.ts, user: 'USTRANGER', text: 'edited <@UALICE>' } });
    assert.equal(msgRow(id).text, `edited <@${alice.me.id}>`);
    assert.ok(msgRow(id).edited_at);
    const editedAt = msgRow(id).edited_at;
    await h({ type: 'message', subtype: 'message_changed', channel: SLACK_CH, message: { ts: ev.ts, user: 'USTRANGER', text: 'edited <@UALICE>' } });
    assert.equal(msgRow(id).edited_at, editedAt); // unchanged text (e.g. unfurl) is ignored

    await h({ type: 'reaction_added', user: 'UALICE', reaction: 'thumbsup', item: { type: 'message', channel: SLACK_CH, ts: ev.ts } });
    await h({ type: 'reaction_added', user: 'USTRANGER', reaction: 'thumbsup', item: { type: 'message', channel: SLACK_CH, ts: ev.ts } });
    let msg = (await api(app, alice.token).get(`/api/messages/${id}`)).body;
    assert.equal(msg.reactions[0].userIds.length, 2);
    await h({ type: 'reaction_removed', user: 'UALICE', reaction: 'thumbsup', item: { type: 'message', channel: SLACK_CH, ts: ev.ts } });
    msg = (await api(app, alice.token).get(`/api/messages/${id}`)).body;
    assert.equal(msg.reactions[0].userIds.length, 1);
    // reactions from Slack are not mirrored back
    assert.equal(fake.of('reactions.add').length, 0);

    await h({ type: 'message', subtype: 'message_deleted', channel: SLACK_CH, deleted_ts: ev.ts });
    assert.ok(msgRow(id).deleted_at);
    assert.equal(fake.of('chat.delete').length, 0); // no echo
    // edits of deleted messages are ignored
    await h({ type: 'message', subtype: 'message_changed', channel: SLACK_CH, message: { ts: ev.ts, user: 'USTRANGER', text: 'zombie' } });
    assert.equal(msgRow(id).text, '');
  });

  test('user changes and channel renames', async () => {
    const h = bridge._internals.handleEvent;
    await h({
      type: 'user_change',
      user: { id: 'USTRANGER', tz: '', deleted: true, profile: { real_name: 'Samuel S', display_name: 'sam2', title: 'CTO', status_emoji: ':palm_tree:', status_text: 'Away', image_192: `${avatarUrl}/new.png` } },
    });
    const pid = db.get<{ relay_user_id: string }>('SELECT relay_user_id FROM slack_users WHERE slack_user_id = ?', 'USTRANGER')!.relay_user_id;
    const p = db.get<any>('SELECT * FROM users WHERE id = ?', pid);
    assert.deepEqual(
      [p.full_name, p.display_name, p.title, p.timezone, p.status_emoji, p.status_text, p.deactivated],
      ['Samuel S', 'sam2', 'CTO', 'America/New_York', 'palm_tree', 'Away', 1],
    );
    assert.match(p.avatar_path, /\.png$/);
    // linked to a real account: never overwritten
    await h({ type: 'user_change', user: { id: 'UALICE', profile: { real_name: 'Hacked' } } });
    await h({ type: 'user_change', user: { id: 'UNKNOWNUSER', profile: {} } });
    assert.equal(db.get<any>('SELECT full_name FROM users WHERE id = ?', alice.me.id).full_name, 'Alice Liddell');

    await h({ type: 'channel_rename', channel: { id: SLACK_CH, name: 'renamed' } });
    assert.equal(bridge.listLinks()[0].slackChannelName, 'renamed');
    await h({ type: 'group_rename', channel: {} });
  });
});

describe('relay -> Slack', () => {
  test('messages, threads, files and bots are posted with the author identity', async () => {
    fake.calls.length = 0;
    await api(app, alice.token).upload('/api/users/me/avatar', [{ filename: 'a.png', content: png(), contentType: 'image/png' }], {}, 'PUT');
    const a = api(app, alice.token);
    const m = (await a.post(`/api/channels/${linked.id}/messages`, { text: `**hi** <@${bob.me.id}>` })).body;
    const post = await waitFor(() => fake.of('chat.postMessage').find((p) => p.text === '*hi* @Bob'));
    assert.equal(post.channel, SLACK_CH);
    assert.equal(post.username, 'Alice Liddell');
    assert.match(post.icon_url, new RegExp(`^https://relay\\.example\\.com/api/public/avatars/${alice.me.id}/[0-9a-f]{24}$`));
    assert.equal(post.thread_ts, undefined);
    await waitFor(() => db.get('SELECT 1 FROM slack_messages WHERE relay_message_id = ?', m.id));

    // the signed avatar URL is public
    const avatarPath = new URL(post.icon_url).pathname;
    const img = await api(app).get(avatarPath);
    assert.equal(img.status, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.equal((await api(app).get(avatarPath.replace(/[0-9a-f]{24}$/, 'f'.repeat(24)))).status, 404);
    assert.equal((await api(app).get(`/api/public/avatars/${bob.me.id}/abc`)).status, 404);
    // puppet avatars (jpeg) are served as well
    const puppet = db.get<any>("SELECT * FROM users WHERE external = 'slack' AND avatar_path IS NOT NULL LIMIT 1");
    const purl = bridge.publicAvatarUrl(puppet)!;
    assert.equal((await api(app).get(new URL(purl).pathname)).headers['content-type'], 'image/png');

    // replies go into the Slack thread; broadcasts set reply_broadcast
    const r = (await a.post(`/api/channels/${linked.id}/messages`, { text: 'in thread', threadRootId: m.id, alsoInChannel: true })).body;
    const rp = await waitFor(() => fake.of('chat.postMessage').find((p) => p.text === 'in thread'));
    assert.equal(rp.thread_ts, db.get<any>('SELECT slack_ts FROM slack_messages WHERE relay_message_id = ?', m.id).slack_ts);
    assert.equal(rp.reply_broadcast, true);
    assert.ok(r.id);

    // files: uploaded into the thread of the text message; file-only messages get the author as comment
    const up = await a.upload('/api/files', [
      { filename: 'notes.txt', content: 'n', contentType: 'text/plain' },
      { filename: 'fail.txt', content: 'f', contentType: 'text/plain' },
    ]);
    await silence(async () => {
      await a.post(`/api/channels/${linked.id}/messages`, { text: 'with file', fileIds: [up.body[0].id, up.body[1].id] });
      await waitFor(() => fake.uploads.length >= 2);
    });
    assert.equal(fake.uploads[0].filename, 'notes.txt');
    assert.equal(fake.uploads[0].initialComment, undefined);
    assert.ok(fake.uploads[0].threadTs);
    assert.equal(fake.uploads[0].data.toString(), 'n');
    const up2 = await a.upload('/api/files', [{ filename: 'only.txt', content: 'o', contentType: 'text/plain' }]);
    await a.post(`/api/channels/${linked.id}/messages`, { text: '', fileIds: [up2.body[0].id] });
    const fileOnly = await waitFor(() => fake.uploads.find((u) => u.filename === 'only.txt'));
    assert.equal(fileOnly.initialComment, '*Alice Liddell*');
    assert.equal(fileOnly.threadTs, undefined);

    // webhook/bot messages carry their bot name
    services.postMessage({ channelId: linked.id, userId: null, text: 'from a hook', subtype: 'bot', botName: 'CI' });
    const hookPost = await waitFor(() => fake.of('chat.postMessage').find((p) => p.text === 'from a hook'));
    assert.equal(hookPost.username, 'CI');
    services.postMessage({ channelId: linked.id, userId: null, text: 'nameless', subtype: 'bot' });
    assert.equal((await waitFor(() => fake.of('chat.postMessage').find((p) => p.text === 'nameless'))).username, 'Relay');

    // system messages and other channels are not mirrored
    const n = fake.of('chat.postMessage').length;
    await a.patch(`/api/channels/${linked.id}`, { topic: 'new topic' });
    await a.post(`/api/channels/${general.id}/messages`, { text: 'not bridged' });
    const marker = (await a.post(`/api/channels/${linked.id}/messages`, { text: 'marker' })).body;
    await waitFor(() => fake.of('chat.postMessage').find((p) => p.text === 'marker'));
    assert.equal(fake.of('chat.postMessage').length, n + 1);
    assert.ok(marker.id);
  });

  test('edits, deletes and reactions are mirrored', async () => {
    const a = api(app, alice.token);
    const b = api(app, bob.token);
    const m = (await a.post(`/api/channels/${linked.id}/messages`, { text: 'mirror me' })).body;
    const ref = await waitFor(() => db.get<{ slack_ts: string }>('SELECT slack_ts FROM slack_messages WHERE relay_message_id = ?', m.id));

    await a.patch(`/api/messages/${m.id}`, { text: 'mirror me ~~now~~' });
    const upd = await waitFor(() => fake.of('chat.update').find((p) => p.ts === ref.slack_ts));
    assert.deepEqual(upd, { channel: SLACK_CH, ts: ref.slack_ts, text: 'mirror me ~now~' });

    await a.post(`/api/messages/${m.id}/reactions`, { emoji: 'tada' });
    await waitFor(() => fake.of('reactions.add').find((p) => p.timestamp === ref.slack_ts && p.name === 'tada'));
    // "already_reacted" is fine
    fake.failNext['reactions.add'] = 'already_reacted';
    await b.post(`/api/messages/${m.id}/reactions`, { emoji: 'tada' });
    await waitFor(() => fake.of('reactions.add').length >= 2);
    // still reacted by bob here -> keep the bot's reaction
    await a.del(`/api/messages/${m.id}/reactions/tada`);
    await b.post(`/api/messages/${m.id}/reactions`, { emoji: 'eyes' });
    await waitFor(() => fake.of('reactions.add').find((p) => p.name === 'eyes'));
    assert.equal(fake.of('reactions.remove').length, 0);
    fake.failNext['reactions.remove'] = 'no_reaction';
    await b.del(`/api/messages/${m.id}/reactions/tada`);
    await waitFor(() => fake.of('reactions.remove').length === 1);
    // other errors are logged, the queue keeps going
    fake.failNext['reactions.remove'] = 'internal_error';
    await silence(async () => {
      await b.del(`/api/messages/${m.id}/reactions/eyes`);
      await waitFor(() => fake.of('reactions.remove').length === 2);
      fake.failNext['chat.postMessage'] = 'channel_not_found';
      await a.post(`/api/channels/${linked.id}/messages`, { text: 'lost' });
      await waitFor(() => fake.of('chat.postMessage').some((p) => p.text === 'lost'));
    });
    await a.post(`/api/channels/${linked.id}/messages`, { text: 'after the error' });
    await waitFor(() => fake.of('chat.postMessage').some((p) => p.text === 'after the error'));

    await a.del(`/api/messages/${m.id}`);
    await waitFor(() => fake.of('chat.delete').find((p) => p.ts === ref.slack_ts));

    // a message that never reached Slack has nothing to update / delete / react to
    const local = services.postMessage({ channelId: general.id, userId: alice.me.id, text: 'local' });
    const before = fake.calls.length;
    await a.patch(`/api/messages/${local.id}`, { text: 'local edit' });
    await a.post(`/api/messages/${local.id}/reactions`, { emoji: 'x' });
    await a.del(`/api/messages/${local.id}/reactions/x`);
    await a.del(`/api/messages/${local.id}`);
    assert.equal(fake.calls.length, before);
  });

  test('nothing is sent while disconnected; unlink stops mirroring', async () => {
    const o = api(app, owner.token);
    const n = fake.of('chat.postMessage').length;
    bridge.stopSlackBridge();
    assert.equal((await o.get('/api/slack/channels')).body.error, 'slack_error');
    assert.equal((await o.post('/api/slack/links', { relayChannelId: linked.id, slackChannelId: SLACK_CH })).body.error, 'slack_error');
    await api(app, alice.token).post(`/api/channels/${linked.id}/messages`, { text: 'offline' });
    await bridge._internals.handleEvent(slackMessage({ user: 'UALICE', text: 'ignored while stopped' }));
    bridge._internals.setApi(fake, { botUserId: 'UBOT', botId: 'BBOT' });
    await o.del(`/api/slack/links/${linked.id}`);
    await api(app, alice.token).post(`/api/channels/${linked.id}/messages`, { text: 'unlinked' });
    await bridge._internals.handleEvent(slackMessage({ user: 'UALICE', text: 'unlinked inbound' }));
    assert.equal(fake.of('chat.postMessage').length, n);
    assert.equal((await o.get(`/api/channels/${linked.id}`)).body.channel.bridge, null);
  });
});

describe('Socket Mode connection', () => {
  test('tokens route connects, acknowledges envelopes, dispatches events and reconnects', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    const wsUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    const acks: string[] = [];
    let conns = 0;
    let current: WsSocket | null = null;
    wss.on('connection', (sock) => {
      conns++;
      current = sock;
      sock.on('message', (d) => acks.push(JSON.parse(String(d)).envelope_id));
      sock.send('not json');
      sock.send(JSON.stringify({ type: 'hello' }));
    });
    const realFetch = globalThis.fetch;
    let authOk = true;
    const slackCalls: string[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (!url.startsWith('https://slack.com/api/')) return realFetch(input, init);
      const method = url.slice('https://slack.com/api/'.length);
      slackCalls.push(method);
      if (method === 'auth.test') return Response.json(authOk ? { ok: true, user_id: 'UBOT', bot_id: 'BBOT', team: 'Acme Slack', url: 'https://acme.slack.com/' } : { ok: false, error: 'invalid_auth' });
      if (method === 'apps.connections.open') return Response.json(authOk ? { ok: true, url: wsUrl } : { ok: false, error: 'not_allowed' });
      if (method === 'users.info') return Response.json({ ok: true, user: fake.users.UALICE });
      return Response.json({ ok: true, ts: '1.1' });
    }) as typeof fetch;
    try {
      const o = api(app, owner.token);
      await o.post('/api/slack/links', { relayChannelId: linked.id, slackChannelId: SLACK_CH }).catch(() => {});
      bridge.stopSlackBridge();
      assert.equal((await o.put('/api/slack/tokens', { botToken: 'nope', appToken: 'xapp-1' })).status, 400);
      const st = await silence(() => o.put('/api/slack/tokens', { botToken: 'xoxb-test', appToken: 'xapp-test' }));
      assert.equal(st.status, 200);
      assert.equal(st.body.connected, true);
      assert.equal(st.body.team, 'Acme Slack');
      const status = (await o.get('/api/slack')).body;
      assert.equal(status.botTokenSet, true);
      assert.equal(status.appTokenSet, true);
      assert.ok(bridge.slackApi());

      // an events_api envelope is acknowledged and handled
      const ts = nextTs();
      current!.send(JSON.stringify({ type: 'events_api', envelope_id: 'env-1', payload: { event: { type: 'message', channel: SLACK_CH, user: 'UALICE', text: 'via socket', ts } } }));
      await waitFor(() => acks.includes('env-1'));
      await waitFor(() => relayMsgForTs(ts));
      assert.equal(msgRow(relayMsgForTs(ts)!).text, 'via socket');
      // a handler error is caught
      await silence(async () => {
        current!.send(JSON.stringify({ type: 'events_api', envelope_id: 'env-2', payload: { event: { type: 'reaction_added', user: 'UALICE', item: null } } }));
        await waitFor(() => acks.includes('env-2'));
      });

      // Slack asks us to reconnect
      await silence(async () => {
        current!.send(JSON.stringify({ type: 'disconnect' }));
        await waitFor(() => !bridge.slackStatus().connected, 3000);
        await waitFor(() => conns === 2 && bridge.slackStatus().connected, 5000);
      });

      // removing the tokens disconnects
      const off = await o.del('/api/slack/tokens');
      assert.equal(off.body.enabled, false);
      assert.equal(off.body.connected, false);
      assert.equal(bridge.slackApi(), null);

      // a failing start reports the error and retries in the background
      authOk = false;
      await silence(async () => {
        db.setSetting('slack.botToken', 'xoxb-bad');
        db.setSetting('slack.appToken', 'xapp-bad');
        await bridge.startSlackBridge();
      });
      assert.equal(bridge.slackStatus().error, 'Slack auth.test: invalid_auth');
      assert.equal(bridge.slackStatus().enabled, true);
      // the background retry fails as well and keeps the error up to date
      await silence(() => waitFor(() => bridge.slackStatus().error === 'Slack apps.connections.open: not_allowed', 5000));
      bridge.stopSlackBridge();
      db.setSetting('slack.botToken', null);
      db.setSetting('slack.appToken', null);
      assert.equal(bridge.slackTokens().bot, '');
    } finally {
      globalThis.fetch = realFetch;
      bridge.stopSlackBridge();
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss.close(r));
      bridge._internals.setApi(fake, { botUserId: 'UBOT', botId: 'BBOT' });
    }
  });
});

describe('SlackApi client', () => {
  test('call: form encoding, auth header, errors and 429 back-off', async () => {
    const realFetch = globalThis.fetch;
    const seen: { url: string; init: any }[] = [];
    let mode: 'ok' | 'error' | '429' = 'ok';
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push({ url: String(url), init });
      if (mode === '429' && seen.length === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
      if (mode === 'error') return Response.json({ ok: false }, { status: 500 });
      if (String(url).startsWith('https://files.slack.com/fail')) return new Response('', { status: 500 });
      if (String(url).startsWith('https://files.slack.com/')) return new Response('bytes', { status: 200 });
      if (String(url).endsWith('files.getUploadURLExternal')) return Response.json({ ok: true, upload_url: init.body.get('filename') === 'bad' ? 'https://files.slack.com/fail' : 'https://files.slack.com/up', file_id: 'F1' });
      return Response.json({ ok: true, echo: Object.fromEntries(init.body) });
    }) as typeof fetch;
    try {
      const c = new SlackApi('xoxb-abc');
      const r = await c.call('chat.postMessage', { channel: 'C1', text: 'hi', blocks: [{ a: 1 }], skip: undefined, nil: null, n: 5 });
      assert.deepEqual(r.echo, { channel: 'C1', text: 'hi', blocks: '[{"a":1}]', n: '5' });
      assert.equal(seen[0].url, 'https://slack.com/api/chat.postMessage');
      assert.equal(seen[0].init.headers.authorization, 'Bearer xoxb-abc');
      await c.call('auth.test');

      mode = 'error';
      await assert.rejects(c.call('auth.test'), (e: any) => e instanceof SlackError && e.code === 'http_500' && e.message === 'Slack auth.test: http_500');

      mode = '429';
      seen.length = 0;
      const retried = await c.call('chat.postMessage', { channel: 'C1' });
      assert.equal(retried.ok, true);
      assert.equal(seen.length, 2);

      mode = 'ok';
      const dl = await c.download('https://files.slack.com/x');
      assert.equal(await dl.text(), 'bytes');
      await assert.rejects(c.download('https://files.slack.com/fail'), /download failed: 500/);

      const up = await c.uploadFile({ channel: 'C1', threadTs: '1.2', filename: 'a.txt', data: Buffer.from('abc') });
      assert.equal(up.echo.channel_id, 'C1');
      assert.equal(up.echo.thread_ts, '1.2');
      assert.deepEqual(JSON.parse(up.echo.files), [{ id: 'F1', title: 'a.txt' }]);
      await assert.rejects(c.uploadFile({ channel: 'C1', filename: 'bad', data: Buffer.from('x') }), /upload failed: 500/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
