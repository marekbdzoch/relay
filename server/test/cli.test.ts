import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { OWNER, addUser, api, closeApp, createApp, setupOwner, type Session } from './helpers.ts';

const exec = promisify(execFile);
const CLI = path.join(import.meta.dirname, '../src/cli.ts');

let app: FastifyInstance;
let dataDir: string;
let member: Session;

/** Runs the CLI against the test data dir; resolves with stdout/stderr and the exit code. */
async function cli(...args: string[]) {
  try {
    const r = await exec(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { env: { ...process.env, DATA_DIR: dataDir } });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e: any) {
    return { code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string };
  }
}

before(async () => {
  ({ app, dataDir } = await createApp());
  await setupOwner(app);
  const owner = (await api(app).post('/api/auth/login', { email: OWNER.email, password: OWNER.password })).body;
  member = await addUser(app, owner.token, { name: 'Mia Member', email: 'mia@example.com', password: 'password123' });
  const d = await addUser(app, owner.token, { name: 'Dee Activated', email: 'dee@example.com' });
  await api(app, owner.token).patch(`/api/users/${d.me.id}`, { deactivated: true });
});
after(() => closeApp(app));

describe('cli', () => {
  test('help', async () => {
    const r = await cli();
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Commands: backup/);
  });

  test('users', async () => {
    const r = await cli('users');
    assert.equal(r.code, 0);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^owner\s+Olivia Owner <owner@example.com>$/);
    assert.match(lines[1], /^member\s+Mia Member <mia@example.com>$/);
    assert.match(lines[2], /^member\s+\(deactivated\) Dee Activated <dee@example.com>$/);
  });

  test('backup writes a consistent copy of the database', async () => {
    const dir = path.join(dataDir, 'my backups');
    const r = await cli('backup', dir);
    assert.equal(r.code, 0);
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^relay-\d{4}-\d{2}-\d{2}T.*\.db$/);
    const copy = new DatabaseSync(path.join(dir, files[0]), { readOnly: true });
    assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 3);
    copy.close();
    // default location
    const r2 = await cli('backup');
    assert.equal(r2.code, 0);
    assert.equal(fs.readdirSync(path.join(dataDir, 'backups')).length, 1);
  });

  test('reset-password signs the user out everywhere', async () => {
    assert.equal((await cli('reset-password', 'mia@example.com')).code, 1);
    assert.equal((await cli('reset-password', 'mia@example.com', 'short')).code, 1);
    const missing = await cli('reset-password', 'ghost@example.com', 'long-enough-1');
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No user with email ghost@example.com/);
    const r = await cli('reset-password', 'MIA@example.com', 'brand-new-pass');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Password updated for Mia Member/);
    assert.equal((await api(app, member.token).get('/api/counts')).status, 401);
    assert.equal((await api(app).post('/api/auth/login', { email: 'mia@example.com', password: 'password123' })).status, 401);
    assert.equal((await api(app).post('/api/auth/login', { email: 'mia@example.com', password: 'brand-new-pass' })).status, 200);
    // also reactivates
    assert.equal((await cli('reset-password', 'dee@example.com', 'welcome-back')).code, 0);
    assert.equal((await api(app).post('/api/auth/login', { email: 'dee@example.com', password: 'welcome-back' })).status, 200);
  });

  test('make-owner', async () => {
    assert.equal((await cli('make-owner')).code, 1);
    const r = await cli('make-owner', 'mia@example.com');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Mia Member is now an owner/);
    const login = await api(app).post('/api/auth/login', { email: 'mia@example.com', password: 'brand-new-pass' });
    assert.equal(login.body.me.role, 'owner');
  });
});
