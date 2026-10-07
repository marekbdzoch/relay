import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../shared/types.ts';
import { matchesKeyword, maybeNotify, mentionsMe, notificationPermission, outsideWorkingHours, playKnock, requestNotificationPermission, updateTitleBadge } from './notify.ts';
import { loadEmojiData } from './emoji.ts';
import { setNavigate } from './nav.ts';
import { S, set } from '../store.ts';
import { makeChannel, makeMe, makeMembership, makeMessage, makeUser, mockFetch, resetStore } from '../test/helpers.ts';

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static instances: FakeNotification[] = [];
  static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    FakeNotification.instances.push(this);
  }
}

const nav = vi.fn();
beforeAll(() => loadEmojiData());

function setup(prefs: Partial<ReturnType<typeof makeMe>['prefs']> = {}) {
  resetStore({
    me: makeMe({ id: 'U1', username: 'me', prefs }),
    users: { U1: makeUser({ id: 'U1', username: 'me' }), U2: makeUser({ id: 'U2', username: 'jana', displayName: 'Jana' }) },
    channels: {
      C1: makeChannel({ id: 'C1', name: 'general' }),
      D1: makeChannel({ id: 'D1', kind: 'dm', name: '', memberIds: ['U1', 'U2'] }),
    },
    memberships: { C1: makeMembership({ channelId: 'C1' }), D1: makeMembership({ channelId: 'D1' }) },
    focused: false,
  });
}

beforeEach(() => {
  FakeNotification.permission = 'granted';
  FakeNotification.instances = [];
  vi.stubGlobal('Notification', FakeNotification);
  nav.mockReset();
  setNavigate(nav);
  setup();
});

describe('playKnock', () => {
  it('plays two oscillator tones', () => {
    const osc = { type: '', frequency: { value: 0 }, connect: vi.fn((n) => n), start: vi.fn(), stop: vi.fn() };
    const gain = { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn((n) => n) };
    const ctor = vi.fn(function (this: any) {
      this.currentTime = 1;
      this.destination = {};
      this.createOscillator = () => ({ ...osc });
      this.createGain = () => gain;
    });
    vi.stubGlobal('AudioContext', ctor);
    playKnock();
    playKnock();
    // the context is created lazily and reused
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(gain.gain.setValueAtTime).toHaveBeenCalled();
  });

  it('never throws when audio is unavailable', async () => {
    vi.resetModules();
    vi.stubGlobal('AudioContext', function () {
      throw new Error('no audio');
    });
    const fresh = await import('./notify.ts');
    expect(() => fresh.playKnock()).not.toThrow();
  });
});

describe('notification permission', () => {
  it('reports the current permission', () => {
    FakeNotification.permission = 'denied';
    expect(notificationPermission()).toBe('denied');
  });

  it('requests permission', async () => {
    await expect(requestNotificationPermission()).resolves.toBe('granted');
    expect(FakeNotification.requestPermission).toHaveBeenCalled();
  });

  it('handles browsers without the Notification API', async () => {
    vi.stubGlobal('Notification', undefined);
    expect(notificationPermission()).toBe('unsupported');
    await expect(requestNotificationPermission()).resolves.toBe('unsupported');
  });
});

describe('mentionsMe', () => {
  it('detects direct and broadcast mentions', () => {
    expect(mentionsMe('hi <@U1>', 'U1')).toBe(true);
    expect(mentionsMe('hi <@U12>', 'U1')).toBe(false);
    expect(mentionsMe('<!here> folks', 'U1')).toBe(true);
    expect(mentionsMe('<!channel>', 'U1')).toBe(true);
    expect(mentionsMe('<!everyone>', 'U1')).toBe(true);
    expect(mentionsMe('@here (plain text)', 'U1')).toBe(false);
  });
});

describe('outsideWorkingHours', () => {
  // 2026-10-07 is a Wednesday, 2026-10-10 a Saturday (TZ=UTC)
  const wed = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 7, h, m));
  const sat = new Date(Date.UTC(2026, 9, 10, 12));
  const sun = new Date(Date.UTC(2026, 9, 11, 12));

  it('is never outside when working hours are disabled or not logged in', () => {
    expect(outsideWorkingHours(wed(3))).toBe(false);
    setup({ workingHours: { enabled: false, days: 'every', from: '09:00', to: '17:00' } });
    expect(outsideWorkingHours(wed(3))).toBe(false);
    resetStore();
    expect(outsideWorkingHours(wed(3))).toBe(false);
  });

  it('checks the time window (from inclusive, to exclusive)', () => {
    setup({ workingHours: { enabled: true, days: 'every', from: '09:30', to: '17:00' } });
    expect(outsideWorkingHours(wed(9, 29))).toBe(true);
    expect(outsideWorkingHours(wed(9, 30))).toBe(false);
    expect(outsideWorkingHours(wed(16, 59))).toBe(false);
    expect(outsideWorkingHours(wed(17, 0))).toBe(true);
    expect(outsideWorkingHours(sat)).toBe(false);
  });

  it('treats weekends as outside for weekday schedules', () => {
    setup({ workingHours: { enabled: true, days: 'weekdays', from: '09:00', to: '17:00' } });
    expect(outsideWorkingHours(sat)).toBe(true);
    expect(outsideWorkingHours(sun)).toBe(true);
    expect(outsideWorkingHours(wed(12))).toBe(false);
  });

  it('defaults to the current time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(wed(20));
    setup({ workingHours: { enabled: true, days: 'every', from: '09:00', to: '17:00' } });
    expect(outsideWorkingHours()).toBe(true);
  });
});

describe('matchesKeyword', () => {
  it('returns false without keywords', () => {
    expect(matchesKeyword('deploy')).toBe(false);
    setup({ keywords: ' , ' });
    expect(matchesKeyword('deploy')).toBe(false);
  });

  it('matches whole words case-insensitively', () => {
    setup({ keywords: 'Deploy, release ,ops' });
    expect(matchesKeyword('time to DEPLOY!')).toBe(true);
    expect(matchesKeyword('release')).toBe(true);
    expect(matchesKeyword('redeployment')).toBe(false);
    expect(matchesKeyword('devops')).toBe(false);
    expect(matchesKeyword('ops.')).toBe(true);
  });

  it('escapes regex characters and works with unicode letters', () => {
    setup({ keywords: 'c++, a.b, účet' });
    expect(matchesKeyword('I love c++ a lot')).toBe(true);
    expect(matchesKeyword('axb')).toBe(false);
    expect(matchesKeyword('a.b')).toBe(true);
    expect(matchesKeyword('Účet je hotový')).toBe(true);
    expect(matchesKeyword('účetnictví')).toBe(false);
  });

  it('matches on the plain-text rendering (mentions resolved)', () => {
    setup({ keywords: 'jana' });
    expect(matchesKeyword('ping <@U2>')).toBe(true); // "<@U2>" renders as "@Jana"
    setup({ keywords: 'U2' });
    expect(matchesKeyword('ping <@U2>')).toBe(false);
  });
});

describe('maybeNotify', () => {
  const msg = (p: Partial<Message> = {}) => makeMessage({ id: 10, channelId: 'C1', userId: 'U2', text: 'hello <@U1>', ...p });
  let knocks: number;
  beforeEach(() => {
    knocks = 0;
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function (this: any) {
        knocks++;
        throw new Error('count only');
      }),
    );
  });
  const last = () => FakeNotification.instances.at(-1);

  it('shows a notification for a mention in a channel', () => {
    maybeNotify(msg());
    expect(FakeNotification.instances).toHaveLength(1);
    expect(last()!.title).toBe('Jana (#general)');
    expect(last()!.options).toMatchObject({ body: 'hello @me', tag: 'msg-10', silent: true });
  });

  it('ignores own messages, system messages and when logged out', () => {
    maybeNotify(msg({ userId: 'U1' }));
    maybeNotify(msg({ subtype: 'join' }));
    resetStore();
    maybeNotify(msg());
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('notifies for bot messages and uses the bot name', () => {
    maybeNotify(msg({ subtype: 'bot', userId: null, botName: 'CI' }));
    expect(last()!.title).toBe('CI (#general)');
  });

  it('respects do-not-disturb', () => {
    set((s) => void (s.me!.dndUntil = Date.now() + 60_000));
    maybeNotify(msg());
    expect(FakeNotification.instances).toHaveLength(0);
    set((s) => void (s.me!.dndUntil = Date.now() - 1));
    maybeNotify(msg());
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it('respects working hours', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 7, 22));
    setup({ workingHours: { enabled: true, days: 'every', from: '09:00', to: '17:00' } });
    maybeNotify(msg());
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('ignores unknown channels, non-member channels and muted channels', () => {
    maybeNotify(msg({ channelId: 'C404' }));
    set((s) => void (s.channels.C2 = makeChannel({ id: 'C2' })));
    maybeNotify(msg({ channelId: 'C2' }));
    set((s) => void (s.memberships.C1.muted = true));
    maybeNotify(msg());
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('applies the per-channel and global notification level', () => {
    // global default: mentions only
    maybeNotify(msg({ text: 'no mention' }));
    expect(FakeNotification.instances).toHaveLength(0);

    set((s) => void (s.memberships.C1.notify = 'all'));
    maybeNotify(msg({ text: 'no mention' }));
    expect(FakeNotification.instances).toHaveLength(1);

    set((s) => void (s.memberships.C1.notify = 'none'));
    maybeNotify(msg());
    expect(FakeNotification.instances).toHaveLength(1);

    setup({ notifyLevel: 'all' });
    maybeNotify(msg({ text: 'anything' }));
    expect(FakeNotification.instances).toHaveLength(2);

    setup({ notifyLevel: 'none' });
    maybeNotify(msg());
    expect(FakeNotification.instances).toHaveLength(2);
  });

  it('always notifies for direct messages and titles them with the author only', () => {
    maybeNotify(msg({ channelId: 'D1', text: 'psst' }));
    expect(last()!.title).toBe('Jana');
  });

  it('notifies for keyword matches', () => {
    setup({ keywords: 'deploy' });
    maybeNotify(msg({ text: 'deploy is done' }));
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it('notifies for replies in threads I started or replied to', () => {
    set((s) => {
      s.msgs[5] = makeMessage({ id: 5, userId: 'U1' });
      s.msgs[6] = makeMessage({ id: 6, userId: 'U2', replyUserIds: ['U1'] });
      s.msgs[7] = makeMessage({ id: 7, userId: 'U2' });
    });
    maybeNotify(msg({ text: 'reply', threadRootId: 5 }));
    expect(last()!.title).toBe('Jana (#general) in a thread');
    maybeNotify(msg({ text: 'reply', threadRootId: 6 }));
    expect(FakeNotification.instances).toHaveLength(2);
    maybeNotify(msg({ text: 'reply', threadRootId: 7 }));
    maybeNotify(msg({ text: 'reply', threadRootId: 404 }));
    expect(FakeNotification.instances).toHaveLength(2);
  });

  it('skips thread notifications when disabled in prefs', () => {
    setup({ notifyThreads: false });
    set((s) => void (s.msgs[5] = makeMessage({ id: 5, userId: 'U1' })));
    maybeNotify(msg({ text: 'reply', threadRootId: 5 }));
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('stays quiet while the user is looking at the conversation', () => {
    set((s) => {
      s.focused = true;
      s.activeChannelId = 'C1';
    });
    maybeNotify(msg());
    expect(FakeNotification.instances).toHaveLength(0);

    // thread reply while the thread is open
    set((s) => {
      s.activeChannelId = 'C9';
      s.right = { type: 'thread', rootId: 5, channelId: 'C1' };
      s.msgs[5] = makeMessage({ id: 5, userId: 'U1' });
    });
    maybeNotify(msg({ threadRootId: 5 }));
    expect(FakeNotification.instances).toHaveLength(0);

    // a reply also sent to the channel counts as channel activity
    maybeNotify(msg({ threadRootId: 5, alsoInChannel: true }));
    expect(FakeNotification.instances).toHaveLength(1);

    // not focused → notify even when the channel is active
    set((s) => {
      s.focused = false;
      s.activeChannelId = 'C1';
    });
    maybeNotify(msg());
    expect(FakeNotification.instances).toHaveLength(2);
  });

  it('plays a sound unless disabled', async () => {
    // fresh module graph so no AudioContext has been cached yet; the stub throws so every knock retries
    vi.resetModules();
    const fresh = await import('./notify.ts');
    const h = await import('../test/helpers.ts');
    const base = {
      users: { U2: makeUser({ id: 'U2', username: 'jana' }) },
      channels: { C1: makeChannel({ id: 'C1', name: 'general' }) },
      memberships: { C1: makeMembership({ channelId: 'C1' }) },
    };
    h.resetStore({ ...base, me: makeMe({ id: 'U1', prefs: {} }) });
    fresh.maybeNotify(msg());
    expect(knocks).toBe(1);
    h.resetStore({ ...base, me: makeMe({ id: 'U1', prefs: { notifySound: false } }) });
    fresh.maybeNotify(msg());
    expect(knocks).toBe(1);
    expect(FakeNotification.instances).toHaveLength(2);
  });

  it('does not show a system notification without permission', () => {
    FakeNotification.permission = 'default';
    maybeNotify(msg());
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('hides previews when configured and describes file-only messages', () => {
    setup({ showMessagePreviews: false });
    maybeNotify(msg());
    expect(last()!.options.body).toBe('New message');
    setup({ notifyLevel: 'all' });
    maybeNotify(msg({ text: '', files: [{ id: 'F1' } as any] }));
    expect(last()!.options.body).toBe('Shared a file');
    maybeNotify(msg({ text: '' }));
    expect(last()!.options.body).toBe('');
  });

  it('truncates long bodies to 200 characters', () => {
    maybeNotify(msg({ text: '<@U1> ' + 'x'.repeat(500) }));
    expect(last()!.options.body).toHaveLength(200);
  });

  it('opens the channel at the message when clicked', () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    maybeNotify(msg());
    last()!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(nav).toHaveBeenCalledWith('/c/C1/10', undefined);
    expect(last()!.close).toHaveBeenCalled();
  });

  it('opens the thread when a thread reply notification is clicked', () => {
    mockFetch({ 'GET /api/messages/5/thread': { root: makeMessage({ id: 5, userId: 'U1' }), replies: [], following: true, lastRead: 0 } });
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    set((s) => void (s.msgs[5] = makeMessage({ id: 5, userId: 'U1' })));
    maybeNotify(msg({ threadRootId: 5 }));
    last()!.onclick!();
    expect(nav).toHaveBeenCalledWith('/c/C1', undefined);
    expect(S().right).toEqual({ type: 'thread', rootId: 5, channelId: 'C1', highlightId: undefined });
  });

  it('swallows errors from the Notification constructor', () => {
    vi.stubGlobal(
      'Notification',
      Object.assign(
        function () {
          throw new Error('Illegal constructor');
        },
        { permission: 'granted' },
      ),
    );
    expect(() => maybeNotify(msg())).not.toThrow();
  });
});

describe('updateTitleBadge', () => {
  afterEach(() => {
    delete (window as any).relayDesktop;
  });

  it('shows the workspace name or Relay', () => {
    updateTitleBadge();
    expect(document.title).toBe('Relay');
    set((s) => void (s.workspace = { name: 'Acme' } as any));
    updateTitleBadge();
    expect(document.title).toBe('Acme');
  });

  it('includes the active channel', () => {
    set((s) => {
      s.workspace = { name: 'Acme' } as any;
      s.activeChannelId = 'C1';
    });
    updateTitleBadge();
    expect(document.title).toBe('#general - Acme');
    set((s) => void (s.activeChannelId = 'D1'));
    updateTitleBadge();
    expect(document.title).toBe('Jana - Acme');
    set((s) => void (s.workspace = null));
    updateTitleBadge();
    expect(document.title).toBe('Jana - Relay');
  });

  it('counts channel mentions and all DM unreads, ignoring muted/hidden/unknown', () => {
    const setBadge = vi.fn();
    (window as any).relayDesktop = { setBadge };
    set((s) => {
      s.memberships.C1.unread = 5;
      s.memberships.C1.mentions = 2;
      s.memberships.D1.unread = 3;
      s.memberships.C2 = makeMembership({ channelId: 'C2', unread: 9, mentions: 9, muted: true });
      s.memberships.C3 = makeMembership({ channelId: 'C3', unread: 9, mentions: 9 });
      s.channels.C2 = makeChannel({ id: 'C2' });
      s.memberships.D2 = makeMembership({ channelId: 'D2', unread: 9, hidden: true });
      s.channels.D2 = makeChannel({ id: 'D2', kind: 'group', memberIds: ['U1', 'U2'] });
    });
    updateTitleBadge();
    expect(document.title).toBe('(5) Relay');
    expect(setBadge).toHaveBeenCalledWith(5);
  });

  it('marks unread messages without mentions with an asterisk', () => {
    const setBadge = vi.fn();
    (window as any).relayDesktop = { setBadge };
    set((s) => void (s.memberships.C1.unread = 4));
    updateTitleBadge();
    expect(document.title).toBe('* Relay');
    expect(setBadge).toHaveBeenLastCalledWith('•');
    set((s) => void (s.memberships.C1.unread = 0));
    updateTitleBadge();
    expect(setBadge).toHaveBeenLastCalledWith('');
  });
});
