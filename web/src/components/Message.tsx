import { memo, useRef, useState } from 'react';
import {
  AlarmClock,
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  Download,
  EllipsisVertical,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
  Forward,
  Headphones,
  MessageSquareText,
  Pin,
  SmilePlus,
  FileVideo,
  FileAudio,
  File as FileIcon,
  RotateCcw,
  Trash2,
} from './icons.tsx';
import type { FileInfo, Message, Unfurl } from '../../../shared/types.ts';
import { assetUrl } from '../api.ts';
import { S, displayName, isDmKind, set, useStore, userName } from '../store.ts';
import { t, tp } from '../i18n.ts';
import {
  copyLink,
  deleteMessage,
  remindMe,
  remindOptions,
  editMessage,
  markUnread,
  openModal,
  openProfile,
  openThread,
  removeLocal,
  retryMessage,
  setThreadFollow,
  toggleReaction,
  togglePin,
  toggleSaved,
} from '../actions.ts';
import { Emoji, Mrkdwn, toPlainText } from '../lib/mrkdwn.tsx';
import { isEmojiOnly, DEFAULT_QUICK_REACTIONS, nativeFor } from '../lib/emoji.ts';
import { fileKind, formatDateTime, formatSize, formatTime, timeAgo } from '../lib/format.ts';
import { decodeMessage, encodeMessage } from '../lib/composerText.ts';
import { joinHuddle } from '../lib/huddle.ts';
import { Avatar, Menu, MenuItem, MenuSep, Popover, StatusEmoji, SubmenuItem, Tip, usePopover } from './ui.tsx';
import { EmojiPickerPopover } from './EmojiPicker.tsx';
import { ComposerInput, type ComposerInputHandle } from './ComposerInput.tsx';

export type MessageContext = 'channel' | 'thread' | 'thread-root' | 'list';

// ---------- files ----------

function FileTypeIcon({ f }: { f: FileInfo }) {
  const kind = fileKind(f.mime, f.name);
  const map: Record<string, [React.ReactNode, string]> = {
    pdf: [<FileText size={22} />, '#e01e5a'],
    archive: [<FileArchive size={22} />, '#868686'],
    sheet: [<FileSpreadsheet size={22} />, '#2bac76'],
    doc: [<FileText size={22} />, '#1d9bd1'],
    code: [<FileCode size={22} />, '#4a154b'],
    video: [<FileVideo size={22} />, '#e8912d'],
    audio: [<FileAudio size={22} />, '#e8912d'],
    slides: [<FileText size={22} />, '#e8912d'],
    file: [<FileIcon size={22} />, '#868686'],
  };
  const [icon, color] = map[kind] ?? map.file;
  return (
    <span className="file-icon" style={{ background: color }}>
      {icon}
    </span>
  );
}

const COLLAPSED_KEY = 'relay.collapsedFiles';
function collapsedSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

/** Image / video previews have a "name ▾" header that collapses them, like Slack. */
function Collapsible({ f, children }: { f: FileInfo; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => collapsedSet().has(f.id));
  const toggle = () => {
    const set = collapsedSet();
    if (collapsed) set.delete(f.id);
    else set.add(f.id);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set].slice(-500)));
    } catch {
      /* ignore */
    }
    setCollapsed(!collapsed);
  };
  return (
    <div className="file-collapsible">
      <button className="file-collapse-head" onClick={toggle}>
        {f.name} <ChevronDown size={13} className={collapsed ? 'rot' : ''} />
      </button>
      {!collapsed && children}
    </div>
  );
}

export function FileCard({ f, messageId, collapsible = false }: { f: FileInfo; messageId?: number; collapsible?: boolean }) {
  const kind = fileKind(f.mime, f.name);
  const url = assetUrl(f.url);
  if (collapsible && (kind === 'image' || kind === 'video')) {
    return (
      <Collapsible f={f}>
        <FileCard f={f} messageId={messageId} />
      </Collapsible>
    );
  }
  if (kind === 'image') {
    const maxW = 360;
    const maxH = 360;
    let w = f.width ?? maxW;
    let h = f.height ?? 240;
    const scale = Math.min(1, maxW / w, maxH / h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    return (
      <div className="file-image" style={{ width: w, maxWidth: '100%' }}>
        <img
          src={url}
          alt={f.name}
          loading="lazy"
          style={{ aspectRatio: f.width && f.height ? `${f.width} / ${f.height}` : undefined }}
          onClick={() => messageId && openModal({ type: 'image', fileId: f.id, messageId })}
        />
        <a className="file-image-dl" href={`${url}?download=1`} download={f.name} title={t('Download')} onClick={(e) => e.stopPropagation()}>
          <Download size={14} />
        </a>
      </div>
    );
  }
  if (kind === 'video')
    return (
      <div className="file-media">
        <video src={url} controls preload="metadata" />
        <div className="file-media-name">{f.name}</div>
      </div>
    );
  if (kind === 'audio')
    return (
      <div className="file-media audio">
        <div className="file-media-name">{f.name}</div>
        <audio src={url} controls preload="metadata" />
      </div>
    );
  return (
    <a className="file-card" href={kind === 'pdf' ? url : `${url}?download=1`} target="_blank" rel="noreferrer" download={kind === 'pdf' ? undefined : f.name}>
      <FileTypeIcon f={f} />
      <span className="file-meta">
        <span className="file-name">{f.name}</span>
        <span className="file-sub">
          {f.name.split('.').pop()?.toUpperCase()} · {formatSize(f.size)}
        </span>
      </span>
      <span className="file-dl">
        <Download size={16} />
      </span>
    </a>
  );
}

function UnfurlCard({ u }: { u: Unfurl }) {
  return (
    <div className="unfurl">
      <div className="unfurl-body">
        <div className="unfurl-site">{u.siteName}</div>
        <a className="unfurl-title" href={u.url} target="_blank" rel="noopener noreferrer">
          {u.title}
        </a>
        {u.description && <div className="unfurl-desc">{u.description}</div>}
      </div>
      {u.image && <img className="unfurl-img" src={u.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
    </div>
  );
}

// ---------- reactions ----------

function Reactions({ m }: { m: Message }) {
  const meId = useStore((s) => s.me?.id);
  const users = useStore((s) => s.users);
  const add = usePopover();
  if (!m.reactions.length) return null;
  return (
    <div className="reactions">
      {m.reactions.map((r) => {
        const mine = !!meId && r.userIds.includes(meId);
        const names = r.userIds.map((id) => (id === meId ? t('You') : displayName(users[id]))).join(', ');
        return (
          <Tip key={r.emoji} label={t('{names} reacted with :{emoji}:', { names, emoji: r.emoji })}>
            <button className={`reaction${mine ? ' mine' : ''}`} onClick={() => void toggleReaction(m.id, r.emoji)}>
              <Emoji code={r.emoji} size={16} />
              <span className="reaction-count">{r.userIds.length}</span>
            </button>
          </Tip>
        );
      })}
      <button className="reaction reaction-add" ref={add.ref} onClick={add.toggle} aria-label={t('Add reaction')}>
        <SmilePlus size={16} />
      </button>
      {add.open && <EmojiPickerPopover anchor={add.ref.current} onClose={add.close} onPick={(e) => void toggleReaction(m.id, e.code)} placement="top-start" />}
    </div>
  );
}

// ---------- thread summary ----------

function ThreadSummary({ m }: { m: Message }) {
  if (!m.replyCount) return null;
  return (
    <button className="thread-summary" onClick={() => openThread(m.id, m.channelId)}>
      <span className="ts-avatars">
        {m.replyUserIds.slice(-5).map((id) => (
          <Avatar key={id} userId={id} size={24} />
        ))}
      </span>
      <span className="ts-count">{tp(m.replyCount, '{n} reply', '{n} replies')}</span>
      <span className="ts-last">{m.lastReplyAt ? t('Last reply {when}', { when: timeAgo(m.lastReplyAt) }) : ''}</span>
      <span className="ts-view">{t('View thread')}</span>
    </button>
  );
}

// ---------- edit box ----------

function EditBox({ m }: { m: Message }) {
  const [text, setText] = useState(() => decodeMessage(m.text));
  const ref = useRef<ComposerInputHandle>(null);
  const cancel = () => set((s) => void (s.editingId = null));
  const save = () => {
    const v = text.trim();
    if (!v && !m.files.length) return deleteMessage(m.id);
    if (encodeMessage(v) === m.text) return cancel();
    void editMessage(m.id, encodeMessage(v));
  };
  return (
    <div className="edit-box">
      <div className="composer focused">
        <ComposerInput
          ref={ref}
          value={text}
          onChange={setText}
          onSubmit={save}
          channelId={m.channelId}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
              return true;
            }
            return false;
          }}
        />
      </div>
      <div className="edit-actions">
        <button className="btn" onClick={cancel}>
          {t('Cancel')}
        </button>
        <button className="btn primary" onClick={save}>
          {t('Save')}
        </button>
      </div>
    </div>
  );
}

// ---------- system messages ----------

function SystemText({ m }: { m: Message }) {
  const ch = useStore((s) => s.channels[m.channelId]);
  const name = ch && !isDmKind(ch) ? `#${ch.name}` : '';
  switch (m.subtype) {
    case 'join':
      return m.text ? (
        <span className="sys">
          {t('was added to {channel} by', { channel: name })} <Mrkdwn text={m.text} />.
        </span>
      ) : (
        <span className="sys">{t('joined {channel}.', { channel: name })}</span>
      );
    case 'leave':
      return <span className="sys">{t('left {channel}.', { channel: name })}</span>;
    case 'topic':
      return (
        <span className="sys">
          {m.text ? t('set the channel topic:') : t('cleared the channel topic.')} {m.text && <Mrkdwn text={m.text} />}
        </span>
      );
    case 'description':
      return (
        <span className="sys">
          {m.text ? t('set the channel description:') : t('cleared the channel description.')} {m.text && <Mrkdwn text={m.text} />}
        </span>
      );
    case 'rename':
      return <span className="sys">{t('renamed the channel to #{name}.', { name: m.text })}</span>;
    case 'archive':
      return <span className="sys">{t('archived {channel}. The contents will still be browsable and available in search.', { channel: name })}</span>;
    case 'unarchive':
      return <span className="sys">{t('un-archived {channel}.', { channel: name })}</span>;
    case 'huddle':
      return <HuddleNotice m={m} />;
    case 'bridge':
      return <span className="sys">{t('connected this channel to {target}. Messages are now mirrored both ways.', { target: m.text })}</span>;
    default:
      return null;
  }
}

function HuddleNotice({ m }: { m: Message }) {
  const live = useStore((s) => s.huddles[m.channelId]);
  return (
    <span className="huddle-notice">
      <span className="hn-icon">
        <Headphones size={16} />
      </span>
      <span>
        <b>{live ? t('A huddle is happening') : t('A huddle started')}</b>
        {live && <span className="hn-count">{tp(live.participants.length, '{n} person', '{n} people')}</span>}
      </span>
      {live && (
        <button className="btn small primary" onClick={() => void joinHuddle(m.channelId)}>
          {t('Join')}
        </button>
      )}
    </span>
  );
}

// ---------- hover actions ----------

function MessageActions({ m, context, onMenuChange }: { m: Message; context: MessageContext; onMenuChange: (open: boolean) => void }) {
  const meId = useStore((s) => s.me?.id);
  const isAdminUser = useStore((s) => s.me?.role === 'owner' || s.me?.role === 'admin');
  const saved = useStore((s) => !!s.saved[m.id]);
  const recent = useStore((s) => s.me?.prefs.recentEmoji);
  const following = useStore((s) => s.threads[m.threadRootId ?? m.id]?.following);
  const emoji = usePopover();
  const more = usePopover();
  const mine = m.userId === meId;
  const quick = [...(recent ?? []), ...DEFAULT_QUICK_REACTIONS].filter((c, i, a) => a.indexOf(c) === i && nativeFor(c)).slice(0, 3);
  const setOpen = (fn: () => void, open: boolean) => {
    fn();
    onMenuChange(open);
  };
  const close = (fn?: () => void) => () => {
    more.close();
    onMenuChange(false);
    fn?.();
  };
  const isSystem = !!m.subtype && m.subtype !== 'bot';

  return (
    <div className={`msg-actions${emoji.open || more.open ? ' open' : ''}`}>
      {!isSystem &&
        quick.map((c) => (
          <Tip key={c} label={`:${c}:`}>
            <button onClick={() => void toggleReaction(m.id, c)}>
              <Emoji code={c} size={16} />
            </button>
          </Tip>
        ))}
      {!isSystem && (
        <Tip label={t('Find another reaction')}>
          <button ref={emoji.ref} onClick={() => setOpen(emoji.toggle, !emoji.open)}>
            <SmilePlus size={17} />
          </button>
        </Tip>
      )}
      {context === 'channel' && !isSystem && (
        <Tip label={t('Reply in thread')}>
          <button onClick={() => openThread(m.threadRootId ?? m.id, m.channelId)}>
            <MessageSquareText size={17} />
          </button>
        </Tip>
      )}
      {!isSystem && (
        <Tip label={t('Forward message')}>
          <button onClick={() => openModal({ type: 'forward', messageId: m.id })}>
            <Forward size={17} />
          </button>
        </Tip>
      )}
      <Tip label={saved ? t('Remove from Later') : t('Save for later')}>
        <button className={saved ? 'on' : ''} onClick={() => void toggleSaved(m.id)}>
          {saved ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}
        </button>
      </Tip>
      <Tip label={t('More actions')}>
        <button ref={more.ref} onClick={() => setOpen(more.toggle, !more.open)}>
          <EllipsisVertical size={17} />
        </button>
      </Tip>
      {emoji.open && (
        <EmojiPickerPopover
          anchor={emoji.ref.current}
          onClose={() => setOpen(emoji.close, false)}
          onPick={(e) => void toggleReaction(m.id, e.code)}
          placement="bottom-end"
        />
      )}
      {more.open && (
        <Popover anchor={more.ref.current} onClose={close()} placement="bottom-end">
          <Menu>
            {(m.replyCount > 0 || m.threadRootId) && (
              <MenuItem onClick={close(() => void setThreadFollow(m.threadRootId ?? m.id, following === false))}>
                {following === false ? t('Get notified about new replies') : t('Turn off notifications for replies')}
              </MenuItem>
            )}
            <MenuItem onClick={close(() => void markUnread(m))} hint="Alt+click">
              {t('Mark unread')}
            </MenuItem>
            {!isSystem && (
              <SubmenuItem label={t('Remind me')} icon={<AlarmClock size={15} />}>
                {(c) => (
                  <>
                    {remindOptions().map((o) => (
                      <MenuItem key={o.label} onClick={() => (c(), close(() => void remindMe(m.id, o.at))())}>
                        {o.label}
                      </MenuItem>
                    ))}
                    <MenuItem onClick={() => (c(), close(() => openModal({ type: 'remind', messageId: m.id }))())}>{t('Custom…')}</MenuItem>
                  </>
                )}
              </SubmenuItem>
            )}
            <MenuSep />
            <MenuItem onClick={close(() => copyLink(m))}>{t('Copy link')}</MenuItem>
            {!isSystem && <MenuItem onClick={close(() => void navigator.clipboard?.writeText(m.text))}>{t('Copy text')}</MenuItem>}
            {!isSystem && (
              <MenuItem icon={<Pin size={15} />} onClick={close(() => void togglePin(m.id))}>
                {m.pinnedBy ? t('Un-pin from channel') : t('Pin to channel')}
              </MenuItem>
            )}
            {mine && !isSystem && (
              <>
                <MenuSep />
                <MenuItem onClick={close(() => set((s) => void (s.editingId = m.id)))} hint="E">
                  {t('Edit message')}
                </MenuItem>
              </>
            )}
            {(mine || isAdminUser) && !isSystem && (
              <MenuItem danger onClick={close(() => void deleteMessage(m.id))} hint="Del">
                {t('Delete message…')}
              </MenuItem>
            )}
          </Menu>
        </Popover>
      )}
    </div>
  );
}

// ---------- message ----------

export const MessageItem = memo(function MessageItem({
  id,
  grouped = false,
  context = 'channel',
  highlighted = false,
}: {
  id: number;
  grouped?: boolean;
  context?: MessageContext;
  highlighted?: boolean;
}) {
  const m = useStore((s) => s.msgs[id]);
  const editing = useStore((s) => s.editingId === id);
  const saved = useStore((s) => !!s.saved[id]);
  const meId = useStore((s) => s.me?.id);
  const author = useStore((s) => (m?.userId ? s.users[m.userId] : undefined));
  const rootPreview = useStore((s) => (m?.alsoInChannel && m.threadRootId && context === 'channel' ? s.msgs[m.threadRootId] : undefined));
  const [menuOpen, setMenuOpen] = useState(false);
  if (!m) return null;

  const isSystem = !!m.subtype && m.subtype !== 'bot';
  const mentioned = !!meId && (m.text.includes(`<@${meId}>`) || /<!(channel|everyone|here)>/.test(m.text)) && m.userId !== meId;
  const name = m.botName ?? (author ? displayName(author) : t('Unknown'));
  const showHeader = !grouped || context === 'thread-root';
  const emojiOnly = !m.files.length && isEmojiOnly(m.text);

  const onClick = (e: React.MouseEvent) => {
    if (e.altKey && m.id > 0) {
      e.preventDefault();
      void markUnread(m);
    }
  };

  const classes = [
    'msg',
    showHeader ? 'with-header' : 'grouped',
    highlighted ? 'highlighted' : '',
    m.pinnedBy ? 'pinned' : '',
    saved ? 'saved' : '',
    mentioned ? 'mentioned' : '',
    m.pending ? 'pending' : '',
    m.failed ? 'failed' : '',
    editing ? 'editing' : '',
    menuOpen ? 'menu-open' : '',
    isSystem ? 'system' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} data-id={m.id} onClick={onClick}>
      {(m.pinnedBy || saved) && (
        <div className="msg-label">
          {saved && (
            <span className="label-saved">
              <Bookmark size={12} /> {t('Saved for later')}
            </span>
          )}
          {m.pinnedBy && (
            <span className="label-pinned">
              <Pin size={12} /> {t('Pinned by {name}', { name: m.pinnedBy === meId ? t('you') : userName(m.pinnedBy) })}
            </span>
          )}
        </div>
      )}
      {rootPreview && (
        <div className="msg-label thread-broadcast">
          {t('replied to a thread:')}{' '}
          <button className="link" onClick={() => openThread(rootPreview.id, m.channelId)}>
            {toPlainText(rootPreview.text).replace(/[*_~`]/g, '').slice(0, 80) || t('View thread')}
          </button>
        </div>
      )}
      <div className="msg-row">
        <div className="msg-gutter">
          {showHeader ? (
            m.botName ? (
              <span className="avatar bot-avatar" style={{ width: 36, height: 36 }}>
                {m.botName.slice(0, 1).toUpperCase()}
              </span>
            ) : (
              <Avatar user={author} size={36} onClick={() => m.userId && openProfile(m.userId)} />
            )
          ) : (
            <Tip label={formatDateTime(m.createdAt)}>
              <span className="msg-hover-time">{formatTime(m.createdAt)}</span>
            </Tip>
          )}
        </div>
        <div className="msg-content">
          {showHeader && (
            <div className="msg-header">
              <button className="msg-author" onClick={() => m.userId && openProfile(m.userId)}>
                {name}
              </button>
              {m.botName && <span className="app-badge">{t('APP')}</span>}
              {author?.external === 'agent' && <span className="agent-badge">{t('AGENT')}</span>}
              {author?.external === 'slack' && <span className="slack-badge" title={t('Writes from Slack')}>Slack</span>}
              {m.userId && <StatusEmoji userId={m.userId} />}
              <Tip label={formatDateTime(m.createdAt)}>
                <span className="msg-time">{formatTime(m.createdAt)}</span>
              </Tip>
            </div>
          )}
          {editing ? (
            <EditBox m={m} />
          ) : m.deleted ? (
            <div className="msg-text deleted">{t('This message was deleted.')}</div>
          ) : (
            <>
              {isSystem ? (
                <div className="msg-text">
                  <SystemText m={m} />
                </div>
              ) : (
                m.text && (
                  <div className={`msg-text${emojiOnly ? ' jumbo' : ''}`}>
                    <Mrkdwn text={m.text} />
                    {m.editedAt && <span className="edited"> {t('(edited)')}</span>}
                  </div>
                )
              )}
              {m.files.length > 0 && (
                <div className="msg-files">
                  {m.files.map((f) => (
                    <FileCard key={f.id} f={f} messageId={m.id} collapsible />
                  ))}
                </div>
              )}
              {m.unfurls.map((u) => (
                <UnfurlCard key={u.url} u={u} />
              ))}
              <Reactions m={m} />
              {context === 'channel' && <ThreadSummary m={m} />}
              {m.failed && (
                <div className="msg-failed">
                  {t('Message not sent.')}{' '}
                  <button className="link" onClick={() => void retryMessage(m.id)}>
                    <RotateCcw size={12} /> {t('Retry')}
                  </button>{' '}
                  <button className="link danger" onClick={() => removeLocal(m.id)}>
                    <Trash2 size={12} /> {t('Delete')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {!editing && m.id > 0 && !m.deleted && context !== 'list' && <MessageActions m={m} context={context} onMenuChange={setMenuOpen} />}
    </div>
  );
});

/** Whether `m` should be displayed collapsed under `prev`. */
export function shouldGroup(prev: Message | undefined, m: Message) {
  if (!prev) return false;
  if (prev.userId !== m.userId || prev.botName !== m.botName) return false;
  if ((prev.subtype && prev.subtype !== 'bot') || (m.subtype && m.subtype !== 'bot')) return false;
  if (m.alsoInChannel && m.threadRootId) return false;
  if (m.pinnedBy || S().saved[m.id]) return false;
  return m.createdAt - prev.createdAt < 5 * 60_000 && new Date(m.createdAt).toDateString() === new Date(prev.createdAt).toDateString();
}
