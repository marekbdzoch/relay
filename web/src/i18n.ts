import { cs } from './i18n.cs.ts';

/**
 * Minimal gettext-style i18n: the English text is the key.
 * Dictionaries map English -> translation. Plural entries are arrays
 * ([one, few, many] for Czech; [one, other] for English-like languages).
 */
type Dict = Record<string, string | string[]>;
const dictionaries: Record<string, Dict> = { cs };

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'cs', name: 'Čeština' },
];

function detect() {
  try {
    const saved = localStorage.getItem('relay.lang');
    if (saved) return saved;
  } catch {
    /* ignore */
  }
  const nav = (navigator.language || 'en').slice(0, 2);
  return dictionaries[nav] ? nav : 'en';
}

let lang = detect();
let dict: Dict = dictionaries[lang] ?? {};

export function setLanguage(code: string | undefined) {
  if (!code) return;
  lang = dictionaries[code] || code === 'en' ? code : 'en';
  dict = dictionaries[lang] ?? {};
  try {
    localStorage.setItem('relay.lang', lang);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = lang;
}

export const getLanguage = () => lang;
export const locale = () => (lang === 'cs' ? 'cs-CZ' : undefined);

function fill(s: string, vars?: Record<string, string | number>) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const v = dict[key];
  return fill(typeof v === 'string' ? v : key, vars);
}

/** Plural: `tp(n, '{n} reply', '{n} replies')`. The `other` form is the dictionary key. */
export function tp(n: number, one: string, other: string, vars?: Record<string, string | number>): string {
  const v = dict[other];
  const all = { n, ...vars };
  if (Array.isArray(v)) {
    if (lang === 'cs') {
      const form = n === 1 ? v[0] : n >= 2 && n <= 4 ? v[1] ?? v[0] : v[2] ?? v[1] ?? v[0];
      return fill(form, all);
    }
    return fill(n === 1 ? v[0] : v[v.length - 1], all);
  }
  return fill(n === 1 ? one : typeof v === 'string' ? v : other, all);
}

setLanguage(lang);
