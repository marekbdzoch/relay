import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { addUser, api, closeApp, createApp, gif, png, setupOwner, type Session } from './helpers.ts';

let app: FastifyInstance;
let dataDir: string;
let owner: Session;
let admin: Session;
let member: Session;
let guest: Session;

before(async () => {
  ({ app, dataDir } = await createApp());
  owner = await setupOwner(app);
  admin = await addUser(app, owner.token, { name: 'Ann Admin', email: 'ann@example.com', role: 'admin' });
  member = await addUser(app, owner.token, { name: 'Mike Member', email: 'mike@example.com' });
  guest = await addUser(app, owner.token, { name: 'Gina Guest', email: 'gina@example.com', role: 'guest' });
});
after(() => closeApp(app));

describe('bootstrap & users', () => {
  test('bootstrap shape', async () => {
    const r = await api(app, member.token).get('/api/bootstrap');
    assert.equal(r.status, 200);
    const b = r.body;
    for (const k of ['me', 'workspace', 'users', 'channels', 'memberships', 'presence', 'savedIds', 'agents', 'drafts', 'customEmoji', 'huddles', 'activityUnread', 'threadsUnread', 'version']) {
      assert.ok(k in b, `missing ${k}`);
    }
    assert.equal(b.me.id, member.me.id);
    assert.equal(b.me.email, 'mike@example.com');
    assert.deepEqual(b.me.prefs, {});
    assert.equal(b.me.awayManual, false);
    assert.equal(b.users.length, 4);
    // members do not see other people's emails, admins do
    assert.ok(b.users.every((u: any) => u.email === undefined));
    const adminBoot = await api(app, admin.token).get('/api/bootstrap');
    assert.ok(adminBoot.body.users.every((u: any) => typeof u.email === 'string'));
    assert.ok(Array.isArray(b.workspace.iceServers));
  });

  test('user list and single user', async () => {
    const list = await api(app, member.token).get('/api/users');
    assert.equal(list.body.length, 4);
    const one = await api(app, member.token).get(`/api/users/${owner.me.id}`);
    assert.equal(one.body.fullName, 'Olivia Owner');
    assert.equal(one.body.email, undefined);
    const self = await api(app, member.token).get(`/api/users/${member.me.id}`);
    assert.equal(self.body.email, 'mike@example.com');
    assert.equal((await api(app, member.token).get('/api/users/UNKNOWN')).status, 404);
  });
});

describe('profile', () => {
  test('patch profile fields', async () => {
    const r = await api(app, member.token).patch('/api/users/me', { fullName: ' Mike M ', displayName: 'mikey', title: 'Engineer', phone: '+420', timezone: 'Europe/Prague' });
    assert.equal(r.status, 200);
    assert.equal(r.body.fullName, 'Mike M');
    assert.equal(r.body.displayName, 'mikey');
    assert.equal(r.body.title, 'Engineer');
    assert.equal(r.body.phone, '+420');
    assert.equal(r.body.timezone, 'Europe/Prague');
  });

  test('username is normalised and must be unique', async () => {
    const r = await api(app, member.token).patch('/api/users/me', { username: 'Míké Smith' });
    assert.equal(r.body.username, 'mike.smith');
    const taken = await api(app, admin.token).patch('/api/users/me', { username: 'MIKE.SMITH' });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error, 'username_taken');
    const bad = await api(app, admin.token).patch('/api/users/me', { username: '!!!' });
    assert.equal(bad.body.error, 'invalid_username');
    // keeping your own name is fine
    assert.equal((await api(app, member.token).patch('/api/users/me', { username: 'mike.smith' })).status, 200);
  });

  test('status with expiry', async () => {
    const m = api(app, member.token);
    const r = await m.put('/api/users/me/status', { emoji: 'palm_tree', text: 'On vacation', expiresAt: Date.now() + 60_000 });
    assert.equal(r.body.statusEmoji, 'palm_tree');
    assert.equal(r.body.statusText, 'On vacation');
    assert.ok(r.body.statusExpiresAt);
    const expired = await m.put('/api/users/me/status', { emoji: 'x', text: 'old', expiresAt: Date.now() - 1000 });
    assert.equal(expired.body.statusEmoji, '');
    assert.equal(expired.body.statusText, '');
    assert.equal(expired.body.statusExpiresAt, null);
    const forever = await m.put('/api/users/me/status', { emoji: 'house', text: 'WFH' });
    assert.equal(forever.body.statusExpiresAt, null);
    assert.equal(forever.body.statusText, 'WFH');
    assert.equal((await m.put('/api/users/me/status', { emoji: 'x' })).status, 400);
  });

  test('manual away presence', async () => {
    const r = await api(app, member.token).put('/api/users/me/presence', { away: true });
    assert.equal(r.body.awayManual, true);
    const r2 = await api(app, member.token).put('/api/users/me/presence', { away: false });
    assert.equal(r2.body.awayManual, false);
  });

  test('do not disturb', async () => {
    const until = Date.now() + 3600_000;
    const r = await api(app, member.token).put('/api/users/me/dnd', { until });
    assert.equal(r.body.dndUntil, until);
    const past = await api(app, member.token).put('/api/users/me/dnd', { until: Date.now() - 1 });
    assert.equal(past.body.dndUntil, null);
    const off = await api(app, member.token).put('/api/users/me/dnd', { until: null });
    assert.equal(off.body.dndUntil, null);
  });

  test('prefs are merged', async () => {
    const m = api(app, member.token);
    await m.put('/api/users/me/prefs', { theme: 'dark', sidebar: { compact: true } });
    const r = await m.put('/api/users/me/prefs', { notifications: 'all' });
    assert.deepEqual(r.body.prefs, { theme: 'dark', sidebar: { compact: true }, notifications: 'all' });
    const big = await m.put('/api/users/me/prefs', { blob: 'x'.repeat(21000) });
    assert.equal(big.body.error, 'prefs_too_large');
    assert.equal((await m.put('/api/users/me/prefs', ['nope'])).status, 400);
  });
});

describe('avatar', () => {
  test('upload, serve, replace and delete', async () => {
    const m = api(app, member.token);
    const bad = await m.upload('/api/users/me/avatar', [{ filename: 'a.txt', content: 'hello', contentType: 'text/plain' }], {}, 'PUT');
    assert.equal(bad.body.error, 'unsupported_image');
    const empty = await app.inject({ method: 'PUT', url: '/api/users/me/avatar', headers: { authorization: `Bearer ${member.token}`, 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x--\r\n' });
    assert.equal(empty.statusCode, 400);

    const up = await m.upload('/api/users/me/avatar', [{ filename: 'me.png', content: png(4, 4), contentType: 'image/png' }], {}, 'PUT');
    assert.equal(up.status, 200);
    assert.match(up.body.avatarUrl, new RegExp(`^/api/avatars/${member.me.id}\\?v=`));
    const firstPath = fs.readdirSync(path.join(dataDir, 'uploads', 'avatars'));
    assert.equal(firstPath.length, 1);

    const img = await api(app, owner.token).get(up.body.avatarUrl);
    assert.equal(img.status, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.equal(img.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(img.raw.rawPayload, png(4, 4));
    assert.equal((await api(app).get(up.body.avatarUrl)).status, 401);

    // replacing removes the old file
    const up2 = await m.upload('/api/users/me/avatar', [{ filename: 'me.gif', content: gif(1, 1), contentType: 'image/gif' }], {}, 'PUT');
    assert.notEqual(up2.body.avatarUrl, up.body.avatarUrl);
    const files = fs.readdirSync(path.join(dataDir, 'uploads', 'avatars'));
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('.gif'));
    assert.equal((await api(app, owner.token).get(up2.body.avatarUrl)).headers['content-type'], 'image/gif');

    const del = await m.del('/api/users/me/avatar');
    assert.equal(del.body.avatarUrl, null);
    assert.equal(fs.readdirSync(path.join(dataDir, 'uploads', 'avatars')).length, 0);
    assert.equal((await api(app, owner.token).get(`/api/avatars/${member.me.id}`)).status, 404);
  });
});

describe('admin: members', () => {
  test('only admins may change members', async () => {
    const r = await api(app, member.token).patch(`/api/users/${guest.me.id}`, { role: 'member' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'admin_only');
  });

  test('admins change roles and names', async () => {
    const r = await api(app, admin.token).patch(`/api/users/${guest.me.id}`, { role: 'member', fullName: 'Gina G' });
    assert.equal(r.status, 200);
    assert.equal(r.body.role, 'member');
    assert.equal(r.body.fullName, 'Gina G');
    assert.equal(r.body.email, 'gina@example.com');
    await api(app, admin.token).patch(`/api/users/${guest.me.id}`, { role: 'guest' });
    assert.equal((await api(app, admin.token).patch('/api/users/NOPE', { role: 'guest' })).status, 404);
  });

  test('owner protections', async () => {
    const a = api(app, admin.token);
    assert.equal((await a.patch(`/api/users/${owner.me.id}`, { role: 'member' })).body.error, 'owner_only');
    assert.equal((await a.patch(`/api/users/${owner.me.id}`, { deactivated: true })).body.error, 'owner_only');
    assert.equal((await a.patch(`/api/users/${member.me.id}`, { role: 'owner' })).body.error, 'owner_only');
    assert.equal((await a.patch(`/api/users/${admin.me.id}`, { role: 'member' })).body.error, 'cannot_change_self');
    assert.equal((await api(app, owner.token).patch(`/api/users/${owner.me.id}`, { deactivated: true })).body.error, 'cannot_change_self');
    // same role for oneself is a no-op, name change is fine
    assert.equal((await a.patch(`/api/users/${admin.me.id}`, { role: 'admin', fullName: 'Ann A' })).status, 200);
    // owners can create other owners
    const promoted = await api(app, owner.token).patch(`/api/users/${admin.me.id}`, { role: 'owner' });
    assert.equal(promoted.body.role, 'owner');
    await api(app, owner.token).patch(`/api/users/${admin.me.id}`, { role: 'admin' });
  });

  test('deactivation revokes sessions; reactivation allows login again', async () => {
    const victim = await addUser(app, owner.token, { email: 'victim@example.com', password: 'password123' });
    assert.equal((await api(app, victim.token).get('/api/counts')).status, 200);
    const r = await api(app, admin.token).patch(`/api/users/${victim.me.id}`, { deactivated: true });
    assert.equal(r.body.deactivated, true);
    assert.equal((await api(app, victim.token).get('/api/counts')).status, 401);
    await api(app, admin.token).patch(`/api/users/${victim.me.id}`, { deactivated: false });
    assert.equal((await api(app).post('/api/auth/login', { email: 'victim@example.com', password: 'password123' })).status, 200);
  });
});

describe('workspace', () => {
  test('patch name (admins only)', async () => {
    assert.equal((await api(app, member.token).patch('/api/workspace', { name: 'Hack' })).status, 403);
    const r = await api(app, admin.token).patch('/api/workspace', { name: 'Acme Inc' });
    assert.equal(r.body.name, 'Acme Inc');
    assert.equal((await api(app, admin.token).patch('/api/workspace', { name: '' })).status, 400);
  });

  test('icon upload is public', async () => {
    assert.equal((await api(app).get('/api/workspace/icon')).status, 404);
    assert.equal((await api(app, member.token).upload('/api/workspace/icon', [{ filename: 'i.png', content: png(), contentType: 'image/png' }], {}, 'PUT')).status, 403);
    const bad = await api(app, admin.token).upload('/api/workspace/icon', [{ filename: 'i.svg', content: '<svg/>', contentType: 'image/svg+xml' }], {}, 'PUT');
    assert.equal(bad.body.error, 'unsupported_image');
    const r = await api(app, admin.token).upload('/api/workspace/icon', [{ filename: 'i.png', content: png(), contentType: 'image/png' }], {}, 'PUT');
    assert.match(r.body.iconUrl, /^\/api\/workspace\/icon\?v=/);
    const r2 = await api(app, admin.token).upload('/api/workspace/icon', [{ filename: 'i.png', content: png(3, 3), contentType: 'image/png' }], {}, 'PUT');
    assert.notEqual(r2.body.iconUrl, r.body.iconUrl);
    assert.equal(fs.readdirSync(path.join(dataDir, 'uploads', 'workspace')).length, 1);
    const icon = await api(app).get('/api/workspace/icon');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers['content-type'], 'image/png');
    const status = await api(app).get('/api/setup/status');
    assert.equal(status.body.workspace.iconUrl, r2.body.iconUrl);
  });
});

describe('invites', () => {
  test('permissions', async () => {
    assert.equal((await api(app, guest.token).post('/api/invites', {})).status, 403);
    // members can invite, but only as member
    const m = await api(app, member.token).post('/api/invites', { role: 'admin' });
    assert.equal(m.status, 200);
    assert.equal(m.body.role, 'member');
    assert.equal(m.body.createdBy, member.me.id);
    assert.ok(m.body.expiresAt > Date.now() + 29 * 86400_000);
    assert.equal((await api(app, member.token).get('/api/invites')).status, 403);
    assert.equal((await api(app, member.token).del(`/api/invites/${m.body.code}`)).status, 403);
  });

  test('list and delete as admin', async () => {
    const inv = await api(app, admin.token).post('/api/invites', { role: 'guest', maxUses: 5, expiresInDays: 2 });
    assert.equal(inv.body.role, 'guest');
    assert.equal(inv.body.maxUses, 5);
    const list = await api(app, admin.token).get('/api/invites');
    assert.ok(list.body.some((i: any) => i.code === inv.body.code));
    assert.equal((await api(app, admin.token).del(`/api/invites/${inv.body.code}`)).status, 200);
    const list2 = await api(app, admin.token).get('/api/invites');
    assert.ok(!list2.body.some((i: any) => i.code === inv.body.code));
    assert.equal((await api(app, admin.token).post('/api/invites', { email: 'not-an-email' })).status, 400);
  });
});

describe('custom emoji', () => {
  test('upload, serve and delete with permissions', async () => {
    assert.equal((await api(app, guest.token).upload('/api/emoji', [{ filename: 'p.png', content: png(), contentType: 'image/png' }], { name: 'party' })).status, 403);
    const bad = await api(app, member.token).upload('/api/emoji', [{ filename: 'p.txt', content: 'x', contentType: 'text/plain' }], { name: 'party' });
    assert.equal(bad.body.error, 'unsupported_image');
    const noName = await api(app, member.token).upload('/api/emoji', [{ filename: 'p.png', content: png(), contentType: 'image/png' }], { name: ':!!:' });
    assert.equal(noName.body.error, 'invalid_name');

    const r = await api(app, member.token).upload('/api/emoji', [{ filename: 'p.png', content: png(), contentType: 'image/png' }], { name: ':Party_Parrot:' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((e: any) => e.name), ['party_parrot']);
    assert.equal(r.body[0].url, '/api/emoji/party_parrot');
    assert.equal(r.body[0].createdBy, member.me.id);

    const dup = await api(app, admin.token).upload('/api/emoji', [{ filename: 'p.png', content: png(), contentType: 'image/png' }], { name: 'party_parrot' });
    assert.equal(dup.status, 409);

    const img = await api(app, guest.token).get('/api/emoji/party_parrot');
    assert.equal(img.status, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.equal((await api(app, guest.token).get('/api/emoji/unknown')).status, 404);

    const boot = await api(app, guest.token).get('/api/bootstrap');
    assert.equal(boot.body.customEmoji.length, 1);

    assert.equal((await api(app, guest.token).del('/api/emoji/party_parrot')).status, 403);
    assert.equal((await api(app, member.token).del('/api/emoji/nope')).status, 404);
    const del = await api(app, member.token).del('/api/emoji/party_parrot');
    assert.deepEqual(del.body, []);

    // admins can delete anybody's emoji
    await api(app, member.token).upload('/api/emoji', [{ filename: 'p.gif', content: gif(1, 1), contentType: 'image/gif' }], { name: 'wave' });
    assert.deepEqual((await api(app, admin.token).del('/api/emoji/wave')).body, []);
    assert.equal(fs.readdirSync(path.join(dataDir, 'uploads', 'emoji')).length, 0);
  });
});

describe('webhooks', () => {
  test('CRUD (admins only) and incoming posts', async () => {
    const boot = await api(app, owner.token).get('/api/bootstrap');
    const general = boot.body.channels.find((c: any) => c.name === 'general');
    assert.equal((await api(app, member.token).post('/api/webhooks', { name: 'CI', channelId: general.id })).status, 403);
    assert.equal((await api(app, member.token).get('/api/webhooks')).status, 403);
    assert.equal((await api(app, admin.token).post('/api/webhooks', { name: 'CI', channelId: 'NOPE' })).body.error, 'invalid_channel');
    const dm = await api(app, admin.token).post('/api/dms', { userIds: [member.me.id] });
    assert.equal((await api(app, admin.token).post('/api/webhooks', { name: 'CI', channelId: dm.body.channel.id })).body.error, 'invalid_channel');

    const hook = await api(app, admin.token).post('/api/webhooks', { name: 'CI', channelId: general.id });
    assert.equal(hook.status, 200);
    assert.equal(hook.body.name, 'CI');
    assert.match(hook.body.url, /\/api\/hooks\/[\w-]+$/);
    const list = await api(app, admin.token).get('/api/webhooks');
    assert.equal(list.body.length, 1);

    const hookPath = new URL(hook.body.url, 'http://x').pathname;
    const post = await api(app).post(hookPath, { text: 'Build *passed*', username: 'Jenkins' });
    assert.equal(post.status, 200);
    const post2 = await api(app).post(hookPath, { text: 'Default name' });
    assert.equal(post2.status, 200);
    assert.equal((await api(app).post(hookPath, { text: '' })).status, 400);
    assert.equal((await api(app).post('/api/hooks/wrong', { text: 'x' })).status, 404);

    const msgs = await api(app, member.token).get(`/api/channels/${general.id}/messages`);
    const bots = msgs.body.messages.filter((m: any) => m.subtype === 'bot');
    assert.deepEqual(
      bots.map((m: any) => [m.text, m.botName, m.userId]),
      [
        ['Build *passed*', 'Jenkins', null],
        ['Default name', 'CI', null],
      ],
    );

    // archived channel -> unavailable
    const ch = await api(app, admin.token).post('/api/channels', { name: 'ci-builds' });
    const hook2 = await api(app, admin.token).post('/api/webhooks', { name: 'CI2', channelId: ch.body.id });
    await api(app, admin.token).post(`/api/channels/${ch.body.id}/archive`);
    const res = await api(app).post(new URL(hook2.body.url, 'http://x').pathname, { text: 'x' });
    assert.equal(res.body.error, 'channel_unavailable');

    assert.equal((await api(app, admin.token).del(`/api/webhooks/${hook.body.id}`)).status, 200);
    assert.equal((await api(app).post(hookPath, { text: 'gone' })).status, 404);
  });
});
