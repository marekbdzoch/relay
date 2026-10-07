/**
 * Regression tests for bugs found while writing the suite (they were pinned with `it.fails` until fixed).
 * New known bugs can be pinned here with `it.fails`; once fixed, turn them into a normal `it`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as A from '../actions.ts';
import { api } from '../api.ts';
import { S, set } from '../store.ts';
import { jsonResponse, makeChannel, makeMe, makeMembership, makeMessage, makeUser, mockFetch, resetStore } from './helpers.ts';

vi.mock('../socket.ts', () => ({ connectSocket: vi.fn(), disconnectSocket: vi.fn(), emitTyping: vi.fn(), socket: null }));

beforeEach(() => {
  resetStore({
    me: makeMe({ id: 'U1', prefs: {} }),
    users: { U1: makeUser({ id: 'U1' }), U2: makeUser({ id: 'U2' }) },
    channels: { C1: makeChannel({ id: 'C1' }), C2: makeChannel({ id: 'C2' }) },
    memberships: { C1: makeMembership({ channelId: 'C1' }) },
  });
});

describe('fixed bugs (regressions)', () => {
  it('api(): non-JSON error bodies (e.g. an HTML 502 from a proxy) should become an ApiError, not a SyntaxError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' })));
    await expect(api('GET', '/api/x')).rejects.toMatchObject({ status: 502, code: 'error' });
  });

  it('refreshCounts(): a call superseded by a newer call should still resolve', async () => {
    vi.useFakeTimers();
    mockFetch({ 'GET /api/counts': { activityUnread: 0, threadsUnread: 0 } });
    let firstResolved = false;
    void A.refreshCounts().then(() => (firstResolved = true));
    void A.refreshCounts();
    await vi.advanceTimersByTimeAsync(1000);
    expect(firstResolved).toBe(true);
  });

  it('toggleReaction(): the optimistic reaction should be rolled back when the server rejects it', async () => {
    set((s) => void (s.msgs[10] = makeMessage({ id: 10, reactions: [] })));
    mockFetch({ 'POST /api/messages/10/reactions': () => jsonResponse({ message: 'nope' }, 400) });
    await A.toggleReaction(10, 'fire');
    expect(S().msgs[10].reactions).toEqual([]);
  });

  it('forwardMessage(): should not toast "Message forwarded" when sending failed', async () => {
    set((s) => void (s.msgs[10] = makeMessage({ id: 10, text: 'x' })));
    mockFetch({ 'POST /api/channels/C2/messages': () => jsonResponse({ message: 'nope' }, 500) });
    await A.forwardMessage(10, 'C2', '');
    expect(S().toasts.map((t) => t.text)).not.toContain('Message forwarded');
  });

  it('receiveMessage(): a bot/agent message that @-mentions me should count as a mention (maybeNotify treats it as one)', () => {
    A.receiveMessage(makeMessage({ id: 5, channelId: 'C1', userId: 'U2', subtype: 'bot', text: 'hey <@U1>' }));
    expect(S().memberships.C1.mentions).toBe(1);
  });
  it('setChannelPrefs(): rolls back when the server rejects it', async () => {
    mockFetch({ 'PUT /api/channels/C1/prefs': () => jsonResponse({ message: 'nope' }, 400) });
    await A.setChannelPrefs('C1', { starred: true, muted: true });
    expect(S().memberships.C1).toMatchObject({ starred: false, muted: false });
  });

  it('toggleSaved(): rolls back both ways when the server rejects it', async () => {
    mockFetch({ 'POST /api/messages/10/save': () => jsonResponse({ message: 'nope' }, 400), 'DELETE /api/messages/11/save': () => jsonResponse({ message: 'nope' }, 400) });
    await A.toggleSaved(10);
    expect(S().saved[10]).toBeUndefined();
    set((s) => void (s.saved[11] = true));
    await A.toggleSaved(11);
    expect(S().saved[11]).toBe(true);
  });

  it('remindMe(): un-saves only messages that were not saved before', async () => {
    mockFetch({ 'POST /api/messages/*': () => jsonResponse({ message: 'nope' }, 400) });
    await A.remindMe(10, Date.now() + 60_000);
    expect(S().saved[10]).toBeUndefined();
    set((s) => void (s.saved[11] = true));
    await A.remindMe(11, Date.now() + 60_000);
    expect(S().saved[11]).toBe(true);
  });

  it('updatePrefs(): restores the previous preferences when the server rejects them', async () => {
    set((s) => void (s.me!.prefs = { enterToSend: true }));
    mockFetch({ 'PUT /api/users/me/prefs': () => jsonResponse({ message: 'nope' }, 400) });
    await A.updatePrefs({ enterToSend: false });
    expect(S().me!.prefs.enterToSend).toBe(true);
  });
});
