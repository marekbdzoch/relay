import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapResponse, Message } from '../../shared/types.ts';
import * as A from './actions.ts';
import { ApiError, setToken } from './api.ts';
import { S, draftKey, set } from './store.ts';
import { setNavigate } from './lib/nav.ts';
import { setLanguage } from './i18n.ts';
import { connectSocket, disconnectSocket, emitTyping } from './socket.ts';
import { loadEmojiData } from './lib/emoji.ts';
import { bodyOf, jsonResponse, makeChannel, makeMe, makeMembership, makeMessage, makeUser, mockFetch, resetStore } from './test/helpers.ts';

vi.mock('./socket.ts', () => ({ connectSocket: vi.fn(), disconnectSocket: vi.fn(), emitTyping: vi.fn(), socket: null }));
vi.mock('./lib/emoji.ts', async (orig) => ({ ...(await orig<typeof import('./lib/emoji.ts')>()), loadEmojiData: vi.fn(async () => {}) }));
vi.mock('./api.ts', async (orig) => ({ ...(await orig<typeof import('./api.ts')>()), setToken: vi.fn() }));

const nav = vi.fn();
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0); // Wednesday

function seed() {
  resetStore({
    status: 'ready',
    me: makeMe({ id: 'U1', username: 'me', prefs: {} }),
    users: { U1: makeUser({ id: 'U1', username: 'me' }), U2: makeUser({ id: 'U2', username: 'jana', displayName: 'Jana' }) },
    channels: {
      C1: makeChannel({ id: 'C1', name: 'general' }),
      C2: makeChannel({ id: 'C2', name: 'secret', kind: 'private' }),
      D1: makeChannel({ id: 'D1', kind: 'dm', name: '', memberIds: ['U1', 'U2'] }),
    },
    memberships: {
      C1: makeMembership({ channelId: 'C1', lastRead: 10 }),
      C2: makeMembership({ channelId: 'C2' }),
      D1: makeMembership({ channelId: 'D1' }),
    },
  });
}

/** Puts a loaded channel with the given messages into the store. */
function loadedChannel(channelId: string, msgs: Message[], extra: Partial<ReturnType<typeof S>['chan'][string]> = {}) {
  set((s) => {
    for (const m of msgs) s.msgs[m.id] = m;
    s.chan[channelId] = { ids: msgs.map((m) => m.id), hasMoreBefore: false, hasMoreAfter: false, loading: false, loaded: true, ...extra };
  });
}

const lastToast = () => S().toasts.at(-1);
const page = (ids: number[], p: { hasMoreBefore?: boolean; hasMoreAfter?: boolean } = {}) => ({
  messages: ids.map((id) => makeMessage({ id, channelId: 'C1' })),
  hasMoreBefore: p.hasMoreBefore ?? false,
  hasMoreAfter: p.hasMoreAfter ?? false,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  nav.mockReset();
  setNavigate(nav);
  setLanguage('en');
  vi.mocked(connectSocket).mockClear();
  vi.mocked(disconnectSocket).mockClear();
  vi.mocked(emitTyping).mockClear();
  A.suppressAutoRead.clear();
  seed();
});

// ---------------------------------------------------------------------------

describe('errorMessage / fail', () => {
  it('maps known API error codes to friendly text', () => {
    expect(A.errorMessage(new ApiError(401, 'invalid_credentials', 'x'))).toBe('Wrong email or password.');
    expect(A.errorMessage(new ApiError(409, 'name_taken', 'x'))).toBe('A channel with that name already exists.');
    expect(A.errorMessage(new ApiError(0, 'network_error', 'x'))).toBe('Network error – check your connection.');
    expect(A.errorMessage(new ApiError(400, 'cannot_leave_general', 'x'))).toBe('Everyone stays in #general.');
  });

  it('translates the friendly text', () => {
    setLanguage('cs');
    expect(A.errorMessage(new ApiError(400, 'channel_archived', 'x'))).toBe('Tento kanál je archivovaný.');
  });

  it('falls back to the server message, error messages and strings', () => {
    expect(A.errorMessage(new ApiError(500, 'weird', 'Server says no'))).toBe('Server says no');
    expect(A.errorMessage(new Error('plain'))).toBe('plain');
    expect(A.errorMessage('text')).toBe('text');
    expect(A.errorMessage(42)).toBe('42');
  });

  it('every mapped code produces a non-empty message', () => {
    for (const code of ['email_taken', 'not_in_channel', 'file_too_large', 'invite_invalid', 'signup_not_allowed', 'username_taken', 'wrong_password', 'account_deactivated'])
      expect(A.errorMessage(new ApiError(400, code, 'raw'))).not.toBe('raw');
  });

  it('fail() shows an error toast but ignores aborted uploads', () => {
    A.fail(new ApiError(0, 'aborted', 'Upload cancelled'));
    expect(S().toasts).toEqual([]);
    A.fail(new Error('boom'));
    expect(lastToast()).toMatchObject({ text: 'boom', kind: 'error' });
  });
});

// ---------------------------------------------------------------------------

function bootstrap(p: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    me: makeMe({ id: 'U1', username: 'me', prefs: { language: 'cs', theme: 'whatever', colorMode: 'dark' } }),
    workspace: { name: 'Acme', iconUrl: null, allowedDomains: '', createdAt: 0, iceServers: [] },
    users: [makeUser({ id: 'U1' }), makeUser({ id: 'U2' })],
    channels: [makeChannel({ id: 'C1', name: 'general' })],
    memberships: [makeMembership({ channelId: 'C1', unread: 2, mentions: 1 })],
    presence: { U2: 'active' },
    savedIds: [5, 6],
    agents: [{ userId: 'U9', avatarEmoji: '🤖' } as any],
    drafts: [{ channelId: 'C1', threadRootId: null, text: 'draft', updatedAt: 1 }, { channelId: 'C1', threadRootId: 7, text: 'reply', updatedAt: 2 }],
    customEmoji: [{ name: 'parrot', url: '/e/p.gif', createdBy: 'U1' }],
    huddles: [{ channelId: 'C1', participants: [], startedAt: 1 }],
    activityUnread: 3,
    threadsUnread: 4,
    version: '1',
    ...p,
  };
}

describe('applyBootstrap', () => {
  afterEach(() => setLanguage('en'));

  it('indexes everything and becomes ready', () => {
    resetStore();
    A.applyBootstrap(bootstrap());
    const s = S();
    expect(s.status).toBe('ready');
    expect(s.me?.id).toBe('U1');
    expect(s.workspace?.name).toBe('Acme');
    expect(Object.keys(s.users)).toEqual(['U1', 'U2']);
    expect(s.channels.C1.name).toBe('general');
    expect(s.memberships.C1.unread).toBe(2);
    expect(s.presence).toEqual({ U2: 'active' });
    expect(s.saved).toEqual({ 5: true, 6: true });
    expect(Object.keys(s.drafts)).toEqual(['C1:0', 'C1:7']);
    expect(s.customEmoji).toEqual({ parrot: '/e/p.gif' });
    expect(s.customEmojiList).toHaveLength(1);
    expect(Object.keys(s.huddles)).toEqual(['C1']);
    expect(Object.keys(s.agents)).toEqual(['U9']);
    expect(s.activityUnread).toBe(3);
    expect(s.threadsUnread).toBe(4);
  });

  it('applies language, theme and the title badge', () => {
    A.applyBootstrap(bootstrap());
    expect(document.documentElement.lang).toBe('cs');
    expect(document.documentElement.dataset.mode).toBe('dark');
    expect(document.title).toBe('(1) Acme');
  });

  it('keeps the language when the user has no preference', () => {
    setLanguage('en');
    A.applyMePrefs(makeMe({ id: 'U1', prefs: {} }));
    expect(document.documentElement.lang).toBe('en');
  });
});

describe('boot', () => {
  it('shows the setup wizard on a fresh install', async () => {
    const f = mockFetch({ 'GET /api/setup/status': { needsSetup: true } });
    await A.boot();
    expect(S().status).toBe('setup');
    expect(f).toHaveBeenCalledTimes(1);
    expect(connectSocket).not.toHaveBeenCalled();
  });

  it('loads bootstrap and emoji data, then connects the socket', async () => {
    resetStore();
    mockFetch({ 'GET /api/setup/status': { needsSetup: false }, 'GET /api/bootstrap': bootstrap() });
    await A.boot();
    expect(S().status).toBe('ready');
    expect(loadEmojiData).toHaveBeenCalled();
    expect(connectSocket).toHaveBeenCalledTimes(1);
    setLanguage('en');
  });

  it('still boots when the emoji data fails to load', async () => {
    vi.mocked(loadEmojiData).mockRejectedValueOnce(new Error('chunk failed'));
    resetStore();
    mockFetch({ 'GET /api/setup/status': { needsSetup: false }, 'GET /api/bootstrap': bootstrap() });
    await A.boot();
    expect(S().status).toBe('ready');
    setLanguage('en');
  });

  it('goes to the login page on 401', async () => {
    mockFetch({ 'GET /api/setup/status': { needsSetup: false }, 'GET /api/bootstrap': () => jsonResponse({ error: 'not_authenticated' }, 401) });
    await A.boot();
    expect(S().status).toBe('unauth');
  });

  it('shows an error for other failures', async () => {
    mockFetch({ 'GET /api/setup/status': () => jsonResponse({ error: 'oops' }, 500) });
    await A.boot();
    expect(S().status).toBe('error');
  });

  it('loginSuccess stores the token and boots', async () => {
    mockFetch({ 'GET /api/setup/status': { needsSetup: true } });
    A.loginSuccess({ token: 'tok', me: makeMe({ id: 'U1' }) });
    expect(setToken).toHaveBeenCalledWith('tok');
    expect(S().status).toBe('loading');
    await vi.waitFor(() => expect(S().status).toBe('setup'));
  });
});

describe('logout', () => {
  it('logs out, clears the token and disconnects even if the request fails', async () => {
    const f = mockFetch({ 'POST /api/auth/logout': () => jsonResponse({}, 500) });
    const loc = { href: '/c/C1', origin: location.origin, pathname: '/c/C1' };
    vi.stubGlobal('location', loc);
    await A.logout();
    expect(loc.href).toBe('/login');
    expect(f).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
    expect(setToken).toHaveBeenCalledWith(null);
    expect(disconnectSocket).toHaveBeenCalled();
  });
});

describe('resync', () => {
  it('refreshes the active channel, drops other caches and reloads the open thread', async () => {
    loadedChannel('C1', [makeMessage({ id: 11 }), makeMessage({ id: 12 })]);
    loadedChannel('C2', [makeMessage({ id: 20, channelId: 'C2' })]);
    set((s) => {
      s.chan.D1 = { ids: [], hasMoreBefore: true, hasMoreAfter: false, loading: true, loaded: false };
      s.activeChannelId = 'C1';
      s.right = { type: 'thread', rootId: 11, channelId: 'C1' };
    });
    const f = mockFetch({
      'GET /api/bootstrap': bootstrap({ me: makeMe({ id: 'U1', prefs: {} }) }),
      'GET /api/channels/C1/messages*': page([13]),
      'GET /api/messages/11/thread': { root: makeMessage({ id: 11 }), replies: [], following: false, lastRead: 0 },
    });
    await A.resync();
    await vi.waitFor(() => expect(S().chan.C1.ids).toEqual([11, 12, 13]));
    const urls = f.mock.calls.map((c) => c[0]);
    expect(urls).toContain('/api/channels/C1/messages?limit=100&after=12');
    expect(urls).toContain('/api/messages/11/thread');
    expect(S().chan.C2).toBeUndefined();
    expect(S().chan.D1).toBeDefined();
  });

  it('swallows errors (the next reconnect retries)', async () => {
    mockFetch({ 'GET /api/bootstrap': () => jsonResponse({}, 503) });
    await expect(A.resync()).resolves.toBeUndefined();
    expect(S().toasts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('navigation & ui', () => {
  it('openChannel navigates to the channel path', () => {
    A.openChannel('C1');
    A.openChannel('C1', 99);
    expect(nav.mock.calls).toEqual([
      ['/c/C1', undefined],
      ['/c/C1/99', undefined],
    ]);
  });

  it('setRight / openProfile / openModal / confirmDialog', () => {
    A.openProfile('U2');
    expect(S().right).toEqual({ type: 'profile', userId: 'U2' });
    A.setRight(null);
    expect(S().right).toBeNull();
    A.openModal({ type: 'shortcuts' });
    expect(S().modal).toEqual({ type: 'shortcuts' });
    const onConfirm = vi.fn();
    A.confirmDialog({ title: 'T', body: 'B', onConfirm });
    expect(S().modal).toEqual({ type: 'confirm', title: 'T', body: 'B', onConfirm });
    A.openModal(null);
    expect(S().modal).toBeNull();
  });

  it('openThread shows the panel and loads the thread', async () => {
    mockFetch({ 'GET /api/messages/5/thread': { root: makeMessage({ id: 5 }), replies: [makeMessage({ id: 6, threadRootId: 5 })], following: true, lastRead: 6 } });
    A.openThread(5, 'C1', 6);
    expect(S().right).toEqual({ type: 'thread', rootId: 5, channelId: 'C1', highlightId: 6 });
    await vi.waitFor(() => expect(S().threads[5]).toEqual({ ids: [6], loaded: true, following: true, lastRead: 6 }));
  });
});

// ---------------------------------------------------------------------------

describe('loadChannel', () => {
  it('loads the latest page', async () => {
    const f = mockFetch({ 'GET /api/channels/C1/messages*': page([3, 1, 2], { hasMoreBefore: true }) });
    const p = A.loadChannel('C1');
    expect(S().chan.C1.loading).toBe(true);
    await p;
    expect(f.mock.calls[0][0]).toBe('/api/channels/C1/messages?limit=50');
    expect(S().chan.C1).toEqual({ ids: [1, 2, 3], hasMoreBefore: true, hasMoreAfter: false, loading: false, loaded: true });
    expect(S().msgs[2].id).toBe(2);
  });

  it('keeps pending messages at the bottom ordered by creation time', async () => {
    set((s) => {
      s.msgs[-5] = makeMessage({ id: -5, createdAt: 200 });
      s.msgs[-9] = makeMessage({ id: -9, createdAt: 100 });
      s.chan.C1 = { ids: [-5, -9], hasMoreBefore: true, hasMoreAfter: false, loading: false, loaded: false };
    });
    mockFetch({ 'GET /api/channels/C1/messages*': page([1, 2]) });
    await A.loadChannel('C1');
    expect(S().chan.C1.ids).toEqual([1, 2, -9, -5]);
  });

  it('does nothing while loading or when already loaded', async () => {
    const f = mockFetch({});
    set((s) => void (s.chan.C1 = { ids: [], hasMoreBefore: true, hasMoreAfter: false, loading: true, loaded: false }));
    await A.loadChannel('C1');
    loadedChannel('C2', [makeMessage({ id: 30, channelId: 'C2' })]);
    await A.loadChannel('C2');
    await A.loadChannel('C2', 30);
    expect(f).not.toHaveBeenCalled();
  });

  it('reloads around a message that is not loaded yet', async () => {
    loadedChannel('C1', [makeMessage({ id: 100 })]);
    const f = mockFetch({ 'GET /api/channels/C1/messages*': page([40, 41, 42], { hasMoreBefore: true, hasMoreAfter: true }) });
    await A.loadChannel('C1', 41);
    expect(f.mock.calls[0][0]).toBe('/api/channels/C1/messages?limit=50&around=41');
    expect(S().chan.C1).toMatchObject({ ids: [40, 41, 42], hasMoreAfter: true });
  });

  it('resets loading and toasts on failure', async () => {
    mockFetch({ 'GET /api/channels/C1/messages*': () => jsonResponse({ error: 'not_in_channel' }, 403) });
    await A.loadChannel('C1');
    expect(S().chan.C1).toMatchObject({ loading: false, loaded: false });
    expect(lastToast()).toMatchObject({ text: 'You are not a member of this channel.', kind: 'error' });
  });
});

describe('loadOlder', () => {
  it('prepends the previous page and de-duplicates', async () => {
    loadedChannel('C1', [makeMessage({ id: 10 }), makeMessage({ id: 11 })], { hasMoreBefore: true });
    const f = mockFetch({ 'GET /api/channels/C1/messages*': page([8, 9, 10]) });
    await A.loadOlder('C1');
    expect(f.mock.calls[0][0]).toBe('/api/channels/C1/messages?limit=50&before=10');
    expect(S().chan.C1).toMatchObject({ ids: [8, 9, 10, 11], hasMoreBefore: false, loading: false });
  });

  it('skips when unknown, loading, exhausted or only pending messages exist', async () => {
    const f = mockFetch({});
    await A.loadOlder('NOPE');
    loadedChannel('C1', [makeMessage({ id: 10 })], { hasMoreBefore: false });
    await A.loadOlder('C1');
    loadedChannel('C1', [makeMessage({ id: 10 })], { hasMoreBefore: true, loading: true });
    await A.loadOlder('C1');
    loadedChannel('C1', [makeMessage({ id: -1 })], { hasMoreBefore: true });
    await A.loadOlder('C1');
    expect(f).not.toHaveBeenCalled();
  });

  it('handles failures', async () => {
    loadedChannel('C1', [makeMessage({ id: 10 })], { hasMoreBefore: true });
    mockFetch({ 'GET /api/channels/C1/messages*': () => jsonResponse({ message: 'nope' }, 500) });
    await A.loadOlder('C1');
    expect(S().chan.C1.loading).toBe(false);
    expect(lastToast()?.text).toBe('nope');
  });
});

describe('loadNewer', () => {
  it('appends the next page after the last real message', async () => {
    loadedChannel('C1', [makeMessage({ id: 10 }), makeMessage({ id: 11 }), makeMessage({ id: -3 })], { hasMoreAfter: true });
    const f = mockFetch({ 'GET /api/channels/C1/messages*': page([12, 13], { hasMoreAfter: false }) });
    await A.loadNewer('C1');
    expect(f.mock.calls[0][0]).toBe('/api/channels/C1/messages?limit=100&after=11');
    expect(S().chan.C1).toMatchObject({ ids: [10, 11, 12, 13, -3], hasMoreAfter: false, loading: false });
  });

  it('skips unless there is more (or forced)', async () => {
    const f = mockFetch({ 'GET /api/channels/C1/messages*': page([]) });
    await A.loadNewer('NOPE');
    loadedChannel('C1', [makeMessage({ id: 10 })], { hasMoreAfter: false });
    await A.loadNewer('C1');
    loadedChannel('C1', [makeMessage({ id: 10 })], { hasMoreAfter: true, loading: true });
    await A.loadNewer('C1');
    expect(f).not.toHaveBeenCalled();
    await A.loadNewer('C1', 5, true);
    expect(f.mock.calls[0][0]).toBe('/api/channels/C1/messages?limit=100&after=5');
  });

  it('uses 0 when there is no real message yet', async () => {
    loadedChannel('C1', [], { hasMoreAfter: true });
    const f = mockFetch({ 'GET /api/channels/C1/messages*': page([1]) });
    await A.loadNewer('C1');
    expect(f.mock.calls[0][0]).toContain('after=0');
  });

  it('handles failures', async () => {
    loadedChannel('C1', [makeMessage({ id: 10 })], { hasMoreAfter: true });
    mockFetch({ 'GET /api/channels/C1/messages*': () => jsonResponse({ message: 'down' }, 500) });
    await A.loadNewer('C1');
    expect(S().chan.C1.loading).toBe(false);
    expect(lastToast()?.text).toBe('down');
  });
});

describe('jumpToPresent', () => {
  it('drops the cached window and reloads the latest page', async () => {
    loadedChannel('C1', [makeMessage({ id: 3 })], { hasMoreAfter: true });
    mockFetch({ 'GET /api/channels/C1/messages*': page([90, 91]) });
    await A.jumpToPresent('C1');
    expect(S().chan.C1.ids).toEqual([90, 91]);
  });
});

// ---------------------------------------------------------------------------

describe('receiveMessage', () => {
  it('appends to a loaded channel at the live end and updates lastMessageAt', () => {
    loadedChannel('C1', [makeMessage({ id: 10 })]);
    A.receiveMessage(makeMessage({ id: 12, createdAt: 5555 }));
    expect(S().chan.C1.ids).toEqual([10, 12]);
    expect(S().channels.C1.lastMessageAt).toBe(5555);
  });

  it('does not append when viewing older history (hasMoreAfter)', () => {
    loadedChannel('C1', [makeMessage({ id: 10 })], { hasMoreAfter: true });
    A.receiveMessage(makeMessage({ id: 12 }));
    expect(S().chan.C1.ids).toEqual([10]);
    expect(S().msgs[12]).toBeDefined();
  });

  it('counts unread messages and mentions from others', () => {
    A.receiveMessage(makeMessage({ id: 11, text: 'hi' }));
    A.receiveMessage(makeMessage({ id: 12, text: 'hey <@U1>' }));
    A.receiveMessage(makeMessage({ id: 13, text: '<!here> standup' }));
    expect(S().memberships.C1).toMatchObject({ unread: 3, mentions: 2 });
    expect(document.title).toMatch(/^\(2\) /);
  });

  it('does not count messages at or below lastRead, or system mentions', () => {
    A.receiveMessage(makeMessage({ id: 9, text: '<@U1>' }));
    A.receiveMessage(makeMessage({ id: 11, text: '<@U1> joined', subtype: 'join' }));
    expect(S().memberships.C1).toMatchObject({ unread: 1, mentions: 0 });
  });

  it('marks the channel read when I post', () => {
    set((s) => void Object.assign(s.memberships.C1, { unread: 4, mentions: 1 }));
    A.receiveMessage(makeMessage({ id: 20, userId: 'U1' }));
    expect(S().memberships.C1).toMatchObject({ lastRead: 20, unread: 0, mentions: 0 });
  });

  it('counts each message only once', () => {
    A.receiveMessage(makeMessage({ id: 11 }));
    A.receiveMessage(makeMessage({ id: 11, text: 'again' }));
    expect(S().memberships.C1.unread).toBe(1);
    expect(S().msgs[11].text).toBe('again');
  });

  it('thread replies go to the loaded thread, not the channel, and do not count as unread', () => {
    loadedChannel('C1', [makeMessage({ id: 10 })]);
    set((s) => void (s.threads[10] = { ids: [], loaded: true, following: true, lastRead: 0 }));
    A.receiveMessage(makeMessage({ id: 15, threadRootId: 10, createdAt: 777 }));
    A.receiveMessage(makeMessage({ id: 15, threadRootId: 10 }));
    expect(S().threads[10].ids).toEqual([15]);
    expect(S().chan.C1.ids).toEqual([10]);
    expect(S().memberships.C1.unread).toBe(0);
    expect(S().channels.C1.lastMessageAt).toBeNull();
  });

  it('replies also sent to the channel appear in both', () => {
    loadedChannel('C1', [makeMessage({ id: 10 })]);
    set((s) => void (s.threads[10] = { ids: [], loaded: true, following: true, lastRead: 0 }));
    A.receiveMessage(makeMessage({ id: 16, threadRootId: 10, alsoInChannel: true }));
    expect(S().threads[10].ids).toEqual([16]);
    expect(S().chan.C1.ids).toEqual([10, 16]);
    expect(S().memberships.C1.unread).toBe(1);
  });

  it('replaces the optimistic copy matched by clientId', () => {
    loadedChannel('C1', [makeMessage({ id: 10 }), makeMessage({ id: -1, clientId: 'abc', userId: 'U1', threadRootId: 10, alsoInChannel: true })]);
    set((s) => void (s.threads[10] = { ids: [-1], loaded: true, following: true, lastRead: 0 }));
    A.receiveMessage(makeMessage({ id: 11, clientId: 'abc', userId: 'U1', threadRootId: 10, alsoInChannel: true }));
    expect(S().msgs[-1]).toBeUndefined();
    expect(S().chan.C1.ids).toEqual([10, 11]);
    expect(S().threads[10].ids).toEqual([11]);
  });

  it('ignores clientIds that match no pending message and works for unloaded channels', () => {
    A.receiveMessage(makeMessage({ id: 30, channelId: 'C2', clientId: 'zzz' }));
    expect(S().msgs[30]).toBeDefined();
    expect(S().chan.C2).toBeUndefined();
    expect(S().memberships.C2.unread).toBe(1);
  });

  it('unhides hidden DMs when someone writes', () => {
    set((s) => void (s.memberships.D1.hidden = true));
    A.receiveMessage(makeMessage({ id: 40, channelId: 'D1', userId: 'U1' }));
    expect(S().memberships.D1.hidden).toBe(true);
    A.receiveMessage(makeMessage({ id: 41, channelId: 'D1', userId: 'U2' }));
    expect(S().memberships.D1.hidden).toBe(false);
  });

  it('works for channels I am not a member of', () => {
    A.receiveMessage(makeMessage({ id: 50, channelId: 'C404' }));
    expect(S().msgs[50]).toBeDefined();
  });
});

describe('sendMessage', () => {
  it('shows an optimistic message and replaces it with the server copy', async () => {
    loadedChannel('C1', [makeMessage({ id: 10 })]);
    let resolve!: (r: Response) => void;
    const f = mockFetch({ 'POST /api/channels/C1/messages': () => new Promise<Response>((r) => (resolve = r)) });
    const p = A.sendMessage('C1', 'hello');
    const ids = S().chan.C1.ids;
    expect(ids).toHaveLength(2);
    const tempId = ids[1];
    expect(tempId).toBeLessThan(0);
    const temp = S().msgs[tempId];
    expect(temp).toMatchObject({ text: 'hello', userId: 'U1', pending: true, channelId: 'C1', threadRootId: null });
    const body = bodyOf(f, 0);
    expect(body).toEqual({ text: 'hello', threadRootId: null, clientId: temp.clientId });
    expect(temp.clientId).toMatch(/^U1-\d+-\d+$/);

    resolve(jsonResponse(makeMessage({ id: 11, userId: 'U1', text: 'hello', clientId: temp.clientId })));
    const m = await p;
    expect(m?.id).toBe(11);
    expect(S().chan.C1.ids).toEqual([10, 11]);
    expect(S().msgs[tempId]).toBeUndefined();
    expect(S().memberships.C1.lastRead).toBe(11);
  });

  it('puts thread replies into the loaded thread and sends files', async () => {
    loadedChannel('C1', [makeMessage({ id: 10 })]);
    set((s) => void (s.threads[10] = { ids: [12], loaded: true, following: true, lastRead: 0 }));
    set((s) => void (s.msgs[12] = makeMessage({ id: 12, threadRootId: 10 })));
    const f = mockFetch({ 'POST /api/channels/C1/messages': ({ body }: any) => makeMessage({ id: 13, userId: 'U1', threadRootId: 10, clientId: body.clientId }) });
    const p = A.sendMessage('C1', 'reply', { threadRootId: 10, files: [{ id: 'F1' } as any] });
    expect(S().threads[10].ids).toHaveLength(2);
    expect(S().chan.C1.ids).toEqual([10]);
    await p;
    expect(bodyOf(f, 0)).toMatchObject({ threadRootId: 10, fileIds: ['F1'] });
    expect(S().threads[10].ids).toEqual([12, 13]);
  });

  it('adds also-in-channel replies to the channel too', () => {
    loadedChannel('C1', [makeMessage({ id: 10 })]);
    mockFetch({ 'POST /api/channels/C1/messages': () => new Promise(() => {}) });
    void A.sendMessage('C1', 'both', { threadRootId: 10, alsoInChannel: true });
    expect(S().chan.C1.ids).toHaveLength(2);
  });

  it('keeps multiple pending messages ordered', () => {
    loadedChannel('C1', [makeMessage({ id: 10 })]);
    mockFetch({ 'POST /api/channels/C1/messages': () => new Promise(() => {}) });
    void A.sendMessage('C1', 'first');
    vi.advanceTimersByTime(5);
    void A.sendMessage('C1', 'second');
    const texts = S().chan.C1.ids.map((id) => S().msgs[id].text);
    expect(texts).toEqual(['hello', 'first', 'second']);
  });

  it('marks the message as failed and toasts on error; retry resends it', async () => {
    loadedChannel('C1', []);
    mockFetch({ 'POST /api/channels/C1/messages': () => jsonResponse({ error: 'channel_archived' }, 403) });
    await expect(A.sendMessage('C1', 'oops')).resolves.toBeUndefined();
    const tempId = S().chan.C1.ids[0];
    expect(S().msgs[tempId]).toMatchObject({ failed: true, pending: true });
    expect(lastToast()).toMatchObject({ text: 'This channel is archived.', kind: 'error' });

    const f = mockFetch({ 'POST /api/channels/C1/messages': ({ body }: any) => makeMessage({ id: 77, userId: 'U1', text: body.text, clientId: body.clientId }) });
    await A.retryMessage(tempId);
    expect(f).toHaveBeenCalledTimes(1);
    expect(S().msgs[tempId]).toBeUndefined();
    expect(S().chan.C1.ids).toEqual([77]);
  });

  it('retry ignores unknown messages', async () => {
    const f = mockFetch({});
    await A.retryMessage(-12345);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('removeLocal / removeMessageLocal', () => {
  it('removes a message from channel and thread lists', () => {
    loadedChannel('C1', [makeMessage({ id: 10 }), makeMessage({ id: 11, threadRootId: 10, alsoInChannel: true })]);
    set((s) => void (s.threads[10] = { ids: [11], loaded: true, following: false, lastRead: 0 }));
    A.removeLocal(11);
    expect(S().chan.C1.ids).toEqual([10]);
    expect(S().threads[10].ids).toEqual([]);
    A.removeLocal(999); // no-op
  });

  it('removeMessageLocal also closes the thread panel of a deleted root', () => {
    loadedChannel('C1', [makeMessage({ id: 10 }), makeMessage({ id: 11 })]);
    set((s) => {
      s.threads[10] = { ids: [12], loaded: true, following: false, lastRead: 0 };
      s.right = { type: 'thread', rootId: 10, channelId: 'C1' };
    });
    A.removeMessageLocal({ id: 12, channelId: 'C1', threadRootId: 10 });
    expect(S().threads[10].ids).toEqual([]);
    expect(S().right).not.toBeNull();
    A.removeMessageLocal({ id: 10, channelId: 'C1', threadRootId: null });
    expect(S().chan.C1.ids).toEqual([11]);
    expect(S().right).toBeNull();
    A.removeMessageLocal({ id: 1, channelId: 'C404', threadRootId: 99 });
  });
});

describe('editMessage', () => {
  it('updates optimistically, closes the editor and stores the server copy', async () => {
    loadedChannel('C1', [makeMessage({ id: 10, text: 'old', userId: 'U1' })]);
    set((s) => void (s.editingId = 10));
    let resolve!: (r: Response) => void;
    const f = mockFetch({ 'PATCH /api/messages/10': () => new Promise<Response>((r) => (resolve = r)) });
    const p = A.editMessage(10, 'new');
    expect(S().msgs[10]).toMatchObject({ text: 'new', editedAt: NOW });
    expect(S().editingId).toBeNull();
    expect(bodyOf(f, 0)).toEqual({ text: 'new' });
    resolve(jsonResponse(makeMessage({ id: 10, text: 'new (server)', editedAt: 1 })));
    await p;
    expect(S().msgs[10].text).toBe('new (server)');
  });

  it('restores the previous text on failure', async () => {
    loadedChannel('C1', [makeMessage({ id: 10, text: 'old' })]);
    mockFetch({ 'PATCH /api/messages/10': () => jsonResponse({ message: 'forbidden' }, 403) });
    await A.editMessage(10, 'new');
    expect(S().msgs[10].text).toBe('old');
    expect(lastToast()?.text).toBe('forbidden');
  });

  it('tolerates unknown messages', async () => {
    mockFetch({ 'PATCH /api/messages/99': () => jsonResponse({ message: 'gone' }, 404) });
    await A.editMessage(99, 'x');
    expect(S().msgs[99]).toBeUndefined();
  });
});

describe('deleteMessage', () => {
  it('asks for confirmation first', async () => {
    const f = mockFetch({ 'DELETE /api/messages/10': {} });
    A.deleteMessage(10);
    const modal = S().modal;
    expect(modal).toMatchObject({ type: 'confirm', title: 'Delete message', danger: true, confirmLabel: 'Delete' });
    expect(f).not.toHaveBeenCalled();
    await (modal as any).onConfirm();
    expect(f).toHaveBeenCalledWith('/api/messages/10', expect.objectContaining({ method: 'DELETE' }));
  });

  it('deletes immediately when skipping the confirmation, toasting failures', async () => {
    mockFetch({ 'DELETE /api/messages/10': () => jsonResponse({ message: 'nope' }, 403) });
    await A.deleteMessage(10, true);
    expect(S().modal).toBeNull();
    expect(lastToast()?.text).toBe('nope');
  });
});

describe('toggleReaction / rememberEmoji', () => {
  beforeEach(() => {
    set((s) => {
      s.msgs[10] = makeMessage({ id: 10, reactions: [{ emoji: 'tada', userIds: ['U2'] }, { emoji: 'eyes', userIds: ['U1'] }] });
    });
  });

  it('adds my reaction optimistically and posts it', async () => {
    let resolve!: (r: Response) => void;
    const f = mockFetch({ 'POST /api/messages/10/reactions': () => new Promise<Response>((r) => (resolve = r)) });
    const p = A.toggleReaction(10, 'tada');
    expect(S().msgs[10].reactions[0]).toEqual({ emoji: 'tada', userIds: ['U2', 'U1'] });
    expect(bodyOf(f, 0)).toEqual({ emoji: 'tada' });
    resolve(jsonResponse(makeMessage({ id: 10, reactions: [{ emoji: 'tada', userIds: ['U1', 'U2'] }] })));
    await p;
    expect(S().msgs[10].reactions).toEqual([{ emoji: 'tada', userIds: ['U1', 'U2'] }]);
  });

  it('creates a new reaction entry', () => {
    mockFetch({ 'POST /api/messages/10/reactions': () => new Promise(() => {}) });
    void A.toggleReaction(10, '+1::skin-tone-2');
    expect(S().msgs[10].reactions.at(-1)).toEqual({ emoji: '+1::skin-tone-2', userIds: ['U1'] });
  });

  it('removes my reaction (dropping empty ones) via DELETE with an encoded emoji', async () => {
    const f = mockFetch({ 'DELETE /api/messages/10/reactions/*': makeMessage({ id: 10 }) });
    const p = A.toggleReaction(10, 'eyes');
    expect(S().msgs[10].reactions.map((r) => r.emoji)).toEqual(['tada']);
    await p;
    expect(f.mock.calls[0][0]).toBe('/api/messages/10/reactions/eyes');
    set((s) => void (s.msgs[10] = makeMessage({ id: 10, reactions: [{ emoji: '+1', userIds: ['U1', 'U2'] }] })));
    await A.toggleReaction(10, '+1');
    expect(f.mock.calls[1][0]).toBe('/api/messages/10/reactions/%2B1');
  });

  it('ignores unknown messages', async () => {
    const f = mockFetch({});
    await A.toggleReaction(404, 'tada');
    expect(f).not.toHaveBeenCalled();
  });

  it('toasts failures', async () => {
    mockFetch({ 'POST /api/messages/10/reactions': () => jsonResponse({ message: 'too many reactions' }, 400) });
    await A.toggleReaction(10, 'fire');
    expect(lastToast()).toMatchObject({ text: 'too many reactions', kind: 'error' });
  });

  it('remembers recently used emoji and saves them debounced', async () => {
    const f = mockFetch({ 'PUT /api/users/me/prefs': {} });
    set((s) => void (s.me!.prefs.recentEmoji = ['a', 'b', 'fire']));
    A.rememberEmoji('fire');
    A.rememberEmoji('rocket');
    expect(S().me!.prefs.recentEmoji).toEqual(['rocket', 'fire', 'a', 'b']);
    await vi.advanceTimersByTimeAsync(1999);
    expect(f).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f).toHaveBeenCalledTimes(1);
    expect(bodyOf(f, 0)).toEqual({ recentEmoji: ['rocket', 'fire', 'a', 'b'] });
  });

  it('caps the recent list at 24 and ignores failures and logged-out state', async () => {
    mockFetch({ 'PUT /api/users/me/prefs': () => jsonResponse({}, 500) });
    for (let i = 0; i < 30; i++) A.rememberEmoji(`e${i}`);
    expect(S().me!.prefs.recentEmoji).toHaveLength(24);
    expect(S().me!.prefs.recentEmoji![0]).toBe('e29');
    await vi.advanceTimersByTimeAsync(2000);
    expect(S().toasts).toEqual([]);
    resetStore();
    expect(() => A.rememberEmoji('x')).not.toThrow();
  });

  it('adding a reaction records it as recent', () => {
    mockFetch({ 'POST /api/messages/10/reactions': () => new Promise(() => {}) });
    void A.toggleReaction(10, 'rocket');
    expect(S().me!.prefs.recentEmoji).toEqual(['rocket']);
  });
});

describe('togglePin', () => {
  it('pins and unpins with a toast', async () => {
    set((s) => void (s.msgs[10] = makeMessage({ id: 10 })));
    mockFetch({ 'POST /api/messages/10/pin': makeMessage({ id: 10, pinnedBy: 'U1' }), 'DELETE /api/messages/10/pin': makeMessage({ id: 10 }) });
    await A.togglePin(10);
    expect(S().msgs[10].pinnedBy).toBe('U1');
    expect(lastToast()?.text).toBe('Pinned to channel');
    await A.togglePin(10);
    expect(S().msgs[10].pinnedBy).toBeNull();
    expect(lastToast()?.text).toBe('Unpinned from channel');
  });

  it('ignores unknown messages and toasts failures', async () => {
    const f = mockFetch({ 'POST /api/messages/10/pin': () => jsonResponse({ message: 'no' }, 403) });
    await A.togglePin(999);
    expect(f).not.toHaveBeenCalled();
    set((s) => void (s.msgs[10] = makeMessage({ id: 10 })));
    await A.togglePin(10);
    expect(lastToast()).toMatchObject({ text: 'no', kind: 'error' });
  });
});

describe('reminders & saved', () => {
  it('remindOptions offers fixed delays, tomorrow 9:00 and next Monday 9:00', () => {
    const opts = A.remindOptions();
    expect(opts.map((o) => o.label)).toEqual(['In 20 minutes', 'In 1 hour', 'In 3 hours', 'Tomorrow', 'Next week']);
    expect(opts[0].at).toBe(NOW + 20 * 60_000);
    expect(opts[1].at).toBe(NOW + 3600_000);
    expect(opts[2].at).toBe(NOW + 3 * 3600_000);
    expect(new Date(opts[3].at).toISOString()).toBe('2026-10-08T09:00:00.000Z');
    expect(new Date(opts[4].at).toISOString()).toBe('2026-10-12T09:00:00.000Z');
  });

  it.each([
    ['Sunday', Date.UTC(2026, 9, 11, 20), '2026-10-12'],
    ['Monday', Date.UTC(2026, 9, 12, 8), '2026-10-19'],
    ['Saturday', Date.UTC(2026, 9, 10, 8), '2026-10-12'],
  ])('"Next week" from a %s is the following Monday', (_, now, date) => {
    vi.setSystemTime(now);
    expect(new Date(A.remindOptions()[4].at).toISOString()).toBe(`${date}T09:00:00.000Z`);
  });

  it('remindMe saves the message with a reminder', async () => {
    const f = mockFetch({ 'POST /api/messages/10/save': {} });
    const at = NOW + 3600_000;
    await A.remindMe(10, at);
    expect(S().saved[10]).toBe(true);
    expect(bodyOf(f, 0)).toEqual({ remindAt: at });
    expect(lastToast()?.text).toMatch(/^I’ll remind you /);
  });

  it('remindMe toasts failures', async () => {
    mockFetch({ 'POST /api/messages/10/save': () => jsonResponse({ message: 'nope' }, 500) });
    await A.remindMe(10, NOW);
    expect(lastToast()).toMatchObject({ text: 'nope', kind: 'error' });
  });

  it('toggleSaved saves and unsaves', async () => {
    const f = mockFetch({ 'POST /api/messages/10/save': {}, 'DELETE /api/messages/10/save': {} });
    await A.toggleSaved(10);
    expect(S().saved[10]).toBe(true);
    expect(lastToast()?.text).toBe('Saved for later');
    await A.toggleSaved(10);
    expect(S().saved[10]).toBeUndefined();
    expect(lastToast()?.text).toBe('Removed from Later');
    expect(f.mock.calls.map((c) => c[1]?.method)).toEqual(['POST', 'DELETE']);
  });

  it('toggleSaved toasts failures', async () => {
    mockFetch({ 'POST /api/messages/10/save': () => jsonResponse({ message: 'x' }, 500) });
    await A.toggleSaved(10);
    expect(lastToast()?.kind).toBe('error');
  });
});

describe('markUnread', () => {
  it('moves the read marker back and suppresses auto-read', async () => {
    mockFetch({ 'POST /api/messages/15/unread': {} });
    await A.markUnread(makeMessage({ id: 15, channelId: 'C1' }));
    expect(S().memberships.C1.lastRead).toBe(14);
    expect(S().unreadMarker.C1).toBe(14);
    expect(A.suppressAutoRead.has('C1')).toBe(true);
    expect(lastToast()?.text).toBe('Marked as unread');
  });

  it('does not touch the channel marker for thread-only replies or unknown memberships', async () => {
    mockFetch({ 'POST /api/messages/*': {} });
    await A.markUnread(makeMessage({ id: 15, channelId: 'C1', threadRootId: 3 }));
    expect(S().memberships.C1.lastRead).toBe(10);
    await A.markUnread(makeMessage({ id: 16, channelId: 'C404' }));
    expect(S().unreadMarker.C404).toBe(15);
  });

  it('toasts failures', async () => {
    mockFetch({ 'POST /api/messages/15/unread': () => jsonResponse({ message: 'x' }, 500) });
    await A.markUnread(makeMessage({ id: 15 }));
    expect(lastToast()?.kind).toBe('error');
  });
});

describe('markRead', () => {
  it('clears counts immediately and syncs to the server debounced', async () => {
    loadedChannel('C1', [makeMessage({ id: 11 }), makeMessage({ id: 12 }), makeMessage({ id: -1 })]);
    set((s) => void Object.assign(s.memberships.C1, { unread: 2, mentions: 0 }));
    const f = mockFetch({ 'PUT /api/channels/C1/read': {} });
    A.markRead('C1');
    expect(S().memberships.C1).toMatchObject({ lastRead: 12, unread: 0, mentions: 0 });
    await vi.advanceTimersByTimeAsync(399);
    expect(f).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f).toHaveBeenCalledTimes(1);
    expect(bodyOf(f, 0)).toEqual({ messageId: 12 });
  });

  it('coalesces rapid calls into one request with the latest position', async () => {
    const f = mockFetch({ 'PUT /api/channels/C1/read': {} });
    A.markRead('C1', 11);
    await vi.advanceTimersByTimeAsync(200);
    A.markRead('C1', 13);
    await vi.advanceTimersByTimeAsync(400);
    expect(f).toHaveBeenCalledTimes(1);
    expect(bodyOf(f, 0)).toEqual({ messageId: 13 });
  });

  it('refreshes the activity counts after clearing mentions', async () => {
    set((s) => void Object.assign(s.memberships.C1, { unread: 1, mentions: 1 }));
    const f = mockFetch({ 'PUT /api/channels/C1/read': {}, 'GET /api/counts': { activityUnread: 0, threadsUnread: 2 } });
    set((s) => void (s.activityUnread = 5));
    A.markRead('C1', 11);
    await vi.advanceTimersByTimeAsync(400 + 300);
    expect(f.mock.calls.map((c) => c[0])).toEqual(['/api/channels/C1/read', '/api/counts']);
    expect(S()).toMatchObject({ activityUnread: 0, threadsUnread: 2 });
  });

  it('does nothing when already read, unknown, or empty', async () => {
    const f = mockFetch({});
    A.markRead('C404', 50);
    A.markRead('C1', 5); // below lastRead with no counts
    A.markRead('C2'); // nothing loaded → last = 0
    await vi.advanceTimersByTimeAsync(1000);
    expect(f).not.toHaveBeenCalled();
  });

  it('never moves lastRead backwards and ignores server errors', async () => {
    set((s) => void (s.memberships.C1.unread = 3));
    mockFetch({ 'PUT /api/channels/C1/read': () => jsonResponse({}, 500) });
    A.markRead('C1', 5);
    expect(S().memberships.C1).toMatchObject({ lastRead: 10, unread: 0 });
    await vi.advanceTimersByTimeAsync(400);
    expect(S().toasts).toEqual([]);
  });
});

describe('refreshCounts', () => {
  it('debounces requests', async () => {
    const f = mockFetch({ 'GET /api/counts': { activityUnread: 7, threadsUnread: 1 } });
    void A.refreshCounts();
    const p = A.refreshCounts();
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(f).toHaveBeenCalledTimes(1);
    expect(S()).toMatchObject({ activityUnread: 7, threadsUnread: 1 });
  });

  it('resolves even when the request fails', async () => {
    mockFetch({ 'GET /api/counts': () => jsonResponse({}, 500) });
    const p = A.refreshCounts();
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('threads', () => {
  it('loadThread keeps pending replies and closes the panel on error', async () => {
    set((s) => {
      s.msgs[-4] = makeMessage({ id: -4, threadRootId: 5 });
      s.threads[5] = { ids: [-4], loaded: false, following: false, lastRead: 0 };
    });
    mockFetch({ 'GET /api/messages/5/thread': { root: makeMessage({ id: 5 }), replies: [makeMessage({ id: 7 }), makeMessage({ id: 6 })], following: false, lastRead: 0 } });
    await A.loadThread(5);
    expect(S().threads[5].ids).toEqual([6, 7, -4]);
    expect(S().msgs[5]).toBeDefined();

    set((s) => void (s.right = { type: 'thread', rootId: 8, channelId: 'C1' }));
    mockFetch({ 'GET /api/messages/8/thread': () => jsonResponse({ message: 'gone' }, 404) });
    await A.loadThread(8);
    expect(S().right).toBeNull();
    expect(lastToast()?.text).toBe('gone');
  });

  it('markThreadRead advances lastRead and syncs', async () => {
    set((s) => void (s.threads[5] = { ids: [6, 7, -1], loaded: true, following: true, lastRead: 6 }));
    const f = mockFetch({ 'PUT /api/messages/5/thread/read': {}, 'GET /api/counts': { activityUnread: 0, threadsUnread: 0 } });
    A.markThreadRead(5);
    expect(S().threads[5].lastRead).toBe(7);
    await vi.advanceTimersByTimeAsync(300);
    expect(f.mock.calls.map((c) => c[0])).toEqual(['/api/messages/5/thread/read', '/api/counts']);
    expect(bodyOf(f, 0)).toEqual({ messageId: 7 });
  });

  it('markThreadRead does nothing for unknown or already-read threads and swallows errors', async () => {
    const f = mockFetch({ 'PUT /api/messages/5/thread/read': () => jsonResponse({}, 500) });
    A.markThreadRead(404);
    set((s) => void (s.threads[5] = { ids: [6], loaded: true, following: true, lastRead: 6 }));
    A.markThreadRead(5);
    set((s) => void (s.threads[9] = { ids: [], loaded: true, following: true, lastRead: 0 }));
    A.markThreadRead(9);
    expect(f).not.toHaveBeenCalled();
    set((s) => void (s.threads[5].ids = [6, 8]));
    A.markThreadRead(5);
    await vi.advanceTimersByTimeAsync(500);
    expect(S().toasts).toEqual([]);
  });

  it('setThreadFollow toggles following with a toast', async () => {
    set((s) => void (s.threads[5] = { ids: [], loaded: true, following: false, lastRead: 0 }));
    const f = mockFetch({ 'PUT /api/messages/*': {}, 'GET /api/counts': { activityUnread: 0, threadsUnread: 0 } });
    await A.setThreadFollow(5, true);
    expect(S().threads[5].following).toBe(true);
    expect(lastToast()?.text).toBe('You’re following this thread');
    await A.setThreadFollow(6, false);
    expect(lastToast()?.text).toBe('You’ve unfollowed this thread');
    expect(bodyOf(f, 0)).toEqual({ following: true });
  });

  it('setThreadFollow toasts failures', async () => {
    mockFetch({ 'PUT /api/messages/5/thread/follow': () => jsonResponse({ message: 'no' }, 500) });
    await A.setThreadFollow(5, true);
    expect(lastToast()).toMatchObject({ text: 'no', kind: 'error' });
  });
});

// ---------------------------------------------------------------------------

describe('channels', () => {
  it('upsertChannel / upsertMembership', () => {
    A.upsertChannel(makeChannel({ id: 'C9', name: 'new' }));
    A.upsertMembership(makeMembership({ channelId: 'C9', unread: 1 }));
    expect(S().channels.C9.name).toBe('new');
    expect(S().memberships.C9.unread).toBe(1);
  });

  it('joinChannel stores the channel and reloads messages', async () => {
    loadedChannel('C9', [makeMessage({ id: 1, channelId: 'C9' })]);
    const f = mockFetch({
      'POST /api/channels/C9/join': { channel: makeChannel({ id: 'C9', name: 'random' }), membership: makeMembership({ channelId: 'C9' }) },
      'GET /api/channels/C9/messages*': { messages: [makeMessage({ id: 2, channelId: 'C9' })], hasMoreBefore: false, hasMoreAfter: false },
    });
    await A.joinChannel('C9');
    expect(S().memberships.C9).toBeDefined();
    await vi.waitFor(() => expect(S().chan.C9.ids).toEqual([2]));
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('joinChannel toasts failures', async () => {
    mockFetch({ 'POST /api/channels/C9/join': () => jsonResponse({ error: 'channel_archived' }, 400) });
    await A.joinChannel('C9');
    expect(lastToast()?.text).toBe('This channel is archived.');
  });

  it('leaving a public channel removes the membership and navigates home if active', async () => {
    set((s) => void (s.activeChannelId = 'C1'));
    mockFetch({ 'POST /api/channels/C1/leave': {} });
    A.leaveChannel('C1');
    await vi.waitFor(() => expect(S().memberships.C1).toBeUndefined());
    expect(S().channels.C1).toBeDefined();
    expect(nav).toHaveBeenCalledWith('/', undefined);
  });

  it('leaving a private channel asks first and forgets the channel', async () => {
    mockFetch({ 'POST /api/channels/C2/leave': {} });
    A.leaveChannel('C2');
    const modal = S().modal as any;
    expect(modal).toMatchObject({ type: 'confirm', title: 'Leave #secret?', confirmLabel: 'Leave channel', danger: true });
    await modal.onConfirm();
    expect(S().memberships.C2).toBeUndefined();
    expect(S().channels.C2).toBeUndefined();
    expect(nav).not.toHaveBeenCalled();
  });

  it('leaving a DM just hides it', async () => {
    mockFetch({ 'POST /api/channels/D1/leave': {} });
    A.leaveChannel('D1');
    await vi.waitFor(() => expect(S().memberships.D1.hidden).toBe(true));
    expect(S().channels.D1).toBeDefined();
  });

  it('leaveChannel toasts failures', async () => {
    mockFetch({ 'POST /api/channels/C1/leave': () => jsonResponse({ error: 'cannot_leave_general' }, 400) });
    A.leaveChannel('C1');
    await vi.waitFor(() => expect(lastToast()?.text).toBe('Everyone stays in #general.'));
    expect(S().memberships.C1).toBeDefined();
  });

  it('openDm creates/reuses a DM and opens it', async () => {
    const f = mockFetch({ 'POST /api/dms': { channel: makeChannel({ id: 'D7', kind: 'dm', memberIds: ['U1', 'U2'] }), membership: makeMembership({ channelId: 'D7' }) } });
    const ch = await A.openDm(['U2']);
    expect(ch?.id).toBe('D7');
    expect(bodyOf(f, 0)).toEqual({ userIds: ['U2'] });
    expect(S().memberships.D7).toBeDefined();
    expect(nav).toHaveBeenCalledWith('/c/D7', undefined);
  });

  it('openDm toasts failures', async () => {
    mockFetch({ 'POST /api/dms': () => jsonResponse({ message: 'nope' }, 400) });
    await expect(A.openDm(['U2'])).resolves.toBeUndefined();
    expect(lastToast()?.text).toBe('nope');
  });

  it('setChannelPrefs applies optimistically and stores the server membership', async () => {
    let resolve!: (r: Response) => void;
    const f = mockFetch({ 'PUT /api/channels/C1/prefs': () => new Promise<Response>((r) => (resolve = r)) });
    const p = A.setChannelPrefs('C1', { starred: true, notify: 'all' });
    expect(S().memberships.C1).toMatchObject({ starred: true, notify: 'all' });
    expect(bodyOf(f, 0)).toEqual({ starred: true, notify: 'all' });
    resolve(jsonResponse(makeMembership({ channelId: 'C1', starred: true, notify: 'all', muted: true })));
    await p;
    expect(S().memberships.C1.muted).toBe(true);
  });

  it('setChannelPrefs toasts failures and ignores unknown memberships', async () => {
    mockFetch({ 'PUT /api/channels/C404/prefs': () => jsonResponse({ message: 'no' }, 404) });
    await A.setChannelPrefs('C404', { muted: true });
    expect(S().memberships.C404).toBeUndefined();
    expect(lastToast()?.text).toBe('no');
  });
});

// ---------------------------------------------------------------------------

describe('user', () => {
  it('updatePrefs applies locally (incl. language/theme) and persists', async () => {
    const f = mockFetch({ 'PUT /api/users/me/prefs': {} });
    await A.updatePrefs({ language: 'cs', colorMode: 'dark', compact: true });
    expect(S().me!.prefs).toMatchObject({ language: 'cs', colorMode: 'dark', compact: true });
    expect(document.documentElement.lang).toBe('cs');
    expect(document.documentElement.dataset.mode).toBe('dark');
    expect(bodyOf(f, 0)).toEqual({ language: 'cs', colorMode: 'dark', compact: true });
    setLanguage('en');
  });

  it('updatePrefs works logged out and toasts failures', async () => {
    resetStore();
    mockFetch({ 'PUT /api/users/me/prefs': () => jsonResponse({ message: 'no' }, 500) });
    await A.updatePrefs({ compact: true });
    expect(lastToast()?.text).toBe('no');
  });

  it('setMe updates me and the users map', () => {
    A.setMe(makeMe({ id: 'U1', username: 'renamed' }));
    expect(S().me!.username).toBe('renamed');
    expect(S().users.U1.username).toBe('renamed');
  });

  it('setStatus / setAway / setDnd store the returned profile', async () => {
    const f = mockFetch({
      'PUT /api/users/me/status': makeMe({ id: 'U1', statusEmoji: 'palm_tree', statusText: 'Vacation' }),
      'PUT /api/users/me/presence': makeMe({ id: 'U1', awayManual: true }),
      'PUT /api/users/me/dnd': ({ body }: any) => makeMe({ id: 'U1', dndUntil: body.until }),
    });
    await A.setStatus('palm_tree', 'Vacation', null);
    expect(S().users.U1.statusText).toBe('Vacation');
    expect(bodyOf(f, 0)).toEqual({ emoji: 'palm_tree', text: 'Vacation', expiresAt: null });
    await A.setAway(true);
    expect(S().me!.awayManual).toBe(true);
    await A.setDnd(NOW + 1000);
    expect(S().me!.dndUntil).toBe(NOW + 1000);
    expect(lastToast()?.text).toBe('Notifications paused');
    await A.setDnd(null);
    expect(lastToast()?.text).toBe('Notifications resumed');
  });

  it('setStatus / setAway / setDnd toast failures', async () => {
    mockFetch({ 'PUT /api/users/me/*': () => jsonResponse({ message: 'fail' }, 500) });
    await A.setStatus('x', 'y', null);
    await A.setAway(false);
    await A.setDnd(null);
    expect(S().toasts.filter((t) => t.kind === 'error')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------

describe('drafts & typing', () => {
  it('saves drafts locally right away and to the server debounced', async () => {
    const f = mockFetch({ 'PUT /api/drafts': {} });
    A.saveDraft('C1', null, 'h');
    A.saveDraft('C1', null, 'hello');
    expect(S().drafts[draftKey('C1')]).toMatchObject({ channelId: 'C1', threadRootId: null, text: 'hello', updatedAt: NOW });
    await vi.advanceTimersByTimeAsync(799);
    expect(f).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f).toHaveBeenCalledTimes(1);
    expect(bodyOf(f, 0)).toEqual({ channelId: 'C1', threadRootId: null, text: 'hello' });
  });

  it('debounces per conversation', async () => {
    const f = mockFetch({ 'PUT /api/drafts': {} });
    A.saveDraft('C1', null, 'a');
    A.saveDraft('C1', 5, 'b');
    await vi.advanceTimersByTimeAsync(800);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('skips unchanged text and deletes blank drafts', async () => {
    const f = mockFetch({ 'PUT /api/drafts': () => jsonResponse({}, 500) });
    A.saveDraft('C1', 3, '');
    expect(f).not.toHaveBeenCalled();
    A.saveDraft('C1', 3, 'x');
    A.saveDraft('C1', 3, '   ');
    expect(S().drafts['C1:3']).toBeUndefined();
    await vi.advanceTimersByTimeAsync(800);
    expect(bodyOf(f, 0).text).toBe('   ');
    expect(S().toasts).toEqual([]);
  });

  it('throttles typing notifications per conversation (3s)', () => {
    A.sendTyping('C1', null);
    A.sendTyping('C1', null);
    expect(emitTyping).toHaveBeenCalledTimes(1);
    A.sendTyping('C1', 7);
    expect(emitTyping).toHaveBeenLastCalledWith('C1', 7);
    vi.advanceTimersByTime(3000);
    A.sendTyping('C1', 7);
    expect(emitTyping).toHaveBeenCalledTimes(3);
  });
});

describe('forwardMessage / copyLink', () => {
  it('forwards a message as a quote with a permalink', async () => {
    set((s) => void (s.msgs[10] = makeMessage({ id: 10, channelId: 'C1', userId: 'U2', text: 'line 1\nline 2' })));
    const f = mockFetch({ 'POST /api/channels/C2/messages': ({ body }: any) => makeMessage({ id: 50, channelId: 'C2', userId: 'U1', clientId: body.clientId }) });
    await A.forwardMessage(10, 'C2', 'FYI');
    const text = bodyOf(f, 0).text;
    expect(text).toBe(`FYI\n> line 1\n> line 2\n> — <@U2> · <${location.origin}/c/C1/10|view message>`);
    expect(lastToast()?.text).toBe('Message forwarded');
  });

  it('forwards without a comment and ignores unknown messages', async () => {
    set((s) => void (s.msgs[10] = makeMessage({ id: 10, text: 'x' })));
    const f = mockFetch({ 'POST /api/channels/C2/messages': ({ body }: any) => makeMessage({ id: 50, channelId: 'C2', clientId: body.clientId }) });
    await A.forwardMessage(404, 'C2', '');
    expect(f).not.toHaveBeenCalled();
    await A.forwardMessage(10, 'C2', '');
    expect(bodyOf(f, 0).text).toMatch(/^> x\n> — /);
  });

  it('copies permalinks (with thread parameter for thread replies)', () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    A.copyLink(makeMessage({ id: 10, channelId: 'C1' }));
    expect(writeText).toHaveBeenLastCalledWith(`${location.origin}/c/C1/10`);
    A.copyLink(makeMessage({ id: 11, channelId: 'C1', threadRootId: 10 }));
    expect(writeText).toHaveBeenLastCalledWith(`${location.origin}/c/C1/11?thread=10`);
    A.copyLink(makeMessage({ id: 12, channelId: 'C1', threadRootId: 10, alsoInChannel: true }));
    expect(writeText).toHaveBeenLastCalledWith(`${location.origin}/c/C1/12`);
    expect(lastToast()?.text).toBe('Link copied to clipboard');
  });

  it('copyLink works without clipboard support', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    expect(() => A.copyLink(makeMessage({ id: 1 }))).not.toThrow();
  });
});
