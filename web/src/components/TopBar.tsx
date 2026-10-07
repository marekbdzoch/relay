import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CircleHelp, Hash, Lock, Search, X, Clock, WifiOff } from './icons.tsx';
import { useNavigate } from 'react-router-dom';
import { displayName, useStore } from '../store.ts';
import { t } from '../i18n.ts';
import { openChannel, openDm, openModal, openProfile } from '../actions.ts';
import { Avatar } from './ui.tsx';

const RECENT_KEY = 'relay.recentSearches';
export function recentSearches(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}
export function addRecentSearch(q: string) {
  const list = [q, ...recentSearches().filter((x) => x !== q)].slice(0, 8);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function TopBar() {
  const ws = useStore((s) => s.workspace);
  const connected = useStore((s) => s.connected);
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<string | undefined>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'g' || (e.key === 'f' && e.shiftKey))) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    const onOpen = (e: Event) => {
      setPrefill((e as CustomEvent<string | undefined>).detail);
      setOpen(true);
    };
    window.addEventListener('relay:search', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('relay:search', onOpen);
    };
  }, []);

  return (
    <header className="topbar">
      <div className="topbar-nav">
        <button className="topbar-btn" onClick={() => history.back()} aria-label={t('Back')}>
          <ArrowLeft size={18} />
        </button>
        <button className="topbar-btn" onClick={() => history.forward()} aria-label={t('Forward')}>
          <ArrowRight size={18} />
        </button>
        <button className="topbar-btn" onClick={() => openModal({ type: 'quickSwitcher' })} aria-label={t('Jump to…')} title={`${t('Jump to…')} (⌘K)`}>
          <Clock size={18} />
        </button>
      </div>
      <div className="topbar-search-wrap">
        <button className="topbar-search" onClick={() => setOpen(true)}>
          <Search size={15} />
          <span>{t('Search {name}', { name: ws?.name ?? '' })}</span>
        </button>
        {open && (
          <SearchBox
            initial={prefill}
            onClose={() => {
              setOpen(false);
              setPrefill(undefined);
            }}
          />
        )}
      </div>
      <div className="topbar-right">
        {!connected && (
          <span className="topbar-offline" title={t('Reconnecting…')}>
            <WifiOff size={15} /> {t('Reconnecting…')}
          </span>
        )}
        <button className="topbar-btn" onClick={() => openModal({ type: 'shortcuts' })} aria-label={t('Help')}>
          <CircleHelp size={18} />
        </button>
      </div>
    </header>
  );
}

function SearchBox({ onClose, initial }: { onClose: () => void; initial?: string }) {
  const nav = useNavigate();
  const [q, setQ] = useState(() => initial ?? new URLSearchParams(location.search).get('q') ?? '');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const memberships = useStore((s) => s.memberships);
  const meId = useStore((s) => s.me?.id);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (initial) {
      el.focus();
      el.setSelectionRange(initial.length, initial.length);
    } else el.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const suggestions = useMemo(() => {
    const term = q.trim().toLowerCase();
    type Sug = { key: string; icon: React.ReactNode; label: string; sub?: string; run: () => void };
    const out: Sug[] = [];
    if (!term) {
      for (const r of recentSearches()) out.push({ key: `r-${r}`, icon: <Clock size={16} />, label: r, run: () => submit(r) });
      return out;
    }
    const chans = Object.values(channels)
      .filter((c) => (c.kind === 'public' || c.kind === 'private') && memberships[c.id] && c.name.includes(term))
      .slice(0, 4);
    for (const c of chans) out.push({ key: c.id, icon: c.kind === 'private' ? <Lock size={16} /> : <Hash size={16} />, label: c.name, run: () => openChannel(c.id) });
    const people = Object.values(users)
      .filter((u) => !u.deactivated && (displayName(u).toLowerCase().includes(term) || u.fullName.toLowerCase().includes(term) || u.username.includes(term)))
      .slice(0, 4);
    for (const u of people)
      out.push({
        key: u.id,
        icon: <Avatar user={u} size={20} />,
        label: displayName(u),
        sub: u.title,
        run: () => (u.id === meId ? openProfile(u.id) : void openDm([u.id])),
      });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, users, channels, memberships]);

  function submit(query: string) {
    const v = query.trim();
    if (!v) return;
    addRecentSearch(v);
    onClose();
    nav(`/search?q=${encodeURIComponent(v)}`);
  }

  const onKey = (e: React.KeyboardEvent) => {
    const total = suggestions.length + (q.trim() ? 1 : 0);
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((x) => (x + 1) % Math.max(1, total));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((x) => (x - 1 + total) % Math.max(1, total));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (q.trim() && sel === 0) submit(q);
      else {
        const s = suggestions[q.trim() ? sel - 1 : sel];
        if (s) {
          onClose();
          s.run();
        } else submit(q);
      }
    }
  };

  return (
    <>
      <div className="search-backdrop" onMouseDown={onClose} />
      <div className="search-box">
        <div className="search-input-row">
          <Search size={16} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKey}
            placeholder={t('Search for messages, files, people, channels…')}
          />
          {q && (
            <button className="icon-btn small" onClick={() => setQ('')} aria-label={t('Clear')}>
              <X size={14} />
            </button>
          )}
        </div>
        <div className="search-suggestions">
          {q.trim() && (
            <button className={`search-sug${sel === 0 ? ' selected' : ''}`} onMouseEnter={() => setSel(0)} onClick={() => submit(q)}>
              <Search size={16} />
              <span>{q}</span>
            </button>
          )}
          {!q.trim() && suggestions.length > 0 && <div className="search-section">{t('Recent searches')}</div>}
          {suggestions.map((s, i) => {
            const idx = q.trim() ? i + 1 : i;
            return (
              <button
                key={s.key}
                className={`search-sug${sel === idx ? ' selected' : ''}`}
                onMouseEnter={() => setSel(idx)}
                onClick={() => {
                  onClose();
                  s.run();
                }}
              >
                {s.icon}
                <span>{s.label}</span>
                {s.sub && <span className="search-sug-sub">{s.sub}</span>}
              </button>
            );
          })}
          <div className="search-help">
            {t('Tip: narrow results with')} <code>in:#channel</code> <code>from:@user</code> <code>before:2025-01-31</code> <code>has:file</code>
          </div>
        </div>
      </div>
    </>
  );
}

