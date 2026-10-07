import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, DEL, GET, PATCH, POST, PUT, SERVER, api, assetUrl, getToken, setToken, setUnauthorizedHandler, upload } from './api.ts';
import { jsonResponse } from './test/helpers.ts';

let fetchMock: ReturnType<typeof vi.fn>;
function respond(res: Response | (() => Response)) {
  fetchMock = vi.fn(async () => (typeof res === 'function' ? res() : res));
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  respond(jsonResponse({ ok: true }));
  setUnauthorizedHandler(() => {});
});

describe('api()', () => {
  it('sends JSON with credentials and parses the response', async () => {
    respond(jsonResponse({ id: 1 }));
    await expect(api('POST', '/api/x', { a: 1 })).resolves.toEqual({ id: 1 });
    expect(SERVER).toBe('');
    expect(fetchMock).toHaveBeenCalledWith('/api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
      credentials: 'include',
    });
  });

  it('omits body and content-type without a payload', async () => {
    await api('GET', '/api/y');
    expect(fetchMock).toHaveBeenCalledWith('/api/y', { method: 'GET', headers: {}, body: undefined, credentials: 'include' });
  });

  it('returns null for empty responses', async () => {
    respond(new Response(null, { status: 204 }));
    await expect(api('DELETE', '/api/z')).resolves.toBeNull();
  });

  it('maps errors to ApiError with server code and message', async () => {
    respond(jsonResponse({ error: 'name_taken', message: 'Name is taken' }, 409));
    const err = await api('POST', '/api/channels', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ status: 409, code: 'name_taken', message: 'Name is taken' });
  });

  it('falls back to a generic code and the status text', async () => {
    respond(new Response('', { status: 500, statusText: 'Internal Server Error' }));
    await expect(api('GET', '/api/boom')).rejects.toMatchObject({ status: 500, code: 'error', message: 'Internal Server Error' });
  });

  it('rejects a successful but non-JSON response with an ApiError', async () => {
    respond(new Response('<html>', { status: 200 }));
    await expect(api('GET', '/api/html')).rejects.toMatchObject({ status: 200, code: 'bad_response' });
  });

  it('calls the unauthorized handler on 401, except for login', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    respond(() => jsonResponse({ error: 'not_authenticated' }, 401));
    await expect(GET('/api/bootstrap')).rejects.toMatchObject({ status: 401, code: 'not_authenticated' });
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(POST('/api/auth/login', { email: 'a' })).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('propagates network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(GET('/api/x')).rejects.toThrow('Failed to fetch');
  });
});

describe('verb helpers', () => {
  it.each([
    ['GET', () => GET('/p'), undefined],
    ['POST', () => POST('/p'), '{}'],
    ['POST', () => POST('/p', { a: 1 }), '{"a":1}'],
    ['PUT', () => PUT('/p'), '{}'],
    ['PUT', () => PUT('/p', [1]), '[1]'],
    ['PATCH', () => PATCH('/p'), '{}'],
    ['PATCH', () => PATCH('/p', { t: 'x' }), '{"t":"x"}'],
    ['DELETE', () => DEL('/p'), undefined],
  ] as const)('%s sends body %s', async (method, call, body) => {
    await call();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method, body });
  });
});

describe('same-origin token handling', () => {
  it('ignores tokens (cookie auth)', () => {
    setToken('abc');
    expect(getToken()).toBeNull();
    expect(localStorage.getItem('relay.token')).toBeNull();
  });
});

describe('assetUrl', () => {
  it('handles empty, absolute and relative paths', () => {
    expect(assetUrl(null)).toBe('');
    expect(assetUrl(undefined)).toBe('');
    expect(assetUrl('')).toBe('');
    expect(assetUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(assetUrl('http://x/a.png')).toBe('http://x/a.png');
    expect(assetUrl('data:image/png;base64,xx')).toBe('data:image/png;base64,xx');
    expect(assetUrl('blob:abc')).toBe('blob:abc');
    expect(assetUrl('/files/F1/a.png')).toBe('/files/F1/a.png');
  });
});

// ---------- upload (XMLHttpRequest) ----------

class FakeXHR {
  static last: FakeXHR;
  method = '';
  url = '';
  withCredentials = false;
  headers: Record<string, string> = {};
  status = 0;
  responseText = '';
  sent: unknown;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXHR.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.sent = body;
  }
  abort() {
    this.onabort?.();
  }
  finish(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

describe('upload()', () => {
  beforeEach(() => vi.stubGlobal('XMLHttpRequest', FakeXHR));

  it('posts files as multipart form data with progress', async () => {
    const onProgress = vi.fn();
    const files = [new File(['a'], 'a.txt'), new File(['bb'], 'b.txt')];
    const { promise } = upload('/api/files', files, onProgress);
    const xhr = FakeXHR.last;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/files');
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers).toEqual({});
    const form = xhr.sent as FormData;
    expect(form.getAll('file').map((f) => (f as File).name)).toEqual(['a.txt', 'b.txt']);

    xhr.upload.onprogress!({ lengthComputable: true, loaded: 5, total: 10 });
    xhr.upload.onprogress!({ lengthComputable: false, loaded: 7, total: 0 });
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(0.5);

    xhr.finish(201, JSON.stringify([{ id: 'F1' }]));
    await expect(promise).resolves.toEqual([{ id: 'F1' }]);
  });

  it('passes a FormData through and supports other methods', async () => {
    const fd = new FormData();
    fd.append('avatar', new File(['x'], 'me.png'));
    const { promise } = upload('/api/users/me/avatar', fd, undefined, 'PUT');
    expect(FakeXHR.last.method).toBe('PUT');
    expect(FakeXHR.last.sent).toBe(fd);
    FakeXHR.last.upload.onprogress!({ lengthComputable: true, loaded: 1, total: 1 }); // no callback → no throw
    FakeXHR.last.finish(200, 'not json');
    await expect(promise).resolves.toBeNull();
  });

  it('rejects with the server error', async () => {
    const { promise } = upload('/api/files', []);
    FakeXHR.last.finish(413, JSON.stringify({ error: 'file_too_large', message: 'Too big' }));
    await expect(promise).rejects.toMatchObject({ status: 413, code: 'file_too_large', message: 'Too big' });
  });

  it('rejects with a generic error for non-JSON failures', async () => {
    const { promise } = upload('/api/files', []);
    FakeXHR.last.finish(502, '<html>Bad gateway</html>');
    await expect(promise).rejects.toMatchObject({ status: 502, code: 'upload_failed', message: 'Upload failed' });
  });

  it('rejects on network errors', async () => {
    const { promise } = upload('/api/files', []);
    FakeXHR.last.onerror!();
    await expect(promise).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('can be aborted', async () => {
    const { promise, abort } = upload('/api/files', []);
    abort();
    await expect(promise).rejects.toMatchObject({ status: 0, code: 'aborted', message: 'Upload cancelled' });
  });
});

// ---------- remote server (desktop / mobile shells) ----------

describe('cross-origin server', () => {
  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  async function loadRemote(token: string | null = null) {
    localStorage.setItem('relay.server', 'https://chat.example.com/');
    if (token) localStorage.setItem('relay.token', token);
    vi.resetModules();
    return import('./api.ts');
  }

  it('prefixes requests with the server URL and sends a bearer token', async () => {
    const remote = await loadRemote('tok1');
    expect(remote.SERVER).toBe('https://chat.example.com');
    expect(remote.getToken()).toBe('tok1');
    await remote.GET('/api/me');
    expect(fetchMock).toHaveBeenCalledWith('https://chat.example.com/api/me', expect.objectContaining({ headers: { authorization: 'Bearer tok1' } }));
    expect(remote.assetUrl('/files/x.png')).toBe('https://chat.example.com/files/x.png');
  });

  it('stores and clears tokens', async () => {
    const remote = await loadRemote();
    expect(remote.getToken()).toBeNull();
    remote.setToken('new');
    expect(remote.getToken()).toBe('new');
    expect(localStorage.getItem('relay.token')).toBe('new');
    remote.setToken(null);
    expect(remote.getToken()).toBeNull();
    expect(localStorage.getItem('relay.token')).toBeNull();
  });

  it('sends the token with uploads', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const remote = await loadRemote('tok2');
    remote.upload('/api/files', []);
    expect(FakeXHR.last.url).toBe('https://chat.example.com/api/files');
    expect(FakeXHR.last.headers).toEqual({ authorization: 'Bearer tok2' });
  });

  it('treats a server equal to the page origin as same-origin', async () => {
    localStorage.setItem('relay.server', location.origin);
    localStorage.setItem('relay.token', 'ignored');
    vi.resetModules();
    const same = await import('./api.ts');
    expect(same.getToken()).toBeNull();
  });

  it('survives a throwing localStorage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.resetModules();
    const mod = await import('./api.ts');
    expect(mod.SERVER).toBe('');
  });
});
