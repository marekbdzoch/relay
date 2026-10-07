import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from './config.ts';

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

// Each entry is applied once, in order. Never edit an applied migration – append a new one.
const migrations: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE workspace (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    icon_path TEXT,
    allowed_domains TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    timezone TEXT NOT NULL DEFAULT '',
    avatar_path TEXT,
    avatar_color TEXT NOT NULL DEFAULT '#4a154b',
    role TEXT NOT NULL DEFAULT 'member',
    status_emoji TEXT NOT NULL DEFAULT '',
    status_text TEXT NOT NULL DEFAULT '',
    status_expires_at INTEGER,
    dnd_until INTEGER,
    away_manual INTEGER NOT NULL DEFAULT 0,
    prefs TEXT NOT NULL DEFAULT '{}',
    deactivated INTEGER NOT NULL DEFAULT 0,
    is_bot INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    dm_key TEXT UNIQUE,
    last_message_at INTEGER
  );
  CREATE UNIQUE INDEX channels_name ON channels(name) WHERE kind IN ('public', 'private');

  CREATE TABLE channel_members (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    last_read INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    muted INTEGER NOT NULL DEFAULT 0,
    notify TEXT NOT NULL DEFAULT 'default',
    hidden INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE INDEX channel_members_user ON channel_members(user_id);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT,
    text TEXT NOT NULL DEFAULT '',
    subtype TEXT,
    thread_root_id INTEGER,
    reply_count INTEGER NOT NULL DEFAULT 0,
    last_reply_at INTEGER,
    reply_users TEXT NOT NULL DEFAULT '[]',
    also_in_channel INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER
  );
  CREATE INDEX messages_channel ON messages(channel_id, id);
  CREATE INDEX messages_thread ON messages(thread_root_id, id);
  CREATE INDEX messages_user ON messages(user_id, id);

  CREATE VIRTUAL TABLE messages_fts USING fts5(
    text, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
  END;

  CREATE TABLE reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );

  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    channel_id TEXT,
    message_id INTEGER,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX files_message ON files(message_id);
  CREATE INDEX files_channel ON files(channel_id, created_at);
  CREATE VIRTUAL TABLE files_fts USING fts5(name, content='files', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
    INSERT INTO files_fts(rowid, name) VALUES (new.rowid, new.name);
  END;
  CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
  END;

  CREATE TABLE pins (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    pinned_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX pins_channel ON pins(channel_id);

  CREATE TABLE saved (
    user_id TEXT NOT NULL,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, message_id)
  );

  CREATE TABLE thread_follows (
    user_id TEXT NOT NULL,
    root_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    last_read INTEGER NOT NULL DEFAULT 0,
    following INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, root_id)
  );
  CREATE INDEX thread_follows_root ON thread_follows(root_id);

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    actor_id TEXT,
    channel_id TEXT NOT NULL,
    emoji TEXT,
    created_at INTEGER NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX activity_user ON activity(user_id, id);

  CREATE TABLE drafts (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_root_id INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id, thread_root_id)
  );

  CREATE TABLE scheduled (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_root_id INTEGER,
    text TEXT NOT NULL,
    send_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX scheduled_time ON scheduled(send_at);

  CREATE TABLE invites (
    code TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'member',
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE custom_emoji (
    name TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    mime TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  /* 2: Slack bridge */ `
  ALTER TABLE users ADD COLUMN external TEXT;
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE slack_links (
    relay_channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    slack_channel_id TEXT NOT NULL UNIQUE,
    slack_channel_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE slack_users (
    slack_user_id TEXT PRIMARY KEY,
    relay_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE slack_messages (
    relay_message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    slack_channel_id TEXT NOT NULL,
    slack_ts TEXT NOT NULL,
    UNIQUE (slack_channel_id, slack_ts)
  );
  `,
  /* 3: reminders, huddle history, AI agents */ `
  ALTER TABLE saved ADD COLUMN remind_at INTEGER;
  ALTER TABLE saved ADD COLUMN reminded INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX saved_remind ON saved(remind_at) WHERE remind_at IS NOT NULL AND reminded = 0;
  CREATE TABLE huddle_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    started_by TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    participants TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX huddle_sessions_channel ON huddle_sessions(channel_id, started_at);
  CREATE TABLE agents (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  /* 4: agent options */ `
  ALTER TABLE agents ADD COLUMN web_search INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE agents ADD COLUMN avatar_emoji TEXT NOT NULL DEFAULT '';
  ALTER TABLE agents ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'mentions';
  `,
  /* 5: workspace import (Slack export) – placeholder accounts + external id mapping */ `
  ALTER TABLE users ADD COLUMN imported INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE import_map (
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    external_id TEXT NOT NULL,
    local_id TEXT NOT NULL,
    PRIMARY KEY (source, kind, external_id)
  ) WITHOUT ROWID;
  CREATE INDEX import_map_local ON import_map(kind, local_id);
  `,
];

export function getSetting(key: string): string | null {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}
export function setSetting(key: string, value: string | null) {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < migrations.length) {
    tx(() => {
      db.exec(migrations[version]);
      version++;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
    });
  }
}

type Params = SQLInputValue[];

export function get<T = Record<string, any>>(sql: string, ...params: Params): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T = Record<string, any>>(sql: string, ...params: Params): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: Params) {
  return db.prepare(sql).run(...params);
}

let txDepth = 0;
export function tx<T>(fn: () => T): T {
  if (txDepth > 0) return fn();
  txDepth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth--;
  }
}

/** Builds "?, ?, ?" for IN clauses. */
export function placeholders(n: number) {
  return Array.from({ length: n }, () => '?').join(', ');
}

migrate();
