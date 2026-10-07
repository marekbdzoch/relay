import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { addUser, api, closeApp, createApp, setupOwner, type Session } from './helpers.ts';

let app: FastifyInstance;
let owner: Session;
let alice: Session;
let bob: Session;
let guest: Session;
let pub: any;
let priv: any;
let dm: any;
let db: typeof import('../src/db.ts');
const ids: Record<string, number> = {};

const search = async (s: Session, q: string, extra = '') => {
  const r = await api(app, s.token).get(`/api/search?q=${encodeURIComponent(q)}${extra}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const texts = (r: any) => r.messages.map((m: any) => m.text).sort();

before(async () => {
  ({ app } = await createApp());
  db = await import('../src/db.ts');
  owner = await setupOwner(app);
  alice = await addUser(app, owner.token, { name: 'Alice Anders', email: 'alice@example.com' });
  bob = await addUser(app, owner.token, { name: 'Bob Builder', email: 'bob@example.com' });
  guest = await addUser(app, owner.token, { name: 'Gwen Guest', email: 'gwen@example.com', role: 'guest' });
  await api(app, bob.token).patch('/api/users/me', { title: 'Plumbing specialist' });
  pub = (await api(app, alice.token).post('/api/channels', { name: 'engineering', description: 'Builds and deploys', memberIds: [bob.me.id] })).body;
  priv = (await api(app, alice.token).post('/api/channels', { name: 'secret-plans', isPrivate: true })).body;
  dm = (await api(app, alice.token).post('/api/dms', { userIds: [bob.me.id] })).body.channel;
  const post = async (s: Session, ch: string, key: string, text: string, extra: Record<string, unknown> = {}) => {
    ids[key] = (await api(app, s.token).post(`/api/channels/${ch}/messages`, { text, ...extra })).body.id;
  };
  await post(alice, pub.id, 'deploy', 'Deploying the Kubernetes cluster tonight');
  await post(bob, pub.id, 'cafe', 'Kávu si dáme v kavárně na náměstí');
  await post(alice, priv.id, 'secret', 'The secret Kubernetes migration plan');
  await post(bob, dm.id, 'dm', 'Private kubernetes chat in DM');
  await post(alice, pub.id, 'link', 'Docs at https://kubernetes.io/docs');
  await post(bob, pub.id, 'reply', 'Kubernetes reply in thread', { threadRootId: ids.deploy });
  await api(app, bob.token).post(`/api/messages/${ids.link}/pin`);
  const up = await api(app, alice.token).upload('/api/files', [{ filename: 'kubernetes-diagram.txt', content: 'k8s', contentType: 'text/plain' }]);
  await post(alice, pub.id, 'file', 'see attachment', { fileIds: [up.body[0].id] });
  const up2 = await api(app, alice.token).upload('/api/files', [{ filename: 'kubernetes-secret.txt', content: 'k8s', contentType: 'text/plain' }]);
  await post(alice, priv.id, 'privfile', 'private attachment', { fileIds: [up2.body[0].id] });
  // a system message never matches
  await api(app, alice.token).patch(`/api/channels/${pub.id}`, { topic: 'kubernetes topic' });
});
after(() => closeApp(app));

describe('message search', () => {
  test('full text, prefix matching and permissions', async () => {
    const r = await search(alice, 'kubern');
    assert.deepEqual(texts(r), [
      'Deploying the Kubernetes cluster tonight',
      'Docs at https://kubernetes.io/docs',
      'Kubernetes reply in thread',
      'Private kubernetes chat in DM',
      'The secret Kubernetes migration plan',
    ]);
    assert.equal(r.total, 5);
    // bob is not in the private channel; owner sees neither the private channel nor the DM
    assert.ok(!texts(await search(bob, 'kubernetes')).includes('The secret Kubernetes migration plan'));
    const ownerRes = await search(owner, 'kubernetes');
    assert.deepEqual(texts(ownerRes), ['Deploying the Kubernetes cluster tonight', 'Docs at https://kubernetes.io/docs', 'Kubernetes reply in thread']);
    // guests only see channels they belong to
    assert.equal((await search(guest, 'kubernetes')).messages.length, 0);
  });

  test('diacritics-insensitive matching', async () => {
    assert.deepEqual(texts(await search(alice, 'kavarne namesti')), ['Kávu si dáme v kavárně na náměstí']);
    assert.deepEqual(texts(await search(alice, 'KAVÁRNĚ')), ['Kávu si dáme v kavárně na náměstí']);
  });

  test('special characters are not FTS syntax errors', async () => {
    const r = await search(alice, '"kubernetes* (cluster) ^tonight:');
    assert.deepEqual(texts(r), ['Deploying the Kubernetes cluster tonight']);
    assert.equal((await search(alice, '***')).messages.length, 0);
  });

  test('in: / from: modifiers', async () => {
    assert.deepEqual(texts(await search(alice, 'kubernetes in:#secret-plans')), ['The secret Kubernetes migration plan']);
    assert.deepEqual(texts(await search(alice, 'kubernetes in:engineering')), ['Deploying the Kubernetes cluster tonight', 'Docs at https://kubernetes.io/docs', 'Kubernetes reply in thread']);
    // a private channel you're not in never leaks
    assert.equal((await search(bob, 'kubernetes in:#secret-plans')).messages.length, 0);
    assert.equal((await search(alice, 'kubernetes in:#nonexistent')).messages.length, 0);
    assert.deepEqual(texts(await search(alice, `kubernetes in:@${bob.me.username}`)), ['Private kubernetes chat in DM']);
    assert.equal((await search(owner, `kubernetes in:@${bob.me.username}`)).messages.length, 0);
    // an unknown person must not widen the search to everything
    assert.equal((await search(alice, 'kubernetes in:@nobody')).messages.length, 0);
    assert.deepEqual(texts(await search(alice, `kubernetes from:@${bob.me.username}`)), ['Kubernetes reply in thread', 'Private kubernetes chat in DM']);
    assert.equal((await search(alice, 'kubernetes from:@nobody')).messages.length, 0);
    // modifiers alone (no text) list everything that matches them, newest first
    const fromBob = await search(alice, `from:${bob.me.username}`);
    assert.equal(fromBob.messages[0].text, 'Kubernetes reply in thread');
    assert.equal(fromBob.total, 3);
  });

  test('before: / after: / on: date modifiers', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    assert.equal((await search(alice, `kubernetes before:${tomorrow}`)).total, 5);
    assert.equal((await search(alice, `kubernetes before:${yesterday}`)).total, 0);
    assert.equal((await search(alice, `kubernetes after:${yesterday}`)).total, 5);
    assert.equal((await search(alice, `kubernetes after:${today}`)).total, 0);
    assert.equal((await search(alice, `kubernetes on:${today}`)).total, 5);
    // unparsable dates are ignored
    assert.equal((await search(alice, 'kubernetes before:someday')).total, 5);
  });

  test('is: / has: modifiers', async () => {
    assert.deepEqual(texts(await search(alice, 'kubernetes is:thread')), ['Deploying the Kubernetes cluster tonight', 'Kubernetes reply in thread']);
    assert.deepEqual(texts(await search(alice, 'has:pin')), ['Docs at https://kubernetes.io/docs']);
    assert.deepEqual(texts(await search(alice, 'has:link')), ['Docs at https://kubernetes.io/docs']);
    assert.deepEqual(texts(await search(alice, 'has:file')), ['private attachment', 'see attachment']);
    assert.deepEqual(texts(await search(bob, 'has:files')), ['see attachment']);
  });

  test('sorting and paging', async () => {
    const newest = await search(alice, 'kubernetes', '&sort=newest');
    const oldest = await search(alice, 'kubernetes', '&sort=oldest');
    assert.deepEqual(
      newest.messages.map((m: any) => m.id),
      [...oldest.messages.map((m: any) => m.id)].reverse(),
    );
    const page = await search(alice, 'kubernetes', '&sort=oldest&limit=2&offset=2');
    assert.deepEqual(page.messages.map((m: any) => m.id), oldest.messages.slice(2, 4).map((m: any) => m.id));
    assert.equal(page.total, 5);
    const rel = await search(alice, 'kubernetes', '&sort=relevance&type=messages');
    assert.equal(rel.messages.length, 5);
    assert.deepEqual(rel.channels, []);
    assert.equal((await api(app, alice.token).get('/api/search?q=x&limit=1000')).status, 400);
  });
});

describe('files, channels and people results', () => {
  test('files are searched by name with permissions', async () => {
    const r = await search(alice, 'kubernetes', '&type=files');
    assert.deepEqual(r.files.map((f: any) => f.name).sort(), ['kubernetes-diagram.txt', 'kubernetes-secret.txt']);
    assert.deepEqual(r.messages, []);
    const b = await search(bob, 'diagram');
    assert.deepEqual(b.files.map((f: any) => f.name), ['kubernetes-diagram.txt']);
    assert.deepEqual((await search(bob, 'secret', '&type=files')).files, []);
  });

  test('channels by name/topic/description; private only for members', async () => {
    assert.deepEqual((await search(bob, 'deploys', '&type=channels')).channels.map((c: any) => c.name), ['engineering']);
    assert.deepEqual((await search(alice, 'secret')).channels.map((c: any) => c.name), ['secret-plans']);
    assert.deepEqual((await search(bob, 'secret')).channels, []);
    assert.deepEqual((await search(guest, 'engineering', '&type=channels')).channels, []);
  });

  test('people by name, username and title', async () => {
    assert.deepEqual((await search(alice, 'builder', '&type=people')).users.map((u: any) => u.id), [bob.me.id]);
    assert.deepEqual((await search(alice, 'plumbing', '&type=people')).users.map((u: any) => u.id), [bob.me.id]);
    assert.deepEqual((await search(alice, 'alice', '&type=people')).users.map((u: any) => u.id), [alice.me.id]);
    assert.equal((await search(alice, 'alice', '&type=people')).users[0].email, undefined);
  });

  test('edits and deletes update the index', async () => {
    await api(app, alice.token).patch(`/api/messages/${ids.deploy}`, { text: 'Deploying the Nomad cluster tonight' });
    assert.deepEqual(texts(await search(alice, 'nomad')), ['Deploying the Nomad cluster tonight']);
    await api(app, bob.token).del(`/api/messages/${ids.cafe}`);
    assert.deepEqual((await search(alice, 'kavarne')).messages, []);
    // fts row removal on hard delete
    db.run('DELETE FROM messages WHERE id = ?', ids.cafe);
    assert.equal((await search(alice, 'kavarne')).total, 0);
  });
});
