import { Fragment, type ReactNode } from 'react';
import { S, useStore, userName } from '../store.ts';
import { nativeFor } from './emoji.ts';
import { openProfile, openChannel } from '../actions.ts';
import { t } from '../i18n.ts';

// ---------- inline ----------

// Patterns as strings: regex literals can't use \p{..} without the u flag in TS.
const INLINE = new RegExp(
  [
    String.raw`(?<shrug>¯\\_\(ツ\)_\/¯)`,
    String.raw`(?<code>` + '`' + String.raw`[^` + '`' + String.raw`\n]+` + '`' + ')',
    String.raw`(?<user><@[A-Z0-9]+>)`,
    String.raw`(?<chan><#[A-Z0-9]+(?:\|[^>]*)?>)`,
    String.raw`(?<special><!(?:here|channel|everyone)>)`,
    String.raw`(?<alink><https?:\/\/[^>|\s]+(?:\|[^>]+)?>)`,
    String.raw`(?<mdlink>\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))`,
    String.raw`(?<url>https?:\/\/[^\s<>]*[^\s<>.,:;"'!?)\]])`,
    String.raw`(?<emoji>:[a-z0-9_+\-]+(?:::skin-tone-[2-6])?:)`,
    String.raw`(?<bold2>\*\*(?=\S)[^\n]+?(?<=\S)\*\*)`,
    String.raw`(?<bold>(?<![\p{L}\p{N}*])\*(?=\S)[^*\n]+?(?<=\S)\*(?![\p{L}\p{N}*]))`,
    String.raw`(?<italic>(?<![\p{L}\p{N}_])_(?=\S)[^_\n]+?(?<=\S)_(?![\p{L}\p{N}_]))`,
    String.raw`(?<strike>(?<![\p{L}\p{N}~])~~?(?=\S)[^~\n]+?(?<=\S)~~?(?![\p{L}\p{N}~]))`,
  ].join('|'),
  'gu',
);

function UserMention({ id }: { id: string }) {
  const name = useStore((s) => s.users[id] && (s.users[id].displayName || s.users[id].fullName || s.users[id].username));
  const isMe = useStore((s) => s.me?.id === id);
  return (
    <span className={`mention${isMe ? ' mention-me' : ''}`} onClick={(e) => (e.stopPropagation(), openProfile(id))}>
      @{name || t('unknown user')}
    </span>
  );
}

function ChannelMention({ id, fallback }: { id: string; fallback?: string }) {
  const name = useStore((s) => s.channels[id]?.name);
  return (
    <span className="mention mention-channel" onClick={(e) => (e.stopPropagation(), openChannel(id))}>
      #{name || fallback || t('private-channel')}
    </span>
  );
}

export function Emoji({ code, size }: { code: string; size?: number }) {
  const custom = useStore((s) => s.customEmoji[code.split('::')[0]]);
  if (custom) return <img className="emoji-custom" src={custom} alt={`:${code}:`} title={`:${code}:`} style={size ? { width: size, height: size } : undefined} />;
  const native = nativeFor(code);
  if (!native) return <>{`:${code}:`}</>;
  return (
    <span className="emoji" title={`:${code}:`} style={size ? { fontSize: size } : undefined}>
      {native}
    </span>
  );
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  // in-app permalinks open inside the app
  const inApp = href.startsWith(location.origin + '/c/');
  return (
    <a
      href={href}
      target={inApp ? undefined : '_blank'}
      rel="noopener noreferrer"
      onClick={(e) => {
        e.stopPropagation();
        if (inApp) {
          e.preventDefault();
          const [, , channelId, msg] = new URL(href).pathname.split('/');
          openChannel(channelId, msg ? Number(msg) : undefined);
        }
      }}
    >
      {children}
    </a>
  );
}

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  INLINE.lastIndex = 0;
  const re = new RegExp(INLINE.source, INLINE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const g = m.groups!;
    const key = `${keyPrefix}-${k++}`;
    const s = m[0];
    if (g.shrug) out.push(s);
    else if (g.code) out.push(<code key={key}>{s.slice(1, -1)}</code>);
    else if (g.user) out.push(<UserMention key={key} id={s.slice(2, -1)} />);
    else if (g.chan) {
      const [id, name] = s.slice(2, -1).split('|');
      out.push(<ChannelMention key={key} id={id} fallback={name} />);
    } else if (g.special) out.push(<span key={key} className="mention mention-special">@{s.slice(2, -1)}</span>);
    else if (g.alink) {
      const [href, label] = s.slice(1, -1).split('|');
      out.push(<Link key={key} href={href}>{label ? renderInline(label, key) : href}</Link>);
    } else if (g.mdlink) {
      const mm = s.match(/^\[([^\]]+)\]\((.+)\)$/)!;
      out.push(<Link key={key} href={mm[2]}>{renderInline(mm[1], key)}</Link>);
    } else if (g.url) out.push(<Link key={key} href={s}>{s}</Link>);
    else if (g.emoji) out.push(<Emoji key={key} code={s.slice(1, -1)} />);
    else if (g.bold2) out.push(<b key={key}>{renderInline(s.slice(2, -2), key)}</b>);
    else if (g.bold) out.push(<b key={key}>{renderInline(s.slice(1, -1), key)}</b>);
    else if (g.italic) out.push(<i key={key}>{renderInline(s.slice(1, -1), key)}</i>);
    else if (g.strike) {
      const n = s.startsWith('~~') && s.endsWith('~~') ? 2 : 1;
      out.push(<s key={key}>{renderInline(s.slice(n, -n), key)}</s>);
    }
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function withBreaks(lines: string[], key: string) {
  return lines.map((l, i) => (
    <Fragment key={`${key}-${i}`}>
      {i > 0 && <br />}
      {renderInline(l, `${key}-${i}`)}
    </Fragment>
  ));
}

// ---------- blocks ----------

const UL = /^\s*[-*•]\s+/;
const OL = /^\s*\d+[.)]\s+/;
const QUOTE = /^(>|&gt;) ?/;

function renderBlocks(text: string, key: string): ReactNode[] {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const bk = `${key}-b${k++}`;
    if (QUOTE.test(line)) {
      const group: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) group.push(lines[i++].replace(QUOTE, ''));
      out.push(<blockquote key={bk}>{withBreaks(group, bk)}</blockquote>);
    } else if (UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL.test(lines[i])) items.push(lines[i++].replace(UL, ''));
      out.push(<ul key={bk}>{items.map((it, j) => <li key={j}>{renderInline(it, `${bk}-${j}`)}</li>)}</ul>);
    } else if (OL.test(line)) {
      const items: string[] = [];
      const start = Number(line.match(/\d+/)![0]);
      while (i < lines.length && OL.test(lines[i])) items.push(lines[i++].replace(OL, ''));
      out.push(<ol key={bk} start={start}>{items.map((it, j) => <li key={j}>{renderInline(it, `${bk}-${j}`)}</li>)}</ol>);
    } else {
      const group: string[] = [];
      while (i < lines.length && !QUOTE.test(lines[i]) && !UL.test(lines[i]) && !OL.test(lines[i])) group.push(lines[i++]);
      // trim leading/trailing empty lines produced by code blocks
      while (group.length && !group[0].trim() && out.length === 0) group.shift();
      while (group.length && !group[group.length - 1].trim()) group.pop();
      if (group.length) out.push(<span key={bk} className="p">{withBreaks(group, bk)}</span>);
    }
  }
  return out;
}

export function Mrkdwn({ text }: { text: string }) {
  const parts = text.split(/```([\s\S]*?)```/g);
  const out: ReactNode[] = [];
  parts.forEach((part, idx) => {
    if (idx % 2 === 1) {
      out.push(<pre key={`c${idx}`} className="code-block">{part.replace(/^\n/, '').replace(/\n$/, '')}</pre>);
    } else if (part) {
      out.push(...renderBlocks(part, `t${idx}`));
    }
  });
  return <>{out}</>;
}

/** Plain-text version (notifications, previews). */
export function toPlainText(text: string) {
  const s = S();
  return text
    .replace(/<@([A-Z0-9]+)>/g, (_, id) => `@${userName(id)}`)
    .replace(/<#([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `#${s.channels[id]?.name ?? 'channel'}`)
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/```([\s\S]*?)```/g, '$1')
    .replace(/:([a-z0-9_+\-]+(?:::skin-tone-[2-6])?):/g, (m, c) => nativeFor(c) ?? m);
}
