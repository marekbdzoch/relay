import { useEffect, useMemo, useState } from 'react';
import { Hash, Layers, Lock, Search, Archive } from '../components/icons.tsx';
import { useNavigate } from 'react-router-dom';
import type { Channel, FileInfo } from '../../../shared/types.ts';
import { GET } from '../api.ts';
import { displayName, useStore } from '../store.ts';
import { t, tp } from '../i18n.ts';
import { fail, joinChannel, leaveChannel, openModal } from '../actions.ts';
import { formatShortDate } from '../lib/format.ts';
import { FileCard } from '../components/Message.tsx';
import { Spinner } from '../components/ui.tsx';
import { PersonCard } from './SearchView.tsx';

type Tab = 'channels' | 'people' | 'files';

function ChannelsTab() {
  const nav = useNavigate();
  const [list, setList] = useState<Channel[] | null>(null);
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const memberships = useStore((s) => s.memberships);
  useEffect(() => {
    GET<Channel[]>('/api/channels').then(setList).catch(fail);
  }, [memberships]);
  const filtered = useMemo(
    () => (list ?? []).filter((c) => (showArchived ? c.archived : !c.archived) && (!q || c.name.includes(q.toLowerCase()) || c.description.toLowerCase().includes(q.toLowerCase()))),
    [list, q, showArchived],
  );
  return (
    <>
      <div className="browse-toolbar">
        <div className="browse-search">
          <Search size={16} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search for channels')} />
        </div>
        <label className="browse-check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> <Archive size={14} /> {t('Archived channels')}
        </label>
        <button className="btn primary" onClick={() => openModal({ type: 'createChannel' })}>
          {t('Create channel')}
        </button>
      </div>
      {!list ? (
        <div className="center-fill">
          <Spinner />
        </div>
      ) : (
        <div className="browse-list">
          <div className="browse-count">{tp(filtered.length, '{n} result', '{n} results')}</div>
          {filtered.map((c) => {
            const joined = !!memberships[c.id];
            return (
              <div key={c.id} className="browse-row" onClick={() => nav(`/c/${c.id}`)}>
                <div className="browse-main">
                  <div className="browse-name">
                    {c.kind === 'private' ? <Lock size={14} /> : <Hash size={14} />} {c.name}
                  </div>
                  <div className="browse-sub">
                    {joined && <span className="browse-joined">✓ {t('Joined')} · </span>}
                    {tp(c.memberCount, '{n} member', '{n} members')}
                    {c.description && ` · ${c.description}`}
                  </div>
                </div>
                <div className="browse-actions" onClick={(e) => e.stopPropagation()}>
                  {joined ? (
                    !c.isDefault && (
                      <button className="btn small" onClick={() => leaveChannel(c.id)}>
                        {t('Leave')}
                      </button>
                    )
                  ) : (
                    !c.archived && (
                      <button className="btn small primary" onClick={() => void joinChannel(c.id)}>
                        {t('Join')}
                      </button>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function PeopleTab() {
  const users = useStore((s) => s.users);
  const [q, setQ] = useState('');
  const [showDeactivated, setShowDeactivated] = useState(false);
  const list = useMemo(
    () =>
      Object.values(users)
        .filter((u) => u.deactivated === showDeactivated && !u.isBot)
        .filter((u) => !q || `${u.fullName} ${u.displayName} ${u.username} ${u.title}`.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [users, q, showDeactivated],
  );
  return (
    <>
      <div className="browse-toolbar">
        <div className="browse-search">
          <Search size={16} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search for people')} />
        </div>
        <label className="browse-check">
          <input type="checkbox" checked={showDeactivated} onChange={(e) => setShowDeactivated(e.target.checked)} /> {t('Deactivated accounts')}
        </label>
        <button className="btn primary" onClick={() => openModal({ type: 'invite' })}>
          {t('Invite people')}
        </button>
      </div>
      <div className="people-grid">
        {list.map((u) => (
          <PersonCard key={u.id} userId={u.id} />
        ))}
      </div>
    </>
  );
}

function FilesTab() {
  const [list, setList] = useState<FileInfo[] | null>(null);
  const [mine, setMine] = useState(false);
  const users = useStore((s) => s.users);
  useEffect(() => {
    setList(null);
    GET<FileInfo[]>(`/api/files${mine ? '?mine=1' : ''}`).then(setList).catch(fail);
  }, [mine]);
  return (
    <>
      <div className="browse-toolbar">
        <label className="browse-check">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> {t('Only my files')}
        </label>
      </div>
      {!list ? (
        <div className="center-fill">
          <Spinner />
        </div>
      ) : (
        <div className="files-grid">
          {list.map((f) => (
            <div key={f.id} className="files-grid-item">
              <FileCard f={f} messageId={f.messageId ?? undefined} />
              <div className="files-grid-meta">
                {users[f.userId]?.fullName} · {formatShortDate(f.createdAt)}
              </div>
            </div>
          ))}
          {!list.length && <div className="pane-empty">{t('No files yet.')}</div>}
        </div>
      )}
    </>
  );
}

export function BrowseView({ tab }: { tab: Tab }) {
  const nav = useNavigate();
  return (
    <main className="main-view">
      <div className="view-header">
        <h2>
          <Layers size={18} /> {t('Directories')}
        </h2>
      </div>
      <div className="view-tabs">
        {(
          [
            ['people', t('People')],
            ['channels', t('Channels')],
            ['files', t('Files')],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} className={`view-tab${tab === k ? ' active' : ''}`} onClick={() => nav(`/browse/${k}`)}>
            {label}
          </button>
        ))}
      </div>
      <div className="view-body browse-body">
        {tab === 'channels' && <ChannelsTab />}
        {tab === 'people' && <PeopleTab />}
        {tab === 'files' && <FilesTab />}
      </div>
    </main>
  );
}
