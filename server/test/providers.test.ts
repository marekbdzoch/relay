// AI providers: settings routes, the connection test and the OpenAI-compatible agent adapter.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { addUser, api, closeApp, createApp, png, setupOwner, waitFor, type Session } from './helpers.ts';

// ---------- fake API server (OpenAI-compatible under /v1, Anthropic models list under /v1/models with x-api-key) ----------

interface Captured {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}
type Reply = { status?: number; delay?: number; raw?: string; json?: any };
type Responder = (req: Captured) => Reply | Promise<Reply>;

const requests: Captured[] = [];
let responder: Responder;

const MODELS = {
  object: 'list',
  data: [
    { id: 'gpt-test-large', object: 'model', owned_by: 'test' },
    { id: 'gpt-test-mini', object: 'model', owned_by: 'test' },
    { id: 'text-embedding-test', object: 'model', owned_by: 'test' },
    { id: 'gpt-test-mini', object: 'model', owned_by: 'test' },
  ],
};
const ANTHROPIC_MODELS = {
  data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }],
  has_more: false,
  first_id: null,
  last_id: null,
};

function completion(message: Record<string, unknown>, finish_reason = 'stop'): Reply {
  return {
    json: {
      id: `chatcmpl_${requests.length}`,
      object: 'chat.completion',
      created: 1,
      model: 'x',
      choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason }],
    },
  };
}
const say = (text: string) => completion({ content: text });
const toolCalls = (...calls: [string, string, unknown][]) =>
  completion(
    {
      content: null,
      tool_calls: calls.map(([id, name, args]) => ({
        id,
        type: 'function',
        function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
      })),
    },
    'tool_calls',
  );

const defaultResponder: Responder = (req) => {
  if (req.path.endsWith('/models')) return { json: req.headers['x-api-key'] ? ANTHROPIC_MODELS : MODELS };
  return say('Hello from an open model');
};

const fake = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', async () => {
    const cap: Captured = { method: req.method ?? '', path: (req.url ?? '').split('?')[0], headers: req.headers, body: data ? JSON.parse(data) : null };
    requests.push(cap);
    const r = await responder(cap);
    if (r.delay) await new Promise((ok) => setTimeout(ok, r.delay));
    if (res.destroyed) return;
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json', 'request-id': 'req_test' });
    res.end(r.raw ?? JSON.stringify(r.json));
  });
});

let app: FastifyInstance;
let owner: Session;
let alice: Session;
let db: typeof import('../src/db.ts');
let providers: typeof import('../src/agents/providers.ts');
let base = '';
let deadUrl = '';

const ENV_KEYS = ['AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'MISTRAL_API_KEY', 'AI_API_KEY'];

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}/v1`;
  // a port nobody listens on
  const tmp = http.createServer();
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
  deadUrl = `http://127.0.0.1:${(tmp.address() as AddressInfo).port}/v1`;
  await new Promise((r) => tmp.close(r));

  ({ app } = await createApp({
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'sk-ant-env-key',
    ...Object.fromEntries(ENV_KEYS.map((k) => [k, undefined])),
  }));
  db = await import('../src/db.ts');
  providers = await import('../src/agents/providers.ts');
  const { initAgents } = await import('../src/agents/runtime.ts');
  initAgents();
  owner = await setupOwner(app);
  alice = await addUser(app, owner.token, { name: 'Alice', email: 'alice@example.com' });
});
after(async () => {
  if (app) await closeApp(app);
  fake.closeAllConnections();
  await new Promise((r) => fake.close(r));
});
beforeEach(() => {
  responder = defaultResponder;
  requests.length = 0;
});

const settings = async (s: Session = owner) => (await api(app, s.token).get('/api/agents/settings')).body;
const put = (body: unknown, s: Session = owner) => api(app, s.token).put('/api/agents/settings', body);
const testConn = (body: unknown, s: Session = owner) => api(app, s.token).post('/api/agents/settings/test', body);
const createAgent = async (body: Record<string, unknown> = {}) => {
  const r = await api(app, alice.token).post('/api/agents', { name: 'Agent', role: 'Helper', instructions: 'Be helpful.', ...body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { agent: any; user: any };
};
const dmWith = async (userId: string) => (await api(app, alice.token).post('/api/dms', { userIds: [userId] })).body.channel;
const send = (channelId: string, text: string, extra: Record<string, unknown> = {}) =>
  api(app, alice.token).post(`/api/channels/${channelId}/messages`, { text, ...extra });
const agentMessages = (channelId: string, userId: string) =>
  db.all<any>('SELECT * FROM messages WHERE channel_id = ? AND user_id = ? AND deleted_at IS NULL AND subtype IS NULL ORDER BY id', channelId, userId);
const waitForReply = (channelId: string, userId: string, n = 1) =>
  waitFor(() => (agentMessages(channelId, userId).length >= n ? agentMessages(channelId, userId) : null));
const chatRequests = () => requests.filter((r) => r.path.endsWith('/chat/completions'));
const silenceLogs = async <T>(fn: () => Promise<T>) => {
  const [e, w] = [console.error, console.warn];
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = e;
    console.warn = w;
  }
};

describe('settings', () => {
  test('defaults: Anthropic, provider list without keys, admin-only writes', async () => {
    const s = await settings();
    assert.equal(s.provider, 'anthropic');
    assert.equal(s.configured, true);
    assert.equal(s.fromEnv, true);
    assert.equal(s.baseUrl, '');
    assert.equal(s.defaultModel, 'claude-opus-5-5');
    assert.equal(s.providerFromEnv, false);
    assert.deepEqual(
      s.models.map((m: any) => m.id),
      ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
    );
    assert.deepEqual(
      s.providers.map((p: any) => p.id),
      ['anthropic', 'openai', 'gemini', 'openrouter', 'mistral', 'ollama', 'custom'],
    );
    const byId = Object.fromEntries(s.providers.map((p: any) => [p.id, p]));
    assert.equal(byId.anthropic.keySet, true);
    assert.equal(byId.anthropic.supportsWebSearch, true);
    assert.equal(byId.openai.keySet, false);
    assert.equal(byId.openai.supportsWebSearch, false);
    assert.equal(byId.gemini.defaultBaseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
    assert.equal(byId.ollama.needsKey, false);
    assert.equal(byId.ollama.needsBaseUrl, true);
    assert.equal(byId.ollama.defaultBaseUrl, 'http://localhost:11434/v1');
    assert.ok(byId.openrouter.keyUrl.startsWith('https://'));
    assert.ok(!JSON.stringify(s).includes('sk-ant-env-key'));

    assert.equal((await put({ provider: 'openai' }, alice)).status, 403);
    assert.equal((await testConn({ provider: 'openai', apiKey: 'x' }, alice)).status, 403);
    assert.equal((await testConn({ provider: 'nope' })).status, 400);
    assert.equal((await put({ provider: 'nope' })).status, 400);
    assert.equal((await put({ defaultModel: 'gpt-4' })).body.error, 'invalid_model');
    assert.equal((await put({ defaultModel: 'claude-sonnet-5-5' })).body.defaultModel, 'claude-sonnet-5-5');
    // new agents without a model get the workspace default
    assert.equal((await createAgent({ name: 'Default Sonnet' })).agent.model, 'claude-sonnet-5-5');
    assert.equal((await put({ defaultModel: '' })).body.defaultModel, 'claude-opus-5-5');
    assert.equal(requests.length, 0);
  });

  test('connection test: Anthropic', async () => {
    const ok = (await testConn({ provider: 'anthropic' })).body;
    assert.deepEqual(ok, {
      ok: true,
      models: [
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
      ],
    });
    assert.equal(requests[0].path, '/v1/models');
    assert.equal(requests[0].headers['x-api-key'], 'sk-ant-env-key');

    const typed = await testConn({ provider: 'anthropic', apiKey: 'sk-ant-typed' });
    assert.equal(typed.body.ok, true);
    assert.equal(requests[1].headers['x-api-key'], 'sk-ant-typed');

    assert.match((await testConn({ provider: 'anthropic', apiKey: 'sk-proj-123' })).body.error, /start with sk-ant-/);
    responder = () => ({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    assert.deepEqual((await testConn({ provider: 'anthropic', apiKey: 'sk-ant-bad' })).body, {
      ok: false,
      error: 'The API key was rejected. Check that it is correct and still active.',
    });
    responder = () => ({ status: 500, json: { type: 'error', error: { type: 'api_error', message: 'boom' } } });
    assert.match((await testConn({ provider: 'anthropic' })).body.error, /HTTP 500/);

    const saved = providers.limits.testTimeoutMs;
    providers.limits.testTimeoutMs = 150;
    try {
      responder = () => ({ delay: 600, json: ANTHROPIC_MODELS });
      assert.match((await testConn({ provider: 'anthropic' })).body.error, /did not respond within/);
    } finally {
      providers.limits.testTimeoutMs = saved;
    }
  });

  test('connection test: OpenAI-compatible providers', async () => {
    const r = (await testConn({ provider: 'custom', baseUrl: `${base}/`, apiKey: 'sk-custom' })).body;
    assert.deepEqual(r, {
      ok: true,
      models: [
        { id: 'gpt-test-large', name: 'gpt-test-large' },
        { id: 'gpt-test-mini', name: 'gpt-test-mini' },
      ],
    });
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].path, '/v1/models');
    assert.equal(requests[0].headers.authorization, 'Bearer sk-custom');

    // Gemini lists ids as "models/…"; ollama needs no key
    responder = () => ({ json: { object: 'list', data: [{ id: 'models/gemini-test-pro', object: 'model' }, { id: 'models/embedding-001' }] } });
    assert.deepEqual((await testConn({ provider: 'gemini', apiKey: 'AIza-test', baseUrl: base })).body.models, [
      { id: 'gemini-test-pro', name: 'gemini-test-pro' },
    ]);
    responder = () => ({ json: { object: 'list', data: [{ id: 'llama-test:8b' }] } });
    const ollama = await testConn({ provider: 'ollama', baseUrl: base });
    assert.equal(ollama.body.ok, true);
    assert.equal(requests.at(-1)!.headers.authorization, undefined);
    responder = () => ({ json: { object: 'list', data: [] } });
    assert.match((await testConn({ provider: 'ollama', baseUrl: base })).body.error, /lists no models.*ollama pull/);

    // friendly failures
    assert.deepEqual((await testConn({ provider: 'openai' })).body, { ok: false, error: 'Enter an API key first.' });
    assert.match((await testConn({ provider: 'custom', baseUrl: 'ftp://x' })).body.error, /must be an http/);
    assert.match((await testConn({ provider: 'custom' })).body.error, /Enter the base URL/);
    responder = () => ({ status: 401, json: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } } });
    assert.match((await testConn({ provider: 'openai', apiKey: 'sk-bad', baseUrl: base })).body.error, /API key was rejected \(HTTP 401\)/);
    responder = () => ({ status: 404, raw: 'Not Found' });
    assert.match((await testConn({ provider: 'custom', baseUrl: base })).body.error, /Nothing found at .*\/v1\/models \(HTTP 404\).*\/v1/);
    responder = () => ({ status: 500, json: { error: 'model server crashed' } });
    assert.match((await testConn({ provider: 'custom', baseUrl: base })).body.error, /HTTP 500: model server crashed/);
    responder = () => ({ raw: '<html>hello</html>' });
    assert.match((await testConn({ provider: 'custom', baseUrl: base })).body.error, /does not look like an OpenAI-compatible API/);
    responder = () => ({ json: { hello: 'world' } });
    assert.match((await testConn({ provider: 'custom', baseUrl: base })).body.error, /does not look like an OpenAI-compatible API/);
    assert.match((await testConn({ provider: 'custom', baseUrl: deadUrl })).body.error, /^Cannot reach http:\/\/127\.0\.0\.1:\d+\/v1/);

    const saved = providers.limits.testTimeoutMs;
    providers.limits.testTimeoutMs = 150;
    try {
      responder = () => ({ delay: 600, json: MODELS });
      assert.match((await testConn({ provider: 'custom', baseUrl: base })).body.error, /did not respond within/);
    } finally {
      providers.limits.testTimeoutMs = saved;
    }
    // nothing was saved by testing
    assert.equal((await settings()).provider, 'anthropic');
    assert.equal(db.getSetting('ai.custom.apiKey'), null);
  });

  test('saving a provider stores the key, caches models and picks a default model; keys are never returned', async () => {
    assert.equal((await put({ provider: 'custom', baseUrl: 'not a url' })).body.error, 'invalid_url');
    const r = await put({ provider: 'custom', apiKey: 'sk-secret-custom', baseUrl: `${base}/` });
    assert.equal(r.status, 200);
    assert.equal(r.body.provider, 'custom');
    assert.equal(r.body.baseUrl, base);
    assert.equal(r.body.defaultModel, 'gpt-test-large');
    assert.equal(r.body.configured, true);
    assert.equal(r.body.fromEnv, false);
    assert.deepEqual(
      r.body.models.map((m: any) => m.id),
      ['gpt-test-large', 'gpt-test-mini'],
    );
    assert.equal(r.body.providers.find((p: any) => p.id === 'custom').keySet, true);
    assert.ok(!JSON.stringify(r.body).includes('sk-secret-custom'));
    assert.ok(!JSON.stringify(await settings()).includes('sk-secret-custom'));
    assert.equal(db.getSetting('ai.custom.apiKey'), 'sk-secret-custom');
    assert.equal(db.getSetting('ai.provider'), 'custom');
    assert.equal(requests.filter((x) => x.path.endsWith('/models')).length, 1);
    // members see the provider and models, but not the base URL
    const member = await settings(alice);
    assert.equal(member.provider, 'custom');
    assert.equal(member.baseUrl, '');
    assert.equal(member.models.length, 2);

    // choosing a default model does not refetch the list
    assert.equal((await put({ defaultModel: 'gpt-test-mini' })).body.defaultModel, 'gpt-test-mini');
    assert.equal(requests.filter((x) => x.path.endsWith('/models')).length, 1);
    // the old body shape applies to the active provider
    await put({ apiKey: 'sk-secret-2' });
    assert.equal(db.getSetting('ai.custom.apiKey'), 'sk-secret-2');
    assert.equal(db.getSetting('anthropic.apiKey'), null);

    // agents: free-text models; '' and Claude ids mean "workspace default"
    const free = await createAgent({ name: 'Free Text', model: 'my-finetune' });
    assert.equal(free.agent.model, 'my-finetune');
    assert.equal((await createAgent({ name: 'No Model' })).agent.model, '');
    assert.equal((await createAgent({ name: 'Claude Id', model: 'claude-opus-5-5' })).agent.model, '');
    const p = await api(app, alice.token).patch(`/api/agents/${free.user.id}`, { model: 'gpt-test-mini' });
    assert.equal(p.body.agent.model, 'gpt-test-mini');

    // a failing model fetch doesn't block saving
    await silenceLogs(async () => {
      responder = () => ({ status: 503, json: { error: 'down' } });
      const down = await put({ provider: 'ollama', baseUrl: deadUrl });
      assert.equal(down.status, 200);
      assert.equal(down.body.provider, 'ollama');
      assert.deepEqual(down.body.models, []);
      assert.equal(down.body.defaultModel, '');
      assert.equal(down.body.configured, false);
    });
  });
});

describe('OpenAI-compatible agents', () => {
  before(async () => {
    responder = defaultResponder;
    await put({ provider: 'custom', apiKey: 'sk-secret-custom', baseUrl: base, defaultModel: 'gpt-test-large' });
  });

  test('DM: request shape and reply', async () => {
    const { user: agent } = await createAgent({ name: 'Open Helper', department: 'Ops', instructions: 'Answer briefly.', webSearch: true });
    const dm = await dmWith(agent.id);
    requests.length = 0;
    await send(dm.id, `Hi <@${agent.id}>`);
    const [reply] = await waitForReply(dm.id, agent.id);
    assert.equal(reply.text, 'Hello from an open model');
    assert.equal(JSON.parse(reply.meta).agentDepth, 1);
    const req = chatRequests()[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer sk-secret-custom');
    assert.equal(req.body.model, 'gpt-test-large');
    // no Anthropic-only parameters, no web search
    assert.equal(req.body.fallbacks, undefined);
    assert.equal(req.body.output_config, undefined);
    assert.deepEqual(
      req.body.tools.map((t: any) => [t.type, t.function.name]),
      ['send_message', 'read_channel', 'search_messages', 'list_channels', 'add_reaction'].map((n) => ['function', n]),
    );
    assert.deepEqual(req.body.tools[0].function.parameters.required, ['to', 'text']);
    assert.equal(req.body.messages[0].role, 'system');
    assert.match(req.body.messages[0].content, /You are Open Helper \(@open\.helper\)[\s\S]*Team \/ department: Ops[\s\S]*Answer briefly\./);
    assert.equal(req.body.messages[1].role, 'user');
    assert.match(req.body.messages[1].content, /You are in: direct message with Alice[\s\S]*New message you are responding to:\n.*Hi @open\.helper/);

    // an agent-specific model wins over the default
    const { user: mini } = await createAgent({ name: 'Mini', model: 'gpt-test-mini' });
    const dm2 = await dmWith(mini.id);
    requests.length = 0;
    await send(dm2.id, 'hi');
    await waitForReply(dm2.id, mini.id);
    assert.equal(chatRequests()[0].body.model, 'gpt-test-mini');
  });

  test('tool calls round-trip, then the final reply is posted', async () => {
    const { user: agent } = await createAgent({ name: 'Open Delegator' });
    const dm = await dmWith(agent.id);
    const bob = await addUser(app, owner.token, { name: 'Bob', email: 'bob@example.com' });
    let round = 0;
    let second: any;
    responder = (req) => {
      if (!req.path.endsWith('/chat/completions')) return defaultResponder(req);
      round++;
      if (round === 1)
        return toolCalls(
          ['call_1', 'send_message', { to: `@${bob.me.username}`, text: `Hi @${bob.me.username}, please review` }],
          ['call_2', 'add_reaction', { emoji: ':eyes:' }],
          ['call_3', 'read_channel', '{not json'],
          ['call_4', 'teleport', {}],
        );
      if (round === 2) {
        second = req.body;
        // tool calls without an id (some local servers) still work
        return completion({ content: '', tool_calls: [{ type: 'function', function: { name: 'list_channels', arguments: '' } }] });
      }
      return say('Done – I asked Bob.');
    };
    const trigger = (await send(dm.id, 'Please ask Bob to review')).body;
    const [reply] = await waitForReply(dm.id, agent.id);
    assert.equal(reply.text, 'Done – I asked Bob.');
    assert.equal(chatRequests().length, 3);

    const msgs = second.messages;
    const assistant = msgs.at(-5);
    assert.equal(assistant.role, 'assistant');
    assert.deepEqual(
      assistant.tool_calls.map((c: any) => [c.id, c.type, c.function.name]),
      [
        ['call_1', 'function', 'send_message'],
        ['call_2', 'function', 'add_reaction'],
        ['call_3', 'function', 'read_channel'],
        ['call_4', 'function', 'teleport'],
      ],
    );
    assert.deepEqual(
      msgs.slice(-4).map((m: any) => [m.role, m.tool_call_id, m.content]),
      [
        ['tool', 'call_1', `Sent to @${bob.me.username}.`],
        ['tool', 'call_2', 'Reaction added.'],
        ['tool', 'call_3', 'Error: the tool arguments are not valid JSON.'],
        ['tool', 'call_4', 'Error: unknown tool teleport'],
      ],
    );
    const third = chatRequests()[2].body.messages;
    assert.equal(third.at(-2).tool_calls[0].id, 'call_1_0');
    assert.equal(third.at(-1).tool_call_id, 'call_1_0');
    assert.match(third.at(-1).content, /#general \(member\)|#general/);

    const bobDm = db.get<{ id: string }>('SELECT id FROM channels WHERE dm_key = ?', [agent.id, bob.me.id].sort().join(','))!;
    const toBob = agentMessages(bobDm.id, agent.id);
    assert.equal(toBob[0].text, `Hi <@${bob.me.id}>, please review`);
    assert.equal(JSON.parse(toBob[0].meta).agentDepth, 1);
    const reacted = (await api(app, alice.token).get(`/api/messages/${trigger.id}`)).body;
    assert.deepEqual(reacted.reactions, [{ emoji: 'eyes', userIds: [agent.id] }]);
  });

  test('content filter and empty answers', async () => {
    const { user: agent } = await createAgent({ name: 'Filtered' });
    const dm = await dmWith(agent.id);
    responder = (req) => (req.path.endsWith('/chat/completions') ? completion({ content: null }, 'content_filter') : defaultResponder(req));
    await send(dm.id, 'bad');
    assert.equal((await waitForReply(dm.id, agent.id))[0].text, 'Sorry, I can’t help with that.');
    // array content parts are joined
    responder = (req) =>
      req.path.endsWith('/chat/completions')
        ? completion({
            content: [
              { type: 'text', text: 'part one, ' },
              { type: 'text', text: 'part two' },
            ],
          })
        : defaultResponder(req);
    await send(dm.id, 'parts');
    assert.equal((await waitForReply(dm.id, agent.id, 2))[1].text, 'part one, part two');
  });

  test('images are sent as data URLs, and dropped when the model rejects them', async () => {
    const { user: agent } = await createAgent({ name: 'Open Vision' });
    const dm = await dmWith(agent.id);
    const up = await api(app, alice.token).upload('/api/files', [{ filename: 'a.png', content: png(2, 2), contentType: 'image/png' }]);
    await send(dm.id, 'what is this?', { fileIds: [up.body[0].id] });
    await waitForReply(dm.id, agent.id);
    const content = chatRequests()[0].body.messages[1].content;
    assert.equal(content[0].type, 'image_url');
    assert.equal(content[0].image_url.url, `data:image/png;base64,${png(2, 2).toString('base64')}`);
    assert.equal(content[1].type, 'text');
    assert.match(content[1].text, /\[files: a\.png\]/);

    requests.length = 0;
    responder = (req) => {
      if (Array.isArray(req.body?.messages?.[1]?.content)) return { status: 400, json: { error: { message: 'model does not support images' } } };
      return say('text only answer');
    };
    const up2 = await api(app, alice.token).upload('/api/files', [{ filename: 'b.png', content: png(3, 3), contentType: 'image/png' }]);
    await send(dm.id, 'and this?', { fileIds: [up2.body[0].id] });
    const rows = await waitForReply(dm.id, agent.id, 2);
    assert.equal(rows[1].text, 'text only answer');
    assert.equal(chatRequests().length, 2);
    assert.equal(typeof chatRequests()[1].body.messages[1].content, 'string');
  });

  test('API errors become an apology message', async () => {
    const { user: agent } = await createAgent({ name: 'Open Unlucky', model: 'gpt-missing' });
    const dm = await dmWith(agent.id);
    const err = (status: number, message: string): Reply => ({ status, json: { error: { message } } });
    const cases: [Reply, RegExp][] = [
      [err(401, 'bad key'), /the Custom \(OpenAI-compatible\) API key is invalid/],
      [err(402, 'no credit'), /run out of credit/],
      [err(403, 'nope'), /no access to this model/],
      [err(404, 'no such model'), /the model “gpt-missing” was not found/],
      [err(429, 'slow down'), /rate limited/],
      [err(400, 'tools not supported'), /the request was rejected \(400 tools not supported\)/],
      [err(500, 'boom'), /the AI service returned an error \(500\)/],
      [{ raw: 'not json' }, /a response I couldn’t read/],
      [{ json: { choices: [] } }, /a response I couldn’t read/],
    ];
    let i = 0;
    for (const [reply, re] of cases) {
      responder = (req) => (req.path.endsWith('/chat/completions') ? reply : defaultResponder(req));
      await silenceLogs(async () => {
        await send(dm.id, `try ${i}`);
        const rows = await waitForReply(dm.id, agent.id, ++i);
        assert.match(rows.at(-1).text, /^⚠️ Sorry, I couldn’t answer: /);
        assert.match(rows.at(-1).text, re);
      });
    }
    // timeouts and unreachable servers
    const saved = providers.limits.requestTimeoutMs;
    providers.limits.requestTimeoutMs = 150;
    try {
      responder = () => ({ delay: 600, ...say('too late') });
      await silenceLogs(async () => {
        await send(dm.id, 'slow');
        assert.match((await waitForReply(dm.id, agent.id, ++i)).at(-1).text, /took too long/);
      });
    } finally {
      providers.limits.requestTimeoutMs = saved;
    }
    db.setSetting('ai.baseUrl', deadUrl);
    try {
      await silenceLogs(async () => {
        await send(dm.id, 'anyone?');
        assert.match((await waitForReply(dm.id, agent.id, ++i)).at(-1).text, /can’t be reached/);
      });
    } finally {
      db.setSetting('ai.baseUrl', base);
    }
  });

  test('not configured: missing key or model', async () => {
    const { user: agent } = await createAgent({ name: 'Open Unplugged' });
    const dm = await dmWith(agent.id);
    await put({ provider: 'openai' }); // no OpenAI key yet
    try {
      const s = await settings();
      assert.equal(s.provider, 'openai');
      assert.equal(s.configured, false);
      assert.equal(s.baseUrl, 'https://api.openai.com/v1');
      requests.length = 0;
      await send(dm.id, 'hello?');
      const [reply] = await waitForReply(dm.id, agent.id);
      assert.match(reply.text, /not connected to an AI model yet.*OpenAI setup/);
      assert.equal(requests.length, 0);
    } finally {
      await put({ provider: 'custom', apiKey: 'sk-secret-custom', baseUrl: base, defaultModel: 'gpt-test-large' });
    }
  });

  test('environment overrides', async () => {
    const env = { AI_PROVIDER: 'openai', AI_BASE_URL: `${base}/`, AI_MODEL: 'gpt-env-model', OPENAI_API_KEY: 'sk-env-openai' };
    Object.assign(process.env, env);
    try {
      const s = await settings();
      assert.equal(s.provider, 'openai');
      assert.equal(s.providerFromEnv, true);
      assert.equal(s.fromEnv, true);
      assert.equal(s.configured, true);
      assert.equal(s.baseUrl, base);
      assert.equal(s.defaultModel, 'gpt-env-model');
      assert.equal(s.providers.find((p: any) => p.id === 'openai').keySet, true);
      assert.ok(!JSON.stringify(s).includes('sk-env-openai'));
      assert.equal((await put({ provider: 'anthropic' })).body.error, 'provider_from_env');

      const { user: agent } = await createAgent({ name: 'Env Agent' });
      const dm = await dmWith(agent.id);
      requests.length = 0;
      await send(dm.id, 'hi');
      await waitForReply(dm.id, agent.id);
      assert.equal(chatRequests()[0].headers.authorization, 'Bearer sk-env-openai');
      assert.equal(chatRequests()[0].body.model, 'gpt-env-model');
      // the connection test uses the env key
      assert.equal((await testConn({ provider: 'openai' })).body.ok, true);
      assert.equal(requests.at(-1)!.headers.authorization, 'Bearer sk-env-openai');
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });

  test('switching back to Anthropic restores the Claude setup', async () => {
    const { user: agent } = await createAgent({ name: 'Switcher', model: 'gpt-test-mini' });
    const r = await put({ provider: 'anthropic' });
    assert.equal(r.body.provider, 'anthropic');
    assert.equal(r.body.defaultModel, 'claude-opus-5-5');
    assert.equal(r.body.baseUrl, '');
    assert.deepEqual(
      r.body.models.map((m: any) => m.id),
      ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
    );
    assert.equal(db.getSetting('ai.provider'), null);
    // the stored custom key stays for later
    assert.equal(db.getSetting('ai.custom.apiKey'), 'sk-secret-custom');
    // a non-Claude agent model shows (and runs) as the default Claude model
    const a = (await api(app, alice.token).get(`/api/agents/${agent.id}`)).body.agent;
    assert.equal(a.model, 'claude-opus-5-5');
    const dm = await dmWith(agent.id);
    responder = () => ({
      json: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'Claude here' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    requests.length = 0;
    await send(dm.id, 'who are you?');
    assert.equal((await waitForReply(dm.id, agent.id))[0].text, 'Claude here');
    assert.equal(requests[0].path, '/v1/messages');
    assert.equal(requests[0].body.model, 'claude-opus-5-5');
  });
});
