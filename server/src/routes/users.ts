import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BootstrapResponse, Draft, Invite, UserPrefs } from '../../../shared/types.ts';
import { all, get, run } from '../db.ts';
import { config } from '../config.ts';
import { isAdmin, requireAdmin, requireAuth } from '../lib/auth.ts';
import { absPath, isSafeInline, removeUpload, saveUpload } from '../lib/files.ts';
import { HttpError, badRequest, forbidden, json, newId, normalizeUsername, notFound, now, parse, randomToken } from '../lib/util.ts';
import { getMe, getMemberships, getUserRow, getWorkspace, listCustomEmoji, serializeChannel, serializeUser, type ChannelRow, type UserRow } from '../model.ts';
import { activityUnreadCount, threadsUnreadCount } from '../services.ts';
import { listAgents } from '../agents/store.ts';
import { allPresence, broadcastPresence, disconnectUser, io, listHuddles, toUser } from '../realtime.ts';

function emitUser(userId: string) {
  const row = getUserRow(userId);
  if (!row) return;
  io.emit('user:upsert', serializeUser(row));
  toUser(userId).emit('me:updated', getMe(userId));
}

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/;

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/bootstrap', async (req): Promise<BootstrapResponse> => {
    const uid = req.user.id;
    const admin = isAdmin(req.user);
    const users = all<UserRow>('SELECT * FROM users ORDER BY full_name COLLATE NOCASE').map((u) => serializeUser(u, admin));
    const channels = all<ChannelRow>(
      `SELECT c.* FROM channels c WHERE c.id IN (SELECT channel_id FROM channel_members WHERE user_id = ?)`,
      uid,
    ).map(serializeChannel);
    const drafts = all<{ channel_id: string; thread_root_id: number; text: string; updated_at: number }>('SELECT * FROM drafts WHERE user_id = ?', uid).map(
      (d): Draft => ({ channelId: d.channel_id, threadRootId: d.thread_root_id || null, text: d.text, updatedAt: d.updated_at }),
    );
    return {
      me: getMe(uid),
      workspace: getWorkspace(),
      users,
      channels,
      memberships: getMemberships(uid),
      presence: allPresence(),
      savedIds: all<{ message_id: number }>('SELECT message_id FROM saved WHERE user_id = ? AND done = 0', uid).map((r) => r.message_id),
      agents: listAgents(),
      drafts,
      customEmoji: listCustomEmoji(),
      huddles: listHuddles().filter((h) => channels.some((c) => c.id === h.channelId)),
      activityUnread: activityUnreadCount(uid),
      threadsUnread: threadsUnreadCount(uid),
      version: config.version,
    };
  });

  app.get('/api/users', async (req) => {
    const admin = isAdmin(req.user);
    return all<UserRow>('SELECT * FROM users ORDER BY full_name COLLATE NOCASE').map((u) => serializeUser(u, admin));
  });

  app.get('/api/users/:id', async (req) => {
    const row = getUserRow((req.params as { id: string }).id);
    if (!row) throw notFound();
    return serializeUser(row, isAdmin(req.user) || row.id === req.user.id);
  });

  app.patch('/api/users/me', async (req) => {
    const body = parse(
      z.object({
        fullName: z.string().trim().min(1).max(80).optional(),
        displayName: z.string().trim().max(80).optional(),
        title: z.string().trim().max(120).optional(),
        phone: z.string().trim().max(40).optional(),
        timezone: z.string().trim().max(64).optional(),
        username: z.string().trim().min(1).max(40).optional(),
      }),
      req.body,
    );
    const map: Record<string, string> = { fullName: 'full_name', displayName: 'display_name', title: 'title', phone: 'phone', timezone: 'timezone' };
    for (const [k, col] of Object.entries(map)) {
      const v = (body as Record<string, string | undefined>)[k];
      if (v !== undefined) run(`UPDATE users SET ${col} = ? WHERE id = ?`, v, req.user.id);
    }
    if (body.username !== undefined) {
      const u = normalizeUsername(body.username);
      if (!u) throw badRequest('invalid_username');
      if (get('SELECT 1 FROM users WHERE username = ? AND id != ?', u, req.user.id)) throw new HttpError(409, 'username_taken');
      run('UPDATE users SET username = ? WHERE id = ?', u, req.user.id);
    }
    emitUser(req.user.id);
    return getMe(req.user.id);
  });

  app.put('/api/users/me/avatar', async (req) => {
    const part = await req.file({ limits: { fileSize: 10 * 1024 * 1024 } });
    if (!part) throw badRequest('no_file');
    if (!IMAGE_MIME.test(part.mimetype)) throw badRequest('unsupported_image');
    const saved = await saveUpload(part, 'avatars');
    const old = getUserRow(req.user.id)?.avatar_path;
    run('UPDATE users SET avatar_path = ? WHERE id = ?', saved.rel, req.user.id);
    removeUpload(old);
    emitUser(req.user.id);
    return getMe(req.user.id);
  });

  app.delete('/api/users/me/avatar', async (req) => {
    removeUpload(getUserRow(req.user.id)?.avatar_path);
    run('UPDATE users SET avatar_path = NULL WHERE id = ?', req.user.id);
    emitUser(req.user.id);
    return getMe(req.user.id);
  });

  app.put('/api/users/me/status', async (req) => {
    const body = parse(z.object({ emoji: z.string().max(64), text: z.string().max(100), expiresAt: z.number().nullable().optional() }), req.body);
    run('UPDATE users SET status_emoji = ?, status_text = ?, status_expires_at = ? WHERE id = ?', body.emoji, body.text, body.expiresAt ?? null, req.user.id);
    emitUser(req.user.id);
    return getMe(req.user.id);
  });

  app.put('/api/users/me/presence', async (req) => {
    const body = parse(z.object({ away: z.boolean() }), req.body);
    run('UPDATE users SET away_manual = ? WHERE id = ?', body.away ? 1 : 0, req.user.id);
    broadcastPresence(req.user.id);
    toUser(req.user.id).emit('me:updated', getMe(req.user.id));
    return getMe(req.user.id);
  });

  app.put('/api/users/me/dnd', async (req) => {
    const body = parse(z.object({ until: z.number().nullable() }), req.body);
    run('UPDATE users SET dnd_until = ? WHERE id = ?', body.until, req.user.id);
    emitUser(req.user.id);
    return getMe(req.user.id);
  });

  app.put('/api/users/me/prefs', async (req) => {
    const body = parse(z.record(z.string(), z.unknown()), req.body) as Partial<UserPrefs>;
    const current = json<UserPrefs>(getUserRow(req.user.id)?.prefs, {});
    const next = { ...current, ...body };
    const s = JSON.stringify(next);
    if (s.length > 20000) throw badRequest('prefs_too_large');
    run('UPDATE users SET prefs = ? WHERE id = ?', s, req.user.id);
    const me = getMe(req.user.id);
    toUser(req.user.id).emit('me:updated', me);
    return me;
  });

  // ----- admin: members -----
  app.patch('/api/users/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = parse(z.object({ role: z.enum(['owner', 'admin', 'member', 'guest']).optional(), deactivated: z.boolean().optional(), fullName: z.string().trim().min(1).max(80).optional() }), req.body);
    const target = getUserRow(id);
    if (!target) throw notFound();
    if (target.role === 'owner' && req.user.role !== 'owner') throw forbidden('owner_only');
    if (body.role === 'owner' && req.user.role !== 'owner') throw forbidden('owner_only');
    if (id === req.user.id && (body.deactivated || (body.role && body.role !== req.user.role))) throw badRequest('cannot_change_self');
    if (body.role) run('UPDATE users SET role = ? WHERE id = ?', body.role, id);
    if (body.fullName) run('UPDATE users SET full_name = ? WHERE id = ?', body.fullName, id);
    if (body.deactivated !== undefined) {
      run('UPDATE users SET deactivated = ? WHERE id = ?', body.deactivated ? 1 : 0, id);
      if (body.deactivated) {
        run('DELETE FROM sessions WHERE user_id = ?', id);
        disconnectUser(id);
      }
    }
    emitUser(id);
    return serializeUser(getUserRow(id)!, true);
  });

  // ----- workspace settings -----
  app.patch('/api/workspace', async (req) => {
    requireAdmin(req);
    const body = parse(z.object({ name: z.string().trim().min(1).max(80).optional(), allowedDomains: z.string().max(500).optional() }), req.body);
    if (body.name) run('UPDATE workspace SET name = ? WHERE id = 1', body.name);
    if (body.allowedDomains !== undefined) {
      const clean = body.allowedDomains
        .split(/[,\s]+/)
        .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean)
        .join(',');
      run('UPDATE workspace SET allowed_domains = ? WHERE id = 1', clean);
    }
    const w = getWorkspace();
    io.emit('workspace:updated', w);
    return w;
  });

  app.put('/api/workspace/icon', async (req) => {
    requireAdmin(req);
    const part = await req.file({ limits: { fileSize: 5 * 1024 * 1024 } });
    if (!part || !IMAGE_MIME.test(part.mimetype)) throw badRequest('unsupported_image');
    const saved = await saveUpload(part, 'workspace');
    const old = get<{ icon_path: string | null }>('SELECT icon_path FROM workspace WHERE id = 1')?.icon_path;
    run('UPDATE workspace SET icon_path = ? WHERE id = 1', saved.rel);
    removeUpload(old);
    const w = getWorkspace();
    io.emit('workspace:updated', w);
    return w;
  });

  // ----- invites -----
  const serializeInvite = (r: any): Invite => ({
    code: r.code,
    email: r.email,
    role: r.role,
    maxUses: r.max_uses,
    uses: r.uses,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    createdBy: r.created_by,
  });

  app.get('/api/invites', async (req) => {
    requireAdmin(req);
    return all('SELECT * FROM invites ORDER BY created_at DESC').map(serializeInvite);
  });

  app.post('/api/invites', async (req) => {
    // Any full member may create invites (like Slack's default), admins can choose the role.
    if (req.user.role === 'guest') throw forbidden();
    const body = parse(
      z.object({
        email: z.email().optional().nullable(),
        role: z.enum(['admin', 'member', 'guest']).optional(),
        maxUses: z.number().int().positive().nullable().optional(),
        expiresInDays: z.number().positive().max(365).nullable().optional(),
      }),
      req.body,
    );
    const role = isAdmin(req.user) ? body.role ?? 'member' : 'member';
    const code = randomToken(12);
    const t = now();
    run(
      'INSERT INTO invites (code, created_by, email, role, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      code,
      req.user.id,
      body.email ?? null,
      role,
      body.maxUses ?? (body.email ? 1 : null),
      body.expiresInDays ? t + body.expiresInDays * 86400_000 : t + 30 * 86400_000,
      t,
    );
    return serializeInvite(get('SELECT * FROM invites WHERE code = ?', code));
  });

  app.delete('/api/invites/:code', async (req) => {
    requireAdmin(req);
    run('DELETE FROM invites WHERE code = ?', (req.params as { code: string }).code);
    return { ok: true };
  });

  // ----- custom emoji -----
  app.post('/api/emoji', async (req) => {
    if (req.user.role === 'guest') throw forbidden();
    const part = await req.file({ limits: { fileSize: 1024 * 1024 } });
    if (!part || !IMAGE_MIME.test(part.mimetype)) throw badRequest('unsupported_image');
    const rawName = (part.fields.name as { value?: string } | undefined)?.value ?? '';
    const name = rawName.toLowerCase().replace(/^:|:$/g, '').replace(/[^a-z0-9_+-]/g, '');
    if (!name) throw badRequest('invalid_name');
    if (get('SELECT 1 FROM custom_emoji WHERE name = ?', name)) throw new HttpError(409, 'emoji_exists');
    const saved = await saveUpload(part, 'emoji');
    run('INSERT INTO custom_emoji (name, path, mime, created_by, created_at) VALUES (?, ?, ?, ?, ?)', name, saved.rel, part.mimetype, req.user.id, now());
    const list = listCustomEmoji();
    io.emit('emoji:changed', list);
    return list;
  });

  app.delete('/api/emoji/:name', async (req) => {
    const { name } = req.params as { name: string };
    const row = get<{ path: string; created_by: string }>('SELECT * FROM custom_emoji WHERE name = ?', name);
    if (!row) throw notFound();
    if (row.created_by !== req.user.id && !isAdmin(req.user)) throw forbidden();
    run('DELETE FROM custom_emoji WHERE name = ?', name);
    removeUpload(row.path);
    const list = listCustomEmoji();
    io.emit('emoji:changed', list);
    return list;
  });

  // ----- webhooks (incoming) -----
  const serializeHook = (r: any) => ({
    id: r.id,
    name: r.name,
    channelId: r.channel_id,
    url: `${config.publicUrl}/api/hooks/${r.token}`,
    createdBy: r.created_by,
    createdAt: r.created_at,
  });

  app.get('/api/webhooks', async (req) => {
    requireAdmin(req);
    return all('SELECT * FROM webhooks ORDER BY created_at DESC').map(serializeHook);
  });

  app.post('/api/webhooks', async (req) => {
    requireAdmin(req);
    const body = parse(z.object({ name: z.string().trim().min(1).max(80), channelId: z.string() }), req.body);
    const ch = get<ChannelRow>('SELECT * FROM channels WHERE id = ?', body.channelId);
    if (!ch || ch.kind === 'dm' || ch.kind === 'group') throw badRequest('invalid_channel');
    const id = newId('W');
    run('INSERT INTO webhooks (id, token, channel_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, randomToken(24), body.channelId, body.name, req.user.id, now());
    return serializeHook(get('SELECT * FROM webhooks WHERE id = ?', id));
  });

  app.delete('/api/webhooks/:id', async (req) => {
    requireAdmin(req);
    run('DELETE FROM webhooks WHERE id = ?', (req.params as { id: string }).id);
    return { ok: true };
  });
}

/** Public (but authenticated) static assets: avatars, workspace icon, custom emoji. */
export async function assetRoutes(app: FastifyInstance) {
  const send = (reply: any, rel: string | null | undefined, mime?: string) => {
    if (!rel) throw notFound();
    const abs = absPath(rel);
    if (!fs.existsSync(abs)) throw notFound();
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.header('x-content-type-options', 'nosniff');
    if (mime && isSafeInline(mime)) reply.type(mime);
    return reply.send(fs.createReadStream(abs));
  };
  const ext2mime = (p: string) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' })[p.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';

  app.get('/api/avatars/:id', { preHandler: requireAuth }, async (req, reply) => {
    const row = getUserRow((req.params as { id: string }).id);
    return send(reply, row?.avatar_path, row?.avatar_path ? ext2mime(row.avatar_path) : undefined);
  });
  // the icon is shown on the login page, so it is public
  app.get('/api/workspace/icon', async (_req, reply) => {
    const p = get<{ icon_path: string | null }>('SELECT icon_path FROM workspace WHERE id = 1')?.icon_path;
    return send(reply, p, p ? ext2mime(p) : undefined);
  });
  app.get('/api/emoji/:name', { preHandler: requireAuth }, async (req, reply) => {
    const row = get<{ path: string; mime: string }>('SELECT path, mime FROM custom_emoji WHERE name = ?', (req.params as { name: string }).name);
    return send(reply, row?.path, row?.mime);
  });
}
