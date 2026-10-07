import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { OWNER, api, closeApp, createApp } from './helpers.ts';

// a production server without SETUP_TOKEN generates its own setup code and keeps it across restarts
let app: FastifyInstance;
let dataDir: string;

before(async () => {
  ({ app, dataDir } = await createApp({ NODE_ENV: 'production', SETUP_TOKEN: undefined, RAILWAY_PUBLIC_DOMAIN: 'relay-demo.up.railway.app', PUBLIC_URL: undefined }));
});
after(() => closeApp(app));

test('generates a setup code, stores it in the data dir and requires it', async () => {
  const { config } = await import('../src/config.ts');
  const file = path.join(dataDir, '.setup-token');
  assert.ok(fs.existsSync(file));
  const code = fs.readFileSync(file, 'utf8').trim();
  assert.match(code, /^[a-z2-9]{12}$/);
  assert.equal(config.setupToken, code);
  assert.equal((await api(app).get('/api/setup/status')).body.setupCodeRequired, true);
  assert.equal((await api(app).post('/api/setup', OWNER)).status, 403);
  assert.equal((await api(app).post('/api/setup', { ...OWNER, setupCode: code })).status, 200);
});

test('uses the Railway domain as the public URL and secure cookies', async () => {
  const { config } = await import('../src/config.ts');
  assert.equal(config.publicUrl, 'https://relay-demo.up.railway.app');
  assert.equal(config.secureCookies, true);
});
