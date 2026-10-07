import type { FileInfo } from '../../shared/types.ts';

/**
 * Server location. The web build talks to its own origin (cookie auth).
 * Desktop / mobile shells can set `localStorage['relay.server']` (or VITE_SERVER_URL)
 * to point at a remote server – a bearer token is then used instead of the cookie.
 */
function readServer() {
  try {
    return (localStorage.getItem('relay.server') ?? import.meta.env.VITE_SERVER_URL ?? '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

export const SERVER = readServer();
const crossOrigin = !!SERVER && SERVER !== location.origin;

let token: string | null = crossOrigin ? localStorage.getItem('relay.token') : null;

export function setToken(t: string | null) {
  if (!crossOrigin) return;
  token = t;
  if (t) localStorage.setItem('relay.token', t);
  else localStorage.removeItem('relay.token');
}
export const getToken = () => token;

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Listener = () => void;
let onUnauthorized: Listener = () => {};
export function setUnauthorizedHandler(fn: Listener) {
  onUnauthorized = fn;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(SERVER + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'include',
  });
  const text = await res.text();
  // error pages from a proxy (e.g. an HTML 502) are not JSON
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) throw new ApiError(res.status, 'bad_response', 'Unexpected response from the server');
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login')) onUnauthorized();
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText);
  }
  return data as T;
}

export const GET = <T = any>(p: string) => api<T>('GET', p);
export const POST = <T = any>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const PUT = <T = any>(p: string, b?: unknown) => api<T>('PUT', p, b ?? {});
export const PATCH = <T = any>(p: string, b?: unknown) => api<T>('PATCH', p, b ?? {});
export const DEL = <T = any>(p: string) => api<T>('DELETE', p);

/** Uploads files with progress reporting. */
export function upload<T = FileInfo[]>(path: string, files: File[] | FormData, onProgress?: (fraction: number) => void, method = 'POST'): { promise: Promise<T>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const form = files instanceof FormData ? files : new FormData();
  if (Array.isArray(files)) for (const f of files) form.append('file', f, f.name);
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open(method, SERVER + path);
    xhr.withCredentials = true;
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error ?? 'upload_failed', data?.message ?? 'Upload failed'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Network error'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled'));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

/** Absolute URL for server-hosted assets (files, avatars, emoji). */
export function assetUrl(path: string | null | undefined) {
  if (!path) return '';
  if (/^https?:|^data:|^blob:/.test(path)) return path;
  return SERVER + path;
}
