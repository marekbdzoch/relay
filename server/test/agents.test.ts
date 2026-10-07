import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { addUser, api, closeApp, createApp, png, setupOwner, waitFor, type Session } from './helpers.ts';

// ---------- fake Anthropic API ----------

interface Captured {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}
type Reply = { status?: number; headers?: Record<string, string>; json: any };
type Responder = (req: Captured) => Reply | Promise<Reply>;

const requests: Captured[] = [];
let responder: Responder;
const textReply = (text: string, stop_reason = 'end_turn'): Reply => ({ json: message([{ type: 'text', text }], stop_reason) });
const defaultResponder: Responder = () => textReply('Hello from the agent');

function message(content: any[], stop_reason: string) {
  return { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
}

const fake = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', async () => {
    const cap: Captured = { path: req.url ?? '', headers: req.headers, body: data ? JSON.parse(data) : null };
    requests.push(cap);
    const r = await responder(cap);
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json', 'request-id': 'req_test', ...r.headers });
    res.end(JSON.stringify(r.json));
  });
});

let app: FastifyInstance;
let owner: Session;
let alice: Session;
let bob: Session;
let guest: Session;
let db: typeof import('../src/db.ts');
let services: typeof import('../src/services.ts');

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as AddressInfo).port;
  ({ app } = await createApp({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'sk-ant-test-key' }));
  db = await import('../src/db.ts');
  services = await import('../src/services.ts');
  const { initAgents } = await import('../src/agents/runtime.ts');
  initAgents();
  initAgents(); // idempotent
  owner = await setupOwner(app);
  alice = await addUser(app, owner.token, { name: 'Alice', email: 'alice@example.com' });
  bob = await addUser(app, owner.token, { name: 'Bob', email: 'bob@example.com' });
  guest = await addUser(app, owner.token, { name: 'Guest', email: 'guest@example.com', role: 'guest' });
});
after(async () => {
  await closeApp(app);
  await new Promise((r) => fake.close(r));
});
beforeEach(() => {
  responder = defaultResponder;
});

const createAgent = async (s: Session, body: Record<string, unknown>) => {
  const r = await api(app, s.token).post('/api/agents', { name: 'Agent', role: 'Helper', instructions: 'Be helpful.', ...body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { agent: any; user: any };
};
const send = (s: Session, channelId: string, text: string, extra: Record<string, unknown> = {}) => api(app, s.token).post(`/api/channels/${channelId}/messages`, { text, ...extra });
const dmWith = async (s: Session, userId: string) => (await api(app, s.token).post('/api/dms', { userIds: [userId] })).body.channel;
const messagesBy = (channelId: string, userId: string) =>
  db.all<any>('SELECT * FROM messages WHERE channel_id = ? AND user_id = ? AND deleted_at IS NULL AND subtype IS NULL ORDER BY id', channelId, userId);
const waitForReply = (channelId: string, userId: string, n = 1) => waitFor(() => (messagesBy(channelId, userId).length >= n ? messagesBy(channelId, userId) : null));
/** waits until no agent run is in flight (the request count is stable and every DM got its answer) */
const quiet = async () => {
  let last = -1;
  await waitFor(async () => {
    const n = requests.length;
    const stable = n === last;
    last = n;
    await new Promise((r) => setTimeout(r, 30));
    return stable;
  });
};
const silenceErrors = async <T>(fn: () => Promise<T>) => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
};

describe('agent management', () => {
  test('create with channels, permissions and defaults', async () => {
    assert.equal((await api(app, guest.token).post('/api/agents', { name: 'G', role: 'r', instructions: '' })).status, 403);
    assert.equal((await api(app, alice.token).post('/api/agents', { name: '', role: 'r', instructions: '' })).status, 400);
    const pub = (await api(app, alice.token).post('/api/channels', { name: 'agents-pub' })).body;
    const privMine = (await api(app, alice.token).post('/api/channels', { name: 'agents-priv', isPrivate: true })).body;
    const privOther = (await api(app, bob.token).post('/api/channels', { name: 'agents-bob', isPrivate: true })).body;
    const dm = await dmWith(alice, bob.me.id);
    const r = await createAgent(alice, {
      name: 'Research Bot',
      role: 'Researcher',
      department: 'R&D',
      model: 'not-a-model',
      webSearch: false,
      avatarEmoji: '🤖',
      avatarColor: '#123456',
      replyMode: 'all',
      channelIds: [pub.id, privMine.id, privOther.id, dm.id, 'NOPE'],
    });
    assert.equal(r.agent.model, 'claude-opus-5-5');
    assert.equal(r.agent.webSearch, false);
    assert.equal(r.agent.replyMode, 'all');
    assert.equal(r.agent.department, 'R&D');
    assert.equal(r.agent.createdBy, alice.me.id);
    assert.equal(r.user.isBot, true);
    assert.equal(r.user.external, 'agent');
    assert.equal(r.user.username, 'research.bot');
    assert.equal(r.user.avatarColor, '#123456');
    assert.equal(r.user.title, 'Researcher');
    const memberOf = db.all<{ channel_id: string }>('SELECT channel_id FROM channel_members WHERE user_id = ?', r.user.id).map((x) => x.channel_id);
    assert.deepEqual(memberOf.sort(), [pub.id, privMine.id].sort());
    // agents can't log in
    const email = db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', r.user.id)!.email;
    assert.equal((await api(app).post('/api/auth/login', { email, password: '!' })).status, 401);
    // second agent with the same name gets a unique username
    const r2 = await createAgent(bob, { name: 'Research Bot' });
    assert.equal(r2.user.username, 'research.bot2');
    assert.equal(r2.agent.replyMode, 'mentions');
    assert.equal(r2.agent.webSearch, true);

    const list = await api(app, bob.token).get('/api/agents');
    assert.ok(list.body.some((a: any) => a.userId === r.user.id));
    assert.ok((await api(app, bob.token).get('/api/bootstrap')).body.agents.length >= 2);
    const one = await api(app, bob.token).get(`/api/agents/${r.user.id}`);
    assert.equal(one.body.user.fullName, 'Research Bot');
    assert.equal((await api(app, bob.token).get('/api/agents/NOPE')).status, 404);
  });

  test('patch, delete and restore: creator or admin only', async () => {
    const { user } = await createAgent(alice, { name: 'Editable' });
    const id = user.id;
    assert.equal((await api(app, bob.token).patch(`/api/agents/${id}`, { role: 'x' })).status, 403);
    assert.equal((await api(app, bob.token).patch('/api/agents/NOPE', { role: 'x' })).status, 404);
    const p = await api(app, alice.token).patch(`/api/agents/${id}`, {
      name: 'Edited',
      role: 'Writer',
      department: 'Marketing',
      instructions: 'Write well',
      model: 'claude-haiku-4-5',
      webSearch: false,
      avatarEmoji: '✍️',
      avatarColor: '#abcdef',
      replyMode: 'all',
    });
    assert.equal(p.status, 200);
    assert.equal(p.body.agent.model, 'claude-haiku-4-5');
    assert.equal(p.body.agent.instructions, 'Write well');
    assert.equal(p.body.user.fullName, 'Edited');
    assert.equal(p.body.user.title, 'Writer');
    assert.equal(p.body.user.avatarColor, '#abcdef');
    const p2 = await api(app, owner.token).patch(`/api/agents/${id}`, { model: 'gpt-4' });
    assert.equal(p2.body.agent.model, 'claude-opus-5-5');

    const ch = (await api(app, alice.token).post('/api/channels', { name: 'agent-del', memberIds: [id] })).body;
    assert.ok(ch.memberIds.includes(id));
    assert.equal((await api(app, bob.token).del(`/api/agents/${id}`)).status, 403);
    assert.equal((await api(app, alice.token).del(`/api/agents/${id}`)).status, 200);
    assert.equal((await api(app, alice.token).get(`/api/agents/${id}`)).body.user.deactivated, true);
    assert.equal(db.get('SELECT 1 FROM channel_members WHERE user_id = ?', id), undefined);
    assert.equal((await api(app, alice.token).del('/api/agents/NOPE')).status, 404);

    assert.equal((await api(app, bob.token).post(`/api/agents/${id}/restore`)).status, 403);
    assert.equal((await api(app, bob.token).post('/api/agents/NOPE/restore')).status, 404);
    const restored = await api(app, owner.token).post(`/api/agents/${id}/restore`);
    assert.equal(restored.body.user.deactivated, false);
  });

  test('settings: admin only, key validation', async () => {
    const s = await api(app, bob.token).get('/api/agents/settings');
    assert.equal(s.body.configured, true);
    assert.equal(s.body.fromEnv, true);
    assert.deepEqual(s.body.models.map((m: any) => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']);
    assert.equal((await api(app, bob.token).put('/api/agents/settings', { apiKey: 'sk-ant-x' })).status, 403);
    const bad = await api(app, owner.token).put('/api/agents/settings', { apiKey: 'sk-openai-123' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_key');
    assert.equal((await api(app, owner.token).put('/api/agents/settings', { apiKey: 'sk-ant-stored' })).status, 200);
    assert.equal(db.getSetting('anthropic.apiKey'), 'sk-ant-stored');
    const { storedKeyPresent } = await import('../src/agents/runtime.ts');
    assert.equal(storedKeyPresent(), true);
    await api(app, owner.token).put('/api/agents/settings', { apiKey: null });
    assert.equal(db.getSetting('anthropic.apiKey'), null);
    assert.equal(storedKeyPresent(), false);
  });
});

describe('agent runtime', () => {
  test('DM: request shape and reply', async () => {
    const { user: agent } = await createAgent(alice, { name: 'Opus Helper', role: 'Assistant', department: 'Ops', instructions: 'Answer briefly.' });
    const dm = await dmWith(alice, agent.id);
    requests.length = 0;
    const m = (await send(alice, dm.id, `Hi <@${agent.id}>, what's up in <#CNOPE>? <!here> <https://x.dev|docs> <https://y.dev>`)).body;
    const [reply] = await waitForReply(dm.id, agent.id);
    assert.equal(reply.text, 'Hello from the agent');
    assert.equal(reply.thread_root_id, null);
    assert.equal(JSON.parse(reply.meta).agentDepth, 1);

    const req = requests[0];
    assert.match(req.path, /^\/v1\/messages/);
    assert.equal(req.headers['x-api-key'], 'sk-ant-test-key');
    assert.match(String(req.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.equal(req.body.model, 'claude-opus-5-5');
    assert.equal(req.body.fallbacks, 'default');
    assert.deepEqual(req.body.output_config, { effort: 'medium' });
    assert.equal(req.body.max_tokens, 16000);
    assert.deepEqual(
      req.body.tools.map((t: any) => t.name),
      ['send_message', 'read_channel', 'search_messages', 'list_channels', 'add_reaction', 'web_search'],
    );
    assert.equal(req.body.tools.at(-1).type, 'web_search_20260209');
    assert.match(req.body.system[0].text, /You are Opus Helper \(@opus.helper\)/);
    assert.match(req.body.system[0].text, /Team \/ department: Ops/);
    assert.match(req.body.system[0].text, /Answer briefly\./);
    assert.deepEqual(req.body.system[0].cache_control, { type: 'ephemeral' });
    const ctx = req.body.messages[0].content.at(-1).text;
    assert.match(ctx, /You are in: direct message with Alice \(@alice\)/);
    assert.match(ctx, /New message you are responding to:\n\[.*UTC\] Alice \(@\w+\): Hi @opus\.helper, what's up in #channel\? @here \[docs\]\(https:\/\/x\.dev\) https:\/\/y\.dev/);
    assert.match(ctx, /People in the workspace:[\s\S]*- Opus Helper @opus\.helper – AI agent, Ops: Assistant/);
    assert.match(ctx, /\(no earlier messages\)/);
    assert.ok(m.id);

    // typing indicator user is the agent; a follow-up includes the history
    await send(alice, dm.id, 'second');
    await waitForReply(dm.id, agent.id, 2);
    const ctx2 = requests[1].body.messages[0].content.at(-1).text;
    assert.match(ctx2, /Conversation so far:\n.*Alice.*Hi @opus\.helper[\s\S]*Opus Helper \(@opus\.helper, AI agent – Assistant\): Hello from the agent/);
  });

  test('tool loop: send_message to a person, then a final answer', async () => {
    const { user: agent } = await createAgent(alice, { name: 'Delegator' });
    const dm = await dmWith(alice, agent.id);
    const general = (await api(app, alice.token).get('/api/bootstrap')).body.channels.find((c: any) => c.name === 'general');
    await api(app, alice.token).post(`/api/channels/${general.id}/members`, { userIds: [agent.id] });
    const seed = (await send(alice, general.id, 'The quarterly numbers are great')).body;
    requests.length = 0;
    let round = 0;
    responder = (req) => {
      round++;
      if (round === 1) {
        return {
          json: message(
            [
              { type: 'text', text: 'Let me check.' },
              { type: 'tool_use', id: 'tu_1', name: 'send_message', input: { to: `@${bob.me.username}`, text: `Hi @${bob.me.username}. could you look at #general? \`@${bob.me.username}\`` } },
              { type: 'tool_use', id: 'tu_2', name: 'send_message', input: { to: '#general', text: 'Heads-up for @here and @nobody' } },
              { type: 'tool_use', id: 'tu_3', name: 'send_message', input: { to: '#random', text: 'not a member' } },
              { type: 'tool_use', id: 'tu_4', name: 'send_message', input: { to: '#does-not-exist', text: 'x' } },
              { type: 'tool_use', id: 'tu_5', name: 'send_message', input: { to: '@ghost', text: 'x' } },
              { type: 'tool_use', id: 'tu_6', name: 'send_message', input: { to: `@${agent.username}`, text: 'x' } },
              { type: 'tool_use', id: 'tu_7', name: 'send_message', input: { to: `@${alice.me.username}`, text: 'current conversation' } },
              { type: 'tool_use', id: 'tu_8', name: 'send_message', input: { to: '@x' } },
            ],
            'tool_use',
          ),
        };
      }
      if (round === 2) {
        const results = req.body.messages.at(-1).content;
        assert.equal(req.body.messages.at(-2).role, 'assistant');
        assert.deepEqual(
          results.map((r: any) => [r.tool_use_id, r.content, r.is_error ?? false]),
          [
            ['tu_1', `Sent to @${bob.me.username}.`, false],
            ['tu_2', 'Sent to #general.', false],
            ['tu_3', 'Error: You are not a member of #random. Ask someone to add you.', true],
            ['tu_4', 'Error: Channel #does-not-exist does not exist.', true],
            ['tu_5', 'Error: Nobody with username @ghost.', true],
            ['tu_6', 'Error: That is you.', true],
            ['tu_7', 'Error: that is the current conversation – just write your reply as your final answer.', true],
            ['tu_8', 'Error: "to" and "text" are required.', true],
          ],
        );
        return {
          json: message(
            [
              { type: 'tool_use', id: 'tu_9', name: 'read_channel', input: { channel: '#general', limit: 5 } },
              { type: 'tool_use', id: 'tu_10', name: 'read_channel', input: { channel: `@${bob.me.username}` } },
              { type: 'tool_use', id: 'tu_11', name: 'read_channel', input: { channel: `@${owner.me.username}` } },
              { type: 'tool_use', id: 'tu_12', name: 'read_channel', input: {} },
              { type: 'tool_use', id: 'tu_13', name: 'read_channel', input: { channel: '#nope' } },
              { type: 'tool_use', id: 'tu_14', name: 'search_messages', input: { query: 'quarterly' } },
              { type: 'tool_use', id: 'tu_15', name: 'search_messages', input: { query: '  ' } },
              { type: 'tool_use', id: 'tu_16', name: 'search_messages', input: { query: 'zzzzunknown' } },
              { type: 'tool_use', id: 'tu_17', name: 'list_channels', input: {} },
              { type: 'tool_use', id: 'tu_18', name: 'add_reaction', input: { emoji: ':eyes:' } },
              { type: 'tool_use', id: 'tu_19', name: 'add_reaction', input: {} },
              { type: 'tool_use', id: 'tu_20', name: 'teleport', input: {} },
            ],
            'tool_use',
          ),
        };
      }
      const results = req.body.messages.at(-1).content.map((r: any) => r.content);
      assert.match(results[0], /Alice \(@\w+\): The quarterly numbers are great/);
      assert.match(results[0], /\(join event\)|Heads-up/);
      assert.match(results[1], /Hi @/);
      assert.equal(results[2], 'No messages yet.');
      assert.equal(results[3], 'Error: "channel" is required.');
      assert.equal(results[4], 'Error: Channel #nope does not exist.');
      assert.match(results[5], /^#general \[.*\] Alice .*quarterly numbers/);
      assert.equal(results[6], 'Error: empty query.');
      assert.equal(results[7], 'No results.');
      assert.match(results[8], /#general \(member\) – This is the one channel/);
      assert.match(results[8], /#random – Non-work banter/);
      assert.equal(results[9], 'Reaction added.');
      assert.equal(results[10], 'Error: no emoji.');
      assert.equal(results[11], 'Error: unknown tool teleport');
      return textReply('Done – I asked Bob.');
    };
    const trigger = (await send(alice, dm.id, 'Please ask Bob to review')).body;
    const replies = await waitForReply(dm.id, agent.id);
    assert.equal(replies[0].text, 'Done – I asked Bob.');
    assert.equal(requests.length, 3);

    const bobDm = db.get<{ id: string }>('SELECT id FROM channels WHERE dm_key = ?', [agent.id, bob.me.id].sort().join(','))!;
    const toBob = messagesBy(bobDm.id, agent.id);
    assert.equal(toBob.length, 1);
    assert.equal(toBob[0].text, `Hi <@${bob.me.id}>. could you look at <#${general.id}>? \`@${bob.me.username}\``);
    assert.equal(JSON.parse(toBob[0].meta).agentDepth, 1);
    const inGeneral = messagesBy(general.id, agent.id).filter((m) => !m.subtype);
    assert.equal(inGeneral.at(-1).text, 'Heads-up for @here and @nobody');
    // reaction on the trigger
    const reacted = (await api(app, alice.token).get(`/api/messages/${trigger.id}`)).body;
    assert.deepEqual(reacted.reactions, [{ emoji: 'eyes', userIds: [agent.id] }]);
    // bob got a DM activity entry
    const act = (await api(app, bob.token).get('/api/activity?filter=dms')).body;
    assert.ok(act.some((a: any) => a.channelId === bobDm.id));
    assert.ok(seed.id);
  });

  test('channels: mention triggers, no mention stays quiet; threads and reply mode "all"', async () => {
    const { user: agent } = await createAgent(alice, { name: 'Channel Bot' });
    const ch = (await api(app, alice.token).post('/api/channels', { name: 'agent-chan', topic: 'x', description: 'Agent playground', memberIds: [agent.id, bob.me.id] })).body;
    requests.length = 0;
    await send(alice, ch.id, 'no mention here');
    const m = (await send(alice, ch.id, `<@${agent.id}> please help`)).body;
    const [reply] = await waitForReply(ch.id, agent.id, 1).then((rows) => rows.filter((r: any) => !r.subtype));
    assert.equal(reply.thread_root_id, null);
    await quiet();
    assert.equal(requests.length, 1);
    assert.match(requests[0].body.messages[0].content.at(-1).text, /You are in: channel #agent-chan – Agent playground/);
    assert.ok(m.id);

    // a thread the agent takes part in: follow-ups need no mention ...
    const root = (await send(alice, ch.id, `<@${agent.id}> thread start`)).body;
    await waitFor(() => messagesBy(ch.id, agent.id).filter((r) => !r.subtype).length >= 2);
    const before = requests.length;
    await send(bob, ch.id, 'and a follow-up', { threadRootId: root.id });
    // root mentions the agent -> it isn't the root author; it only answers once it replied in the thread
    await quiet();
    assert.equal(requests.length, before);
    await send(bob, ch.id, `<@${agent.id}> now in thread`, { threadRootId: root.id });
    await waitFor(() => db.get('SELECT 1 FROM messages WHERE thread_root_id = ? AND user_id = ?', root.id, agent.id));
    const n = requests.length;
    await send(bob, ch.id, 'follow-up without mention', { threadRootId: root.id });
    await waitFor(() => requests.length > n);
    assert.match(requests.at(-1)!.body.messages[0].content.at(-1).text, /inside a thread[\s\S]*thread start/);
    await quiet();
    // ... unless somebody else is addressed
    const n2 = requests.length;
    await send(bob, ch.id, `<@${alice.me.id}> what do you think?`, { threadRootId: root.id });
    await quiet();
    assert.equal(requests.length, n2);

    // reply mode "all": answers top-level messages without mentions, but not ones addressed to others
    await api(app, alice.token).patch(`/api/agents/${agent.id}`, { replyMode: 'all' });
    const n3 = requests.length;
    await send(bob, ch.id, 'anyone?');
    await waitFor(() => requests.length > n3);
    await quiet();
    const n4 = requests.length;
    await send(bob, ch.id, `<@${alice.me.id}> only you`);
    await quiet();
    assert.equal(requests.length, n4);
    // archived channels never trigger
    await api(app, alice.token).post(`/api/channels/${ch.id}/archive`);
    services.postMessage({ channelId: ch.id, userId: bob.me.id, text: 'in the archive' });
    await quiet();
    assert.equal(requests.length, n4);
  });

  test('group DMs follow the reply mode', async () => {
    const { user: agent } = await createAgent(alice, { name: 'Group Bot' });
    const g = (await api(app, alice.token).post('/api/dms', { userIds: [agent.id, bob.me.id] })).body.channel;
    assert.equal(g.kind, 'group');
    requests.length = 0;
    await send(alice, g.id, 'hello group');
    await quiet();
    assert.equal(requests.length, 0);
    await api(app, alice.token).patch(`/api/agents/${agent.id}`, { replyMode: 'all' });
    await send(alice, g.id, 'hello again');
    await waitForReply(g.id, agent.id);
    assert.match(requests[0].body.messages[0].content.at(-1).text, /group direct message with/);
  });

  test('agents only answer other agents when mentioned, and hops are limited', async () => {
    const { user: a1 } = await createAgent(alice, { name: 'Agent One', replyMode: 'all' });
    const { user: a2 } = await createAgent(alice, { name: 'Agent Two', replyMode: 'all' });
    const ch = (await api(app, alice.token).post('/api/channels', { name: 'agent-hops', memberIds: [a1.id, a2.id] })).body;
    requests.length = 0;
    services.postMessage({ channelId: ch.id, userId: a1.id, text: 'chatter without mention', source: 'agent', agentDepth: 1 });
    await quiet();
    assert.equal(requests.length, 0);
    services.postMessage({ channelId: ch.id, userId: a1.id, text: `<@${a2.id}> over to you`, source: 'agent', agentDepth: 1 });
    const [reply] = await waitForReply(ch.id, a2.id).then((r) => r.filter((x: any) => !x.subtype));
    assert.equal(JSON.parse(reply.meta).agentDepth, 2);

    // in a DM between two agents the chain stops at depth 4
    const dm = (await api(app, owner.token).post('/api/dms', { userIds: [] })).body.channel; // unrelated, just to have a DM row
    assert.ok(dm.id);
    const key = [a1.id, a2.id].sort().join(',');
    const id = 'DTESTHOPS1';
    db.run("INSERT INTO channels (id, kind, created_by, created_at, dm_key) VALUES (?, 'dm', ?, ?, ?)", id, a1.id, Date.now(), key);
    services.addMembers(id, [a1.id, a2.id], a1.id, false);
    requests.length = 0;
    services.postMessage({ channelId: id, userId: a1.id, text: 'depth four', source: 'agent', agentDepth: 4 });
    await quiet();
    assert.equal(requests.length, 0);
    services.postMessage({ channelId: id, userId: a1.id, text: 'depth two', source: 'agent', agentDepth: 2 });
    // a2 answers (3), a1 answers (4), then it stops
    await waitFor(() => messagesBy(id, a1.id).length >= 3);
    await quiet();
    const depths = db.all<{ meta: string }>('SELECT meta FROM messages WHERE channel_id = ? ORDER BY id', id).map((m) => JSON.parse(m.meta).agentDepth);
    assert.deepEqual(depths, [4, 2, 3, 4]);
  });

  test('busy agents coalesce messages and answer the latest', async () => {
    const { user: agent } = await createAgent(alice, { name: 'Busy Bot' });
    const dm = await dmWith(alice, agent.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    requests.length = 0;
    responder = async (req) => {
      if (requests.length === 1) await gate;
      return textReply(`answer to: ${req.body.messages[0].content.at(-1).text.split('\n').at(-1)}`);
    };
    await send(alice, dm.id, 'first');
    await waitFor(() => requests.length === 1);
    await send(alice, dm.id, 'second');
    await send(alice, dm.id, 'third');
    release();
    await waitForReply(dm.id, agent.id, 2);
    await quiet();
    assert.equal(requests.length, 2);
    assert.deepEqual(
      messagesBy(dm.id, agent.id).map((m) => m.text.replace(/^answer to: \[.*?\] /, '')),
      [`Alice (<@${alice.me.id}>): first`, `Alice (<@${alice.me.id}>): third`],
    );
  });

  test('stop reasons: refusal and pause_turn; thread replies go into the thread', async () => {
    const { user: agent } = await createAgent(alice, { name: 'Stopper' });
    const dm = await dmWith(alice, agent.id);
    responder = () => textReply('', 'refusal');
    await send(alice, dm.id, 'do something bad');
    assert.equal((await waitForReply(dm.id, agent.id))[0].text, 'Sorry, I can’t help with that.');

    let n = 0;
    responder = () => (++n === 1 ? { json: message([{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } }], 'pause_turn') } : textReply('after pause'));
    const root = (await send(alice, dm.id, 'search the web')).body;
    await waitForReply(dm.id, agent.id, 2);
    const before = requests.length;
    await send(alice, dm.id, 'in thread', { threadRootId: root.id });
    await waitFor(() => db.get('SELECT 1 FROM messages WHERE thread_root_id = ? AND user_id = ?', root.id, agent.id));
    assert.ok(requests.length > before);
    // an empty final answer posts nothing
    responder = () => textReply('');
    const count = messagesBy(dm.id, agent.id).length;
    await send(alice, dm.id, 'say nothing');
    await quiet();
    assert.equal(messagesBy(dm.id, agent.id).length, count);
  });

  test('images from the trigger message are sent along', async () => {
    const { user: agent } = await createAgent(alice, { name: 'Vision' });
    const dm = await dmWith(alice, agent.id);
    const up = await api(app, alice.token).upload('/api/files', [
      { filename: 'a.png', content: png(2, 2), contentType: 'image/png' },
      { filename: 'b.txt', content: 'text', contentType: 'text/plain' },
    ]);
    requests.length = 0;
    await send(alice, dm.id, 'what is this?', { fileIds: up.body.map((f: any) => f.id) });
    await waitForReply(dm.id, agent.id);
    const content = requests[0].body.messages[0].content;
    assert.equal(content[0].type, 'image');
    assert.equal(content[0].source.media_type, 'image/png');
    assert.equal(Buffer.from(content[0].source.data, 'base64').equals(png(2, 2)), true);
    assert.equal(content[1].type, 'text');
    assert.match(content[1].text, /\[files: a\.png, b\.txt\]/);
  });

  test('haiku: older web search tool, no fallbacks/effort; web search can be disabled', async () => {
    const { user: haiku } = await createAgent(alice, { name: 'Haiku', model: 'claude-haiku-4-5' });
    const dm = await dmWith(alice, haiku.id);
    requests.length = 0;
    await send(alice, dm.id, 'quick one');
    await waitForReply(dm.id, haiku.id);
    const req = requests[0];
    assert.equal(req.body.model, 'claude-haiku-4-5');
    assert.equal(req.body.fallbacks, undefined);
    assert.equal(req.body.output_config, undefined);
    assert.doesNotMatch(String(req.headers['anthropic-beta'] ?? ''), /server-side-fallback/);
    assert.deepEqual(req.body.tools.at(-1), { type: 'web_search_20250305', name: 'web_search', max_uses: 5 });

    const { user: noWeb } = await createAgent(alice, { name: 'Offline', webSearch: false, model: 'claude-sonnet-5-5' });
    const dm2 = await dmWith(alice, noWeb.id);
    requests.length = 0;
    await send(alice, dm2.id, 'hi');
    await waitForReply(dm2.id, noWeb.id);
    assert.equal(requests[0].body.model, 'claude-sonnet-5-5');
    assert.ok(!requests[0].body.tools.some((t: any) => t.name === 'web_search'));
  });

  test('API errors become an apology message', async () => {
    const { user: agent } = await createAgent(alice, { name: 'Unlucky' });
    const dm = await dmWith(alice, agent.id);
    const err = (status: number, type: string): Reply => ({ status, headers: { 'retry-after-ms': '1', 'x-should-retry': 'false' }, json: { type: 'error', error: { type, message: `${type} happened` } } });
    const cases: [Reply, RegExp][] = [
      [err(401, 'authentication_error'), /the Anthropic API key is invalid/],
      [err(403, 'permission_error'), /the API key has no access to this model/],
      [err(429, 'rate_limit_error'), /rate limited/],
      [err(400, 'invalid_request_error'), /the request was rejected \(400 .*invalid_request_error happened/],
      [err(500, 'api_error'), /the AI service returned an error \(500\)/],
    ];
    let i = 0;
    for (const [reply, re] of cases) {
      responder = () => reply;
      await silenceErrors(async () => {
        await send(alice, dm.id, `try ${i}`);
        const rows = await waitForReply(dm.id, agent.id, ++i);
        assert.match(rows.at(-1).text, /^⚠️ Sorry, I couldn’t answer: /);
        assert.match(rows.at(-1).text, re);
      });
    }
    // a non-API failure (e.g. a broken response) gives the generic reason
    responder = () => ({ json: { nonsense: true } });
    await silenceErrors(async () => {
      await send(alice, dm.id, 'broken');
      const rows = await waitForReply(dm.id, agent.id, ++i);
      assert.match(rows.at(-1).text, /something went wrong|couldn’t answer/);
    });
  });

  test('missing API key: the agent says it is not connected', async () => {
    const { user: agent } = await createAgent(alice, { name: 'Unplugged' });
    const dm = await dmWith(alice, agent.id);
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const s = await api(app, alice.token).get('/api/agents/settings');
      assert.equal(s.body.configured, false);
      assert.equal(s.body.fromEnv, false);
      requests.length = 0;
      await send(alice, dm.id, 'hello?');
      const [reply] = await waitForReply(dm.id, agent.id);
      assert.match(reply.text, /not connected to an AI model yet/);
      assert.equal(requests.length, 0);
      // a stored key works too (and a new client is created for it)
      db.setSetting('anthropic.apiKey', 'sk-ant-stored-key');
      await send(alice, dm.id, 'and now?');
      await waitForReply(dm.id, agent.id, 2);
      assert.equal(requests[0].headers['x-api-key'], 'sk-ant-stored-key');
    } finally {
      process.env.ANTHROPIC_API_KEY = saved;
      db.setSetting('anthropic.apiKey', null);
    }
  });

  test('a failing tool is reported to the model as an error', async () => {
    const { user: agent } = await createAgent(alice, { name: 'Fragile' });
    const dm = await dmWith(alice, agent.id);
    let round = 0;
    let toolResult: any;
    responder = (req) => {
      round++;
      if (round === 1) {
        // the trigger disappears for good while the agent works -> reacting to it fails
        const trigger = db.get<{ id: number }>('SELECT MAX(id) AS id FROM messages WHERE channel_id = ?', dm.id)!.id;
        db.run('DELETE FROM messages WHERE id = ?', trigger);
        return { json: message([{ type: 'tool_use', id: 'tu_x', name: 'add_reaction', input: { emoji: 'eyes' } }], 'tool_use') };
      }
      toolResult = req.body.messages.at(-1).content[0];
      return textReply('ok');
    };
    await send(alice, dm.id, 'react please');
    await waitForReply(dm.id, agent.id);
    assert.equal(toolResult.is_error, true);
    assert.match(toolResult.content, /^Error: .*FOREIGN KEY/);
  });

  test('images that vanished from disk are skipped', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { config } = await import('../src/config.ts');
    const { user: agent } = await createAgent(alice, { name: 'Vision Two' });
    const dm = await dmWith(alice, agent.id);
    const up = await api(app, alice.token).upload('/api/files', [{ filename: 'gone.png', content: png(2, 2), contentType: 'image/png' }]);
    const row = db.get<{ path: string }>('SELECT path FROM files WHERE id = ?', up.body[0].id)!;
    fs.rmSync(path.join(config.uploadsDir, row.path));
    requests.length = 0;
    await send(alice, dm.id, 'look', { fileIds: [up.body[0].id] });
    await waitForReply(dm.id, agent.id);
    assert.deepEqual(requests[0].body.messages[0].content.map((c: any) => c.type), ['text']);
  });

  test('deactivated agents and deleted messages never run', async () => {
    const { user: agent } = await createAgent(alice, { name: 'Sleeper' });
    const dm = await dmWith(alice, agent.id);
    const { isActiveAgent } = await import('../src/agents/runtime.ts');
    assert.equal(isActiveAgent(agent.id), true);
    await api(app, alice.token).del(`/api/agents/${agent.id}`);
    assert.equal(isActiveAgent(agent.id), false);
    assert.equal(isActiveAgent(alice.me.id), false);
    requests.length = 0;
    services.postMessage({ channelId: dm.id, userId: alice.me.id, text: 'wake up' });
    await quiet();
    assert.equal(requests.length, 0);
  });
});
