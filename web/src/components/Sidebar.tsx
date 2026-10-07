import { useMemo, useState, type ReactNode } from 'react';
import {
  Bell,
  BellOff,
  Bot,
  Check,
  ChevronDown,
  Copy,
  EllipsisVertical,
  FolderInput,
  Hash,
  Headphones,
  Volume2,
  Inbox,
  Info,
  Link2,
  Lock,
  LogOut,
  MessageCircle,
  Plus,
  Search,
  SendHorizontal,
  Settings,
  SquarePen,
  Star,
  Trash2,
  X,
  Pencil,
  Bot as BotIcon,
  UserPlus,
} from './icons.tsx';
import { VoiceRoomMembers } from './Huddle.tsx';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Channel, Membership, SidebarSection } from '../../../shared/types.ts';
import { S, channelTitle, dmPartner, draftKey, isDmKind, toast, useStore } from '../store.ts';
import { t } from '../i18n.ts';
import { leaveChannel, openDm, openModal, setChannelPrefs, updatePrefs } from '../actions.ts';
import { channelPath, navigate } from '../lib/nav.ts';
import { Emoji } from '../lib/mrkdwn.tsx';
import { Avatar, Badge, Menu, MenuItem, MenuSep, Popover, SubmenuItem, UserPresenceDot, usePopover } from './ui.tsx';

const NO_SECTIONS: SidebarSection[] = [];

export function ChannelIcon({ channel, size = 16, active }: { channel: Channel; size?: number; active?: boolean }) {
  const partner = dmPartner(channel);
  if (channel.kind === 'dm' && partner) {
    return (
      <span className="dm-avatar">
        <Avatar userId={partner} size={size + 4} />
        <UserPresenceDot userId={partner} className={active ? 'on-active' : ''} />
      </span>
    );
  }
  if (channel.kind === 'group') return <span className="group-count">{Math.max(0, (channel.memberIds?.length ?? 1) - 1)}</span>;
  return channel.kind === 'private' ? <Lock size={size - 1} /> : <Hash size={size} />;
}

// ---------------------------------------------------------------------------
// context menu (right click / ⋮ in header)

function moveToSection(channelId: string, sectionId: string | null) {
  const sections = (S().me?.prefs.sidebarSections ?? []).map((s) => ({ ...s, channelIds: s.channelIds.filter((c) => c !== channelId) }));
  const next = sectionId ? sections.map((s) => (s.id === sectionId ? { ...s, channelIds: [...s.channelIds, channelId] } : s)) : sections;
  void updatePrefs({ sidebarSections: next });
}

export function ChannelContextMenu({ channel, membership, onClose }: { channel: Channel; membership: Membership; onClose: () => void }) {
  const isDm = isDmKind(channel);
  const sectionsRaw = useStore((s) => s.me?.prefs.sidebarSections);
  const sections = sectionsRaw ?? NO_SECTIONS;
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const notify = membership.muted ? 'mute' : membership.notify;
  return (
    <Menu>
      <MenuItem icon={<Info size={15} />} onClick={run(() => openModal({ type: 'channelDetails', channelId: channel.id }))}>
        {isDm ? t('View conversation details') : t('View channel details')}
      </MenuItem>
      <SubmenuItem label={t('Copy')} icon={<Copy size={15} />}>
        {(close) => (
          <>
            <MenuItem
              icon={<Link2 size={15} />}
              onClick={() => {
                close();
                onClose();
                void navigator.clipboard?.writeText(location.origin + channelPath(channel.id));
                toast(t('Link copied to clipboard'));
              }}
            >
              {t('Copy link')}
            </MenuItem>
            {!isDm && (
              <MenuItem
                onClick={() => {
                  close();
                  onClose();
                  void navigator.clipboard?.writeText(`#${channel.name}`);
                  toast(t('Copied to clipboard'));
                }}
              >
                {t('Copy name')}
              </MenuItem>
            )}
          </>
        )}
      </SubmenuItem>
      <SubmenuItem label={isDm ? t('Move conversation') : t('Move channel')} icon={<FolderInput size={15} />}>
        {(close) => (
          <>
            {sections.map((s) => (
              <MenuItem
                key={s.id}
                onClick={() => {
                  close();
                  onClose();
                  moveToSection(channel.id, s.id);
                }}
                right={s.channelIds.includes(channel.id) ? <Check size={14} /> : undefined}
              >
                {s.emoji} {s.name}
              </MenuItem>
            ))}
            {sections.some((s) => s.channelIds.includes(channel.id)) && (
              <MenuItem
                onClick={() => {
                  close();
                  onClose();
                  moveToSection(channel.id, null);
                }}
              >
                {isDm ? t('Back to Direct messages') : t('Back to Channels')}
              </MenuItem>
            )}
            {sections.length > 0 && <MenuSep />}
            <MenuItem
              icon={<Plus size={15} />}
              onClick={() => {
                close();
                onClose();
                openModal({ type: 'section', channelId: channel.id });
              }}
            >
              {t('New section…')}
            </MenuItem>
          </>
        )}
      </SubmenuItem>
      <MenuSep />
      <div className="menu-header">{t('Notify you about…')}</div>
      <MenuItem icon={<Bell size={15} />} right={notify === 'all' ? <Check size={14} /> : undefined} onClick={run(() => void setChannelPrefs(channel.id, { notify: 'all', muted: false }))}>
        {t('All new posts')}
      </MenuItem>
      <MenuItem icon={<Bell size={15} />} right={notify === 'mentions' || notify === 'default' ? <Check size={14} /> : undefined} onClick={run(() => void setChannelPrefs(channel.id, { notify: 'mentions', muted: false }))}>
        {t('Just mentions')}
      </MenuItem>
      <MenuItem icon={<BellOff size={15} />} right={notify === 'mute' ? <Check size={14} /> : undefined} onClick={run(() => void setChannelPrefs(channel.id, { muted: !membership.muted }))}>
        {membership.muted ? t('Unmute') : t('Mute')}
      </MenuItem>
      <MenuSep />
      <MenuItem icon={<Star size={15} />} onClick={run(() => void setChannelPrefs(channel.id, { starred: !membership.starred }))}>
        {membership.starred ? t('Unstar') : t('Star')}
      </MenuItem>
      {isDm ? (
        <MenuItem icon={<X size={15} />} onClick={run(() => void setChannelPrefs(channel.id, { hidden: true }))}>
          {t('Close conversation')}
        </MenuItem>
      ) : (
        <MenuItem icon={<LogOut size={15} />} danger onClick={run(() => leaveChannel(channel.id))}>
          {t('Leave channel')}
        </MenuItem>
      )}
    </Menu>
  );
}

// ---------------------------------------------------------------------------
// items

function ChannelItem({ channel, membership, active }: { channel: Channel; membership: Membership; active: boolean }) {
  const nav = useNavigate();
  const meId = useStore((s) => s.me?.id);
  const title = useStore(() => channelTitle(channel, meId));
  const hasDraft = useStore((s) => !!s.drafts[draftKey(channel.id)]);
  const huddle = useStore((s) => s.huddles[channel.id]);
  const partner = dmPartner(channel);
  const statusEmoji = useStore((s) => (partner ? s.users[partner]?.statusEmoji : ''));
  const agentRole = useStore((s) => (partner ? s.agents[partner]?.role : undefined));
  const external = useStore((s) => (partner ? s.users[partner]?.external : null));
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const isDm = isDmKind(channel);
  const unread = membership.unread > 0 && !membership.muted;
  const badge = isDm ? membership.unread : membership.mentions;

  return (
    <>
      <a
        href={channelPath(channel.id)}
        className={`sb-item${active ? ' active' : ''}${unread ? ' unread' : ''}${membership.muted ? ' muted' : ''}`}
        onClick={(e) => {
          e.preventDefault();
          nav(channelPath(channel.id));
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <span className="sb-icon">
          <ChannelIcon channel={channel} active={active} />
        </span>
        <span className="sb-name">
          {title}
          {partner === meId && channel.kind === 'dm' && <span className="sb-you"> {t('you')}</span>}
          {agentRole && <span className="sb-sub"> {agentRole}</span>}
          {external === 'slack' && <span className="sb-sub"> Slack</span>}
        </span>
        {statusEmoji && (
          <span className="sb-status">
            <Emoji code={statusEmoji} size={14} />
          </span>
        )}
        {huddle && (isDm ? <Headphones size={14} className="sb-huddle" /> : <Volume2 size={14} className="sb-huddle" />)}
        {hasDraft && !active && !badge && <SquarePen size={13} className="sb-draft" />}
        {membership.muted && <BellOff size={13} className="sb-muted-icon" />}
        {badge > 0 && <Badge count={badge} />}
        {isDm && (
          <button
            className="sb-close"
            aria-label={t('Close conversation')}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void setChannelPrefs(channel.id, { hidden: true });
            }}
          >
            <X size={14} />
          </button>
        )}
      </a>
      {!isDm && <VoiceRoomMembers channelId={channel.id} />}
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} placement="bottom-start">
          <ChannelContextMenu channel={channel} membership={membership} onClose={() => setMenu(null)} />
        </Popover>
      )}
    </>
  );
}

function AgentItem({ userId }: { userId: string }) {
  const u = useStore((s) => s.users[userId]);
  const role = useStore((s) => s.agents[userId]?.role);
  if (!u) return null;
  return (
    <button className="sb-item" onClick={() => void openDm([userId])}>
      <span className="sb-icon">
        <span className="dm-avatar">
          <Avatar userId={userId} size={20} />
        </span>
      </span>
      <span className="sb-name">
        {u.displayName || u.fullName}
        {role && <span className="sb-sub"> {role}</span>}
      </span>
    </button>
  );
}

function NavLink({ icon, label, to, badge, count, bold }: { icon: ReactNode; label: string; to: string; badge?: number; count?: ReactNode; bold?: boolean }) {
  const loc = useLocation();
  const nav = useNavigate();
  const active = loc.pathname.startsWith(to);
  return (
    <a
      href={to}
      className={`sb-item sb-nav${active ? ' active' : ''}${badge || bold ? ' unread' : ''}`}
      onClick={(e) => {
        e.preventDefault();
        nav(to);
      }}
    >
      <span className="sb-icon">{icon}</span>
      <span className="sb-name">{label}</span>
      {badge ? <Badge count={badge} /> : count ? <span className="sb-count">{count}</span> : null}
    </a>
  );
}

function AddRow({ label, onClick, icon }: { label: string; onClick: () => void; icon?: ReactNode }) {
  return (
    <button className="sb-item sb-add" onClick={onClick}>
      <span className="sb-icon sb-add-icon">{icon ?? <Plus size={14} />}</span>
      <span className="sb-name">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// sections

type Entry = [Channel, Membership];

interface SectionProps {
  id: string;
  title: ReactNode;
  entries: Entry[];
  extra?: ReactNode;
  menu?: (close: () => void) => ReactNode;
  onAdd?: () => void;
  activeId: string | null;
  onChannelPage: boolean;
  defaultSort: 'alpha' | 'recent';
  children?: ReactNode;
}

function Section({ id, title, entries, extra, menu, onAdd, activeId, onChannelPage, defaultSort, children }: SectionProps) {
  const collapsed = useStore((s) => !!s.me?.prefs.sidebarCollapsed?.[id]);
  const allCollapsed = useStore((s) => s.me?.prefs.sidebarCollapsed);
  const sort = useStore((s) => s.me?.prefs.sectionSort?.[id] ?? defaultSort);
  const filter = useStore((s) => s.me?.prefs.sectionFilter?.[id] ?? 'all');
  const meId = useStore((s) => s.me?.id);
  const more = usePopover();

  const sorted = useMemo(() => {
    const list = [...entries];
    if (sort === 'alpha') list.sort((a, b) => channelTitle(a[0], meId).localeCompare(channelTitle(b[0], meId)));
    else list.sort((a, b) => (b[0].lastMessageAt ?? b[1].joinedAt) - (a[0].lastMessageAt ?? a[1].joinedAt));
    return list;
  }, [entries, sort, meId]);

  const visible = sorted.filter(([c, m]) => {
    const isActive = onChannelPage && c.id === activeId;
    if (collapsed) return isActive || (m.unread > 0 && !m.muted);
    if (filter === 'unreads') return isActive || m.unread > 0;
    return true;
  });

  return (
    <div className="sb-section">
      <div className="sb-section-head">
        <button className="sb-section-toggle" onClick={() => void updatePrefs({ sidebarCollapsed: { ...allCollapsed, [id]: !collapsed } })}>
          <ChevronDown size={14} className={`sb-caret${collapsed ? ' collapsed' : ''}`} />
          <span>{title}</span>
        </button>
        {menu && (
          <>
            <button className="sb-section-add" ref={more.ref} onClick={more.toggle} aria-label={t('Section options')}>
              <EllipsisVertical size={15} />
            </button>
            {more.open && (
              <Popover anchor={more.ref.current} onClose={more.close} placement="bottom-start">
                <Menu>{menu(more.close)}</Menu>
              </Popover>
            )}
          </>
        )}
        {onAdd && (
          <button className="sb-section-add" onClick={onAdd} aria-label={t('Add')}>
            <Plus size={15} />
          </button>
        )}
      </div>
      {visible.map(([c, m]) => (
        <ChannelItem key={c.id} channel={c} membership={m} active={onChannelPage && c.id === activeId} />
      ))}
      {!collapsed && children}
      {!collapsed && extra}
    </div>
  );
}

function SectionSettings({ id, close, defaultSort }: { id: string; close: () => void; defaultSort: 'alpha' | 'recent' }) {
  const sort = useStore((s) => s.me?.prefs.sectionSort?.[id] ?? defaultSort);
  const filter = useStore((s) => s.me?.prefs.sectionFilter?.[id] ?? 'all');
  const prefs = useStore((s) => s.me?.prefs);
  const setSort = (v: 'alpha' | 'recent') => {
    close();
    void updatePrefs({ sectionSort: { ...prefs?.sectionSort, [id]: v } });
  };
  const setFilter = (v: 'all' | 'unreads') => {
    close();
    void updatePrefs({ sectionFilter: { ...prefs?.sectionFilter, [id]: v } });
  };
  return (
    <>
      <div className="menu-header">{t('Section settings')}</div>
      <SubmenuItem label={`${t('Show')}: ${filter === 'all' ? t('All') : t('Unreads only')}`}>
        {(c) => (
          <>
            <MenuItem right={filter === 'all' ? <Check size={14} /> : undefined} onClick={() => (c(), setFilter('all'))}>
              {t('All conversations')}
            </MenuItem>
            <MenuItem right={filter === 'unreads' ? <Check size={14} /> : undefined} onClick={() => (c(), setFilter('unreads'))}>
              {t('Unreads only')}
            </MenuItem>
          </>
        )}
      </SubmenuItem>
      <SubmenuItem label={`${t('Sort')}: ${sort === 'alpha' ? 'A–Z' : t('Recent activity')}`}>
        {(c) => (
          <>
            <MenuItem right={sort === 'alpha' ? <Check size={14} /> : undefined} onClick={() => (c(), setSort('alpha'))}>
              {t('Alphabetically')}
            </MenuItem>
            <MenuItem right={sort === 'recent' ? <Check size={14} /> : undefined} onClick={() => (c(), setSort('recent'))}>
              {t('Recent activity')}
            </MenuItem>
          </>
        )}
      </SubmenuItem>
    </>
  );
}

// ---------------------------------------------------------------------------

export function Sidebar() {
  const activeId = useStore((s) => s.activeChannelId);
  const threadsUnread = useStore((s) => s.threadsUnread);
  const draftsCount = useStore((s) => Object.keys(s.drafts).length);
  const liveHuddles = useStore((s) => Object.keys(s.huddles).length);
  const anyUnread = useStore((s) => Object.values(s.memberships).some((m) => m.unread > 0 && !m.muted));
  const channels = useStore((s) => s.channels);
  const memberships = useStore((s) => s.memberships);
  const agents = useStore((s) => s.agents);
  const users = useStore((s) => s.users);
  const sections = useStore((s) => s.me?.prefs.sidebarSections);
  const loc = useLocation();
  const onChannelPage = loc.pathname.startsWith('/c/') || loc.pathname.startsWith('/dms/');

  const groups = useMemo(() => {
    const inSection = new Map<string, string>();
    for (const sec of sections ?? []) for (const cid of sec.channelIds) inSection.set(cid, sec.id);
    const starred: Entry[] = [];
    const chans: Entry[] = [];
    const dms: Entry[] = [];
    const agentDms: Entry[] = [];
    const custom = new Map<string, Entry[]>();
    for (const m of Object.values(memberships)) {
      const c = channels[m.channelId];
      if (!c) continue;
      if (isDmKind(c) && m.hidden && c.id !== activeId) continue;
      if (c.archived && c.id !== activeId) continue;
      const partner = dmPartner(c);
      if (m.starred) starred.push([c, m]);
      else if (inSection.has(c.id)) custom.set(inSection.get(c.id)!, [...(custom.get(inSection.get(c.id)!) ?? []), [c, m]]);
      else if (c.kind === 'dm' && partner && agents[partner]) agentDms.push([c, m]);
      else if (isDmKind(c)) dms.push([c, m]);
      else chans.push([c, m]);
    }
    return { starred, chans, dms: dms.slice(0, 40), agentDms, custom };
  }, [channels, memberships, activeId, sections, agents]);

  // agents you haven't talked to yet still show up in the Agents section
  const agentsWithoutDm = useMemo(() => {
    const withDm = new Set(groups.agentDms.map(([c]) => dmPartner(c)));
    return Object.values(agents)
      .filter((a) => users[a.userId] && !users[a.userId].deactivated && !withDm.has(a.userId))
      .map((a) => a.userId);
  }, [agents, users, groups.agentDms]);

  const sectionCommon = { activeId, onChannelPage };

  return (
    <div className="pane sidebar-pane">
      <div className="sidebar-scroll">
        <>
            <div className="sb-group">
              <NavLink icon={<Inbox size={16} />} label={t('Unreads')} to="/unreads" bold={anyUnread} />
              <NavLink icon={<MessageCircle size={16} />} label={t('Threads')} to="/threads" badge={threadsUnread} />
              <NavLink icon={<Headphones size={16} />} label={t('Huddles')} to="/huddles" count={liveHuddles ? <span className="sb-live">{liveHuddles}</span> : null} />
              <NavLink
                icon={<SendHorizontal size={16} />}
                label={t('Drafts & sent')}
                to="/drafts"
                count={
                  draftsCount ? (
                    <span className="sb-draft-count">
                      <Pencil size={11} /> {draftsCount}
                    </span>
                  ) : null
                }
              />
            </div>
            {groups.starred.length > 0 && (
              <Section id="starred" title={t('Starred')} entries={groups.starred} defaultSort="alpha" {...sectionCommon} menu={(close) => <SectionSettings id="starred" close={close} defaultSort="alpha" />} />
            )}
            {(sections ?? []).map((sec: SidebarSection) => (
              <Section
                key={sec.id}
                id={sec.id}
                title={
                  <>
                    <span className="sb-section-emoji">{sec.emoji}</span> {sec.name}
                  </>
                }
                entries={groups.custom.get(sec.id) ?? []}
                defaultSort="alpha"
                {...sectionCommon}
                menu={(close) => (
                  <>
                    <MenuItem icon={<Pencil size={15} />} onClick={() => (close(), openModal({ type: 'section', sectionId: sec.id }))}>
                      {t('Rename section')}
                    </MenuItem>
                    <MenuSep />
                    <SectionSettings id={sec.id} close={close} defaultSort="alpha" />
                    <MenuSep />
                    <MenuItem
                      icon={<Trash2 size={15} />}
                      danger
                      onClick={() => {
                        close();
                        void updatePrefs({ sidebarSections: (sections ?? []).filter((x) => x.id !== sec.id) });
                      }}
                    >
                      {t('Delete section')}
                    </MenuItem>
                  </>
                )}
              >
                {!(groups.custom.get(sec.id) ?? []).length && <div className="sb-hint">{t('Right-click a channel → Move to add it here')}</div>}
              </Section>
            ))}
            <Section
              id="channels"
              title={t('Channels')}
              entries={groups.chans}
              defaultSort="alpha"
              {...sectionCommon}
              onAdd={() => openModal({ type: 'createChannel' })}
              menu={(close) => (
                <>
                  <div className="menu-header">{t('Channels')}</div>
                  <MenuItem icon={<Hash size={15} />} onClick={() => (close(), openModal({ type: 'createChannel' }))}>
                    {t('Create a channel')}
                  </MenuItem>
                  <MenuItem icon={<Search size={15} />} onClick={() => (close(), navigate('/browse/channels'))}>
                    {t('Browse channels')}
                  </MenuItem>
                  <MenuSep />
                  <div className="menu-header">{t('Manage section')}</div>
                  <MenuItem icon={<Plus size={15} />} onClick={() => (close(), openModal({ type: 'section' }))}>
                    {t('Create a new section')}
                  </MenuItem>
                  <MenuSep />
                  <SectionSettings id="channels" close={close} defaultSort="alpha" />
                </>
              )}
              extra={<AddRow label={t('Add channels')} onClick={() => navigate('/browse/channels')} />}
            />
            <Section
              id="dms"
              title={t('Direct messages')}
              entries={groups.dms}
              defaultSort="recent"
              {...sectionCommon}
              onAdd={() => openModal({ type: 'newMessage' })}
              menu={(close) => (
                <>
                  <MenuItem icon={<SquarePen size={15} />} onClick={() => (close(), openModal({ type: 'newMessage' }))}>
                    {t('New message')}
                  </MenuItem>
                  <MenuItem icon={<Plus size={15} />} onClick={() => (close(), openModal({ type: 'section' }))}>
                    {t('Create a new section')}
                  </MenuItem>
                  <MenuSep />
                  <SectionSettings id="dms" close={close} defaultSort="recent" />
                </>
              )}
              extra={
                <>
                  <AddRow label={t('Add coworkers')} icon={<UserPlus size={13} />} onClick={() => openModal({ type: 'invite' })} />
                  <AddRow label={t('Add agent')} icon={<BotIcon size={13} />} onClick={() => openModal({ type: 'agent' })} />
                </>
              }
            />
            <Section
              id="agents"
              title={t('Agents')}
              entries={groups.agentDms}
              defaultSort="alpha"
              {...sectionCommon}
              onAdd={() => openModal({ type: 'agent' })}
              menu={(close) => (
                <>
                  <MenuItem icon={<Bot size={15} />} onClick={() => (close(), openModal({ type: 'agent' }))}>
                    {t('New agent')}
                  </MenuItem>
                  <MenuItem icon={<Settings size={15} />} onClick={() => (close(), navigate('/agents'))}>
                    {t('Manage agents')}
                  </MenuItem>
                  <MenuSep />
                  <SectionSettings id="agents" close={close} defaultSort="alpha" />
                </>
              )}
            >
              {agentsWithoutDm.map((id) => (
                <AgentItem key={id} userId={id} />
              ))}
              {!groups.agentDms.length && !agentsWithoutDm.length && <AddRow label={t('Add agent')} icon={<BotIcon size={13} />} onClick={() => openModal({ type: 'agent' })} />}
            </Section>
            <div className="sb-group sb-bottom">
              <NavLink icon={<Bot size={16} />} label={t('Agents & apps')} to="/agents" />
            </div>
        </>
      </div>
    </div>
  );
}
