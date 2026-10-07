import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { addUser, api, closeApp, createApp, png, setupOwner, type Session } from './helpers.ts';

let app: FastifyInstance;
let owner: Session;
let alice: Session;
let bob: Session;
let carol: Session;
let guest: Session;
let general: any;

before(async () => {
  ({ app } = await createApp());
  owner = await setupOwner(app);
  alice = await addUser(app, owner.token, { name: 'Alice', email: 'alice@example.com' });
  bob = await addUser(app, owner.token, { name: 'Bob', email: 'bob@example.com' });
  carol = await addUser(app, owner.token, { name: 'Carol', email: 'carol@example.com' });
  guest = await addUser(app, owner.token, { name: 'Gary Guest', email: 'gary@example.com', role: 'guest' });
  general = (await api(app, owner.token).get('/api/bootstrap')).body.channels.find((c: any) => c.name === 'general');
});
after(() => closeApp(app));

const send = (s: Session, channelId: string, text: string, extra: Record<string, unknown> = {}) => api(app, s.token).post(`/api/channels/${channelId}/messages`, { text, ...extra });

describe('create & browse', () => {
  test('names are normalised; duplicates conflict; guests cannot create', async () => {
    const r = await api(app, alice.token).post('/api/channels', { name: '  Project  X_Files!! ', description: 'about X' });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'project-x-files');
    assert.equal(r.body.kind, 'public');
    assert.equal(r.body.description, 'about X');
    assert.deepEqual(r.body.memberIds, [alice.me.id]);
    assert.equal(r.body.createdBy, alice.me.id);

    const dup = await api(app, bob.token).post('/api/channels', { name: 'PROJECT-X-files' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'name_taken');
    assert.equal((await api(app, bob.token).post('/api/channels', { name: '!!!' })).body.error, 'invalid_name');
    assert.equal((await api(app, guest.token).post('/api/channels', { name: 'guests' })).status, 403);
    assert.equal((await api(app, bob.token).post('/api/channels', {})).status, 400);
    const unicode = await api(app, bob.token).post('/api/channels', { name: 'Účetnictví 2024' });
    assert.equal(unicode.body.name, 'účetnictví-2024');
  });

  test('private channels with initial members are only visible to members', async () => {
    const r = await api(app, alice.token).post('/api/channels', { name: 'secret', isPrivate: true, memberIds: [bob.me.id, alice.me.id, 'UNKNOWN'] });
    assert.equal(r.body.kind, 'private');
    assert.deepEqual(r.body.memberIds.sort(), [alice.me.id, bob.me.id].sort());

    const browseCarol = await api(app, carol.token).get('/api/channels');
    assert.ok(!browseCarol.body.some((c: any) => c.name === 'secret'));
    assert.ok(browseCarol.body.some((c: any) => c.name === 'project-x-files'));
    const browseBob = await api(app, bob.token).get('/api/channels');
    assert.ok(browseBob.body.some((c: any) => c.name === 'secret'));

    assert.equal((await api(app, carol.token).get(`/api/channels/${r.body.id}`)).body.error, 'not_in_channel');
    // admins don't get to read private channels they are not in either
    assert.equal((await api(app, owner.token).get(`/api/channels/${r.body.id}/messages`)).status, 403);
    assert.equal((await api(app, carol.token).post(`/api/channels/${r.body.id}/join`)).body.error, 'cannot_join');
    const info = await api(app, bob.token).get(`/api/channels/${r.body.id}`);
    assert.equal(info.body.channel.name, 'secret');
    assert.equal(info.body.membership.channelId, r.body.id);
    // bob got an invite activity + a join message mentioning alice
    const act = await api(app, bob.token).get('/api/activity?filter=all');
    assert.ok(act.body.some((a: any) => a.kind === 'channel_invite' && a.channelId === r.body.id && a.actorId === alice.me.id));
    const msgs = await api(app, bob.token).get(`/api/channels/${r.body.id}/messages`);
    const join = msgs.body.messages.find((m: any) => m.subtype === 'join' && m.userId === bob.me.id);
    assert.equal(join.text, `<@${alice.me.id}>`);
  });

  test('public channel readable by non-members but not by guests', async () => {
    const ch = (await api(app, alice.token).get('/api/channels')).body.find((c: any) => c.name === 'project-x-files');
    assert.equal((await api(app, carol.token).get(`/api/channels/${ch.id}`)).status, 200);
    const info = await api(app, carol.token).get(`/api/channels/${ch.id}`);
    assert.equal(info.body.membership, null);
    assert.equal((await api(app, guest.token).get(`/api/channels/${ch.id}`)).status, 403);
    assert.equal((await api(app, carol.token).get('/api/channels/NOPE')).status, 404);
    const members = await api(app, carol.token).get(`/api/channels/${ch.id}/members`);
    assert.deepEqual(members.body, [alice.me.id]);
  });
});

describe('join & leave', () => {
  test('join public channel, leave it, cannot leave #general', async () => {
    const ch = (await api(app, alice.token).get('/api/channels')).body.find((c: any) => c.name === 'project-x-files');
    const j = await api(app, carol.token).post(`/api/channels/${ch.id}/join`);
    assert.equal(j.status, 200);
    assert.ok(j.body.channel.memberIds.includes(carol.me.id));
    assert.equal(j.body.membership.unread, 0);
    assert.equal((await api(app, guest.token).post(`/api/channels/${ch.id}/join`)).status, 403);
    assert.equal((await api(app, carol.token).post('/api/channels/NOPE/join')).status, 404);

    const l = await api(app, carol.token).post(`/api/channels/${ch.id}/leave`);
    assert.equal(l.status, 200);
    const msgs = await api(app, alice.token).get(`/api/channels/${ch.id}/messages`);
    assert.deepEqual(
      msgs.body.messages.filter((m: any) => m.userId === carol.me.id).map((m: any) => m.subtype),
      ['join', 'leave'],
    );
    assert.equal((await api(app, carol.token).post(`/api/channels/${ch.id}/leave`)).body.error, 'not_in_channel');
    const g = await api(app, carol.token).post(`/api/channels/${general.id}/leave`);
    assert.equal(g.body.error, 'cannot_leave_general');
  });
});

describe('direct messages', () => {
  test('find-or-create DM and group DM; hide and unhide', async () => {
    const a = api(app, alice.token);
    const dm = await a.post('/api/dms', { userIds: [bob.me.id] });
    assert.equal(dm.status, 200);
    assert.equal(dm.body.channel.kind, 'dm');
    assert.deepEqual(dm.body.channel.memberIds.sort(), [alice.me.id, bob.me.id].sort());
    const again = await api(app, bob.token).post('/api/dms', { userIds: [alice.me.id] });
    assert.equal(again.body.channel.id, dm.body.channel.id);

    const self = await a.post('/api/dms', { userIds: [] });
    assert.equal(self.body.channel.kind, 'dm');
    assert.deepEqual(self.body.channel.memberIds, [alice.me.id]);

    const group = await a.post('/api/dms', { userIds: [bob.me.id, carol.me.id] });
    assert.equal(group.body.channel.kind, 'group');
    assert.equal(group.body.channel.memberCount, 3);
    assert.equal((await a.post('/api/dms', { userIds: ['UNKNOWN'] })).body.error, 'invalid_user');

    // no join messages in DMs
    const msgs = await a.get(`/api/channels/${dm.body.channel.id}/messages`);
    assert.equal(msgs.body.messages.length, 0);

    // "leaving" a DM hides it
    assert.equal((await a.post(`/api/channels/${dm.body.channel.id}/leave`)).status, 200);
    let mem = (await a.get(`/api/channels/${dm.body.channel.id}`)).body.membership;
    assert.equal(mem.hidden, true);
    // re-opening unhides it
    const reopen = await a.post('/api/dms', { userIds: [bob.me.id] });
    assert.equal(reopen.body.membership.hidden, false);
    // a new message from the other side unhides it as well
    await a.put(`/api/channels/${dm.body.channel.id}/prefs`, { hidden: true });
    await send(bob, dm.body.channel.id, 'ping');
    mem = (await a.get(`/api/channels/${dm.body.channel.id}`)).body.membership;
    assert.equal(mem.hidden, false);
    assert.equal(mem.unread, 1);

    // DMs cannot be renamed or get members
    assert.equal((await a.patch(`/api/channels/${dm.body.channel.id}`, { name: 'x' })).body.error, 'cannot_rename_dm');
    assert.equal((await a.post(`/api/channels/${dm.body.channel.id}/members`, { userIds: [carol.me.id] })).body.error, 'cannot_add_to_dm');
    assert.equal((await a.del(`/api/channels/${dm.body.channel.id}/members/${bob.me.id}`)).body.error, 'cannot_remove_from_dm');
    assert.equal((await a.post(`/api/channels/${dm.body.channel.id}/archive`)).status, 403);
    assert.equal((await api(app, owner.token).del(`/api/channels/${dm.body.channel.id}`)).status, 403);
  });

  test('dms/latest lists the newest message per DM', async () => {
    const dm = (await api(app, carol.token).post('/api/dms', { userIds: [bob.me.id] })).body.channel;
    await send(carol, dm.id, 'first');
    await send(bob, dm.id, 'second');
    const r = await api(app, carol.token).get('/api/dms/latest');
    const latest = r.body.find((m: any) => m.channelId === dm.id);
    assert.equal(latest.text, 'second');
    assert.ok(!r.body.some((m: any) => m.channelId === general.id));
  });
});

describe('edit channel', () => {
  test('rename/topic/description post system messages; permissions', async () => {
    const ch = (await api(app, alice.token).post('/api/channels', { name: 'edit-me' })).body;
    await api(app, bob.token).post(`/api/channels/${ch.id}/join`);
    assert.equal((await api(app, bob.token).patch(`/api/channels/${ch.id}`, { name: 'bobs' })).status, 403);
    assert.equal((await api(app, carol.token).patch(`/api/channels/${ch.id}`, { topic: 'x' })).body.error, 'not_in_channel');

    const r = await api(app, alice.token).patch(`/api/channels/${ch.id}`, { name: 'Edited Name' });
    assert.equal(r.body.name, 'edited-name');
    assert.equal((await api(app, alice.token).patch(`/api/channels/${ch.id}`, { name: 'general' })).status, 409);
    assert.equal((await api(app, alice.token).patch(`/api/channels/${ch.id}`, { name: '***' })).body.error, 'invalid_name');
    // same name: no system message
    await api(app, alice.token).patch(`/api/channels/${ch.id}`, { name: 'edited-name' });

    // any member may set topic/description
    const t = await api(app, bob.token).patch(`/api/channels/${ch.id}`, { topic: 'New topic', description: 'New desc' });
    assert.equal(t.body.topic, 'New topic');
    assert.equal(t.body.description, 'New desc');
    await api(app, bob.token).patch(`/api/channels/${ch.id}`, { topic: 'New topic' }); // unchanged -> no message

    const msgs = (await api(app, alice.token).get(`/api/channels/${ch.id}/messages`)).body.messages;
    assert.deepEqual(
      msgs.filter((m: any) => ['rename', 'topic', 'description'].includes(m.subtype)).map((m: any) => [m.subtype, m.text]),
      [
        ['rename', 'edited-name'],
        ['topic', 'New topic'],
        ['description', 'New desc'],
      ],
    );
    // isDefault is admin-only and public-only
    assert.equal((await api(app, alice.token).patch(`/api/channels/${ch.id}`, { isDefault: true })).status, 403);
    await api(app, owner.token).post(`/api/channels/${ch.id}/join`);
    const def = await api(app, owner.token).patch(`/api/channels/${ch.id}`, { isDefault: true });
    assert.equal(def.body.isDefault, true);
    // new users join default channels
    const newbie = await addUser(app, owner.token);
    const boot = await api(app, newbie.token).get('/api/bootstrap');
    assert.ok(boot.body.channels.some((c: any) => c.id === ch.id));
    await api(app, owner.token).patch(`/api/channels/${ch.id}`, { isDefault: false });
  });
});

describe('archive & delete', () => {
  test('archive/unarchive by creator or admin', async () => {
    const ch = (await api(app, alice.token).post('/api/channels', { name: 'archive-me', memberIds: [bob.me.id] })).body;
    assert.equal((await api(app, bob.token).post(`/api/channels/${ch.id}/archive`)).status, 403);
    const a = await api(app, alice.token).post(`/api/channels/${ch.id}/archive`);
    assert.equal(a.body.archived, true);
    // archived: no posting, no joining, no adding
    assert.equal((await send(bob, ch.id, 'hello')).body.error, 'channel_archived');
    assert.equal((await api(app, carol.token).post(`/api/channels/${ch.id}/join`)).body.error, 'channel_archived');
    assert.equal((await api(app, alice.token).post(`/api/channels/${ch.id}/members`, { userIds: [carol.me.id] })).body.error, 'channel_archived');

    assert.equal((await api(app, bob.token).post(`/api/channels/${ch.id}/unarchive`)).status, 403);
    assert.equal((await api(app, bob.token).post('/api/channels/NOPE/unarchive')).status, 404);
    const u = await api(app, owner.token).post(`/api/channels/${ch.id}/unarchive`);
    assert.equal(u.body.archived, false);
    const subtypes = (await api(app, bob.token).get(`/api/channels/${ch.id}/messages`)).body.messages.map((m: any) => m.subtype);
    assert.ok(subtypes.includes('archive') && subtypes.includes('unarchive'));
    assert.equal((await api(app, owner.token).post(`/api/channels/${general.id}/archive`)).body.error, 'cannot_archive_general');
  });

  test('delete is admin only and cleans up', async () => {
    const ch = (await api(app, alice.token).post('/api/channels', { name: 'delete-me', memberIds: [bob.me.id] })).body;
    await send(alice, ch.id, 'hi');
    await api(app, alice.token).put('/api/drafts', { channelId: ch.id, text: 'draft' });
    assert.equal((await api(app, alice.token).del(`/api/channels/${ch.id}`)).status, 403);
    assert.equal((await api(app, owner.token).del('/api/channels/NOPE')).status, 404);
    assert.equal((await api(app, owner.token).del(`/api/channels/${general.id}`)).body.error, 'cannot_delete_general');
    assert.equal((await api(app, owner.token).del(`/api/channels/${ch.id}`)).status, 200);
    assert.equal((await api(app, alice.token).get(`/api/channels/${ch.id}`)).status, 404);
    const boot = await api(app, alice.token).get('/api/bootstrap');
    assert.ok(!boot.body.drafts.some((d: any) => d.channelId === ch.id));
  });
});

describe('members', () => {
  test('add and remove with permissions', async () => {
    const ch = (await api(app, alice.token).post('/api/channels', { name: 'members-test', isPrivate: true })).body;
    assert.equal((await api(app, bob.token).post(`/api/channels/${ch.id}/members`, { userIds: [bob.me.id] })).status, 403);
    const add = await api(app, alice.token).post(`/api/channels/${ch.id}/members`, { userIds: [bob.me.id, guest.me.id] });
    assert.deepEqual(add.body.memberIds.sort(), [alice.me.id, bob.me.id, guest.me.id].sort());
    assert.equal((await api(app, alice.token).post(`/api/channels/${ch.id}/members`, { userIds: [] })).status, 400);
    // guests in a channel can read but not add people
    assert.equal((await api(app, guest.token).get(`/api/channels/${ch.id}/messages`)).status, 200);
    assert.equal((await api(app, guest.token).post(`/api/channels/${ch.id}/members`, { userIds: [carol.me.id] })).status, 403);
    // bob may not remove others but can remove himself
    assert.equal((await api(app, bob.token).del(`/api/channels/${ch.id}/members/${guest.me.id}`)).status, 403);
    const self = await api(app, bob.token).del(`/api/channels/${ch.id}/members/${bob.me.id}`);
    assert.ok(!self.body.memberIds.includes(bob.me.id));
    // after leaving a private channel it is unreadable
    assert.equal((await api(app, bob.token).get(`/api/channels/${ch.id}/messages`)).status, 403);
    // creator removes others
    const rm = await api(app, alice.token).del(`/api/channels/${ch.id}/members/${guest.me.id}`);
    assert.deepEqual(rm.body.memberIds, [alice.me.id]);
    assert.equal((await api(app, owner.token).del(`/api/channels/${general.id}/members/${bob.me.id}`)).body.error, 'cannot_leave_general');
    // deactivated users are skipped
    const d = await addUser(app, owner.token);
    await api(app, owner.token).patch(`/api/users/${d.me.id}`, { deactivated: true });
    const add2 = await api(app, alice.token).post(`/api/channels/${ch.id}/members`, { userIds: [d.me.id] });
    assert.ok(!add2.body.memberIds.includes(d.me.id));
  });
});

describe('read markers, unread and mentions', () => {
  test('unread and mention counts follow the read marker', async () => {
    const ch = (await api(app, alice.token).post('/api/channels', { name: 'counting', memberIds: [bob.me.id, carol.me.id] })).body;
    const m1 = (await send(alice, ch.id, 'one')).body;
    await send(alice, ch.id, `hey <@${bob.me.id}>`);
    const m3 = (await send(alice, ch.id, 'three')).body;
    // a mention of a non-member doesn't count
    await send(alice, ch.id, `<@${owner.me.id}> you are not here`);

    let mem = (await api(app, bob.token).get(`/api/channels/${ch.id}`)).body.membership;
    assert.equal(mem.unread, 4);
    assert.equal(mem.mentions, 1);
    const boot = await api(app, bob.token).get('/api/bootstrap');
    assert.equal(boot.body.memberships.find((m: any) => m.channelId === ch.id).mentions, 1);
    assert.ok(boot.body.activityUnread >= 1);

    // own messages are never unread
    mem = (await api(app, alice.token).get(`/api/channels/${ch.id}`)).body.membership;
    assert.equal(mem.unread, 0);

    const r = await api(app, bob.token).put(`/api/channels/${ch.id}/read`, { messageId: m3.id });
    assert.equal(r.body.unread, 1);
    assert.equal(r.body.mentions, 0);
    const acts = await api(app, bob.token).get('/api/activity?filter=mentions');
    assert.equal(acts.body.find((a: any) => a.channelId === ch.id).read, true);

    // moving the marker back makes the mention unread again
    const back = await api(app, bob.token).put(`/api/channels/${ch.id}/read`, { messageId: m1.id });
    assert.equal(back.body.unread, 3);
    assert.equal(back.body.mentions, 1);
    assert.equal((await api(app, bob.token).put(`/api/channels/${ch.id}/read`, { messageId: -1 })).status, 400);
    assert.equal((await api(app, owner.token).put(`/api/channels/${ch.id}/read`, { messageId: 1 })).status, 403);
  });

  test('@channel / @everyone mention every member', async () => {
    const ch = (await api(app, alice.token).post('/api/channels', { name: 'broadcast', memberIds: [bob.me.id, carol.me.id] })).body;
    await send(alice, ch.id, 'listen up <!channel>');
    for (const s of [bob, carol]) {
      const mem = (await api(app, s.token).get(`/api/channels/${ch.id}`)).body.membership;
      assert.equal(mem.mentions, 1);
    }
    // @here only reaches people who are online (nobody here)
    await send(alice, ch.id, 'anyone <!here>');
    assert.equal((await api(app, bob.token).get(`/api/channels/${ch.id}`)).body.membership.mentions, 1);
  });

  test('channel prefs: star, mute, notify, hidden', async () => {
    const p = await api(app, bob.token).put(`/api/channels/${general.id}/prefs`, { starred: true, muted: true, notify: 'mentions', hidden: false });
    assert.equal(p.body.starred, true);
    assert.equal(p.body.muted, true);
    assert.equal(p.body.notify, 'mentions');
    assert.equal(p.body.hidden, false);
    const p2 = await api(app, bob.token).put(`/api/channels/${general.id}/prefs`, { starred: false, muted: false });
    assert.equal(p2.body.starred, false);
    assert.equal(p2.body.muted, false);
    assert.equal(p2.body.notify, 'mentions');
    assert.equal((await api(app, bob.token).put(`/api/channels/${general.id}/prefs`, { notify: 'loud' })).status, 400);
  });
});

describe('channel content lists', () => {
  test('pins, files, links and message-at', async () => {
    const ch = (await api(app, alice.token).post('/api/channels', { name: 'content', memberIds: [bob.me.id] })).body;
    await new Promise((r) => setTimeout(r, 5)); // the join message must be strictly older than t0
    const t0 = Date.now();
    const m1 = (await send(alice, ch.id, 'see https://example.com/a and <https://example.org/b|Example B>, plus https://example.com/a again')).body;
    const m2 = (await send(bob, ch.id, 'code ```https://hidden.example``` and https://example.net/c.')).body;

    // pins
    await api(app, bob.token).post(`/api/messages/${m1.id}/pin`);
    const pins = await api(app, carol.token).get(`/api/channels/${ch.id}/pins`);
    assert.deepEqual(pins.body.map((m: any) => m.id), [m1.id]);
    assert.equal(pins.body[0].pinnedBy, bob.me.id);

    // files
    const up = await api(app, alice.token).upload('/api/files', [{ filename: 'pic.png', content: png(5, 6), contentType: 'image/png' }]);
    const unattached = await api(app, alice.token).get(`/api/channels/${ch.id}/files`);
    assert.equal(unattached.body.length, 0);
    await send(alice, ch.id, '', { fileIds: [up.body[0].id] });
    const files = await api(app, carol.token).get(`/api/channels/${ch.id}/files`);
    assert.equal(files.body.length, 1);
    assert.equal(files.body[0].name, 'pic.png');
    assert.equal(files.body[0].width, 5);
    assert.equal(files.body[0].height, 6);

    // links
    const links = await api(app, carol.token).get(`/api/channels/${ch.id}/links`);
    assert.deepEqual(
      links.body.map((l: any) => [l.url, l.title, l.messageId]),
      [
        ['https://example.net/c', null, m2.id],
        ['https://example.com/a', null, m1.id],
        ['https://example.org/b', 'Example B', m1.id],
      ],
    );
    assert.deepEqual((await api(app, guest.token).get(`/api/channels/${ch.id}/links`)).body, []);

    // message-at
    const at = await api(app, bob.token).get(`/api/channels/${ch.id}/message-at?ts=${t0}`);
    assert.equal(at.body.id, m1.id);
    const future = await api(app, bob.token).get(`/api/channels/${ch.id}/message-at?ts=${Date.now() + 86400_000}`);
    assert.ok(future.body.id >= m2.id); // falls back to the latest message
    assert.equal((await api(app, bob.token).get(`/api/channels/${ch.id}/message-at`)).status, 400);
    const empty = (await api(app, bob.token).post('/api/dms', { userIds: [guest.me.id] })).body.channel;
    assert.equal((await api(app, bob.token).get(`/api/channels/${empty.id}/message-at?ts=0`)).body.id, null);
  });
});
