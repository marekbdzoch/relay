import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SidebarSection, UserPrefs } from '../../../shared/types.ts';
import { all, get, getSetting, run, setSetting } from '../db.ts';
import { requireAdmin, requireAuth } from '../lib/auth.ts';
import { badRequest, json, newId, normalizeChannelName, now, parse } from '../lib/util.ts';
import { getChannel, getMe, getUserRow, getWorkspace } from '../model.ts';
import { addMembers, emitChannel } from '../services.ts';
import { io, toUser } from '../realtime.ts';

/**
 * First-run setup wizard (owner/admins): create the team's channels, group them into sidebar sections that every
 * member gets, then mark the workspace as set up. AI providers and the Slack import have their own routes.
 */

const DEFAULT_SECTIONS = 'workspace.defaultSections';
/** set when the workspace is created, cleared when the wizard is finished or skipped */
export const ONBOARDING_PENDING = 'onboarding.pending';

export function defaultSections(): SidebarSection[] {
  return json<SidebarSection[]>(getSetting(DEFAULT_SECTIONS), []);
}

function emitMe(userId: string) {
  if (!getUserRow(userId)) return;
  toUser(userId).emit('me:updated', getMe(userId));
}

/** Gives a user the workspace's default sidebar sections (merged with their own sections of the same id). */
export function applyDefaultSections(userId: string, emit = true) {
  const sections = defaultSections();
  const row = getUserRow(userId);
  if (!sections.length || !row) return;
  const prefs = json<UserPrefs>(row.prefs, {});
  const mine = [...(prefs.sidebarSections ?? [])];
  for (const d of sections) {
    const existing = mine.find((s) => s.id === d.id);
    if (existing) existing.channelIds = [...new Set([...existing.channelIds, ...d.channelIds])];
    else mine.push({ ...d, channelIds: [...d.channelIds] });
  }
  // a channel lives in one section only: the default section wins over the user's older placement
  const claimed = new Map(sections.flatMap((d) => d.channelIds.map((c) => [c, d.id] as const)));
  for (const s of mine) s.channelIds = s.channelIds.filter((c) => !claimed.has(c) || claimed.get(c) === s.id);
  run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify({ ...prefs, sidebarSections: mine }), userId);
  if (emit) emitMe(userId);
}

const channelInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(250).optional(),
  isPrivate: z.boolean().optional(),
  /** everyone joins it now and new members join automatically */
  everyone: z.boolean().optional(),
  /** name of the section it goes into */
  section: z.string().trim().max(60).optional(),
});

export async function onboardingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.post('/api/onboarding/channels', async (req) => {
    requireAdmin(req);
    const me = req.user;
    const body = parse(
      z.object({
        channels: z.array(channelInput).max(50),
        sections: z.array(z.object({ name: z.string().trim().min(1).max(60), emoji: z.string().max(64).optional() })).max(20).optional(),
      }),
      req.body,
    );
    const everyone = all<{ id: string }>("SELECT id FROM users WHERE deactivated = 0 AND is_bot = 0 AND role != 'guest'").map((u) => u.id);
    const ids: string[] = [];
    const bySection = new Map<string, string[]>();
    for (const c of body.channels) {
      const name = normalizeChannelName(c.name);
      if (!name) throw badRequest('invalid_name');
      let id = get<{ id: string }>("SELECT id FROM channels WHERE name = ? AND kind IN ('public','private')", name)?.id;
      if (!id) {
        id = newId('C');
        run(
          'INSERT INTO channels (id, kind, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          id,
          c.isPrivate ? 'private' : 'public',
          name,
          c.description ?? '',
          me.id,
          now(),
        );
      } else if (c.description) {
        run("UPDATE channels SET description = ? WHERE id = ? AND description = ''", c.description, id);
      }
      addMembers(id, [me.id], null, false);
      if (c.everyone && !c.isPrivate) {
        run('UPDATE channels SET is_default = 1 WHERE id = ?', id);
        addMembers(id, everyone, null, false);
      }
      emitChannel(id);
      ids.push(id);
      if (c.section) bySection.set(c.section, [...(bySection.get(c.section) ?? []), id]);
    }

    if (body.sections?.length) {
      const current = defaultSections();
      // channels placed in this request move out of whatever section they were in before
      const placed = new Set([...bySection.values()].flat());
      for (const s of current) s.channelIds = s.channelIds.filter((c) => !placed.has(c));
      for (const s of body.sections) {
        const channelIds = [...bySection].filter(([name]) => name.toLowerCase() === s.name.toLowerCase()).flatMap(([, ids]) => ids);
        const existing = current.find((x) => x.name.toLowerCase() === s.name.toLowerCase());
        if (existing) {
          existing.channelIds = [...new Set([...existing.channelIds, ...channelIds])];
          if (s.emoji) existing.emoji = s.emoji;
        } else current.push({ id: newId('S'), name: s.name, emoji: s.emoji ?? '', channelIds });
      }
      // a channel belongs to one section
      const seen = new Set<string>();
      for (const s of current) s.channelIds = s.channelIds.filter((c) => !seen.has(c) && (seen.add(c), true));
      setSetting(DEFAULT_SECTIONS, JSON.stringify(current));
      for (const u of all<{ id: string }>('SELECT id FROM users WHERE deactivated = 0 AND is_bot = 0')) applyDefaultSections(u.id);
    }
    return { channels: ids.map((id) => getChannel(id)), sections: defaultSections() };
  });

  app.post('/api/onboarding/complete', async (req) => {
    requireAdmin(req);
    setSetting(ONBOARDING_PENDING, null);
    const w = getWorkspace();
    io.emit('workspace:updated', w);
    return w;
  });
}
