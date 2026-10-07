import { useEffect, useState } from 'react';
import { Check, Hash, Lock, Inbox } from '../components/icons.tsx';
import { useNavigate } from 'react-router-dom';
import type { UnreadGroup } from '../../../shared/types.ts';
import { GET } from '../api.ts';
import { channelTitle, isDmKind, set, useStore, upsertMessages } from '../store.ts';
import { t, tp } from '../i18n.ts';
import { fail, markRead } from '../actions.ts';
import { MessageItem, shouldGroup } from '../components/Message.tsx';
import { ChannelIcon } from '../components/Sidebar.tsx';
import { Spinner } from '../components/ui.tsx';

function Group({ g, onDone }: { g: UnreadGroup; onDone: () => void }) {
  const nav = useNavigate();
  const ch = useStore((s) => s.channels[g.channelId]);
  const msgs = useStore((s) => s.msgs);
  if (!ch) return null;
  return (
    <div className="unread-group">
      <div className="unread-group-head">
        <button className="unread-group-title" onClick={() => nav(`/c/${ch.id}`)}>
          <span className="unread-group-icon">{isDmKind(ch) ? <ChannelIcon channel={ch} size={16} /> : ch.kind === 'private' ? <Lock size={15} /> : <Hash size={16} />}</span>
          <b>{channelTitle(ch)}</b>
          <span className="muted-text">{tp(g.total, '{n} new message', '{n} new messages')}</span>
        </button>
        <button
          className="btn small"
          onClick={() => {
            const last = g.messages[g.messages.length - 1]?.id;
            markRead(ch.id, last);
            onDone();
          }}
        >
          <Check size={14} /> {t('Mark as read')}
        </button>
      </div>
      {g.total > g.messages.length && (
        <button className="link unread-more" onClick={() => nav(`/c/${ch.id}`)}>
          {tp(g.total - g.messages.length, 'View {n} earlier message', 'View {n} earlier messages')}
        </button>
      )}
      {g.messages.map((m, i) => (
        <MessageItem key={m.id} id={m.id} context="list" grouped={shouldGroup(i ? msgs[g.messages[i - 1].id] : undefined, m)} />
      ))}
    </div>
  );
}

export function UnreadsView() {
  const [groups, setGroups] = useState<UnreadGroup[] | null>(null);
  const memberships = useStore((s) => s.memberships);
  const unreadKey = Object.values(memberships)
    .filter((m) => m.unread > 0)
    .map((m) => m.channelId)
    .join(',');

  useEffect(() => {
    GET<UnreadGroup[]>('/api/unreads')
      .then((g) => {
        set((s) => upsertMessages(s, g.flatMap((x) => x.messages)));
        setGroups(g);
      })
      .catch(fail);
    // refetch when the set of unread conversations changes
  }, [unreadKey]);

  return (
    <main className="main-view">
      <div className="view-header">
        <h2>
          <Inbox size={18} /> {t('Unreads')}
        </h2>
        {groups && groups.length > 0 && (
          <button
            className="btn small view-header-action"
            onClick={() => {
              for (const g of groups) markRead(g.channelId, g.messages[g.messages.length - 1]?.id);
              setGroups([]);
            }}
          >
            <Check size={14} /> {t('Mark all as read')}
          </button>
        )}
      </div>
      <div className="view-body unreads-view">
        {!groups ? (
          <div className="center-fill">
            <Spinner />
          </div>
        ) : !groups.length ? (
          <div className="all-caught-up">
            <div className="caught-up-emoji">🎉</div>
            <h3>{t('You’re up to date.')}</h3>
            <p>{t('Go forth and do great things.')}</p>
          </div>
        ) : (
          groups.map((g) => <Group key={g.channelId} g={g} onDone={() => setGroups((l) => l?.filter((x) => x.channelId !== g.channelId) ?? null)} />)
        )}
      </div>
    </main>
  );
}
