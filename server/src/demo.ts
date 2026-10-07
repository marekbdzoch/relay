import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SidebarSection } from '../../shared/types.ts';
import { config } from './config.ts';
import { all, db, get, getSetting, run, setSetting, tx } from './db.ts';
import { createSession, hashPassword, setSessionCookie } from './lib/auth.ts';
import { HttpError, newId, now, randomAvatarColor } from './lib/util.ts';
import { getMe } from './model.ts';
import { addMembers, postMessage } from './services.ts';
import { io } from './realtime.ts';
import { uniqueUsername } from './routes/auth.ts';
import { applyDefaultSections } from './routes/onboarding.ts';

/**
 * Demo mode (DEMO_MODE=true): a public "try it" instance. The workspace comes pre-filled with a sample company,
 * visitors get a throw-away account with one click (no sign-up), risky actions are disabled, and everything is wiped
 * and re-seeded every DEMO_RESET_HOURS.
 */

const SEEDED_AT = 'demo.seededAt';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function demoInfo() {
  if (!config.demo) return null;
  const seededAt = Number(getSetting(SEEDED_AT) ?? 0);
  return { resetHours: config.demoResetHours, nextResetAt: seededAt + config.demoResetHours * HOUR };
}

// ---------------------------------------------------------------------------
// sample content

interface Person {
  key: string;
  name: string;
  title: string;
  color: string;
  status?: [string, string];
  agent?: { role: string; department: string; emoji: string; instructions: string };
}

const PEOPLE: Person[] = [
  { key: 'alex', name: 'Alex Rivera', title: 'Head of Operations', color: '#6750a4' },
  { key: 'sarah', name: 'Sarah Chen', title: 'Product Lead', color: '#0b57d0', status: ['rocket', 'Shipping the relaunch'] },
  { key: 'tomas', name: 'Tomáš Novák', title: 'Engineering Lead', color: '#006a6a' },
  { key: 'priya', name: 'Priya Patel', title: 'Product Designer', color: '#984061', status: ['art', 'Deep in Figma'] },
  { key: 'marcus', name: 'Marcus Johnson', title: 'Sales', color: '#855300' },
  { key: 'elena', name: 'Elena García', title: 'Marketing Manager', color: '#3a6a1f', status: ['palm_tree', 'Back on Monday'] },
  {
    key: 'mia',
    name: 'Mia',
    title: 'Marketing assistant',
    color: '#c4314b',
    agent: {
      role: 'Marketing assistant',
      department: 'Marketing',
      emoji: '📣',
      instructions: 'Drafts social posts, newsletters and launch copy. Keeps the tone friendly and concise.',
    },
  },
  {
    key: 'dev',
    name: 'Devon',
    title: 'Engineering assistant',
    color: '#3c4043',
    agent: {
      role: 'Engineering assistant',
      department: 'Development',
      emoji: '🛠️',
      instructions: 'Answers technical questions, summarises incidents and drafts release notes.',
    },
  },
];

interface ChannelDef {
  name: string;
  description: string;
  topic?: string;
  section: string;
  everyone?: boolean;
  isPrivate?: boolean;
  members?: string[];
}

const SECTIONS = [
  { name: 'Company', emoji: '🏢' },
  { name: 'Teams', emoji: '👥' },
  { name: 'Projects', emoji: '🚀' },
];

const CHANNELS: ChannelDef[] = [
  { name: 'announcements', description: 'Important news for everyone', section: 'Company', everyone: true },
  { name: 'general', description: 'Company-wide announcements and work-based matters', section: 'Company', everyone: true },
  { name: 'random', description: 'Non-work banter and water cooler conversation', section: 'Company', everyone: true },
  { name: 'marketing', description: 'Campaigns, content and brand', section: 'Teams', everyone: true },
  { name: 'engineering', description: 'Product and engineering', topic: 'Release train: every Tuesday', section: 'Teams', everyone: true },
  { name: 'design', description: 'Design work and reviews', section: 'Teams', everyone: true },
  { name: 'website-relaunch', description: 'The new website – launch on Friday', topic: '🚀 Launch Friday 10:00', section: 'Projects', everyone: true },
  { name: 'q4-planning', description: 'Planning the next quarter (join to follow along)', section: 'Projects' },
  { name: 'leadership', description: 'Private channel for the leadership team', section: 'Company', isPrivate: true, members: ['alex', 'sarah', 'tomas'] },
];

/** [channel, author, text, minutes ago, options] – `id` names a message so others can thread under it */
type Line = [string, string, string, number, { id?: string; thread?: string; reactions?: [string, string[]][]; pin?: boolean; broadcast?: boolean }?];

const LINES: Line[] = [
  ['announcements', 'alex', ':wave: *Welcome to Northwind Labs!* This is a demo of <https://github.com/marekbdzoch/relay|Relay>, an open-source Slack alternative you can host yourself.\n\nLook around: channels on the left, threads, reactions, search (try `in:#engineering`), the voice room in each channel, and AI teammates under *Agents*.', 3 * DAY, { reactions: [['tada', ['sarah', 'tomas', 'priya', 'marcus']], ['heart', ['elena']]], pin: true }],
  ['announcements', 'sarah', 'The new website goes live on *Friday at 10:00* :rocket: Follow along in <#website-relaunch>.', 26 * HOUR, { reactions: [['rocket', ['alex', 'tomas', 'priya', 'elena']], ['eyes', ['marcus']]] }],

  ['general', 'alex', 'Morning all! Reminder: all-hands moves to *Thursday 15:00* this week.', 2 * DAY + 3 * HOUR, { reactions: [['+1', ['sarah', 'marcus', 'priya']]] }],
  ['general', 'marcus', 'Signed a 2-year deal with Contoso today :handshake: Thanks <@tomas> for the help with the security questionnaire!', 30 * HOUR, { id: 'deal', reactions: [['tada', ['alex', 'sarah', 'elena', 'priya']], ['muscle', ['tomas']]] }],
  ['general', 'tomas', 'Happy to help! Their SSO setup is a bit special, I left notes in the account doc.', 29 * HOUR, { thread: 'deal' }],
  ['general', 'sarah', 'Huge! :clap: Can we turn this into a customer story for the new website?', 28 * HOUR, { thread: 'deal' }],
  ['general', 'elena', 'Yes! I’ll reach out to their marketing team next week.', 27 * HOUR, { thread: 'deal', broadcast: true }],
  ['general', 'priya', 'Who’s up for lunch at the new ramen place? :ramen:', 3 * HOUR, { reactions: [['raised_hand', ['marcus', 'tomas']]] }],

  ['random', 'tomas', 'My cat just walked over the keyboard and pushed a commit. It passed CI. :cat:', 2 * DAY, { reactions: [['joy', ['priya', 'sarah', 'marcus', 'alex']], ['100', ['elena']]] }],
  ['random', 'priya', 'Hire the cat.', 2 * DAY - 10, { reactions: [['+1', ['tomas', 'sarah']]] }],
  ['random', 'marcus', 'Friday playlist thread :musical_note: drop your favourite focus song', 5 * HOUR, { id: 'music' }],
  ['random', 'sarah', 'Anything by Tycho, always.', 4 * HOUR, { thread: 'music' }],
  ['random', 'tomas', 'Lofi beats to fix bugs to :headphones:', 4 * HOUR - 20, { thread: 'music' }],

  ['marketing', 'elena', 'Launch checklist for Friday:\n• Blog post – _draft ready_\n• Newsletter – scheduled 10:30\n• Social posts – <@mia> is drafting them\n• Press kit – needs final screenshots from <@priya>', 20 * HOUR, { id: 'launch', pin: true, reactions: [['white_check_mark', ['sarah']]] }],
  ['marketing', 'mia', 'Here are three options for the LinkedIn post:\n\n1. *“We rebuilt our website from scratch – faster, clearer, and finally fun to use.”*\n2. *“New look, same Northwind. Take a tour of our new site.”*\n3. *“Our biggest website update in five years is live. Here’s what changed.”*\n\nI’d go with 1 for engagement. Want me to draft the X/Twitter versions too?', 19 * HOUR, { thread: 'launch' }],
  ['marketing', 'elena', 'Love #1. Yes please, and keep them under 200 characters.', 18 * HOUR, { thread: 'launch' }],
  ['marketing', 'priya', 'Screenshots are in the press kit folder now :frame_with_picture:', 6 * HOUR, { thread: 'launch' }],

  ['engineering', 'tomas', 'Deploy of `v2.4.0` finished :white_check_mark:\n```\n✔ migrations   3 applied\n✔ health check  200 OK (41 ms)\n✔ rollout       100%\n```', 22 * HOUR, { reactions: [['rocket', ['sarah', 'alex']]] }],
  ['engineering', 'sarah', '<@dev> can you summarise what went into 2.4 for the changelog?', 21 * HOUR, { id: 'changelog' }],
  ['engineering', 'dev', 'Sure! *Release 2.4.0*\n• New: dark mode for the dashboard\n• Faster search (p95 down from 480 ms to 120 ms)\n• Fixed: CSV export lost the last row\n• Fixed: timezone shown wrong for users in UTC+13', 21 * HOUR - 2, { thread: 'changelog', reactions: [['heart', ['sarah']]] }],
  ['engineering', 'tomas', 'Heads up: I’m starting the database upgrade at 18:00, ~5 minutes of read-only mode.', 2 * HOUR, { reactions: [['+1', ['sarah', 'alex']], ['pray', ['marcus']]] }],

  ['design', 'priya', 'New homepage hero – feedback welcome :art: The idea is a calm gradient in our brand violet with one clear call to action.', 2 * DAY + HOUR, { id: 'hero', reactions: [['fire', ['sarah', 'elena', 'alex']]] }],
  ['design', 'sarah', 'Much cleaner than before. Could the CTA say “Start free” instead of “Get started”?', 2 * DAY, { thread: 'hero' }],
  ['design', 'elena', '+1 to “Start free”, it tested better in the last campaign.', 2 * DAY - 30, { thread: 'hero' }],
  ['design', 'priya', 'Done, updated in Figma :sparkles:', 47 * HOUR, { thread: 'hero', reactions: [['raised_hands', ['sarah']]] }],

  ['website-relaunch', 'sarah', 'Launch plan for Friday :calendar:\n1. 09:30 – final smoke test (<@tomas>)\n2. 10:00 – DNS switch\n3. 10:15 – announcement + newsletter (<@elena>)\n4. 11:00 – retro in the voice room :headphones:', 25 * HOUR, { pin: true, reactions: [['white_check_mark', ['tomas', 'elena', 'priya']]] }],
  ['website-relaunch', 'tomas', 'Staging is ready for a last look: https://staging.northwind.example', 8 * HOUR],
  ['website-relaunch', 'priya', 'Found one thing: the pricing toggle overlaps on small phones. Fix is up for review.', 7 * HOUR, { id: 'bug' }],
  ['website-relaunch', 'tomas', 'Merged, thanks! :pray:', 6 * HOUR, { thread: 'bug' }],
  ['website-relaunch', 'alex', 'Great work everyone. Let’s use the channel voice room for the launch – just drop in at 10:00.', 90, { reactions: [['headphones', ['sarah', 'tomas', 'priya']]] }],

  ['q4-planning', 'sarah', 'Kicking off Q4 planning. Top themes so far: self-serve onboarding, integrations, mobile.', 3 * DAY - HOUR],

  ['leadership', 'alex', 'Budget review moved to next Wednesday.', 2 * DAY],
];

// ---------------------------------------------------------------------------
// seeding

const randomPassword = () => crypto.randomBytes(24).toString('hex');

export async function seedDemo() {
  const t0 = now();
  const ids: Record<string, string> = {};
  const passwordHash = await hashPassword(randomPassword());

  tx(() => {
    run('INSERT OR REPLACE INTO workspace (id, name, created_at) VALUES (1, ?, ?)', 'Northwind Labs', t0 - 30 * DAY);
    for (const p of PEOPLE) {
      const id = newId('U');
      ids[p.key] = id;
      run(
        `INSERT INTO users (id, email, password_hash, username, full_name, title, avatar_color, role, status_emoji, status_text, is_bot, external, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        `${p.key}@northwind.example`,
        p.agent ? '!' : passwordHash,
        uniqueUsername(p.key),
        p.name,
        p.title,
        p.color,
        p.key === 'alex' ? 'owner' : 'member',
        p.status?.[0] ?? '',
        p.status?.[1] ?? '',
        p.agent ? 1 : 0,
        p.agent ? 'agent' : null,
        t0 - 30 * DAY,
      );
      if (p.agent) {
        run(
          `INSERT INTO agents (user_id, role, department, instructions, model, web_search, avatar_emoji, reply_mode, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, '', 1, ?, 'mentions', ?, ?, ?)`,
          id,
          p.agent.role,
          p.agent.department,
          p.agent.instructions,
          p.agent.emoji,
          ids.alex,
          t0 - 20 * DAY,
          t0 - 20 * DAY,
        );
      }
    }

    const channelIds: Record<string, string> = {};
    for (const c of CHANNELS) {
      const id = newId('C');
      channelIds[c.name] = id;
      run(
        'INSERT INTO channels (id, kind, name, topic, description, created_by, created_at, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        c.isPrivate ? 'private' : 'public',
        c.name,
        c.topic ?? '',
        c.description,
        ids.alex,
        t0 - 30 * DAY,
        c.everyone ? 1 : 0,
      );
      const members = c.members ?? PEOPLE.filter((p) => !p.agent || ['marketing', 'engineering', 'general'].includes(c.name)).map((p) => p.key);
      for (const m of members) run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at, last_read) VALUES (?, ?, ?, 0)', id, ids[m], t0 - 30 * DAY);
    }

    // messages, oldest first so ids follow time
    const named: Record<string, number> = {};
    const lines = [...LINES].sort((a, b) => b[3] - a[3]);
    for (const [channel, author, rawText, ago, o = {}] of lines) {
      const text = rawText.replace(/<@([a-z]+)>/g, (_, k: string) => `<@${ids[k]}>`).replace(/<#([a-z0-9-]+)>/g, (_, n: string) => `<#${channelIds[n]}|${n}>`);
      const at = t0 - ago * MIN;
      const root = o.thread ? named[o.thread] : null;
      const id = Number(
        run(
          'INSERT INTO messages (channel_id, user_id, text, thread_root_id, also_in_channel, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          channelIds[channel],
          ids[author],
          text,
          root,
          o.broadcast ? 1 : 0,
          at,
        ).lastInsertRowid,
      );
      if (o.id) named[o.id] = id;
      if (root) {
        const r = get<{ reply_users: string }>('SELECT reply_users FROM messages WHERE id = ?', root)!;
        const users = [...new Set([...(JSON.parse(r.reply_users) as string[]), ids[author]])];
        run('UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ?, reply_users = ? WHERE id = ?', at, JSON.stringify(users), root);
      }
      for (const [emoji, who] of o.reactions ?? []) {
        for (const w of who) run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', id, ids[w], emoji, at + MIN);
      }
      if (o.pin) run('INSERT INTO pins (message_id, channel_id, pinned_by, created_at) VALUES (?, ?, ?, ?)', id, channelIds[channel], ids[author], at + MIN);
    }
    run('UPDATE channel_members SET last_read = (SELECT COALESCE(MAX(id), 0) FROM messages WHERE messages.channel_id = channel_members.channel_id)');

    const sections: SidebarSection[] = SECTIONS.map((s) => ({
      id: newId('S'),
      name: s.name,
      emoji: s.emoji,
      channelIds: CHANNELS.filter((c) => c.section === s.name).map((c) => channelIds[c.name]),
    }));
    setSetting('workspace.defaultSections', JSON.stringify(sections));
    setSetting('demo.channelIds', JSON.stringify(channelIds));
    setSetting('demo.userIds', JSON.stringify(ids));
    setSetting(SEEDED_AT, String(t0));
  });
}

/** Wipes every table and the uploads, then seeds the sample company again. Connected visitors are signed out. */
export async function resetDemo() {
  const tables = all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name != 'schema_version'",
  ).map((r) => r.name);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(() => {
      for (const t of tables) run(`DELETE FROM "${t}"`);
      run("INSERT INTO messages_fts(messages_fts) VALUES ('delete-all')");
      run("INSERT INTO files_fts(files_fts) VALUES ('delete-all')");
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  for (const entry of fs.readdirSync(config.uploadsDir)) fs.rmSync(path.join(config.uploadsDir, entry), { recursive: true, force: true });
  await seedDemo();
  io?.emit('session:revoked');
  io?.disconnectSockets(true);
}

/** Seeds an empty instance and resets it on schedule. */
export async function initDemo() {
  if (!config.demo) return;
  if (!get('SELECT 1 FROM users LIMIT 1')) await seedDemo();
  const check = async () => {
    const info = demoInfo();
    if (info && Date.now() >= info.nextResetAt) await resetDemo().catch((e) => console.error('demo reset failed', e));
  };
  await check();
  setInterval(() => void check(), 5 * MIN).unref();
}

// ---------------------------------------------------------------------------
// visitors

const ADJECTIVES = ['Curious', 'Brave', 'Sunny', 'Clever', 'Swift', 'Calm', 'Bright', 'Lucky', 'Happy', 'Bold'];
const ANIMALS = ['Otter', 'Fox', 'Panda', 'Koala', 'Falcon', 'Lynx', 'Dolphin', 'Owl', 'Badger', 'Heron'];
const pick = <T>(list: T[]) => list[crypto.randomInt(list.length)];

/** Requests a visitor can't make in the demo (sign-ups, invites, passwords, setup). */
const BLOCKED: [string, RegExp][] = [
  ['POST', /^\/api\/setup$/],
  ['POST', /^\/api\/auth\/signup$/],
  ['PUT', /^\/api\/auth\/password$/],
  ['POST', /^\/api\/invites$/],
];

/** Global onRequest hook (registered on the root instance when DEMO_MODE is on). */
export async function demoGuard(req: FastifyRequest) {
  const url = req.url.split('?')[0];
  if (BLOCKED.some(([m, re]) => m === req.method && re.test(url))) throw new HttpError(403, 'demo_disabled', 'This is turned off in the demo.');
}

export async function demoRoutes(app: FastifyInstance) {
  if (!config.demo) return;

  app.post('/api/demo/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const name = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
    const id = newId('U');
    run(
      `INSERT INTO users (id, email, password_hash, username, full_name, title, avatar_color, role, created_at)
       VALUES (?, ?, '!', ?, ?, 'Demo visitor', ?, 'member', ?)`,
      id,
      `${id.toLowerCase()}@visitors.invalid`,
      uniqueUsername(name.replace(' ', '.')),
      name,
      randomAvatarColor(),
      now(),
    );
    // join quietly: hundreds of visitors must not flood the channels with "joined" messages
    const defaults = all<{ id: string }>("SELECT id FROM channels WHERE is_default = 1 AND archived = 0 AND kind = 'public'");
    for (const c of defaults) addMembers(c.id, [id], null, false);
    applyDefaultSections(id, false);
    // leave a couple of messages unread so badges, the "new" divider and Activity have something to show
    const channelIds = JSON.parse(getSetting('demo.channelIds') ?? '{}') as Record<string, string>;
    for (const name of ['announcements', 'website-relaunch']) {
      const cid = channelIds[name];
      if (!cid) continue;
      const before = get<{ id: number }>('SELECT id FROM messages WHERE channel_id = ? AND thread_root_id IS NULL ORDER BY id DESC LIMIT 1 OFFSET 1', cid);
      if (before) run('UPDATE channel_members SET last_read = ? WHERE channel_id = ? AND user_id = ?', before.id, cid, id);
    }
    // a welcome DM from the "owner"
    const people = JSON.parse(getSetting('demo.userIds') ?? '{}') as Record<string, string>;
    if (people.alex) {
      const dm = newId('D');
      run("INSERT INTO channels (id, kind, created_by, created_at, dm_key) VALUES (?, 'dm', ?, ?, ?)", dm, people.alex, now(), [id, people.alex].sort().join(','));
      for (const u of [id, people.alex]) run('INSERT INTO channel_members (channel_id, user_id, joined_at, last_read) VALUES (?, ?, ?, 0)', dm, u, now());
      postMessage({
        channelId: dm,
        userId: people.alex,
        text: `Hi ${name.split(' ')[0]}! :wave: Welcome to the Relay demo.\n\nA few things to try:\n• Reply in a thread or add a reaction\n• Search with \`in:#engineering\` or \`from:@sarah\`\n• Join the voice room in any channel\n• Create your own channel or AI agent\n• Switch themes and dark mode in *Preferences*\n\nThe demo resets every ${config.demoResetHours} hours. Like it? Deploy your own copy for free from GitHub.`,
      });
    }
    const token = createSession(id, req.headers['user-agent']);
    setSessionCookie(reply, token);
    return { token, me: getMe(id) };
  });
}
