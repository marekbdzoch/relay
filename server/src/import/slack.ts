/**
 * Slack workspace export importer (Slack → Workspace settings → Import/Export data → Export).
 *
 * The export is a ZIP with users.json, channels.json (+ groups.json, dms.json, mpims.json on plans that include
 * private conversations) and one folder per conversation holding YYYY-MM-DD.json arrays of messages.
 *
 * Design notes
 * - Runs as a background job; progress is pushed to the admin who started it ('import:progress').
 * - Writes straight to the database in batched transactions instead of going through postMessage(): no
 *   notifications, activity items, agent triggers, unfurls, bridge echo or realtime storm. Clients get a single
 *   'import:done' at the end and reload. The FTS index is maintained by the messages triggers.
 * - Idempotent: every Slack object is recorded in import_map (source 'slack'), so re-importing the same or a newer
 *   export only adds what is missing. Messages are also recorded in slack_messages / people in slack_users so the
 *   live Slack bridge recognises them (no duplicates when a channel is linked later).
 * - Ordering: channels list messages by id, so history must be inserted oldest first. When history is merged into
 *   a channel that already has newer messages (e.g. the "joined" notices in #general), those are moved behind the
 *   imported history (re-inserted with a new id, references updated).
 */
import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import type { SlackImportJob } from '../../../shared/types.ts';
import { config } from '../config.ts';
import { all, db, get, run, tx } from '../db.ts';
import { hashPassword } from '../lib/auth.ts';
import { absPath, imageSize } from '../lib/files.ts';
import { HttpError, newId, normalizeUsername, now, randomAvatarColor, randomToken } from '../lib/util.ts';
import { io, joinChannelRoom, toUser } from '../realtime.ts';

const SOURCE = 'slack';
const MAX_JSON_BYTES = 512 * 1024 * 1024;
const MAX_WARNINGS = 100;

export interface SlackImportOptions {
  importFiles: boolean;
  importPrivate: boolean;
  importDms: boolean;
}

/** exposed for tests */
export const _internals = {
  /** downloads are limited to Slack's file/avatar hosts unless this is set (tests serve files locally) */
  allowAnyHost: false,
  downloadConcurrency: 4,
};

// ---------------------------------------------------------------------------
// zip access

interface Zip {
  entries: Map<string, yauzl.Entry>;
  zf: yauzl.ZipFile;
  /** folder prefix when the export was re-zipped inside a top-level folder */
  root: string;
}

async function openZip(file: string): Promise<Zip> {
  const zf = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false, strictFileNames: false, decodeStrings: true });
  const entries = new Map<string, yauzl.Entry>();
  await new Promise<void>((resolve, reject) => {
    zf.on('entry', (e: yauzl.Entry) => {
      if (!e.fileName.endsWith('/') && !e.fileName.startsWith('__MACOSX/')) entries.set(e.fileName, e);
      zf.readEntry();
    });
    zf.once('end', () => resolve());
    zf.once('error', reject);
    zf.readEntry();
  });
  // users.json / channels.json mark the export root (may be nested one folder deep)
  let root: string | null = null;
  for (const name of entries.keys()) {
    const base = name.split('/').pop();
    if (base !== 'channels.json' && base !== 'users.json') continue;
    const dir = name.slice(0, name.length - base.length);
    if (root === null || dir.length < root.length) root = dir;
  }
  if (root === null) {
    zf.close();
    throw new HttpError(400, 'not_a_slack_export', 'This ZIP does not look like a Slack export (users.json / channels.json missing).');
  }
  return { entries, zf, root };
}

async function readEntry(zip: Zip, e: yauzl.Entry): Promise<unknown> {
  if (e.uncompressedSize > MAX_JSON_BYTES) throw new Error(`${e.fileName} is too large`);
  const stream = await zip.zf.openReadStreamPromise(e);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stream) {
    size += (c as Buffer).length;
    if (size > MAX_JSON_BYTES) throw new Error(`${e.fileName} is too large`);
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readJson<T>(zip: Zip, name: string, fallback: T): Promise<T> {
  const e = zip.entries.get(zip.root + name);
  if (!e) return fallback;
  return (await readEntry(zip, e)) as T;
}

/** Throws a 400 unless the file is a ZIP that looks like a Slack export. */
export async function inspectSlackExport(file: string) {
  let zip: Zip;
  try {
    zip = await openZip(file);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'not_a_slack_export', 'The file is not a valid ZIP archive.');
  }
  zip.zf.close();
}

// ---------------------------------------------------------------------------
// jobs

interface JobRecord {
  job: SlackImportJob;
  userId: string;
}

const jobs = new Map<string, JobRecord>();
let lastJobId: string | null = null;

export const getImportJob = (id: string) => jobs.get(id)?.job ?? null;
export const latestImportJob = () => (lastJobId ? (jobs.get(lastJobId)?.job ?? null) : null);
export const importRunning = () => [...jobs.values()].some((j) => j.job.state === 'queued' || j.job.state === 'running');

/** Starts the import of a Slack export (the ZIP at `zipPath` is deleted afterwards). */
export function startSlackImport(zipPath: string, opts: SlackImportOptions, userId: string): SlackImportJob {
  const job: SlackImportJob = {
    id: newId('J'),
    state: 'queued',
    phase: 'queued',
    progress: 0,
    counts: { users: 0, channels: 0, messages: 0, files: 0, reactions: 0 },
    warnings: [],
    startedAt: now(),
  };
  jobs.set(job.id, { job, userId });
  lastJobId = job.id;
  // keep memory bounded: only the latest few jobs are queryable
  for (const id of [...jobs.keys()].slice(0, -10)) jobs.delete(id);
  setImmediate(() => void runJob(job, userId, zipPath, opts));
  return job;
}

/** Turns an imported placeholder into a real account (called by signup with an admin's personal invite). */
export async function claimImportedUser(userId: string, o: { password: string; fullName: string; role: string; timezone?: string }) {
  const hash = await hashPassword(o.password);
  const r = run(
    `UPDATE users SET password_hash = ?, full_name = ?, role = ?, timezone = CASE WHEN ? != '' THEN ? ELSE timezone END,
       imported = 0, external = NULL, deactivated = 0 WHERE id = ? AND imported = 1`,
    hash,
    o.fullName.trim(),
    o.role,
    o.timezone ?? '',
    o.timezone ?? '',
    userId,
  );
  if (!r.changes) throw new HttpError(409, 'email_taken');
  return userId;
}

// ---------------------------------------------------------------------------
// the import

interface SlackProfile {
  real_name?: string;
  display_name?: string;
  title?: string;
  phone?: string;
  email?: string;
  image_72?: string;
  image_192?: string;
  image_512?: string;
  image_original?: string;
  is_custom_image?: boolean;
}
interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  tz?: string;
  profile?: SlackProfile;
}
interface SlackConv {
  id: string;
  name?: string;
  created?: number;
  creator?: string;
  is_archived?: boolean;
  is_general?: boolean;
  members?: string[];
  user?: string;
  topic?: { value?: string };
  purpose?: { value?: string };
}
interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  mode?: string;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
  external_url?: string;
  is_external?: boolean;
  original_w?: number;
  original_h?: number;
}
interface SlackMsg {
  type?: string;
  subtype?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  user_profile?: SlackProfile & { name?: string };
  text?: string;
  thread_ts?: string;
  reply_broadcast?: boolean;
  hidden?: boolean;
  inviter?: string;
  topic?: string;
  purpose?: string;
  name?: string;
  edited?: { ts?: string };
  reactions?: { name: string; users?: string[]; count?: number }[];
  files?: SlackFile[];
  attachments?: { fallback?: string; text?: string }[];
  pinned_to?: string[];
}

type Kind = 'public' | 'private' | 'dm' | 'group';

interface Conv {
  slack: SlackConv;
  kind: Kind;
  folder: string | null;
  localId: string;
  name: string;
}

interface PendingFile {
  key: string; // message key `${slackChannel}:${ts}`
  fileKey: string;
  channelId: string;
  ownerId: string | null;
  file: SlackFile;
  createdAt: number;
}

const SYSTEM_SUBTYPES: Record<string, string> = {
  channel_join: 'join',
  group_join: 'join',
  channel_leave: 'leave',
  group_leave: 'leave',
  channel_topic: 'topic',
  group_topic: 'topic',
  channel_purpose: 'description',
  group_purpose: 'description',
  channel_name: 'rename',
  group_name: 'rename',
  channel_archive: 'archive',
  group_archive: 'archive',
  channel_unarchive: 'unarchive',
  group_unarchive: 'unarchive',
};
const CONTENT_SUBTYPES = new Set(['', 'bot_message', 'me_message', 'thread_broadcast', 'reply_broadcast', 'file_share', 'file_comment', 'slackbot_response', 'tombstone', 'share']);
const EMOJI_ALIASES: Record<string, string> = { thumbsup: '+1', thumbsdown: '-1', simple_smile: 'slightly_smiling_face' };

/** Slack ts ("1609459200.000200") as integer microseconds – exact ordering key. */
function tsMicros(ts: string) {
  const [s, f = ''] = String(ts).split('.');
  return Number(s) * 1e6 + Number((f + '000000').slice(0, 6));
}
const tsMillis = (ts: string) => Math.floor(tsMicros(ts) / 1000);

function decodeEntities(s: string) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function cleanChannelName(name: string) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}_\-]/gu, '')
      .slice(0, 80) || 'channel'
  );
}

function uniqueUsername(base: string) {
  const name = normalizeUsername(base) || 'slack.user';
  let candidate = name;
  let i = 1;
  while (get('SELECT 1 FROM users WHERE username = ?', candidate)) candidate = `${name}${++i}`;
  return candidate;
}

function allowedUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (_internals.allowAnyHost) return u.protocol === 'https:' || u.protocol === 'http:';
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return ['slack.com', 'slack-edge.com', 'slack-files.com', 'slack-imgs.com'].some((d) => h === d || h.endsWith('.' + d));
  } catch {
    return false;
  }
}

async function download(url: string, maxBytes: number): Promise<{ buf: Buffer; type: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new Error('too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += c.length;
    if (size > maxBytes) throw new Error('too large');
    chunks.push(Buffer.from(c));
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  // Slack answers expired/invalid file links with an HTML login page
  if (type === 'text/html') throw new Error('not a file (login page)');
  return { buf: Buffer.concat(chunks), type };
}

function saveBuffer(subdir: string, name: string, buf: Buffer) {
  const ext = path.extname(name || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  fs.mkdirSync(path.join(config.uploadsDir, subdir), { recursive: true });
  const rel = path.join(subdir, `${Date.now().toString(36)}${randomToken(9)}${ext}`);
  fs.writeFileSync(absPath(rel), buf);
  return rel;
}

function fileLink(f: SlackFile) {
  const strip = (u: string) => u.split('?')[0];
  return f.permalink || (f.is_external && f.external_url) || (f.url_private ? strip(f.url_private) : '') || '';
}
/** Text line kept in a message for a file that wasn't (or couldn't be) copied. */
function fileLine(f: SlackFile) {
  const name = (f.name || f.title || 'file').replace(/[<>|]/g, '');
  const link = fileLink(f);
  return link ? `:paperclip: <${link}|${name}>` : `:paperclip: ${name}`;
}

class Importer {
  job: SlackImportJob;
  userId: string;
  opts: SlackImportOptions;
  zip!: Zip;
  lastEmit = 0;

  userMap = new Map<string, string>(); // slack user -> local user
  botNames = new Map<string, string>(); // slack user id of bots/apps -> name
  profiles = new Map<string, SlackUser>();
  avatarQueue: { userId: string; url: string }[] = [];
  convs: Conv[] = [];
  channelMap = new Map<string, Conv>(); // slack conversation id -> conv
  slackChannelNames = new Map<string, string>();
  pendingFiles: PendingFile[] = [];
  newMembers: { channelId: string; userId: string }[] = [];
  skippedSubtypes = 0;
  skippedFiles = 0;
  warningOverflow = 0;

  // prepared statements (hot path)
  st = {
    mapGet: db.prepare('SELECT local_id FROM import_map WHERE source = ? AND kind = ? AND external_id = ?'),
    mapSet: db.prepare('INSERT INTO import_map (source, kind, external_id, local_id) VALUES (?, ?, ?, ?) ON CONFLICT(source, kind, external_id) DO UPDATE SET local_id = excluded.local_id'),
    msgByMap: db.prepare(
      "SELECT m.id FROM import_map im JOIN messages m ON m.id = CAST(im.local_id AS INTEGER) WHERE im.source = 'slack' AND im.kind = 'message' AND im.external_id = ?",
    ),
    msgByBridge: db.prepare('SELECT m.id FROM slack_messages sm JOIN messages m ON m.id = sm.relay_message_id WHERE sm.slack_channel_id = ? AND sm.slack_ts = ?'),
    insertMsg: db.prepare(
      `INSERT INTO messages (channel_id, user_id, text, subtype, thread_root_id, also_in_channel, meta, created_at, edited_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    bridgeSet: db.prepare('INSERT OR IGNORE INTO slack_messages (relay_message_id, slack_channel_id, slack_ts) VALUES (?, ?, ?)'),
    reaction: db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)'),
    pin: db.prepare('INSERT OR IGNORE INTO pins (message_id, channel_id, pinned_by, created_at) VALUES (?, ?, ?, ?)'),
  };

  constructor(job: SlackImportJob, userId: string, opts: SlackImportOptions) {
    this.job = job;
    this.userId = userId;
    this.opts = opts;
  }

  warn(msg: string) {
    if (this.job.warnings.length < MAX_WARNINGS) this.job.warnings.push(msg);
    else this.warningOverflow++;
  }

  progress(phase: string, p: number, force = false) {
    this.job.phase = phase;
    this.job.progress = Math.max(this.job.progress, Math.min(1, p));
    const t = Date.now();
    if (force || t - this.lastEmit > 250) {
      this.lastEmit = t;
      toUser(this.userId).emit('import:progress', { ...this.job, warnings: [...this.job.warnings] });
    }
  }

  mapGet(kind: string, ext: string) {
    return (this.st.mapGet.get(SOURCE, kind, ext) as { local_id: string } | undefined)?.local_id ?? null;
  }
  mapSet(kind: string, ext: string, local: string | number) {
    this.st.mapSet.run(SOURCE, kind, ext, String(local));
  }

  // ----- users -----

  importUsers(list: SlackUser[]) {
    tx(() => {
      for (const su of list) {
        if (!su?.id) continue;
        this.profiles.set(su.id, su);
        if (su.is_bot || su.is_app_user || su.id === 'USLACKBOT') {
          this.botNames.set(su.id, su.profile?.real_name || su.real_name || su.name || 'Slack app');
          continue;
        }
        this.mapUser(su, false);
      }
    });
  }

  /** Maps a Slack person to a local account: earlier import, bridge puppet, same e-mail, or a new placeholder. */
  mapUser(su: SlackUser, unknown: boolean): string {
    const p = su.profile ?? {};
    const fullName = (p.real_name || su.real_name || p.display_name || su.name || `Slack user ${su.id}`).slice(0, 80);
    const email = p.email?.trim().toLowerCase() || null;
    const deactivated = su.deleted || unknown ? 1 : 0;
    const avatar = p.is_custom_image === false ? undefined : p.image_512 || p.image_192 || p.image_72;

    let localId = this.mapGet('user', su.id);
    if (localId && !get('SELECT 1 FROM users WHERE id = ?', localId)) localId = null;
    if (localId) {
      // refresh placeholders that nobody has claimed yet
      const row = get<{ imported: number; avatar_path: string | null }>('SELECT imported, avatar_path FROM users WHERE id = ?', localId)!;
      if (row.imported && !unknown) {
        run(
          'UPDATE users SET full_name = ?, display_name = ?, title = ?, timezone = ?, deactivated = ? WHERE id = ?',
          fullName,
          (p.display_name ?? '').slice(0, 80),
          (p.title ?? '').slice(0, 200),
          su.tz ?? '',
          deactivated,
          localId,
        );
        if (!row.avatar_path && avatar) this.avatarQueue.push({ userId: localId, url: avatar });
      }
      this.userMap.set(su.id, localId);
      return localId;
    }

    // a person the Slack bridge already mirrored
    const bridged = get<{ id: string; external: string | null; email: string }>(
      'SELECT u.id, u.external, u.email FROM slack_users s JOIN users u ON u.id = s.relay_user_id WHERE s.slack_user_id = ?',
      su.id,
    );
    if (bridged) {
      localId = bridged.id;
      // a bridge puppet with the real e-mail becomes claimable
      if (bridged.external === 'slack' && email && bridged.email.endsWith('.invalid') && !get('SELECT 1 FROM users WHERE email = ?', email)) {
        run('UPDATE users SET email = ?, imported = 1 WHERE id = ?', email, localId);
      }
    } else if (email) {
      localId = get<{ id: string }>('SELECT id FROM users WHERE email = ?', email)?.id ?? null;
    }

    if (!localId) {
      localId = newId('U');
      const emailFree = email && !get('SELECT 1 FROM users WHERE email = ?', email);
      run(
        `INSERT INTO users (id, email, password_hash, username, full_name, display_name, title, phone, timezone, avatar_color, role, deactivated, imported, created_at)
         VALUES (?, ?, '!', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        localId,
        emailFree ? email : `${su.id.toLowerCase()}.${randomToken(3).toLowerCase()}@slack-import.invalid`,
        uniqueUsername(p.display_name || su.name || fullName),
        fullName,
        (p.display_name ?? '').slice(0, 80),
        (p.title ?? '').slice(0, 200),
        (p.phone ?? '').slice(0, 50),
        su.tz ?? '',
        randomAvatarColor(),
        su.is_restricted || su.is_ultra_restricted ? 'guest' : 'member',
        deactivated,
        now(),
      );
      if (avatar) this.avatarQueue.push({ userId: localId, url: avatar });
    }
    this.mapSet('user', su.id, localId);
    run('INSERT OR IGNORE INTO slack_users (slack_user_id, relay_user_id) VALUES (?, ?)', su.id, localId);
    this.userMap.set(su.id, localId);
    this.job.counts.users++;
    return localId;
  }

  /** Local user for a Slack user id seen in a message/reaction; unknown people get a deactivated placeholder. */
  user(slackId: string | undefined, hint?: SlackMsg['user_profile']): string | null {
    if (!slackId || this.botNames.has(slackId)) return null;
    const known = this.userMap.get(slackId);
    if (known) return known;
    if (!/^[UW][A-Z0-9]+$/.test(slackId)) return null;
    const su: SlackUser = this.profiles.get(slackId) ?? {
      id: slackId,
      name: hint?.name,
      real_name: hint?.real_name,
      profile: hint ? { real_name: hint.real_name, display_name: hint.display_name, image_72: hint.image_72 } : undefined,
    };
    return this.mapUser(su, !this.profiles.has(slackId));
  }

  // ----- conversations -----

  importConversations(lists: { kind: Kind; list: SlackConv[] }[], folders: Set<string>) {
    for (const { list } of lists) for (const c of list) if (c?.id && c.name) this.slackChannelNames.set(c.id, c.name);
    tx(() => {
      for (const { kind, list } of lists) {
        for (const c of list) {
          if (!c?.id) continue;
          try {
            this.importConversation(c, kind, folders);
          } catch (e) {
            this.warn(`Conversation ${c.name ?? c.id} was skipped: ${e instanceof Error ? e.message : e}`);
          }
        }
      }
    });
  }

  importConversation(c: SlackConv, kind: Kind, folders: Set<string>) {
    const folder = [c.name, c.id].find((f) => f && folders.has(f)) ?? null;
    const created = c.created ? c.created * 1000 : now();
    const creator = this.user(c.creator);
    const topic = decodeEntities(c.topic?.value ?? '').slice(0, 250);
    const purpose = decodeEntities(c.purpose?.value ?? '').slice(0, 250);
    const memberSlackIds = c.members ?? (c.user ? [c.user] : []);

    type ChanRow = { id: string; kind: Kind; name: string; topic: string; description: string; is_default: number };
    let localId = this.mapGet('channel', c.id);
    let row = localId ? get<ChanRow>('SELECT * FROM channels WHERE id = ?', localId) : undefined;
    const mappedBefore = !!row;
    if (localId && !row) {
      // the channel was deleted here since the last import: forget its old messages and start over
      run("DELETE FROM import_map WHERE source = 'slack' AND kind IN ('message', 'file') AND external_id LIKE ? ESCAPE '\\'", `${c.id.replace(/[%_\\]/g, '\\$&')}:%`);
      localId = null;
    }
    let isNew = false;

    if (!row) {
      if (kind === 'public' || kind === 'private') {
        let name = c.is_general ? 'general' : cleanChannelName(c.name ?? c.id);
        const existing = get<{ id: string; kind: Kind }>("SELECT id, kind FROM channels WHERE name = ? AND kind IN ('public', 'private')", name);
        // merge by name – but never pour private history into a public channel
        if (existing && (existing.kind === kind || kind === 'public' || c.is_general)) {
          localId = existing.id;
        } else {
          if (existing) {
            const base = `${name}-slack`.slice(0, 80);
            name = base;
            for (let i = 2; get("SELECT 1 FROM channels WHERE name = ? AND kind IN ('public', 'private')", name); i++) name = `${base}-${i}`;
            this.warn(`Private channel #${c.name} was imported as #${name} because a public channel with that name already exists.`);
          }
          localId = newId('C');
          run(
            'INSERT INTO channels (id, kind, name, topic, description, created_by, created_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            localId,
            kind,
            name,
            topic,
            purpose,
            creator,
            created,
            c.is_archived ? 1 : 0,
          );
          isNew = true;
        }
      } else {
        const ids: string[] = [];
        for (const sid of memberSlackIds) {
          if (this.botNames.has(sid)) {
            this.warn(`A direct message with the app "${this.botNames.get(sid)}" was skipped.`);
            return;
          }
          const uid = this.user(sid);
          if (uid) ids.push(uid);
        }
        const unique = [...new Set(ids)].sort();
        if (!unique.length) return;
        const key = unique.join(',');
        localId = get<{ id: string }>('SELECT id FROM channels WHERE dm_key = ?', key)?.id ?? null;
        if (!localId) {
          localId = newId('D');
          run('INSERT INTO channels (id, kind, created_by, created_at, dm_key) VALUES (?, ?, ?, ?, ?)', localId, unique.length <= 2 ? 'dm' : 'group', creator, created, key);
          isNew = true;
        }
      }
      row = get<ChanRow>('SELECT * FROM channels WHERE id = ?', localId!)!;
      this.mapSet('channel', c.id, localId!);
      this.job.counts.channels++;
    }
    localId = row.id;

    if (row.kind === 'public' || row.kind === 'private') {
      if (!isNew) {
        // fill in what is missing, never overwrite what people set here
        if (!row.topic && topic) run('UPDATE channels SET topic = ? WHERE id = ?', topic, localId);
        if (!row.description && purpose) run('UPDATE channels SET description = ? WHERE id = ?', purpose, localId);
        // archived in Slack since the last import (never for channels merged by name, or the default ones)
        if (c.is_archived && mappedBefore && !row.is_default) {
          run('UPDATE channels SET archived = 1 WHERE id = ?', localId);
        }
      }
    }

    const isDm = row.kind === 'dm' || row.kind === 'group';
    for (const sid of memberSlackIds) {
      const uid = this.user(sid);
      if (!uid) continue;
      if (!isDm && get('SELECT 1 FROM users WHERE id = ? AND deactivated = 1', uid)) continue;
      const r = run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at, last_read) VALUES (?, ?, ?, 0)', localId, uid, created);
      if (r.changes) this.newMembers.push({ channelId: localId, userId: uid });
    }

    const conv: Conv = { slack: c, kind: row.kind, folder, localId, name: row.name };
    this.convs.push(conv);
    this.channelMap.set(c.id, conv);
  }

  // ----- text -----

  convertText(text: string | undefined): string {
    if (!text) return '';
    const out = text
      .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, sid: string, label?: string) => {
        if (this.botNames.has(sid)) return `@${this.botNames.get(sid)}`;
        const uid = this.userMap.get(sid);
        if (uid) return `<@${uid}>`;
        const p = this.profiles.get(sid);
        return `@${label || p?.profile?.display_name || p?.real_name || p?.name || 'unknown'}`;
      })
      .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, cid: string, label?: string) => {
        const conv = this.channelMap.get(cid);
        if (conv && (conv.kind === 'public' || conv.kind === 'private')) return `<#${conv.localId}|${conv.name}>`;
        return `#${label || this.slackChannelNames.get(cid) || 'channel'}`;
      })
      .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '<!$1>')
      .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, name?: string) => name ?? '@group')
      .replace(/<!date\^[^|>]*\|([^>]*)>/g, '$1')
      .replace(/<mailto:([^|>]+)(?:\|([^>]+))?>/g, (_, addr: string, label?: string) => label ?? addr)
      .replace(/<tel:([^|>]+)(?:\|([^>]+))?>/g, (_, nr: string, label?: string) => label ?? nr);
    return decodeEntities(out);
  }

  // ----- messages -----

  findMessage(slackChannel: string, ts: string): number | null {
    const key = `${slackChannel}:${ts}`;
    const a = this.st.msgByMap.get(key) as { id: number } | undefined;
    if (a) return a.id;
    const b = this.st.msgByBridge.get(slackChannel, ts) as { id: number } | undefined;
    if (b) {
      this.mapSet('message', key, b.id);
      return b.id;
    }
    return null;
  }

  async importMessages(dayFiles: Map<string, yauzl.Entry[]>, progressFrom: number, progressTo: number) {
    const total = this.convs.reduce((n, c) => n + (dayFiles.get(c.folder ?? '') ?? []).reduce((m, e) => m + e.uncompressedSize, 0), 0) || 1;
    let done = 0;
    const read = async (day: yauzl.Entry): Promise<SlackMsg[]> => {
      try {
        const data = await readEntry(this.zip, day);
        return Array.isArray(data) ? (data as SlackMsg[]).filter((m) => m && typeof m.ts === 'string') : [];
      } catch (e) {
        this.warn(`${day.fileName} could not be read: ${e instanceof Error ? e.message : e}`);
        return [];
      }
    };
    for (const conv of this.convs) {
      const days = conv.folder ? (dayFiles.get(conv.folder) ?? []) : [];
      if (!days.length) continue;
      const cs = new ChannelState(conv);
      // batches of day files: read in parallel, insert in one transaction (few large commits are much faster)
      for (let i = 0; i < days.length; ) {
        const batch: yauzl.Entry[] = [];
        let bytes = 0;
        while (i < days.length && batch.length < 64 && bytes < 8 * 1024 * 1024) {
          bytes += days[i].uncompressedSize;
          batch.push(days[i++]);
        }
        const msgs = (await Promise.all(batch.map(read))).flat().sort((a, b) => tsMicros(a.ts) - tsMicros(b.ts));
        bulkIndexed(() => {
          for (const m of msgs) this.importMessage(cs, m);
        });
        done += bytes;
        this.progress('messages', progressFrom + ((progressTo - progressFrom) * done) / total);
        await new Promise((r) => setImmediate(r));
      }
      bulkIndexed(() => cs.finish());
      await new Promise((r) => setImmediate(r));
    }
  }

  importMessage(cs: ChannelState, m: SlackMsg) {
    const conv = cs.conv;
    const slackChannel = conv.slack.id;
    const key = `${slackChannel}:${m.ts}`;
    const subtype = m.subtype ?? '';
    if (m.hidden || (subtype && !(subtype in SYSTEM_SUBTYPES) && !CONTENT_SUBTYPES.has(subtype))) {
      this.skippedSubtypes++;
      return;
    }
    const createdAt = tsMillis(m.ts);
    let id = this.findMessage(slackChannel, m.ts);

    if (id === null) {
      // ----- author -----
      let userId: string | null = null;
      let botName: string | undefined;
      if (subtype === 'bot_message' || (!m.user && m.bot_id)) botName = m.username || m.bot_profile?.name || this.botNames.get(m.user ?? '') || 'Slack app';
      else if (m.user && this.botNames.has(m.user)) botName = m.bot_profile?.name || this.botNames.get(m.user) || 'Slack app';
      else if (m.user === 'USLACKBOT') botName = 'Slackbot';
      else if (m.user) userId = this.user(m.user, m.user_profile);
      if (!userId && !botName) botName = m.username || 'Slack';

      // ----- kind & text -----
      let sub: string | null = null;
      let text = '';
      let deletedAt: number | null = null;
      const system = SYSTEM_SUBTYPES[subtype];
      if (system) {
        if (!userId || conv.kind === 'dm' || conv.kind === 'group') {
          this.skippedSubtypes++;
          return;
        }
        sub = system;
        if (system === 'join') {
          const inviter = m.inviter ? this.user(m.inviter) : null;
          text = inviter && inviter !== userId ? `<@${inviter}>` : '';
        } else if (system === 'topic') text = this.convertText(m.topic ?? '');
        else if (system === 'description') text = this.convertText(m.purpose ?? '');
        else if (system === 'rename') text = m.name ?? '';
      } else if (subtype === 'tombstone') {
        deletedAt = createdAt;
      } else {
        text = this.convertText(m.text);
        if (subtype === 'me_message' && text) text = `_${text}_`;
        if (!text.trim() && Array.isArray(m.attachments)) {
          text = this.convertText(m.attachments.map((a) => a.fallback || a.text || '').filter(Boolean).join('\n'));
        }
        if (botName) sub = 'bot';
      }

      // ----- files -----
      const files = (m.files ?? []).filter((f) => f && f.mode !== 'tombstone' && f.mode !== 'hidden_by_limit');
      this.skippedFiles += (m.files?.length ?? 0) - files.length;
      const lines: string[] = [];
      for (const f of files) {
        const downloadable = this.opts.importFiles && !f.is_external && f.mode !== 'external' && allowedUrl(f.url_private_download || f.url_private);
        if (downloadable) this.pendingFiles.push({ key, fileKey: `${key}/${f.id ?? f.name}`, channelId: conv.localId, ownerId: userId, file: f, createdAt });
        else lines.push(fileLine(f));
      }
      if (lines.length) text = [text, ...lines].filter(Boolean).join('\n');
      if (!text.trim() && !files.length && !deletedAt && !sub) {
        this.skippedSubtypes++;
        return;
      }

      // newer messages already here move behind this one (may move the thread root too, so look it up after)
      cs.beforeInsert(createdAt);
      let rootId: number | null = null;
      if (m.thread_ts && m.thread_ts !== m.ts) rootId = this.findMessage(slackChannel, m.thread_ts);
      const alsoInChannel = rootId !== null && (subtype === 'thread_broadcast' || subtype === 'reply_broadcast' || !!m.reply_broadcast);
      const meta: Record<string, unknown> = { source: 'slack', noUnfurl: true };
      if (botName) meta.botName = botName.slice(0, 80);
      const r = this.st.insertMsg.run(
        conv.localId,
        userId,
        text,
        sub,
        rootId,
        alsoInChannel ? 1 : 0,
        JSON.stringify(meta),
        createdAt,
        m.edited?.ts ? tsMillis(m.edited.ts) : null,
        deletedAt,
      );
      id = Number(r.lastInsertRowid);
      this.mapSet('message', key, id);
      this.st.bridgeSet.run(id, slackChannel, m.ts);
      this.job.counts.messages++;
      cs.inserted(id, rootId, userId, alsoInChannel);
    } else if (this.opts.importFiles && m.files?.length) {
      // already imported: retry files that weren't copied last time
      const owner = get<{ user_id: string | null }>('SELECT user_id FROM messages WHERE id = ?', id)?.user_id ?? null;
      for (const f of m.files ?? []) {
        const fileKey = `${key}/${f.id ?? f.name}`;
        if (!f || f.mode === 'tombstone' || f.mode === 'hidden_by_limit' || f.is_external || f.mode === 'external') continue;
        if (this.mapGet('file', fileKey) || !allowedUrl(f.url_private_download || f.url_private)) continue;
        this.pendingFiles.push({ key, fileKey, channelId: conv.localId, ownerId: owner, file: f, createdAt });
      }
    }

    // ----- reactions & pins (also refreshed for messages imported before) -----
    for (const rx of m.reactions ?? []) {
      if (!rx?.name) continue;
      const [base, ...rest] = rx.name.split('::');
      const emoji = [EMOJI_ALIASES[base] ?? base, ...rest].join('::');
      for (const sid of rx.users ?? []) {
        const uid = this.user(sid);
        if (uid && this.st.reaction.run(id, uid, emoji, createdAt).changes) this.job.counts.reactions++;
      }
    }
    if (m.pinned_to?.includes(slackChannel)) {
      const author = get<{ user_id: string | null }>('SELECT user_id FROM messages WHERE id = ?', id)?.user_id;
      this.st.pin.run(id, conv.localId, author ?? this.userId, createdAt);
    }
  }

  // ----- files -----

  async importFiles(progressFrom: number, progressTo: number) {
    const list = this.pendingFiles;
    const avatars = this.avatarQueue;
    const total = list.length + avatars.length || 1;
    let done = 0;
    let failed = 0;
    const maxBytes = config.maxUploadMb * 1024 * 1024;
    const tick = () => this.progress('files', progressFrom + ((progressTo - progressFrom) * ++done) / total);

    const fileJob = async (p: PendingFile) => {
      const f = p.file;
      const msgId = this.findMessage(p.key.slice(0, p.key.indexOf(':')), p.key.slice(p.key.indexOf(':') + 1));
      try {
        if (!msgId || this.mapGet('file', p.fileKey)) return;
        if (f.size && f.size > maxBytes) throw new Error(`larger than the ${config.maxUploadMb} MB upload limit`);
        const { buf } = await download((f.url_private_download || f.url_private)!, maxBytes);
        const name = (f.name || f.title || 'file').slice(0, 200);
        const rel = saveBuffer(new Date().toISOString().slice(0, 7), name, buf);
        const mime = f.mimetype || 'application/octet-stream';
        const dims = f.original_w && f.original_h ? { width: f.original_w, height: f.original_h } : mime.startsWith('image/') ? imageSize(absPath(rel)) : null;
        const fileId = newId('F', 12);
        tx(() => {
          run(
            'INSERT INTO files (id, user_id, channel_id, message_id, name, mime, size, path, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            fileId,
            p.ownerId ?? '',
            p.channelId,
            msgId,
            name,
            mime,
            buf.length,
            rel,
            dims?.width ?? null,
            dims?.height ?? null,
            p.createdAt,
          );
          this.mapSet('file', p.fileKey, fileId);
          // an earlier import without files left a link in the text
          const line = fileLine(f);
          const text = get<{ text: string }>('SELECT text FROM messages WHERE id = ?', msgId)?.text ?? '';
          if (text.includes(line)) run('UPDATE messages SET text = ? WHERE id = ?', text.replace(`\n${line}`, '').replace(line, ''), msgId);
        });
        this.job.counts.files++;
      } catch (e) {
        failed++;
        if (msgId) {
          // keep a link to the original so nothing is lost
          const line = fileLine(f);
          const text = get<{ text: string }>('SELECT text FROM messages WHERE id = ?', msgId)?.text ?? '';
          if (!text.includes(line)) run('UPDATE messages SET text = ? WHERE id = ?', text ? `${text}\n${line}` : line, msgId);
        }
        if (failed <= 20) this.warn(`File "${f.name ?? f.id}" could not be copied (${e instanceof Error ? e.message : e}); a link to Slack was kept instead.`);
      } finally {
        tick();
      }
    };

    const avatarJob = async (a: { userId: string; url: string }) => {
      try {
        if (!allowedUrl(a.url) || get('SELECT 1 FROM users WHERE id = ? AND avatar_path IS NOT NULL', a.userId)) return;
        const { buf, type } = await download(a.url, 10 * 1024 * 1024);
        const ext = type.includes('png') ? '.png' : type.includes('gif') ? '.gif' : '.jpg';
        const rel = saveBuffer('avatars', `avatar${ext}`, buf);
        run('UPDATE users SET avatar_path = ? WHERE id = ? AND avatar_path IS NULL', rel, a.userId);
      } catch {
        /* initials are fine */
      } finally {
        tick();
      }
    };

    const queue: (() => Promise<void>)[] = [...avatars.map((a) => () => avatarJob(a)), ...list.map((p) => () => fileJob(p))];
    const workers = Array.from({ length: Math.max(1, _internals.downloadConcurrency) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await next();
    });
    await Promise.all(workers);
    if (failed > 20) this.warn(`${failed - 20} more files could not be copied; links to Slack were kept instead.`);
  }

  // ----- main -----

  async run(zipPath: string) {
    const job = this.job;
    job.state = 'running';
    this.progress('reading', 0, true);
    this.zip = await openZip(zipPath);
    const zip = this.zip;

    const users = await readJson<SlackUser[]>(zip, 'users.json', []);
    const lists: { kind: Kind; list: SlackConv[] }[] = [{ kind: 'public', list: await readJson<SlackConv[]>(zip, 'channels.json', []) }];
    const groups = await readJson<SlackConv[]>(zip, 'groups.json', []);
    const dms = await readJson<SlackConv[]>(zip, 'dms.json', []);
    const mpims = await readJson<SlackConv[]>(zip, 'mpims.json', []);
    if (this.opts.importPrivate) lists.push({ kind: 'private', list: groups });
    else if (groups.length) this.warn(`${groups.length} private channels were skipped (option turned off).`);
    if (this.opts.importDms) lists.push({ kind: 'dm', list: dms }, { kind: 'group', list: mpims });
    else if (dms.length + mpims.length) this.warn(`${dms.length + mpims.length} direct messages were skipped (option turned off).`);
    if (!groups.length && !dms.length && !mpims.length) {
      this.warn('This export contains public channels only. Private channels and direct messages are only included in exports from Slack Business+ and Enterprise plans.');
    }

    // conversation folders with their day files, oldest first
    const dayFiles = new Map<string, yauzl.Entry[]>();
    for (const [name, e] of zip.entries) {
      if (!name.startsWith(zip.root)) continue;
      const m = /^(.+)\/(\d{4}-\d{2}-\d{2})\.json$/.exec(name.slice(zip.root.length));
      if (!m || m[1].includes('/')) continue;
      const list = dayFiles.get(m[1]) ?? [];
      list.push(e);
      dayFiles.set(m[1], list);
    }
    for (const list of dayFiles.values()) list.sort((a, b) => (a.fileName < b.fileName ? -1 : 1));
    this.progress('users', 0.02, true);

    this.importUsers(users);
    this.progress('channels', 0.06, true);
    this.importConversations(lists, new Set(dayFiles.keys()));
    this.progress('messages', 0.1, true);

    const withFiles = this.opts.importFiles;
    await this.importMessages(dayFiles, 0.1, withFiles ? 0.75 : 0.97);
    if (this.skippedSubtypes) this.warn(`${this.skippedSubtypes} Slack system messages (e.g. app installs, reminders, empty messages) were skipped.`);
    if (this.skippedFiles) this.warn(`${this.skippedFiles} files were not part of the export (deleted, or hidden by the Slack plan's limits).`);

    if (withFiles && (this.pendingFiles.length || this.avatarQueue.length)) {
      this.progress('files', 0.75, true);
      await this.importFiles(0.75, 0.97);
    }

    this.progress('finishing', 0.97, true);
    for (const m of this.newMembers) joinChannelRoom(m.userId, m.channelId);
    if (this.warningOverflow) job.warnings.push(`…and ${this.warningOverflow} more warnings.`);
  }
}

/** Per-conversation bookkeeping while its messages are imported. */
class ChannelState {
  conv: Conv;
  /** messages already here that are newer than imported history (moved behind it), oldest first */
  queue: { id: number; created_at: number }[] | null = null;
  /** old id -> new id of moved messages */
  moved: [number, number][] = [];
  importedIds: number[] = [];
  /** thread root -> participants / newest imported reply */
  roots = new Map<number, { users: Set<string>; maxReply: number }>();

  constructor(conv: Conv) {
    this.conv = conv;
  }

  /** Called before inserting an imported message with time `t`: moves newer local messages out of the way. */
  beforeInsert(t: number) {
    if (this.queue === null) {
      this.queue = all<{ id: number; created_at: number }>('SELECT id, created_at FROM messages WHERE channel_id = ? AND created_at > ? ORDER BY created_at, id', this.conv.localId, t);
    }
    while (this.queue.length && this.queue[0].created_at <= t) this.relocate(this.queue.shift()!.id);
  }

  inserted(id: number, rootId: number | null, userId: string | null, alsoInChannel: boolean) {
    if (!rootId || alsoInChannel) this.importedIds.push(id);
    if (rootId) {
      let r = this.roots.get(rootId);
      if (!r) this.roots.set(rootId, (r = { users: new Set(), maxReply: 0 }));
      if (userId) r.users.add(userId);
      r.maxReply = Math.max(r.maxReply, id);
    }
  }

  relocate(oldId: number) {
    const cols = messageColumns();
    const r = run(`INSERT INTO messages (${cols}) SELECT ${cols} FROM messages WHERE id = ?`, oldId);
    const newId = Number(r.lastInsertRowid);
    for (const ref of messageRefs()) {
      if (ref.table === 'import_map') run("UPDATE import_map SET local_id = ? WHERE kind = 'message' AND local_id = ?", String(newId), String(oldId));
      else run(`UPDATE "${ref.table}" SET "${ref.column}" = ? WHERE "${ref.column}" = ?`, newId, oldId);
    }
    run('DELETE FROM messages WHERE id = ?', oldId);
    this.moved.push([oldId, newId]);
    const root = this.roots.get(oldId);
    if (root) {
      this.roots.delete(oldId);
      this.roots.set(newId, root);
    }
  }

  finish() {
    const cid = this.conv.localId;
    if (this.queue) while (this.queue.length) this.relocate(this.queue.shift()!.id);

    // thread roots: counters + participants follow their (read) threads
    for (const [rootId, info] of this.roots) {
      const stats = get<{ n: number; last: number | null }>('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE thread_root_id = ? AND deleted_at IS NULL', rootId)!;
      const users = all<{ user_id: string }>(
        'SELECT user_id FROM messages WHERE thread_root_id = ? AND deleted_at IS NULL AND user_id IS NOT NULL GROUP BY user_id ORDER BY MAX(id)',
        rootId,
      ).map((u) => u.user_id);
      run('UPDATE messages SET reply_count = ?, last_reply_at = ?, reply_users = ? WHERE id = ?', stats.n, stats.last, JSON.stringify(users.slice(-10)), rootId);
      const rootAuthor = get<{ user_id: string | null }>('SELECT user_id FROM messages WHERE id = ?', rootId)?.user_id;
      if (rootAuthor) info.users.add(rootAuthor);
      for (const uid of info.users) {
        run(
          `INSERT INTO thread_follows (user_id, root_id, last_read, following) VALUES (?, ?, ?, 1)
           ON CONFLICT(user_id, root_id) DO UPDATE SET last_read = MAX(last_read, excluded.last_read)`,
          uid,
          rootId,
          info.maxReply,
        );
      }
    }

    // read positions: moved messages keep their read state, imported history counts as read
    const moved = [...this.moved].sort((a, b) => a[0] - b[0]);
    const prefixMaxNew: number[] = [];
    for (let i = 0, mx = 0; i < moved.length; i++) prefixMaxNew.push((mx = Math.max(mx, moved[i][1])));
    const suffixMinNew: number[] = new Array(moved.length);
    for (let i = moved.length - 1, mn = Infinity; i >= 0; i--) suffixMinNew[i] = mn = Math.min(mn, moved[i][1]);
    const firstAbove = (x: number) => {
      let lo = 0;
      let hi = moved.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (moved[mid][0] <= x) lo = mid + 1;
        else hi = mid;
      }
      return lo; // index of the first moved message with old id > x
    };
    const imported = this.importedIds; // ascending
    const lastImportedBelow = (cap: number) => {
      let lo = 0;
      let hi = imported.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (imported[mid] < cap) lo = mid + 1;
        else hi = mid;
      }
      return lo > 0 ? imported[lo - 1] : 0;
    };
    const reposition = (lastRead: number) => {
      const i = firstAbove(lastRead);
      let lr = i > 0 ? Math.max(lastRead, prefixMaxNew[i - 1]) : lastRead;
      const cap = i < moved.length ? suffixMinNew[i] : Infinity;
      lr = Math.max(lr, lastImportedBelow(cap));
      return lr;
    };
    for (const m of all<{ user_id: string; last_read: number }>('SELECT user_id, last_read FROM channel_members WHERE channel_id = ?', cid)) {
      const lr = reposition(m.last_read);
      if (lr !== m.last_read) run('UPDATE channel_members SET last_read = ? WHERE channel_id = ? AND user_id = ?', lr, cid, m.user_id);
    }
    if (moved.length) {
      const movedNew = new Set(moved.map((x) => x[1]));
      for (const f of all<{ user_id: string; root_id: number; last_read: number }>(
        'SELECT tf.user_id, tf.root_id, tf.last_read FROM thread_follows tf JOIN messages m ON m.id = tf.root_id WHERE m.channel_id = ?',
        cid,
      )) {
        if (!movedNew.has(f.root_id)) continue;
        const i = firstAbove(f.last_read);
        const lr = i > 0 ? Math.max(f.last_read, prefixMaxNew[i - 1]) : f.last_read;
        if (lr !== f.last_read) run('UPDATE thread_follows SET last_read = ? WHERE user_id = ? AND root_id = ?', lr, f.user_id, f.root_id);
      }
    }
    run(
      'UPDATE channels SET last_message_at = (SELECT MAX(created_at) FROM messages WHERE channel_id = ? AND (thread_root_id IS NULL OR also_in_channel = 1) AND deleted_at IS NULL) WHERE id = ?',
      cid,
      cid,
    );
  }
}

/**
 * Runs `fn` in a transaction with the per-row full-text trigger switched off and indexes the new rows in one
 * statement afterwards (~15x faster for big imports). DDL is transactional in SQLite and node:sqlite is synchronous
 * on our single connection, so nothing else can observe the missing trigger; a rollback restores it.
 */
function bulkIndexed<T>(fn: () => T): T {
  return tx(() => {
    const trigger = get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'messages_ai'")?.sql;
    const before = get<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM messages')!.id;
    if (trigger) db.exec('DROP TRIGGER messages_ai');
    const result = fn();
    if (trigger) {
      run('INSERT INTO messages_fts (rowid, text) SELECT id, text FROM messages WHERE id > ?', before);
      db.exec(trigger);
    }
    return result;
  });
}

let columnsCache: string | null = null;
function messageColumns() {
  columnsCache ??= all<{ name: string }>('PRAGMA table_info(messages)')
    .map((c) => c.name)
    .filter((n) => n !== 'id')
    .map((n) => `"${n}"`)
    .join(', ');
  return columnsCache;
}

/** Every column that stores a message id (foreign keys + known plain references). */
function messageRefs() {
  const refs: { table: string; column: string }[] = [
    { table: 'messages', column: 'thread_root_id' },
    { table: 'files', column: 'message_id' },
    { table: 'drafts', column: 'thread_root_id' },
    { table: 'scheduled', column: 'thread_root_id' },
    { table: 'import_map', column: 'local_id' },
  ];
  for (const t of all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'")) {
    for (const fk of all<{ table: string; from: string }>(`PRAGMA foreign_key_list("${t.name}")`)) {
      if (fk.table === 'messages' && !refs.some((r) => r.table === t.name && r.column === fk.from)) refs.push({ table: t.name, column: fk.from });
    }
  }
  return refs;
}

async function runJob(job: SlackImportJob, userId: string, zipPath: string, opts: SlackImportOptions) {
  const imp = new Importer(job, userId, opts);
  try {
    await imp.run(zipPath);
    job.state = 'done';
    job.phase = 'done';
    job.progress = 1;
  } catch (e) {
    console.error('[slack-import] failed', e);
    job.state = 'error';
    job.error = e instanceof Error ? e.message : String(e);
  } finally {
    job.finishedAt = now();
    try {
      imp.zip?.zf.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(zipPath, { force: true });
    toUser(userId).emit('import:progress', { ...job, warnings: [...job.warnings] });
    io.emit('import:done', { jobId: job.id });
  }
}
