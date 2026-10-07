import { useEffect, useState } from 'react';
import { Hash, Lock, Search } from '../components/icons.tsx';
import { useLocation, useNavigate } from 'react-router-dom';
import type { SearchResults } from '../../../shared/types.ts';
import { GET } from '../api.ts';
import { channelTitle, displayName, isDmKind, set, useStore, upsertMessages } from '../store.ts';
import { t, tp } from '../i18n.ts';
import { fail, openDm, openProfile } from '../actions.ts';
import { MessageItem, FileCard } from '../components/Message.tsx';
import { Avatar, EmptyState, Spinner } from '../components/ui.tsx';
import { formatShortDate } from '../lib/format.ts';

type Type = 'messages' | 'files' | 'channels' | 'people';

export function SearchView() {
  const loc = useLocation();
  const nav = useNavigate();
  const params = new URLSearchParams(loc.search);
  const q = params.get('q') ?? '';
  const [type, setType] = useState<Type>('messages');
  const [sort, setSort] = useState<'relevance' | 'newest' | 'oldest'>('relevance');
  const [res, setRes] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const channels = useStore((s) => s.channels);
  const users = useStore((s) => s.users);

  useEffect(() => {
    setOffset(0);
  }, [q, type, sort]);

  useEffect(() => {
    if (!q) return;
    setLoading(true);
    GET<SearchResults>(`/api/search?q=${encodeURIComponent(q)}&type=${type === 'messages' ? 'all' : type}&sort=${sort}&offset=${offset}&limit=40`)
      .then((r) => {
        set((s) => upsertMessages(s, r.messages));
        setRes((prev) => (offset && prev ? { ...r, messages: [...prev.messages, ...r.messages] } : r));
      })
      .catch(fail)
      .finally(() => setLoading(false));
  }, [q, type, sort, offset]);

  const tabs: [Type, string, number | undefined][] = [
    ['messages', t('Messages'), res?.total],
    ['files', t('Files'), undefined],
    ['channels', t('Channels'), undefined],
    ['people', t('People'), undefined],
  ];

  return (
    <main className="main-view">
      <div className="view-header">
        <h2>
          <Search size={18} /> {t('Results for “{q}”', { q })}
        </h2>
      </div>
      <div className="view-tabs">
        {tabs.map(([k, label, n]) => (
          <button key={k} className={`view-tab${type === k ? ' active' : ''}`} onClick={() => setType(k)}>
            {label}
            {n !== undefined && <span className="ch-tab-count">{n}</span>}
          </button>
        ))}
        {type === 'messages' && (
          <select className="view-sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="relevance">{t('Most relevant')}</option>
            <option value="newest">{t('Newest')}</option>
            <option value="oldest">{t('Oldest')}</option>
          </select>
        )}
      </div>
      <div className="view-body list-view">
        {loading && !res && (
          <div className="center-fill">
            <Spinner />
          </div>
        )}
        {res && type === 'messages' && (
          <>
            {res.channels.length > 0 && offset === 0 && (
              <div className="search-chips">
                {res.channels.slice(0, 5).map((c) => (
                  <button key={c.id} className="chip" onClick={() => nav(`/c/${c.id}`)}>
                    {c.kind === 'private' ? <Lock size={12} /> : <Hash size={12} />} {c.name}
                  </button>
                ))}
                {res.users.slice(0, 5).map((u) => (
                  <button key={u.id} className="chip" onClick={() => openProfile(u.id)}>
                    <Avatar user={u} size={16} /> {displayName(u)}
                  </button>
                ))}
              </div>
            )}
            {res.messages.length ? (
              <>
                <div className="search-count">{tp(res.total, '{n} result', '{n} results')}</div>
                {res.messages.map((m) => {
                  const ch = channels[m.channelId];
                  return (
                    <div
                      key={m.id}
                      className="list-card search-result"
                      onClick={() => nav(`/c/${m.channelId}/${m.id}${m.threadRootId && !m.alsoInChannel ? `?thread=${m.threadRootId}` : ''}`)}
                    >
                      <div className="draft-top">
                        <span className="draft-where">{ch ? (isDmKind(ch) ? channelTitle(ch) : `#${ch.name}`) : ''}</span>
                        {m.threadRootId && <span className="draft-thread">{t('Thread')}</span>}
                        <span className="draft-time">{formatShortDate(m.createdAt)}</span>
                      </div>
                      <MessageItem id={m.id} context="list" />
                    </div>
                  );
                })}
                {res.messages.length < res.total && (
                  <button className="btn load-more" onClick={() => setOffset(res.messages.length)} disabled={loading}>
                    {loading ? <Spinner size={14} /> : t('Load more')}
                  </button>
                )}
              </>
            ) : (
              !loading && (
                <EmptyState icon={<Search size={36} />} title={t('No results')}>
                  {t('Try different keywords or remove some filters.')}
                </EmptyState>
              )
            )}
          </>
        )}
        {res && type === 'files' && (
          <div className="files-grid">
            {res.files.length ? (
              res.files.map((f) => (
                <div key={f.id} className="files-grid-item">
                  <FileCard f={f} messageId={f.messageId ?? undefined} />
                  <div className="files-grid-meta">
                    {users[f.userId]?.fullName} · {formatShortDate(f.createdAt)}
                  </div>
                </div>
              ))
            ) : (
              <EmptyState title={t('No files found')} />
            )}
          </div>
        )}
        {res && type === 'channels' &&
          (res.channels.length ? (
            res.channels.map((c) => (
              <div key={c.id} className="list-card browse-row" onClick={() => nav(`/c/${c.id}`)}>
                <div className="browse-name">
                  {c.kind === 'private' ? <Lock size={14} /> : <Hash size={14} />} {c.name}
                </div>
                <div className="browse-sub">
                  {tp(c.memberCount, '{n} member', '{n} members')} {c.description && `· ${c.description}`}
                </div>
              </div>
            ))
          ) : (
            <EmptyState title={t('No channels found')} />
          ))}
        {res && type === 'people' && (
          <div className="people-grid">
            {res.users.length ? res.users.map((u) => <PersonCard key={u.id} userId={u.id} />) : <EmptyState title={t('No people found')} />}
          </div>
        )}
      </div>
    </main>
  );
}

export function PersonCard({ userId }: { userId: string }) {
  const u = useStore((s) => s.users[userId]);
  const online = useStore((s) => s.presence[userId] === 'active');
  if (!u) return null;
  return (
    <div className={`person-card${u.deactivated ? ' deactivated' : ''}`} onClick={() => openProfile(u.id)}>
      <Avatar user={u} size={140} />
      <div className="person-name">
        {displayName(u)} <span className={`presence-dot ${online ? 'online' : 'away'}`} />
      </div>
      {u.title && <div className="person-title">{u.title}</div>}
      {!u.deactivated && (
        <button
          className="btn small person-msg"
          onClick={(e) => {
            e.stopPropagation();
            void openDm([u.id]);
          }}
        >
          {t('Message')}
        </button>
      )}
    </div>
  );
}
