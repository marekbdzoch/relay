import { locale, t, tp } from '../i18n.ts';
import { S } from '../store.ts';

const use24 = () => S().me?.prefs.timeFormat24 ?? locale() === 'cs-CZ';

export function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit', hour12: !use24() });
}

export function startOfDay(ts: number) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatDay(ts: number) {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  if (day === today) return t('Today');
  if (day === today - 86400_000) return t('Yesterday');
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(locale(), { weekday: 'long', month: 'long', day: 'numeric', year: sameYear ? undefined : 'numeric' });
}

export function formatDateTime(ts: number) {
  return `${formatDay(ts)} ${t('at')} ${formatTime(ts)}`;
}

export function formatShortDate(ts: number) {
  const day = startOfDay(ts);
  const today = startOfDay(Date.now());
  if (day === today) return formatTime(ts);
  if (day === today - 86400_000) return t('Yesterday');
  const d = new Date(ts);
  if (Date.now() - ts < 6 * 86400_000) return d.toLocaleDateString(locale(), { weekday: 'long' });
  return d.toLocaleDateString(locale(), { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function timeAgo(ts: number) {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return t('just now');
  if (m < 60) return tp(m, '{n} minute ago', '{n} minutes ago');
  const h = Math.floor(m / 60);
  if (h < 24) return tp(h, '{n} hour ago', '{n} hours ago');
  const d = Math.floor(h / 24);
  if (d < 30) return tp(d, '{n} day ago', '{n} days ago');
  return formatShortDate(ts);
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function localTime(tz: string) {
  try {
    return new Date().toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit', hour12: !use24(), timeZone: tz || undefined });
  } catch {
    return '';
  }
}

export function fileKind(mime: string, name: string) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return 'archive';
  if (['xls', 'xlsx', 'csv', 'ods', 'numbers'].includes(ext)) return 'sheet';
  if (['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages'].includes(ext)) return 'doc';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'java', 'c', 'cpp', 'rs', 'php', 'html', 'css', 'json', 'yml', 'yaml', 'sh', 'sql'].includes(ext)) return 'code';
  if (['ppt', 'pptx', 'key', 'odp'].includes(ext)) return 'slides';
  return 'file';
}

export function formatLongDate(ts: number) {
  return new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });
}
