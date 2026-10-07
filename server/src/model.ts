import type { Channel, CustomEmoji, FileInfo, Me, Membership, Message, Reaction, User, Workspace } from '../../shared/types.ts';
import { all, get, getSetting, placeholders } from './db.ts';
import { config } from './config.ts';
import { bool, forbidden, json, notFound } from './lib/util.ts';

// ---------- users ----------

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  username: string;
  full_name: string;
  display_name: string;
  title: string;
  phone: string;
  timezone: string;
  avatar_path: string | null;
  avatar_color: string;
  role: string;
  status_emoji: string;
  status_text: string;
  status_expires_at: number | null;
  dnd_until: number | null;
  away_manual: number;
  prefs: string;
  deactivated: number;
  is_bot: number;
  external: string | null;
  imported?: number;
  created_at: number;
}

export function avatarUrl(row: { id: string; avatar_path: string | null }) {
  if (!row.avatar_path) return null;
  const v = row.avatar_path.split('/').pop()?.split('.')[0] ?? '';
  return `/api/avatars/${row.id}?v=${v}`;
}

export function serializeUser(row: UserRow, includeEmail = false): User {
  const expired = row.status_expires_at && row.status_expires_at < Date.now();
  const u: User = {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    displayName: row.display_name,
    title: row.title,
    phone: row.phone,
    timezone: row.timezone,
    avatarUrl: avatarUrl(row),
    avatarColor: row.avatar_color,
    role: row.role as User['role'],
    statusEmoji: expired ? '' : row.status_emoji,
    statusText: expired ? '' : row.status_text,
    statusExpiresAt: expired ? null : row.status_expires_at,
    dndUntil: row.dnd_until && row.dnd_until > Date.now() ? row.dnd_until : null,
    deactivated: bool(row.deactivated),
    isBot: bool(row.is_bot),
    external: row.external ?? null,
    createdAt: row.created_at,
  };
  if (includeEmail) u.email = row.email;
  if (row.imported) u.imported = true;
  return u;
}

export function getUserRow(id: string) {
  return get<UserRow>('SELECT * FROM users WHERE id = ?', id);
}

export function getUser(id: string, includeEmail = false) {
  const row = getUserRow(id);
  return row ? serializeUser(row, includeEmail) : null;
}

export function getMe(id: string): Me {
  const row = getUserRow(id);
  if (!row) throw notFound('user_not_found');
  return { ...serializeUser(row, true), email: row.email, prefs: json(row.prefs, {}), awayManual: bool(row.away_manual) };
}

// ---------- workspace ----------

export function getWorkspace(): Workspace {
  const row = get<{ name: string; icon_path: string | null; allowed_domains: string; created_at: number }>('SELECT * FROM workspace WHERE id = 1');
  return {
    name: row?.name ?? 'Relay',
    iconUrl: row?.icon_path ? `/api/workspace/icon?v=${row.icon_path.split('/').pop()?.split('.')[0]}` : null,
    allowedDomains: row?.allowed_domains ?? '',
    createdAt: row?.created_at ?? 0,
    iceServers: config.iceServers,
    onboardingPending: getSetting('onboarding.pending') === '1',
    demo: config.demo ? { resetHours: config.demoResetHours, nextResetAt: Number(getSetting('demo.seededAt') ?? 0) + config.demoResetHours * 3_600_000 } : undefined,
  };
}

export function listCustomEmoji(): CustomEmoji[] {
  return all<{ name: string; path: string; created_by: string }>('SELECT name, path, created_by FROM custom_emoji ORDER BY name').map((r) => ({
    name: r.name,
    url: `/api/emoji/${encodeURIComponent(r.name)}`,
    createdBy: r.created_by,
  }));
}

// ---------- channels ----------

export interface ChannelRow {
  id: string;
  kind: Channel['kind'];
  name: string;
  topic: string;
  description: string;
  created_by: string | null;
  created_at: number;
  archived: number;
  is_default: number;
  dm_key: string | null;
  last_message_at: number | null;
}

export function serializeChannel(row: ChannelRow): Channel {
  const memberIds = all<{ user_id: string }>('SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY joined_at', row.id).map((r) => r.user_id);
  const isDm = row.kind === 'dm' || row.kind === 'group';
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    topic: row.topic,
    description: row.description,
    createdBy: row.created_by,
    createdAt: row.created_at,
    archived: bool(row.archived),
    isDefault: bool(row.is_default),
    memberCount: memberIds.length,
    memberIds: isDm || row.kind === 'private' ? memberIds : memberIds.length <= 500 ? memberIds : undefined,
    lastMessageAt: row.last_message_at,
    bridge: (() => {
      const l = get<{ slack_channel_name: string }>('SELECT slack_channel_name FROM slack_links WHERE relay_channel_id = ?', row.id);
      return l ? { kind: 'slack' as const, name: l.slack_channel_name } : null;
    })(),
  };
}

export function getChannelRow(id: string) {
  return get<ChannelRow>('SELECT * FROM channels WHERE id = ?', id);
}

export function getChannel(id: string) {
  const row = getChannelRow(id);
  return row ? serializeChannel(row) : null;
}

export function isMember(userId: string, channelId: string) {
  return !!get('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?', channelId, userId);
}

/** Throws unless the user may read the channel (members, or anyone non-guest for public channels). */
export function assertCanRead(user: { id: string; role: string }, channelId: string) {
  const ch = getChannelRow(channelId);
  if (!ch) throw notFound('channel_not_found');
  const member = isMember(user.id, channelId);
  if (!member && !(ch.kind === 'public' && user.role !== 'guest')) throw forbidden('not_in_channel');
  return { ch, member };
}

export function assertMember(userId: string, channelId: string) {
  const ch = getChannelRow(channelId);
  if (!ch) throw notFound('channel_not_found');
  if (!isMember(userId, channelId)) throw forbidden('not_in_channel');
  return ch;
}

export function channelMemberIds(channelId: string) {
  return all<{ user_id: string }>('SELECT user_id FROM channel_members WHERE channel_id = ?', channelId).map((r) => r.user_id);
}

interface MemberRow {
  channel_id: string;
  last_read: number;
  starred: number;
  muted: number;
  notify: string;
  hidden: number;
  joined_at: number;
  unread: number;
  mentions: number;
}

const MEMBERSHIP_SQL = `
  SELECT cm.channel_id, cm.last_read, cm.starred, cm.muted, cm.notify, cm.hidden, cm.joined_at,
    (SELECT COUNT(*) FROM (SELECT 1 FROM messages m WHERE m.channel_id = cm.channel_id AND m.id > cm.last_read
       AND (m.thread_root_id IS NULL OR m.also_in_channel = 1) AND m.deleted_at IS NULL
       AND (m.user_id IS NULL OR m.user_id != cm.user_id) LIMIT 100)) AS unread,
    (SELECT COUNT(*) FROM activity a WHERE a.user_id = cm.user_id AND a.channel_id = cm.channel_id
       AND a.kind = 'mention' AND a.read = 0 AND a.message_id > cm.last_read) AS mentions
  FROM channel_members cm`;

function serializeMembership(r: MemberRow): Membership {
  return {
    channelId: r.channel_id,
    lastRead: r.last_read,
    starred: bool(r.starred),
    muted: bool(r.muted),
    notify: r.notify as Membership['notify'],
    hidden: bool(r.hidden),
    unread: r.unread,
    mentions: r.mentions,
    joinedAt: r.joined_at,
  };
}

export function getMemberships(userId: string): Membership[] {
  return all<MemberRow>(`${MEMBERSHIP_SQL} WHERE cm.user_id = ?`, userId).map(serializeMembership);
}

export function getMembership(userId: string, channelId: string): Membership | null {
  const r = get<MemberRow>(`${MEMBERSHIP_SQL} WHERE cm.user_id = ? AND cm.channel_id = ?`, userId, channelId);
  return r ? serializeMembership(r) : null;
}

// ---------- files ----------

export interface FileRow {
  id: string;
  user_id: string;
  channel_id: string | null;
  message_id: number | null;
  name: string;
  mime: string;
  size: number;
  path: string;
  width: number | null;
  height: number | null;
  created_at: number;
}

export function serializeFile(r: FileRow): FileInfo {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    url: `/api/files/${r.id}/${encodeURIComponent(r.name)}`,
    width: r.width,
    height: r.height,
    userId: r.user_id,
    channelId: r.channel_id,
    messageId: r.message_id,
    createdAt: r.created_at,
  };
}

// ---------- messages ----------

export interface MessageRow {
  id: number;
  channel_id: string;
  user_id: string | null;
  text: string;
  subtype: string | null;
  thread_root_id: number | null;
  reply_count: number;
  last_reply_at: number | null;
  reply_users: string;
  also_in_channel: number;
  meta: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

export interface MessageMeta {
  unfurls?: Message['unfurls'];
  botName?: string;
  clientId?: string;
  noUnfurl?: boolean;
  source?: string;
  /** how many agent hops led to this message (loop protection) */
  agentDepth?: number;
}

export function hydrateMessages(rows: MessageRow[]): Message[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = placeholders(ids.length);
  const reactions = new Map<number, Reaction[]>();
  for (const r of all<{ message_id: number; emoji: string; user_id: string }>(
    `SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${ph}) ORDER BY created_at, rowid`,
    ...ids,
  )) {
    let list = reactions.get(r.message_id);
    if (!list) reactions.set(r.message_id, (list = []));
    let rx = list.find((x) => x.emoji === r.emoji);
    if (!rx) list.push((rx = { emoji: r.emoji, userIds: [] }));
    rx.userIds.push(r.user_id);
  }
  const files = new Map<number, FileInfo[]>();
  for (const f of all<FileRow>(`SELECT * FROM files WHERE message_id IN (${ph}) ORDER BY created_at, rowid`, ...ids)) {
    const list = files.get(f.message_id!) ?? [];
    list.push(serializeFile(f));
    files.set(f.message_id!, list);
  }
  const pins = new Map<number, string>();
  for (const p of all<{ message_id: number; pinned_by: string }>(`SELECT message_id, pinned_by FROM pins WHERE message_id IN (${ph})`, ...ids)) {
    pins.set(p.message_id, p.pinned_by);
  }
  return rows.map((r) => {
    const meta = json<MessageMeta>(r.meta, {});
    const deleted = !!r.deleted_at;
    return {
      id: r.id,
      channelId: r.channel_id,
      userId: r.user_id,
      text: deleted ? '' : r.text,
      subtype: (r.subtype as Message['subtype']) ?? null,
      threadRootId: r.thread_root_id,
      replyCount: r.reply_count,
      lastReplyAt: r.last_reply_at,
      replyUserIds: json<string[]>(r.reply_users, []),
      alsoInChannel: bool(r.also_in_channel),
      createdAt: r.created_at,
      editedAt: r.edited_at,
      deleted,
      reactions: deleted ? [] : reactions.get(r.id) ?? [],
      files: deleted ? [] : files.get(r.id) ?? [],
      unfurls: deleted ? [] : meta.unfurls ?? [],
      pinnedBy: pins.get(r.id) ?? null,
      botName: meta.botName,
      clientId: meta.clientId,
    };
  });
}

export function getMessageRow(id: number) {
  return get<MessageRow>('SELECT * FROM messages WHERE id = ?', id);
}

export function getMessage(id: number): Message | null {
  const row = getMessageRow(id);
  return row ? hydrateMessages([row])[0] : null;
}
