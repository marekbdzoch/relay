import { useEffect, useState } from 'react';
import { Download, FileText, Files, Image, Search, Share2, Upload, User } from '../components/icons.tsx';
import { useLocation, useNavigate } from 'react-router-dom';
import type { FileInfo } from '../../../shared/types.ts';
import { GET, assetUrl } from '../api.ts';
import { channelTitle, isDmKind, useStore, userName } from '../store.ts';
import { t } from '../i18n.ts';
import { fail, openModal } from '../actions.ts';
import { fileKind, formatShortDate, formatSize } from '../lib/format.ts';
import { Spinner } from '../components/ui.tsx';

type Scope = 'all' | 'mine' | 'shared';
const TYPES = ['all', 'images', 'pdfs', 'documents', 'spreadsheets', 'media', 'archives', 'other'] as const;
type FileType = (typeof TYPES)[number];

function useFileParams() {
  const loc = useLocation();
  const p = new URLSearchParams(loc.search);
  return { scope: (p.get('scope') as Scope) || 'all', type: (p.get('type') as FileType) || 'all' };
}

export function FilesNav() {
  const nav = useNavigate();
  const { scope, type } = useFileParams();
  const go = (s: Scope, ty: FileType = 'all') => nav(`/files?scope=${s}&type=${ty}`);
  const item = (key: Scope, label: string, icon: React.ReactNode) => (
    <button className={`sb-item${scope === key && type === 'all' ? ' active' : ''}`} onClick={() => go(key)}>
      <span className="sb-icon">{icon}</span>
      <span className="sb-name">{label}</span>
    </button>
  );
  const typeLabels: Record<FileType, string> = {
    all: t('All types'),
    images: t('Images'),
    pdfs: t('PDFs'),
    documents: t('Documents'),
    spreadsheets: t('Spreadsheets'),
    media: t('Audio & video'),
    archives: t('Archives'),
    other: t('Other'),
  };
  return (
    <div className="pane files-nav">
      <div className="pane-head">
        <span className="pane-title">{t('Files')}</span>
      </div>
      <div className="sidebar-scroll">
        <div className="sb-group">
          {item('all', t('All files'), <Files size={16} />)}
          {item('mine', t('Created by you'), <User size={16} />)}
          {item('shared', t('Shared with you'), <Share2 size={16} />)}
        </div>
        <div className="sb-section">
          <div className="sb-section-head">
            <span className="sb-section-toggle">{t('Types')}</span>
          </div>
          {TYPES.slice(1).map((ty) => (
            <button key={ty} className={`sb-item${type === ty ? ' active' : ''}`} onClick={() => go(scope, ty)}>
              <span className="sb-icon">{ty === 'images' ? <Image size={15} /> : <FileText size={15} />}</span>
              <span className="sb-name">{typeLabels[ty]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function FilesView() {
  const nav = useNavigate();
  const { scope, type } = useFileParams();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'name' | 'size'>('newest');
  const [list, setList] = useState<FileInfo[] | null>(null);
  const channels = useStore((s) => s.channels);

  useEffect(() => {
    setList(null);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ type, sort });
      if (scope === 'mine') params.set('mine', '1');
      if (scope === 'shared') params.set('shared', '1');
      if (q.trim()) params.set('q', q.trim());
      GET<FileInfo[]>(`/api/files?${params}`).then(setList).catch(fail);
    }, 200);
    return () => clearTimeout(timer);
  }, [scope, type, sort, q]);

  return (
    <main className="main-view">
      <div className="view-header">
        <h2>
          <Files size={18} /> {scope === 'mine' ? t('Created by you') : scope === 'shared' ? t('Shared with you') : t('All files')}
        </h2>
      </div>
      <div className="files-toolbar">
        <div className="browse-search">
          <Search size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search files')} />
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="view-sort">
          <option value="newest">{t('Newest')}</option>
          <option value="oldest">{t('Oldest')}</option>
          <option value="name">{t('Name')}</option>
          <option value="size">{t('Size')}</option>
        </select>
      </div>
      <div className="view-body files-list">
        {!list ? (
          <div className="center-fill">
            <Spinner />
          </div>
        ) : !list.length ? (
          <div className="all-caught-up">
            <Upload size={36} />
            <h3>{t('No files yet')}</h3>
            <p>{t('Files shared in channels and direct messages show up here.')}</p>
          </div>
        ) : (
          list.map((f) => {
            const ch = f.channelId ? channels[f.channelId] : undefined;
            const kind = fileKind(f.mime, f.name);
            return (
              <div
                key={f.id}
                className="file-row"
                onClick={() => (kind === 'image' && f.messageId ? openModal({ type: 'image', fileId: f.id, messageId: f.messageId }) : f.channelId && nav(`/c/${f.channelId}/${f.messageId}`))}
              >
                {kind === 'image' ? (
                  <img className="file-row-thumb" src={assetUrl(f.url)} alt="" loading="lazy" />
                ) : (
                  <span className={`file-row-icon kind-${kind}`}>
                    <FileText size={18} />
                  </span>
                )}
                <div className="file-row-main">
                  <b>{f.name}</b>
                  <span className="muted-text">
                    {userName(f.userId)} · {formatShortDate(f.createdAt)} · {formatSize(f.size)}
                    {ch && ` · ${isDmKind(ch) ? channelTitle(ch) : `#${ch.name}`}`}
                  </span>
                </div>
                <a className="icon-btn" href={`${assetUrl(f.url)}?download=1`} download={f.name} onClick={(e) => e.stopPropagation()} title={t('Download')}>
                  <Download size={16} />
                </a>
              </div>
            );
          })
        )}
      </div>
    </main>
  );
}
