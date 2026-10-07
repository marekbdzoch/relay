import { vi } from 'vitest';
import type { Channel, Me, Membership, Message, User } from '../../../shared/types.ts';
import { useStore, type State } from '../store.ts';

const initialState: State = structuredClone(
  Object.fromEntries(Object.entries(useStore.getState()).filter(([, v]) => typeof v !== 'function')),
) as State;

/** Restores the zustand store to its pristine initial state. */
export function resetStore(patch: Partial<State> = {}) {
  useStore.setState({ ...structuredClone(initialState), ...patch } as State, true);
}

export function makeUser(p: Partial<User> & { id: string }): User {
  return {
    username: p.id.toLowerCase(),
    fullName: '',
    displayName: '',
    title: '',
    phone: '',
    timezone: 'Europe/Prague',
    avatarUrl: null,
    avatarColor: '#123456',
    role: 'member',
    statusEmoji: '',
    statusText: '',
    statusExpiresAt: null,
    dndUntil: null,
    deactivated: false,
    isBot: false,
    external: null,
    createdAt: 0,
    ...p,
  };
}

export function makeMe(p: Partial<Me> & { id: string }): Me {
  return { ...makeUser(p), email: `${p.id}@example.com`, prefs: {}, awayManual: false, ...p } as Me;
}

export function makeChannel(p: Partial<Channel> & { id: string }): Channel {
  return {
    kind: 'public',
    name: p.id.toLowerCase(),
    topic: '',
    description: '',
    createdBy: null,
    createdAt: 0,
    archived: false,
    isDefault: false,
    memberCount: 1,
    lastMessageAt: null,
    bridge: null,
    ...p,
  };
}

export function makeMembership(p: Partial<Membership> & { channelId: string }): Membership {
  return { lastRead: 0, starred: false, muted: false, notify: 'default', hidden: false, unread: 0, mentions: 0, joinedAt: 0, ...p };
}

export function makeMessage(p: Partial<Message> & { id: number; channelId?: string }): Message {
  return {
    channelId: 'C1',
    userId: 'U2',
    text: 'hello',
    subtype: null,
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    replyUserIds: [],
    alsoInChannel: false,
    createdAt: p.id * 1000,
    editedAt: null,
    deleted: false,
    reactions: [],
    files: [],
    unfurls: [],
    pinnedBy: null,
    ...p,
  };
}

/** A `fetch` mock driven by a route table: `{ 'GET /api/x': body | (req) => body | Response }`. */
export type Route = unknown | ((init: { method: string; url: string; body: any }) => unknown);
export function mockFetch(routes: Record<string, Route> = {}) {
  const fn = vi.fn(async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && (p === path || (p.endsWith('*') && path.startsWith(p.slice(0, -1))));
    });
    if (!key) return jsonResponse({ error: 'not_found', message: `No route ${method} ${path}` }, 404);
    const r = routes[key];
    const out = typeof r === 'function' ? await (r as any)({ method, url: path, body }) : r;
    return out instanceof Response ? out : jsonResponse(out ?? {});
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Parsed JSON body of the n-th fetch call. */
export function bodyOf(fn: { mock: { calls: unknown[][] } }, n = 0): any {
  const init = fn.mock.calls[n]?.[1] as RequestInit | undefined;
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

export function jsonResponse(body: unknown, status = 200, statusText = '') {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, statusText, headers: { 'content-type': 'application/json' } });
}

/** Flush pending promise callbacks (works with fake timers as well). */
export async function flush(times = 5) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
