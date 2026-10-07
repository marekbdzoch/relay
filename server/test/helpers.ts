// Shared test helpers. Every test file runs in its own process (node:test), so module singletons
// (config, db, socket.io server) are fresh per file. DATA_DIR must be set before the server modules load.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

export interface Session {
  token: string;
  me: { id: string; username: string; role: string; email: string; [k: string]: any };
}

/** Creates a fresh data dir and points the server at it. Call before importing anything from src/. */
export function freshDataDir(env: Record<string, string | undefined> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.DATA_DIR = dir;
  process.env.UNFURL_LINKS ??= 'false';
  process.env.LOG_LEVEL ??= 'silent';
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return dir;
}

/** Builds the app on a fresh data directory. */
export async function createApp(env: Record<string, string | undefined> = {}) {
  const dataDir = freshDataDir(env);
  const { buildApp } = await import('../src/app.ts');
  const app = await buildApp({ logger: false, serveWeb: false });
  return { app, dataDir };
}

export async function closeApp(app: FastifyInstance) {
  const { io } = await import('../src/realtime.ts');
  await new Promise<void>((resolve) => io.close(() => resolve()));
  await app.close().catch(() => {});
}

// every request gets its own client address so per-IP rate limits (login/signup) never kick in
let ipCounter = 1;
const nextIp = () => {
  const n = ipCounter++;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, any>;
  raw: LightMyRequestResponse;
}

function wrap(res: LightMyRequestResponse): Res {
  let body: any = res.body;
  if (String(res.headers['content-type'] ?? '').includes('application/json')) {
    try {
      body = JSON.parse(res.body);
    } catch {
      /* keep text */
    }
  }
  return { status: res.statusCode, body, headers: res.headers, raw: res };
}

export interface UploadFile {
  field?: string;
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

/** Builds a multipart/form-data payload (fields first, then files). */
export function multipart(files: UploadFile[], fields: Record<string, string> = {}) {
  const boundary = `----relaytest${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field ?? 'file'}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType ?? 'application/octet-stream'}\r\n\r\n`,
      ),
    );
    chunks.push(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Small client around app.inject that authenticates with a bearer token. */
export function api(app: FastifyInstance, token?: string | null) {
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: method as any,
      url,
      payload: body === undefined ? undefined : (body as any),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      remoteAddress: nextIp(),
    });
    return wrap(res);
  };
  return {
    get: <T = any>(url: string, headers?: Record<string, string>) => call('GET', url, undefined, headers) as Promise<Res<T>>,
    post: <T = any>(url: string, body?: unknown, headers?: Record<string, string>) => call('POST', url, body ?? {}, headers) as Promise<Res<T>>,
    put: <T = any>(url: string, body?: unknown) => call('PUT', url, body ?? {}) as Promise<Res<T>>,
    patch: <T = any>(url: string, body?: unknown) => call('PATCH', url, body ?? {}) as Promise<Res<T>>,
    del: <T = any>(url: string) => call('DELETE', url) as Promise<Res<T>>,
    upload: <T = any>(url: string, files: UploadFile[], fields: Record<string, string> = {}, method = 'POST') => {
      const mp = multipart(files, fields);
      return call(method, url, mp.payload, mp.headers) as Promise<Res<T>>;
    },
  };
}
export type Api = ReturnType<typeof api>;

export const OWNER = { email: 'owner@example.com', password: 'owner-password', fullName: 'Olivia Owner', workspaceName: 'Acme' };

export async function setupOwner(app: FastifyInstance, extra: Record<string, unknown> = {}): Promise<Session> {
  const res = await api(app).post('/api/setup', { ...OWNER, ...extra });
  if (res.status !== 200) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

let userCounter = 0;
/** Invites a user (as `inviter`) and signs them up. */
export async function addUser(
  app: FastifyInstance,
  inviterToken: string,
  o: { name?: string; email?: string; role?: 'admin' | 'member' | 'guest'; password?: string } = {},
): Promise<Session> {
  const n = ++userCounter;
  const email = o.email ?? `user${n}@example.com`;
  const inv = await api(app, inviterToken).post('/api/invites', { email, role: o.role ?? 'member' });
  if (inv.status !== 200) throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.body)}`);
  const res = await api(app).post('/api/auth/signup', { inviteCode: inv.body.code, fullName: o.name ?? `User ${n}`, email, password: o.password ?? 'password123' });
  if (res.status !== 200) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Polls until fn returns a truthy value (or throws after timeout). */
export async function waitFor<T>(fn: () => T | Promise<T>, timeout = 5000, interval = 10): Promise<NonNullable<T>> {
  const start = Date.now();
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out${lastErr ? `: ${lastErr instanceof Error ? lastErr.message : lastErr}` : ''}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ---------- image fixtures ----------

/** A real (decodable) RGB PNG of the given size. */
export function png(width = 2, height = 3) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function gif(width: number, height: number) {
  const b = Buffer.alloc(32);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

/** JPEG with an APP0 segment followed by a SOF0 frame header. */
export function jpeg(width: number, height: number) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0x00]), app0, sof, Buffer.alloc(16)]);
}

export function webp(kind: 'VP8X' | 'VP8 ' | 'VP8L', width: number, height: number) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'ascii');
  b.write(kind, 12, 'ascii');
  if (kind === 'VP8X') {
    b.writeUIntLE(width - 1, 24, 3);
    b.writeUIntLE(height - 1, 27, 3);
  } else if (kind === 'VP8 ') {
    b.writeUInt16LE(width, 26);
    b.writeUInt16LE(height, 28);
  } else {
    b[20] = 0x2f;
    b.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  }
  return b;
}
