import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { OWNER, addUser, api, closeApp, createApp, type Session } from './helpers.ts';

let app: FastifyInstance;
let owner: Session;

before(async () => {
  ({ app } = await createApp());
});
after(() => closeApp(app));

describe('setup', () => {
  test('health endpoint', async () => {
    const r = await api(app).get('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  test('status says setup is needed before the first user exists', async () => {
    const r = await api(app).get('/api/setup/status');
    assert.deepEqual(r.body, { needsSetup: true, setupCodeRequired: false, workspace: null });
  });

  test('setup validates input', async () => {
    const r = await api(app).post('/api/setup', { ...OWNER, password: 'short' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_input');
    assert.match(r.body.message, /password/);
  });

  test('setup creates the owner, workspace and default channels', async () => {
    const r = await api(app).post('/api/setup', { ...OWNER, timezone: 'Europe/Prague' });
    assert.equal(r.status, 200);
    owner = r.body;
    assert.ok(owner.token);
    assert.equal(owner.me.role, 'owner');
    assert.equal(owner.me.email, OWNER.email);
    assert.equal(owner.me.username, 'owner');
    assert.equal(owner.me.timezone, 'Europe/Prague');
    const cookie = String(r.headers['set-cookie']);
    assert.match(cookie, /relay_session=/);
    assert.match(cookie, /HttpOnly/);

    const boot = await api(app, owner.token).get('/api/bootstrap');
    assert.deepEqual(boot.body.channels.map((c: any) => c.name).sort(), ['general', 'random']);
    assert.equal(boot.body.workspace.name, 'Acme');
  });

  test('setup only works once', async () => {
    const r = await api(app).post('/api/setup', { ...OWNER, email: 'other@example.com' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'already_setup');
    const s = await api(app).get('/api/setup/status');
    assert.equal(s.body.needsSetup, false);
    assert.equal(s.body.workspace.name, 'Acme');
  });
});

describe('login / logout / sessions', () => {
  test('login with email or username', async () => {
    const r = await api(app).post('/api/auth/login', { email: 'OWNER@example.com', password: OWNER.password });
    assert.equal(r.status, 200);
    assert.equal(r.body.me.id, owner.me.id);
    const r2 = await api(app).post('/api/auth/login', { email: 'owner', password: OWNER.password });
    assert.equal(r2.status, 200);
  });

  test('wrong password and unknown user give 401', async () => {
    const r = await api(app).post('/api/auth/login', { email: OWNER.email, password: 'nope-nope' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'invalid_credentials');
    const r2 = await api(app).post('/api/auth/login', { email: 'ghost@example.com', password: 'whatever1' });
    assert.equal(r2.status, 401);
  });

  test('unauthenticated requests are rejected', async () => {
    const r = await api(app).get('/api/bootstrap');
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'not_authenticated');
    const r2 = await api(app, 'garbage-token').get('/api/bootstrap');
    assert.equal(r2.status, 401);
  });

  test('session cookie authenticates as well as the bearer header', async () => {
    const login = await api(app).post('/api/auth/login', { email: OWNER.email, password: OWNER.password });
    const res = await app.inject({ method: 'GET', url: '/api/bootstrap', cookies: { relay_session: login.body.token } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().me.id, owner.me.id);
  });

  test('session count, logout-others and logout', async () => {
    const a = (await api(app).post('/api/auth/login', { email: OWNER.email, password: OWNER.password })).body.token;
    const b = (await api(app).post('/api/auth/login', { email: OWNER.email, password: OWNER.password })).body.token;
    const count = await api(app, a).get('/api/auth/sessions');
    assert.ok(count.body.count >= 3);
    const lo = await api(app, a).post('/api/auth/logout-others');
    assert.equal(lo.status, 200);
    assert.ok(lo.body.count >= 2);
    assert.equal((await api(app, a).get('/api/auth/sessions')).body.count, 1);
    assert.equal((await api(app, b).get('/api/bootstrap')).status, 401);
    assert.equal((await api(app, owner.token).get('/api/bootstrap')).status, 401);

    const out = await api(app, a).post('/api/auth/logout');
    assert.equal(out.status, 200);
    assert.match(String(out.headers['set-cookie']), /relay_session=;/);
    assert.equal((await api(app, a).get('/api/bootstrap')).status, 401);

    owner = (await api(app).post('/api/auth/login', { email: OWNER.email, password: OWNER.password })).body;
  });

  test('password change', async () => {
    const o = api(app, owner.token);
    assert.equal((await o.put('/api/auth/password', { current: 'wrong-pass', password: 'new-password-1' })).body.error, 'wrong_password');
    assert.equal((await o.put('/api/auth/password', { current: OWNER.password, password: 'short' })).status, 400);
    assert.equal((await o.put('/api/auth/password', { current: OWNER.password, password: 'new-password-1' })).status, 200);
    assert.equal((await api(app).post('/api/auth/login', { email: OWNER.email, password: OWNER.password })).status, 401);
    assert.equal((await api(app).post('/api/auth/login', { email: OWNER.email, password: 'new-password-1' })).status, 200);
    await o.put('/api/auth/password', { current: 'new-password-1', password: OWNER.password });
  });

  test('login rate limit applies per client address', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@example.com', password: 'y' }, remoteAddress: '192.0.2.77' });
      last = res.statusCode;
    }
    assert.equal(last, 429);
  });
});

describe('signup', () => {
  test('invite info endpoint', async () => {
    const inv = await api(app, owner.token).post('/api/invites', { email: 'info@example.com' });
    const r = await api(app).get(`/api/invites/${inv.body.code}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.email, 'info@example.com');
    assert.equal(r.body.workspace.name, 'Acme');
    assert.equal((await api(app).get('/api/invites/nope')).status, 404);
  });

  test('invite gives its role and joins default channels', async () => {
    const inv = await api(app, owner.token).post('/api/invites', { role: 'admin' });
    assert.equal(inv.body.role, 'admin');
    assert.equal(inv.body.maxUses, null);
    const r = await api(app).post('/api/auth/signup', { inviteCode: inv.body.code, fullName: 'Ada Admin', email: 'Ada@Example.com', password: 'password123', timezone: 'UTC' });
    assert.equal(r.status, 200);
    assert.equal(r.body.me.role, 'admin');
    assert.equal(r.body.me.email, 'ada@example.com');
    const boot = await api(app, r.body.token).get('/api/bootstrap');
    assert.deepEqual(boot.body.channels.map((c: any) => c.name).sort(), ['general', 'random']);
    // the join message is already read
    assert.ok(boot.body.memberships.every((m: any) => m.unread === 0));
    // same email again
    const dup = await api(app).post('/api/auth/signup', { inviteCode: inv.body.code, fullName: 'Ada 2', email: 'ada@example.com', password: 'password123' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'email_taken');
  });

  test('usernames are made unique', async () => {
    const inv = await api(app, owner.token).post('/api/invites', {});
    const r = await api(app).post('/api/auth/signup', { inviteCode: inv.body.code, fullName: 'Other Owner', email: 'owner@other.org', password: 'password123' });
    assert.equal(r.body.me.username, 'owner2');
  });

  test('email-locked invites only accept that address and are single use', async () => {
    const inv = await api(app, owner.token).post('/api/invites', { email: 'locked@example.com', role: 'guest' });
    assert.equal(inv.body.maxUses, 1);
    const wrong = await api(app).post('/api/auth/signup', { inviteCode: inv.body.code, fullName: 'X', email: 'other@example.com', password: 'password123' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'invite_email_mismatch');
    const ok = await api(app).post('/api/auth/signup', { inviteCode: inv.body.code, fullName: 'Gus Guest', email: 'LOCKED@example.com', password: 'password123' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.me.role, 'guest');
    const again = await api(app).post('/api/auth/signup', { inviteCode: inv.body.code, fullName: 'X', email: 'locked@example.com', password: 'password123' });
    assert.equal(again.body.error, 'invite_invalid');
    assert.equal((await api(app).get(`/api/invites/${inv.body.code}`)).status, 404);
  });

  test('max uses are enforced', async () => {
    const inv = await api(app, owner.token).post('/api/invites', { maxUses: 1 });
    assert.equal((await api(app).post('/api/auth/signup', { inviteCode: inv.body.code, fullName: 'M1', email: 'm1@example.com', password: 'password123' })).status, 200);
    const r = await api(app).post('/api/auth/signup', { inviteCode: inv.body.code, fullName: 'M2', email: 'm2@example.com', password: 'password123' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invite_invalid');
  });

  test('a failed signup does not use up the invite', async () => {
    const inv = await api(app, owner.token).post('/api/invites', { maxUses: 1 });
    const taken = await api(app).post('/api/auth/signup', { inviteCode: inv.body.code, fullName: 'Dup', email: 'm1@example.com', password: 'password123' });
    assert.equal(taken.status, 409);
    const bad = await api(app).post('/api/auth/signup', { inviteCode: inv.body.code, fullName: 'Short', email: 'short@example.com', password: 'short' });
    assert.equal(bad.status, 400);
    const ok = await api(app).post('/api/auth/signup', { inviteCode: inv.body.code, fullName: 'Fresh', email: 'fresh@example.com', password: 'password123' });
    assert.equal(ok.status, 200);
    const list = await api(app, owner.token).get('/api/invites');
    assert.equal(list.body.find((i: any) => i.code === inv.body.code).uses, 1);
  });

  test('concurrent signups cannot exceed max uses', async () => {
    const inv = await api(app, owner.token).post('/api/invites', { maxUses: 1 });
    const results = await Promise.all(
      ['race1@example.com', 'race2@example.com', 'race3@example.com'].map((email) =>
        api(app).post('/api/auth/signup', { inviteCode: inv.body.code, fullName: 'Racer', email, password: 'password123' }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400, 400]);
  });

  test('expired invites are rejected', async () => {
    const inv = await api(app, owner.token).post('/api/invites', { expiresInDays: 1 });
    const { run } = await import('../src/db.ts');
    run('UPDATE invites SET expires_at = ? WHERE code = ?', Date.now() - 1000, inv.body.code);
    const r = await api(app).post('/api/auth/signup', { inviteCode: inv.body.code, fullName: 'Late', email: 'late@example.com', password: 'password123' });
    assert.equal(r.body.error, 'invite_invalid');
    assert.equal((await api(app).post('/api/auth/signup', { inviteCode: 'unknown', fullName: 'Late', email: 'late@example.com', password: 'password123' })).body.error, 'invite_invalid');
  });

  test('open signup only for allowed domains', async () => {
    const closed = await api(app).post('/api/auth/signup', { fullName: 'Dom', email: 'dom@acme.dev', password: 'password123' });
    assert.equal(closed.status, 403);
    assert.equal(closed.body.error, 'signup_not_allowed');
    const w = await api(app, owner.token).patch('/api/workspace', { allowedDomains: '@Acme.dev, other.io' });
    assert.equal(w.body.allowedDomains, 'acme.dev,other.io');
    const open = await api(app).post('/api/auth/signup', { fullName: 'Dom', email: 'dom@acme.dev', password: 'password123' });
    assert.equal(open.status, 200);
    assert.equal(open.body.me.role, 'member');
    const other = await api(app).post('/api/auth/signup', { fullName: 'Eve', email: 'eve@evil.io', password: 'password123' });
    assert.equal(other.status, 403);
  });

  test('deactivated accounts cannot log in; bots and external users never can', async () => {
    const u = await addUser(app, owner.token, { email: 'deact@example.com', password: 'password123' });
    assert.equal((await api(app, owner.token).patch(`/api/users/${u.me.id}`, { deactivated: true })).status, 200);
    const r = await api(app).post('/api/auth/login', { email: 'deact@example.com', password: 'password123' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'account_deactivated');
    assert.equal((await api(app, u.token).get('/api/bootstrap')).status, 401);

    const { run } = await import('../src/db.ts');
    const b = await addUser(app, owner.token, { email: 'bot@example.com', password: 'password123' });
    run('UPDATE users SET is_bot = 1 WHERE id = ?', b.me.id);
    assert.equal((await api(app).post('/api/auth/login', { email: 'bot@example.com', password: 'password123' })).status, 401);
  });

  test('sessions expire after 90 days without use and are refreshed hourly', async () => {
    const { run, get } = await import('../src/db.ts');
    const { sha256 } = await import('../src/lib/util.ts');
    const u = await addUser(app, owner.token);
    const hash = sha256(u.token);
    run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', Date.now() - 2 * 3600_000, hash);
    assert.equal((await api(app, u.token).get('/api/counts')).status, 200);
    assert.ok(get<{ last_seen_at: number }>('SELECT last_seen_at FROM sessions WHERE token_hash = ?', hash)!.last_seen_at > Date.now() - 60_000);
    run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', Date.now() - 91 * 86400_000, hash);
    assert.equal((await api(app, u.token).get('/api/counts')).status, 401);
    assert.equal(get('SELECT 1 FROM sessions WHERE token_hash = ?', hash), undefined);
  });
});

describe('error handling', () => {
  test('malformed JSON bodies are a 400, not a 500', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: '{bad', headers: { 'content-type': 'application/json' }, remoteAddress: '10.200.0.1' });
    assert.equal(res.statusCode, 400);
  });
});
