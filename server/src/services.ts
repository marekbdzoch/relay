import { EventEmitter } from 'node:events';
import type { ActivityItem, Message } from '../../shared/types.ts';
import { all, get, placeholders, run, tx } from './db.ts';
import {
  channelMemberIds,
  getChannel,
  getChannelRow,
  getMembership,
  getMessage,
  getMessageRow,
  hydrateMessages,
  type FileRow,
  type MessageMeta,
  type MessageRow,
} from './model.ts';
import { io, joinChannelRoom, leaveChannelRoom, toChannel, toUser } from './realtime.ts';
import { removeUpload } from './lib/files.ts';
import { badRequest, json, now } from './lib/util.ts';
import { unfurlMessage } from './unfurl.ts';

/**
 * Internal events other modules (e.g. the Slack bridge) can subscribe to.
 * 'posted' (msg, source), 'edited' (msg, source), 'deleted' (row), 'reaction' ({messageId, userId, emoji, added})
 */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

export const MENTION_RE = /<@([A-Z0-9]+)>/g;
export const SPECIAL_MENTION_RE = /<!(here|channel|everyone)>/g;

export function emitChannel(channelId: string) {
  const ch = getChannel(channelId);
  if (!ch) return;
  if (ch.kind === 'public') io.emit('channel:upsert', ch);
  else toChannel(channelId).emit('channel:upsert', ch);
}

export function emitMembership(userId: string, channelId: string) {
  const m = getMembership(userId, channelId);
  if (m) toUser(userId).emit('membership:upsert', m);
}

export function emitMessageUpdated(id: number) {
  const m = getMessage(id);
  if (m) toChannel(m.channelId).emit('message:updated', m);
  return m;
}

export function addMembers(channelId: string, userIds: string[], actorId: string | null, announce = true) {
  const ch = getChannelRow(channelId);
  if (!ch) return;
  const t = now();
  const added: string[] = [];
  tx(() => {
    for (const uid of userIds) {
      const user = get<{ deactivated: number }>('SELECT deactivated FROM users WHERE id = ?', uid);
      if (!user || user.deactivated) continue;
      const lastRead = get<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channel_id = ?', channelId)!.id;
      const r = run(
        'INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at, last_read) VALUES (?, ?, ?, ?)',
        channelId,
        uid,
        t,
        lastRead,
      );
      if (r.changes) added.push(uid);
    }
  });
  for (const uid of added) joinChannelRoom(uid, channelId);
  if (!added.length) return;
  emitChannel(channelId);
  if (ch.kind === 'public' || ch.kind === 'private') {
    if (announce) {
      for (const uid of added) {
        postMessage({ channelId, userId: uid, text: actorId && actorId !== uid ? `<@${actorId}>` : '', subtype: 'join' });
      }
    }
    for (const uid of added) {
      if (actorId && actorId !== uid) {
        recordActivity({ userId: uid, kind: 'channel_invite', actorId, channelId, messageId: null });
      }
    }
  }
  // membership after the join message so the joiner has nothing unread
  for (const uid of added) {
    const max = get<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channel_id = ?', channelId)!.id;
    run('UPDATE channel_members SET last_read = ? WHERE channel_id = ? AND user_id = ?', max, channelId, uid);
    emitMembership(uid, channelId);
  }
}

export function removeMember(channelId: string, userId: string, announce = true) {
  const ch = getChannelRow(channelId);
  if (!ch) return;
  const r = run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', channelId, userId);
  if (!r.changes) return;
  if (announce && (ch.kind === 'public' || ch.kind === 'private')) {
    postMessage({ channelId, userId, text: '', subtype: 'leave' });
  }
  leaveChannelRoom(userId, channelId);
  if (ch.kind === 'private') toUser(userId).emit('channel:removed', { channelId });
  else toUser(userId).emit('channel:upsert', getChannel(channelId)!);
  emitChannel(channelId);
}

export function recordActivity(a: { userId: string; kind: ActivityItem['kind']; actorId: string | null; channelId: string; messageId: number | null; emoji?: string }) {
  const t = now();
  const r = run(
    'INSERT INTO activity (user_id, kind, message_id, actor_id, channel_id, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    a.userId,
    a.kind,
    a.messageId,
    a.actorId,
    a.channelId,
    a.emoji ?? null,
    t,
  );
  const item: ActivityItem = {
    id: Number(r.lastInsertRowid),
    kind: a.kind,
    actorId: a.actorId,
    channelId: a.channelId,
    emoji: a.emoji ?? null,
    read: false,
    createdAt: t,
    message: a.messageId ? getMessage(a.messageId) : null,
  };
  toUser(a.userId).emit('activity:new', item);
}

export function extractMentions(text: string, channelId: string, authorId: string | null) {
  const members = new Set(channelMemberIds(channelId));
  const ids = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) if (members.has(m[1])) ids.add(m[1]);
  const special = [...text.matchAll(SPECIAL_MENTION_RE)].map((m) => m[1]);
  if (special.length) {
    const onlineOnly = special.every((s) => s === 'here');
    for (const uid of members) {
      if (onlineOnly && !io.sockets.adapter.rooms.get(`user:${uid}`)?.size) continue;
      ids.add(uid);
    }
  }
  if (authorId) ids.delete(authorId);
  return ids;
}

export interface PostOptions {
  channelId: string;
  userId: string | null;
  text: string;
  threadRootId?: number | null;
  alsoInChannel?: boolean;
  fileIds?: string[];
  subtype?: Message['subtype'];
  botName?: string;
  clientId?: string;
  createdAt?: number;
  /** where the message came from ('slack' for bridged messages) – used to avoid echo loops */
  source?: string;
  agentDepth?: number;
}

export function postMessage(o: PostOptions): Message {
  const t = o.createdAt ?? now();
  const ch = getChannelRow(o.channelId);
  if (!ch) throw badRequest('channel_not_found');
  let root: MessageRow | undefined;
  if (o.threadRootId) {
    root = getMessageRow(o.threadRootId);
    if (!root || root.channel_id !== o.channelId || root.thread_root_id) throw badRequest('invalid_thread');
  }
  const meta: MessageMeta = {};
  if (o.botName) meta.botName = o.botName;
  if (o.clientId) meta.clientId = o.clientId;
  if (o.source) meta.source = o.source;
  if (o.agentDepth) meta.agentDepth = o.agentDepth;

  const id = tx(() => {
    const r = run(
      `INSERT INTO messages (channel_id, user_id, text, subtype, thread_root_id, also_in_channel, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      o.channelId,
      o.userId,
      o.text,
      o.subtype ?? null,
      root ? root.id : null,
      root && o.alsoInChannel ? 1 : 0,
      JSON.stringify(meta),
      t,
    );
    const id = Number(r.lastInsertRowid);
    if (o.fileIds?.length) {
      run(
        `UPDATE files SET message_id = ?, channel_id = ? WHERE id IN (${placeholders(o.fileIds.length)}) AND user_id = ? AND message_id IS NULL`,
        id,
        o.channelId,
        ...o.fileIds,
        o.userId ?? '',
      );
    }
    if (root) {
      const users = json<string[]>(root.reply_users, []).filter((u) => u !== o.userId);
      if (o.userId) users.push(o.userId);
      run(
        'UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ?, reply_users = ? WHERE id = ?',
        t,
        JSON.stringify(users.slice(-10)),
        root.id,
      );
    }
    if (!root || o.alsoInChannel) {
      run('UPDATE channels SET last_message_at = ? WHERE id = ?', t, o.channelId);
      if (o.userId) run('UPDATE channel_members SET last_read = ? WHERE channel_id = ? AND user_id = ?', id, o.channelId, o.userId);
    }
    return id;
  });

  const msg = getMessage(id)!;
  toChannel(o.channelId).emit('message:new', msg);

  if (o.userId && (!o.subtype || o.source)) {
    const mentioned = extractMentions(o.text, o.channelId, o.userId);
    // reveal hidden DMs again when somebody writes
    if (ch.kind === 'dm' || ch.kind === 'group') {
      const hidden = all<{ user_id: string }>('SELECT user_id FROM channel_members WHERE channel_id = ? AND hidden = 1', o.channelId);
      if (hidden.length) {
        run('UPDATE channel_members SET hidden = 0 WHERE channel_id = ?', o.channelId);
        for (const h of hidden) emitMembership(h.user_id, o.channelId);
      }
    } else {
      for (const uid of mentioned) recordActivity({ userId: uid, kind: 'mention', actorId: o.userId, channelId: o.channelId, messageId: id });
    }
    if (root) {
      handleThreadReply(root, msg, mentioned);
    }
    if (!root || o.alsoInChannel) emitMembership(o.userId, o.channelId);
    if (!(meta as MessageMeta).noUnfurl) void unfurlMessage(id, o.text);
  }
  if (root) emitMessageUpdated(root.id);
  bus.emit('posted', msg, o.source ?? null);
  return msg;
}

function follow(userId: string, rootId: number, lastRead: number) {
  run(
    `INSERT INTO thread_follows (user_id, root_id, last_read, following) VALUES (?, ?, ?, 1)
     ON CONFLICT(user_id, root_id) DO UPDATE SET following = 1, last_read = MAX(last_read, excluded.last_read)`,
    userId,
    rootId,
    lastRead,
  );
}

function handleThreadReply(root: MessageRow, reply: Message, mentioned: Set<string>) {
  const authorId = reply.userId!;
  if (root.user_id && root.user_id !== authorId && !get('SELECT 1 FROM thread_follows WHERE user_id = ? AND root_id = ?', root.user_id, root.id)) {
    follow(root.user_id, root.id, 0);
  }
  follow(authorId, root.id, reply.id);
  toUser(authorId).emit('thread:read', { rootId: root.id, lastRead: reply.id });
  for (const uid of mentioned) {
    if (!get('SELECT 1 FROM thread_follows WHERE user_id = ? AND root_id = ?', uid, root.id)) follow(uid, root.id, 0);
  }
  const followers = all<{ user_id: string }>('SELECT user_id FROM thread_follows WHERE root_id = ? AND following = 1 AND user_id != ?', root.id, authorId);
  const ch = getChannelRow(root.channel_id);
  const isDm = ch?.kind === 'dm' || ch?.kind === 'group';
  for (const f of followers) {
    if (mentioned.has(f.user_id) && !isDm) continue; // already notified as a mention
    recordActivity({ userId: f.user_id, kind: 'thread_reply', actorId: authorId, channelId: root.channel_id, messageId: reply.id });
  }
}

export function systemText(subtype: Message['subtype'], text: string) {
  return { subtype, text };
}

export function threadsUnreadCount(userId: string) {
  return (
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM thread_follows tf JOIN messages r ON r.id = tf.root_id
       WHERE tf.user_id = ? AND tf.following = 1 AND r.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_root_id = r.id AND m.id > tf.last_read AND m.deleted_at IS NULL AND (m.user_id IS NULL OR m.user_id != tf.user_id))`,
      userId,
    )?.n ?? 0
  );
}

export function activityUnreadCount(userId: string) {
  return get<{ n: number }>('SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND read = 0', userId)?.n ?? 0;
}

/** Soft-deletes a message (keeps a placeholder when it has replies) and notifies clients. */
export function deleteMessage(row: MessageRow) {
  const files = all<FileRow>('SELECT * FROM files WHERE message_id = ?', row.id);
  tx(() => {
    run("UPDATE messages SET deleted_at = ?, text = '', meta = '{}' WHERE id = ?", now(), row.id);
    run('DELETE FROM reactions WHERE message_id = ?', row.id);
    run('DELETE FROM pins WHERE message_id = ?', row.id);
    run('DELETE FROM saved WHERE message_id = ?', row.id);
    run('DELETE FROM activity WHERE message_id = ?', row.id);
    run('DELETE FROM files WHERE message_id = ?', row.id);
    if (row.thread_root_id) {
      const root = getMessageRow(row.thread_root_id);
      if (root) {
        const last = get<{ t: number | null }>('SELECT MAX(created_at) AS t FROM messages WHERE thread_root_id = ? AND deleted_at IS NULL', root.id);
        const users = all<{ user_id: string }>(
          'SELECT user_id FROM messages WHERE thread_root_id = ? AND deleted_at IS NULL AND user_id IS NOT NULL GROUP BY user_id ORDER BY MAX(id)',
          root.id,
        ).map((r) => r.user_id);
        run('UPDATE messages SET reply_count = MAX(reply_count - 1, 0), last_reply_at = ?, reply_users = ? WHERE id = ?', last?.t ?? null, JSON.stringify(users.slice(-10)), root.id);
      }
    }
  });
  for (const f of files) removeUpload(f.path);
  bus.emit('deleted', row);
  if (row.reply_count > 0) emitMessageUpdated(row.id);
  else toChannel(row.channel_id).emit('message:deleted', { id: row.id, channelId: row.channel_id, threadRootId: row.thread_root_id });
  if (row.thread_root_id) {
    const root = getMessageRow(row.thread_root_id);
    // a deleted root with no replies left disappears entirely
    if (root?.deleted_at && root.reply_count === 0) toChannel(row.channel_id).emit('message:deleted', { id: root.id, channelId: root.channel_id, threadRootId: null });
    else emitMessageUpdated(row.thread_root_id);
  }
}
