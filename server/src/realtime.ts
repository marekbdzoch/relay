import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { ClientEvents, HuddleState, Presence, ServerEvents } from '../../shared/types.ts';
import { userFromToken, SESSION_COOKIE } from './lib/auth.ts';
import { all, get } from './db.ts';
import { config } from './config.ts';

type IO = Server<ClientEvents, ServerEvents>;
type Sock = Socket<ClientEvents, ServerEvents, Record<string, never>, { userId: string; sessionHash: string }>;

export let io: IO;

// userId -> number of connected sockets
const connections = new Map<string, number>();
// channelId -> huddle
const huddles = new Map<string, HuddleState>();
// userId -> channelId of the huddle they are in
const userHuddle = new Map<string, string>();

const userRoom = (id: string) => `user:${id}`;
const channelRoom = (id: string) => `channel:${id}`;

function parseCookie(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    // a malformed value must not throw: it would escape the socket.io middleware and crash the process
    try {
      return decodeURIComponent(v.join('='));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function presenceOf(userId: string): Presence {
  if (!connections.get(userId)) return 'away';
  const row = get<{ away_manual: number }>('SELECT away_manual FROM users WHERE id = ?', userId);
  return row?.away_manual ? 'away' : 'active';
}

export function allPresence(): Record<string, Presence> {
  const out: Record<string, Presence> = {};
  for (const [id, n] of connections) if (n > 0) out[id] = presenceOf(id);
  return out;
}

export function broadcastPresence(userId: string) {
  io.emit('presence', { userId, presence: presenceOf(userId) });
}

export function listHuddles() {
  return [...huddles.values()];
}

export function initRealtime(server: HttpServer) {
  io = new Server<ClientEvents, ServerEvents>(server, {
    path: '/socket.io',
    cors: config.corsOrigins.length ? { origin: config.corsOrigins, credentials: true } : undefined,
    maxHttpBufferSize: 1e6,
  });

  io.use((socket, next) => {
    const token = (socket.handshake.auth?.token as string | undefined) ?? parseCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
    const user = userFromToken(token);
    if (!user) return next(new Error('not_authenticated'));
    socket.data.userId = user.id;
    socket.data.sessionHash = user.sessionHash;
    next();
  });

  io.on('connection', (socket: Sock) => {
    const userId = socket.data.userId;
    socket.join(userRoom(userId));
    socket.join(`session:${socket.data.sessionHash}`);
    for (const r of all<{ channel_id: string }>('SELECT channel_id FROM channel_members WHERE user_id = ?', userId)) {
      socket.join(channelRoom(r.channel_id));
    }
    const before = connections.get(userId) ?? 0;
    connections.set(userId, before + 1);
    if (before === 0) broadcastPresence(userId);

    socket.on('typing', (p) => {
      if (!p || typeof p.channelId !== 'string') return;
      if (!socket.rooms.has(channelRoom(p.channelId))) return;
      socket.to(channelRoom(p.channelId)).emit('typing', { channelId: p.channelId, threadRootId: p.threadRootId ?? null, userId });
    });

    socket.on('presence:active', () => broadcastPresence(userId));

    // ----- huddles (WebRTC mesh signalling) -----
    socket.on('huddle:join', (p, ack) => {
      const channelId = p?.channelId;
      if (!channelId || !socket.rooms.has(channelRoom(channelId))) return ack?.({ ok: false, error: 'not_in_channel' });
      const current = userHuddle.get(userId);
      if (current && current !== channelId) leaveHuddle(userId, current);
      let h = huddles.get(channelId);
      const isNew = !h;
      if (!h) {
        h = { channelId, participants: [], startedAt: Date.now() };
        huddles.set(channelId, h);
      }
      if (!h.participants.some((x) => x.userId === userId)) h.participants.push({ userId, muted: false, sharing: false, video: false });
      userHuddle.set(userId, channelId);
      socket.join(`huddle:${channelId}`);
      io.to(channelRoom(channelId)).emit('huddle:state', h);
      if (isNew) huddleHooks.started?.(channelId, userId);
      huddleHooks.joined?.(channelId, userId);
      ack?.({ ok: true });
    });

    socket.on('huddle:leave', (p) => {
      if (p?.channelId) leaveHuddle(userId, p.channelId);
      socket.leave(`huddle:${p?.channelId}`);
    });

    socket.on('huddle:media', (p) => {
      const h = p?.channelId ? huddles.get(p.channelId) : undefined;
      const me = h?.participants.find((x) => x.userId === userId);
      if (!h || !me) return;
      me.muted = !!p.muted;
      me.sharing = !!p.sharing;
      me.video = !!p.video;
      io.to(channelRoom(h.channelId)).emit('huddle:state', h);
    });

    socket.on('huddle:signal', (p) => {
      if (!p?.to || !p.channelId) return;
      const h = huddles.get(p.channelId);
      if (!h?.participants.some((x) => x.userId === userId)) return;
      io.to(userRoom(p.to)).emit('huddle:signal', { from: userId, channelId: p.channelId, data: p.data });
    });

    socket.on('disconnect', () => {
      const n = (connections.get(userId) ?? 1) - 1;
      if (n <= 0) {
        connections.delete(userId);
        broadcastPresence(userId);
        const hc = userHuddle.get(userId);
        if (hc) leaveHuddle(userId, hc);
      } else {
        connections.set(userId, n);
      }
    });
  });

  return io;
}

interface HuddleHooks {
  started?: (channelId: string, userId: string) => void;
  joined?: (channelId: string, userId: string) => void;
  left?: (channelId: string, userId: string) => void;
  ended?: (channelId: string) => void;
}
const huddleHooks: HuddleHooks = {};
export function setHuddleHooks(h: HuddleHooks) {
  Object.assign(huddleHooks, h);
}

export function huddleOf(userId: string) {
  return userHuddle.get(userId) ?? null;
}

function leaveHuddle(userId: string, channelId: string) {
  const h = huddles.get(channelId);
  if (userHuddle.get(userId) === channelId) userHuddle.delete(userId);
  if (!h) return;
  const was = h.participants.length;
  h.participants = h.participants.filter((p) => p.userId !== userId);
  if (was !== h.participants.length) huddleHooks.left?.(channelId, userId);
  if (h.participants.length === 0) {
    huddles.delete(channelId);
    io.to(channelRoom(channelId)).emit('huddle:ended', { channelId });
    huddleHooks.ended?.(channelId);
  } else {
    io.to(channelRoom(channelId)).emit('huddle:state', h);
  }
}

// ----- emit helpers -----

export const toUser = (userId: string) => io.to(userRoom(userId));
export const toChannel = (channelId: string) => io.to(channelRoom(channelId));

/** Subscribe/unsubscribe all sockets of a user to a channel room (on join/leave). */
export function joinChannelRoom(userId: string, channelId: string) {
  io.in(userRoom(userId)).socketsJoin(channelRoom(channelId));
}
export function leaveChannelRoom(userId: string, channelId: string) {
  io.in(userRoom(userId)).socketsLeave(channelRoom(channelId));
  const hc = userHuddle.get(userId);
  if (hc === channelId) leaveHuddle(userId, channelId);
}

export function disconnectSession(sessionHash: string) {
  io.to(`session:${sessionHash}`).emit('session:revoked');
  io.in(`session:${sessionHash}`).disconnectSockets(true);
}

export function disconnectUser(userId: string) {
  io.to(userRoom(userId)).emit('session:revoked');
  io.in(userRoom(userId)).disconnectSockets(true);
}

export function isOnline(userId: string) {
  return (connections.get(userId) ?? 0) > 0;
}
