/**
 * Slack bridge: mirrors linked channels between this server and an existing Slack workspace.
 *
 * - Connects with Socket Mode (outbound WebSocket), so the server needs no public URL for it.
 * - Slack people appear here as "external" users (name + avatar), or are matched to an
 *   existing account with the same email address.
 * - Messages written here are posted to Slack with the author's name and avatar (chat:write.customize).
 * - Threads, edits, deletes, reactions and files are synchronised in both directions.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Message } from '../../../shared/types.ts';
import { all, get, getSetting, run, tx } from '../db.ts';
import { config } from '../config.ts';
import { absPath } from '../lib/files.ts';
import { json, newId, normalizeUsername, now, randomAvatarColor, randomToken } from '../lib/util.ts';
import { getMessageRow, getUserRow, serializeUser, type MessageMeta, type MessageRow, type UserRow } from '../model.ts';
import { addMembers, bus, deleteMessage, emitMessageUpdated, postMessage } from '../services.ts';
import { io } from '../realtime.ts';
import { SlackApi, SlackError } from './api.ts';

interface Status {
  enabled: boolean;
  connected: boolean;
  team: string | null;
  teamUrl: string | null;
  error: string | null;
}

const state: Status = { enabled: false, connected: false, team: null, teamUrl: null, error: null };
let api: SlackApi | null = null;
let appToken = '';
let botUserId = '';
let botId = '';
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 1000;
let generation = 0;

export const slackStatus = () => ({ ...state });
export const slackApi = () => api;

export function slackTokens() {
  return {
    bot: process.env.SLACK_BOT_TOKEN || getSetting('slack.botToken') || '',
    app: process.env.SLACK_APP_TOKEN || getSetting('slack.appToken') || '',
    fromEnv: !!(process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN),
  };
}

// ---------------------------------------------------------------------------
// connection

export function stopSlackBridge() {
  generation++;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  ws = null;
  api = null;
  Object.assign(state, { enabled: false, connected: false, team: null, teamUrl: null, error: null });
}

export async function startSlackBridge() {
  stopSlackBridge();
  const { bot, app } = slackTokens();
  if (!bot || !app) return;
  state.enabled = true;
  api = new SlackApi(bot);
  appToken = app;
  const gen = generation;
  try {
    const auth = await api.call<{ user_id: string; bot_id: string; team: string; url: string }>('auth.test');
    if (gen !== generation) return;
    botUserId = auth.user_id;
    botId = auth.bot_id;
    state.team = auth.team;
    state.teamUrl = auth.url;
    await openSocket(gen);
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    console.error('[slack] start failed:', state.error);
    scheduleReconnect(gen);
  }
}

function scheduleReconnect(gen: number) {
  if (gen !== generation || !state.enabled) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (gen === generation) void openSocket(gen).catch((e) => {
      state.error = e instanceof Error ? e.message : String(e);
      scheduleReconnect(gen);
    });
  }, backoff);
  backoff = Math.min(backoff * 2, 60_000);
}

async function openSocket(gen: number) {
  const res = await fetch('https://slack.com/api/apps.connections.open', {
    method: 'POST',
    headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/x-www-form-urlencoded' },
  });
  const data = (await res.json()) as { ok: boolean; url?: string; error?: string };
  if (!data.ok || !data.url) throw new SlackError(data.error ?? 'no_url', 'apps.connections.open');
  if (gen !== generation) return;
  const socket = new WebSocket(data.url);
  ws = socket;
  socket.onmessage = (e) => {
    let msg: any;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.envelope_id) socket.send(JSON.stringify({ envelope_id: msg.envelope_id }));
    if (msg.type === 'hello') {
      state.connected = true;
      state.error = null;
      backoff = 1000;
      console.log(`[slack] connected to ${state.team}`);
    } else if (msg.type === 'disconnect') {
      socket.close();
    } else if (msg.type === 'events_api') {
      void handleEvent(msg.payload?.event).catch((err) => console.error('[slack] event error', err));
    }
  };
  socket.onclose = () => {
    if (ws === socket) {
      state.connected = false;
      ws = null;
      scheduleReconnect(gen);
    }
  };
  socket.onerror = () => {
    /* onclose follows */
  };
}

// ---------------------------------------------------------------------------
// lookups

interface Link {
  relay_channel_id: string;
  slack_channel_id: string;
  slack_channel_name: string;
}

const linkBySlack = (id: string) => get<Link>('SELECT * FROM slack_links WHERE slack_channel_id = ?', id);
const linkByRelay = (id: string) => get<Link>('SELECT * FROM slack_links WHERE relay_channel_id = ?', id);
const relayIdForTs = (channel: string, ts: string) => get<{ relay_message_id: number }>('SELECT relay_message_id FROM slack_messages WHERE slack_channel_id = ? AND slack_ts = ?', channel, ts)?.relay_message_id;
const tsForRelay = (id: number) => get<{ slack_channel_id: string; slack_ts: string }>('SELECT slack_channel_id, slack_ts FROM slack_messages WHERE relay_message_id = ?', id);
const slackIdForRelayUser = (id: string) => get<{ slack_user_id: string }>('SELECT slack_user_id FROM slack_users WHERE relay_user_id = ?', id)?.slack_user_id;

function remember(relayId: number, channel: string, ts: string) {
  run('INSERT OR IGNORE INTO slack_messages (relay_message_id, slack_channel_id, slack_ts) VALUES (?, ?, ?)', relayId, channel, ts);
}

function emitUser(id: string) {
  const row = getUserRow(id);
  if (row) io.emit('user:upsert', serializeUser(row));
}

async function saveAvatar(slackId: string, url: string | undefined) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    const ext = type.includes('png') ? '.png' : type.includes('gif') ? '.gif' : '.jpg';
    const rel = path.join('avatars', `${Date.now().toString(36)}${randomToken(6)}-slack-${slackId}${ext}`);
    fs.mkdirSync(path.join(config.uploadsDir, 'avatars'), { recursive: true });
    fs.writeFileSync(absPath(rel), Buffer.from(await res.arrayBuffer()));
    return rel;
  } catch {
    return null;
  }
}

const puppetLocks = new Map<string, Promise<string>>();

/** Returns the local user id representing a Slack user (creating an external account on first sight). */
export function ensurePuppet(slackUserId: string): Promise<string> {
  const known = get<{ relay_user_id: string }>('SELECT relay_user_id FROM slack_users WHERE slack_user_id = ?', slackUserId);
  if (known) return Promise.resolve(known.relay_user_id);
  let p = puppetLocks.get(slackUserId);
  if (!p) {
    p = createPuppet(slackUserId).finally(() => puppetLocks.delete(slackUserId));
    puppetLocks.set(slackUserId, p);
  }
  return p;
}

function uniqueUsername(base: string) {
  const name = normalizeUsername(base) || 'slack.user';
  let candidate = name;
  let i = 1;
  while (get('SELECT 1 FROM users WHERE username = ?', candidate)) candidate = `${name}${++i}`;
  return candidate;
}

async function createPuppet(slackUserId: string): Promise<string> {
  const info = await api!.call<{ user: any }>('users.info', { user: slackUserId });
  const u = info.user;
  const p = u.profile ?? {};
  const email: string | undefined = p.email?.toLowerCase();
  // somebody who has an account here already -> map to it
  if (email) {
    const existing = get<{ id: string }>('SELECT id FROM users WHERE email = ? AND external IS NULL', email);
    if (existing) {
      run('INSERT OR REPLACE INTO slack_users (slack_user_id, relay_user_id) VALUES (?, ?)', slackUserId, existing.id);
      return existing.id;
    }
  }
  const id = newId('U');
  const fullName = p.real_name || u.real_name || u.name || 'Slack user';
  const avatar = await saveAvatar(slackUserId, p.image_192 || p.image_72);
  tx(() => {
    run(
      `INSERT INTO users (id, email, password_hash, username, full_name, display_name, title, timezone, avatar_path, avatar_color, role, is_bot, external, created_at)
       VALUES (?, ?, '!', ?, ?, ?, ?, ?, ?, ?, 'guest', ?, 'slack', ?)`,
      id,
      `${slackUserId.toLowerCase()}.${randomToken(4).toLowerCase()}@slack.invalid`,
      uniqueUsername(p.display_name || u.name || fullName),
      fullName,
      p.display_name || '',
      p.title || '',
      u.tz || '',
      avatar,
      randomAvatarColor(),
      u.is_bot ? 1 : 0,
      now(),
    );
    run('INSERT OR REPLACE INTO slack_users (slack_user_id, relay_user_id) VALUES (?, ?)', slackUserId, id);
  });
  emitUser(id);
  return id;
}

async function refreshPuppet(u: any) {
  const relayId = get<{ relay_user_id: string }>('SELECT relay_user_id FROM slack_users WHERE slack_user_id = ?', u.id)?.relay_user_id;
  const row = relayId ? getUserRow(relayId) : undefined;
  if (!row || row.external !== 'slack') return;
  const p = u.profile ?? {};
  const avatar = (await saveAvatar(u.id, p.image_192 || p.image_72)) ?? row.avatar_path;
  run(
    'UPDATE users SET full_name = ?, display_name = ?, title = ?, timezone = ?, avatar_path = ?, status_emoji = ?, status_text = ?, deactivated = ? WHERE id = ?',
    p.real_name || row.full_name,
    p.display_name || '',
    p.title || '',
    u.tz || row.timezone,
    avatar,
    (p.status_emoji || '').replace(/:/g, ''),
    p.status_text || '',
    u.deleted ? 1 : 0,
    row.id,
  );
  emitUser(row.id);
}

// ---------------------------------------------------------------------------
// text conversion

function decodeEntities(s: string) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function slackToRelay(text: string): Promise<string> {
  if (!text) return '';
  const userIds = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))];
  const map = new Map<string, string>();
  for (const sid of userIds) {
    if (sid === botUserId) continue;
    try {
      map.set(sid, await ensurePuppet(sid));
    } catch {
      /* unknown user */
    }
  }
  let out = text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, sid, label) => (map.has(sid) ? `<@${map.get(sid)}>` : `@${label ?? 'someone'}`))
    .replace(/<#(C[A-Z0-9]+)(?:\|([^>]*))?>/g, (_, cid, name) => {
      const l = linkBySlack(cid);
      return l ? `<#${l.relay_channel_id}>` : `#${name ?? 'channel'}`;
    })
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, name) => name ?? '@group')
    .replace(/<!date\^[^|>]*\|([^>]*)>/g, '$1')
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1');
  out = decodeEntities(out);
  // "@username" typed in Slack mentions people on this side
  out = out.replace(/(^|[\s(])@([\p{L}\p{N}._-]+)/gu, (m, pre, name: string) => {
    const u = get<{ id: string }>('SELECT id FROM users WHERE username = ? AND external IS NULL AND deactivated = 0', name.toLowerCase());
    return u ? `${pre}<@${u.id}>` : m;
  });
  return out;
}

function escapeSlack(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function relayToSlack(text: string): string {
  return text
    .split(/(<[@#!][^>]+>|<https?:\/\/[^>]+>|```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part, i) => {
      if (i % 2 === 1) {
        if (part.startsWith('<@')) {
          const id = part.slice(2, -1);
          const sid = slackIdForRelayUser(id);
          if (sid) return `<@${sid}>`;
          const u = getUserRow(id);
          return u ? `@${u.display_name || u.full_name}` : part;
        }
        if (part.startsWith('<#')) {
          const id = part.slice(2, -1).split('|')[0];
          const l = linkByRelay(id);
          if (l) return `<#${l.slack_channel_id}>`;
          const ch = get<{ name: string }>('SELECT name FROM channels WHERE id = ?', id);
          return `#${ch?.name ?? 'channel'}`;
        }
        if (part.startsWith('`')) return part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return part;
      }
      return escapeSlack(part)
        .replace(/\*\*(\S[^\n]*?\S|\S)\*\*/g, '*$1*')
        .replace(/~~(\S[^\n]*?\S|\S)~~/g, '~$1~')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Slack -> here

async function handleEvent(ev: any) {
  if (!ev || !api) return;
  switch (ev.type) {
    case 'message':
      return onSlackMessage(ev);
    case 'reaction_added':
    case 'reaction_removed':
      return onSlackReaction(ev, ev.type === 'reaction_added');
    case 'user_change':
      return refreshPuppet(ev.user);
    case 'channel_rename':
    case 'group_rename': {
      if (ev.channel?.id) run('UPDATE slack_links SET slack_channel_name = ? WHERE slack_channel_id = ?', ev.channel.name ?? '', ev.channel.id);
      return;
    }
  }
}

const IGNORED_SUBTYPES = new Set(['channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'group_join', 'group_leave', 'bot_add', 'bot_remove', 'pinned_item', 'unpinned_item', 'channel_archive', 'channel_unarchive', 'ekm_access_denied']);

function isOwn(m: any) {
  return (botId && m.bot_id === botId) || (botUserId && m.user === botUserId);
}

async function importFiles(files: any[] | undefined, ownerId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const f of files ?? []) {
    try {
      if (!f.url_private_download && !f.url_private) continue;
      if (f.size && f.size > config.maxUploadMb * 1024 * 1024) continue;
      const res = await api!.download(f.url_private_download || f.url_private);
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = path.extname(f.name || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
      const sub = new Date().toISOString().slice(0, 7);
      fs.mkdirSync(path.join(config.uploadsDir, sub), { recursive: true });
      const rel = path.join(sub, `${Date.now().toString(36)}${randomToken(9)}${ext}`);
      fs.writeFileSync(absPath(rel), buf);
      const id = newId('F', 12);
      run(
        'INSERT INTO files (id, user_id, name, mime, size, path, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        ownerId,
        (f.name || 'file').slice(0, 200),
        f.mimetype || 'application/octet-stream',
        buf.length,
        rel,
        f.original_w ?? null,
        f.original_h ?? null,
        now(),
      );
      ids.push(id);
    } catch (e) {
      console.error('[slack] file import failed', e);
    }
  }
  return ids;
}

async function onSlackMessage(ev: any) {
  const link = linkBySlack(ev.channel);
  if (!link) return;

  if (ev.subtype === 'message_changed') {
    const m = ev.message;
    if (!m || isOwn(m)) return;
    const relayId = relayIdForTs(ev.channel, m.ts);
    const row = relayId ? getMessageRow(relayId) : undefined;
    if (!row || row.deleted_at) return;
    const text = await slackToRelay(m.text ?? '');
    if (text === row.text) return; // e.g. unfurl-only change
    run('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?', text, now(), row.id);
    emitMessageUpdated(row.id);
    return;
  }
  if (ev.subtype === 'message_deleted') {
    const relayId = relayIdForTs(ev.channel, ev.deleted_ts);
    const row = relayId ? getMessageRow(relayId) : undefined;
    if (row && !row.deleted_at && json<MessageMeta>(row.meta, {}).source === 'slack') deleteMessage(row);
    return;
  }
  if (IGNORED_SUBTYPES.has(ev.subtype) || ev.hidden || isOwn(ev)) return;
  if (relayIdForTs(ev.channel, ev.ts)) return; // already imported

  let userId: string | null = null;
  let botName: string | undefined;
  if (ev.user && ev.subtype !== 'bot_message') {
    userId = await ensurePuppet(ev.user);
    if (!get('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?', link.relay_channel_id, userId)) addMembers(link.relay_channel_id, [userId], null, false);
  } else {
    botName = ev.username || ev.bot_profile?.name || 'Slack app';
  }
  let threadRootId: number | null = null;
  if (ev.thread_ts && ev.thread_ts !== ev.ts) threadRootId = relayIdForTs(ev.channel, ev.thread_ts) ?? null;

  let text = await slackToRelay(ev.text ?? '');
  if (ev.subtype === 'me_message') text = `_${text}_`;
  // legacy attachments (bots) – keep their fallback text
  if (!text && Array.isArray(ev.attachments)) text = ev.attachments.map((a: any) => a.fallback || a.text || '').filter(Boolean).join('\n');
  const fileIds = await importFiles(ev.files, userId ?? '');
  if (!text.trim() && !fileIds.length) return;

  const msg = postMessage({
    channelId: link.relay_channel_id,
    userId,
    text,
    threadRootId,
    alsoInChannel: ev.subtype === 'thread_broadcast',
    fileIds,
    subtype: userId ? undefined : 'bot',
    botName,
    source: 'slack',
    createdAt: Math.round(Number(ev.ts) * 1000) || undefined,
  });
  remember(msg.id, ev.channel, ev.ts);
}

async function onSlackReaction(ev: any, added: boolean) {
  if (ev.user === botUserId || ev.item?.type !== 'message') return;
  const relayId = relayIdForTs(ev.item.channel, ev.item.ts);
  if (!relayId) return;
  const userId = await ensurePuppet(ev.user);
  const emoji = String(ev.reaction);
  if (added) run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', relayId, userId, emoji, now());
  else run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', relayId, userId, emoji);
  emitMessageUpdated(relayId);
}

// ---------------------------------------------------------------------------
// here -> Slack

// one queue per Slack channel keeps ordering (and plays nicely with rate limits)
const queues = new Map<string, Promise<unknown>>();
function enqueue(channel: string, job: () => Promise<unknown>) {
  const prev = queues.get(channel) ?? Promise.resolve();
  const next = prev.then(job).catch((e) => console.error('[slack] send failed:', e instanceof Error ? e.message : e));
  queues.set(channel, next);
}

function avatarSignature(userId: string, avatarPath: string) {
  return crypto.createHmac('sha256', config.secret).update(`${userId}:${avatarPath}`).digest('hex').slice(0, 24);
}

/** Public (signed) avatar URL so Slack can display the author's picture. */
export function publicAvatarUrl(u: UserRow) {
  if (!config.publicUrl || !u.avatar_path) return undefined;
  return `${config.publicUrl}/api/public/avatars/${u.id}/${avatarSignature(u.id, u.avatar_path)}`;
}

export function verifyAvatarSignature(userId: string, sig: string) {
  const u = getUserRow(userId);
  if (!u?.avatar_path) return null;
  const expected = avatarSignature(u.id, u.avatar_path);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? u : null;
}

function author(msg: Message) {
  if (!msg.userId) return { username: msg.botName ?? 'Relay', icon_url: undefined };
  const u = getUserRow(msg.userId);
  return { username: u ? u.display_name || u.full_name : 'Relay', icon_url: u ? publicAvatarUrl(u) : undefined };
}

async function sendToSlack(msg: Message, link: Link) {
  if (!api || !state.connected) return;
  const who = author(msg);
  let threadTs: string | undefined;
  if (msg.threadRootId) threadTs = tsForRelay(msg.threadRootId)?.slack_ts;
  const text = relayToSlack(msg.text);
  let ts: string | undefined;
  if (text.trim()) {
    const r = await api.call<{ ts: string }>('chat.postMessage', {
      channel: link.slack_channel_id,
      text,
      username: who.username,
      icon_url: who.icon_url,
      thread_ts: threadTs,
      reply_broadcast: threadTs && msg.alsoInChannel ? true : undefined,
      unfurl_links: true,
      unfurl_media: true,
    });
    ts = r.ts;
    remember(msg.id, link.slack_channel_id, r.ts);
  }
  for (const f of msg.files) {
    const row = get<{ path: string }>('SELECT path FROM files WHERE id = ?', f.id);
    if (!row) continue;
    try {
      await api.uploadFile({
        channel: link.slack_channel_id,
        threadTs: threadTs ?? ts,
        filename: f.name,
        data: fs.readFileSync(absPath(row.path)),
        initialComment: text.trim() ? undefined : `*${who.username}*`,
      });
    } catch (e) {
      console.error('[slack] file upload failed', e);
    }
  }
}

function setupOutbound() {
  bus.on('posted', (msg: Message, source: string | null) => {
    if (source === 'slack' || !api) return;
    if (msg.subtype && msg.subtype !== 'bot') return;
    const link = linkByRelay(msg.channelId);
    if (!link) return;
    enqueue(link.slack_channel_id, () => sendToSlack(msg, link));
  });

  bus.on('edited', (msg: Message, source: string | null) => {
    if (source === 'slack' || !api) return;
    const ref = tsForRelay(msg.id);
    if (!ref) return;
    enqueue(ref.slack_channel_id, () => api!.call('chat.update', { channel: ref.slack_channel_id, ts: ref.slack_ts, text: relayToSlack(msg.text) }));
  });

  bus.on('deleted', (row: MessageRow) => {
    if (!api || json<MessageMeta>(row.meta, {}).source === 'slack') return;
    const ref = tsForRelay(row.id);
    if (!ref) return;
    enqueue(ref.slack_channel_id, () => api!.call('chat.delete', { channel: ref.slack_channel_id, ts: ref.slack_ts }));
  });

  bus.on('reaction', (r: { messageId: number; userId: string; emoji: string; added: boolean }) => {
    if (!api) return;
    const ref = tsForRelay(r.messageId);
    if (!ref) return;
    const name = r.emoji.replace(/:/g, '');
    if (r.added) {
      enqueue(ref.slack_channel_id, () =>
        api!.call('reactions.add', { channel: ref.slack_channel_id, timestamp: ref.slack_ts, name }).catch((e) => {
          if (!(e instanceof SlackError && e.code === 'already_reacted')) throw e;
        }),
      );
    } else {
      // keep the bot's reaction while anyone on this side still reacts with it
      const still = get(
        'SELECT 1 FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.message_id = ? AND r.emoji = ? AND u.external IS NULL',
        r.messageId,
        r.emoji,
      );
      if (still) return;
      enqueue(ref.slack_channel_id, () =>
        api!.call('reactions.remove', { channel: ref.slack_channel_id, timestamp: ref.slack_ts, name }).catch((e) => {
          if (!(e instanceof SlackError && e.code === 'no_reaction')) throw e;
        }),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// linking

export async function listSlackChannels() {
  if (!api) throw new Error('Slack is not connected');
  const out: { id: string; name: string; isPrivate: boolean; isMember: boolean; members: number }[] = [];
  let cursor: string | undefined;
  do {
    const r = await api.call<{ channels: any[]; response_metadata?: { next_cursor?: string } }>('conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 1000,
      cursor,
    });
    for (const c of r.channels) out.push({ id: c.id, name: c.name, isPrivate: !!c.is_private, isMember: !!c.is_member, members: c.num_members ?? 0 });
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor && out.length < 5000);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function linkChannel(relayChannelId: string, slackChannelId: string, importHistory: number) {
  if (!api) throw new Error('Slack is not connected');
  const info = await api.call<{ channel: any }>('conversations.info', { channel: slackChannelId });
  const ch = info.channel;
  if (!ch.is_member) {
    if (ch.is_private) throw new Error('Invite the Relay app to the private Slack channel first (/invite @Relay in Slack).');
    await api.call('conversations.join', { channel: slackChannelId });
  }
  run('DELETE FROM slack_links WHERE relay_channel_id = ? OR slack_channel_id = ?', relayChannelId, slackChannelId);
  run('INSERT INTO slack_links (relay_channel_id, slack_channel_id, slack_channel_name, created_at) VALUES (?, ?, ?, ?)', relayChannelId, slackChannelId, ch.name ?? '', now());
  if (importHistory > 0) void importRecent(slackChannelId, Math.min(importHistory, 500)).catch((e) => console.error('[slack] history import failed', e));
}

export function unlinkChannel(relayChannelId: string) {
  run('DELETE FROM slack_links WHERE relay_channel_id = ?', relayChannelId);
}

export function listLinks() {
  return all<Link & { created_at: number }>('SELECT * FROM slack_links ORDER BY created_at').map((l) => ({
    relayChannelId: l.relay_channel_id,
    slackChannelId: l.slack_channel_id,
    slackChannelName: l.slack_channel_name,
  }));
}

/** Imports the latest messages of a Slack channel (oldest first), including thread replies. */
async function importRecent(slackChannelId: string, limit: number) {
  const r = await api!.call<{ messages: any[] }>('conversations.history', { channel: slackChannelId, limit });
  const msgs = r.messages.reverse();
  for (const m of msgs) {
    await onSlackMessage({ ...m, channel: slackChannelId });
    if (m.reply_count > 0) {
      const rep = await api!.call<{ messages: any[] }>('conversations.replies', { channel: slackChannelId, ts: m.ts, limit: 200 });
      for (const reply of rep.messages.slice(1)) await onSlackMessage({ ...reply, channel: slackChannelId });
    }
  }
}

export const SLACK_MANIFEST = `display_information:
  name: Relay Bridge
  description: Connects Slack channels with a self-hosted Relay workspace
  background_color: "#3f0e40"
features:
  bot_user:
    display_name: Relay
    always_online: true
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:read
      - channels:join
      - groups:history
      - groups:read
      - chat:write
      - chat:write.customize
      - files:read
      - files:write
      - reactions:read
      - reactions:write
      - users:read
      - users:read.email
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - reaction_added
      - reaction_removed
      - user_change
      - channel_rename
      - group_rename
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`;

/** exposed for tests */
export const _internals = {
  relayToSlack,
  slackToRelay,
  handleEvent,
  setApi(fake: any, ids: { botUserId: string; botId: string }) {
    api = fake;
    botUserId = ids.botUserId;
    botId = ids.botId;
    state.connected = true;
  },
};

let outboundReady = false;
export function initSlackBridge() {
  if (!outboundReady) {
    setupOutbound();
    outboundReady = true;
  }
  void startSlackBridge();
}
