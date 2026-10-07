import type { Message } from '../../../shared/types.ts';
import { S, channelTitle, isDmKind, userName } from '../store.ts';
import { toPlainText } from './mrkdwn.tsx';
import { openChannel, openThread } from '../actions.ts';
import { t } from '../i18n.ts';

let audioCtx: AudioContext | null = null;

export function playKnock() {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const t0 = ctx.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + i * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + i * 0.09 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.09 + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + i * 0.09);
      osc.stop(t0 + i * 0.09 + 0.25);
    }
  } catch {
    /* audio not available */
  }
}

export function notificationPermission() {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}

export function mentionsMe(text: string, meId: string) {
  return text.includes(`<@${meId}>`) || /<!(channel|everyone|here)>/.test(text);
}

/** Outside of the working hours set in Preferences → Availability, notifications are paused. */
export function outsideWorkingHours(now = new Date()) {
  const wh = S().me?.prefs.workingHours;
  if (!wh?.enabled) return false;
  const day = now.getDay();
  if (wh.days === 'weekdays' && (day === 0 || day === 6)) return true;
  const mins = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = wh.from.split(':').map(Number);
  const [th, tm] = wh.to.split(':').map(Number);
  return mins < fh * 60 + fm || mins >= th * 60 + tm;
}

export function matchesKeyword(text: string) {
  const kw = S().me?.prefs.keywords;
  if (!kw) return false;
  const plain = toPlainText(text).toLowerCase();
  return kw
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .some((k) => new RegExp(`(^|[^\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(plain));
}

export function maybeNotify(m: Message) {
  const s = S();
  const me = s.me;
  if (!me || m.userId === me.id || (m.subtype && m.subtype !== 'bot')) return;
  if (me.dndUntil && me.dndUntil > Date.now()) return;
  if (outsideWorkingHours()) return;
  const ch = s.channels[m.channelId];
  const mem = s.memberships[m.channelId];
  if (!ch || !mem || mem.muted) return;

  const level = mem.notify !== 'default' ? mem.notify : me.prefs.notifyLevel ?? 'mentions';
  if (level === 'none') return;
  const mentioned = mentionsMe(m.text, me.id) || matchesKeyword(m.text);
  let isThreadForMe = false;
  if (m.threadRootId && me.prefs.notifyThreads !== false) {
    const root = s.msgs[m.threadRootId];
    isThreadForMe = !!root && (root.userId === me.id || root.replyUserIds.includes(me.id));
  }
  const relevant = level === 'all' || isDmKind(ch) || mentioned || isThreadForMe;
  if (!relevant) return;

  // already looking at it
  const viewing =
    s.focused &&
    ((m.threadRootId && !m.alsoInChannel && s.right?.type === 'thread' && s.right.rootId === m.threadRootId) ||
      ((!m.threadRootId || m.alsoInChannel) && s.activeChannelId === m.channelId));
  if (viewing) return;

  if (me.prefs.notifySound !== false) playKnock();
  if (notificationPermission() !== 'granted') return;

  const author = m.botName ?? userName(m.userId);
  const title = isDmKind(ch) ? author : `${author} (#${channelTitle(ch)})`;
  const body = me.prefs.showMessagePreviews === false ? t('New message') : toPlainText(m.text) || (m.files.length ? t('Shared a file') : '');
  try {
    const n = new Notification(m.threadRootId ? `${title} ${t('in a thread')}` : title, { body: body.slice(0, 200), tag: `msg-${m.id}`, silent: true });
    n.onclick = () => {
      window.focus();
      if (m.threadRootId && !m.alsoInChannel) {
        openChannel(m.channelId);
        openThread(m.threadRootId, m.channelId);
      } else openChannel(m.channelId, m.id);
      n.close();
    };
  } catch {
    /* ignore */
  }
}

/** Updates the document title / favicon badge with the unread state. */
export function updateTitleBadge() {
  const s = S();
  let mentions = 0;
  let unread = false;
  for (const m of Object.values(s.memberships)) {
    const ch = s.channels[m.channelId];
    if (!ch || m.muted || m.hidden) continue;
    if (isDmKind(ch)) mentions += m.unread;
    else mentions += m.mentions;
    if (m.unread > 0) unread = true;
  }
  const active = s.activeChannelId ? s.channels[s.activeChannelId] : undefined;
  const base = active ? `${isDmKind(active) ? '' : '#'}${channelTitle(active)} - ${s.workspace?.name ?? 'Relay'}` : s.workspace?.name ?? 'Relay';
  document.title = `${mentions ? `(${mentions}) ` : unread ? '* ' : ''}${base}`;
  // Electron / mobile shells can listen for this
  (window as any).relayDesktop?.setBadge?.(mentions || (unread ? '•' : ''));
}
