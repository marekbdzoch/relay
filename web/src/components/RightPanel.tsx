import { useEffect, useLayoutEffect, useRef } from 'react';
import { Clock, Copy, Headphones, Mail, MessageSquare, Phone, X, EllipsisVertical, Pencil } from './icons.tsx';
import { channelTitle, isAdmin, isDmKind, useStore } from '../store.ts';
import { t, tp } from '../i18n.ts';
import { markThreadRead, openDm, openModal, setRight, setThreadFollow } from '../actions.ts';
import { toast } from '../store.ts';
import { localTime } from '../lib/format.ts';
import { joinHuddle } from '../lib/huddle.ts';
import { Emoji } from '../lib/mrkdwn.tsx';
import { MessageItem, shouldGroup } from './Message.tsx';
import { Composer } from './Composer.tsx';
import { Avatar, Menu, MenuItem, Popover, Spinner, UserPresenceDot, usePopover, useResizableWidth } from './ui.tsx';

function ThreadPanel({ rootId, channelId, highlightId }: { rootId: number; channelId: string; highlightId?: number }) {
  const root = useStore((s) => s.msgs[rootId]);
  const thread = useStore((s) => s.threads[rootId]);
  const msgs = useStore((s) => s.msgs);
  const channel = useStore((s) => s.channels[channelId]);
  const isMember = useStore((s) => !!s.memberships[channelId]);
  const focused = useStore((s) => s.focused);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const didInitial = useRef(false);
  const more = usePopover();
  const ids = thread?.ids ?? [];

  useEffect(() => {
    didInitial.current = false;
  }, [rootId]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !thread?.loaded) return;
    if (!didInitial.current) {
      didInitial.current = true;
      const target = highlightId ? el.querySelector(`[data-id="${highlightId}"]`) : null;
      if (target) target.scrollIntoView({ block: 'center' });
      else el.scrollTop = el.scrollHeight;
    } else if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [ids.length, thread?.loaded, highlightId]);

  useEffect(() => {
    if (thread?.loaded && focused) markThreadRead(rootId);
  }, [ids.length, thread?.loaded, focused, rootId]);

  return (
    <>
      <div className="rp-head">
        <div className="rp-title">
          <h3>{t('Thread')}</h3>
          {channel && <span className="rp-sub">{isDmKind(channel) ? channelTitle(channel) : `#${channel.name}`}</span>}
        </div>
        {thread?.loaded && (
          <>
            <button className="icon-btn" ref={more.ref} onClick={more.toggle}>
              <EllipsisVertical size={18} />
            </button>
            {more.open && (
              <Popover anchor={more.ref.current} onClose={more.close} placement="bottom-end">
                <Menu>
                  <MenuItem
                    onClick={() => {
                      more.close();
                      void setThreadFollow(rootId, !thread.following);
                    }}
                  >
                    {thread.following ? t('Turn off notifications for replies') : t('Get notified about new replies')}
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      more.close();
                      void navigator.clipboard?.writeText(`${location.origin}/c/${channelId}/${rootId}?thread=${rootId}`);
                      toast(t('Link copied to clipboard'));
                    }}
                  >
                    {t('Copy link')}
                  </MenuItem>
                </Menu>
              </Popover>
            )}
          </>
        )}
        <button className="icon-btn" onClick={() => setRight(null)} aria-label={t('Close')}>
          <X size={18} />
        </button>
      </div>
      <div
        className="rp-body thread-body"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current!;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!root || !thread?.loaded ? (
          <div className="center-fill">
            <Spinner />
          </div>
        ) : (
          <>
            <MessageItem id={rootId} context="thread-root" />
            {ids.length > 0 && (
              <div className="thread-divider">
                <span>{tp(ids.filter((id) => id > 0).length, '{n} reply', '{n} replies')}</span>
              </div>
            )}
            {ids.map((id, i) => (
              <MessageItem key={id} id={id} context="thread" grouped={shouldGroup(i > 0 ? msgs[ids[i - 1]] : undefined, msgs[id])} highlighted={highlightId === id} />
            ))}
          </>
        )}
      </div>
      {root && isMember && !channel?.archived && !root.deleted && (
        <div className="rp-composer">
          <Composer key={rootId} channelId={channelId} threadRootId={rootId} />
        </div>
      )}
    </>
  );
}

function ProfilePanel({ userId }: { userId: string }) {
  const u = useStore((s) => s.users[userId]);
  const agent = useStore((s) => s.agents[userId]);
  const meUser = useStore((s) => s.me);
  const meId = useStore((s) => s.me?.id);
  const online = useStore((s) => s.presence[userId] === 'active');
  if (!u) return null;
  const self = u.id === meId;
  const copy = (v: string) => {
    void navigator.clipboard?.writeText(v);
    toast(t('Copied to clipboard'));
  };
  return (
    <>
      <div className="rp-head">
        <div className="rp-title">
          <h3>{t('Profile')}</h3>
        </div>
        <button className="icon-btn" onClick={() => setRight(null)} aria-label={t('Close')}>
          <X size={18} />
        </button>
      </div>
      <div className="rp-body profile">
        <div className="profile-photo">
          <Avatar user={u} size={256} />
        </div>
        <div className="profile-main">
          <h2>
            {u.fullName}
            {u.isBot && <span className="app-badge">{t('APP')}</span>}
            {u.external === 'slack' && <span className="slack-badge">Slack</span>}
            {agent && <span className="agent-badge">{t('AGENT')}</span>}
          </h2>
          {u.displayName && u.displayName !== u.fullName && <div className="profile-display">{u.displayName}</div>}
          {u.title && <div className="profile-title">{u.title}</div>}
          {u.deactivated && <div className="profile-deactivated">{t('Deactivated account')}</div>}
          {(u.statusEmoji || u.statusText) && (
            <div className="profile-status">
              {u.statusEmoji && <Emoji code={u.statusEmoji} size={16} />} {u.statusText}
            </div>
          )}
          <div className="profile-presence">
            <UserPresenceDot userId={u.id} /> {u.dndUntil ? t('Notifications paused') : online ? t('Active') : t('Away')}
          </div>
          {u.timezone && (
            <div className="profile-time">
              <Clock size={14} /> {t('{time} local time', { time: localTime(u.timezone) })}
            </div>
          )}
          <div className="profile-actions">
            {self ? (
              <button className="btn" onClick={() => openModal({ type: 'editProfile' })}>
                <Pencil size={14} /> {t('Edit profile')}
              </button>
            ) : (
              <>
                <button className="btn" onClick={() => void openDm([u.id])} disabled={u.deactivated || u.external === 'slack'}>
                  <MessageSquare size={14} /> {t('Message')}
                </button>
                <button
                  className="btn"
                  disabled={u.deactivated || u.external === 'slack'}
                  onClick={async () => {
                    const ch = await openDm([u.id]);
                    if (ch) void joinHuddle(ch.id);
                  }}
                >
                  <Headphones size={14} /> {t('Huddle')}
                </button>
              </>
            )}
          </div>
        </div>
        <div className="profile-section">
          <h4>{t('Contact information')}</h4>
          {u.email && (
            <div className="profile-contact">
              <Mail size={16} />
              <div>
                <div className="pc-label">{t('Email address')}</div>
                <a href={`mailto:${u.email}`}>{u.email}</a>
              </div>
              <button className="icon-btn small" onClick={() => copy(u.email!)}>
                <Copy size={14} />
              </button>
            </div>
          )}
          {u.phone && (
            <div className="profile-contact">
              <Phone size={16} />
              <div>
                <div className="pc-label">{t('Phone')}</div>
                <a href={`tel:${u.phone}`}>{u.phone}</a>
              </div>
            </div>
          )}
          <div className="profile-contact">
            <span className="pc-at">@</span>
            <div>
              <div className="pc-label">{t('Username')}</div>
              <span>@{u.username}</span>
            </div>
          </div>
        </div>
        {agent ? (
          <div className="profile-section">
            <h4>{t('AI agent')}</h4>
            <div className="profile-about">
              <b>{agent.role}</b>
              {agent.department && ` · ${agent.department}`}
            </div>
            <div className="profile-instructions">{agent.instructions}</div>
            {(isAdmin(meUser) || agent.createdBy === meId) && (
              <button className="btn small" onClick={() => openModal({ type: 'agent', userId: u.id })}>
                <Pencil size={14} /> {t('Edit agent')}
              </button>
            )}
          </div>
        ) : (
          <div className="profile-section">
            <h4>{t('About')}</h4>
            <div className="profile-about">{t('Role: {role}', { role: t(u.role) })}</div>
          </div>
        )}
      </div>
    </>
  );
}

export function RightPanel() {
  const right = useStore((s) => s.right);
  const { width, onDown } = useResizableWidth('relay.rightWidth', 420, 320, 760);
  if (!right) return null;
  return (
    <aside className="right-panel" style={{ width }}>
      <div className="resize-handle left" onPointerDown={(e) => onDown(e, -1)} />
      {right.type === 'thread' && <ThreadPanel key={right.rootId} rootId={right.rootId} channelId={right.channelId} highlightId={right.highlightId} />}
      {right.type === 'profile' && <ProfilePanel userId={right.userId} />}
    </aside>
  );
}
