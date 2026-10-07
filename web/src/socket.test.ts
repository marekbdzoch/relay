import { beforeEach, describe, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
import { connectSocket, disconnectSocket, emitTyping, socket } from './socket.ts';
import * as socketModule from './socket.ts';
import { S, set } from './store.ts';
import { refreshCounts, resync } from './actions.ts';
import { maybeNotify } from './lib/notify.ts';
import { huddleEnded, huddleSignal, huddleStateChanged, rejoinHuddle } from './lib/huddle.ts';
import { setLanguage } from './i18n.ts';
import { makeChannel, makeMe, makeMembership, makeMessage, makeUser, resetStore } from './test/helpers.ts';

type Handler = (...args: any[]) => void;
const fake = vi.hoisted(() => {
  const handlers: Record<string, Handler> = {};
  const sock = {
    handlers,
    on: (ev: string, cb: Handler) => {
      handlers[ev] = cb;
      return sock;
    },
    emit: (..._args: unknown[]) => {},
    disconnect: () => {},
  };
  return sock;
});

vi.mock('socket.io-client', () => ({ io: vi.fn(() => fake) }));
vi.mock('./lib/huddle.ts', () => ({ huddleSignal: vi.fn(), huddleStateChanged: vi.fn(), huddleEnded: vi.fn(), rejoinHuddle: vi.fn() }));
vi.mock('./actions.ts', async (orig) => ({ ...(await orig<typeof import('./actions.ts')>()), resync: vi.fn(async () => {}), refreshCounts: vi.fn(async () => {}) }));
vi.mock('./lib/notify.ts', async (orig) => ({ ...(await orig<typeof import('./lib/notify.ts')>()), maybeNotify: vi.fn() }));

const fire = (ev: string, ...args: unknown[]) => {
  const h = fake.handlers[ev];
  if (!h) throw new Error(`no handler for ${ev}`);
  h(...args);
};

beforeEach(() => {
  disconnectSocket();
  for (const k of Object.keys(fake.handlers)) delete fake.handlers[k];
  fake.emit = vi.fn();
  fake.disconnect = vi.fn();
  vi.mocked(io).mockClear();
  vi.mocked(resync).mockClear();
  vi.mocked(refreshCounts).mockClear();
  vi.mocked(maybeNotify).mockClear();
  resetStore({
    me: makeMe({ id: 'U1', username: 'me', prefs: {} }),
    users: { U1: makeUser({ id: 'U1' }), U2: makeUser({ id: 'U2' }) },
    channels: { C1: makeChannel({ id: 'C1', name: 'general' }), C2: makeChannel({ id: 'C2', kind: 'private' }) },
    memberships: { C1: makeMembership({ channelId: 'C1' }), C2: makeMembership({ channelId: 'C2' }) },
  });
  connectSocket();
});

describe('connectSocket', () => {
  it('connects once with credentials and both transports', () => {
    expect(io).toHaveBeenCalledTimes(1);
    expect(io).toHaveBeenCalledWith(undefined, { path: '/socket.io', withCredentials: true, auth: undefined, transports: ['websocket', 'polling'] });
    expect(connectSocket()).toBe(fake);
    expect(io).toHaveBeenCalledTimes(1);
    expect(socketModule.socket).toBe(fake);
    expect(socket).toBe(fake); // live binding
  });

  it('disconnectSocket disconnects and allows reconnecting', () => {
    disconnectSocket();
    expect(fake.disconnect).toHaveBeenCalled();
    expect(socketModule.socket).toBeNull();
    disconnectSocket(); // no-op without a socket
    connectSocket();
    expect(io).toHaveBeenCalledTimes(2);
  });

  it('emits typing events only while connected', () => {
    emitTyping('C1', 5);
    expect(fake.emit).toHaveBeenCalledWith('typing', { channelId: 'C1', threadRootId: 5 });
    disconnectSocket();
    expect(() => emitTyping('C1', null)).not.toThrow();
  });
});

describe('connection state', () => {
  it('tracks connect / disconnect and resyncs (and rejoins the call) only on reconnects', () => {
    vi.mocked(rejoinHuddle).mockClear();
    fire('connect');
    expect(S().connected).toBe(true);
    expect(resync).not.toHaveBeenCalled();
    expect(rejoinHuddle).not.toHaveBeenCalled();
    fire('disconnect');
    expect(S().connected).toBe(false);
    fire('connect');
    expect(resync).toHaveBeenCalledTimes(1);
    expect(rejoinHuddle).toHaveBeenCalledTimes(1);
  });

  it('marks disconnected on connect errors and redirects to login when unauthenticated', () => {
    const loc = { href: '/c/C1', pathname: '/c/C1' };
    vi.stubGlobal('location', loc);
    set((s) => void (s.connected = true));
    fire('connect_error', new Error('timeout'));
    expect(S().connected).toBe(false);
    expect(loc.href).toBe('/c/C1');
    fire('connect_error', new Error('not_authenticated'));
    expect(loc.href).toBe('/login');
  });

  it('redirects to login when the session is revoked', () => {
    const loc = { href: '/' };
    vi.stubGlobal('location', loc);
    fire('session:revoked');
    expect(loc.href).toBe('/login');
  });
});

describe('message events', () => {
  it('message:new stores the message, notifies and clears the author typing state', () => {
    set((s) => void (s.typing['C1:0'] = { U2: Date.now() + 5000, U3: Date.now() + 5000 }));
    const m = makeMessage({ id: 5, channelId: 'C1', userId: 'U2' });
    fire('message:new', m);
    expect(S().msgs[5]).toEqual(m);
    expect(S().memberships.C1.unread).toBe(1);
    expect(maybeNotify).toHaveBeenCalledWith(m);
    expect(Object.keys(S().typing['C1:0'])).toEqual(['U3']);
  });

  it('clears typing in the thread for thread replies', () => {
    set((s) => void (s.typing['C1:3'] = { U2: 1 }));
    fire('message:new', makeMessage({ id: 6, channelId: 'C1', userId: 'U2', threadRootId: 3 }));
    expect(S().typing['C1:3']).toEqual({});
  });

  // BUG (socket.ts message:new): the Composer reports typing under the thread key (draftKey(channel, rootId)),
  // but for "also send to channel" replies the handler clears draftKey(channel, null) instead.
  it('an also-in-channel thread reply should clear the author typing indicator in the thread', () => {
    set((s) => void (s.typing['C1:3'] = { U2: 1 }));
    fire('message:new', makeMessage({ id: 6, channelId: 'C1', userId: 'U2', threadRootId: 3, alsoInChannel: true }));
    expect(S().typing['C1:3']).toEqual({});
  });

  it('handles bot messages without a user and conversations nobody types in', () => {
    fire('message:new', makeMessage({ id: 7, userId: null, subtype: 'bot' }));
    fire('message:new', makeMessage({ id: 8, userId: 'U2', channelId: 'C2' }));
    expect(S().msgs[7]).toBeDefined();
    expect(S().typing).toEqual({});
  });

  it('message:updated replaces known messages and messages of loaded channels only', () => {
    set((s) => {
      s.msgs[5] = makeMessage({ id: 5, text: 'old' });
      s.chan.C2 = { ids: [], loaded: true, hasMoreAfter: false, hasMoreBefore: false, loading: false };
    });
    fire('message:updated', makeMessage({ id: 5, text: 'new' }));
    fire('message:updated', makeMessage({ id: 6, channelId: 'C2', text: 'in loaded channel' }));
    fire('message:updated', makeMessage({ id: 7, channelId: 'C1', text: 'unknown' }));
    expect(S().msgs[5].text).toBe('new');
    expect(S().msgs[6].text).toBe('in loaded channel');
    expect(S().msgs[7]).toBeUndefined();
  });

  it('message:deleted removes the message', () => {
    set((s) => {
      s.msgs[5] = makeMessage({ id: 5 });
      s.chan.C1 = { ids: [5], loaded: true, hasMoreAfter: false, hasMoreBefore: false, loading: false };
    });
    fire('message:deleted', { id: 5, channelId: 'C1', threadRootId: null });
    expect(S().msgs[5]).toBeUndefined();
    expect(S().chan.C1.ids).toEqual([]);
  });
});

describe('channel events', () => {
  it('channel:upsert ignores unknown public channels but stores others', () => {
    fire('channel:upsert', makeChannel({ id: 'C9', kind: 'public' }));
    expect(S().channels.C9).toBeUndefined();
    fire('channel:upsert', makeChannel({ id: 'C1', name: 'renamed' }));
    expect(S().channels.C1.name).toBe('renamed');
    fire('channel:upsert', makeChannel({ id: 'P1', kind: 'private' }));
    expect(S().channels.P1).toBeDefined();
    set((s) => void (s.memberships.C8 = makeMembership({ channelId: 'C8' })));
    fire('channel:upsert', makeChannel({ id: 'C8', kind: 'public' }));
    expect(S().channels.C8).toBeDefined();
  });

  it('channel:removed drops the membership, private channels and the active selection', () => {
    set((s) => void (s.activeChannelId = 'C2'));
    fire('channel:removed', { channelId: 'C2' });
    expect(S().memberships.C2).toBeUndefined();
    expect(S().channels.C2).toBeUndefined();
    expect(S().activeChannelId).toBeNull();
    fire('channel:removed', { channelId: 'C1' });
    expect(S().memberships.C1).toBeUndefined();
    expect(S().channels.C1).toBeDefined(); // public channels stay browsable
    fire('channel:removed', { channelId: 'C404' });
  });

  it('channel:removed navigates away from the removed channel', () => {
    history.pushState(null, '', '/c/C2/15');
    const pop = vi.fn();
    window.addEventListener('popstate', pop);
    fire('channel:removed', { channelId: 'C2' });
    expect(location.pathname).toBe('/');
    expect(pop).toHaveBeenCalled();
    window.removeEventListener('popstate', pop);

    history.pushState(null, '', '/c/C1');
    fire('channel:removed', { channelId: 'C2' });
    expect(location.pathname).toBe('/c/C1');
  });

  it('membership:upsert stores the membership', () => {
    fire('membership:upsert', makeMembership({ channelId: 'C1', starred: true }));
    expect(S().memberships.C1.starred).toBe(true);
  });
});

describe('user events', () => {
  it('user:upsert and presence', () => {
    fire('user:upsert', makeUser({ id: 'U3', username: 'new' }));
    fire('presence', { userId: 'U3', presence: 'active' });
    expect(S().users.U3.username).toBe('new');
    expect(S().presence.U3).toBe('active');
  });

  it('me:updated updates me, the users map and applies prefs', () => {
    fire('me:updated', makeMe({ id: 'U1', username: 'me2', prefs: { language: 'cs', colorMode: 'dark' } }));
    expect(S().me!.username).toBe('me2');
    expect(S().users.U1.username).toBe('me2');
    expect(document.documentElement.lang).toBe('cs');
    setLanguage('en');
  });

  it('typing records an expiry 6s ahead', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    fire('typing', { channelId: 'C1', threadRootId: null, userId: 'U2' });
    fire('typing', { channelId: 'C1', threadRootId: 4, userId: 'U2' });
    fire('typing', { channelId: 'C1', threadRootId: null, userId: 'U3' });
    expect(S().typing).toEqual({ 'C1:0': { U2: 1_006_000, U3: 1_006_000 }, 'C1:4': { U2: 1_006_000 } });
  });
});

describe('misc events', () => {
  it('saved:changed', () => {
    fire('saved:changed', { messageId: 5, saved: true });
    expect(S().saved[5]).toBe(true);
    fire('saved:changed', { messageId: 5, saved: false });
    expect(S().saved[5]).toBeUndefined();
  });

  it('draft:changed', () => {
    const d = { channelId: 'C1', threadRootId: 3, text: 'hi', updatedAt: 1 };
    fire('draft:changed', d);
    expect(S().drafts['C1:3']).toEqual(d);
    fire('draft:changed', { ...d, deleted: true });
    expect(S().drafts['C1:3']).toBeUndefined();
  });

  it('activity:new bumps the counter and refreshes counts', () => {
    fire('activity:new', {});
    fire('activity:new', {});
    expect(S().activityUnread).toBe(2);
    expect(refreshCounts).toHaveBeenCalledTimes(2);
  });

  it('thread:read only moves lastRead forward', () => {
    set((s) => void (s.threads[3] = { ids: [], loaded: true, following: true, lastRead: 10 }));
    fire('thread:read', { rootId: 3, lastRead: 8 });
    expect(S().threads[3].lastRead).toBe(10);
    fire('thread:read', { rootId: 3, lastRead: 12 });
    expect(S().threads[3].lastRead).toBe(12);
    fire('thread:read', { rootId: 99, lastRead: 1 });
    expect(S().threads[99]).toBeUndefined();
    expect(refreshCounts).toHaveBeenCalledTimes(3);
  });

  it('emoji:changed rebuilds the custom emoji map', () => {
    const list = [{ name: 'parrot', url: '/p.gif', createdBy: 'U1' }];
    fire('emoji:changed', list);
    expect(S().customEmojiList).toEqual(list);
    expect(S().customEmoji).toEqual({ parrot: '/p.gif' });
  });

  it('workspace:updated', () => {
    fire('workspace:updated', { name: 'New name' });
    expect(S().workspace?.name).toBe('New name');
  });

  it('agent:upsert / agent:removed', () => {
    fire('agent:upsert', { userId: 'U9', role: 'bot' });
    expect(S().agents.U9).toMatchObject({ role: 'bot' });
    fire('agent:removed', { userId: 'U9' });
    expect(S().agents.U9).toBeUndefined();
  });
});

describe('huddle events', () => {
  it('huddle:state stores the huddle and forwards it', () => {
    const h = { channelId: 'C1', participants: [{ userId: 'U2', muted: false, sharing: false, video: false }], startedAt: 1 };
    fire('huddle:state', h);
    expect(S().huddles.C1).toEqual(h);
    expect(huddleStateChanged).toHaveBeenCalledWith(h);
  });

  it('huddle:ended removes the huddle', () => {
    set((s) => void (s.huddles.C1 = { channelId: 'C1', participants: [], startedAt: 1 }));
    fire('huddle:ended', { channelId: 'C1' });
    expect(S().huddles.C1).toBeUndefined();
    expect(huddleEnded).toHaveBeenCalledWith('C1');
  });

  it('huddle:signal is forwarded', () => {
    const p = { from: 'U2', channelId: 'C1', data: { candidate: {} } };
    fire('huddle:signal', p);
    expect(huddleSignal).toHaveBeenCalledWith(p);
  });
});

describe('remote server', () => {
  it('passes the server URL and bearer token to socket.io', async () => {
    localStorage.setItem('relay.server', 'https://chat.example.com');
    localStorage.setItem('relay.token', 'tok');
    vi.resetModules();
    const { io: freshIo } = await import('socket.io-client');
    const fresh = await import('./socket.ts');
    fresh.connectSocket();
    expect(freshIo).toHaveBeenLastCalledWith('https://chat.example.com', expect.objectContaining({ auth: { token: 'tok' } }));
    localStorage.clear();
  });
});
