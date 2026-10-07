import { useEffect, useState } from 'react';
import { ArrowLeft, Bell, BellOff, Bot, Check, ChevronDown, EllipsisVertical, FileText, Hash, Link2, Lock, MessageSquare, Moon, Pin, Search } from '../components/icons.tsx';
import { useNavigate } from 'react-router-dom';
import type { Channel, FileInfo, LinkItem, Membership, Message } from '../../../shared/types.ts';
import { GET } from '../api.ts';
import { channelTitle, dmPartner, draftKey, isDmKind, set, useStore, upsertMessages } from '../store.ts';
import { t } from '../i18n.ts';
import { fail, joinChannel, openModal, openProfile, openThread, setChannelPrefs, suppressAutoRead, upsertChannel } from '../actions.ts';
import { MessageList } from '../components/MessageList.tsx';
import { Composer } from '../components/Composer.tsx';
import { ChannelContextMenu, ChannelIcon } from '../components/Sidebar.tsx';
import { HuddleButton } from '../components/Huddle.tsx';
import { Avatar, EmptyState, Menu, MenuItem, MenuSep, Popover, Spinner, StatusEmoji, UserPresenceDot, usePopover } from '../components/ui.tsx';
import { formatTime } from '../lib/format.ts';
import { FileCard, MessageItem } from '../components/Message.tsx';
import { Emoji } from '../lib/mrkdwn.tsx';
import { formatShortDate } from '../lib/format.ts';
import { localTime } from '../lib/format.ts';

type Tab = 'messages' | 'pins' | 'files';

function Header({ channel, membership, tab, setTab }: { channel: Channel; membership?: Membership; tab: Tab; setTab: (t: Tab) => void }) {
  const nav = useNavigate();
  const meId = useStore((s) => s.me?.id);
  const title = useStore(() => channelTitle(channel, meId));
  const partnerId = dmPartner(channel);
  const partner = useStore((s) => (partnerId ? s.users[partnerId] : undefined));
  const more = usePopover();
  const isDm = isDmKind(channel);
  const memberIds = channel.memberIds ?? [];
  const pinnedCount = useStore((s) => {
    const ids = s.chan[channel.id]?.ids ?? [];
    return ids.filter((id) => s.msgs[id]?.pinnedBy).length;
  });

  return (
    <div className="channel-header">
      <div className="ch-top">
        <button className="ch-back" onClick={() => nav(isDm ? '/dms' : '/')} aria-label={t('Back')}>
          <ArrowLeft size={20} />
        </button>
        <button className="ch-title" onClick={() => (channel.kind === 'dm' && partnerId ? openProfile(partnerId) : openModal({ type: 'channelDetails', channelId: channel.id }))}>
          {channel.kind === 'dm' && partner ? (
            <span className="ch-dm-avatar">
              <Avatar user={partner} size={24} />
              <UserPresenceDot userId={partner.id} />
            </span>
          ) : (
            <span className="ch-title-icon">
              <ChannelIcon channel={channel} size={18} />
            </span>
          )}
          <span className="ch-name">{title}</span>
          {partner && <StatusEmoji userId={partner.id} size={16} />}
          <ChevronDown size={16} />
        </button>
        {membership?.muted && <BellOff size={14} className="ch-muted" />}
        {channel.bridge && (
          <span className="slack-badge" title={t('Linked with Slack #{name} – messages are mirrored both ways', { name: channel.bridge.name })}>
            Slack #{channel.bridge.name}
          </span>
        )}
        {channel.kind === 'dm' && partner && partner.timezone && <span className="ch-topic">{t('{time} local time', { time: localTime(partner.timezone) })}</span>}
        {!isDm && channel.topic && (
          <span className="ch-topic" title={channel.topic} onClick={() => openModal({ type: 'channelDetails', channelId: channel.id })}>
            {channel.topic}
          </span>
        )}
        <div className="ch-right">
          {!isDm || channel.kind === 'group' ? (
            <button className="ch-members" onClick={() => openModal({ type: 'channelDetails', channelId: channel.id, tab: 'members' })} title={t('View all members')}>
              <span className="ch-faces">
                {memberIds.slice(0, 3).map((id) => (
                  <Avatar key={id} userId={id} size={20} />
                ))}
              </span>
              <span>{channel.memberCount}</span>
            </button>
          ) : null}
          {membership && !channel.archived && <HuddleButton channelId={channel.id} />}
          {membership && <NotifyButton channel={channel} membership={membership} />}
          <button
            className="icon-btn"
            title={t('Search in conversation')}
            onClick={() => {
              const q = isDm ? (partner ? `in:@${partner.username} ` : '') : `in:#${channel.name} `;
              window.dispatchEvent(new CustomEvent('relay:search', { detail: q }));
            }}
          >
            <Search size={17} />
          </button>
          {membership && (
            <>
              <button className="icon-btn" ref={more.ref} onClick={more.toggle} aria-label={t('More')}>
                <EllipsisVertical size={18} />
              </button>
              {more.open && (
                <Popover anchor={more.ref.current} onClose={more.close} placement="bottom-end">
                  <ChannelContextMenu channel={channel} membership={membership} onClose={more.close} />
                </Popover>
              )}
            </>
          )}
        </div>
      </div>
      <div className="ch-tabs">
        <button className={`ch-tab${tab === 'messages' ? ' active' : ''}`} onClick={() => setTab('messages')}>
          <MessageSquare size={15} /> {t('Messages')}
        </button>
        <button className={`ch-tab${tab === 'pins' ? ' active' : ''}`} onClick={() => setTab('pins')}>
          <Pin size={15} /> {t('Pins')}
          {pinnedCount > 0 && <span className="ch-tab-count">{pinnedCount}</span>}
        </button>
        <button className={`ch-tab${tab === 'files' ? ' active' : ''}`} onClick={() => setTab('files')}>
          <FileText size={15} /> {t('Files & links')}
        </button>
      </div>
    </div>
  );
}

function NotifyButton({ channel, membership }: { channel: Channel; membership: Membership }) {
  const pop = usePopover();
  const level = membership.muted ? 'mute' : membership.notify;
  const choose = (prefs: Partial<Pick<Membership, 'notify' | 'muted'>>) => {
    pop.close();
    void setChannelPrefs(channel.id, prefs);
  };
  return (
    <>
      <button className={`icon-btn${membership.muted ? ' muted' : ''}`} ref={pop.ref} onClick={pop.toggle} title={t('Notifications')}>
        {membership.muted ? <BellOff size={17} /> : <Bell size={17} />}
      </button>
      {pop.open && (
        <Popover anchor={pop.ref.current} onClose={pop.close} placement="bottom-end">
          <Menu>
            <div className="menu-header">{t('Notify you about…')}</div>
            <MenuItem right={level === 'all' ? <Check size={14} /> : undefined} onClick={() => choose({ notify: 'all', muted: false })}>
              {t('All new posts')}
            </MenuItem>
            <MenuItem right={level === 'mentions' || level === 'default' ? <Check size={14} /> : undefined} onClick={() => choose({ notify: 'mentions', muted: false })}>
              {t('Just mentions')}
            </MenuItem>
            <MenuItem right={level === 'none' ? <Check size={14} /> : undefined} onClick={() => choose({ notify: 'none', muted: false })}>
              {t('Nothing')}
            </MenuItem>
            <MenuSep />
            <MenuItem icon={membership.muted ? <Bell size={15} /> : <BellOff size={15} />} onClick={() => choose({ muted: !membership.muted })}>
              {membership.muted ? t('Unmute') : isDmKind(channel) ? t('Mute conversation') : t('Mute channel')}
            </MenuItem>
          </Menu>
        </Popover>
      )}
    </>
  );
}

/** Small notices above the composer, e.g. "X has paused their notifications". */
function ComposerNotices({ channel }: { channel: Channel }) {
  const partnerId = dmPartner(channel);
  const partner = useStore((s) => (partnerId ? s.users[partnerId] : undefined));
  const agent = useStore((s) => (partnerId ? s.agents[partnerId] : undefined));
  const meId = useStore((s) => s.me?.id);
  if (!partner || partner.id === meId) return null;
  if (agent)
    return (
      <div className="composer-notice">
        <Bot size={14} /> {t('{name} is an AI agent ({role}). Give it a task or ask a question.', { name: partner.displayName || partner.fullName, role: agent.role })}
      </div>
    );
  if (partner.dndUntil)
    return (
      <div className="composer-notice">
        <Moon size={14} /> {t('{name} has paused their notifications until {time}', { name: partner.displayName || partner.fullName, time: formatTime(partner.dndUntil) })}
      </div>
    );
  if (partner.deactivated) return <div className="composer-notice">{t('This account has been deactivated.')}</div>;
  return null;
}

function LinksList({ channelId }: { channelId: string }) {
  const [links, setLinks] = useState<LinkItem[] | null>(null);
  useEffect(() => {
    GET<LinkItem[]>(`/api/channels/${channelId}/links`).then(setLinks).catch(fail);
  }, [channelId]);
  if (!links?.length) return null;
  return (
    <div className="links-list">
      <h3 className="section-title">{t('Links')}</h3>
      {links.map((l) => (
        <a key={l.url + l.messageId} className="link-row" href={l.url} target="_blank" rel="noopener noreferrer">
          <span className="link-row-icon">
            <Link2 size={16} />
          </span>
          <span className="link-row-main">
            <b>{l.title || l.url.replace(/^https?:\/\//, '').slice(0, 80)}</b>
            <span className="muted-text">
              {new URL(l.url).hostname} · {formatShortDate(l.createdAt)}
            </span>
          </span>
        </a>
      ))}
    </div>
  );
}

function PinsTab({ channelId }: { channelId: string }) {
  const [list, setList] = useState<Message[] | null>(null);
  useEffect(() => {
    GET<Message[]>(`/api/channels/${channelId}/pins`)
      .then((l) => {
        set((s) => upsertMessages(s, l));
        setList(l);
      })
      .catch(fail);
  }, [channelId]);
  if (!list) return <div className="tab-body center"><Spinner /></div>;
  if (!list.length)
    return (
      <div className="tab-body">
        <EmptyState icon={<Pin size={32} />} title={t('No pinned messages yet')}>
          {t('Pin important messages so everyone can find them. Hover a message, choose “More actions” and “Pin to channel”.')}
        </EmptyState>
      </div>
    );
  return (
    <div className="tab-body list-view">
      {list.map((m) => (
        <div key={m.id} className="list-card" onClick={() => (m.threadRootId && !m.alsoInChannel ? openThread(m.threadRootId, m.channelId, m.id) : undefined)}>
          <MessageItem id={m.id} context="list" />
        </div>
      ))}
    </div>
  );
}

function FilesTab({ channelId }: { channelId: string }) {
  const [list, setList] = useState<FileInfo[] | null>(null);
  const users = useStore((s) => s.users);
  useEffect(() => {
    GET<FileInfo[]>(`/api/channels/${channelId}/files`).then(setList).catch(fail);
  }, [channelId]);
  if (!list) return <div className="tab-body center"><Spinner /></div>;
  if (!list.length)
    return (
      <div className="tab-body">
        <LinksList channelId={channelId} />
        <EmptyState icon={<FileText size={32} />} title={t('No files yet')}>
          {t('Files shared in this conversation will show up here.')}
        </EmptyState>
      </div>
    );
  return (
    <div className="tab-body">
    <h3 className="section-title files-title">{t('Files')}</h3>
    <div className="files-grid">
      {list.map((f) => (
        <div key={f.id} className="files-grid-item">
          <FileCard f={f} messageId={f.messageId ?? undefined} />
          <div className="files-grid-meta">
            {users[f.userId]?.fullName} · {formatShortDate(f.createdAt)}
          </div>
        </div>
      ))}
    </div>
    <LinksList channelId={channelId} />
    </div>
  );
}

export function ChannelView({ channelId, messageId, threadId }: { channelId: string; messageId?: number; threadId?: number }) {
  const channel = useStore((s) => s.channels[channelId]);
  const membership = useStore((s) => s.memberships[channelId]);
  const [tab, setTab] = useState<Tab>('messages');
  const [missing, setMissing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const isGuest = useStore((s) => s.me?.role === 'guest');

  // activate channel + unread marker snapshot
  useEffect(() => {
    set((s) => {
      s.activeChannelId = channelId;
      const m = s.memberships[channelId];
      if (m && m.unread > 0) s.unreadMarker[channelId] = m.lastRead;
      else delete s.unreadMarker[channelId];
      if (s.right && s.right.type === 'thread' && s.right.channelId !== channelId) s.right = null;
      s.highlightId = messageId ?? null;
    });
    setTab('messages');
    try {
      localStorage.setItem('relay.lastChannel', channelId);
    } catch {
      /* ignore */
    }
    return () => {
      suppressAutoRead.delete(channelId);
      set((s) => {
        delete s.unreadMarker[channelId];
        if (s.activeChannelId === channelId) s.activeChannelId = null;
      });
    };
  }, [channelId, messageId]);

  useEffect(() => {
    if (threadId) openThread(threadId, channelId, messageId);
  }, [threadId, channelId, messageId]);

  useEffect(() => {
    if (!messageId) return;
    const timer = setTimeout(() => set((s) => void (s.highlightId = null)), 4000);
    return () => clearTimeout(timer);
  }, [messageId]);

  // unknown channel (public preview or permalink): fetch it
  useEffect(() => {
    if (channel) return;
    setMissing(false);
    GET<{ channel: Channel; membership: Membership | null }>(`/api/channels/${channelId}`)
      .then((r) => upsertChannel(r.channel))
      .catch(() => setMissing(true));
  }, [channelId, channel]);

  if (!channel) {
    return (
      <main className="main-view">
        {missing ? (
          <EmptyState icon={<Hash size={32} />} title={t('Channel not found')}>
            {t('It may have been deleted, or you may not have access to it.')}
          </EmptyState>
        ) : (
          <div className="center-fill">
            <Spinner size={28} />
          </div>
        )}
      </main>
    );
  }

  return (
    <main
      className={`main-view channel-view${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (membership && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        setDragging(false);
        if (!membership || !e.dataTransfer.files.length) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('relay:files', { detail: { files: [...e.dataTransfer.files], target: draftKey(channelId) } }));
      }}
    >
      <Header channel={channel} membership={membership} tab={tab} setTab={setTab} />
      {tab === 'messages' && (
        <>
          <MessageList channelId={channelId} focusId={messageId} />
          {channel.archived ? (
            <div className="channel-footer-note">
              <span>
                {t('You are viewing')} <b>#{channel.name}</b>, {t('an archived channel.')}
              </span>
            </div>
          ) : membership ? (
            <>
              <ComposerNotices channel={channel} />
              <Composer key={channelId} channelId={channelId} />
            </>
          ) : (
            <div className="join-bar">
              <div className="join-bar-title">
                {channel.kind === 'private' ? <Lock size={16} /> : <Hash size={16} />} {channel.name}
              </div>
              {channel.description && <div className="join-bar-desc">{channel.description}</div>}
              <div className="join-bar-actions">
                <button className="btn" onClick={() => openModal({ type: 'channelDetails', channelId })}>
                  {t('Details')}
                </button>
                {!isGuest && (
                  <button className="btn primary" onClick={() => void joinChannel(channelId)}>
                    {t('Join channel')}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
      {tab === 'pins' && <PinsTab channelId={channelId} />}
      {tab === 'files' && <FilesTab channelId={channelId} />}
      {dragging && (
        <div className="drop-overlay">
          <div>
            <Emoji code="inbox_tray" size={40} />
            <h3>{t('Upload to {name}', { name: isDmKind(channel) ? channelTitle(channel) : `#${channel.name}` })}</h3>
          </div>
        </div>
      )}
    </main>
  );
}
