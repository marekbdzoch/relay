import { afterEach, describe, expect, it, vi } from 'vitest';
import { LANGUAGES, getLanguage, locale, setLanguage, t, tp } from './i18n.ts';
import { cs } from './i18n.cs.ts';

afterEach(() => setLanguage('en'));

describe('t()', () => {
  it('returns the key itself in English', () => {
    setLanguage('en');
    expect(t('Delete')).toBe('Delete');
    expect(t('Leave #{name}?', { name: 'general' })).toBe('Leave #general?');
  });

  it('translates to Czech and fills placeholders', () => {
    setLanguage('cs');
    expect(t('Delete')).toBe('Smazat');
    expect(t('Leave #{name}?', { name: 'general' })).toBe('Opustit #general?');
    expect(t('{a} and {b} are typing…', { a: 'Jana', b: 'Petr' })).toBe('Jana a Petr píšou…');
  });

  it('falls back to the key for missing translations', () => {
    setLanguage('cs');
    expect(t('Definitely not translated {x}', { x: 1 })).toBe('Definitely not translated 1');
  });

  it('leaves unknown placeholders untouched and accepts numeric values', () => {
    expect(t('{a} of {b}', { a: 0 })).toBe('0 of {b}');
    expect(t('no vars {x}')).toBe('no vars {x}');
  });

  it('does not treat plural arrays as plain strings', () => {
    setLanguage('cs');
    expect(t('{n} replies', { n: 3 })).toBe('3 replies');
  });
});

describe('tp()', () => {
  it('uses the English one/other forms', () => {
    setLanguage('en');
    expect(tp(1, '{n} reply', '{n} replies')).toBe('1 reply');
    expect(tp(0, '{n} reply', '{n} replies')).toBe('0 replies');
    expect(tp(7, '{n} reply', '{n} replies')).toBe('7 replies');
  });

  it.each([
    [1, '1 odpověď'],
    [2, '2 odpovědi'],
    [3, '3 odpovědi'],
    [4, '4 odpovědi'],
    [5, '5 odpovědí'],
    [0, '0 odpovědí'],
    [11, '11 odpovědí'],
    [22, '22 odpovědí'],
  ])('Czech plural of %i → %s', (n, expected) => {
    setLanguage('cs');
    expect(tp(n, '{n} reply', '{n} replies')).toBe(expected);
  });

  it('passes extra vars along with n', () => {
    setLanguage('en');
    expect(tp(2, '{n} file in {c}', '{n} files in {c}', { c: '#x' })).toBe('2 files in #x');
  });

  it('uses a plain-string dictionary entry for the plural form', () => {
    setLanguage('cs');
    // `t('Delete')` is a plain string in the Czech dictionary
    expect(tp(5, 'one', 'Delete')).toBe('Smazat');
    expect(tp(1, 'one {n}', 'Delete')).toBe('one 1');
  });

  it('falls back to earlier forms when a Czech array is short', () => {
    setLanguage('cs');
    const key = '__test short plural__';
    (cs as Record<string, string[]>)[key] = ['{n} jeden'];
    try {
      expect(tp(3, 'x', key)).toBe('3 jeden');
      expect(tp(9, 'x', key)).toBe('9 jeden');
      (cs as Record<string, string[]>)[key] = ['{n} jeden', '{n} dva'];
      expect(tp(9, 'x', key)).toBe('9 dva');
    } finally {
      delete (cs as Record<string, unknown>)[key];
    }
  });
});

describe('language selection', () => {
  it('ignores empty codes', () => {
    setLanguage('cs');
    setLanguage(undefined);
    expect(getLanguage()).toBe('cs');
  });

  it('persists the choice and sets <html lang>', () => {
    setLanguage('cs');
    expect(localStorage.getItem('relay.lang')).toBe('cs');
    expect(document.documentElement.lang).toBe('cs');
    expect(locale()).toBe('cs-CZ');
    setLanguage('en');
    expect(locale()).toBeUndefined();
  });

  it('falls back to English for unsupported languages', () => {
    setLanguage('xx');
    expect(getLanguage()).toBe('en');
    expect(t('Delete')).toBe('Delete');
  });

  it('survives a throwing localStorage', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => setLanguage('cs')).not.toThrow();
    expect(getLanguage()).toBe('cs');
    spy.mockRestore();
  });

  it('lists the supported languages', () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(['en', 'cs']);
  });
});

describe('initial language detection', () => {
  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('prefers the saved language', async () => {
    localStorage.setItem('relay.lang', 'cs');
    vi.resetModules();
    const i18n = await import('./i18n.ts');
    expect(i18n.getLanguage()).toBe('cs');
  });

  it('uses navigator.language when supported', async () => {
    localStorage.clear();
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('cs-CZ');
    vi.resetModules();
    const i18n = await import('./i18n.ts');
    expect(i18n.getLanguage()).toBe('cs');
  });

  it('defaults to English for unsupported or missing navigator languages', async () => {
    localStorage.clear();
    const nav = vi.spyOn(navigator, 'language', 'get').mockReturnValue('fr-FR');
    vi.resetModules();
    expect((await import('./i18n.ts')).getLanguage()).toBe('en');
    nav.mockReturnValue('');
    vi.resetModules();
    expect((await import('./i18n.ts')).getLanguage()).toBe('en');
  });

  it('survives a throwing localStorage on startup', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.resetModules();
    const i18n = await import('./i18n.ts');
    expect(['en', 'cs']).toContain(i18n.getLanguage());
  });
});

describe('Czech dictionary consistency', () => {
  const placeholders = (s: string) =>
    [...s.matchAll(/\{(\w+)\}/g)]
      .map((m) => m[1])
      .sort()
      .join(',');

  it('every translation uses exactly the placeholders of its key', () => {
    const problems: string[] = [];
    for (const [key, value] of Object.entries(cs)) {
      const forms = Array.isArray(value) ? value : [value];
      forms.forEach((form, i) => {
        // the singular form of a plural may spell the number out ("jeden huddle")
        const expected = Array.isArray(value) && i === 0 ? placeholders(key).replace(/(^|,)n(,|$)/, '$1$2').replace(/^,|,$/g, '') : placeholders(key);
        const actual = Array.isArray(value) && i === 0 ? placeholders(form).replace(/(^|,)n(,|$)/, '$1$2').replace(/^,|,$/g, '') : placeholders(form);
        if (actual !== expected) problems.push(`${JSON.stringify(key)} [${i}] → ${JSON.stringify(form)}`);
      });
    }
    expect(problems).toEqual([]);
  });

  it('has no empty translations', () => {
    const empty = Object.entries(cs).filter(([, v]) => (Array.isArray(v) ? v.some((f) => !f.trim()) : !v.trim()));
    expect(empty).toEqual([]);
  });

  it('plural entries have the Czech [one, few, many] shape and keep {n} in few/many', () => {
    for (const [key, value] of Object.entries(cs)) {
      if (!Array.isArray(value)) continue;
      expect(value, key).toHaveLength(3);
      expect(key, key).toContain('{n}');
      expect(value[1], key).toContain('{n}');
      expect(value[2], key).toContain('{n}');
    }
  });

  it('every t()/tp() key used by the non-UI modules is translated', () => {
    const sources = import.meta.glob<string>(['./*.ts', './lib/*.{ts,tsx}', '!./**/*.test.*', '!./i18n*.ts'], { query: '?raw', import: 'default', eager: true });
    expect(Object.keys(sources)).toContain('./actions.ts');
    const missing: string[] = [];
    for (const [f, src] of Object.entries(sources)) {
      for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) if (!(m[1] in cs)) missing.push(`${f}: ${m[1]}`);
      for (const m of src.matchAll(/\btp\([^,]+,\s*'(?:[^'\\]|\\.)*',\s*'((?:[^'\\]|\\.)*)'/g)) if (!Array.isArray(cs[m[1]])) missing.push(`${f}: plural ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });
});
