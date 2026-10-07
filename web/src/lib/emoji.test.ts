import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as emoji from './emoji.ts';
import { DEFAULT_QUICK_REACTIONS, emojiName, isEmojiOnly, loadEmojiData, nativeFor, resolveId, searchEmoji, shortcodeForNative } from './emoji.ts';

describe('before loadEmojiData()', () => {
  it('knows no emoji and has no data yet', async () => {
    vi.resetModules();
    const fresh = await import('./emoji.ts');
    expect(fresh.emojiData).toBeNull();
    expect(fresh.nativeFor('tada')).toBeNull();
    expect(fresh.resolveId('thumbsup')).toBeNull();
    expect(fresh.shortcodeForNative('🎉')).toBeNull();
    expect(fresh.emojiName('tada')).toBe('tada');
    expect(fresh.searchEmoji('ta', { tada_custom: '/x.png' })).toEqual([{ id: 'tada_custom', url: '/x.png' }]);
    // shortcode syntax is recognised even without the dataset
    expect(fresh.isEmojiOnly(':tada:')).toBe(true);
  });

  it('is idempotent and returns the same promise', async () => {
    vi.resetModules();
    const fresh = await import('./emoji.ts');
    const p1 = fresh.loadEmojiData();
    expect(fresh.loadEmojiData()).toBe(p1);
    await p1;
    expect(fresh.emojiData).toHaveProperty('emojis');
    expect(fresh.nativeFor('tada')).toBe('🎉');
  });
});

beforeAll(() => loadEmojiData());

describe('resolveId', () => {
  it('resolves ids, emoji-mart aliases and Slack aliases', () => {
    expect(resolveId('heart')).toBe('heart');
    expect(resolveId('thumbsup')).toBe('+1');
    expect(resolveId('thumbsdown')).toBe('-1');
    expect(resolveId('simple_smile')).toBe('slightly_smiling_face');
    expect(resolveId('wave::skin-tone-3')).toBe('wave');
  });
  it('returns null for unknown codes', () => {
    expect(resolveId('definitely_not_an_emoji')).toBeNull();
  });
});

describe('nativeFor', () => {
  it('returns the native character', () => {
    expect(nativeFor('+1')).toBe('👍');
    expect(nativeFor('thumbsup')).toBe('👍');
    expect(nativeFor('tada')).toBe('🎉');
  });
  it('applies skin tones', () => {
    expect(nativeFor('wave::skin-tone-2')).toBe('👋🏻');
    expect(nativeFor('wave::skin-tone-6')).toBe('👋🏿');
  });
  it('falls back to the default skin for invalid tones and emoji without skins', () => {
    expect(nativeFor('wave::skin-tone-9')).toBe('👋');
    expect(nativeFor('heart::skin-tone-3')).toBe('❤️');
  });
  it('returns null for unknown codes', () => {
    expect(nativeFor('nope_nope')).toBeNull();
  });
});

describe('shortcodeForNative', () => {
  it('maps natives back to shortcodes incl. skin tones', () => {
    expect(shortcodeForNative('👍')).toBe('+1');
    expect(shortcodeForNative('👋🏽')).toBe('wave::skin-tone-4');
    expect(shortcodeForNative('x')).toBeNull();
  });
  it('round-trips with nativeFor', () => {
    for (const code of ['wave::skin-tone-2', 'rocket', 'fire', '+1::skin-tone-5']) expect(shortcodeForNative(nativeFor(code)!)).toBe(code);
  });
});

describe('emojiName', () => {
  it('normalises aliases and keeps unknown codes', () => {
    expect(emojiName('thumbsup')).toBe('+1');
    expect(emojiName('custom_party')).toBe('custom_party');
  });
});

describe('searchEmoji', () => {
  it('lists custom emoji first, then prefix matches, then keyword matches', () => {
    const res = searchEmoji('smi', { smile_custom: '/e/sc.png', other: '/e/o.png' });
    expect(res[0]).toEqual({ id: 'smile_custom', url: '/e/sc.png' });
    expect(res.slice(1).every((e) => e.native)).toBe(true);
    expect(res.map((e) => e.id)).toContain('smile');
    expect(res).toHaveLength(8);
  });
  it('is case-insensitive and respects the limit', () => {
    expect(searchEmoji('ROCK', {}, 3).map((e) => e.id)[0]).toBe('rock');
    expect(searchEmoji('a', {}, 3)).toHaveLength(3);
  });
  it('includes keyword matches when there are few prefix matches', () => {
    const ids = searchEmoji('thumbs', {}).map((e) => e.id);
    expect(ids).toContain('+1');
  });
  it('returns nothing for nonsense', () => {
    expect(searchEmoji('qqqqzzzz', {})).toEqual([]);
  });
});

describe('isEmojiOnly', () => {
  it.each([
    ['👍', true],
    ['  🎉🎉  ', true],
    ['👍 🎉', true],
    [':tada:', true],
    [':+1::skin-tone-2: :rocket:', true],
    ['👨‍👩‍👧', true],
    ['❤️', true],
    ['hi 👍', false],
    ['', false],
    ['   ', false],
    ['123', false],
    ['#', false],
    ['*', false],
    [':not closed', false],
    ['👍'.repeat(31), false],
  ])('%j → %s', (text, expected) => {
    expect(isEmojiOnly(text)).toBe(expected);
  });
});

describe('constants', () => {
  it('quick reactions are valid emoji', () => {
    for (const c of DEFAULT_QUICK_REACTIONS) expect(nativeFor(c)).toBeTruthy();
    expect(emoji.emojiData).toHaveProperty('emojis');
  });
});
