import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, run, tx } from '../db.ts';
import { isAdmin, requireAuth } from '../lib/auth.ts';
import { HttpError, badRequest, forbidden, newId, normalizeChannelName, notFound, now, parse } from '../lib/util.ts';
import {
  assertCanRead,
  assertMember,
  getChannel,
  getChannelRow,
  getMembership,
  hydrateMessages,
  serializeChannel,
  serializeFile,
  type ChannelRow,
  type FileRow,
  type MessageRow,
} from '../model.ts';
import { addMembers, emitChannel, emitMembership, postMessage, removeMember } from '../services.ts';
import { toUser } from '../realtime.ts';

function canManage(user: { id: string; role: string }, ch: ChannelRow) {
  return isAdmin(user) || ch.created_by === user.id;
}

export async function channelRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // Browse: all public channels + private channels the user belongs to.
  app.get('/api/channels', async (req) => {
    const rows = all<ChannelRow>(
      `SELECT * FROM channels WHERE kind = 'public' OR (kind = 'private' AND id IN (SELECT channel_id FROM channel_members WHERE user_id = ?))
       ORDER BY name`,
      req.user.id,
    );
    return rows.map(serializeChannel);
  });

  app.post('/api/channels', async (req) => {
    if (req.user.role === 'guest') throw forbidden();
    const body = parse(
      z.object({ name: z.string().min(1).max(80), isPrivate: z.boolean().optional(), description: z.string().max(250).optional(), memberIds: z.array(z.string()).max(500).optional() }),
      req.body,
    );
    const name = normalizeChannelName(body.name);
    if (!name) throw badRequest('invalid_name');
    if (get("SELECT 1 FROM channels WHERE name = ? AND kind IN ('public','private')", name)) throw new HttpError(409, 'name_taken');
    const id = newId('C');
    run(
      'INSERT INTO channels (id, kind, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      body.isPrivate ? 'private' : 'public',
      name,
      body.description ?? '',
      req.user.id,
      now(),
    );
    addMembers(id, [req.user.id], null, false);
    if (body.memberIds?.length) addMembers(id, body.memberIds.filter((m) => m !== req.user.id), req.user.id);
    emitChannel(id);
    return getChannel(id);
  });

  // Open (find or create) a direct message / group DM.
  app.post('/api/dms', async (req) => {
    const body = parse(z.object({ userIds: z.array(z.string()).min(0).max(8) }), req.body);
    const ids = [...new Set([req.user.id, ...body.userIds])].sort();
    for (const uid of ids) if (!get('SELECT 1 FROM users WHERE id = ? AND deactivated = 0', uid)) throw badRequest('invalid_user');
    const key = ids.join(',');
    let row = get<ChannelRow>('SELECT * FROM channels WHERE dm_key = ?', key);
    if (!row) {
      const id = newId('D');
      run('INSERT INTO channels (id, kind, created_by, created_at, dm_key) VALUES (?, ?, ?, ?, ?)', id, ids.length <= 2 ? 'dm' : 'group', req.user.id, now(), key);
      addMembers(id, ids, req.user.id, false);
      row = getChannelRow(id)!;
    }
    if (get('SELECT hidden FROM channel_members WHERE channel_id = ? AND user_id = ? AND hidden = 1', row.id, req.user.id)) {
      run('UPDATE channel_members SET hidden = 0 WHERE channel_id = ? AND user_id = ?', row.id, req.user.id);
      emitMembership(req.user.id, row.id);
    }
    return { channel: serializeChannel(row), membership: getMembership(req.user.id, row.id) };
  });

  // Latest message of each DM / group DM (for the DMs list previews).
  app.get('/api/dms/latest', async (req) => {
    const rows = all<MessageRow>(
      `SELECT m.* FROM messages m JOIN (
         SELECT channel_id, MAX(id) AS id FROM messages
         WHERE (thread_root_id IS NULL OR also_in_channel = 1) AND deleted_at IS NULL AND subtype IS NULL
           AND channel_id IN (SELECT c.id FROM channels c JOIN channel_members cm ON cm.channel_id = c.id WHERE cm.user_id = ? AND c.kind IN ('dm', 'group'))
         GROUP BY channel_id) x ON x.id = m.id`,
      req.user.id,
    );
    return hydrateMessages(rows);
  });

  app.get('/api/channels/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { ch } = assertCanRead(req.user, id);
    return { channel: serializeChannel(ch), membership: getMembership(req.user.id, id) };
  });

  app.patch('/api/channels/:id', async (req) => {
    const { id } = req.params as { id: string };
    const ch = assertMember(req.user.id, id);
    const body = parse(z.object({ name: z.string().min(1).max(80).optional(), topic: z.string().max(250).optional(), description: z.string().max(250).optional(), isDefault: z.boolean().optional() }), req.body);
    if (body.name !== undefined) {
      if (ch.kind === 'dm' || ch.kind === 'group') throw badRequest('cannot_rename_dm');
      if (!canManage(req.user, ch)) throw forbidden();
      const name = normalizeChannelName(body.name);
      if (!name) throw badRequest('invalid_name');
      if (name !== ch.name) {
        if (get("SELECT 1 FROM channels WHERE name = ? AND kind IN ('public','private') AND id != ?", name, id)) throw new HttpError(409, 'name_taken');
        run('UPDATE channels SET name = ? WHERE id = ?', name, id);
        postMessage({ channelId: id, userId: req.user.id, text: name, subtype: 'rename' });
      }
    }
    if (body.topic !== undefined && body.topic !== ch.topic) {
      run('UPDATE channels SET topic = ? WHERE id = ?', body.topic, id);
      postMessage({ channelId: id, userId: req.user.id, text: body.topic, subtype: 'topic' });
    }
    if (body.description !== undefined && body.description !== ch.description) {
      run('UPDATE channels SET description = ? WHERE id = ?', body.description, id);
      postMessage({ channelId: id, userId: req.user.id, text: body.description, subtype: 'description' });
    }
    if (body.isDefault !== undefined) {
      if (!isAdmin(req.user) || ch.kind !== 'public') throw forbidden();
      run('UPDATE channels SET is_default = ? WHERE id = ?', body.isDefault ? 1 : 0, id);
    }
    emitChannel(id);
    return getChannel(id);
  });

  app.post('/api/channels/:id/join', async (req) => {
    const { id } = req.params as { id: string };
    const ch = getChannelRow(id);
    if (!ch) throw notFound();
    if (ch.kind !== 'public' || req.user.role === 'guest') throw forbidden('cannot_join');
    if (ch.archived) throw badRequest('channel_archived');
    addMembers(id, [req.user.id], null);
    return { channel: getChannel(id), membership: getMembership(req.user.id, id) };
  });

  app.post('/api/channels/:id/leave', async (req) => {
    const { id } = req.params as { id: string };
    const ch = assertMember(req.user.id, id);
    if (ch.kind === 'dm' || ch.kind === 'group') {
      // DMs are "closed" (hidden) rather than left
      run('UPDATE channel_members SET hidden = 1 WHERE channel_id = ? AND user_id = ?', id, req.user.id);
      emitMembership(req.user.id, id);
      return { ok: true };
    }
    if (ch.is_default && ch.name === 'general') throw badRequest('cannot_leave_general');
    removeMember(id, req.user.id);
    return { ok: true };
  });

  app.post('/api/channels/:id/archive', async (req) => {
    const { id } = req.params as { id: string };
    const ch = assertMember(req.user.id, id);
    if (!canManage(req.user, ch) || ch.kind === 'dm' || ch.kind === 'group') throw forbidden();
    if (ch.is_default && ch.name === 'general') throw badRequest('cannot_archive_general');
    postMessage({ channelId: id, userId: req.user.id, text: '', subtype: 'archive' });
    run('UPDATE channels SET archived = 1 WHERE id = ?', id);
    emitChannel(id);
    return getChannel(id);
  });

  app.post('/api/channels/:id/unarchive', async (req) => {
    const { id } = req.params as { id: string };
    const ch = getChannelRow(id);
    if (!ch) throw notFound();
    if (!canManage(req.user, ch)) throw forbidden();
    run('UPDATE channels SET archived = 0 WHERE id = ?', id);
    postMessage({ channelId: id, userId: req.user.id, text: '', subtype: 'unarchive' });
    emitChannel(id);
    return getChannel(id);
  });

  app.delete('/api/channels/:id', async (req) => {
    const { id } = req.params as { id: string };
    const ch = getChannelRow(id);
    if (!ch) throw notFound();
    if (!isAdmin(req.user) || ch.kind === 'dm' || ch.kind === 'group') throw forbidden();
    if (ch.is_default && ch.name === 'general') throw badRequest('cannot_delete_general');
    const members = all<{ user_id: string }>('SELECT user_id FROM channel_members WHERE channel_id = ?', id);
    tx(() => {
      run('DELETE FROM activity WHERE channel_id = ?', id);
      run('DELETE FROM drafts WHERE channel_id = ?', id);
      run('DELETE FROM scheduled WHERE channel_id = ?', id);
      run('UPDATE files SET message_id = NULL, channel_id = NULL WHERE channel_id = ?', id);
      run('DELETE FROM channels WHERE id = ?', id);
    });
    for (const m of members) toUser(m.user_id).emit('channel:removed', { channelId: id });
    return { ok: true };
  });

  app.get('/api/channels/:id/members', async (req) => {
    const { id } = req.params as { id: string };
    assertCanRead(req.user, id);
    return all<{ user_id: string }>('SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY joined_at', id).map((r) => r.user_id);
  });

  app.post('/api/channels/:id/members', async (req) => {
    const { id } = req.params as { id: string };
    const ch = assertMember(req.user.id, id);
    if (ch.kind === 'dm' || ch.kind === 'group') throw badRequest('cannot_add_to_dm');
    if (ch.archived) throw badRequest('channel_archived');
    if (req.user.role === 'guest') throw forbidden();
    const body = parse(z.object({ userIds: z.array(z.string()).min(1).max(500) }), req.body);
    addMembers(id, body.userIds, req.user.id);
    return getChannel(id);
  });

  app.delete('/api/channels/:id/members/:userId', async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const ch = assertMember(req.user.id, id);
    if (ch.kind === 'dm' || ch.kind === 'group') throw badRequest('cannot_remove_from_dm');
    if (userId !== req.user.id && !canManage(req.user, ch)) throw forbidden();
    if (ch.is_default && ch.name === 'general') throw badRequest('cannot_leave_general');
    removeMember(id, userId);
    return getChannel(id);
  });

  // Mark read up to a message (or mark unread by passing a lower id).
  app.put('/api/channels/:id/read', async (req) => {
    const { id } = req.params as { id: string };
    assertMember(req.user.id, id);
    const body = parse(z.object({ messageId: z.number().int().min(0) }), req.body);
    run('UPDATE channel_members SET last_read = ? WHERE channel_id = ? AND user_id = ?', body.messageId, id, req.user.id);
    run("UPDATE activity SET read = 1 WHERE user_id = ? AND channel_id = ? AND kind = 'mention' AND message_id <= ? AND read = 0", req.user.id, id, body.messageId);
    run("UPDATE activity SET read = 0 WHERE user_id = ? AND channel_id = ? AND kind = 'mention' AND message_id > ? AND read = 1", req.user.id, id, body.messageId);
    emitMembership(req.user.id, id);
    return getMembership(req.user.id, id);
  });

  app.put('/api/channels/:id/prefs', async (req) => {
    const { id } = req.params as { id: string };
    assertMember(req.user.id, id);
    const body = parse(z.object({ starred: z.boolean().optional(), muted: z.boolean().optional(), notify: z.enum(['default', 'all', 'mentions', 'none']).optional(), hidden: z.boolean().optional() }), req.body);
    if (body.starred !== undefined) run('UPDATE channel_members SET starred = ? WHERE channel_id = ? AND user_id = ?', body.starred ? 1 : 0, id, req.user.id);
    if (body.muted !== undefined) run('UPDATE channel_members SET muted = ? WHERE channel_id = ? AND user_id = ?', body.muted ? 1 : 0, id, req.user.id);
    if (body.notify !== undefined) run('UPDATE channel_members SET notify = ? WHERE channel_id = ? AND user_id = ?', body.notify, id, req.user.id);
    if (body.hidden !== undefined) run('UPDATE channel_members SET hidden = ? WHERE channel_id = ? AND user_id = ?', body.hidden ? 1 : 0, id, req.user.id);
    emitMembership(req.user.id, id);
    return getMembership(req.user.id, id);
  });

  app.get('/api/channels/:id/pins', async (req) => {
    const { id } = req.params as { id: string };
    assertCanRead(req.user, id);
    const rows = all<MessageRow>('SELECT m.* FROM pins p JOIN messages m ON m.id = p.message_id WHERE p.channel_id = ? AND m.deleted_at IS NULL ORDER BY p.created_at DESC', id);
    return hydrateMessages(rows);
  });

  app.get('/api/channels/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    assertCanRead(req.user, id);
    return all<FileRow>('SELECT * FROM files WHERE channel_id = ? AND message_id IS NOT NULL ORDER BY created_at DESC LIMIT 200', id).map(serializeFile);
  });
}
