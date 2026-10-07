import { useEffect, useMemo, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import type { NavSection } from '../../../shared/types.ts';
import { assetUrl } from '../api.ts';
import { displayName, isDmKind, useStore } from '../store.ts';
import { t } from '../i18n.ts';
import { openModal, updatePrefs } from '../actions.ts';
import { Emoji } from '../lib/mrkdwn.tsx';
import { isDarkMode } from '../lib/theme.ts';
import { navTabsOf } from '../lib/navTabs.ts';
import { Bell, Bookmark, Bot, ChevronDown, Files, Hash, Headphones, Home, MessagesSquare, Moon, MoreHorizontal, Pencil, Plus, Settings, SquarePen, Sun, UserPlus } from './icons.tsx';
import { Avatar, Badge, Menu, MenuItem, Popover, Tip, usePopover, useResizableWidth } from './ui.tsx';
import { UserMenu } from './UserMenu.tsx';
import { WorkspaceMenu } from './WorkspaceMenu.tsx';
import { HuddleBar } from './Huddle.tsx';

export function WorkspaceIcon({ size = 36 }: { size?: number }) {
  const ws = useStore((s) => s.workspace);
  if (ws?.iconUrl) return <img className="ws-icon" src={assetUrl(ws.iconUrl)} alt="" style={{ width: size, height: size }} />;
  return (
    <span className="ws-icon ws-icon-letter" style={{ width: size, height: size, fontSize: size * 0.45 }}>
      {(ws?.name ?? 'R').slice(0, 1).toUpperCase()}
    </span>
  );
}

// ---------------------------------------------------------------------------
// unread counters

export function useDmUnread() {
  return useStore((s) => {
    let n = 0;
    for (const m of Object.values(s.memberships)) {
      if (!m.muted && !m.hidden && isDmKind(s.channels[m.channelId])) n += m.unread;
    }
    return n;
  });
}

export function useHomeUnread() {
  return useStore(
    useShallow((s) => {
      let mentions = 0;
      let unread = false;
      for (const m of Object.values(s.memberships)) {
        const c = s.channels[m.channelId];
        if (!c || m.muted || m.hidden) continue;
        if (isDmKind(c)) mentions += m.unread;
        else {
          mentions += m.mentions;
          if (m.unread) unread = true;
        }
      }
      return { mentions, unread };
    }),
  );
}

export type Section = NavSection;

export function useSection(): Section {
  const seg = useLocation().pathname.split('/')[1] || 'c';
  return (['dms', 'activity', 'later', 'files', 'agents'].includes(seg) ? seg : 'home') as Section;
}

function useGoHome() {
  const nav = useNavigate();
  return () => {
    const s = useStore.getState();
    const last = s.activeChannelId;
    // on phones Home is the channel list itself
    const phone = !!window.matchMedia?.('(max-width: 768px)').matches;
    nav(!phone && last && !isDmKind(s.channels[last]) ? `/c/${last}` : '/');
  };
}

// ---------------------------------------------------------------------------
// "+" create menu

export function CreateMenu({ onClose }: { onClose: () => void }) {
  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const items: [ReactNode, string, string, string, () => void][] = [
    [<Pencil size={16} />, 'var(--accent)', t('Message'), t('Start a conversation in a DM or channel'), () => openModal({ type: 'newMessage' })],
    [<Hash size={16} />, '#5f6b7a', t('Channel'), t('Start a group conversation by topic'), () => openModal({ type: 'createChannel' })],
    [<Headphones size={16} />, '#16a37f', t('Huddle'), t('Start a video or audio chat'), () => openModal({ type: 'newMessage' })],
    [<Bot size={16} />, '#2f7bf5', t('Agent'), t('Add an AI teammate with a role and tasks'), () => openModal({ type: 'agent' })],
  ];
  return (
    <div className="create-menu">
      <div className="create-menu-title">{t('Create')}</div>
      {items.map(([icon, color, title, desc, fn]) => (
        <button key={title} className="create-item" onClick={go(fn)}>
          <span className="create-icon" style={{ background: color }}>
            {icon}
          </span>
          <span>
            <b>{title}</b>
            <span className="create-desc">{desc}</span>
          </span>
        </button>
      ))}
      <div className="menu-sep" />
      <button className="create-item plain" onClick={go(() => openModal({ type: 'invite' }))}>
        <UserPlus size={16} /> <span>{t('Invite people')}</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// top of the left column: workspace + section switcher

function WorkspaceHeader() {
  const ws = useStore((s) => s.workspace);
  const menu = usePopover();
  return (
    <div className="nav-head">
      <button className="ws-name" ref={menu.ref} onClick={menu.toggle}>
        <WorkspaceIcon size={26} />
        <span>{ws?.name}</span>
        <ChevronDown size={14} />
      </button>
      <Tip label={t('Preferences')} placement="bottom">
        <button className="nav-icon-btn" onClick={() => openModal({ type: 'preferences' })} aria-label={t('Preferences')}>
          <Settings size={17} />
        </button>
      </Tip>
      <Tip label={t('New message')} placement="bottom">
        <button className="nav-icon-btn compose" onClick={() => openModal({ type: 'newMessage' })} aria-label={t('New message')}>
          <SquarePen size={17} />
        </button>
      </Tip>
      {menu.open && <WorkspaceMenu anchor={menu.ref.current} onClose={menu.close} />}
    </div>
  );
}

interface SectionItem {
  key: Section;
  label: string;
  icon: (size: number) => ReactNode;
  go: () => void;
  /** number for a badge */
  count: number;
  /** unread without a count (Home) */
  dot?: boolean;
}

/** Everything needed to render a section entry, keyed by section, plus the user's order and visibility. */
export function useSectionItems() {
  const nav = useNavigate();
  const goHome = useGoHome();
  const dmUnread = useDmUnread();
  const home = useHomeUnread();
  const activity = useStore((s) => s.activityUnread);
  const saved = useStore((s) => s.me?.prefs.navTabs);
  const tabs = useMemo(() => navTabsOf({ navTabs: saved }), [saved]);
  const items: Record<Section, SectionItem> = {
    home: { key: 'home', label: t('Home'), icon: (n) => <Home size={n} />, go: goHome, count: home.mentions, dot: home.unread },
    dms: { key: 'dms', label: t('DMs'), icon: (n) => <MessagesSquare size={n} />, go: () => nav('/dms'), count: dmUnread },
    activity: { key: 'activity', label: t('Activity'), icon: (n) => <Bell size={n} />, go: () => nav('/activity'), count: activity },
    files: { key: 'files', label: t('Files'), icon: (n) => <Files size={n} />, go: () => nav('/files'), count: 0 },
    later: { key: 'later', label: t('Later'), icon: (n) => <Bookmark size={n} />, go: () => nav('/later'), count: 0 },
    agents: { key: 'agents', label: t('Agents'), icon: (n) => <Bot size={n} />, go: () => nav('/agents'), count: 0 },
  };
  return {
    visible: tabs.filter((x) => x.visible).map((x) => items[x.id]),
    hidden: tabs.filter((x) => !x.visible).map((x) => items[x.id]),
  };
}

function SectionTabs() {
  const section = useSection();
  const { visible, hidden } = useSectionItems();
  const more = usePopover<HTMLButtonElement>();
  const hiddenActive = hidden.some((x) => x.key === section);
  const hiddenCount = hidden.reduce((n, x) => n + x.count, 0);
  return (
    <nav className="nav-tabs" aria-label={t('Sections')}>
      {visible.map((x) => (
        <Tip label={x.label} placement="bottom" key={x.key}>
          <button className={`nav-tab${section === x.key ? ' active' : ''}`} onClick={x.go} aria-label={x.label} aria-current={section === x.key ? 'page' : undefined}>
            {x.icon(19)}
            {x.count > 0 ? <Badge count={x.count} className="nav-badge" /> : x.dot ? <span className="nav-dot" /> : null}
          </button>
        </Tip>
      ))}
      {hidden.length > 0 && (
        <Tip label={t('More')} placement="bottom">
          <button
            className={`nav-tab${hiddenActive || more.open ? ' active' : ''}`}
            ref={more.ref}
            onClick={more.toggle}
            aria-label={t('More')}
            aria-haspopup="menu"
            aria-expanded={more.open}
          >
            <MoreHorizontal size={19} />
            {hiddenCount > 0 && <Badge count={hiddenCount} className="nav-badge" />}
          </button>
        </Tip>
      )}
      {more.open && (
        <Popover anchor={more.ref.current} onClose={more.close} placement="bottom-end">
          <Menu className="nav-more-menu">
            {hidden.map((x) => (
              <MenuItem
                key={x.key}
                icon={x.icon(18)}
                onClick={() => {
                  more.close();
                  x.go();
                }}
                right={x.count ? <Badge count={x.count} /> : undefined}
              >
                {x.label}
              </MenuItem>
            ))}
            <div className="menu-sep" />
            <MenuItem
              icon={<Settings size={18} />}
              onClick={() => {
                more.close();
                openModal({ type: 'preferences', tab: 'navigation' });
              }}
            >
              {t('Customize sections…')}
            </MenuItem>
          </Menu>
        </Popover>
      )}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// bottom of the left column: you, create, theme

function SidebarFooter() {
  const me = useStore((s) => s.me);
  const dark = useStore((s) => isDarkMode(s.me?.prefs.colorMode));
  const user = usePopover<HTMLButtonElement>();
  const create = usePopover<HTMLButtonElement>();
  if (!me) return null;
  return (
    <div className="nav-foot">
      <button className="nav-me" ref={user.ref} onClick={user.toggle} aria-label={t('Your profile')}>
        <Avatar user={me} size={30} presence />
        <span className="nav-me-text">
          <b>{displayName(me)}</b>
          <span className="nav-me-status">
            {me.statusEmoji && <Emoji code={me.statusEmoji} size={12} />} {me.statusText || (me.awayManual ? t('Away') : t('Active'))}
          </span>
        </span>
      </button>
      {user.open && <UserMenu anchor={user.ref.current} onClose={user.close} placement="top-start" />}
      <Tip label={dark ? t('Light mode') : t('Dark mode')}>
        <button className="nav-icon-btn" onClick={() => void updatePrefs({ colorMode: dark ? 'light' : 'dark' })} aria-label={dark ? t('Light mode') : t('Dark mode')}>
          {dark ? <Sun size={17} /> : <Moon size={17} />}
        </button>
      </Tip>
      <Tip label={t('Create')}>
        <button className="nav-create" ref={create.ref} onClick={create.toggle} aria-label={t('Create')}>
          <Plus size={18} />
        </button>
      </Tip>
      {create.open && (
        <Popover anchor={create.ref.current} onClose={create.close} placement="top-end">
          <CreateMenu onClose={create.close} />
        </Popover>
      )}
    </div>
  );
}

/** The whole left column: header, section switcher, the current pane, huddle bar and footer. */
export function LeftColumn({ children }: { children: ReactNode }) {
  const { width, onDown } = useResizableWidth('relay.sidebarWidth', 280, 220, 440);
  // the top bar aligns the search box with the right edge of this column
  useEffect(() => {
    document.documentElement.style.setProperty('--left-width', `${width}px`);
  }, [width]);
  return (
    <aside className="left-col" style={{ width }}>
      <WorkspaceHeader />
      <SectionTabs />
      <div className="left-pane">{children}</div>
      <HuddleBar />
      <SidebarFooter />
      <div className="resize-handle" onPointerDown={(e) => onDown(e)} />
    </aside>
  );
}

// ---------------------------------------------------------------------------
// mobile bottom tab bar

export function TabBar() {
  const section = useSection();
  const { visible } = useSectionItems();
  const meId = useStore((s) => s.me?.id);
  const user = usePopover();
  return (
    <nav className="tabbar">
      {visible.slice(0, 4).map((x) => (
        <button key={x.key} className={`tab${section === x.key ? ' active' : ''}`} onClick={x.go}>
          <span className="tab-icon">
            {x.icon(22)}
            {x.count > 0 && <Badge count={x.count} className="nav-badge" />}
          </span>
          <span>{x.label}</span>
        </button>
      ))}
      <button className="tab" ref={user.ref} onClick={user.toggle}>
        <span className="tab-icon">
          <Avatar userId={meId} size={24} presence />
        </span>
        <span>{t('You')}</span>
      </button>
      {user.open && <UserMenu anchor={user.ref.current} onClose={user.close} placement="top-end" />}
    </nav>
  );
}
