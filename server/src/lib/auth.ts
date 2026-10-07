import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { get, run } from '../db.ts';
import { config } from '../config.ts';
import { HttpError, now, randomToken, sha256 } from './util.ts';

export const SESSION_COOKIE = 'relay_session';
const SESSION_TTL_DAYS = 90;

export interface AuthUser {
  id: string;
  role: string;
  username: string;
  deactivated: number;
  is_bot: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
    sessionHash: string;
  }
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 11);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export function createSession(userId: string, userAgent = '') {
  const token = randomToken();
  const t = now();
  run('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?)', sha256(token), userId, t, t, userAgent.slice(0, 300));
  return token;
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    maxAge: SESSION_TTL_DAYS * 86400,
  });
}

/** Resolves a raw token (from cookie, bearer header or socket handshake) to a user. */
export function userFromToken(token: string | undefined | null): (AuthUser & { sessionHash: string }) | null {
  if (!token) return null;
  const hash = sha256(token);
  const row = get<AuthUser & { last_seen_at: number; created_at: number }>(
    `SELECT u.id, u.role, u.username, u.deactivated, u.is_bot, s.last_seen_at, s.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    hash,
  );
  if (!row || row.deactivated) return null;
  const t = now();
  if (t - row.last_seen_at > SESSION_TTL_DAYS * 86400_000) {
    run('DELETE FROM sessions WHERE token_hash = ?', hash);
    return null;
  }
  if (t - row.last_seen_at > 3600_000) run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', t, hash);
  return { id: row.id, role: row.role, username: row.username, deactivated: row.deactivated, is_bot: row.is_bot, sessionHash: hash };
}

export function tokenFromRequest(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return req.cookies?.[SESSION_COOKIE];
}

export async function requireAuth(req: FastifyRequest) {
  const u = userFromToken(tokenFromRequest(req));
  if (!u) throw new HttpError(401, 'not_authenticated');
  req.user = u;
  req.sessionHash = u.sessionHash;
}

export function isAdmin(u: { role: string }) {
  return u.role === 'owner' || u.role === 'admin';
}

export function requireAdmin(req: FastifyRequest) {
  if (!isAdmin(req.user)) throw new HttpError(403, 'admin_only');
}
