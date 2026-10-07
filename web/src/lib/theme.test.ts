import { afterEach, describe, expect, it, vi } from 'vitest';

// NOTE: theme.ts is being redesigned concurrently; expected values are always derived from THEMES.

function mockMatchMedia(matches: boolean) {
  const listeners: ((e: { matches: boolean }) => void)[] = [];
  const mql = { matches, addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.push(cb) };
  Object.defineProperty(window, 'matchMedia', { value: vi.fn(() => mql), configurable: true, writable: true });
  const fire = (m: boolean) => {
    mql.matches = m;
    listeners.forEach((l) => l({ matches: m }));
  };
  return { listeners, fire };
}

async function load() {
  vi.resetModules();
  return import('./theme.ts');
}

const root = document.documentElement;
const css = (k: string) => root.style.getPropertyValue(k);

afterEach(() => {
  delete root.dataset.mode;
  delete root.dataset.modePref;
  document.head.innerHTML = '';
});

describe('THEMES', () => {
  it('have unique ids, names and complete light/dark hex palettes', async () => {
    mockMatchMedia(false);
    const { THEMES, DEFAULT_THEME } = await load();
    expect(THEMES.length).toBeGreaterThan(1);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(THEMES.map((t) => t.id)).toContain(DEFAULT_THEME);
    for (const t of THEMES) {
      expect(t.name).toBeTruthy();
      for (const tones of [t.light, t.dark]) for (const c of Object.values(tones)) expect(c, t.id).toMatch(/^#[0-9a-f]{6}$/i);
      expect(Object.keys(t.light).sort()).toEqual(Object.keys(t.dark).sort());
    }
  });
});

describe('isDarkMode', () => {
  it('resolves explicit modes, the default and the OS preference', async () => {
    const { fire } = mockMatchMedia(false);
    const { isDarkMode, DEFAULT_COLOR_MODE } = await load();
    expect(isDarkMode('dark')).toBe(true);
    expect(isDarkMode('light')).toBe(false);
    expect(isDarkMode()).toBe((DEFAULT_COLOR_MODE as string) === 'dark');
    expect(isDarkMode('system')).toBe(false);
    fire(true);
    expect(isDarkMode('system')).toBe(true);
  });
});

describe('applyTheme', () => {
  it('applies the light tones of the selected theme', async () => {
    mockMatchMedia(true);
    const { applyTheme, THEMES } = await load();
    const theme = THEMES[1];
    applyTheme(theme.id, 'light');
    expect(css('--frame-bg')).toBe(theme.light.frame);
    expect(css('--accent')).toBe(theme.light.accent);
    expect(css('--sidebar-active-bg')).toBeTruthy();
    expect(root.dataset.mode).toBe('light');
    expect(root.dataset.modePref).toBe('light');
  });

  it('applies the dark tones in dark mode', async () => {
    mockMatchMedia(false);
    const { applyTheme, THEMES } = await load();
    const theme = THEMES[2];
    applyTheme(theme.id, 'dark');
    expect(css('--frame-bg')).toBe(theme.dark.frame);
    expect(css('--accent')).toBe(theme.dark.accent);
    expect(root.dataset.mode).toBe('dark');
  });

  it('falls back to the first theme and the default mode, updating <meta theme-color>', async () => {
    mockMatchMedia(false);
    const { applyTheme, THEMES, DEFAULT_COLOR_MODE, isDarkMode } = await load();
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
    applyTheme('does-not-exist');
    const tones = isDarkMode() ? THEMES[0].dark : THEMES[0].light;
    expect(css('--frame-bg')).toBe(tones.frame);
    expect(meta.getAttribute('content')).toBe(tones.frame);
    expect(root.dataset.modePref).toBe(DEFAULT_COLOR_MODE);
  });

  it('follows OS colour scheme changes only while the preference is "system"', async () => {
    const { listeners, fire } = mockMatchMedia(false);
    const { applyTheme, THEMES } = await load();
    expect(listeners).toHaveLength(1);
    const theme = THEMES[0];

    applyTheme(theme.id, 'system');
    expect(root.dataset.mode).toBe('light');
    fire(true);
    expect(root.dataset.mode).toBe('dark');
    expect(css('--frame-bg')).toBe(theme.dark.frame);

    applyTheme(theme.id, 'light');
    fire(true);
    expect(root.dataset.mode).toBe('light');
    expect(css('--frame-bg')).toBe(theme.light.frame);
  });
});
