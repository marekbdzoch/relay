import { useEffect, useState } from 'react';
import { MessageCircle } from '../components/icons.tsx';
import type { ThreadSummary } from '../../../shared/types.ts';
import { GET } from '../api.ts';
import { channelTitle, isDmKind, set, useStore, upsertMessages } from '../store.ts';
import { t, tp } from '../i18n.ts';
import { fail, markThreadRead, openThread } from '../actions.ts';
import { socket } from '../socket.ts';
import { MessageItem } from '../components/Message.tsx';
import { Composer } from '../components/Composer.tsx';
import { EmptyState, Spinner } from '../components/ui.tsx';

function ThreadCard({ th }: { th: ThreadSummary }) {
  const channel = useStore((s) => s.channels[th.root.channelId]);
  const [showAll, setShowAll] = useState(false);
  const threadState = useStore((s) => s.threads[th.root.id]);
  const replyIds = showAll && threadState?.loaded ? threadState.ids : th.replies.map((r) => r.id);
  const hidden = th.root.replyCount - th.replies.length;

  return (
    <div className={`thread-card${th.unread ? ' unread' : ''}`}>
      <div className="thread-card-head">
        <b>{channel ? (isDmKind(channel) ? channelTitle(channel) : `#${channel.name}`) : ''}</b>
        {th.unread > 0 && <span className="thread-card-new">{tp(th.unread, '{n} new reply', '{n} new replies')}</span>}
      </div>
      <MessageItem id={th.root.id} context="thread" />
      {hidden > 0 && !showAll && (
        <button
          className="link thread-card-more"
          onClick={() => {
            setShowAll(true);
            openThread(th.root.id, th.root.channelId);
          }}
        >
          {tp(hidden, 'Show {n} more reply', 'Show {n} more replies')}
        </button>
      )}
      {replyIds.map((id) => (
        <MessageItem key={id} id={id} context="thread" />
      ))}
      <div className="thread-card-composer" onFocus={() => markThreadRead(th.root.id)}>
        <Composer channelId={th.root.channelId} threadRootId={th.root.id} autoFocus={false} placeholder={t('Reply…')} />
      </div>
    </div>
  );
}

export function ThreadsView() {
  const [list, setList] = useState<ThreadSummary[] | null>(null);

  const load = () =>
    GET<ThreadSummary[]>('/api/threads')
      .then((l) => {
        set((s) => {
          upsertMessages(s, l.flatMap((x) => [x.root, ...x.replies]));
          for (const x of l) {
            if (!s.threads[x.root.id]) s.threads[x.root.id] = { ids: x.replies.map((r) => r.id), loaded: false, following: true, lastRead: x.lastRead };
          }
        });
        setList(l);
      })
      .catch(fail);

  useEffect(() => {
    void load();
    const onNew = (m: { threadRootId: number | null }) => {
      if (m.threadRootId) void load();
    };
    socket?.on('message:new', onNew);
    return () => {
      socket?.off('message:new', onNew);
    };
  }, []);

  useEffect(() => {
    // viewing the threads page marks the visible threads as read
    if (list) for (const th of list) if (th.unread) markThreadReadLocal(th);
  }, [list]);

  return (
    <main className="main-view">
      <div className="view-header">
        <h2>
          <MessageCircle size={18} /> {t('Threads')}
        </h2>
      </div>
      <div className="view-body threads-view">
        {!list ? (
          <div className="center-fill">
            <Spinner />
          </div>
        ) : !list.length ? (
          <EmptyState icon={<MessageCircle size={36} />} title={t('No threads yet')}>
            {t('Threads you start, reply to, or are mentioned in will show up here.')}
          </EmptyState>
        ) : (
          list.map((th) => <ThreadCard key={th.root.id} th={th} />)
        )}
      </div>
    </main>
  );
}

function markThreadReadLocal(th: ThreadSummary) {
  const last = th.replies[th.replies.length - 1]?.id;
  if (!last) return;
  set((s) => {
    if (s.threads[th.root.id]) {
      s.threads[th.root.id].ids = s.threads[th.root.id].loaded ? s.threads[th.root.id].ids : th.replies.map((r) => r.id);
    }
  });
  markThreadRead(th.root.id);
}
