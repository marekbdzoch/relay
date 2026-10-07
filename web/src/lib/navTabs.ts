import type { NavSection, UserPrefs } from '../../../shared/types.ts';

export const NAV_SECTIONS: NavSection[] = ['home', 'dms', 'activity', 'files', 'later', 'agents'];

export type NavTabs = { id: NavSection; visible: boolean }[];

/**
 * The user's section icons in their chosen order. Unknown or duplicate entries are dropped, sections added in a
 * newer version are appended (visible), and Home can never be hidden: it is the way back to the channel list.
 */
export function navTabsOf(prefs: UserPrefs | undefined): NavTabs {
  const out: NavTabs = [];
  for (const tab of prefs?.navTabs ?? []) {
    if (!NAV_SECTIONS.includes(tab?.id) || out.some((x) => x.id === tab.id)) continue;
    out.push({ id: tab.id, visible: tab.id === 'home' || tab.visible !== false });
  }
  for (const id of NAV_SECTIONS) if (!out.some((x) => x.id === id)) out.push({ id, visible: true });
  return out;
}

/** Moves the tab at `from` to index `to`. */
export function moveNavTab(tabs: NavTabs, from: number, to: number): NavTabs {
  if (from === to || from < 0 || to < 0 || from >= tabs.length || to >= tabs.length) return tabs;
  const next = [...tabs];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function setNavTabVisible(tabs: NavTabs, id: NavSection, visible: boolean): NavTabs {
  return tabs.map((x) => (x.id === id ? { ...x, visible: id === 'home' || visible } : x));
}
