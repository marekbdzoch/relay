import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { OWNER, addUser, api, closeApp, createApp, type Session } from './helpers.ts';

let app: FastifyInstance;
let owner: Session;

before(async () => {
  ({ app } = await createApp({ SETUP_TOKEN: 'k7m2x9pq' }));
});
after(() => closeApp(app));

describe('setup code', () => {
  test('status tells the client a setup code is needed', async () => {
    const r = await api(app).get('/api/setup/status');
    assert.equal(r.body.setupCodeRequired, true);
  });

  test('setup without or with a wrong code is refused', async () => {
    assert.equal((await api(app).post('/api/setup', OWNER)).body.error, 'invalid_setup_code');
    const wrong = await api(app).post('/api/setup', { ...OWNER, setupCode: 'nope' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error, 'invalid_setup_code');
  });

  test('setup with the right code works and leaves the wizard pending', async () => {
    const r = await api(app).post('/api/setup', { ...OWNER, setupCode: ' k7m2x9pq ' });
    assert.equal(r.status, 200);
    owner = r.body;
    const boot = await api(app, owner.token).get('/api/bootstrap');
    assert.equal(boot.body.workspace.onboardingPending, true);
    assert.equal((await api(app).get('/api/setup/status')).body.setupCodeRequired, false);
  });
});

describe('onboarding wizard', () => {
  let member: Session;

  before(async () => {
    member = await addUser(app, owner.token, { name: 'Early Member' });
  });

  test('members cannot use the wizard routes', async () => {
    assert.equal((await api(app, member.token).post('/api/onboarding/channels', { channels: [] })).status, 403);
    assert.equal((await api(app, member.token).post('/api/onboarding/complete')).status, 403);
  });

  test('creates channels, reuses existing ones and builds default sections for everyone', async () => {
    const r = await api(app, owner.token).post('/api/onboarding/channels', {
      channels: [
        { name: 'general', section: 'Company', everyone: true },
        { name: 'Oznámení', description: 'News', section: 'Company', everyone: true },
        { name: 'marketing', section: 'Teams' },
        { name: 'hr', section: 'Teams', isPrivate: true, everyone: true },
        { name: 'loose' },
      ],
      sections: [
        { name: 'Company', emoji: '🏢' },
        { name: 'Teams', emoji: '👥' },
        { name: 'Empty' },
      ],
    });
    assert.equal(r.status, 200);
    const names = r.body.channels.map((c: any) => c.name);
    assert.deepEqual(names, ['general', 'oznámení', 'marketing', 'hr', 'loose']);
    const byName = Object.fromEntries(r.body.channels.map((c: any) => [c.name, c]));
    assert.equal(byName.hr.kind, 'private');
    assert.equal(byName['oznámení'].isDefault, true);
    assert.equal(byName.hr.isDefault, false, 'private channels are never auto-joined');
    assert.equal(byName.marketing.description, '');

    const sections = r.body.sections;
    assert.deepEqual(
      sections.map((s: any) => [s.name, s.emoji, s.channelIds.length]),
      [
        ['Company', '🏢', 2],
        ['Teams', '👥', 2],
        ['Empty', '', 0],
      ],
    );

    // the existing member was added to the "everyone" channel and got the sections
    const mine = (await api(app, member.token).get('/api/bootstrap')).body;
    assert.ok(mine.memberships.some((m: any) => m.channelId === byName['oznámení'].id));
    assert.ok(!mine.memberships.some((m: any) => m.channelId === byName.marketing.id));
    assert.deepEqual(
      mine.me.prefs.sidebarSections.map((s: any) => s.name),
      ['Company', 'Teams', 'Empty'],
    );
  });

  test('running it again merges into the same sections instead of duplicating them', async () => {
    const r = await api(app, owner.token).post('/api/onboarding/channels', {
      channels: [{ name: 'design', section: 'teams' }, { name: 'marketing', section: 'Company' }],
      sections: [{ name: 'teams' }, { name: 'Company' }],
    });
    const sections = r.body.sections;
    assert.equal(sections.length, 3);
    const teams = sections.find((s: any) => s.name === 'Teams');
    const company = sections.find((s: any) => s.name === 'Company');
    const ids = Object.fromEntries(r.body.channels.map((c: any) => [c.name, c.id]));
    assert.ok(teams.channelIds.includes(ids.design));
    // a channel lives in one section only: marketing moved from Teams to Company
    assert.ok(company.channelIds.includes(ids.marketing));
    assert.ok(!teams.channelIds.includes(ids.marketing));
    const mine = (await api(app, owner.token).get('/api/bootstrap')).body.me.prefs.sidebarSections;
    assert.ok(mine.find((s: any) => s.name === 'Company').channelIds.includes(ids.marketing));
    assert.ok(!mine.find((s: any) => s.name === 'Teams').channelIds.includes(ids.marketing));
  });

  test('people who join later get the "everyone" channels and the sections', async () => {
    const late = await addUser(app, owner.token, { name: 'Late Joiner' });
    const boot = (await api(app, late.token).get('/api/bootstrap')).body;
    const names = boot.memberships.map((m: any) => boot.channels.find((c: any) => c.id === m.channelId)?.name);
    assert.ok(names.includes('oznámení'));
    assert.ok(!names.includes('hr'));
    assert.deepEqual(
      boot.me.prefs.sidebarSections.map((s: any) => s.name),
      ['Company', 'Teams', 'Empty'],
    );
  });

  test('rejects invalid channel names', async () => {
    const r = await api(app, owner.token).post('/api/onboarding/channels', { channels: [{ name: '!!!' }] });
    assert.equal(r.status, 400);
  });

  test('completing the wizard clears the flag', async () => {
    const r = await api(app, owner.token).post('/api/onboarding/complete');
    assert.equal(r.status, 200);
    assert.equal(r.body.onboardingPending, false);
    assert.equal((await api(app, owner.token).get('/api/bootstrap')).body.workspace.onboardingPending, false);
  });
});
