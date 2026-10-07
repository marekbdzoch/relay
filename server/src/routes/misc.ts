import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ActivityItem, HuddleSession, LinkItem, SavedItem, ScheduledMessage, SearchResults, ThreadSummary, UnreadGroup } from '../../../shared/types.ts';
import { all, get, placeholders, run } from '../db.ts';
import { requireAuth } from '../lib/auth.ts';
import { badRequest, newId, notFound, now, parse } from '../lib/util.ts';
import { assertMember, hydrateMessages, serializeChannel, serializeFile, serializeUser, type ChannelRow, type FileRow, type MessageRow, type UserRow } from '../model.ts';
import { toUser } from '../realtime.ts';
import { activityUnreadCount, threadsUnreadCount } from '../services.ts';

function accessibleChannelIds(user: { id: string; role: string }) {
  const rows = all<{ id: string }>(
    `SELECT id FROM channels WHERE id IN (SELECT channel_id FROM channel_members WHERE user_id = ?) ${user.role !== 'guest' ? "OR kind = 'public'" : ''}`,
    user.id,
  );
  return rows.map((r) => r.id);
}

function ftsQuery(terms: string) {
  const words = terms
    .split(/\s+/)
    .map((w) => w.replace(/["*^():]/g, '').trim())
    .filter(Boolean);
  if (!words.length) return null;
  return words.map((w) => `"${w}"*`).join(' ');
}

export async function miscRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ----- search -----
  app.get('/api/search', async (req): Promise<SearchResults> => {
    const q = parse(
      z.object({ q: z.string().max(500), type: z.enum(['all', 'messages', 'files', 'channels', 'people']).optional(), sort: z.enum(['relevance', 'newest', 'oldest']).optional(), limit: z.coerce.number().int().max(100).optional(), offset: z.coerce.number().int().min(0).optional() }),
      req.query,
    );
    const type = q.type ?? 'all';
    const limit = q.limit ?? 40;
    const offset = q.offset ?? 0;
    let text = q.q;
    const where: string[] = [];
    const params: (string | number)[] = [];
    let channelFilter: string[] | null = null;

    // modifiers: in:#channel, in:@user, from:@user, before:2024-01-01, after:2024-01-01, is:thread, has:pin
    text = text.replace(/\b(in|from|before|after|on|is|has):(\S+)/gi, (_, key: string, val: string) => {
      key = key.toLowerCase();
      if (key === 'in') {
        if (val.startsWith('@')) {
          const u = get<{ id: string }>('SELECT id FROM users WHERE username = ?', val.slice(1));
          const key2 = u ? [req.user.id, u.id].sort().join(',') : null;
          const dm = key2 ? get<{ id: string }>('SELECT id FROM channels WHERE dm_key = ?', key2) : undefined;
          channelFilter = dm ? [dm.id] : ['__none__'];
        } else {
          const c = get<{ id: string }>("SELECT id FROM channels WHERE name = ? AND kind IN ('public','private')", val.replace(/^#/, ''));
          channelFilter = c ? [c.id] : ['__none__'];
        }
      } else if (key === 'from') {
        const u = get<{ id: string }>('SELECT id FROM users WHERE username = ?', val.replace(/^@/, ''));
        where.push('m.user_id = ?');
        params.push(u?.id ?? '__none__');
      } else if (key === 'before' || key === 'after' || key === 'on') {
        const d = Date.parse(val);
        if (!Number.isNaN(d)) {
          if (key === 'before') {
            where.push('m.created_at < ?');
            params.push(d);
          } else if (key === 'after') {
            where.push('m.created_at >= ?');
            params.push(d + 86400_000);
          } else {
            where.push('m.created_at >= ? AND m.created_at < ?');
            params.push(d, d + 86400_000);
          }
        }
      } else if (key === 'is' && val === 'thread') {
        where.push('(m.thread_root_id IS NOT NULL OR m.reply_count > 0)');
      } else if (key === 'has' && val === 'pin') {
        where.push('m.id IN (SELECT message_id FROM pins)');
      } else if (key === 'has' && (val === 'file' || val === 'files')) {
        where.push('m.id IN (SELECT message_id FROM files WHERE message_id IS NOT NULL)');
      } else if (key === 'has' && val === 'link') {
        where.push("m.text LIKE '%http%'");
      }
      return ' ';
    });

    const accessible = accessibleChannelIds(req.user);
    const scope = channelFilter ? (channelFilter as string[]).filter((c) => accessible.includes(c) || c === '__none__') : accessible;
    const result: SearchResults = { messages: [], files: [], channels: [], users: [], total: 0 };
    const match = ftsQuery(text);

    if ((type === 'all' || type === 'messages') && scope.length && (match || where.length)) {
      const order = q.sort === 'oldest' ? 'm.id ASC' : q.sort === 'newest' || !match ? 'm.id DESC' : 'bm25(messages_fts), m.id DESC';
      const sql = `FROM messages m ${match ? 'JOIN messages_fts f ON f.rowid = m.id' : ''}
        WHERE m.deleted_at IS NULL AND m.subtype IS NULL AND m.channel_id IN (${placeholders(scope.length)})
        ${match ? 'AND messages_fts MATCH ?' : ''} ${where.length ? 'AND ' + where.join(' AND ') : ''}`;
      const args = [...scope, ...(match ? [match] : []), ...params];
      result.total = get<{ n: number }>(`SELECT COUNT(*) AS n ${sql}`, ...args)!.n;
      result.messages = hydrateMessages(all<MessageRow>(`SELECT m.* ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, limit, offset));
    }
    if ((type === 'all' || type === 'files') && scope.length) {
      const fm = ftsQuery(text);
      if (fm) {
        result.files = all<FileRow>(
          `SELECT f.* FROM files f JOIN files_fts ON files_fts.rowid = f.rowid WHERE files_fts MATCH ? AND f.message_id IS NOT NULL AND f.channel_id IN (${placeholders(scope.length)}) ORDER BY f.created_at DESC LIMIT ?`,
          fm,
          ...scope,
          type === 'files' ? limit : 10,
        ).map(serializeFile);
      }
    }
    const plain = text.trim().toLowerCase();
    if ((type === 'all' || type === 'channels') && plain) {
      result.channels = all<ChannelRow>(
        `SELECT * FROM channels WHERE kind IN ('public','private') AND id IN (${placeholders(accessible.length || 1)}) AND (name LIKE ? OR topic LIKE ? OR description LIKE ?) ORDER BY archived, name LIMIT 20`,
        ...(accessible.length ? accessible : ['__none__']),
        `%${plain}%`,
        `%${plain}%`,
        `%${plain}%`,
      ).map(serializeChannel);
    }
    if ((type === 'all' || type === 'people') && plain) {
      result.users = all<UserRow>(
        'SELECT * FROM users WHERE full_name LIKE ? OR display_name LIKE ? OR username LIKE ? OR title LIKE ? ORDER BY deactivated, full_name LIMIT 30',
        `%${plain}%`,
        `%${plain}%`,
        `%${plain}%`,
        `%${plain}%`,
      ).map((u) => serializeUser(u));
    }
    return result;
  });

  app.get('/api/counts', async (req) => ({ activityUnread: activityUnreadCount(req.user.id), threadsUnread: threadsUnreadCount(req.user.id) }));

  // ----- activity (stored items + direct messages, newest first, paged by time) -----
  app.get('/api/activity', async (req) => {
    const q = parse(
      z.object({ before: z.coerce.number().int().optional(), filter: z.enum(['all', 'dms', 'mentions', 'reactions', 'threads', 'reminders', 'unread']).optional() }),
      req.query,
    );
    const filter = q.filter ?? 'all';
    const before = q.before ?? Number.MAX_SAFE_INTEGER;
    const uid = req.user.id;
    const kinds: Record<string, string> = {
      mentions: "AND a.kind = 'mention'",
      reactions: "AND a.kind = 'reaction'",
      threads: "AND a.kind = 'thread_reply'",
      reminders: "AND a.kind = 'reminder'",
      unread: 'AND a.read = 0',
      all: '',
    };
    type Row = { id: number; kind: string; message_id: number | null; actor_id: string | null; channel_id: string; emoji: string | null; created_at: number; read: number };
    let rows: Row[] = [];
    if (filter !== 'dms') {
      rows = all<Row>(`SELECT a.* FROM activity a WHERE a.user_id = ? AND a.created_at < ? ${kinds[filter]} ORDER BY a.created_at DESC LIMIT 50`, uid, before);
    }
    if (filter === 'all' || filter === 'dms' || filter === 'unread') {
      // DMs are not stored as activity; derive them from the messages
      const dms = all<MessageRow & { last_read: number }>(
        `SELECT m.*, cm.last_read FROM messages m
         JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
         JOIN channels c ON c.id = m.channel_id
         WHERE c.kind IN ('dm', 'group') AND m.deleted_at IS NULL AND m.subtype IS NULL AND (m.thread_root_id IS NULL OR m.also_in_channel = 1)
           AND (m.user_id IS NULL OR m.user_id != ?) AND m.created_at < ? ${filter === 'unread' ? 'AND m.id > cm.last_read' : ''}
         ORDER BY m.created_at DESC LIMIT 50`,
        uid,
        uid,
        before,
      );
      rows.push(
        ...dms.map((m) => ({ id: -m.id, kind: 'dm', message_id: m.id, actor_id: m.user_id, channel_id: m.channel_id, emoji: null, created_at: m.created_at, read: m.id <= m.last_read ? 1 : 0 })),
      );
      rows.sort((a, b) => b.created_at - a.created_at);
      rows = rows.slice(0, 50);
    }
    const msgIds = [...new Set(rows.map((r) => r.message_id).filter((x): x is number => !!x))];
    const msgs = new Map(hydrateMessages(msgIds.length ? all<MessageRow>(`SELECT * FROM messages WHERE id IN (${placeholders(msgIds.length)})`, ...msgIds) : []).map((m) => [m.id, m]));
    return rows.map(
      (r): ActivityItem => ({
        id: r.id,
        kind: r.kind as ActivityItem['kind'],
        actorId: r.actor_id,
        channelId: r.channel_id,
        emoji: r.emoji,
        read: !!r.read,
        createdAt: r.created_at,
        message: r.message_id ? msgs.get(r.message_id) ?? null : null,
      }),
    );
  });

  app.put('/api/activity/read', async (req) => {
    const body = parse(z.object({ ids: z.array(z.number().int()).max(500).optional(), all: z.boolean().optional(), read: z.boolean().optional() }), req.body);
    const read = body.read === false ? 0 : 1;
    if (body.all) run('UPDATE activity SET read = ? WHERE user_id = ?', read, req.user.id);
    else if (body.ids?.length) run(`UPDATE activity SET read = ? WHERE user_id = ? AND id IN (${placeholders(body.ids.length)})`, read, req.user.id, ...body.ids);
    return { ok: true };
  });

  // ----- threads view -----
  app.get('/api/threads', async (req): Promise<ThreadSummary[]> => {
    const rows = all<MessageRow & { tf_last_read: number }>(
      `SELECT r.*, tf.last_read AS tf_last_read FROM thread_follows tf JOIN messages r ON r.id = tf.root_id
       WHERE tf.user_id = ? AND tf.following = 1 AND r.reply_count > 0 AND r.channel_id IN (SELECT channel_id FROM channel_members WHERE user_id = ?)
       ORDER BY r.last_reply_at DESC LIMIT 50`,
      req.user.id,
      req.user.id,
    );
    const roots = hydrateMessages(rows);
    return roots.map((root, i) => {
      const lastRead = rows[i].tf_last_read;
      const replies = all<MessageRow>('SELECT * FROM messages WHERE thread_root_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 3', root.id).reverse();
      const unread = get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM messages WHERE thread_root_id = ? AND id > ? AND deleted_at IS NULL AND (user_id IS NULL OR user_id != ?)',
        root.id,
        lastRead,
        req.user.id,
      )!.n;
      return { root, replies: hydrateMessages(replies), lastRead, unread };
    });
  });

  // ----- saved for later (state: 0 in progress, 1 completed, 2 archived) -----
  app.get('/api/saved', async (req) => {
    const q = parse(z.object({ state: z.enum(['progress', 'completed', 'archived']).optional() }), req.query);
    const code = { progress: 0, completed: 1, archived: 2 }[q.state ?? 'progress'];
    const rows = all<MessageRow & { saved_at: number; saved_done: number; remind_at: number | null }>(
      `SELECT m.*, s.created_at AS saved_at, s.done AS saved_done, s.remind_at FROM saved s JOIN messages m ON m.id = s.message_id
       WHERE s.user_id = ? AND s.done = ? AND m.deleted_at IS NULL
       ORDER BY CASE WHEN s.remind_at IS NULL THEN 1 ELSE 0 END, s.remind_at, s.created_at DESC LIMIT 300`,
      req.user.id,
      code,
    );
    const msgs = hydrateMessages(rows);
    const states = ['progress', 'completed', 'archived'] as const;
    return msgs.map((m, i): SavedItem => ({ message: m, savedAt: rows[i].saved_at, state: states[rows[i].saved_done] ?? 'progress', remindAt: rows[i].remind_at }));
  });

  app.get('/api/saved/count', async (req) => ({ count: get<{ n: number }>('SELECT COUNT(*) AS n FROM saved WHERE user_id = ? AND done = 0', req.user.id)!.n }));

  // ----- unreads view -----
  app.get('/api/unreads', async (req): Promise<UnreadGroup[]> => {
    const mems = all<{ channel_id: string; last_read: number }>(
      `SELECT cm.channel_id, cm.last_read FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
       WHERE cm.user_id = ? AND cm.muted = 0 AND c.archived = 0 AND c.last_message_at IS NOT NULL`,
      req.user.id,
    );
    const out: UnreadGroup[] = [];
    for (const m of mems) {
      const base = `FROM messages WHERE channel_id = ? AND id > ? AND deleted_at IS NULL AND (thread_root_id IS NULL OR also_in_channel = 1) AND (user_id IS NULL OR user_id != ?)`;
      const total = get<{ n: number }>(`SELECT COUNT(*) AS n ${base}`, m.channel_id, m.last_read, req.user.id)!.n;
      if (!total) continue;
      const rows = all<MessageRow>(`SELECT * ${base} ORDER BY id DESC LIMIT 15`, m.channel_id, m.last_read, req.user.id).reverse();
      out.push({ channelId: m.channel_id, messages: hydrateMessages(rows), total });
    }
    return out.sort((a, b) => (b.messages.at(-1)?.createdAt ?? 0) - (a.messages.at(-1)?.createdAt ?? 0));
  });

  // ----- huddle history -----
  app.get('/api/huddles', async (req): Promise<HuddleSession[]> => {
    const rows = all<{ id: number; channel_id: string; started_by: string | null; started_at: number; ended_at: number | null; participants: string }>(
      `SELECT * FROM huddle_sessions WHERE channel_id IN (SELECT channel_id FROM channel_members WHERE user_id = ?) ORDER BY started_at DESC LIMIT 100`,
      req.user.id,
    );
    return rows.map((r) => ({ id: r.id, channelId: r.channel_id, startedBy: r.started_by, startedAt: r.started_at, endedAt: r.ended_at, participantIds: JSON.parse(r.participants) }));
  });

  // ----- drafts -----
  app.put('/api/drafts', async (req) => {
    const body = parse(z.object({ channelId: z.string(), threadRootId: z.number().int().nullable().optional(), text: z.string().max(40000) }), req.body);
    assertMember(req.user.id, body.channelId);
    const t = now();
    const root = body.threadRootId ?? 0;
    if (!body.text.trim()) {
      run('DELETE FROM drafts WHERE user_id = ? AND channel_id = ? AND thread_root_id = ?', req.user.id, body.channelId, root);
      toUser(req.user.id).emit('draft:changed', { channelId: body.channelId, threadRootId: body.threadRootId ?? null, text: '', updatedAt: t, deleted: true });
    } else {
      run(
        `INSERT INTO drafts (user_id, channel_id, thread_root_id, text, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, channel_id, thread_root_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
        req.user.id,
        body.channelId,
        root,
        body.text,
        t,
      );
      toUser(req.user.id).emit('draft:changed', { channelId: body.channelId, threadRootId: body.threadRootId ?? null, text: body.text, updatedAt: t });
    }
    return { ok: true };
  });

  // ----- scheduled messages -----
  const serializeScheduled = (r: any): ScheduledMessage => ({
    id: r.id,
    channelId: r.channel_id,
    threadRootId: r.thread_root_id,
    text: r.text,
    sendAt: r.send_at,
    createdAt: r.created_at,
  });

  app.get('/api/scheduled', async (req) => all('SELECT * FROM scheduled WHERE user_id = ? ORDER BY send_at', req.user.id).map(serializeScheduled));

  app.post('/api/scheduled', async (req) => {
    const body = parse(z.object({ channelId: z.string(), threadRootId: z.number().int().nullable().optional(), text: z.string().min(1).max(40000), sendAt: z.number().int() }), req.body);
    assertMember(req.user.id, body.channelId);
    if (body.sendAt < now() + 30_000) throw badRequest('send_at_in_past');
    const id = newId('S');
    run('INSERT INTO scheduled (id, user_id, channel_id, thread_root_id, text, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, req.user.id, body.channelId, body.threadRootId ?? null, body.text, body.sendAt, now());
    return serializeScheduled(get('SELECT * FROM scheduled WHERE id = ?', id));
  });

  app.patch('/api/scheduled/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ text: z.string().min(1).max(40000).optional(), sendAt: z.number().int().optional() }), req.body);
    const row = get('SELECT * FROM scheduled WHERE id = ? AND user_id = ?', id, req.user.id);
    if (!row) throw notFound();
    if (body.text) run('UPDATE scheduled SET text = ? WHERE id = ?', body.text, id);
    if (body.sendAt) run('UPDATE scheduled SET send_at = ? WHERE id = ?', body.sendAt, id);
    return serializeScheduled(get('SELECT * FROM scheduled WHERE id = ?', id));
  });

  app.delete('/api/scheduled/:id', async (req) => {
    run('DELETE FROM scheduled WHERE id = ? AND user_id = ?', (req.params as { id: string }).id, req.user.id);
    return { ok: true };
  });

  // ----- sent messages (for "Drafts & sent") -----
  app.get('/api/sent', async (req) => {
    const rows = all<MessageRow>('SELECT * FROM messages WHERE user_id = ? AND deleted_at IS NULL AND subtype IS NULL ORDER BY id DESC LIMIT 50', req.user.id);
    return hydrateMessages(rows);
  });

  // ----- files browser -----
  app.get('/api/files', async (req) => {
    const q = parse(
      z.object({
        // "?mine=0" / "?mine=false" must mean false (z.coerce.boolean() turns any non-empty string into true)
        mine: z.stringbool().optional(),
        shared: z.stringbool().optional(),
        type: z.enum(['all', 'images', 'pdfs', 'documents', 'spreadsheets', 'media', 'archives', 'other']).optional(),
        q: z.string().max(200).optional(),
        sort: z.enum(['newest', 'oldest', 'name', 'size']).optional(),
        channelId: z.string().optional(),
      }),
      req.query,
    );
    const scope = q.channelId ? accessibleChannelIds(req.user).filter((c) => c === q.channelId) : accessibleChannelIds(req.user);
    if (!scope.length) return [];
    const where = [`f.message_id IS NOT NULL`, `f.channel_id IN (${placeholders(scope.length)})`];
    const params: (string | number)[] = [...scope];
    if (q.mine) {
      where.push('f.user_id = ?');
      params.push(req.user.id);
    } else if (q.shared) {
      where.push('f.user_id != ?');
      params.push(req.user.id);
    }
    const typeSql: Record<string, string> = {
      images: "f.mime LIKE 'image/%'",
      pdfs: "f.mime = 'application/pdf'",
      media: "(f.mime LIKE 'video/%' OR f.mime LIKE 'audio/%')",
      documents: "(f.mime LIKE '%word%' OR f.mime LIKE '%opendocument.text%' OR f.mime LIKE 'text/%' OR f.name LIKE '%.doc' OR f.name LIKE '%.docx' OR f.name LIKE '%.md' OR f.name LIKE '%.txt')",
      spreadsheets: "(f.mime LIKE '%sheet%' OR f.mime LIKE '%excel%' OR f.mime = 'text/csv' OR f.name LIKE '%.csv' OR f.name LIKE '%.xlsx')",
      archives: "(f.mime LIKE '%zip%' OR f.mime LIKE '%compressed%' OR f.mime LIKE '%tar%' OR f.name LIKE '%.rar' OR f.name LIKE '%.7z')",
    };
    if (q.type && q.type !== 'all') {
      if (q.type === 'other') where.push(`NOT (${Object.values(typeSql).join(' OR ')})`);
      else where.push(typeSql[q.type]);
    }
    if (q.q?.trim()) {
      where.push('f.name LIKE ?');
      params.push(`%${q.q.trim()}%`);
    }
    const order = { newest: 'f.created_at DESC', oldest: 'f.created_at ASC', name: 'f.name COLLATE NOCASE', size: 'f.size DESC' }[q.sort ?? 'newest'];
    return all<FileRow>(`SELECT f.* FROM files f WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 300`, ...params).map(serializeFile);
  });

  // ----- links shared in a channel -----
  app.get('/api/channels/:id/links', async (req): Promise<LinkItem[]> => {
    const { id } = req.params as { id: string };
    if (!accessibleChannelIds(req.user).includes(id)) return [];
    const rows = all<MessageRow>(
      "SELECT * FROM messages WHERE channel_id = ? AND deleted_at IS NULL AND text LIKE '%http%' ORDER BY id DESC LIMIT 300",
      id,
    );
    const out: LinkItem[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const unfurls = (JSON.parse(r.meta || '{}').unfurls ?? []) as { url: string; title?: string }[];
      for (const m of r.text.replace(/```[\s\S]*?```/g, '').matchAll(/<?(https?:\/\/[^\s<>|]+)(?:\|([^>]+))?>?/g)) {
        const url = m[1].replace(/[>.,)]+$/, '');
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({ url, title: unfurls.find((u) => u.url === url)?.title ?? m[2] ?? null, messageId: r.id, userId: r.user_id, createdAt: r.created_at });
      }
    }
    return out.slice(0, 200);
  });
}
