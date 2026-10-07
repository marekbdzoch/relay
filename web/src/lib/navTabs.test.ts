import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS, moveNavTab, navTabsOf, setNavTabVisible } from './navTabs.ts';

describe('navTabsOf', () => {
  it('defaults to every section, visible, in the default order', () => {
    expect(navTabsOf(undefined)).toEqual(NAV_SECTIONS.map((id) => ({ id, visible: true })));
    expect(navTabsOf({})).toEqual(NAV_SECTIONS.map((id) => ({ id, visible: true })));
  });

  it('keeps the saved order and visibility, drops junk and appends missing sections', () => {
    const tabs = navTabsOf({
      navTabs: [
        { id: 'agents', visible: true },
        { id: 'bogus' as any, visible: true },
        { id: 'files', visible: false },
        { id: 'agents', visible: false },
        { id: 'home', visible: false },
        null as any,
      ],
    });
    expect(tabs).toEqual([
      { id: 'agents', visible: true },
      { id: 'files', visible: false },
      { id: 'home', visible: true },
      { id: 'dms', visible: true },
      { id: 'activity', visible: true },
      { id: 'later', visible: true },
    ]);
  });
});

describe('moveNavTab / setNavTabVisible', () => {
  const base = navTabsOf({});
  it('moves a tab and ignores out-of-range moves', () => {
    expect(moveNavTab(base, 5, 0).map((x) => x.id)).toEqual(['agents', 'home', 'dms', 'activity', 'files', 'later']);
    expect(moveNavTab(base, 0, 1).map((x) => x.id)).toEqual(['dms', 'home', 'activity', 'files', 'later', 'agents']);
    expect(moveNavTab(base, 0, 6)).toBe(base);
    expect(moveNavTab(base, -1, 0)).toBe(base);
    expect(moveNavTab(base, 2, 2)).toBe(base);
  });

  it('hides and shows sections, but never Home', () => {
    expect(setNavTabVisible(base, 'files', false).find((x) => x.id === 'files')!.visible).toBe(false);
    expect(setNavTabVisible(setNavTabVisible(base, 'files', false), 'files', true)).toEqual(base);
    expect(setNavTabVisible(base, 'home', false).find((x) => x.id === 'home')!.visible).toBe(true);
  });
});
