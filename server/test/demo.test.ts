import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { OWNER, api, closeApp, createApp } from './helpers.ts';

let app: FastifyInstance;

before(async () => {
  ({ app } = await createApp({ DEMO_MODE: 'true', DEMO_RESET_HOURS: '6', NODE_ENV: 'production', SETUP_TOKEN: undefined }));
  const { initDemo } = await import('../src/demo.ts');
  await initDemo();
});
after(() => closeApp(app));

test('a demo instance is seeded and needs no setup', async () => {
  const s = (await api(app).get('/api/setup/status')).body;
  assert.equal(s.needsSetup, false);
  assert.equal(s.demo.resetHours, 6);
  assert.ok(s.demo.nextResetAt > Date.now() + 5.9 * 3_600_000);
  assert.equal(s.workspace.name, 'Northwind Labs');
});

test('visitors get a throw-away account with sample content in one click', async () => {
  const r = await api(app).post('/api/demo/login', {});
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.equal(r.body.me.role, 'member');
  const boot = (await api(app, r.body.token).get('/api/bootstrap')).body;
  assert.equal(boot.workspace.demo.resetHours, 6);
  const channels = new Map(boot.channels.map((c: any) => [c.id, c]));
  const joined = boot.memberships.map((m: any) => (channels.get(m.channelId) as any)?.name).filter(Boolean);
  for (const name of ['announcements', 'general', 'random', 'engineering', 'website-relaunch']) assert.ok(joined.includes(name), name);
  assert.ok(!joined.includes('leadership'), 'private channels stay private');
  assert.ok(!joined.includes('q4-planning'), 'something is left to discover in Browse channels');
  // sections, unread badges and a welcome DM
  assert.deepEqual(
    boot.me.prefs.sidebarSections.map((s: any) => s.name),
    ['Company', 'Teams', 'Projects'],
  );
  const unread = boot.memberships.filter((m: any) => m.unread > 0);
  assert.ok(unread.length >= 2);
  assert.ok(boot.channels.some((c: any) => c.kind === 'dm'));
  assert.ok(boot.agents.length >= 2);

  // threads, reactions and pins came along
  const general = boot.channels.find((c: any) => c.name === 'general');
  const msgs = (await api(app, r.body.token).get(`/api/channels/${general.id}/messages`)).body;
  const list = msgs.messages ?? msgs;
  assert.ok(list.some((m: any) => m.replyCount >= 3));
  assert.ok(list.some((m: any) => m.reactions.length > 0));
});

test('sign-ups, invites, password changes and setup are disabled', async () => {
  const visitor = (await api(app).post('/api/demo/login', {})).body;
  for (const [method, url, body] of [
    ['post', '/api/invites', { role: 'member' }],
    ['put', '/api/auth/password', { currentPassword: 'x', newPassword: 'yyyyyyyy' }],
    ['post', '/api/auth/signup', { inviteCode: 'x', fullName: 'X', email: 'x@example.com', password: 'password123' }],
    ['post', '/api/setup', OWNER],
  ] as const) {
    const r = await (api(app, visitor.token) as any)[method](url, body);
    assert.equal(r.status, 403, url);
    assert.equal(r.body.error, 'demo_disabled');
  }
  // regular use still works
  const ch = (await api(app, visitor.token).post('/api/channels', { name: 'my-test' })).body;
  assert.equal(ch.name, 'my-test');
});

test('reset wipes visitors and their data, then seeds again', async () => {
  const visitor = (await api(app).post('/api/demo/login', {})).body;
  await api(app, visitor.token).post('/api/channels', { name: 'temporary' });
  const { resetDemo } = await import('../src/demo.ts');
  await resetDemo();
  assert.equal((await api(app, visitor.token).get('/api/bootstrap')).status, 401);
  const fresh = (await api(app).post('/api/demo/login', {})).body;
  const boot = (await api(app, fresh.token).get('/api/bootstrap')).body;
  assert.ok(!boot.channels.some((c: any) => c.name === 'temporary' || c.name === 'my-test'));
  assert.equal(boot.channels.filter((c: any) => c.name === 'general').length, 1);
  const search = (await api(app, fresh.token).get('/api/search?q=ramen')).body;
  assert.ok(JSON.stringify(search).includes('ramen'), 'the search index was rebuilt');
});
