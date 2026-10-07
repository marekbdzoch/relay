import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Short, prefixed, url-safe random id (e.g. U8K2M4Q9ZT1). */
export function newId(prefix: string, len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = prefix;
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (code: string, msg?: string) => new HttpError(400, code, msg);
export const forbidden = (code = 'forbidden', msg?: string) => new HttpError(403, code, msg);
export const notFound = (code = 'not_found', msg?: string) => new HttpError(404, code, msg);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw badRequest('invalid_input', `${issue.path.join('.') || 'input'}: ${issue.message}`);
  }
  return r.data;
}

export const now = () => Date.now();

export function bool(v: unknown) {
  return v === 1 || v === true || v === '1';
}

export function json<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export type Handler = (req: FastifyRequest, reply: FastifyReply) => unknown;

const AVATAR_COLORS = ['#e8912d', '#2bac76', '#1d9bd1', '#e01e5a', '#4a154b', '#9c27b0', '#3f51b5', '#00897b', '#d81b60', '#5d4037', '#546e7a', '#ef6c00'];
export function randomAvatarColor() {
  return AVATAR_COLORS[crypto.randomInt(AVATAR_COLORS.length)];
}

/** Normalises a channel name the way Slack does: lowercase, no spaces, limited charset. */
export function normalizeChannelName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}\-]/gu, '')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

export function normalizeUsername(name: string) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 40);
}
