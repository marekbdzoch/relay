import { useEffect, useRef, useState } from 'react';
import {
  AtSign,
  Bold,
  ChevronDown,
  Code,
  Italic,
  Link,
  List,
  ListOrdered,
  Plus,
  SendHorizontal,
  Smile,
  SquareCode,
  Strikethrough,
  TextQuote,
  Type,
  X,
  Paperclip,
  Clock,
  FileText,
  Mic,
  Video,
  SquareSlash,
} from './icons.tsx';
import { ClipRecorder } from './ClipRecorder.tsx';
import type { FileInfo } from '../../../shared/types.ts';
import { upload, PATCH, POST } from '../api.ts';
import { S, channelTitle, draftKey, isDmKind, set, toast, useStore } from '../store.ts';
import { t } from '../i18n.ts';
import { fail, leaveChannel, openDm, saveDraft, sendMessage, sendTyping, setAway, setDnd, setStatus, openModal, rememberEmoji } from '../actions.ts';
import { encodeMessage } from '../lib/composerText.ts';
import { formatSize } from '../lib/format.ts';
import { navigate } from '../lib/nav.ts';
import { ComposerInput, type ComposerInputHandle } from './ComposerInput.tsx';
import { EmojiPickerPopover } from './EmojiPicker.tsx';
import { Menu, MenuItem, Popover, Tip, usePopover } from './ui.tsx';

interface Upload {
  key: number;
  file: File;
  progress: number;
  info?: FileInfo;
  error?: string;
  abort?: () => void;
  preview?: string;
}

let uploadSeq = 0;

export function useUploads() {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const add = (files: File[]) => {
    for (const file of files) {
      const key = ++uploadSeq;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      const job = upload<FileInfo[]>('/api/files', [file], (p) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))));
      setUploads((u) => [...u, { key, file, progress: 0, abort: job.abort, preview }]);
      job.promise
        .then((infos) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, info: infos[0], progress: 1 } : x))))
        .catch((e) => {
          fail(e);
          setUploads((u) => u.filter((x) => x.key !== key));
        });
    }
  };
  const remove = (key: number) =>
    setUploads((u) => {
      const it = u.find((x) => x.key === key);
      it?.abort?.();
      if (it?.preview) URL.revokeObjectURL(it.preview);
      return u.filter((x) => x.key !== key);
    });
  const clear = () => setUploads([]);
  return { uploads, add, remove, clear, ready: uploads.every((u) => u.info), files: uploads.map((u) => u.info!).filter(Boolean) };
}

export function UploadList({ uploads, onRemove }: { uploads: Upload[]; onRemove: (key: number) => void }) {
  if (!uploads.length) return null;
  return (
    <div className="composer-files">
      {uploads.map((u) => (
        <div key={u.key} className={`cf-item${u.preview ? ' image' : ''}`}>
          {u.preview ? (
            <img src={u.preview} alt="" />
          ) : (
            <div className="cf-file">
              <span className="cf-file-icon">
                <FileText size={18} />
              </span>
              <span className="cf-file-meta">
                <span className="cf-file-name">{u.file.name}</span>
                <span className="cf-file-size">{formatSize(u.file.size)}</span>
              </span>
            </div>
          )}
          {!u.info && (
            <div className="cf-progress">
              <div style={{ width: `${Math.round(u.progress * 100)}%` }} />
            </div>
          )}
          <button className="cf-remove" onClick={() => onRemove(u.key)} aria-label={t('Remove')}>
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

async function runSlash(text: string, channelId: string): Promise<string | null> {
  const m = text.match(/^\/(\w+)\s*([\s\S]*)$/);
  if (!m) return text;
  const [, cmd, rest] = m;
  const arg = rest.trim();
  switch (cmd) {
    case 'me':
      return arg ? `_${arg}_` : null;
    case 'shrug':
      return `${arg ? arg + ' ' : ''}¯\\_(ツ)_/¯`;
    case 'topic':
      await PATCH(`/api/channels/${channelId}`, { topic: arg }).catch(fail);
      return null;
    case 'leave':
      leaveChannel(channelId);
      return null;
    case 'away':
      await setAway(!S().me?.awayManual);
      return null;
    case 'active':
      await setAway(false);
      return null;
    case 'dnd': {
      const mins = Number(arg) || 60;
      await setDnd(arg === 'off' ? null : Date.now() + mins * 60_000);
      return null;
    }
    case 'status': {
      const sm = arg.match(/^:([^:\s]+):\s*(.*)$/);
      if (sm) await setStatus(sm[1], sm[2], null);
      else await setStatus('speech_balloon', arg, null);
      toast(t('Status updated'));
      return null;
    }
    case 'search':
      navigate(`/search?q=${encodeURIComponent(arg)}`);
      return null;
    case 'invite': {
      const names = [...arg.matchAll(/@([\p{L}\p{N}._-]+)/gu)].map((x) => x[1].toLowerCase());
      const ids = Object.values(S().users)
        .filter((u) => names.includes(u.username.toLowerCase()))
        .map((u) => u.id);
      if (!ids.length) {
        toast(t('No matching people found.'), 'error');
        return null;
      }
      await POST(`/api/channels/${channelId}/members`, { userIds: ids }).catch(fail);
      return null;
    }
    case 'msg': {
      const mm = arg.match(/^@([\p{L}\p{N}._-]+)\s*([\s\S]*)$/u);
      const user = mm && Object.values(S().users).find((u) => u.username.toLowerCase() === mm[1].toLowerCase());
      if (!user) {
        toast(t('No matching people found.'), 'error');
        return null;
      }
      const ch = await openDm([user.id]);
      if (ch && mm![2].trim()) await sendMessage(ch.id, encodeMessage(mm![2].trim()));
      return null;
    }
    default:
      toast(t('“/{cmd}” is not a valid command.', { cmd }), 'error');
      return undefined as unknown as null;
  }
}

export function Composer({ channelId, threadRootId = null, placeholder, autoFocus = true }: { channelId: string; threadRootId?: number | null; placeholder?: string; autoFocus?: boolean }) {
  const key = draftKey(channelId, threadRootId);
  const initial = useRef(S().drafts[key]?.text ?? '');
  const [text, setText] = useState(initial.current);
  const [alsoInChannel, setAlsoInChannel] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const showFormatting = useStore((s) => s.me?.prefs.compact !== true);
  const [formatting, setFormatting] = useState(showFormatting);
  const channel = useStore((s) => s.channels[channelId]);
  const meId = useStore((s) => s.me?.id);
  const input = useRef<ComposerInputHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const emoji = usePopover();
  const plus = usePopover();
  const sched = usePopover();
  const videoClip = usePopover();
  const audioClip = usePopover();
  const up = useUploads();

  // external drafts (other device) when the composer is empty
  const remoteDraft = useStore((s) => s.drafts[key]?.text);
  useEffect(() => {
    if (!focused && remoteDraft !== undefined && remoteDraft !== text && !text) setText(remoteDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteDraft]);

  // files dropped on the channel view
  useEffect(() => {
    const onDrop = (e: Event) => {
      const d = (e as CustomEvent<{ files: File[]; target: string }>).detail;
      if (d.target === key) up.add(d.files);
    };
    window.addEventListener('relay:files', onDrop);
    return () => window.removeEventListener('relay:files', onDrop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const onChange = (v: string) => {
    setText(v);
    saveDraft(channelId, threadRootId, v);
    if (v.trim()) sendTyping(channelId, threadRootId);
  };

  const canSend = (text.trim().length > 0 || up.files.length > 0) && up.ready;

  const submit = async () => {
    if (!canSend) return;
    let raw = text.trim();
    if (raw.startsWith('/') && !up.files.length) {
      const result = await runSlash(raw, channelId);
      if (result === undefined) return; // invalid command: keep the text
      if (result === null) {
        setText('');
        saveDraft(channelId, threadRootId, '');
        return;
      }
      raw = result;
    }
    const files = up.files;
    setText('');
    up.clear();
    saveDraft(channelId, threadRootId, '');
    setAlsoInChannel(false);
    await sendMessage(channelId, encodeMessage(raw), { threadRootId, alsoInChannel: threadRootId ? alsoInChannel : undefined, files });
  };

  const scheduleFor = (sendAt: number) => {
    if (!text.trim()) return;
    const body = encodeMessage(text.trim());
    void POST('/api/scheduled', { channelId, threadRootId, text: body, sendAt })
      .then(() => {
        setText('');
        saveDraft(channelId, threadRootId, '');
        toast(t('Message scheduled for {when}', { when: new Date(sendAt).toLocaleString() }));
      })
      .catch(fail);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'ArrowUp' && !text && !e.shiftKey) {
      // edit last own message
      const s = S();
      const ids = threadRootId ? s.threads[threadRootId]?.ids ?? [] : s.chan[channelId]?.ids ?? [];
      // includes a just-sent message that is still waiting for the server (negative id); it is remapped on arrival
      const last = [...ids].reverse().find((id) => s.msgs[id]?.userId === s.me?.id && !s.msgs[id]?.subtype && !s.msgs[id]?.deleted);
      if (last) {
        e.preventDefault();
        set((st) => void (st.editingId = last));
        return true;
      }
    }
    return false;
  };

  const title = channel ? (isDmKind(channel) ? channelTitle(channel, meId) : `#${channel.name}`) : '';
  const ph = placeholder ?? (threadRootId ? t('Reply…') : t('Message {name}', { name: title }));

  const tomorrow9 = new Date();
  tomorrow9.setDate(tomorrow9.getDate() + 1);
  tomorrow9.setHours(9, 0, 0, 0);
  const monday9 = new Date();
  monday9.setDate(monday9.getDate() + ((8 - monday9.getDay()) % 7 || 7));
  monday9.setHours(9, 0, 0, 0);

  return (
    <div className="composer-wrap">
      <div
        className={`composer${focused ? ' focused' : ''}${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            e.stopPropagation();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          e.stopPropagation();
          setDragging(false);
          up.add([...e.dataTransfer.files]);
        }}
      >
        {formatting && (
          <div className="composer-format">
            <Tip label={`${t('Bold')} ⌘B`}>
              <button onClick={() => input.current?.wrap('*')}>
                <Bold size={16} />
              </button>
            </Tip>
            <Tip label={`${t('Italic')} ⌘I`}>
              <button onClick={() => input.current?.wrap('_')}>
                <Italic size={16} />
              </button>
            </Tip>
            <Tip label={`${t('Strikethrough')} ⌘⇧X`}>
              <button onClick={() => input.current?.wrap('~')}>
                <Strikethrough size={16} />
              </button>
            </Tip>
            <span className="cf-sep" />
            <Tip label={t('Link')}>
              <button
                onClick={() => {
                  const url = prompt(t('Link URL'), 'https://');
                  if (url && /^https?:\/\//.test(url)) input.current?.wrap('[', `](${url})`, t('link text'));
                }}
              >
                <Link size={16} />
              </button>
            </Tip>
            <span className="cf-sep" />
            <Tip label={t('Ordered list')}>
              <button onClick={() => input.current?.prefixLines((i) => `${i + 1}. `)}>
                <ListOrdered size={16} />
              </button>
            </Tip>
            <Tip label={t('Bulleted list')}>
              <button onClick={() => input.current?.prefixLines('- ')}>
                <List size={16} />
              </button>
            </Tip>
            <span className="cf-sep" />
            <Tip label={t('Blockquote')}>
              <button onClick={() => input.current?.prefixLines('> ')}>
                <TextQuote size={16} />
              </button>
            </Tip>
            <Tip label={t('Code')}>
              <button onClick={() => input.current?.wrap('`')}>
                <Code size={16} />
              </button>
            </Tip>
            <Tip label={t('Code block')}>
              <button onClick={() => input.current?.wrap('```\n', '\n```')}>
                <SquareCode size={16} />
              </button>
            </Tip>
          </div>
        )}
        <ComposerInput
          ref={input}
          value={text}
          onChange={onChange}
          onSubmit={() => void submit()}
          placeholder={ph}
          channelId={channelId}
          autoFocus={autoFocus}
          slashCommands={!threadRootId}
          onKeyDown={onKeyDown}
          onPasteFiles={up.add}
          onFocusChange={setFocused}
        />
        <UploadList uploads={up.uploads} onRemove={up.remove} />
        <div className="composer-bar">
          <div className="composer-left">
            <button className="cb-btn cb-plus" ref={plus.ref} onClick={plus.toggle} aria-label={t('Attach')}>
              <Plus size={18} />
            </button>
            {plus.open && (
              <Popover anchor={plus.ref.current} onClose={plus.close} placement="top-start">
                <Menu>
                  <MenuItem
                    icon={<Paperclip size={16} />}
                    onClick={() => {
                      plus.close();
                      fileInput.current?.click();
                    }}
                  >
                    {t('Upload from your computer')}
                  </MenuItem>
                  <MenuItem
                    icon={<SquareCode size={16} />}
                    onClick={() => {
                      plus.close();
                      input.current?.wrap('```\n', '\n```');
                    }}
                  >
                    {t('Code snippet')}
                  </MenuItem>
                </Menu>
              </Popover>
            )}
            <Tip label={formatting ? t('Hide formatting') : t('Show formatting')}>
              <button className={`cb-btn${formatting ? ' on' : ''}`} onClick={() => setFormatting(!formatting)}>
                <Type size={16} />
              </button>
            </Tip>
            <Tip label={t('Emoji')}>
              <button className="cb-btn" ref={emoji.ref} onClick={emoji.toggle}>
                <Smile size={17} />
              </button>
            </Tip>
            {emoji.open && (
              <EmojiPickerPopover
                anchor={emoji.ref.current}
                onClose={emoji.close}
                onPick={(e) => {
                  rememberEmoji(e.code);
                  input.current?.insert(e.native ?? `:${e.code}:`);
                }}
              />
            )}
            <Tip label={t('Mention someone')}>
              <button className="cb-btn" onClick={() => input.current?.startTrigger('@')}>
                <AtSign size={16} />
              </button>
            </Tip>
            <span className="cf-sep" />
            <Tip label={t('Record video clip')}>
              <button className="cb-btn" ref={videoClip.ref} onClick={videoClip.toggle}>
                <Video size={17} />
              </button>
            </Tip>
            <Tip label={t('Record audio clip')}>
              <button className="cb-btn" ref={audioClip.ref} onClick={audioClip.toggle}>
                <Mic size={16} />
              </button>
            </Tip>
            {videoClip.open && <ClipRecorder kind="video" anchor={videoClip.ref.current} onClose={videoClip.close} onDone={(f) => up.add([f])} />}
            {audioClip.open && <ClipRecorder kind="audio" anchor={audioClip.ref.current} onClose={audioClip.close} onDone={(f) => up.add([f])} />}
            {!threadRootId && (
              <>
                <span className="cf-sep" />
                <Tip label={t('Run a shortcut')}>
                  <button
                    className="cb-btn"
                    onClick={() => {
                      if (!text) input.current?.startTrigger('/');
                      else input.current?.focus();
                    }}
                  >
                    <SquareSlash size={16} />
                  </button>
                </Tip>
              </>
            )}
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                up.add([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </div>
          <div className={`send-group${canSend ? ' active' : ''}`}>
            <button className="send-btn" onClick={() => void submit()} disabled={!canSend} aria-label={t('Send now')}>
              <SendHorizontal size={16} />
            </button>
            <span className="send-sep" />
            <button className="send-more" ref={sched.ref} onClick={sched.toggle} disabled={!text.trim()} aria-label={t('Schedule for later')}>
              <ChevronDown size={14} />
            </button>
            {sched.open && (
              <Popover anchor={sched.ref.current} onClose={sched.close} placement="top-end">
                <Menu>
                  <div className="menu-header">{t('Schedule message')}</div>
                  <MenuItem icon={<Clock size={15} />} onClick={() => (sched.close(), scheduleFor(tomorrow9.getTime()))} hint={tomorrow9.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}>
                    {t('Tomorrow')}
                  </MenuItem>
                  <MenuItem icon={<Clock size={15} />} onClick={() => (sched.close(), scheduleFor(monday9.getTime()))} hint={monday9.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}>
                    {t('Next Monday')}
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      sched.close();
                      openModal({
                        type: 'schedule',
                        channelId,
                        threadRootId,
                        text: encodeMessage(text.trim()),
                        onDone: () => {
                          setText('');
                          saveDraft(channelId, threadRootId, '');
                        },
                      });
                    }}
                  >
                    {t('Custom time')}
                  </MenuItem>
                </Menu>
              </Popover>
            )}
          </div>
        </div>
      </div>
      {threadRootId && channel && (
        <label className="also-send">
          <input type="checkbox" checked={alsoInChannel} onChange={(e) => setAlsoInChannel(e.target.checked)} />
          {isDmKind(channel) ? t('Also send as direct message') : t('Also send to #{name}', { name: channel.name })}
        </label>
      )}
      <TypingIndicator channelId={channelId} threadRootId={threadRootId} />
    </div>
  );
}

export function TypingIndicator({ channelId, threadRootId }: { channelId: string; threadRootId: number | null }) {
  const typing = useStore((s) => s.typing[draftKey(channelId, threadRootId)]);
  const users = useStore((s) => s.users);
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 2000);
    return () => clearInterval(id);
  }, []);
  const now = Date.now();
  const ids = Object.entries(typing ?? {})
    .filter(([, until]) => until > now)
    .map(([id]) => id);
  const names = ids.map((id) => users[id]?.displayName || users[id]?.fullName || '?');
  let label = '';
  if (names.length === 1) label = t('{name} is typing…', { name: names[0] });
  else if (names.length === 2) label = t('{a} and {b} are typing…', { a: names[0], b: names[1] });
  else if (names.length > 2) label = t('Several people are typing…');
  return <div className="typing">{label}</div>;
}
