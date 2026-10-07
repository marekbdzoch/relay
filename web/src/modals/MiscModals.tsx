import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Hash, Lock, X } from '../components/icons.tsx';
import type { Channel, SidebarSection } from '../../../shared/types.ts';
import { assetUrl, POST } from '../api.ts';
import { channelTitle, displayName, isDmKind, useStore, toast, S } from '../store.ts';
import { t } from '../i18n.ts';
import { fail, forwardMessage, openChannel, openDm, remindMe, updatePrefs } from '../actions.ts';
import { Avatar, Modal, UserPresenceDot } from '../components/ui.tsx';
import { MessageItem } from '../components/Message.tsx';
import { formatDateTime } from '../lib/format.ts';

const NO_SECTIONS: SidebarSection[] = [];

type SwitchItem = { key: string; kind: 'channel' | 'user'; channel?: Channel; userId?: string; label: string; score: number; unread: number };

function useSwitchItems(q: string, includeUsers = true) {
  const channels = useStore((s) => s.channels);
  const memberships = useStore((s) => s.memberships);
  const users = useStore((s) => s.users);
  const meId = useStore((s) => s.me?.id);
  return useMemo(() => {
    const term = q.trim().toLowerCase();
    const items: SwitchItem[] = [];
    const dmUsers = new Set<string>();
    for (const c of Object.values(channels)) {
      const m = memberships[c.id];
      if (!m && c.kind !== 'public') continue;
      if (c.archived) continue;
      const label = channelTitle(c, meId);
      if (c.kind === 'dm') (c.memberIds ?? []).forEach((id) => dmUsers.add(id));
      const l = label.toLowerCase();
      if (term && !l.includes(term)) continue;
      const score = (term && l.startsWith(term) ? 100 : 0) + (m ? 50 : 0) + (m?.unread ? 20 : 0) + (c.lastMessageAt ?? 0) / 1e13;
      items.push({ key: c.id, kind: 'channel', channel: c, label, score, unread: m && !m.muted ? (isDmKind(c) ? m.unread : m.mentions) : 0 });
    }
    if (includeUsers && term) {
      for (const u of Object.values(users)) {
        if (u.deactivated || u.isBot || dmUsers.has(u.id)) continue;
        const l = `${u.fullName} ${u.displayName} ${u.username}`.toLowerCase();
        if (!l.includes(term)) continue;
        items.push({ key: u.id, kind: 'user', userId: u.id, label: displayName(u), score: l.startsWith(term) ? 90 : 10, unread: 0 });
      }
    }
    return items.sort((a, b) => b.score - a.score).slice(0, 12);
  }, [q, channels, memberships, users, meId, includeUsers]);
}

function SwitchRow({ it }: { it: SwitchItem }) {
  if (it.kind === 'user')
    return (
      <>
        <Avatar userId={it.userId} size={20} />
        <span className="qs-label">{it.label}</span>
        <UserPresenceDot userId={it.userId!} />
      </>
    );
  const c = it.channel!;
  const partner = c.kind === 'dm' ? (c.memberIds ?? []).find((id) => id !== S().me?.id) ?? S().me?.id : undefined;
  return (
    <>
      {partner ? <Avatar userId={partner} size={20} /> : c.kind === 'private' ? <Lock size={16} /> : c.kind === 'group' ? <span className="group-count">{(c.memberIds?.length ?? 1) - 1}</span> : <Hash size={16} />}
      <span className="qs-label">{it.label}</span>
      {it.unread > 0 && <span className="badge">{it.unread}</span>}
    </>
  );
}

export function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const items = useSwitchItems(q);
  const go = (it: SwitchItem | undefined) => {
    if (!it) return;
    onClose();
    if (it.kind === 'user') void openDm([it.userId!]);
    else openChannel(it.channel!.id);
  };
  return (
    <Modal onClose={onClose} width={600} className="quick-switcher">
      <input
        className="qs-input"
        autoFocus
        value={q}
        placeholder={t('Where would you like to go?')}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(s + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            go(items[sel]);
          }
        }}
      />
      <div className="qs-list">
        {items.map((it, i) => (
          <button key={it.key} className={`qs-item${i === sel ? ' selected' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => go(it)}>
            <SwitchRow it={it} />
          </button>
        ))}
        {!items.length && <div className="pane-empty">{t('No matches')}</div>}
      </div>
      <div className="qs-hint">
        <kbd>↑</kbd> <kbd>↓</kbd> {t('to navigate')} · <kbd>↵</kbd> {t('to select')} · <kbd>esc</kbd> {t('to dismiss')}
      </div>
    </Modal>
  );
}

export function ForwardModal({ messageId, onClose }: { messageId: number; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<SwitchItem | null>(null);
  const [comment, setComment] = useState('');
  const items = useSwitchItems(q);
  const send = async () => {
    if (!target) return;
    let channelId = target.channel?.id;
    if (target.kind === 'user') {
      const r = await POST<{ channel: Channel }>('/api/dms', { userIds: [target.userId] }).catch(fail);
      channelId = r?.channel.id;
    }
    if (!channelId) return;
    await forwardMessage(messageId, channelId, comment);
    onClose();
  };
  return (
    <Modal
      title={t('Forward this message')}
      onClose={onClose}
      width={600}
      footer={
        <button className="btn primary" disabled={!target} onClick={() => void send()}>
          {t('Forward')}
        </button>
      }
    >
      {target ? (
        <div className="up-field">
          <span className="up-chip">
            <SwitchRow it={target} />
            <button onClick={() => setTarget(null)}>
              <X size={12} />
            </button>
          </span>
        </div>
      ) : (
        <>
          <input className="full-input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Add by name or channel')} />
          <div className="qs-list short">
            {items.map((it) => (
              <button key={it.key} className="qs-item" onClick={() => setTarget(it)}>
                <SwitchRow it={it} />
              </button>
            ))}
          </div>
        </>
      )}
      <textarea className="full-input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('Add a message, if you’d like.')} />
      <div className="forward-preview">
        <MessageItem id={messageId} context="list" />
      </div>
    </Modal>
  );
}

export function ImageModal({ fileId, messageId, onClose }: { fileId: string; messageId: number; onClose: () => void }) {
  const m = useStore((s) => s.msgs[messageId]);
  const images = (m?.files ?? []).filter((f) => f.mime.startsWith('image/'));
  const [idx, setIdx] = useState(() => Math.max(0, images.findIndex((f) => f.id === fileId)));
  const f = images[idx];
  const author = useStore((s) => (m?.userId ? s.users[m.userId] : undefined));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setIdx((i) => Math.min(i + 1, images.length - 1));
      if (e.key === 'ArrowLeft') setIdx((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [images.length]);
  if (!f) return null;
  return (
    <Modal onClose={onClose} width={10000} className="lightbox">
      <div className="lightbox-head">
        <Avatar user={author} size={32} />
        <div>
          <b>{author ? displayName(author) : ''}</b>
          <div className="muted-text">
            {f.name} · {m && formatDateTime(m.createdAt)}
          </div>
        </div>
        <div className="lightbox-actions">
          <a className="icon-btn" href={`${assetUrl(f.url)}?download=1`} download={f.name} title={t('Download')}>
            <Download size={18} />
          </a>
          <button className="icon-btn" onClick={onClose} aria-label={t('Close')}>
            <X size={20} />
          </button>
        </div>
      </div>
      <div className="lightbox-body" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {idx > 0 && (
          <button className="lightbox-nav prev" onClick={() => setIdx(idx - 1)}>
            <ChevronLeft size={28} />
          </button>
        )}
        <img src={assetUrl(f.url)} alt={f.name} />
        {idx < images.length - 1 && (
          <button className="lightbox-nav next" onClick={() => setIdx(idx + 1)}>
            <ChevronRight size={28} />
          </button>
        )}
      </div>
    </Modal>
  );
}

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const rows: [string, string][] = [
    [`${mod} K`, t('Jump to a conversation')],
    [`${mod} G`, t('Search')],
    [`${mod} Shift A`, t('Open Activity')],
    [`${mod} Shift L`, t('Open Later')],
    [`${mod} Shift K`, t('Open direct messages')],
    [`${mod} Shift T`, t('Open Threads')],
    [`${mod} N`, t('Compose a new message')],
    ['Alt ↑ / Alt ↓', t('Previous / next channel')],
    ['Alt Shift ↑ / ↓', t('Previous / next unread channel')],
    ['Esc', t('Mark current channel read / close panel')],
    ['↑', t('Edit your last message (empty composer)')],
    [`${mod} B / ${mod} I / ${mod} Shift X`, t('Bold / italic / strikethrough')],
    ['Shift Enter', t('New line in message')],
    ['Alt + click', t('Mark message unread')],
    [`${mod} ,`, t('Preferences')],
  ];
  return (
    <Modal title={t('Keyboard shortcuts')} onClose={onClose} width={560}>
      <table className="shortcuts">
        <tbody>
          {rows.map(([k, label]) => (
            <tr key={k}>
              <td>{label}</td>
              <td>
                {k.split(' ').map((p, i) => (p === '/' ? ' / ' : <kbd key={i}>{p}</kbd>))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>{t('Formatting')}</h3>
      <table className="shortcuts">
        <tbody>
          <tr>
            <td>*{t('bold')}*</td>
            <td>
              <b>{t('bold')}</b>
            </td>
          </tr>
          <tr>
            <td>_{t('italic')}_</td>
            <td>
              <i>{t('italic')}</i>
            </td>
          </tr>
          <tr>
            <td>~{t('strike')}~</td>
            <td>
              <s>{t('strike')}</s>
            </td>
          </tr>
          <tr>
            <td>`code`</td>
            <td>
              <code>code</code>
            </td>
          </tr>
          <tr>
            <td>```{t('block')}```</td>
            <td>{t('Code block')}</td>
          </tr>
          <tr>
            <td>&gt; {t('quote')}</td>
            <td>{t('Blockquote')}</td>
          </tr>
          <tr>
            <td>- {t('item')}</td>
            <td>{t('Bulleted list')}</td>
          </tr>
        </tbody>
      </table>
    </Modal>
  );
}

export function ScheduleModal({ channelId, threadRootId, text, onDone, onClose }: { channelId: string; threadRootId: number | null; text: string; onDone?: () => void; onClose: () => void }) {
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  const [date, setDate] = useState(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  const [time, setTime] = useState(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
  const when = new Date(`${date}T${time}`).getTime();
  return (
    <Modal
      title={t('Schedule message')}
      onClose={onClose}
      width={460}
      footer={
        <button
          className="btn primary"
          disabled={!when || when < Date.now() + 60_000}
          onClick={async () => {
            try {
              await POST('/api/scheduled', { channelId, threadRootId, text, sendAt: when });
              toast(t('Message scheduled for {when}', { when: formatDateTime(when) }));
              onDone?.();
              onClose();
            } catch (e) {
              fail(e);
            }
          }}
        >
          {t('Schedule message')}
        </button>
      }
    >
      <div className="schedule-fields">
        <label className="field">
          <span className="field-label">{t('Date')}</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">{t('Time')}</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

export function ConfirmModal({
  title,
  body,
  danger,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  danger?: boolean;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            className={`btn ${danger ? 'danger-solid' : 'primary'}`}
            autoFocus
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              onClose();
              await onConfirm();
            }}
          >
            {confirmLabel ?? t('Confirm')}
          </button>
        </>
      }
    >
      <p>{body}</p>
    </Modal>
  );
}

export function RemindModal({ messageId, onClose }: { messageId: number; onClose: () => void }) {
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  const [date, setDate] = useState(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  const [time, setTime] = useState(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
  const when = new Date(`${date}T${time}`).getTime();
  return (
    <Modal
      title={t('Remind me about this message')}
      onClose={onClose}
      width={460}
      footer={
        <button
          className="btn primary"
          disabled={!when || when < Date.now()}
          onClick={async () => {
            await remindMe(messageId, when);
            onClose();
          }}
        >
          {t('Save')}
        </button>
      }
    >
      <div className="schedule-fields">
        <label className="field">
          <span className="field-label">{t('Date')}</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">{t('Time')}</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

const SECTION_EMOJI = ['📁', '⭐', '🔥', '🤝', '🚀', '💼', '🏗️', '🎯', '📣', '🧑‍💻', '🎨', '💬', '🛠️', '📚', '🌍', '🔒'];

export function SectionModal({ sectionId, channelId, onClose }: { sectionId?: string; channelId?: string; onClose: () => void }) {
  const sectionsRaw = useStore((s) => s.me?.prefs.sidebarSections);
  const sections = sectionsRaw ?? NO_SECTIONS;
  const existing = sections.find((x) => x.id === sectionId);
  const [name, setName] = useState(existing?.name ?? '');
  const [emoji, setEmoji] = useState(existing?.emoji ?? '📁');
  const save = () => {
    const clean = name.trim().toUpperCase();
    if (!clean) return;
    let next: SidebarSection[];
    if (existing) next = sections.map((x) => (x.id === existing.id ? { ...x, name: clean, emoji } : x));
    else {
      const id = `s${Date.now().toString(36)}`;
      // a channel can live in one section only
      const base = channelId ? sections.map((x) => ({ ...x, channelIds: x.channelIds.filter((c) => c !== channelId) })) : sections;
      next = [...base, { id, name: clean, emoji, channelIds: channelId ? [channelId] : [] }];
    }
    void updatePrefs({ sidebarSections: next });
    onClose();
  };
  return (
    <Modal
      title={existing ? t('Rename section') : t('Create a section')}
      subtitle={existing ? undefined : t('Use sections to organize your channels and conversations, e.g. by client, project or team.')}
      onClose={onClose}
      width={460}
      footer={
        <button className="btn primary" disabled={!name.trim()} onClick={save}>
          {existing ? t('Save') : t('Create')}
        </button>
      }
    >
      <div className="section-form">
        <div className="section-emoji-grid">
          {SECTION_EMOJI.map((e) => (
            <button key={e} className={emoji === e ? 'active' : ''} onClick={() => setEmoji(e)}>
              {e}
            </button>
          ))}
        </div>
        <input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. Clients')} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </div>
    </Modal>
  );
}
