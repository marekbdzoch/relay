import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { RTCIceServerLike } from '../../shared/types.ts';

const env = process.env;

const dataDir = path.resolve(env.DATA_DIR ?? path.join(import.meta.dirname, '../../data'));
fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });

// A persistent secret is generated on first start unless provided.
function loadSecret(): string {
  if (env.SECRET_KEY) return env.SECRET_KEY;
  const file = path.join(dataDir, '.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

// Public base URL: explicit, or the domain Railway assigns to the service.
const publicUrl = (env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/$/, '');

/**
 * A fresh production instance is reachable by anyone until its owner account exists, so creating the workspace
 * requires a setup code: SETUP_TOKEN, or one generated on first start (printed to the logs, kept in the data dir).
 * Development servers (NODE_ENV != production) don't need one unless SETUP_TOKEN is set.
 */
function loadSetupToken(): string {
  if (env.SETUP_TOKEN !== undefined) return env.SETUP_TOKEN.trim();
  if (env.NODE_ENV !== 'production') return '';
  const file = path.join(dataDir, '.setup-token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const token = Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

function parseIce(): RTCIceServerLike[] {
  const servers: RTCIceServerLike[] = [];
  const stun = env.STUN_URLS ?? 'stun:stun.l.google.com:19302';
  if (stun) servers.push({ urls: stun.split(',').map((s) => s.trim()).filter(Boolean) });
  if (env.TURN_URLS) {
    servers.push({
      urls: env.TURN_URLS.split(',').map((s) => s.trim()),
      username: env.TURN_USERNAME,
      credential: env.TURN_PASSWORD,
    });
  }
  return servers;
}

export const config = {
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '0.0.0.0',
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  dbFile: path.join(dataDir, 'relay.db'),
  secret: loadSecret(),
  publicUrl,
  setupToken: loadSetupToken(),
  maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 100),
  // Comma separated list of extra origins allowed to call the API (desktop/mobile apps, dev servers)
  corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === 'true' : publicUrl.startsWith('https://'),
  webDist: path.resolve(env.WEB_DIST ?? path.join(import.meta.dirname, '../../web/dist')),
  iceServers: parseIce(),
  unfurlLinks: env.UNFURL_LINKS !== 'false',
  /** public "try it" instance: pre-filled sample workspace, one-click visitor accounts, periodic reset */
  demo: env.DEMO_MODE === 'true',
  demoResetHours: Math.max(1, Number(env.DEMO_RESET_HOURS ?? 24) || 24),
  version: '0.1.0',
};
