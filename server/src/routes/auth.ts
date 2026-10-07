import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { z } from 'zod';
import { all, get, run, setSetting, tx } from '../db.ts';
import { applyDefaultSections, ONBOARDING_PENDING } from './onboarding.ts';
import { createSession, hashPassword, isAdmin, requireAuth, setSessionCookie, SESSION_COOKIE, verifyPassword } from '../lib/auth.ts';
import { HttpError, badRequest, newId, normalizeUsername, now, parse, randomAvatarColor } from '../lib/util.ts';
import { getMe, getWorkspace, serializeUser, type UserRow } from '../model.ts';
import { addMembers } from '../services.ts';
import { disconnectSession, io } from '../realtime.ts';
import { claimImportedUser } from '../import/slack.ts';

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const passwordSchema = z.string().min(8, 'Password must have at least 8 characters').max(200);

function uniqueUsername(base: string) {
  let name = normalizeUsername(base) || 'user';
  let candidate = name;
  let i = 1;
  while (get('SELECT 1 FROM users WHERE username = ?', candidate)) candidate = `${name}${++i}`;
  return candidate;
}

async function createUser(o: { email: string; password: string; fullName: string; role: string; timezone?: string }) {
  const id = newId('U');
  const hash = await hashPassword(o.password);
  const username = uniqueUsername(o.email.split('@')[0]);
  run(
    `INSERT INTO users (id, email, password_hash, username, full_name, role, avatar_color, timezone, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    o.email.toLowerCase(),
    hash,
    username,
    o.fullName.trim(),
    o.role,
    randomAvatarColor(),
    o.timezone ?? '',
    now(),
  );
  return id;
}

function joinDefaultChannels(userId: string) {
  const defaults = get<{ ids: string }>("SELECT group_concat(id) AS ids FROM channels WHERE is_default = 1 AND archived = 0 AND kind = 'public'")?.ids;
  for (const cid of defaults?.split(',').filter(Boolean) ?? []) addMembers(cid, [userId], null, true);
  applyDefaultSections(userId, false);
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/setup/status', async () => {
    const hasUsers = !!get('SELECT 1 FROM users LIMIT 1');
    return {
      needsSetup: !hasUsers,
      setupCodeRequired: !hasUsers && !!config.setupToken,
      demo: config.demo ? getWorkspace().demo : undefined,
      workspace: hasUsers ? { name: getWorkspace().name, iconUrl: getWorkspace().iconUrl } : null,
    };
  });

  app.post('/api/setup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(
      z.object({
        workspaceName: z.string().trim().min(1).max(80),
        fullName: z.string().trim().min(1).max(80),
        email: z.email(),
        password: passwordSchema,
        timezone: z.string().max(64).optional(),
        setupCode: z.string().trim().max(200).optional(),
      }),
      req.body,
    );
    if (get('SELECT 1 FROM users LIMIT 1')) throw new HttpError(409, 'already_setup');
    if (config.setupToken && !safeEqual(body.setupCode ?? '', config.setupToken)) throw new HttpError(403, 'invalid_setup_code');
    const userId = await createUser({ ...body, role: 'owner' });
    tx(() => {
      run('INSERT OR REPLACE INTO workspace (id, name, created_at) VALUES (1, ?, ?)', body.workspaceName, now());
      setSetting(ONBOARDING_PENDING, '1');
      const t = now();
      run("INSERT INTO channels (id, kind, name, description, created_by, created_at, is_default) VALUES (?, 'public', 'general', ?, ?, ?, 1)", newId('C'), 'This is the one channel that will always include everyone.', userId, t);
      run("INSERT INTO channels (id, kind, name, description, created_by, created_at, is_default) VALUES (?, 'public', 'random', ?, ?, ?, 1)", newId('C'), 'Non-work banter and water cooler conversation.', userId, t);
    });
    joinDefaultChannels(userId);
    const token = createSession(userId, req.headers['user-agent']);
    setSessionCookie(reply, token);
    return { token, me: getMe(userId) };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().trim(), password: z.string() }), req.body);
    const row = get<UserRow>('SELECT * FROM users WHERE email = ? OR username = ?', body.email.toLowerCase(), body.email);
    if (!row || row.is_bot || row.external || row.imported || !(await verifyPassword(body.password, row.password_hash))) throw new HttpError(401, 'invalid_credentials');
    if (row.deactivated) throw new HttpError(403, 'account_deactivated');
    const token = createSession(row.id, req.headers['user-agent']);
    setSessionCookie(reply, token);
    return { token, me: getMe(row.id) };
  });

  app.get('/api/invites/:code', async (req) => {
    const { code } = req.params as { code: string };
    const inv = get<{ email: string | null; expires_at: number | null; max_uses: number | null; uses: number }>('SELECT * FROM invites WHERE code = ?', code);
    if (!inv || (inv.expires_at && inv.expires_at < now()) || (inv.max_uses && inv.uses >= inv.max_uses)) throw new HttpError(404, 'invite_invalid');
    const w = getWorkspace();
    return { workspace: { name: w.name, iconUrl: w.iconUrl }, email: inv.email };
  });

  app.post('/api/auth/signup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(
      z.object({ inviteCode: z.string().optional(), fullName: z.string().trim().min(1).max(80), email: z.email(), password: passwordSchema, timezone: z.string().max(64).optional() }),
      req.body,
    );
    const email = body.email.toLowerCase();
    let role = 'member';
    let claimEmail: string | null = null;
    if (body.inviteCode) {
      const inv = get<{ code: string; email: string | null; role: string; created_by: string; expires_at: number | null; max_uses: number | null; uses: number }>('SELECT * FROM invites WHERE code = ?', body.inviteCode);
      if (!inv || (inv.expires_at && inv.expires_at < now()) || (inv.max_uses && inv.uses >= inv.max_uses)) throw new HttpError(400, 'invite_invalid');
      if (inv.email && inv.email.toLowerCase() !== email) throw badRequest('invite_email_mismatch');
      role = inv.role;
      // only a personal invite from an admin may take over an imported account (members can invite too)
      const inviter = get<{ role: string }>('SELECT role FROM users WHERE id = ?', inv.created_by);
      if (inv.email && inviter && isAdmin(inviter)) claimEmail = inv.email.toLowerCase();
    } else {
      const domains = getWorkspace().allowedDomains.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
      if (!domains.includes(email.split('@')[1])) throw new HttpError(403, 'signup_not_allowed');
    }
    // an account imported from Slack is taken over (history kept) with an admin's personal invite for its e-mail
    const taken = get<{ id: string; imported: number }>('SELECT id, imported FROM users WHERE email = ?', email);
    if (taken && !(taken.imported && claimEmail === email)) throw new HttpError(409, taken.imported ? 'claim_needs_personal_invite' : 'email_taken');
    // count the use only once the signup can succeed (a failed attempt must not burn a single-use invite),
    // and atomically, so two concurrent signups can't both use the last slot
    if (body.inviteCode && !run('UPDATE invites SET uses = uses + 1 WHERE code = ? AND (max_uses IS NULL OR uses < max_uses)', body.inviteCode).changes) {
      throw new HttpError(400, 'invite_invalid');
    }
    const userId = taken
      ? await claimImportedUser(taken.id, { password: body.password, fullName: body.fullName, role, timezone: body.timezone })
      : await createUser({ email, password: body.password, fullName: body.fullName, role, timezone: body.timezone });
    io.emit('user:upsert', serializeUser(get<UserRow>('SELECT * FROM users WHERE id = ?', userId)!));
    joinDefaultChannels(userId);
    const token = createSession(userId, req.headers['user-agent']);
    setSessionCookie(reply, token);
    return { token, me: getMe(userId) };
  });

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    run('DELETE FROM sessions WHERE token_hash = ?', req.sessionHash);
    disconnectSession(req.sessionHash);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/sessions', { preHandler: requireAuth }, async (req) => {
    const rows = get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', req.user.id);
    return { count: rows?.n ?? 0 };
  });

  app.post('/api/auth/logout-others', { preHandler: requireAuth }, async (req) => {
    const others = all<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id = ? AND token_hash != ?', req.user.id, req.sessionHash);
    run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', req.user.id, req.sessionHash);
    for (const s of others) disconnectSession(s.token_hash);
    return { ok: true, count: others.length };
  });

  app.put('/api/auth/password', { preHandler: requireAuth }, async (req) => {
    const body = parse(z.object({ current: z.string(), password: passwordSchema }), req.body);
    const row = get<UserRow>('SELECT * FROM users WHERE id = ?', req.user.id)!;
    if (!(await verifyPassword(body.current, row.password_hash))) throw new HttpError(400, 'wrong_password');
    run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(body.password), req.user.id);
    return { ok: true };
  });
}

export { createUser, joinDefaultChannels, uniqueUsername };
