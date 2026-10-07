import dns from 'node:dns/promises';
import net from 'node:net';
import type { Unfurl } from '../../shared/types.ts';
import { config } from './config.ts';
import { getMessageRow, type MessageMeta } from './model.ts';
import { run } from './db.ts';
import { json } from './lib/util.ts';

const URL_RE = /<?(https?:\/\/[^\s<>|]+)/g;
const cache = new Map<string, { at: number; data: Unfurl | null }>();

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v.startsWith('::ffff:')) {
    // IPv4-mapped address, dotted (::ffff:127.0.0.1) or hex (::ffff:7f00:1 – how URL() normalises it)
    const rest = v.slice(7);
    const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return net.isIPv4(rest) ? isPrivateIp(rest) : true;
  }
  // ::/96 (loopback, unspecified, IPv4-compatible), ULA fc00::/7, link/site-local fe80::/9+, NAT64 64:ff9b::/96
  return v.startsWith('::') || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe') || v.startsWith('64:ff9b:');
}

export async function safeHost(hostname: string) {
  // IPv6 literals come bracketed from URL.hostname ("[::1]")
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return !isPrivateIp(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

function decode(s: string) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}

function meta(html: string, keys: string[]) {
  for (const key of keys) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return decode(content);
  }
  return undefined;
}

/** Extracts the preview (Open Graph / Twitter card / <title>) from a page; `base` is the final URL after redirects. */
export function parseUnfurl(html: string, url: string, base: string | URL = url): Unfurl | null {
  const target = new URL(base);
  const title = meta(html, ['og:title', 'twitter:title']) ?? decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '');
  if (!title) return null;
  let image = meta(html, ['og:image', 'og:image:url', 'twitter:image']);
  if (image) image = new URL(image, target).toString();
  return {
    url,
    title: title.slice(0, 200),
    description: meta(html, ['og:description', 'twitter:description', 'description'])?.slice(0, 400),
    siteName: meta(html, ['og:site_name']) ?? target.hostname.replace(/^www\./, ''),
    image: image?.startsWith('https://') ? image : undefined,
  };
}

export async function fetchUnfurl(url: string): Promise<Unfurl | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 3600_000) return hit.data;
  let data: Unfurl | null = null;
  try {
    let target = new URL(url);
    let res: Response | undefined;
    for (let hop = 0; hop < 4; hop++) {
      if (!/^https?:$/.test(target.protocol) || !(await safeHost(target.hostname))) return null;
      res = await fetch(target, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; RelayBot/1.0; +link-preview)', accept: 'text/html' },
      });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        target = new URL(loc, target);
        continue;
      }
      break;
    }
    if (!res || !res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) return null;
    // read at most 512 KB
    const reader = res.body!.getReader();
    let html = '';
    const decoder = new TextDecoder();
    while (html.length < 512_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.includes('</head>')) break;
    }
    reader.cancel().catch(() => {});
    data = parseUnfurl(html, url, target);
  } catch {
    data = null;
  }
  cache.set(url, { at: Date.now(), data });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return data;
}

export async function unfurlMessage(messageId: number, text: string) {
  if (!config.unfurlLinks) return;
  const urls = [...new Set([...text.replace(/```[\s\S]*?```|`[^`]*`/g, '').matchAll(URL_RE)].map((m) => m[1].replace(/[>.,)]+$/, '').split('|')[0]))].slice(0, 3);
  if (!urls.length) return;
  const results = (await Promise.all(urls.map(fetchUnfurl))).filter((x): x is Unfurl => !!x);
  if (!results.length) return;
  const row = getMessageRow(messageId);
  if (!row || row.deleted_at) return;
  const m = json<MessageMeta>(row.meta, {});
  m.unfurls = results;
  run('UPDATE messages SET meta = ? WHERE id = ?', JSON.stringify(m), messageId);
  const { emitMessageUpdated } = await import('./services.ts');
  emitMessageUpdated(messageId);
}
