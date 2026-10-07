import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileKind, formatDateTime, formatDay, formatLongDate, formatShortDate, formatSize, formatTime, localTime, startOfDay, timeAgo } from './format.ts';
import { setLanguage } from '../i18n.ts';
import { resetStore, makeMe } from '../test/helpers.ts';

// "now" is Wednesday 2026-10-07 12:00 UTC (tests run with TZ=UTC)
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const norm = (s: string) => s.replace(/\s/g, ' ');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetStore();
  setLanguage('en');
});
afterEach(() => setLanguage('en'));

describe('formatTime', () => {
  it('uses 12h clock in English by default', () => {
    expect(norm(formatTime(at(2026, 10, 7, 14, 5)))).toBe('2:05 PM');
  });
  it('uses 24h clock in Czech by default', () => {
    setLanguage('cs');
    expect(formatTime(at(2026, 10, 7, 14, 5))).toBe('14:05');
  });
  it('honours the timeFormat24 preference', () => {
    resetStore({ me: makeMe({ id: 'U1', prefs: { timeFormat24: true } }) });
    expect(formatTime(at(2026, 10, 7, 9, 5))).toBe('09:05');
    resetStore({ me: makeMe({ id: 'U1', prefs: { timeFormat24: false } }) });
    setLanguage('cs');
    expect(norm(formatTime(at(2026, 10, 7, 21, 5)))).toMatch(/9:05/);
  });
});

describe('startOfDay', () => {
  it('truncates to local midnight', () => {
    expect(startOfDay(at(2026, 10, 7, 23, 59))).toBe(at(2026, 10, 7, 0, 0));
  });
});

describe('formatDay', () => {
  it('names today and yesterday', () => {
    expect(formatDay(at(2026, 10, 7, 1))).toBe('Today');
    expect(formatDay(at(2026, 10, 6, 23))).toBe('Yesterday');
    setLanguage('cs');
    expect(formatDay(at(2026, 10, 7))).toBe('Dnes');
    expect(formatDay(at(2026, 10, 6))).toBe('Včera');
  });
  it('shows weekday and date, adding the year only for other years', () => {
    expect(formatDay(at(2026, 10, 5))).toBe('Monday, October 5');
    expect(formatDay(at(2025, 12, 24))).toBe('Wednesday, December 24, 2025');
  });
});

describe('formatDateTime', () => {
  it('joins day and time', () => {
    expect(norm(formatDateTime(at(2026, 10, 7, 8, 30)))).toBe('Today at 8:30 AM');
    setLanguage('cs');
    expect(formatDateTime(at(2026, 10, 6, 8, 30))).toBe('Včera v 8:30');
  });
});

describe('formatShortDate', () => {
  it('shows the time for today', () => {
    expect(norm(formatShortDate(at(2026, 10, 7, 10, 15)))).toBe('10:15 AM');
  });
  it('shows "Yesterday"', () => {
    expect(formatShortDate(at(2026, 10, 6, 10))).toBe('Yesterday');
  });
  it('shows the weekday within the last 6 days', () => {
    expect(formatShortDate(at(2026, 10, 3, 18))).toBe('Saturday');
  });
  it('shows month and day for older dates and the year for other years', () => {
    expect(formatShortDate(at(2026, 9, 1))).toBe('Sep 1');
    expect(formatShortDate(at(2024, 2, 29))).toBe('Feb 29, 2024');
  });
});

describe('timeAgo', () => {
  it.each([
    [0, 'just now'],
    [30_000, 'just now'],
    [60_000, '1 minute ago'],
    [5 * 60_000, '5 minutes ago'],
    [60 * 60_000, '1 hour ago'],
    [23 * 3600_000, '23 hours ago'],
    [24 * 3600_000, '1 day ago'],
    [29 * 86400_000, '29 days ago'],
  ])('%i ms ago → %s', (diff, expected) => {
    expect(timeAgo(NOW - diff)).toBe(expected);
  });
  it('treats future timestamps as "just now"', () => {
    expect(timeAgo(NOW + 3600_000)).toBe('just now');
  });
  it('falls back to a short date after 30 days', () => {
    expect(timeAgo(at(2026, 8, 1))).toBe('Aug 1');
  });
  it('uses Czech plurals', () => {
    setLanguage('cs');
    expect(timeAgo(NOW - 2 * 60_000)).toBe('před 2 minutami');
    expect(timeAgo(NOW - 3600_000)).toBe('před 1 hodinou');
    expect(timeAgo(NOW - 5 * 86400_000)).toBe('před 5 dny');
  });
});

describe('formatSize', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '2 KB'],
    [1024 * 1024, '1.0 MB'],
    [5.25 * 1024 * 1024, '5.3 MB'],
    [1024 ** 3, '1.00 GB'],
    [2.5 * 1024 ** 3, '2.50 GB'],
  ])('%i bytes → %s', (bytes, expected) => {
    expect(formatSize(bytes)).toBe(expected);
  });
});

describe('localTime', () => {
  it('formats the current time in another timezone', () => {
    resetStore({ me: makeMe({ id: 'U1', prefs: { timeFormat24: true } }) });
    expect(localTime('Asia/Tokyo')).toBe('21:00');
    expect(localTime('')).toBe('12:00');
  });
  it('returns an empty string for invalid timezones', () => {
    expect(localTime('Not/AZone')).toBe('');
  });
});

describe('fileKind', () => {
  it.each([
    ['image/png', 'a.png', 'image'],
    ['video/mp4', 'a.mp4', 'video'],
    ['audio/ogg', 'a.ogg', 'audio'],
    ['application/pdf', 'a.pdf', 'pdf'],
    ['application/octet-stream', 'backup.TAR', 'archive'],
    ['application/octet-stream', 'x.xlsx', 'sheet'],
    ['text/plain', 'notes.md', 'doc'],
    ['text/plain', 'main.rs', 'code'],
    ['application/octet-stream', 'deck.pptx', 'slides'],
    ['application/octet-stream', 'binary', 'file'],
    ['application/octet-stream', 'archive.unknown', 'file'],
  ])('%s %s → %s', (mime, name, kind) => {
    expect(fileKind(mime, name)).toBe(kind);
  });
});

describe('formatLongDate', () => {
  it('formats in the current locale', () => {
    expect(formatLongDate(at(2026, 3, 9))).toBe('March 9, 2026');
    setLanguage('cs');
    expect(formatLongDate(at(2026, 3, 9))).toBe('9. března 2026');
  });
});
