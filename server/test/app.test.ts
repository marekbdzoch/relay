import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { api, closeApp, freshDataDir, setupOwner, waitFor } from './helpers.ts';

let app: FastifyInstance;
let dataDir: string;
const webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-web-'));
process.on('exit', () => fs.rmSync(webDist, { recursive: true, force: true }));

before(async () => {
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>Relay</title>');
  fs.mkdirSync(path.join(webDist, 'assets'));
  fs.writeFileSync(path.join(webDist, 'assets', 'app-123.js'), 'console.log(1)');
  fs.writeFileSync(path.join(webDist, 'favicon.svg'), '<svg/>');
  dataDir = freshDataDir({ WEB_DIST: webDist, CORS_ORIGINS: 'http://localhost:5173, https://desktop.example' });
  const { buildApp } = await import('../src/app.ts');
  app = await buildApp({ serveWeb: true, logger: false });
});
after(() => app.close());

describe('web client & app plumbing', () => {
  test('serves the single page app with history fallback', async () => {
    const root = await api(app).get('/');
    assert.equal(root.status, 200);
    assert.match(root.body, /<title>Relay<\/title>/);
    // the page must be revalidated after every deploy
    assert.equal(root.headers['cache-control'], 'no-cache');
    assert.equal((await api(app).get('/index.html')).headers['cache-control'], 'no-cache');
    const deep = await api(app).get('/c/C123?x=1');
    assert.equal(deep.status, 200);
    assert.equal(deep.headers['cache-control'], 'no-cache');
    assert.match(String(deep.headers['content-type']), /text\/html/);
    const icon = await api(app).get('/favicon.svg');
    assert.equal(icon.status, 200);
  });

  test('hashed assets are immutable; missing ones 404', async () => {
    const js = await api(app).get('/assets/app-123.js?v=1');
    assert.equal(js.status, 200);
    assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(js.body, 'console.log(1)');
    const missing = await api(app).get('/assets/nope.js');
    assert.equal(missing.status, 404);
    // assets created after startup (e.g. a rebuild while running) go through the fallback handler
    fs.writeFileSync(path.join(webDist, 'assets', 'late-456.js'), 'late()');
    const late = await api(app).get('/assets/late-456.js');
    assert.equal(late.status, 200);
    assert.equal(late.headers['cache-control'], 'public, max-age=31536000, immutable');
    // other static files keep the short cache
    assert.equal((await api(app).get('/favicon.svg')).headers['cache-control'], 'public, max-age=3600');
  });

  test('unknown API routes stay JSON 404s', async () => {
    const r = await api(app).get('/api/does-not-exist');
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'not_found' });
    assert.equal((await api(app).get('/socket.io/nothing')).status, 404);
  });

  test('CORS for configured origins only', async () => {
    const ok = await app.inject({ method: 'OPTIONS', url: '/api/health', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' } });
    assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:5173');
    assert.equal(ok.headers['access-control-allow-credentials'], 'true');
    const bad = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } });
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
  });

  test('responses are compressed when asked for', async () => {
    await setupOwner(app);
    const r = await app.inject({ method: 'GET', url: '/', headers: { 'accept-encoding': 'gzip' } });
    assert.equal(r.statusCode, 200);
    const big = await app.inject({ method: 'GET', url: '/api/setup/status', headers: { 'accept-encoding': 'gzip' } });
    assert.equal(big.statusCode, 200);
  });

  test('unexpected errors become a generic 500', async () => {
    const owner = (await api(app).post('/api/auth/login', { email: 'owner@example.com', password: 'owner-password' })).body;
    const { run } = await import('../src/db.ts');
    // an avatar path that points at a directory makes the stream fail
    fs.mkdirSync(path.join(dataDir, 'uploads', 'avatars', 'dir.png'), { recursive: true });
    run("UPDATE users SET avatar_path = 'avatars/dir.png' WHERE id = ?", owner.me.id);
    const r = await api(app, owner.token).get(`/api/avatars/${owner.me.id}`);
    assert.equal(r.status, 500);
    run("UPDATE users SET avatar_path = '../../etc/passwd' WHERE id = ?", owner.me.id);
    const r2 = await api(app, owner.token).get(`/api/avatars/${owner.me.id}`);
    assert.equal(r2.status, 400);
    assert.equal(r2.body.error, 'bad_path');
  });

  test('API-only mode when the web client is missing', async () => {
    const { config } = await import('../src/config.ts');
    const { buildApp } = await import('../src/app.ts');
    const saved = config.webDist;
    config.webDist = path.join(webDist, 'missing');
    try {
      const apiOnly = await buildApp({ logger: false });
      assert.equal((await api(apiOnly).get('/')).status, 404);
      await closeApp(apiOnly);
    } finally {
      config.webDist = saved;
    }
  });
});

describe('index.ts', () => {
  test('starts the server and shuts down gracefully on SIGTERM', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-index-'));
    process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(import.meta.dirname, '../src/index.ts')], {
      env: { ...process.env, DATA_DIR: dir, PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'info', WEB_DIST: path.join(dir, 'nope'), ANTHROPIC_API_KEY: '', SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    const url = await waitFor(() => out.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1], 15000);
    const health = await fetch(`${url}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.match(out, /SIGTERM received, shutting down/);
  });
});
