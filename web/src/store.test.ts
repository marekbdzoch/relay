import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S, channelTitle, displayName, dmPartner, draftKey, isAdmin, isDmKind, set, toast, upsertMessages, useStore, userName } from './store.ts';
import { makeChannel, makeMe, makeMessage, makeUser, resetStore } from './test/helpers.ts';

beforeEach(() => {
  resetStore({
    me: makeMe({ id: 'U1', username: 'me' }),
    users: {
      U1: makeUser({ id: 'U1', username: 'me', fullName: 'Marek' }),
      U2: makeUser({ id: 'U2', username: 'jana', fullName: 'Jana Nováková', displayName: 'Jana' }),
      U3: makeUser({ id: 'U3', username: 'petr' }),
    },
  });
});

describe('initial state', () => {
  it('starts loading and disconnected', () => {
    resetStore();
    expect(S()).toMatchObject({ status: 'loading', connected: false, me: null, toasts: [], activeChannelId: null });
    expect(typeof S().focused).toBe('boolean');
  });
});

describe('set()', () => {
  it('applies immer drafts and notifies subscribers', () => {
    const listener = vi.fn();
    const unsub = useStore.subscribe(listener);
    set((s) => void (s.activityUnread = 3));
    expect(S().activityUnread).toBe(3);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });
});

describe('draftKey', () => {
  it('combines channel and thread root', () => {
    expect(draftKey('C1')).toBe('C1:0');
    expect(draftKey('C1', null)).toBe('C1:0');
    expect(draftKey('C1', 0)).toBe('C1:0');
    expect(draftKey('C1', 42)).toBe('C1:42');
  });
});

describe('toast', () => {
  it('adds toasts and removes them after a delay depending on the kind', () => {
    vi.useFakeTimers();
    toast('Saved');
    toast('Failed', 'error');
    expect(S().toasts.map((t) => [t.text, t.kind])).toEqual([
      ['Saved', 'info'],
      ['Failed', 'error'],
    ]);
    const [a, b] = S().toasts;
    expect(b.id).toBeGreaterThan(a.id);
    vi.advanceTimersByTime(3500);
    expect(S().toasts.map((t) => t.text)).toEqual(['Failed']);
    vi.advanceTimersByTime(2500);
    expect(S().toasts).toEqual([]);
  });
});

describe('displayName / userName', () => {
  it('prefers display name, then full name, then username', () => {
    expect(displayName(S().users.U2)).toBe('Jana');
    expect(displayName(S().users.U1)).toBe('Marek');
    expect(displayName(S().users.U3)).toBe('petr');
    expect(displayName(null)).toBe('');
    expect(displayName(undefined)).toBe('');
  });

  it('looks users up by id', () => {
    expect(userName('U2')).toBe('Jana');
    expect(userName('U404')).toBe('Unknown');
    expect(userName(null)).toBe('');
    expect(userName(undefined)).toBe('');
  });
});

describe('channelTitle', () => {
  it('uses the channel name for public/private channels', () => {
    expect(channelTitle(makeChannel({ id: 'C1', name: 'general' }))).toBe('general');
    expect(channelTitle(makeChannel({ id: 'C2', name: 'secret', kind: 'private' }))).toBe('secret');
    expect(channelTitle(undefined)).toBe('');
  });

  it('uses the other members for DMs and group DMs', () => {
    expect(channelTitle(makeChannel({ id: 'D1', kind: 'dm', name: '', memberIds: ['U1', 'U2'] }))).toBe('Jana');
    expect(channelTitle(makeChannel({ id: 'G1', kind: 'group', name: '', memberIds: ['U1', 'U2', 'U3'] }))).toBe('Jana, petr');
  });

  it('shows my own name for a self-DM and supports an explicit me id', () => {
    expect(channelTitle(makeChannel({ id: 'D0', kind: 'dm', name: '', memberIds: ['U1'] }))).toBe('Marek');
    expect(channelTitle(makeChannel({ id: 'D1', kind: 'dm', name: '', memberIds: ['U1', 'U2'] }), 'U2')).toBe('Marek');
    expect(channelTitle(makeChannel({ id: 'D9', kind: 'dm', name: '' }))).toBe('Marek');
  });
});

describe('dmPartner', () => {
  it('returns the other DM member, me for self-DMs, and null otherwise', () => {
    expect(dmPartner(makeChannel({ id: 'D1', kind: 'dm', memberIds: ['U1', 'U2'] }))).toBe('U2');
    expect(dmPartner(makeChannel({ id: 'D0', kind: 'dm', memberIds: ['U1'] }))).toBe('U1');
    expect(dmPartner(makeChannel({ id: 'D9', kind: 'dm' }))).toBe('U1');
    expect(dmPartner(makeChannel({ id: 'G1', kind: 'group', memberIds: ['U1', 'U2'] }))).toBeNull();
    expect(dmPartner(makeChannel({ id: 'C1' }))).toBeNull();
    expect(dmPartner(undefined)).toBeNull();
    resetStore();
    expect(dmPartner(makeChannel({ id: 'D0', kind: 'dm', memberIds: [] }))).toBeNull();
  });
});

describe('isDmKind / isAdmin / upsertMessages', () => {
  it('classifies channels', () => {
    expect(isDmKind(makeChannel({ id: 'a', kind: 'dm' }))).toBe(true);
    expect(isDmKind(makeChannel({ id: 'a', kind: 'group' }))).toBe(true);
    expect(isDmKind(makeChannel({ id: 'a', kind: 'public' }))).toBe(false);
    expect(isDmKind(undefined)).toBe(false);
  });

  it('recognises admins', () => {
    expect(isAdmin({ role: 'owner' })).toBe(true);
    expect(isAdmin({ role: 'admin' })).toBe(true);
    expect(isAdmin({ role: 'member' })).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });

  it('upserts messages by id', () => {
    set((s) => upsertMessages(s, [makeMessage({ id: 1 }), makeMessage({ id: 2, text: 'a' })]));
    set((s) => upsertMessages(s, [makeMessage({ id: 2, text: 'b' })]));
    expect(Object.keys(S().msgs)).toEqual(['1', '2']);
    expect(S().msgs[2].text).toBe('b');
  });
});
