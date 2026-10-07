import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ChevronDown, Hash, Lock, UserPlus, Pencil } from './icons.tsx';
import type { Message } from '../../../shared/types.ts';
import { channelTitle, dmPartner, useStore, displayName } from '../store.ts';
import { t } from '../i18n.ts';
import { fail, jumpToPresent, loadChannel, loadNewer, loadOlder, markRead, openModal, openProfile, suppressAutoRead } from '../actions.ts';
import { GET } from '../api.ts';
import { set } from '../store.ts';
import { channelPath, navigate } from '../lib/nav.ts';
import { formatDay, startOfDay, formatLongDate } from '../lib/format.ts';
import { MessageItem, shouldGroup } from './Message.tsx';
import { Avatar, Menu, MenuItem, MenuSep, Popover, Spinner, usePopover } from './ui.tsx';

function ChannelIntro({ channelId }: { channelId: string }) {
  const ch = useStore((s) => s.channels[channelId]);
  const meId = useStore((s) => s.me?.id);
  const creator = useStore((s) => (ch?.createdBy ? s.users[ch.createdBy] : undefined));
  const partnerId = dmPartner(ch);
  const partner = useStore((s) => (partnerId ? s.users[partnerId] : undefined));
  if (!ch) return null;
  if (ch.kind === 'dm' && partner) {
    const self = partner.id === meId;
    return (
      <div className="channel-intro">
        <div className="intro-profile">
          <Avatar user={partner} size={96} />
          <div>
            <h2 className="intro-name" onClick={() => openProfile(partner.id)}>
              {displayName(partner)}
            </h2>
            {partner.title && <div className="intro-title">{partner.title}</div>}
          </div>
        </div>
        <p>
          {self
            ? t('This is your space. Draft messages, list your to-dos, or keep links and files handy. You can also talk to yourself here, but please bear in mind you’ll have to supply both sides of the conversation.')
            : t('This conversation is just between you and {name}. Check out their profile to learn more about them.', { name: displayName(partner) })}
        </p>
        {!self && (
          <button className="btn" onClick={() => openProfile(partner.id)}>
            {t('View profile')}
          </button>
        )}
      </div>
    );
  }
  if (ch.kind === 'group') {
    return (
      <div className="channel-intro">
        <div className="intro-faces">
          {(ch.memberIds ?? []).filter((id) => id !== meId).slice(0, 6).map((id) => (
            <Avatar key={id} userId={id} size={56} />
          ))}
        </div>
        <p>{t('This is the very beginning of your direct message history with {names}.', { names: channelTitle(ch, meId) })}</p>
      </div>
    );
  }
  return (
    <div className="channel-intro">
      <h1 className="intro-channel">
        {ch.kind === 'private' ? <Lock size={28} /> : <Hash size={30} />}
        {ch.name}
      </h1>
      <p>
        {creator
          ? t('{name} created this channel on {date}. This is the very beginning of the #{channel} channel.', { name: `@${displayName(creator)}`, date: formatLongDate(ch.createdAt), channel: ch.name })
          : t('This is the very beginning of the #{channel} channel.', { channel: ch.name })}{' '}
        {ch.description}
      </p>
      <div className="intro-actions">
        <button className="btn" onClick={() => openModal({ type: 'channelDetails', channelId: ch.id, tab: 'about' })}>
          <Pencil size={14} /> {t('Add description')}
        </button>
        <button className="btn" onClick={() => openModal({ type: 'addMembers', channelId: ch.id })}>
          <UserPlus size={14} /> {t('Add coworkers')}
        </button>
      </div>
    </div>
  );
}

function DayDivider({ ts, channelId }: { ts: number; channelId: string }) {
  const pop = usePopover<HTMLButtonElement>();
  const [picking, setPicking] = useState(false);
  const jump = async (at: number | 'recent') => {
    pop.close();
    if (at === 'recent') return void jumpToPresent(channelId);
    try {
      const r = await GET<{ id: number | null }>(`/api/channels/${channelId}/message-at?ts=${at}`);
      if (r.id) {
        set((s) => void delete s.chan[channelId]);
        navigate(channelPath(channelId, r.id));
      }
    } catch (e) {
      fail(e);
    }
  };
  const day = 86400_000;
  return (
    <div className="day-divider">
      <button className="day-pill" ref={pop.ref} onClick={pop.toggle}>
        {formatDay(ts)} <ChevronDown size={12} />
      </button>
      {pop.open && (
        <Popover anchor={pop.ref.current} onClose={() => (pop.close(), setPicking(false))} placement="bottom-start">
          <Menu>
            <div className="menu-header">{t('Jump to…')}</div>
            <MenuItem onClick={() => void jump('recent')}>{t('Most recent')}</MenuItem>
            <MenuItem onClick={() => void jump(startOfDay(Date.now()) - 7 * day)}>{t('Last week')}</MenuItem>
            <MenuItem onClick={() => void jump(startOfDay(Date.now()) - 30 * day)}>{t('Last month')}</MenuItem>
            <MenuItem onClick={() => void jump(0)}>{t('The very beginning')}</MenuItem>
            <MenuSep />
            {picking ? (
              <div className="menu-date">
                <input type="date" autoFocus onChange={(e) => e.target.value && void jump(new Date(`${e.target.value}T00:00`).getTime())} />
              </div>
            ) : (
              <MenuItem onClick={() => setPicking(true)}>{t('Jump to a specific date…')}</MenuItem>
            )}
          </Menu>
        </Popover>
      )}
    </div>
  );
}

export function MessageList({ channelId, focusId }: { channelId: string; focusId?: number }) {
  const chan = useStore((s) => s.chan[channelId]);
  const msgs = useStore((s) => s.msgs);
  const marker = useStore((s) => s.unreadMarker[channelId]);
  const highlightId = useStore((s) => s.highlightId);
  const focused = useStore((s) => s.focused);
  const meId = useStore((s) => s.me?.id);
  const isMember = useStore((s) => !!s.memberships[channelId]);
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevHeight = useRef(0);
  const prevFirst = useRef<number | undefined>(undefined);
  const initialScrollDone = useRef(false);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    initialScrollDone.current = false;
    atBottom.current = true;
    void loadChannel(channelId, focusId);
  }, [channelId, focusId]);

  const ids = chan?.ids ?? [];

  // keep position when older messages are prepended, stick to bottom when new ones arrive
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !chan?.loaded) return;
    const first = ids[0];
    if (!initialScrollDone.current) {
      initialScrollDone.current = true;
      const target = focusId ? el.querySelector(`[data-id="${focusId}"]`) : marker !== undefined ? el.querySelector('.new-divider') : null;
      if (target) {
        (target as HTMLElement).scrollIntoView({ block: focusId ? 'center' : 'start' });
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        if (!focusId && atBottom.current) el.scrollTop = el.scrollHeight;
      } else el.scrollTop = el.scrollHeight;
    } else if (prevFirst.current !== undefined && first !== prevFirst.current && ids.indexOf(prevFirst.current) > 0) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, chan?.loaded]);

  // images and unfurls change heights after render
  useEffect(() => {
    const el = scroller.current;
    const content = inner.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
      prevHeight.current = el.scrollHeight;
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // mark as read while looking at the bottom of the channel
  const lastId = [...ids].reverse().find((id) => id > 0);
  useEffect(() => {
    if (!isMember || !focused || !chan?.loaded || chan.hasMoreAfter || !atBottom.current) return;
    if (suppressAutoRead.has(channelId)) return;
    if (document.visibilityState !== 'visible') return;
    markRead(channelId);
  }, [lastId, focused, chan?.loaded, chan?.hasMoreAfter, channelId, isMember]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = bottomGap < 40;
    prevHeight.current = el.scrollHeight;
    setShowJump(bottomGap > 1200 || !!chan?.hasMoreAfter);
    if (el.scrollTop < 400 && chan?.hasMoreBefore && !chan.loading) void loadOlder(channelId);
    if (bottomGap < 400 && chan?.hasMoreAfter && !chan.loading) void loadNewer(channelId);
    if (atBottom.current && !chan?.hasMoreAfter && isMember && !suppressAutoRead.has(channelId)) markRead(channelId);
  };

  if (!chan?.loaded) {
    return (
      <div className="message-list loading">
        <Spinner size={28} />
      </div>
    );
  }

  // messages are grouped per day; each group has a sticky date pill (like Slack)
  const days: { day: number; rows: React.ReactNode[] }[] = [];
  let rows: React.ReactNode[] = [];
  let prev: Message | undefined;
  let newDividerShown = false;
  for (const id of ids) {
    const m = msgs[id];
    if (!m) continue;
    if (!prev || startOfDay(prev.createdAt) !== startOfDay(m.createdAt)) {
      rows = [];
      days.push({ day: m.createdAt, rows });
      prev = undefined;
    }
    let showNew = false;
    if (marker !== undefined && !newDividerShown && m.id > marker && m.id > 0 && m.userId !== meId) {
      newDividerShown = true;
      showNew = true;
      rows.push(
        <div className="new-divider" key="new">
          <span>{t('New')}</span>
        </div>,
      );
    }
    rows.push(<MessageItem key={id} id={id} grouped={!showNew && shouldGroup(prev, m)} highlighted={highlightId === id || focusId === id} />);
    prev = m;
  }

  return (
    <div className="message-list-wrap">
      <div className="message-list" ref={scroller} onScroll={onScroll}>
        <div className="message-list-inner" ref={inner}>
          {chan.hasMoreBefore ? (
            <div className="list-loading">{chan.loading && <Spinner />}</div>
          ) : (
            <ChannelIntro channelId={channelId} />
          )}
          {days.map((d) => (
            <section className="day-section" key={startOfDay(d.day)}>
              <DayDivider ts={d.day} channelId={channelId} />
              {d.rows}
            </section>
          ))}
          {chan.hasMoreAfter && <div className="list-loading">{chan.loading && <Spinner />}</div>}
        </div>
      </div>
      {showJump && (
        <button
          className="jump-recent"
          onClick={() => {
            if (chan.hasMoreAfter) void jumpToPresent(channelId);
            else {
              const el = scroller.current;
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            }
            setShowJump(false);
          }}
        >
          <ArrowDown size={14} /> {t('Jump to recent messages')}
        </button>
      )}
    </div>
  );
}

