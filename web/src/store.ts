import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import type {
  AgentInfo,
  Channel,
  CustomEmoji,
  Draft,
  HuddleState,
  Me,
  Membership,
  Message,
  Presence,
  User,
  Workspace,
} from '../../shared/types.ts';

enableMapSet();

export interface ChannelMsgs {
  ids: number[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  loading: boolean;
  loaded: boolean;
}

export interface ThreadState {
  ids: number[];
  loaded: boolean;
  following: boolean;
  lastRead: number;
}

export type RightPanel =
  | { type: 'thread'; rootId: number; channelId: string; highlightId?: number }
  | { type: 'profile'; userId: string }
  | { type: 'pins'; channelId: string }
  | { type: 'files'; channelId: string };

export type Modal =
  | { type: 'createChannel'; name?: string }
  | { type: 'channelDetails'; channelId: string; tab?: 'about' | 'members' | 'settings' }
  | { type: 'newMessage' }
  | { type: 'preferences'; tab?: string }
  | { type: 'editProfile' }
  | { type: 'setStatus' }
  | { type: 'invite' }
  | { type: 'admin'; tab?: string }
  | { type: 'quickSwitcher' }
  | { type: 'addMembers'; channelId: string }
  | { type: 'image'; fileId: string; messageId: number }
  | { type: 'shortcuts' }
  | { type: 'schedule'; channelId: string; threadRootId: number | null; text: string; fileIds?: string[]; onDone?: () => void }
  | { type: 'forward'; messageId: number }
  | { type: 'confirm'; title: string; body: string; danger?: boolean; confirmLabel?: string; onConfirm: () => void | Promise<void> }
  | { type: 'agent'; userId?: string; template?: string }
  | { type: 'remind'; messageId: number }
  | { type: 'section'; sectionId?: string; channelId?: string };

export interface Toast {
  id: number;
  text: string;
  kind?: 'error' | 'info';
}

export interface State {
  status: 'loading' | 'ready' | 'unauth' | 'setup' | 'error';
  connected: boolean;
  me: Me | null;
  workspace: Workspace | null;
  users: Record<string, User>;
  channels: Record<string, Channel>;
  memberships: Record<string, Membership>;
  presence: Record<string, Presence>;
  saved: Record<number, true>;
  drafts: Record<string, Draft>;
  customEmoji: Record<string, string>;
  customEmojiList: CustomEmoji[];
  huddles: Record<string, HuddleState>;
  agents: Record<string, AgentInfo>;
  activityUnread: number;
  threadsUnread: number;

  msgs: Record<number, Message>;
  chan: Record<string, ChannelMsgs>;
  threads: Record<number, ThreadState>;
  typing: Record<string, Record<string, number>>;

  activeChannelId: string | null;
  right: RightPanel | null;
  modal: Modal | null;
  editingId: number | null;
  highlightId: number | null;
  unreadMarker: Record<string, number>;
  toasts: Toast[];
  focused: boolean;
}

export const useStore = create<State>()(
  immer(() => ({
    status: 'loading',
    connected: false,
    me: null,
    workspace: null,
    users: {},
    channels: {},
    memberships: {},
    presence: {},
    saved: {},
    drafts: {},
    customEmoji: {},
    customEmojiList: [],
    huddles: {},
    agents: {},
    activityUnread: 0,
    threadsUnread: 0,
    msgs: {},
    chan: {},
    threads: {},
    typing: {},
    activeChannelId: null,
    right: null,
    modal: null,
    editingId: null,
    highlightId: null,
    unreadMarker: {},
    toasts: [],
    focused: typeof document !== 'undefined' ? document.hasFocus() : true,
  })) as any,
);

export const S = () => useStore.getState();
export const set = (fn: (s: State) => void) => useStore.setState(fn as any);

export const draftKey = (channelId: string, rootId?: number | null) => `${channelId}:${rootId || 0}`;

let toastSeq = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastSeq;
  set((s) => {
    s.toasts.push({ id, text, kind });
  });
  setTimeout(() => set((s) => void (s.toasts = s.toasts.filter((t) => t.id !== id))), kind === 'error' ? 6000 : 3500);
}

// ---------- selectors / helpers ----------

export function displayName(u: User | undefined | null) {
  if (!u) return '';
  return u.displayName || u.fullName || u.username;
}

export function userName(id: string | null | undefined) {
  if (!id) return '';
  return displayName(S().users[id]) || 'Unknown';
}

/** Title for a channel – DMs use the other members' names. */
export function channelTitle(c: Channel | undefined, meId?: string): string {
  if (!c) return '';
  if (c.kind === 'dm' || c.kind === 'group') {
    const me = meId ?? S().me?.id;
    const others = (c.memberIds ?? []).filter((id) => id !== me);
    if (!others.length) return userName(me);
    return others.map((id) => userName(id)).join(', ');
  }
  return c.name;
}

export function dmPartner(c: Channel | undefined): string | null {
  if (!c || c.kind !== 'dm') return null;
  const me = S().me?.id;
  return (c.memberIds ?? []).find((id) => id !== me) ?? me ?? null;
}

export function isDmKind(c: Channel | undefined) {
  return c?.kind === 'dm' || c?.kind === 'group';
}

export function upsertMessages(s: State, list: Message[]) {
  for (const m of list) s.msgs[m.id] = m;
}

export function isAdmin(u: { role: string } | null | undefined) {
  return u?.role === 'owner' || u?.role === 'admin';
}
