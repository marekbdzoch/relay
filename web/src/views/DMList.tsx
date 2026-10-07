import { useEffect, useMemo, useState } from 'react';
import { SquarePen, Search } from '../components/icons.tsx';
import { useNavigate } from 'react-router-dom';
import type { Channel, Message } from '../../../shared/types.ts';
import { channelTitle, dmPartner, isDmKind, useStore, userName } from '../store.ts';
import { t } from '../i18n.ts';
import { openModal } from '../actions.ts';
import { GET } from '../api.ts';
import { socket } from '../socket.ts';
import { toPlainText } from '../lib/mrkdwn.tsx';
import { formatShortDate } from '../lib/format.ts';
import { Avatar, UserPresenceDot } from '../components/ui.tsx';

function DMRow({ channel, active, preview }: { channel: Channel; active: boolean; preview?: Message }) {
  const nav = useNavigate();
  const meId = useStore((s) => s.me?.id);
  const membership = useStore((s) => s.memberships[channel.id]);
  const loadedLast = useStore((s): Message | undefined => {
    const ids = s.chan[channel.id]?.ids;
    if (!ids?.length) return undefined;
    for (let i = ids.length - 1; i >= 0; i--) {
      const m = s.msgs[ids[i]];
      if (m && !m.subtype) return m;
    }
    return undefined;
  });
  const lastMsg = loadedLast && (!preview || loadedLast.id >= preview.id) ? loadedLast : preview;
  const partner = dmPartner(channel);
  const title = useStore(() => channelTitle(channel, meId));
  const unread = (membership?.unread ?? 0) > 0;

  return (
    <button className={`dm-row${active ? ' active' : ''}${unread ? ' unread' : ''}`} onClick={() => nav(`/dms/${channel.id}`)}>
      <span className="dm-row-avatar">
        {channel.kind === 'dm' && partner ? (
          <>
            <Avatar userId={partner} size={36} />
            <UserPresenceDot userId={partner} />
          </>
        ) : (
          <span className="dm-group-avatars">
            {(channel.memberIds ?? [])
              .filter((id) => id !== meId)
              .slice(0, 2)
              .map((id) => (
                <Avatar key={id} userId={id} size={24} />
              ))}
          </span>
        )}
      </span>
      <span className="dm-row-main">
        <span className="dm-row-top">
          <span className="dm-row-name">
            {title}
            {partner === meId && channel.kind === 'dm' && <span className="sb-you"> {t('you')}</span>}
          </span>
          <span className="dm-row-time">{channel.lastMessageAt ? formatShortDate(channel.lastMessageAt) : ''}</span>
        </span>
        <span className="dm-row-preview">
          {lastMsg ? (
            <>
              {lastMsg.userId === meId ? `${t('You')}: ` : channel.kind === 'group' ? `${userName(lastMsg.userId)}: ` : ''}
              {toPlainText(lastMsg.text) || (lastMsg.files.length ? t('Shared a file') : '')}
            </>
          ) : (
            ''
          )}
        </span>
      </span>
      {unread && <span className="dm-row-badge">{membership!.unread}</span>}
    </button>
  );
}

export function DMList({ activeId }: { activeId?: string }) {
  const channels = useStore((s) => s.channels);
  const memberships = useStore((s) => s.memberships);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [q, setQ] = useState('');
  const meId = useStore((s) => s.me?.id);
  const [latest, setLatest] = useState<Record<string, Message>>({});
  useEffect(() => {
    GET<Message[]>('/api/dms/latest')
      .then((l) => setLatest(Object.fromEntries(l.map((m) => [m.channelId, m]))))
      .catch(() => {});
    const onNew = (m: Message) => {
      if (!m.subtype && (!m.threadRootId || m.alsoInChannel)) setLatest((l) => ({ ...l, [m.channelId]: m }));
    };
    socket?.on('message:new', onNew);
    return () => {
      socket?.off('message:new', onNew);
    };
  }, []);
  const list = useMemo(() => {
    return Object.values(memberships)
      .map((m) => channels[m.channelId])
      .filter((c): c is Channel => !!c && isDmKind(c) && (!memberships[c.id].hidden || c.id === activeId))
      .filter((c) => !onlyUnread || memberships[c.id].unread > 0)
      .filter((c) => !q || channelTitle(c, meId).toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => (b.lastMessageAt ?? memberships[b.id].joinedAt) - (a.lastMessageAt ?? memberships[a.id].joinedAt));
  }, [channels, memberships, onlyUnread, q, activeId, meId]);

  return (
    <div className="pane">
      <div className="pane-head">
        <span className="pane-title">{t('Direct messages')}</span>
        <label className="unread-toggle">
          <span>{t('Unreads')}</span>
          <input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} />
          <span className="mini-toggle" />
        </label>
        <button className="sidebar-compose" onClick={() => openModal({ type: 'newMessage' })} aria-label={t('New message')}>
          <SquarePen size={18} />
        </button>
      </div>
      <div className="pane-search">
        <Search size={14} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Find a DM')} />
      </div>
      <div className="sidebar-scroll">
        {list.map((c) => (
          <DMRow key={c.id} channel={c} active={c.id === activeId} preview={latest[c.id]} />
        ))}
        {!list.length && <div className="pane-empty">{onlyUnread ? t('You’re all caught up.') : t('No conversations yet.')}</div>}
      </div>
    </div>
  );
}
