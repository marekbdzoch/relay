import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Hash, Lock, Megaphone } from './icons.tsx';
import { displayName, useStore } from '../store.ts';
import { t } from '../i18n.ts';
import { searchEmoji } from '../lib/emoji.ts';
import { Avatar, UserPresenceDot } from './ui.tsx';

export interface ComposerInputHandle {
  focus: () => void;
  insert: (text: string) => void;
  wrap: (before: string, after?: string, placeholder?: string) => void;
  prefixLines: (prefix: string | ((i: number) => string)) => void;
  startTrigger: (ch: string) => void;
  el: () => HTMLTextAreaElement | null;
}

export const SLASH_COMMANDS = [
  { cmd: 'me', args: '[text]', desc: 'Display action text' },
  { cmd: 'shrug', args: '[message]', desc: 'Appends ¯\\_(ツ)_/¯ to your message' },
  { cmd: 'topic', args: '[text]', desc: 'Set the channel topic' },
  { cmd: 'invite', args: '@user', desc: 'Invite someone to this channel' },
  { cmd: 'leave', args: '', desc: 'Leave the channel' },
  { cmd: 'status', args: ':emoji: [text]', desc: 'Set your status' },
  { cmd: 'away', args: '', desc: 'Toggle your away status' },
  { cmd: 'dnd', args: '[minutes]', desc: 'Pause notifications' },
  { cmd: 'search', args: '[query]', desc: 'Search messages' },
  { cmd: 'msg', args: '@user [message]', desc: 'Send a direct message' },
];

type Item =
  | { kind: 'user'; id: string; label: string; sub: string; insert: string }
  | { kind: 'special'; id: string; label: string; sub: string; insert: string }
  | { kind: 'channel'; id: string; label: string; private: boolean; insert: string }
  | { kind: 'emoji'; id: string; native?: string; url?: string; insert: string }
  | { kind: 'command'; id: string; label: string; sub: string; insert: string };

interface Trigger {
  char: '@' | '#' | ':' | '/';
  query: string;
  start: number; // index of trigger char
  end: number; // caret
}

function findTrigger(text: string, caret: number, slash: boolean): Trigger | null {
  const before = text.slice(0, caret);
  if (slash) {
    const m = before.match(/^\/([a-z]*)$/);
    if (m) return { char: '/', query: m[1], start: 0, end: caret };
  }
  const m = before.match(/(^|[\s(])([@#:])([\p{L}\p{N}._+\-]*)$/u);
  if (!m) return null;
  const char = m[2] as Trigger['char'];
  const query = m[3];
  if (char === ':' && query.length < 2) return null;
  return { char, query, start: caret - query.length - 1, end: caret };
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  channelId?: string;
  autoFocus?: boolean;
  slashCommands?: boolean;
  /** return true when the key was handled */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean | void;
  onPasteFiles?: (files: File[]) => void;
  onFocusChange?: (focused: boolean) => void;
  maxHeight?: number;
}

export const ComposerInput = forwardRef<ComposerInputHandle, Props>(function ComposerInput(
  { value, onChange, onSubmit, placeholder, channelId, autoFocus, slashCommands, onKeyDown, onPasteFiles, onFocusChange, maxHeight = 320 },
  ref,
) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [sel, setSel] = useState(0);
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const memberships = useStore((s) => s.memberships);
  const customEmoji = useStore((s) => s.customEmoji);
  const enterToSend = useStore((s) => s.me?.prefs.enterToSend !== false);
  const memberIds = useStore((s) => (channelId ? s.channels[channelId]?.memberIds : undefined));

  // autosize
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value, maxHeight]);

  useEffect(() => {
    if (autoFocus) ta.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const items = useMemo<Item[]>(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    if (trigger.char === '@') {
      const inChannel = new Set(memberIds ?? []);
      const list = Object.values(users)
        .filter((u) => !u.deactivated && (!q || u.username.toLowerCase().includes(q) || u.fullName.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q)))
        .sort((a, b) => {
          const ia = inChannel.has(a.id) ? 0 : 1;
          const ib = inChannel.has(b.id) ? 0 : 1;
          if (ia !== ib) return ia - ib;
          const sa = a.username.toLowerCase().startsWith(q) || a.fullName.toLowerCase().startsWith(q) ? 0 : 1;
          const sb = b.username.toLowerCase().startsWith(q) || b.fullName.toLowerCase().startsWith(q) ? 0 : 1;
          return sa - sb || displayName(a).localeCompare(displayName(b));
        })
        .slice(0, 8)
        .map((u): Item => ({ kind: 'user', id: u.id, label: displayName(u), sub: u.fullName !== displayName(u) ? u.fullName : `@${u.username}`, insert: `@${u.username} ` }));
      const specials: Item[] = [
        { kind: 'special', id: 'here', label: '@here', sub: t('Notify every online member in this channel.'), insert: '@here ' },
        { kind: 'special', id: 'channel', label: '@channel', sub: t('Notify everyone in this channel.'), insert: '@channel ' },
      ].filter((s) => s.id.startsWith(q)) as Item[];
      return [...list, ...(channelId ? specials : [])];
    }
    if (trigger.char === '#') {
      return Object.values(channels)
        .filter((c) => (c.kind === 'public' || (c.kind === 'private' && memberships[c.id])) && !c.archived && c.name.includes(q))
        .sort((a, b) => (memberships[b.id] ? 1 : 0) - (memberships[a.id] ? 1 : 0) || a.name.localeCompare(b.name))
        .slice(0, 8)
        .map((c): Item => ({ kind: 'channel', id: c.id, label: c.name, private: c.kind === 'private', insert: `#${c.name} ` }));
    }
    if (trigger.char === ':') {
      return searchEmoji(q, customEmoji, 8).map((e): Item => ({ kind: 'emoji', id: e.id, native: e.native, url: e.url, insert: e.native ? `${e.native} ` : `:${e.id}: ` }));
    }
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q)).map((c): Item => ({ kind: 'command', id: c.cmd, label: `/${c.cmd} ${c.args}`, sub: t(c.desc), insert: `/${c.cmd} ` }));
  }, [trigger, users, channels, memberships, customEmoji, memberIds, channelId]);

  const updateTrigger = (text: string, caret: number) => {
    const tr = findTrigger(text, caret, !!slashCommands);
    setTrigger(tr);
    setSel(0);
  };

  const replaceRange = (start: number, end: number, text: string) => {
    const el = ta.current!;
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    const caret = start + text.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const choose = (item: Item) => {
    if (!trigger) return;
    replaceRange(trigger.start, trigger.end, item.insert);
    setTrigger(null);
  };

  const handle: ComposerInputHandle = {
    focus: () => ta.current?.focus(),
    el: () => ta.current,
    insert: (text: string) => {
      const el = ta.current;
      const start = el?.selectionStart ?? value.length;
      const end = el?.selectionEnd ?? value.length;
      replaceRange(start, end, text);
    },
    wrap: (before: string, after = before, placeholder = '') => {
      const el = ta.current!;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const selected = value.slice(start, end) || placeholder;
      const next = value.slice(0, start) + before + selected + after + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + before.length, start + before.length + selected.length);
      });
    },
    prefixLines: (prefix) => {
      const el = ta.current!;
      const start = value.lastIndexOf('\n', el.selectionStart - 1) + 1;
      let end = value.indexOf('\n', el.selectionEnd);
      if (end === -1) end = value.length;
      const lines = value.slice(start, end).split('\n');
      const replaced = lines.map((l, i) => (typeof prefix === 'function' ? prefix(i) : prefix) + l).join('\n');
      onChange(value.slice(0, start) + replaced + value.slice(end));
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + replaced.length, start + replaced.length);
      });
    },
    startTrigger: (ch: string) => {
      const el = ta.current!;
      const pos = el.selectionStart;
      const needsSpace = pos > 0 && !/\s/.test(value[pos - 1]);
      const text = (needsSpace ? ' ' : '') + ch;
      const next = value.slice(0, pos) + text + value.slice(el.selectionEnd);
      onChange(next);
      const caret = pos + text.length;
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
        updateTrigger(next, caret);
      });
    },
  };
  useImperativeHandle(ref, () => handle);

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (trigger && items.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSel((s) => (s + 1) % items.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => (s - 1 + items.length) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        choose(items[sel]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setTrigger(null);
        return;
      }
    }
    if (onKeyDown?.(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      handle.wrap('*');
      return;
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      handle.wrap('_');
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      handle.wrap('~');
      return;
    }
    if (e.key === 'Enter') {
      // inside an open code block, Enter adds a newline
      const before = value.slice(0, e.currentTarget.selectionStart);
      const inCode = (before.match(/```/g)?.length ?? 0) % 2 === 1;
      const send = enterToSend ? !e.shiftKey && !e.altKey && !inCode && !mod : mod;
      if (send) {
        e.preventDefault();
        onSubmit();
      } else if (inCode && enterToSend && mod) {
        e.preventDefault();
        onSubmit();
      }
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length && onPasteFiles) {
      e.preventDefault();
      onPasteFiles(files);
    }
  };

  return (
    <div className="composer-input">
      <textarea
        ref={ta}
        value={value}
        rows={1}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          updateTrigger(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={handleKey}
        onClick={(e) => updateTrigger(value, e.currentTarget.selectionStart)}
        onPaste={onPaste}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => {
          onFocusChange?.(false);
          setTimeout(() => setTrigger(null), 150);
        }}
        spellCheck
      />
      {trigger && items.length > 0 && (
        <div className="autocomplete">
          <div className="autocomplete-head">
            {trigger.char === '@' ? t('People') : trigger.char === '#' ? t('Channels') : trigger.char === ':' ? t('Emoji matching “{q}”', { q: trigger.query }) : t('Commands')}
          </div>
          {items.map((it, i) => (
            <button
              key={`${it.kind}-${it.id}`}
              className={`ac-item${i === sel ? ' selected' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(it);
              }}
              onMouseEnter={() => setSel(i)}
            >
              {it.kind === 'user' && (
                <>
                  <Avatar userId={it.id} size={20} />
                  <span className="ac-label">{it.label}</span>
                  <UserPresenceDot userId={it.id} />
                  <span className="ac-sub">{it.sub}</span>
                </>
              )}
              {it.kind === 'special' && (
                <>
                  <span className="ac-icon">
                    <Megaphone size={16} />
                  </span>
                  <span className="ac-label">{it.label}</span>
                  <span className="ac-sub">{it.sub}</span>
                </>
              )}
              {it.kind === 'channel' && (
                <>
                  <span className="ac-icon">{it.private ? <Lock size={15} /> : <Hash size={15} />}</span>
                  <span className="ac-label">{it.label}</span>
                </>
              )}
              {it.kind === 'emoji' && (
                <>
                  <span className="ac-emoji">{it.native ?? <img src={it.url} alt="" />}</span>
                  <span className="ac-label">:{it.id}:</span>
                </>
              )}
              {it.kind === 'command' && (
                <>
                  <span className="ac-label">{it.label}</span>
                  <span className="ac-sub">{it.sub}</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
