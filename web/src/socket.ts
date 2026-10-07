import { io, type Socket } from 'socket.io-client';
import type { Channel, ClientEvents, ServerEvents } from '../../shared/types.ts';
import { GET, SERVER, getToken } from './api.ts';
import { S, draftKey, set } from './store.ts';
import {
  applyMePrefs,
  receiveMessage,
  refreshCounts,
  removeMessageLocal,
  reloadAfterImport,
  resync,
  upsertChannel,
  upsertMembership,
} from './actions.ts';
import { maybeNotify, updateTitleBadge } from './lib/notify.ts';
import { huddleSignal, huddleStateChanged, huddleEnded, rejoinHuddle } from './lib/huddle.ts';

export let socket: Socket<ServerEvents, ClientEvents> | null = null;

export function connectSocket() {
  if (socket) return socket;
  const token = getToken();
  const s: Socket<ServerEvents, ClientEvents> = io(SERVER || undefined, {
    path: '/socket.io',
    withCredentials: true,
    auth: token ? { token } : undefined,
    transports: ['websocket', 'polling'],
  });
  socket = s;
  let connectedOnce = false;

  s.on('connect', () => {
    set((st) => void (st.connected = true));
    if (connectedOnce) {
      void resync();
      rejoinHuddle();
    }
    connectedOnce = true;
  });
  s.on('disconnect', () => set((st) => void (st.connected = false)));
  s.on('connect_error', (err) => {
    set((st) => void (st.connected = false));
    if (err.message === 'not_authenticated') location.href = '/login';
  });

  s.on('message:new', (m) => {
    receiveMessage(m);
    maybeNotify(m);
    // the author stops typing once the message arrives
    if (m.userId) {
      set((st) => {
        // the composer reports typing under the thread it is in, also for "send to channel" replies
        const key = draftKey(m.channelId, m.threadRootId);
        if (st.typing[key]) delete st.typing[key][m.userId!];
      });
    }
  });
  s.on('message:updated', (m) => {
    set((st) => {
      const prev = st.msgs[m.id];
      if (prev || st.chan[m.channelId]?.loaded) st.msgs[m.id] = m;
    });
  });
  s.on('message:deleted', (p) => removeMessageLocal(p));

  s.on('channel:upsert', (c) => {
    const st = S();
    // public channels are broadcast to everyone; keep only those we know or are in
    if (c.kind === 'public' && !st.channels[c.id] && !st.memberships[c.id]) return;
    upsertChannel(c);
  });
  s.on('channel:removed', ({ channelId }) => {
    set((st) => {
      delete st.memberships[channelId];
      const ch = st.channels[channelId];
      if (!ch || ch.kind !== 'public') delete st.channels[channelId];
      if (st.activeChannelId === channelId) st.activeChannelId = null;
    });
    if (location.pathname.startsWith(`/c/${channelId}`)) history.replaceState(null, '', '/'), window.dispatchEvent(new PopStateEvent('popstate'));
    updateTitleBadge();
  });
  s.on('membership:upsert', (m) => {
    upsertMembership(m);
    // added to a public channel we never heard of (its broadcast arrived before we were a member): fetch it
    if (!S().channels[m.channelId]) {
      GET<{ channel: Channel }>(`/api/channels/${m.channelId}`)
        .then((r) => upsertChannel(r.channel))
        .catch(() => {});
    }
  });

  s.on('user:upsert', (u) => set((st) => void (st.users[u.id] = u)));
  s.on('me:updated', (me) => {
    set((st) => {
      st.me = me;
      st.users[me.id] = { ...st.users[me.id], ...me };
    });
    applyMePrefs(me);
  });
  s.on('presence', ({ userId, presence }) => set((st) => void (st.presence[userId] = presence)));
  s.on('typing', ({ channelId, threadRootId, userId }) => {
    set((st) => {
      const key = draftKey(channelId, threadRootId);
      st.typing[key] ??= {};
      st.typing[key][userId] = Date.now() + 6000;
    });
  });

  s.on('saved:changed', ({ messageId, saved }) =>
    set((st) => {
      if (saved) st.saved[messageId] = true;
      else delete st.saved[messageId];
    }),
  );
  s.on('draft:changed', (d) =>
    set((st) => {
      const key = draftKey(d.channelId, d.threadRootId);
      if (d.deleted) delete st.drafts[key];
      else st.drafts[key] = d;
    }),
  );
  s.on('activity:new', () => {
    set((st) => void (st.activityUnread += 1));
    void refreshCounts();
  });
  s.on('thread:read', ({ rootId, lastRead }) => {
    set((st) => {
      if (st.threads[rootId]) st.threads[rootId].lastRead = Math.max(st.threads[rootId].lastRead, lastRead);
    });
    void refreshCounts();
  });
  s.on('emoji:changed', (list) =>
    set((st) => {
      st.customEmojiList = list;
      st.customEmoji = Object.fromEntries(list.map((e) => [e.name, e.url]));
    }),
  );
  s.on('workspace:updated', (w) => set((st) => void (st.workspace = w)));

  s.on('huddle:state', (h) => {
    set((st) => void (st.huddles[h.channelId] = h));
    huddleStateChanged(h);
  });
  s.on('huddle:ended', ({ channelId }) => {
    set((st) => void delete st.huddles[channelId]);
    huddleEnded(channelId);
  });
  s.on('huddle:signal', (p) => huddleSignal(p));
  s.on('agent:upsert', (a) => set((st) => void (st.agents[a.userId] = a)));
  s.on('agent:removed', ({ userId }) => set((st) => void delete st.agents[userId]));
  s.on('import:done', ({ jobId }) => void reloadAfterImport(jobId));
  s.on('session:revoked', () => {
    location.href = '/login';
  });

  return s;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

export function emitTyping(channelId: string, threadRootId: number | null) {
  socket?.emit('typing', { channelId, threadRootId });
}
