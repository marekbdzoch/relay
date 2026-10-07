import { useCallback, useEffect, useState } from 'react';
import { AtSign, MessageCircle, SmilePlus, UserPlus, CheckCheck, AlarmClock, MessagesSquare } from '../components/icons.tsx';
import { useNavigate } from 'react-router-dom';
import type { ActivityItem } from '../../../shared/types.ts';
import { GET, PUT } from '../api.ts';
import { channelTitle, isDmKind, set, useStore, userName, upsertMessages } from '../store.ts';
import { t } from '../i18n.ts';
import { fail, refreshCounts } from '../actions.ts';
import { socket } from '../socket.ts';
import { Emoji, toPlainText } from '../lib/mrkdwn.tsx';
import { formatDay, formatShortDate, startOfDay } from '../lib/format.ts';
import { Avatar, Spinner } from '../components/ui.tsx';

type Filter = 'all' | 'dms' | 'mentions' | 'threads' | 'reactions' | 'reminders';

const KIND_ICON: Record<ActivityItem['kind'], React.ReactNode> = {
  mention: <AtSign size={11} />,
  thread_reply: <MessageCircle size={11} />,
  reaction: <SmilePlus size={11} />,
  channel_invite: <UserPlus size={11} />,
  reminder: <AlarmClock size={11} />,
  dm: <MessagesSquare size={11} />,
};

function ActivityRow({ a, active, onOpen }: { a: ActivityItem; active: boolean; onOpen: () => void }) {
  const channel = useStore((s) => s.channels[a.channelId]);
  const where = channel ? (isDmKind(channel) ? t('Direct message') : `#${channel.name}`) : '';
  const actor = a.kind === 'reminder' ? t('Reminder') : userName(a.actorId);
  const dm = isDmKind(channel);
  const labels: Record<ActivityItem['kind'], string> = {
    mention: dm ? t('Mention in a direct message') : t('Mention in {where}', { where }),
    thread_reply: dm ? t('Thread in a direct message') : t('Thread in {where}', { where }),
    reaction: dm ? t('Reacted in a direct message') : t('Reacted in {where}', { where }),
    channel_invite: t('Invitation to {where}', { where }),
    reminder: dm ? t('Reminder: direct message') : t('Reminder: message in {where}', { where }),
    dm: channel?.kind === 'group' ? channelTitle(channel) : t('Direct message'),
  };
  const text = a.message ? toPlainText(a.message.text).slice(0, 200) || (a.message.files.length ? t('Shared a file') : '') : '';
  return (
    <button className={`activity-card${active ? ' active' : ''}${a.read ? '' : ' unread'}`} onClick={onOpen}>
      <span className="activity-avatar">
        {a.kind === 'reminder' ? (
          <span className="activity-reminder-icon">
            <AlarmClock size={18} />
          </span>
        ) : (
          <Avatar userId={a.actorId} size={36} />
        )}
        <span className={`activity-kind kind-${a.kind}`}>{KIND_ICON[a.kind]}</span>
      </span>
      <span className="activity-main">
        <span className="activity-top">
          <b className="activity-actor">{actor}</b>
          <span className="activity-time">{formatShortDate(a.createdAt)}</span>
        </span>
        <span className="activity-label">{labels[a.kind]}</span>
        <span className="activity-text">
          {a.kind === 'reaction' ? (
            <>
              {a.emoji && <Emoji code={a.emoji} size={14} />} {t('You')}: {text}
            </>
          ) : a.kind === 'channel_invite' ? (
            t('invited you to {where}', { where })
          ) : (
            text
          )}
        </span>
      </span>
      {!a.read && <span className="activity-dot" />}
    </button>
  );
}

export function ActivityList({ activeKey }: { activeKey?: string }) {
  const nav = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const load = useCallback(
    async (before?: number) => {
      try {
        const f = onlyUnread && filter === 'all' ? 'unread' : filter;
        let list = await GET<ActivityItem[]>(`/api/activity?filter=${f}${before ? `&before=${before}` : ''}`);
        if (onlyUnread) list = list.filter((a) => !a.read);
        set((s) => upsertMessages(s, list.map((a) => a.message).filter((m): m is NonNullable<typeof m> => !!m)));
        setItems((prev) => (before && prev ? [...prev, ...list] : list));
        setHasMore(list.length >= 40);
      } catch (e) {
        fail(e);
      }
    },
    [filter, onlyUnread],
  );

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  useEffect(() => {
    const onNew = () => void load();
    socket?.on('activity:new', onNew);
    return () => {
      socket?.off('activity:new', onNew);
    };
  }, [load]);

  const open = (a: ActivityItem) => {
    if (!a.read) {
      setItems((list) => list?.map((x) => (x.id === a.id ? { ...x, read: true } : x)) ?? null);
      if (a.id > 0) void PUT('/api/activity/read', { ids: [a.id] }).then(() => refreshCounts());
    }
    const m = a.message;
    if (!m) return nav(`/activity/${a.channelId}`);
    if (m.threadRootId && !m.alsoInChannel) nav(`/activity/${a.channelId}/${m.id}?thread=${m.threadRootId}`);
    else nav(`/activity/${a.channelId}/${m.id}`);
  };

  const markAll = async () => {
    try {
      await PUT('/api/activity/read', { all: true });
      setItems((list) => list?.map((x) => ({ ...x, read: true })) ?? null);
      void refreshCounts();
    } catch (e) {
      fail(e);
    }
  };

  const tabs: [Filter, string, React.ReactNode][] = [
    ['all', t('All'), null],
    ['dms', t('DMs'), <MessagesSquare size={13} />],
    ['mentions', t('Mentions'), <AtSign size={13} />],
    ['threads', t('Threads'), <MessageCircle size={13} />],
    ['reactions', t('Reactions'), <SmilePlus size={13} />],
    ['reminders', t('Reminders'), <AlarmClock size={13} />],
  ];

  const rows: React.ReactNode[] = [];
  let lastDay = 0;
  for (const a of items ?? []) {
    const day = startOfDay(a.createdAt);
    if (day !== lastDay) {
      rows.push(
        <div key={`d${day}`} className="activity-day">
          <span>{formatDay(a.createdAt)}</span>
        </div>,
      );
      lastDay = day;
    }
    rows.push(<ActivityRow key={a.id} a={a} active={activeKey === `${a.channelId}/${a.message?.id ?? ''}`} onOpen={() => open(a)} />);
  }

  return (
    <div className="pane">
      <div className="pane-head">
        <span className="pane-title">{t('Activity')}</span>
        <label className="unread-toggle">
          <span>{t('Unreads')}</span>
          <input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} />
          <span className="mini-toggle" />
        </label>
        <button className="sidebar-compose" onClick={() => void markAll()} title={t('Mark all as read')}>
          <CheckCheck size={18} />
        </button>
      </div>
      <div className="pane-tabs">
        {tabs.map(([k, label, icon]) => (
          <button key={k} className={`pane-tab${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)}>
            {icon}
            {label}
          </button>
        ))}
      </div>
      <div
        className="sidebar-scroll activity-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (hasMore && items?.length && el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
            setHasMore(false);
            void load(items[items.length - 1].createdAt);
          }
        }}
      >
        {!items ? (
          <div className="center-fill">
            <Spinner />
          </div>
        ) : items.length ? (
          rows
        ) : (
          <div className="pane-empty">{onlyUnread ? t('You’re all caught up.') : t('Nothing here yet. Mentions, reactions and thread replies will show up here.')}</div>
        )}
      </div>
    </div>
  );
}
