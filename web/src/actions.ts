import type { BootstrapResponse, Channel, FileInfo, Me, Membership, Message, MessagesPage, UserPrefs } from '../../shared/types.ts';
import { ApiError, DEL, GET, PATCH, POST, PUT, setToken } from './api.ts';
import { S, draftKey, set, toast, upsertMessages, type ChannelMsgs, type Modal, type RightPanel } from './store.ts';
import { channelPath, navigate } from './lib/nav.ts';
import { connectSocket, disconnectSocket, emitTyping } from './socket.ts';
import { setLanguage, t } from './i18n.ts';
import { mentionsMe, updateTitleBadge } from './lib/notify.ts';
import { applyTheme } from './lib/theme.ts';
import { loadEmojiData } from './lib/emoji.ts';

export function errorMessage(e: unknown) {
  if (e instanceof ApiError) {
    const map: Record<string, string> = {
      invalid_credentials: t('Wrong email or password.'),
      invalid_setup_code: t('The setup code is not correct. You can find it in the server logs or in the SETUP_TOKEN variable.'),
      already_setup: t('This workspace has already been set up. Sign in instead.'),
      demo_disabled: t('This is turned off in the demo.'),
      email_taken: t('An account with this email already exists.'),
      claim_needs_personal_invite: t('This e-mail belongs to an account imported from Slack. Ask an admin for a personal invite link for this address.'),
      name_taken: t('A channel with that name already exists.'),
      not_in_channel: t('You are not a member of this channel.'),
      channel_archived: t('This channel is archived.'),
      file_too_large: t('The file is too large.'),
      invite_invalid: t('This invite link is invalid or has expired.'),
      signup_not_allowed: t('Sign up requires an invitation.'),
      username_taken: t('That username is taken.'),
      wrong_password: t('The current password is incorrect.'),
      account_deactivated: t('This account has been deactivated.'),
      cannot_leave_general: t('Everyone stays in #general.'),
      network_error: t('Network error – check your connection.'),
    };
    return map[e.code] ?? e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function fail(e: unknown) {
  if (e instanceof ApiError && e.code === 'aborted') return;
  toast(errorMessage(e), 'error');
}

// ---------- boot ----------

export function applyBootstrap(b: BootstrapResponse) {
  set((s) => {
    s.me = b.me;
    s.workspace = b.workspace;
    s.users = Object.fromEntries(b.users.map((u) => [u.id, u]));
    s.channels = Object.fromEntries(b.channels.map((c) => [c.id, c]));
    s.memberships = Object.fromEntries(b.memberships.map((m) => [m.channelId, m]));
    s.presence = b.presence;
    s.saved = Object.fromEntries(b.savedIds.map((id) => [id, true as const]));
    s.drafts = Object.fromEntries(b.drafts.map((d) => [draftKey(d.channelId, d.threadRootId), d]));
    s.customEmoji = Object.fromEntries(b.customEmoji.map((e) => [e.name, e.url]));
    s.customEmojiList = b.customEmoji;
    s.huddles = Object.fromEntries(b.huddles.map((h) => [h.channelId, h]));
    s.agents = Object.fromEntries(b.agents.map((a) => [a.userId, a]));
    s.activityUnread = b.activityUnread;
    s.threadsUnread = b.threadsUnread;
    s.status = 'ready';
  });
  applyMePrefs(b.me);
  updateTitleBadge();
}

export function applyMePrefs(me: Me) {
  if (me.prefs.language) setLanguage(me.prefs.language);
  applyTheme(me.prefs.theme, me.prefs.colorMode);
}

export async function boot() {
  try {
    const setup = await GET<{ needsSetup: boolean }>('/api/setup/status');
    if (setup.needsSetup) return set((s) => void (s.status = 'setup'));
    // emoji data loads in parallel with the bootstrap request
    const [b] = await Promise.all([GET<BootstrapResponse>('/api/bootstrap'), loadEmojiData().catch(() => {})]);
    applyBootstrap(b);
    connectSocket();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) set((s) => void (s.status = 'unauth'));
    else set((s) => void (s.status = 'error'));
  }
}

/** After a reconnect: refresh state and fetch anything we missed. */
export async function resync() {
  try {
    const b = await GET<BootstrapResponse>('/api/bootstrap');
    applyBootstrap(b);
    const s = S();
    for (const [cid, c] of Object.entries(s.chan)) {
      if (!c.loaded) continue;
      const lastId = [...c.ids].reverse().find((id) => id > 0);
      if (cid === s.activeChannelId) void loadNewer(cid, lastId ?? 0, true);
      else set((st) => void delete st.chan[cid]);
    }
    if (s.right?.type === 'thread') void loadThread(s.right.rootId);
  } catch {
    /* next reconnect will retry */
  }
}

export function loginSuccess(r: { token: string; me: Me }) {
  setToken(r.token);
  set((s) => void (s.status = 'loading'));
  void boot();
}

export async function logout() {
  try {
    await POST('/api/auth/logout');
  } catch {
    /* ignore */
  }
  setToken(null);
  disconnectSocket();
  location.href = '/login';
}

// ---------- navigation / ui ----------

export function openChannel(channelId: string, messageId?: number) {
  navigate(channelPath(channelId, messageId));
}

export function setRight(panel: RightPanel | null) {
  set((s) => void (s.right = panel));
}

export function openThread(rootId: number, channelId: string, highlightId?: number) {
  setRight({ type: 'thread', rootId, channelId, highlightId });
  void loadThread(rootId);
}

export function openProfile(userId: string) {
  setRight({ type: 'profile', userId });
}

export function openModal(m: Modal | null) {
  set((s) => void (s.modal = m));
}

export function confirmDialog(o: Omit<Extract<Modal, { type: 'confirm' }>, 'type'>) {
  openModal({ type: 'confirm', ...o });
}

// ---------- messages ----------

function emptyChan(): ChannelMsgs {
  return { ids: [], hasMoreBefore: true, hasMoreAfter: false, loading: false, loaded: false };
}

function sortIds(ids: number[], msgs: Record<number, Message>) {
  // pending (negative ids) always go to the bottom, ordered by creation time
  return [...new Set(ids)].sort((a, b) => {
    if (a > 0 && b > 0) return a - b;
    if (a < 0 && b < 0) return msgs[a].createdAt - msgs[b].createdAt;
    return a < 0 ? 1 : -1;
  });
}

export async function loadChannel(channelId: string, around?: number) {
  const existing = S().chan[channelId];
  if (existing?.loading) return;
  if (existing?.loaded && !around) return;
  if (existing?.loaded && around && existing.ids.includes(around)) return;
  set((s) => {
    s.chan[channelId] = { ...(s.chan[channelId] ?? emptyChan()), loading: true };
  });
  try {
    const page = await GET<MessagesPage>(`/api/channels/${channelId}/messages?limit=50${around ? `&around=${around}` : ''}`);
    set((s) => {
      upsertMessages(s, page.messages);
      const pending = (s.chan[channelId]?.ids ?? []).filter((id) => id < 0);
      s.chan[channelId] = {
        ids: sortIds([...page.messages.map((m) => m.id), ...pending], s.msgs),
        hasMoreBefore: page.hasMoreBefore,
        hasMoreAfter: page.hasMoreAfter,
        loading: false,
        loaded: true,
      };
    });
  } catch (e) {
    set((s) => void (s.chan[channelId] = { ...(s.chan[channelId] ?? emptyChan()), loading: false }));
    fail(e);
  }
}

export async function loadOlder(channelId: string) {
  const c = S().chan[channelId];
  if (!c || c.loading || !c.hasMoreBefore) return;
  const first = c.ids.find((id) => id > 0);
  if (!first) return;
  set((s) => void (s.chan[channelId].loading = true));
  try {
    const page = await GET<MessagesPage>(`/api/channels/${channelId}/messages?limit=50&before=${first}`);
    set((s) => {
      upsertMessages(s, page.messages);
      const ch = s.chan[channelId];
      ch.ids = sortIds([...page.messages.map((m) => m.id), ...ch.ids], s.msgs);
      ch.hasMoreBefore = page.hasMoreBefore;
      ch.loading = false;
    });
  } catch (e) {
    set((s) => void (s.chan[channelId].loading = false));
    fail(e);
  }
}

export async function loadNewer(channelId: string, afterId?: number, force = false) {
  const c = S().chan[channelId];
  if (!c || (c.loading && !force) || (!c.hasMoreAfter && !force)) return;
  const last = afterId ?? [...c.ids].reverse().find((id) => id > 0) ?? 0;
  set((s) => void (s.chan[channelId].loading = true));
  try {
    const page = await GET<MessagesPage>(`/api/channels/${channelId}/messages?limit=100&after=${last}`);
    set((s) => {
      upsertMessages(s, page.messages);
      const ch = s.chan[channelId];
      ch.ids = sortIds([...ch.ids, ...page.messages.map((m) => m.id)], s.msgs);
      ch.hasMoreAfter = page.hasMoreAfter;
      ch.loading = false;
    });
  } catch (e) {
    set((s) => void (s.chan[channelId].loading = false));
    fail(e);
  }
}

/** Jump to the newest messages (after viewing an old permalink). */
export async function jumpToPresent(channelId: string) {
  set((s) => void delete s.chan[channelId]);
  await loadChannel(channelId);
}

let tempSeq = 0;

export interface SendOptions {
  threadRootId?: number | null;
  alsoInChannel?: boolean;
  files?: FileInfo[];
}

/** Inserts a message received from the server, replacing any optimistic copy. */
export function receiveMessage(m: Message) {
  set((s) => {
    const existed = !!s.msgs[m.id];
    if (m.clientId) {
      const temp = Object.values(s.msgs).find((x) => x.id < 0 && x.clientId === m.clientId);
      if (temp) {
        delete s.msgs[temp.id];
        // ↑ pressed before the server confirmed the message: keep editing the real one
        if (s.editingId === temp.id) s.editingId = m.id;
        const ch = s.chan[m.channelId];
        if (ch) ch.ids = ch.ids.filter((id) => id !== temp.id);
        if (temp.threadRootId && s.threads[temp.threadRootId]) {
          s.threads[temp.threadRootId].ids = s.threads[temp.threadRootId].ids.filter((id) => id !== temp.id);
        }
      }
    }
    s.msgs[m.id] = m;
    const inChannel = !m.threadRootId || m.alsoInChannel;
    const ch = s.chan[m.channelId];
    if (inChannel && ch?.loaded && !ch.hasMoreAfter) ch.ids = sortIds([...ch.ids, m.id], s.msgs);
    if (m.threadRootId) {
      const th = s.threads[m.threadRootId];
      if (th?.loaded && !th.ids.includes(m.id)) th.ids = sortIds([...th.ids, m.id], s.msgs);
    }
    if (existed) return;
    const channel = s.channels[m.channelId];
    if (channel && inChannel) channel.lastMessageAt = m.createdAt;
    const mem = s.memberships[m.channelId];
    if (mem && inChannel) {
      if (m.userId === s.me?.id && !m.subtype) {
        mem.lastRead = Math.max(mem.lastRead, m.id);
        mem.unread = 0;
        mem.mentions = 0;
      } else if (m.id > mem.lastRead && m.userId !== s.me?.id) {
        mem.unread += 1;
        if (s.me && (!m.subtype || m.subtype === 'bot') && mentionsMe(m.text, s.me.id)) mem.mentions += 1;
      }
    }
    if (mem?.hidden && inChannel && m.userId !== s.me?.id) mem.hidden = false;
  });
  updateTitleBadge();
}

export async function sendMessage(channelId: string, text: string, o: SendOptions = {}) {
  const s = S();
  const me = s.me!;
  const clientId = `${me.id}-${Date.now()}-${++tempSeq}`;
  const tempId = -Date.now() - tempSeq;
  // the arriving message clears our typing indicator for others; let the next keystroke announce it again
  lastTypingKey = '';
  const temp: Message = {
    id: tempId,
    channelId,
    userId: me.id,
    text,
    subtype: null,
    threadRootId: o.threadRootId ?? null,
    replyCount: 0,
    lastReplyAt: null,
    replyUserIds: [],
    alsoInChannel: !!o.alsoInChannel,
    createdAt: Date.now(),
    editedAt: null,
    deleted: false,
    reactions: [],
    files: o.files ?? [],
    unfurls: [],
    pinnedBy: null,
    clientId,
  };
  set((st) => {
    st.msgs[tempId] = { ...temp, pending: true } as Message;
    const inChannel = !temp.threadRootId || temp.alsoInChannel;
    const ch = st.chan[channelId];
    if (inChannel && ch?.loaded) ch.ids = sortIds([...ch.ids, tempId], st.msgs);
    if (temp.threadRootId) {
      const th = st.threads[temp.threadRootId];
      if (th?.loaded) th.ids = sortIds([...th.ids, tempId], st.msgs);
    }
  });
  try {
    const m = await POST<Message>(`/api/channels/${channelId}/messages`, {
      text,
      threadRootId: o.threadRootId ?? null,
      alsoInChannel: o.alsoInChannel,
      fileIds: o.files?.map((f) => f.id),
      clientId,
    });
    receiveMessage(m);
    return m;
  } catch (e) {
    set((st) => {
      if (st.msgs[tempId]) (st.msgs[tempId] as any).failed = true;
    });
    fail(e);
  }
}

export async function retryMessage(tempId: number) {
  const m = S().msgs[tempId];
  if (!m) return;
  removeLocal(tempId);
  await sendMessage(m.channelId, m.text, { threadRootId: m.threadRootId, alsoInChannel: m.alsoInChannel, files: m.files });
}

export function removeLocal(id: number) {
  set((s) => {
    const m = s.msgs[id];
    if (!m) return;
    delete s.msgs[id];
    const ch = s.chan[m.channelId];
    if (ch) ch.ids = ch.ids.filter((x) => x !== id);
    if (m.threadRootId && s.threads[m.threadRootId]) s.threads[m.threadRootId].ids = s.threads[m.threadRootId].ids.filter((x) => x !== id);
  });
}

export async function editMessage(id: number, text: string) {
  const prev = S().msgs[id];
  set((s) => {
    if (s.msgs[id]) {
      s.msgs[id].text = text;
      s.msgs[id].editedAt = Date.now();
    }
    s.editingId = null;
  });
  try {
    const m = await PATCH<Message>(`/api/messages/${id}`, { text });
    set((s) => void (s.msgs[id] = m));
  } catch (e) {
    if (prev) set((s) => void (s.msgs[id] = prev));
    fail(e);
  }
}

export function deleteMessage(id: number, skipConfirm = false) {
  const run = async () => {
    try {
      await DEL(`/api/messages/${id}`);
    } catch (e) {
      fail(e);
    }
  };
  if (skipConfirm) return run();
  confirmDialog({
    title: t('Delete message'),
    body: t('Are you sure you want to delete this message? This cannot be undone.'),
    danger: true,
    confirmLabel: t('Delete'),
    onConfirm: run,
  });
}

export function removeMessageLocal(p: { id: number; channelId: string; threadRootId: number | null }) {
  set((s) => {
    delete s.msgs[p.id];
    const ch = s.chan[p.channelId];
    if (ch) ch.ids = ch.ids.filter((x) => x !== p.id);
    if (p.threadRootId && s.threads[p.threadRootId]) s.threads[p.threadRootId].ids = s.threads[p.threadRootId].ids.filter((x) => x !== p.id);
    if (s.right?.type === 'thread' && s.right.rootId === p.id) s.right = null;
  });
}

export async function toggleReaction(messageId: number, emoji: string) {
  const s = S();
  const m = s.msgs[messageId];
  const me = s.me?.id;
  if (!m || !me) return;
  const before = m.reactions;
  const has = m.reactions.find((r) => r.emoji === emoji)?.userIds.includes(me);
  // optimistic
  set((st) => {
    const msg = st.msgs[messageId];
    let r = msg.reactions.find((x) => x.emoji === emoji);
    if (has) {
      if (r) r.userIds = r.userIds.filter((u) => u !== me);
      msg.reactions = msg.reactions.filter((x) => x.userIds.length > 0);
    } else {
      if (!r) msg.reactions.push((r = { emoji, userIds: [] }));
      r.userIds.push(me);
    }
  });
  if (!has) rememberEmoji(emoji);
  try {
    const updated = has ? await DEL<Message>(`/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`) : await POST<Message>(`/api/messages/${messageId}/reactions`, { emoji });
    set((st) => void (st.msgs[messageId] = updated));
  } catch (e) {
    // roll back the optimistic change
    set((st) => {
      if (st.msgs[messageId]) st.msgs[messageId].reactions = before;
    });
    fail(e);
  }
}

export function rememberEmoji(code: string) {
  const me = S().me;
  if (!me) return;
  const recent = [code, ...(me.prefs.recentEmoji ?? []).filter((c) => c !== code)].slice(0, 24);
  set((s) => void (s.me!.prefs.recentEmoji = recent));
  clearTimeout(recentTimer);
  recentTimer = setTimeout(() => void PUT('/api/users/me/prefs', { recentEmoji: S().me?.prefs.recentEmoji }).catch(() => {}), 2000);
}
let recentTimer: ReturnType<typeof setTimeout>;

export async function togglePin(messageId: number) {
  const m = S().msgs[messageId];
  if (!m) return;
  try {
    const updated = m.pinnedBy ? await DEL<Message>(`/api/messages/${messageId}/pin`) : await POST<Message>(`/api/messages/${messageId}/pin`);
    set((s) => void (s.msgs[messageId] = updated));
    toast(m.pinnedBy ? t('Unpinned from channel') : t('Pinned to channel'));
  } catch (e) {
    fail(e);
  }
}

export async function remindMe(messageId: number, remindAt: number) {
  const wasSaved = !!S().saved[messageId];
  set((s) => void (s.saved[messageId] = true));
  try {
    await POST(`/api/messages/${messageId}/save`, { remindAt });
    toast(t('I’ll remind you {when}', { when: new Date(remindAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' }) }));
  } catch (e) {
    if (!wasSaved) set((s) => void delete s.saved[messageId]);
    fail(e);
  }
}

export function remindOptions() {
  const at = (h: number, addDays = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + addDays);
    d.setHours(h, 0, 0, 0);
    return d.getTime();
  };
  const nextMonday = (() => {
    const d = new Date();
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  })();
  return [
    { label: t('In 20 minutes'), at: Date.now() + 20 * 60_000 },
    { label: t('In 1 hour'), at: Date.now() + 60 * 60_000 },
    { label: t('In 3 hours'), at: Date.now() + 3 * 60 * 60_000 },
    { label: t('Tomorrow'), at: at(9, 1) },
    { label: t('Next week'), at: nextMonday },
  ];
}

export async function toggleSaved(messageId: number) {
  const saved = !!S().saved[messageId];
  set((s) => {
    if (saved) delete s.saved[messageId];
    else s.saved[messageId] = true;
  });
  try {
    if (saved) await DEL(`/api/messages/${messageId}/save`);
    else await POST(`/api/messages/${messageId}/save`);
    toast(saved ? t('Removed from Later') : t('Saved for later'));
  } catch (e) {
    set((s) => {
      if (saved) s.saved[messageId] = true;
      else delete s.saved[messageId];
    });
    fail(e);
  }
}

export async function markUnread(m: Message) {
  try {
    await POST(`/api/messages/${m.id}/unread`);
    if (!m.threadRootId || m.alsoInChannel) {
      set((s) => {
        const mem = s.memberships[m.channelId];
        if (mem) mem.lastRead = m.id - 1;
        s.unreadMarker[m.channelId] = m.id - 1;
      });
      suppressAutoRead.add(m.channelId);
    }
    toast(t('Marked as unread'));
  } catch (e) {
    fail(e);
  }
}

/** Channels where the user explicitly marked something unread; skip auto-marking until they leave. */
export const suppressAutoRead = new Set<string>();

const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function markRead(channelId: string, messageId?: number) {
  const s = S();
  const mem = s.memberships[channelId];
  if (!mem) return;
  const ids = s.chan[channelId]?.ids ?? [];
  const last = messageId ?? [...ids].reverse().find((id) => id > 0) ?? 0;
  if (!last || (last <= mem.lastRead && mem.unread === 0 && mem.mentions === 0)) return;
  const hadMentions = mem.mentions > 0;
  set((st) => {
    const m = st.memberships[channelId];
    m.lastRead = Math.max(m.lastRead, last);
    m.unread = 0;
    m.mentions = 0;
  });
  updateTitleBadge();
  clearTimeout(readTimers.get(channelId));
  readTimers.set(
    channelId,
    setTimeout(async () => {
      try {
        await PUT(`/api/channels/${channelId}/read`, { messageId: S().memberships[channelId]?.lastRead ?? last });
        if (hadMentions) void refreshCounts();
      } catch {
        /* ignore */
      }
    }, 400),
  );
}

let countsTimer: ReturnType<typeof setTimeout>;
let countsWaiting: (() => void)[] = [];
/** Debounced; every caller's promise resolves once the (single) fetch finishes. */
export function refreshCounts() {
  clearTimeout(countsTimer);
  return new Promise<void>((resolve) => {
    countsWaiting.push(resolve);
    countsTimer = setTimeout(async () => {
      const waiting = countsWaiting;
      countsWaiting = [];
      try {
        const c = await GET<{ activityUnread: number; threadsUnread: number }>('/api/counts');
        set((s) => {
          s.activityUnread = c.activityUnread;
          s.threadsUnread = c.threadsUnread;
        });
      } catch {
        /* ignore */
      }
      waiting.forEach((r) => r());
    }, 300);
  });
}

// ---------- threads ----------

export async function loadThread(rootId: number) {
  try {
    const r = await GET<{ root: Message; replies: Message[]; following: boolean; lastRead: number }>(`/api/messages/${rootId}/thread`);
    set((s) => {
      upsertMessages(s, [r.root, ...r.replies]);
      const pending = (s.threads[rootId]?.ids ?? []).filter((id) => id < 0);
      s.threads[rootId] = { ids: sortIds([...r.replies.map((m) => m.id), ...pending], s.msgs), loaded: true, following: r.following, lastRead: r.lastRead };
    });
  } catch (e) {
    fail(e);
    setRight(null);
  }
}

export function markThreadRead(rootId: number) {
  const th = S().threads[rootId];
  if (!th) return;
  const last = [...th.ids].reverse().find((id) => id > 0) ?? 0;
  if (!last || last <= th.lastRead) return;
  set((s) => void (s.threads[rootId].lastRead = last));
  void PUT(`/api/messages/${rootId}/thread/read`, { messageId: last })
    .then(() => refreshCounts())
    .catch(() => {});
}

export async function setThreadFollow(rootId: number, following: boolean) {
  try {
    await PUT(`/api/messages/${rootId}/thread/follow`, { following });
    set((s) => {
      if (s.threads[rootId]) s.threads[rootId].following = following;
    });
    toast(following ? t('You’re following this thread') : t('You’ve unfollowed this thread'));
    void refreshCounts();
  } catch (e) {
    fail(e);
  }
}

// ---------- channels ----------

export function upsertChannel(c: Channel) {
  set((s) => void (s.channels[c.id] = c));
}

export function upsertMembership(m: Membership) {
  set((s) => void (s.memberships[m.channelId] = m));
  updateTitleBadge();
}

export async function joinChannel(channelId: string) {
  try {
    const r = await POST<{ channel: Channel; membership: Membership }>(`/api/channels/${channelId}/join`);
    upsertChannel(r.channel);
    upsertMembership(r.membership);
    set((s) => void delete s.chan[channelId]);
    void loadChannel(channelId);
  } catch (e) {
    fail(e);
  }
}

export function leaveChannel(channelId: string) {
  const ch = S().channels[channelId];
  const run = async () => {
    try {
      await POST(`/api/channels/${channelId}/leave`);
      if (ch?.kind === 'dm' || ch?.kind === 'group') {
        set((s) => {
          if (s.memberships[channelId]) s.memberships[channelId].hidden = true;
        });
      } else {
        set((s) => {
          delete s.memberships[channelId];
          if (ch?.kind === 'private') delete s.channels[channelId];
        });
      }
      if (S().activeChannelId === channelId) navigate('/');
    } catch (e) {
      fail(e);
    }
  };
  if (ch?.kind === 'private') {
    confirmDialog({
      title: t('Leave #{name}?', { name: ch.name }),
      body: t('You won’t be able to rejoin this private channel unless someone invites you.'),
      danger: true,
      confirmLabel: t('Leave channel'),
      onConfirm: run,
    });
  } else void run();
}

export async function openDm(userIds: string[]) {
  try {
    const r = await POST<{ channel: Channel; membership: Membership }>('/api/dms', { userIds });
    upsertChannel(r.channel);
    upsertMembership(r.membership);
    openChannel(r.channel.id);
    return r.channel;
  } catch (e) {
    fail(e);
  }
}

export async function setChannelPrefs(channelId: string, prefs: Partial<Pick<Membership, 'starred' | 'muted' | 'notify' | 'hidden'>>) {
  const before = S().memberships[channelId];
  set((s) => {
    if (s.memberships[channelId]) Object.assign(s.memberships[channelId], prefs);
  });
  try {
    upsertMembership(await PUT<Membership>(`/api/channels/${channelId}/prefs`, prefs));
  } catch (e) {
    if (before) set((s) => void (s.memberships[channelId] = before));
    fail(e);
  }
}

// ---------- user ----------

export async function updatePrefs(prefs: Partial<UserPrefs>) {
  const before = S().me?.prefs;
  set((s) => {
    if (s.me) Object.assign(s.me.prefs, prefs);
  });
  const me = S().me;
  if (me) applyMePrefs(me);
  try {
    await PUT('/api/users/me/prefs', prefs);
  } catch (e) {
    if (before) {
      set((s) => void (s.me && (s.me.prefs = before)));
      const restored = S().me;
      if (restored) applyMePrefs(restored);
    }
    fail(e);
  }
}

export function setMe(me: Me) {
  set((s) => {
    s.me = me;
    s.users[me.id] = { ...s.users[me.id], ...me };
  });
}

export async function setStatus(emoji: string, text: string, expiresAt: number | null) {
  try {
    setMe(await PUT<Me>('/api/users/me/status', { emoji, text, expiresAt }));
  } catch (e) {
    fail(e);
  }
}

export async function setAway(away: boolean) {
  try {
    setMe(await PUT<Me>('/api/users/me/presence', { away }));
  } catch (e) {
    fail(e);
  }
}

export async function setDnd(until: number | null) {
  try {
    setMe(await PUT<Me>('/api/users/me/dnd', { until }));
    toast(until ? t('Notifications paused') : t('Notifications resumed'));
  } catch (e) {
    fail(e);
  }
}

// ---------- drafts & typing ----------

const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function saveDraft(channelId: string, threadRootId: number | null, text: string) {
  const key = draftKey(channelId, threadRootId);
  const current = S().drafts[key]?.text ?? '';
  if (current === text) return;
  set((s) => {
    if (text.trim()) s.drafts[key] = { channelId, threadRootId, text, updatedAt: Date.now() };
    else delete s.drafts[key];
  });
  clearTimeout(draftTimers.get(key));
  draftTimers.set(
    key,
    setTimeout(() => void PUT('/api/drafts', { channelId, threadRootId, text }).catch(() => {}), 800),
  );
}

let lastTyping = 0;
let lastTypingKey = '';
export function sendTyping(channelId: string, threadRootId: number | null) {
  const key = draftKey(channelId, threadRootId);
  const n = Date.now();
  if (key === lastTypingKey && n - lastTyping < 3000) return;
  lastTyping = n;
  lastTypingKey = key;
  emitTyping(channelId, threadRootId);
}

export async function forwardMessage(messageId: number, channelId: string, comment: string) {
  const m = S().msgs[messageId];
  if (!m) return;
  const link = `${location.origin}${channelPath(m.channelId, m.id)}`;
  const quoted = m.text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  const text = `${comment ? comment + '\n' : ''}${quoted}\n> — <@${m.userId}> · <${link}|${t('view message')}>`;
  if (await sendMessage(channelId, text)) toast(t('Message forwarded'));
}

export function copyLink(m: Message) {
  const url = `${location.origin}${channelPath(m.channelId, m.id)}${m.threadRootId && !m.alsoInChannel ? `?thread=${m.threadRootId}` : ''}`;
  void navigator.clipboard?.writeText(url);
  toast(t('Link copied to clipboard'));
}

let reloadedImport: string | null = null;
/** After a workspace import: drop cached history (message ids may have moved) and reload everything once. */
export async function reloadAfterImport(jobId: string) {
  if (reloadedImport === jobId) return;
  reloadedImport = jobId;
  set((s) => {
    for (const id of Object.keys(s.chan)) delete s.chan[id];
  });
  await resync();
  const active = S().activeChannelId;
  if (active) void loadChannel(active);
}
