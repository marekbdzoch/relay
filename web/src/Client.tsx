import { Suspense, useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Bell, Bookmark, MessagesSquare } from './components/icons.tsx';
import { S, channelTitle, isAdmin, isDmKind, set, useStore } from './store.ts';
import { useOnboarding } from './lib/onboarding.ts';
import { t } from './i18n.ts';
import { markRead, openModal, setRight } from './actions.ts';
import { setNavigate } from './lib/nav.ts';
import { updateTitleBadge } from './lib/notify.ts';
import { TopBar } from './components/TopBar.tsx';
import { LeftColumn, TabBar } from './components/AppNav.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { RightPanel } from './components/RightPanel.tsx';
import { HuddleScreens } from './components/Huddle.tsx';
import { EmptyState, Spinner } from './components/ui.tsx';
import { ChannelView } from './views/ChannelView.tsx';
import { DMList } from './views/DMList.tsx';
import { ActivityList } from './views/ActivityList.tsx';
import { LaterList } from './views/LaterList.tsx';
import { ModalHost } from './modals/ModalHost.tsx';
import { lazyNamed, prefetchLazyChunks } from './lib/lazy.ts';

// secondary views are split into their own chunks (prefetched when idle)
const ThreadsView = lazyNamed(() => import('./views/ThreadsView.tsx'), 'ThreadsView');
const DraftsView = lazyNamed(() => import('./views/DraftsView.tsx'), 'DraftsView');
const SearchView = lazyNamed(() => import('./views/SearchView.tsx'), 'SearchView');
const BrowseView = lazyNamed(() => import('./views/BrowseView.tsx'), 'BrowseView');
const UnreadsView = lazyNamed(() => import('./views/UnreadsView.tsx'), 'UnreadsView');
const HuddlesView = lazyNamed(() => import('./views/HuddlesView.tsx'), 'HuddlesView');
const FilesView = lazyNamed(() => import('./views/FilesView.tsx'), 'FilesView');
const FilesNav = lazyNamed(() => import('./views/FilesView.tsx'), 'FilesNav');
const AgentsView = lazyNamed(() => import('./views/AgentsView.tsx'), 'AgentsView');
const Onboarding = lazyNamed(() => import('./views/Onboarding.tsx'), 'Onboarding');

/** Thin bar on public demo instances: when it resets and where to get your own copy. */
function DemoBanner() {
  const demo = useStore((s) => s.workspace?.demo);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  if (!demo) return null;
  const left = Math.max(0, demo.nextResetAt - Date.now());
  const hours = Math.floor(left / 3_600_000);
  const minutes = Math.floor((left % 3_600_000) / 60_000);
  return (
    <div className="demo-banner" role="note">
      <b>{t('Demo')}</b>
      <span>{t('Everything you do here resets in {time}.', { time: hours ? `${hours} h ${minutes} min` : `${minutes} min` })}</span>
      <a href="https://github.com/marekbdzoch/relay#get-started-no-technical-skills-needed" target="_blank" rel="noreferrer">
        {t('Deploy your own Relay')} →
      </a>
    </div>
  );
}

/** First-run setup wizard for admins (also reopened from the workspace menu). */
function OnboardingHost() {
  const pending = useStore((s) => !!s.workspace?.onboardingPending && isAdmin(s.me));
  const open = useOnboarding((s) => s.open);
  if (!pending && !open) return null;
  return (
    <Suspense fallback={null}>
      <Onboarding />
    </Suspense>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.kind ?? ''}`}>
          {x.text}
        </div>
      ))}
    </div>
  );
}

function defaultChannel() {
  const s = S();
  const last = localStorage.getItem('relay.lastChannel');
  if (last && s.memberships[last] && s.channels[last]) return last;
  const general = Object.values(s.channels).find((c) => c.name === 'general' && s.memberships[c.id]);
  if (general) return general.id;
  return Object.keys(s.memberships)[0];
}

/** Sidebar order, used for Alt+↑/↓ navigation. */
function sidebarOrder() {
  const s = S();
  const items = Object.values(s.memberships)
    .map((m) => ({ m, c: s.channels[m.channelId] }))
    .filter((x) => x.c && !(isDmKind(x.c) && x.m.hidden) && !x.c.archived);
  const group = (x: (typeof items)[number]) => (x.m.starred ? 0 : isDmKind(x.c) ? 2 : 1);
  return items
    .sort((a, b) => group(a) - group(b) || (group(a) === 2 ? (b.c.lastMessageAt ?? 0) - (a.c.lastMessageAt ?? 0) : channelTitle(a.c).localeCompare(channelTitle(b.c))))
    .map((x) => x.c.id);
}

function useGlobalShortcuts() {
  const nav = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'k' && !e.shiftKey) {
        e.preventDefault();
        openModal({ type: 'quickSwitcher' });
      } else if (mod && e.shiftKey && k === 'a') {
        e.preventDefault();
        nav('/activity');
      } else if (mod && e.shiftKey && k === 'l') {
        e.preventDefault();
        nav('/later');
      } else if (mod && e.shiftKey && k === 'k') {
        e.preventDefault();
        nav('/dms');
      } else if (mod && e.shiftKey && k === 't') {
        e.preventDefault();
        nav('/threads');
      } else if (mod && !e.shiftKey && k === 'n') {
        e.preventDefault();
        openModal({ type: 'newMessage' });
      } else if (mod && k === ',') {
        e.preventDefault();
        openModal({ type: 'preferences' });
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const s = S();
        let order = sidebarOrder();
        if (e.shiftKey) order = order.filter((id) => id === s.activeChannelId || (s.memberships[id]?.unread ?? 0) > 0);
        if (!order.length) return;
        const idx = order.indexOf(s.activeChannelId ?? '');
        const next = order[(idx + (e.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length];
        if (next) nav(`/c/${next}`);
      } else if (e.key === 'Escape' && !S().modal && !document.querySelector('.popover, .search-box')) {
        const s = S();
        const typing = (e.target as HTMLElement)?.tagName === 'TEXTAREA' && (e.target as HTMLTextAreaElement).value;
        if (typing) return;
        if (s.right) setRight(null);
        else if (s.activeChannelId) {
          markRead(s.activeChannelId);
          set((st) => void delete st.unreadMarker[s.activeChannelId!]);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav]);
}

function PaneSpinner() {
  return (
    <div className="center-fill">
      <Spinner />
    </div>
  );
}

function Placeholder({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <main className="main-view placeholder-view">
      <EmptyState icon={icon} title={title}>
        {body}
      </EmptyState>
    </main>
  );
}

const MOBILE = '(max-width: 768px)';
function useIsMobile() {
  const [mobile, setMobile] = useState(() => !!window.matchMedia?.(MOBILE).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(MOBILE);
    if (!mq) return;
    const on = () => setMobile(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return mobile;
}

export function Client() {
  const loc = useLocation();
  const mobile = useIsMobile();
  const demoMode = useStore((s) => !!s.workspace?.demo);
  const nav = useNavigate();
  const memberships = useStore((s) => s.memberships);
  const hasRight = useStore((s) => !!s.right);
  useGlobalShortcuts();

  useEffect(() => setNavigate((to, o) => nav(to, o)), [nav]);
  useEffect(() => prefetchLazyChunks(), []);

  useEffect(() => {
    const onFocus = () => set((s) => void (s.focused = true));
    const onBlur = () => set((s) => void (s.focused = false));
    const onVis = () => set((s) => void (s.focused = document.visibilityState === 'visible' && document.hasFocus()));
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const params = new URLSearchParams(loc.search);
  const seg = loc.pathname.split('/').filter(Boolean);
  const section = seg[0] ?? '';
  const threadId = params.get('thread') ? Number(params.get('thread')) : undefined;

  useEffect(() => {
    updateTitleBadge();
  }, [loc.pathname]);

  // on phones "/" is the channel list itself; on wider screens it opens the last channel next to it
  if (!section && !mobile) {
    const id = defaultChannel();
    return id ? <Navigate to={`/c/${id}`} replace /> : <Navigate to="/browse/channels" replace />;
  }

  let left: React.ReactNode = <Sidebar />;
  let main: React.ReactNode = null;
  const channelId = ['c', 'dms', 'activity', 'later'].includes(section) ? seg[1] : undefined;
  const messageId = channelId && seg[2] ? Number(seg[2]) : undefined;

  if (section === 'dms') left = <DMList activeId={channelId} />;
  if (section === 'activity') left = <ActivityList activeKey={channelId ? `${channelId}/${messageId ?? ''}` : undefined} />;
  if (section === 'later') left = <LaterList activeKey={channelId ? `${channelId}/${messageId ?? ''}` : undefined} />;
  if (section === 'files') left = <FilesNav />;

  if (channelId) main = <ChannelView key={channelId} channelId={channelId} messageId={messageId} threadId={threadId} />;
  else if (section === 'threads') main = <ThreadsView />;
  else if (section === 'unreads') main = <UnreadsView />;
  else if (section === 'huddles') main = <HuddlesView />;
  else if (section === 'files') main = <FilesView />;
  else if (section === 'agents') main = <AgentsView />;
  else if (section === 'drafts') main = <DraftsView />;
  else if (section === 'search') main = <SearchView />;
  else if (section === 'browse') main = <BrowseView tab={(seg[1] as 'channels' | 'people' | 'files') ?? 'people'} />;
  else if (section === 'dms') main = <Placeholder icon={<MessagesSquare size={40} />} title={t('Direct messages')} body={t('Pick a conversation on the left, or start a new one.')} />;
  else if (section === 'activity') main = <Placeholder icon={<Bell size={40} />} title={t('Activity')} body={t('Mentions, reactions and replies to your threads. Pick an item on the left.')} />;
  else if (section === 'later') main = <Placeholder icon={<Bookmark size={40} />} title={t('Later')} body={t('Messages you saved for later. Pick one on the left to see it in context.')} />;
  else if (!section) main = null; // phone: the channel list is the whole screen
  else if (section === 'c') main = <Navigate to="/" replace />;
  else return <Navigate to="/" replace />;

  const showMainOnMobile = !!channelId || ['threads', 'drafts', 'search', 'browse', 'unreads', 'huddles', 'files', 'agents'].includes(section);
  void memberships;

  return (
    <div className={`client${demoMode ? ' has-demo' : ''} section-${section}${showMainOnMobile ? ' mobile-main' : ' mobile-list'}${hasRight ? ' has-right' : ''}`}>
      <DemoBanner />
      <TopBar />
      <div className="client-body">
        <div className="workspace">
          <LeftColumn>
            <Suspense fallback={<PaneSpinner />}>{left}</Suspense>
          </LeftColumn>
          <div className="main-col">
            <Suspense fallback={<PaneSpinner />}>{main}</Suspense>
          </div>
          <RightPanel />
        </div>
      </div>
      <TabBar />
      <ModalHost />
      <HuddleScreens />
      <OnboardingHost />
      <Toasts />
    </div>
  );
}
