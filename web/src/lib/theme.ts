/**
 * Themes are single-tone palettes (Material-style): every surface is a light tint of the accent,
 * and each theme has a matching light and dark variant.
 */
interface Tones {
  /** app background behind the content cards (top bar + left column) */
  frame: string;
  /** content cards (conversation, right panel) */
  surface: string;
  /** primary actions */
  accent: string;
  onAccent: string;
  /** selected items, chips, mention highlight */
  container: string;
  onContainer: string;
}

export interface Theme {
  id: string;
  name: string;
  light: Tones;
  dark: Tones;
}

export const THEMES: Theme[] = [
  {
    id: 'violet',
    name: 'Violet',
    light: { frame: '#f6f2fb', surface: '#ffffff', accent: '#6750a4', onAccent: '#ffffff', container: '#e8def8', onContainer: '#21005d' },
    dark: { frame: '#141218', surface: '#1d1b20', accent: '#d0bcff', onAccent: '#381e72', container: '#4a4458', onContainer: '#e8def8' },
  },
  {
    id: 'blue',
    name: 'Blue',
    light: { frame: '#f1f5fd', surface: '#ffffff', accent: '#0b57d0', onAccent: '#ffffff', container: '#d3e3fd', onContainer: '#041e49' },
    dark: { frame: '#111318', surface: '#1b1d22', accent: '#a8c7fa', onAccent: '#062e6f', container: '#0842a0', onContainer: '#d3e3fd' },
  },
  {
    id: 'teal',
    name: 'Teal',
    light: { frame: '#eff7f6', surface: '#ffffff', accent: '#006a6a', onAccent: '#ffffff', container: '#c8ecea', onContainer: '#002020' },
    dark: { frame: '#0f1514', surface: '#181e1d', accent: '#7fd5d4', onAccent: '#003737', container: '#004f4f', onContainer: '#9cf1f0' },
  },
  {
    id: 'green',
    name: 'Green',
    light: { frame: '#f2f7ee', surface: '#ffffff', accent: '#3a6a1f', onAccent: '#ffffff', container: '#d5edc4', onContainer: '#082100' },
    dark: { frame: '#11140e', surface: '#1a1d16', accent: '#a5d389', onAccent: '#0c3900', container: '#245109', onContainer: '#c0f0a3' },
  },
  {
    id: 'rose',
    name: 'Rose',
    light: { frame: '#fcf2f5', surface: '#ffffff', accent: '#984061', onAccent: '#ffffff', container: '#ffd9e2', onContainer: '#3e001d' },
    dark: { frame: '#191113', surface: '#221a1c', accent: '#ffb0c8', onAccent: '#5e1133', container: '#7b2949', onContainer: '#ffd9e2' },
  },
  {
    id: 'amber',
    name: 'Amber',
    light: { frame: '#fbf5ee', surface: '#ffffff', accent: '#855300', onAccent: '#ffffff', container: '#ffddb3', onContainer: '#291800' },
    dark: { frame: '#18120c', surface: '#211b15', accent: '#ffb951', onAccent: '#462a00', container: '#643f00', onContainer: '#ffddb3' },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    light: { frame: '#f1f3f4', surface: '#ffffff', accent: '#3c4043', onAccent: '#ffffff', container: '#dfe1e3', onContainer: '#1f1f1f' },
    dark: { frame: '#131314', surface: '#1e1f20', accent: '#c4c7c5', onAccent: '#1f1f1f', container: '#3b3d3e', onContainer: '#e3e3e3' },
  },
];

export const DEFAULT_THEME = 'violet';
export const DEFAULT_COLOR_MODE = 'light';

export function isDarkMode(colorMode?: 'light' | 'dark' | 'system') {
  const mode = colorMode ?? DEFAULT_COLOR_MODE;
  return mode === 'dark' || (mode === 'system' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

let current: { themeId?: string; colorMode?: 'light' | 'dark' | 'system' } = {};

export function applyTheme(themeId?: string, colorMode?: 'light' | 'dark' | 'system') {
  current = { themeId, colorMode };
  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0];
  const dark = isDarkMode(colorMode);
  const tones = dark ? theme.dark : theme.light;
  const root = document.documentElement;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  set('--frame-bg', tones.frame);
  set('--sidebar-bg', tones.frame);
  set('--bg', tones.surface);
  set('--accent', tones.accent);
  set('--on-accent', tones.onAccent);
  set('--accent-container', tones.container);
  set('--on-accent-container', tones.onContainer);
  set('--sidebar-active-bg', tones.container);
  set('--sidebar-active-text', tones.onContainer);
  root.dataset.mode = dark ? 'dark' : 'light';
  root.dataset.modePref = colorMode ?? DEFAULT_COLOR_MODE;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', tones.frame);
}

window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if ((current.colorMode ?? DEFAULT_COLOR_MODE) === 'system') applyTheme(current.themeId, current.colorMode);
});
