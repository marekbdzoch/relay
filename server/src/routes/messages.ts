import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MessagesPage } from '../../../shared/types.ts';
import { all, get, run, tx } from '../db.ts';
import { config } from '../config.ts';
import { isAdmin, requireAuth } from '../lib/auth.ts';
import { absPath, imageSize, isSafeInline, removeUpload, saveUpload } from '../lib/files.ts';
import { badRequest, forbidden, json, newId, notFound, now, parse } from '../lib/util.ts';
import {
  assertCanRead,
  assertMember,
  getChannelRow,
  getMessage,
  getMessageRow,
  hydrateMessages,
  serializeFile,
  type FileRow,
  type MessageMeta,
  type MessageRow,
} from '../model.ts';
import { bus, deleteMessage, emitMembership, emitMessageUpdated, postMessage, recordActivity } from '../services.ts';
import { toChannel, toUser } from '../realtime.ts';
import { unfurlMessage } from '../unfurl.ts';

const MAX_TEXT = 40000;

function visibleFilter() {
  // deleted messages stay visible as a placeholder only when they still have replies
  return '(m.deleted_at IS NULL OR m.reply_count > 0)';
}

export async function messageRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/channels/:id/messages', async (req): Promise<MessagesPage> => {
    const { id } = req.params as { id: string };
    assertCanRead(req.user, id);
    const q = parse(
      z.object({
        before: z.coerce.number().int().optional(),
        after: z.coerce.number().int().optional(),
        around: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
      req.query,
    );
    const limit = q.limit ?? 50;
    const base = `SELECT m.* FROM messages m WHERE m.channel_id = ? AND (m.thread_root_id IS NULL OR m.also_in_channel = 1) AND ${visibleFilter()}`;
    let rows: MessageRow[];
    let hasMoreBefore = false;
    let hasMoreAfter = false;
    if (q.around !== undefined) {
      const half = Math.floor(limit / 2);
      const older = all<MessageRow>(`${base} AND m.id <= ? ORDER BY m.id DESC LIMIT ?`, id, q.around, half + 1);
      const newer = all<MessageRow>(`${base} AND m.id > ? ORDER BY m.id ASC LIMIT ?`, id, q.around, half + 1);
      hasMoreBefore = older.length > half;
      hasMoreAfter = newer.length > half;
      rows = [...older.slice(0, half).reverse(), ...newer.slice(0, half)];
    } else if (q.after !== undefined) {
      rows = all<MessageRow>(`${base} AND m.id > ? ORDER BY m.id ASC LIMIT ?`, id, q.after, limit + 1);
      hasMoreAfter = rows.length > limit;
      rows = rows.slice(0, limit);
      hasMoreBefore = true;
    } else {
      rows = all<MessageRow>(`${base} ${q.before ? 'AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`, ...(q.before ? [id, q.before, limit + 1] : [id, limit + 1]));
      hasMoreBefore = rows.length > limit;
      rows = rows.slice(0, limit).reverse();
    }
    return { messages: hydrateMessages(rows), hasMoreBefore, hasMoreAfter };
  });

  // first message at/after a point in time (for "jump to date")
  app.get('/api/channels/:id/message-at', async (req) => {
    const { id } = req.params as { id: string };
    assertCanRead(req.user, id);
    const q = parse(z.object({ ts: z.coerce.number().int() }), req.query);
    const base = 'FROM messages WHERE channel_id = ? AND (thread_root_id IS NULL OR also_in_channel = 1) AND deleted_at IS NULL';
    const row =
      get<{ id: number }>(`SELECT id ${base} AND created_at >= ? ORDER BY id ASC LIMIT 1`, id, q.ts) ??
      get<{ id: number }>(`SELECT id ${base} ORDER BY id DESC LIMIT 1`, id);
    return { id: row?.id ?? null };
  });

  app.post('/api/channels/:id/messages', async (req) => {
    const { id } = req.params as { id: string };
    const ch = assertMember(req.user.id, id);
    if (ch.archived) throw badRequest('channel_archived');
    const body = parse(
      z.object({
        text: z.string().max(MAX_TEXT),
        threadRootId: z.number().int().nullable().optional(),
        alsoInChannel: z.boolean().optional(),
        fileIds: z.array(z.string()).max(20).optional(),
        clientId: z.string().max(64).optional(),
      }),
      req.body,
    );
    if (!body.text.trim() && !body.fileIds?.length) throw badRequest('empty_message');
    return postMessage({ channelId: id, userId: req.user.id, text: body.text, threadRootId: body.threadRootId ?? null, alsoInChannel: body.alsoInChannel, fileIds: body.fileIds, clientId: body.clientId });
  });

  app.get('/api/messages/:id', async (req) => {
    const m = getMessage(Number((req.params as { id: string }).id));
    if (!m) throw notFound();
    assertCanRead(req.user, m.channelId);
    return m;
  });

  app.patch('/api/messages/:id', async (req) => {
    const mid = Number((req.params as { id: string }).id);
    const row = getMessageRow(mid);
    if (!row || row.deleted_at) throw notFound();
    if (row.user_id !== req.user.id || row.subtype) throw forbidden('not_author');
    const body = parse(z.object({ text: z.string().max(MAX_TEXT) }), req.body);
    const meta = json<MessageMeta>(row.meta, {});
    delete meta.unfurls;
    run('UPDATE messages SET text = ?, edited_at = ?, meta = ? WHERE id = ?', body.text, now(), JSON.stringify(meta), mid);
    const m = emitMessageUpdated(mid);
    void unfurlMessage(mid, body.text);
    if (m) bus.emit('edited', m, null);
    return m;
  });

  app.delete('/api/messages/:id', async (req) => {
    const mid = Number((req.params as { id: string }).id);
    const row = getMessageRow(mid);
    if (!row || row.deleted_at) throw notFound();
    if (row.user_id !== req.user.id && !isAdmin(req.user)) throw forbidden();
    deleteMessage(row);
    return { ok: true };
  });

  app.get('/api/messages/:id/thread', async (req) => {
    const mid = Number((req.params as { id: string }).id);
    const root = getMessageRow(mid);
    if (!root) throw notFound();
    assertCanRead(req.user, root.channel_id);
    const replies = all<MessageRow>('SELECT * FROM messages WHERE thread_root_id = ? AND deleted_at IS NULL ORDER BY id', mid);
    const follow = get<{ last_read: number; following: number }>('SELECT last_read, following FROM thread_follows WHERE user_id = ? AND root_id = ?', req.user.id, mid);
    return { root: hydrateMessages([root])[0], replies: hydrateMessages(replies), following: !!follow?.following, lastRead: follow?.last_read ?? 0 };
  });

  app.put('/api/messages/:id/thread/read', async (req) => {
    const mid = Number((req.params as { id: string }).id);
    const root = getMessageRow(mid);
    if (!root) throw notFound();
    assertCanRead(req.user, root.channel_id);
    const body = parse(z.object({ messageId: z.number().int() }), req.body);
    run('UPDATE thread_follows SET last_read = MAX(last_read, ?) WHERE user_id = ? AND root_id = ?', body.messageId, req.user.id, mid);
    run(
      "UPDATE activity SET read = 1 WHERE user_id = ? AND read = 0 AND message_id IN (SELECT id FROM messages WHERE thread_root_id = ? AND id <= ?)",
      req.user.id,
      mid,
      body.messageId,
    );
    toUser(req.user.id).emit('thread:read', { rootId: mid, lastRead: body.messageId });
    return { ok: true };
  });

  app.put('/api/messages/:id/thread/follow', async (req) => {
    const mid = Number((req.params as { id: string }).id);
    const root = getMessageRow(mid);
    if (!root) throw notFound();
    assertCanRead(req.user, root.channel_id);
    const body = parse(z.object({ following: z.boolean() }), req.body);
    run(
      `INSERT INTO thread_follows (user_id, root_id, last_read, following) VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages WHERE thread_root_id = ?), ?)
       ON CONFLICT(user_id, root_id) DO UPDATE SET following = excluded.following`,
      req.user.id,
      mid,
      mid,
      body.following ? 1 : 0,
    );
    return { ok: true, following: body.following };
  });

  // ----- reactions -----
  const emojiSchema = z.object({ emoji: z.string().min(1).max(64) });

  app.post('/api/messages/:id/reactions', async (req) => {
    const mid = Number((req.params as { id: string }).id);
    const row = getMessageRow(mid);
    if (!row || row.deleted_at) throw notFound();
    assertMember(req.user.id, row.channel_id);
    const { emoji } = parse(emojiSchema, req.body);
    const count = get<{ n: number }>('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?', mid)!.n;
    if (count >= 50) throw badRequest('too_many_reactions');
    const r = run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', mid, req.user.id, emoji, now());
    const m = emitMessageUpdated(mid);
    if (r.changes) bus.emit('reaction', { messageId: mid, userId: req.user.id, emoji, added: true });
    if (r.changes && row.user_id && row.user_id !== req.user.id) {
      recordActivity({ userId: row.user_id, kind: 'reaction', actorId: req.user.id, channelId: row.channel_id, messageId: mid, emoji });
    }
    return m;
  });

  app.delete('/api/messages/:id/reactions/:emoji', async (req) => {
    const { id, emoji } = req.params as { id: string; emoji: string };
    const mid = Number(id);
    const row = getMessageRow(mid);
    if (!row) throw notFound();
    const r = run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', mid, req.user.id, emoji);
    // nothing removed (double click, stale client): no events, otherwise the Slack bridge would drop the bot's reaction
    if (!r.changes) return getMessage(mid);
    run("DELETE FROM activity WHERE kind = 'reaction' AND message_id = ? AND actor_id = ? AND emoji = ?", mid, req.user.id, emoji);
    bus.emit('reaction', { messageId: mid, userId: req.user.id, emoji, added: false });
    return emitMessageUpdated(mid);
  });

  // ----- pins -----
  app.post('/api/messages/:id/pin', async (req) => {
    const mid = Number((req.params as { id: string }).id);
    const row = getMessageRow(mid);
    if (!row || row.deleted_at) throw notFound();
    assertMember(req.user.id, row.channel_id);
    run('INSERT OR IGNORE INTO pins (message_id, channel_id, pinned_by, created_at) VALUES (?, ?, ?, ?)', mid, row.channel_id, req.user.id, now());
    return emitMessageUpdated(mid);
  });

  app.delete('/api/messages/:id/pin', async (req) => {
    const mid = Number((req.params as { id: string }).id);
    const row = getMessageRow(mid);
    if (!row) throw notFound();
    assertMember(req.user.id, row.channel_id);
    run('DELETE FROM pins WHERE message_id = ?', mid);
    return emitMessageUpdated(mid);
  });

  // ----- saved for later (+ reminders) -----
  app.post('/api/messages/:id/save', async (req) => {
    const mid = Number((req.params as { id: string }).id);
    const row = getMessageRow(mid);
    if (!row || row.deleted_at) throw notFound();
    assertCanRead(req.user, row.channel_id);
    const body = parse(z.object({ remindAt: z.number().int().nullable().optional() }), req.body ?? {});
    run(
      `INSERT INTO saved (user_id, message_id, created_at, remind_at) VALUES (?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET done = 0, remind_at = COALESCE(excluded.remind_at, remind_at), reminded = CASE WHEN excluded.remind_at IS NULL THEN reminded ELSE 0 END`,
      req.user.id,
      mid,
      now(),
      body.remindAt ?? null,
    );
    toUser(req.user.id).emit('saved:changed', { messageId: mid, saved: true });
    return { ok: true };
  });

  app.delete('/api/messages/:id/save', async (req) => {
    const mid = Number((req.params as { id: string }).id);
    run('DELETE FROM saved WHERE user_id = ? AND message_id = ?', req.user.id, mid);
    toUser(req.user.id).emit('saved:changed', { messageId: mid, saved: false });
    return { ok: true };
  });

  app.put('/api/messages/:id/save', async (req) => {
    const mid = Number((req.params as { id: string }).id);
    const body = parse(z.object({ state: z.enum(['progress', 'completed', 'archived']).optional(), remindAt: z.number().int().nullable().optional() }), req.body);
    if (body.state) run('UPDATE saved SET done = ? WHERE user_id = ? AND message_id = ?', { progress: 0, completed: 1, archived: 2 }[body.state], req.user.id, mid);
    if (body.remindAt !== undefined) run('UPDATE saved SET remind_at = ?, reminded = 0 WHERE user_id = ? AND message_id = ?', body.remindAt, req.user.id, mid);
    const done = get<{ done: number }>('SELECT done FROM saved WHERE user_id = ? AND message_id = ?', req.user.id, mid);
    toUser(req.user.id).emit('saved:changed', { messageId: mid, saved: done?.done === 0 });
    return { ok: true };
  });

  // ----- files -----
  app.post('/api/files', async (req) => {
    const out = [];
    const parts = req.files({ limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 } });
    for await (const part of parts) {
      const saved = await saveUpload(part, new Date().toISOString().slice(0, 7));
      const mime = part.mimetype || 'application/octet-stream';
      const dims = mime.startsWith('image/') ? imageSize(saved.abs) : null;
      const id = newId('F', 12);
      const name = (part.filename || 'file').replace(/[\\/\0]/g, '_').slice(0, 200);
      run(
        'INSERT INTO files (id, user_id, name, mime, size, path, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        req.user.id,
        name,
        mime,
        saved.size,
        saved.rel,
        dims?.width ?? null,
        dims?.height ?? null,
        now(),
      );
      out.push(serializeFile(get<FileRow>('SELECT * FROM files WHERE id = ?', id)!));
    }
    return out;
  });

  app.get('/api/files/:id/:name', async (req, reply) => {
    const { id } = req.params as { id: string };
    const f = get<FileRow>('SELECT * FROM files WHERE id = ?', id);
    if (!f) throw notFound();
    if (f.channel_id) assertCanRead(req.user, f.channel_id);
    else if (f.user_id !== req.user.id) throw forbidden();
    const abs = absPath(f.path);
    if (!fs.existsSync(abs)) throw notFound();
    const download = (req.query as { download?: string }).download === '1';
    const inline = !download && isSafeInline(f.mime);
    reply.header('content-type', inline ? f.mime : 'application/octet-stream');
    reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    reply.header('cache-control', 'private, max-age=86400');
    const stat = fs.statSync(abs);
    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [s, e] = range.slice(6).split('-');
      const start = s ? Number(s) : Math.max(0, stat.size - Number(e));
      const end = s && e ? Math.min(Number(e), stat.size - 1) : stat.size - 1;
      if (start <= end && start < stat.size) {
        reply.code(206);
        reply.header('content-range', `bytes ${start}-${end}/${stat.size}`);
        reply.header('accept-ranges', 'bytes');
        reply.header('content-length', end - start + 1);
        return reply.send(fs.createReadStream(abs, { start, end }));
      }
    }
    reply.header('accept-ranges', 'bytes');
    reply.header('content-length', stat.size);
    return reply.send(fs.createReadStream(abs));
  });

  app.delete('/api/files/:id', async (req) => {
    const { id } = req.params as { id: string };
    const f = get<FileRow>('SELECT * FROM files WHERE id = ?', id);
    if (!f) throw notFound();
    if (f.user_id !== req.user.id && !isAdmin(req.user)) throw forbidden();
    run('DELETE FROM files WHERE id = ?', id);
    removeUpload(f.path);
    if (f.message_id) {
      const m = getMessageRow(f.message_id);
      // a file-only message with no files left is removed
      if (m && !m.text.trim() && !get('SELECT 1 FROM files WHERE message_id = ?', m.id) && m.reply_count === 0) {
        run("UPDATE messages SET deleted_at = ? WHERE id = ?", now(), m.id);
        toChannel(m.channel_id).emit('message:deleted', { id: m.id, channelId: m.channel_id, threadRootId: m.thread_root_id });
      } else emitMessageUpdated(f.message_id);
    }
    return { ok: true };
  });

  // Mark as unread from a message: sets last_read just before it.
  app.post('/api/messages/:id/unread', async (req) => {
    const mid = Number((req.params as { id: string }).id);
    const row = getMessageRow(mid);
    if (!row) throw notFound();
    assertMember(req.user.id, row.channel_id);
    if (row.thread_root_id && !row.also_in_channel) {
      run('UPDATE thread_follows SET last_read = ? WHERE user_id = ? AND root_id = ?', mid - 1, req.user.id, row.thread_root_id);
      toUser(req.user.id).emit('thread:read', { rootId: row.thread_root_id, lastRead: mid - 1 });
      return { ok: true };
    }
    const prev = get<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channel_id = ? AND id < ?', row.channel_id, mid)!.id;
    run('UPDATE channel_members SET last_read = ? WHERE channel_id = ? AND user_id = ?', prev, row.channel_id, req.user.id);
    run("UPDATE activity SET read = 0 WHERE user_id = ? AND channel_id = ? AND kind = 'mention' AND message_id > ?", req.user.id, row.channel_id, prev);
    emitMembership(req.user.id, row.channel_id);
    return { ok: true };
  });
}

/** Incoming webhooks: POST {text, username?} to /api/hooks/:token */
export async function hookRoutes(app: FastifyInstance) {
  app.post('/api/hooks/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = req.params as { token: string };
    const hook = get<{ channel_id: string; name: string }>('SELECT * FROM webhooks WHERE token = ?', token);
    if (!hook) throw notFound();
    const body = parse(z.object({ text: z.string().min(1).max(MAX_TEXT), username: z.string().max(80).optional() }), req.body);
    const ch = getChannelRow(hook.channel_id);
    if (!ch || ch.archived) throw badRequest('channel_unavailable');
    postMessage({ channelId: hook.channel_id, userId: null, text: body.text, subtype: 'bot', botName: body.username || hook.name });
    return { ok: true };
  });
}
