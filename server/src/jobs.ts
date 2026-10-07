import { all, get, run } from './db.ts';
import { getMe, getUserRow, serializeUser } from './model.ts';
import { postMessage, recordActivity } from './services.ts';
import { io, setHuddleHooks, toUser } from './realtime.ts';
import { json, now } from './lib/util.ts';

function emitUser(id: string) {
  const row = getUserRow(id);
  if (!row) return;
  io.emit('user:upsert', serializeUser(row));
  toUser(id).emit('me:updated', getMe(id));
}

export function sendScheduled() {
  const due = all<{ id: string; user_id: string; channel_id: string; thread_root_id: number | null; text: string }>('SELECT * FROM scheduled WHERE send_at <= ?', now());
  for (const s of due) {
    run('DELETE FROM scheduled WHERE id = ?', s.id);
    const member = get('SELECT 1 FROM channel_members cm JOIN channels c ON c.id = cm.channel_id WHERE cm.channel_id = ? AND cm.user_id = ? AND c.archived = 0', s.channel_id, s.user_id);
    if (!member) continue;
    try {
      postMessage({ channelId: s.channel_id, userId: s.user_id, text: s.text, threadRootId: s.thread_root_id });
    } catch (e) {
      console.error('scheduled message failed', e);
    }
  }
}

export function sendReminders() {
  const due = all<{ user_id: string; message_id: number; channel_id: string }>(
    `SELECT s.user_id, s.message_id, m.channel_id FROM saved s JOIN messages m ON m.id = s.message_id
     WHERE s.remind_at IS NOT NULL AND s.remind_at <= ? AND s.reminded = 0 AND m.deleted_at IS NULL`,
    now(),
  );
  for (const r of due) {
    run('UPDATE saved SET reminded = 1 WHERE user_id = ? AND message_id = ?', r.user_id, r.message_id);
    recordActivity({ userId: r.user_id, kind: 'reminder', actorId: null, channelId: r.channel_id, messageId: r.message_id });
  }
}

export function expireStatuses() {
  const t = now();
  for (const r of all<{ id: string }>('SELECT id FROM users WHERE status_expires_at IS NOT NULL AND status_expires_at <= ?', t)) {
    run("UPDATE users SET status_emoji = '', status_text = '', status_expires_at = NULL WHERE id = ?", r.id);
    emitUser(r.id);
  }
  for (const r of all<{ id: string }>('SELECT id FROM users WHERE dnd_until IS NOT NULL AND dnd_until <= ?', t)) {
    run('UPDATE users SET dnd_until = NULL WHERE id = ?', r.id);
    emitUser(r.id);
  }
}

export function cleanup() {
  run('DELETE FROM activity WHERE read = 1 AND created_at < ?', now() - 90 * 86400_000);
  run('DELETE FROM sessions WHERE last_seen_at < ?', now() - 90 * 86400_000);
  // huddles that were never closed (server restart)
  run('UPDATE huddle_sessions SET ended_at = started_at WHERE ended_at IS NULL AND started_at < ?', now() - 24 * 3600_000);
}

// ----- huddles: history + automatic "In a huddle" status -----

const HUDDLE_STATUS = { emoji: 'headphones', text: 'In a huddle' };

function setHuddleStatus(userId: string, on: boolean) {
  const u = getUserRow(userId);
  if (!u) return;
  const prefs = json<Record<string, unknown>>(u.prefs, {});
  if (on) {
    if (u.status_emoji || u.status_text) return; // never override a custom status
    run('UPDATE users SET status_emoji = ?, status_text = ?, status_expires_at = NULL WHERE id = ?', HUDDLE_STATUS.emoji, HUDDLE_STATUS.text, userId);
    prefs.autoHuddleStatus = true;
  } else {
    if (!prefs.autoHuddleStatus) return;
    if (u.status_emoji === HUDDLE_STATUS.emoji && u.status_text === HUDDLE_STATUS.text) {
      run("UPDATE users SET status_emoji = '', status_text = '' WHERE id = ?", userId);
    }
    delete prefs.autoHuddleStatus;
  }
  run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify(prefs), userId);
  emitUser(userId);
}

function openSession(channelId: string) {
  return get<{ id: number; participants: string }>('SELECT id, participants FROM huddle_sessions WHERE channel_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', channelId);
}

export function startJobs() {
  run('UPDATE huddle_sessions SET ended_at = ? WHERE ended_at IS NULL', now());
  // nobody is in a huddle right after a restart
  run("UPDATE users SET status_emoji = '', status_text = '' WHERE status_emoji = ? AND status_text = ? AND prefs LIKE '%autoHuddleStatus%'", HUDDLE_STATUS.emoji, HUDDLE_STATUS.text);
  setHuddleHooks({
    started(channelId, userId) {
      run('INSERT INTO huddle_sessions (channel_id, started_by, started_at, participants) VALUES (?, ?, ?, ?)', channelId, userId, now(), '[]');
      // channels have a permanent voice room (people just drop in and out), so only DM calls get a "huddle started" message
      const kind = get<{ kind: string }>('SELECT kind FROM channels WHERE id = ?', channelId)?.kind;
      if (kind !== 'dm' && kind !== 'group') return;
      try {
        postMessage({ channelId, userId, text: '', subtype: 'huddle' });
      } catch {
        /* ignore */
      }
    },
    joined(channelId, userId) {
      const s = openSession(channelId);
      if (s) {
        const list = json<string[]>(s.participants, []);
        if (!list.includes(userId)) run('UPDATE huddle_sessions SET participants = ? WHERE id = ?', JSON.stringify([...list, userId]), s.id);
      }
      setHuddleStatus(userId, true);
    },
    left(_channelId, userId) {
      setHuddleStatus(userId, false);
    },
    ended(channelId) {
      run('UPDATE huddle_sessions SET ended_at = ? WHERE channel_id = ? AND ended_at IS NULL', now(), channelId);
    },
  });
  setInterval(sendScheduled, 10_000).unref();
  setInterval(sendReminders, 15_000).unref();
  setInterval(expireStatuses, 30_000).unref();
  setInterval(cleanup, 6 * 3600_000).unref();
  sendScheduled();
  sendReminders();
  expireStatuses();
}
