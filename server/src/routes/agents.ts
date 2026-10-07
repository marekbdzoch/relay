import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentSettings, AIConnectionTest } from '../../../shared/types.ts';
import { get, run, tx } from '../db.ts';
import { isAdmin, requireAdmin, requireAuth } from '../lib/auth.ts';
import { forbidden, newId, normalizeUsername, notFound, now, parse, randomAvatarColor, randomToken } from '../lib/util.ts';
import { getUserRow, serializeUser } from '../model.ts';
import { addMembers } from '../services.ts';
import { disconnectUser, io } from '../realtime.ts';
import { getAgentRow, listAgents, sanitizeAgentModel, serializeAgent } from '../agents/store.ts';
import { PROVIDER_IDS } from '../agents/providers.ts';
import { getAgentSettings, testConnection, updateAgentSettings } from '../agents/settings.ts';

const agentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().max(120),
  department: z.string().trim().max(80).optional(),
  instructions: z.string().max(8000),
  model: z.string().max(200).optional(),
  webSearch: z.boolean().optional(),
  avatarEmoji: z.string().max(16).optional(),
  avatarColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  replyMode: z.enum(['mentions', 'all']).optional(),
  channelIds: z.array(z.string()).max(100).optional(),
});

function uniqueUsername(base: string) {
  const name = normalizeUsername(base) || 'agent';
  let candidate = name;
  let i = 1;
  while (get('SELECT 1 FROM users WHERE username = ?', candidate)) candidate = `${name}${++i}`;
  return candidate;
}

function emitAgent(userId: string) {
  const row = getAgentRow(userId);
  const u = getUserRow(userId);
  if (u) io.emit('user:upsert', serializeUser(u));
  if (row) io.emit('agent:upsert', serializeAgent(row));
}

function canEdit(user: { id: string; role: string }, agentId: string) {
  const a = getAgentRow(agentId);
  return !!a && (isAdmin(user) || a.created_by === user.id);
}

export async function agentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/agents', async () => listAgents());

  app.get('/api/agents/settings', async (req): Promise<AgentSettings> => getAgentSettings(isAdmin(req.user)));

  app.put('/api/agents/settings', async (req): Promise<AgentSettings> => {
    requireAdmin(req);
    const body = parse(
      z.object({
        provider: z.enum(PROVIDER_IDS).optional(),
        apiKey: z.string().trim().max(500).nullable().optional(),
        baseUrl: z.string().trim().max(500).optional(),
        defaultModel: z.string().trim().max(200).optional(),
      }),
      req.body,
    );
    await updateAgentSettings(body);
    return getAgentSettings(true);
  });

  app.post('/api/agents/settings/test', async (req): Promise<AIConnectionTest> => {
    requireAdmin(req);
    const body = parse(
      z.object({ provider: z.enum(PROVIDER_IDS), apiKey: z.string().trim().max(500).optional(), baseUrl: z.string().trim().max(500).optional() }),
      req.body,
    );
    return testConnection(body);
  });

  app.post('/api/agents', async (req) => {
    if (req.user.role === 'guest') throw forbidden();
    const body = parse(agentSchema, req.body);
    const id = newId('U');
    const t = now();
    const model = sanitizeAgentModel(body.model);
    tx(() => {
      run(
        `INSERT INTO users (id, email, password_hash, username, full_name, title, avatar_color, role, is_bot, external, created_at)
         VALUES (?, ?, '!', ?, ?, ?, ?, 'member', 1, 'agent', ?)`,
        id,
        `${id.toLowerCase()}.${randomToken(4).toLowerCase()}@agents.invalid`,
        uniqueUsername(body.name),
        body.name,
        body.role,
        body.avatarColor ?? randomAvatarColor(),
        t,
      );
      run(
        `INSERT INTO agents (user_id, role, department, instructions, model, web_search, avatar_emoji, reply_mode, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        body.role,
        body.department ?? '',
        body.instructions,
        model,
        body.webSearch === false ? 0 : 1,
        body.avatarEmoji ?? '',
        body.replyMode ?? 'mentions',
        req.user.id,
        t,
        t,
      );
    });
    emitAgent(id);
    for (const cid of body.channelIds ?? []) {
      const ch = get<{ kind: string }>('SELECT kind FROM channels WHERE id = ?', cid);
      if (!ch || ch.kind === 'dm' || ch.kind === 'group') continue;
      if (!get('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?', cid, req.user.id) && ch.kind === 'private') continue;
      addMembers(cid, [id], req.user.id);
    }
    return { agent: serializeAgent(getAgentRow(id)!), user: serializeUser(getUserRow(id)!) };
  });

  app.patch('/api/agents/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!getAgentRow(id)) throw notFound();
    if (!canEdit(req.user, id)) throw forbidden();
    const body = parse(agentSchema.partial(), req.body);
    const sets: [string, unknown][] = [];
    if (body.role !== undefined) sets.push(['role', body.role]);
    if (body.department !== undefined) sets.push(['department', body.department]);
    if (body.instructions !== undefined) sets.push(['instructions', body.instructions]);
    if (body.model !== undefined) sets.push(['model', sanitizeAgentModel(body.model)]);
    if (body.webSearch !== undefined) sets.push(['web_search', body.webSearch ? 1 : 0]);
    if (body.avatarEmoji !== undefined) sets.push(['avatar_emoji', body.avatarEmoji]);
    if (body.replyMode !== undefined) sets.push(['reply_mode', body.replyMode]);
    tx(() => {
      for (const [col, v] of sets) run(`UPDATE agents SET ${col} = ? WHERE user_id = ?`, v as string, id);
      run('UPDATE agents SET updated_at = ? WHERE user_id = ?', now(), id);
      if (body.name) run('UPDATE users SET full_name = ? WHERE id = ?', body.name, id);
      if (body.role !== undefined) run('UPDATE users SET title = ? WHERE id = ?', body.role, id);
      if (body.avatarColor) run('UPDATE users SET avatar_color = ? WHERE id = ?', body.avatarColor, id);
    });
    emitAgent(id);
    return { agent: serializeAgent(getAgentRow(id)!), user: serializeUser(getUserRow(id)!) };
  });

  app.delete('/api/agents/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!getAgentRow(id)) throw notFound();
    if (!canEdit(req.user, id)) throw forbidden();
    // keep the history: the agent account is deactivated, not deleted
    run('UPDATE users SET deactivated = 1 WHERE id = ?', id);
    run('DELETE FROM channel_members WHERE user_id = ?', id);
    disconnectUser(id);
    emitAgent(id);
    io.emit('agent:removed', { userId: id });
    return { ok: true };
  });

  app.post('/api/agents/:id/restore', async (req) => {
    const { id } = req.params as { id: string };
    if (!getAgentRow(id)) throw notFound();
    if (!canEdit(req.user, id)) throw forbidden();
    run('UPDATE users SET deactivated = 0 WHERE id = ?', id);
    emitAgent(id);
    return { agent: serializeAgent(getAgentRow(id)!), user: serializeUser(getUserRow(id)!) };
  });

  // tiny helper so the client can refresh its own data after creating an agent
  app.get('/api/agents/:id', async (req) => {
    const { id } = req.params as { id: string };
    const a = getAgentRow(id);
    if (!a) throw notFound();
    return { agent: serializeAgent(a), user: serializeUser(getUserRow(id)!) };
  });
}
