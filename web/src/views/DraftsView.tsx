import { useEffect, useMemo, useState } from 'react';
import { Clock, SendHorizontal, Trash2, Pencil } from '../components/icons.tsx';
import { useNavigate } from 'react-router-dom';
import type { Message, ScheduledMessage } from '../../../shared/types.ts';
import { DEL, GET } from '../api.ts';
import { channelTitle, isDmKind, set, useStore, upsertMessages } from '../store.ts';
import { t } from '../i18n.ts';
import { fail, saveDraft, sendMessage, openThread } from '../actions.ts';
import { Mrkdwn } from '../lib/mrkdwn.tsx';
import { formatDateTime, formatShortDate } from '../lib/format.ts';
import { encodeMessage } from '../lib/composerText.ts';
import { EmptyState, Spinner } from '../components/ui.tsx';
import { MessageItem } from '../components/Message.tsx';

type Tab = 'drafts' | 'scheduled' | 'sent';

function Where({ channelId }: { channelId: string }) {
  const ch = useStore((s) => s.channels[channelId]);
  if (!ch) return null;
  return <span className="draft-where">{isDmKind(ch) ? channelTitle(ch) : `#${ch.name}`}</span>;
}

export function DraftsView() {
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('drafts');
  const draftsMap = useStore((s) => s.drafts);
  const drafts = useMemo(() => Object.values(draftsMap).sort((a, b) => b.updatedAt - a.updatedAt), [draftsMap]);
  const [scheduled, setScheduled] = useState<ScheduledMessage[] | null>(null);
  const [sent, setSent] = useState<Message[] | null>(null);

  useEffect(() => {
    if (tab === 'scheduled') GET<ScheduledMessage[]>('/api/scheduled').then(setScheduled).catch(fail);
    if (tab === 'sent')
      GET<Message[]>('/api/sent')
        .then((l) => {
          set((s) => upsertMessages(s, l));
          setSent(l);
        })
        .catch(fail);
  }, [tab]);

  return (
    <main className="main-view">
      <div className="view-header">
        <h2>
          <SendHorizontal size={18} /> {t('Drafts & sent')}
        </h2>
      </div>
      <div className="view-tabs">
        <button className={`view-tab${tab === 'drafts' ? ' active' : ''}`} onClick={() => setTab('drafts')}>
          {t('Drafts')} {drafts.length > 0 && <span className="ch-tab-count">{drafts.length}</span>}
        </button>
        <button className={`view-tab${tab === 'scheduled' ? ' active' : ''}`} onClick={() => setTab('scheduled')}>
          {t('Scheduled')}
        </button>
        <button className={`view-tab${tab === 'sent' ? ' active' : ''}`} onClick={() => setTab('sent')}>
          {t('Sent')}
        </button>
      </div>
      <div className="view-body list-view">
        {tab === 'drafts' &&
          (drafts.length ? (
            drafts.map((d) => (
              <div key={`${d.channelId}:${d.threadRootId}`} className="list-card draft-card" onClick={() => (d.threadRootId ? (nav(`/c/${d.channelId}`), openThread(d.threadRootId, d.channelId)) : nav(`/c/${d.channelId}`))}>
                <div className="draft-top">
                  <Where channelId={d.channelId} />
                  {d.threadRootId && <span className="draft-thread">{t('in a thread')}</span>}
                  <span className="draft-time">{formatShortDate(d.updatedAt)}</span>
                </div>
                <div className="draft-text">{d.text}</div>
                <div className="draft-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn small" title={t('Edit')} onClick={() => nav(`/c/${d.channelId}`)}>
                    <Pencil size={14} />
                  </button>
                  <button
                    className="icon-btn small"
                    title={t('Send now')}
                    onClick={() => {
                      void sendMessage(d.channelId, encodeMessage(d.text), { threadRootId: d.threadRootId });
                      saveDraft(d.channelId, d.threadRootId, '');
                    }}
                  >
                    <SendHorizontal size={14} />
                  </button>
                  <button className="icon-btn small" title={t('Delete draft')} onClick={() => saveDraft(d.channelId, d.threadRootId, '')}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))
          ) : (
            <EmptyState icon={<Pencil size={32} />} title={t('No drafts')}>
              {t('Messages you start but don’t send will be kept here.')}
            </EmptyState>
          ))}
        {tab === 'scheduled' &&
          (!scheduled ? (
            <div className="center-fill">
              <Spinner />
            </div>
          ) : scheduled.length ? (
            scheduled.map((s) => (
              <div key={s.id} className="list-card draft-card">
                <div className="draft-top">
                  <Where channelId={s.channelId} />
                  <span className="draft-time">
                    <Clock size={12} /> {t('Sends {when}', { when: formatDateTime(s.sendAt) })}
                  </span>
                </div>
                <div className="draft-text">
                  <Mrkdwn text={s.text} />
                </div>
                <div className="draft-actions">
                  <button
                    className="icon-btn small"
                    title={t('Send now')}
                    onClick={async () => {
                      await sendMessage(s.channelId, s.text, { threadRootId: s.threadRootId });
                      await DEL(`/api/scheduled/${s.id}`).catch(fail);
                      setScheduled((l) => l?.filter((x) => x.id !== s.id) ?? null);
                    }}
                  >
                    <SendHorizontal size={14} />
                  </button>
                  <button
                    className="icon-btn small"
                    title={t('Delete')}
                    onClick={async () => {
                      await DEL(`/api/scheduled/${s.id}`).catch(fail);
                      setScheduled((l) => l?.filter((x) => x.id !== s.id) ?? null);
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))
          ) : (
            <EmptyState icon={<Clock size={32} />} title={t('No scheduled messages')}>
              {t('Use the arrow next to the send button to schedule a message.')}
            </EmptyState>
          ))}
        {tab === 'sent' &&
          (!sent ? (
            <div className="center-fill">
              <Spinner />
            </div>
          ) : (
            sent.map((m) => (
              <div key={m.id} className="list-card" onClick={() => nav(`/c/${m.channelId}/${m.id}${m.threadRootId && !m.alsoInChannel ? `?thread=${m.threadRootId}` : ''}`)}>
                <div className="draft-top">
                  <Where channelId={m.channelId} />
                </div>
                <MessageItem id={m.id} context="list" />
              </div>
            ))
          ))}
      </div>
    </main>
  );
}

