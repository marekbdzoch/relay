import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { freshDataDir, gif, jpeg, png, webp } from './helpers.ts';

let dataDir: string;
let util: typeof import('../src/lib/util.ts');
let files: typeof import('../src/lib/files.ts');
let db: typeof import('../src/db.ts');
let model: typeof import('../src/model.ts');
let auth: typeof import('../src/lib/auth.ts');
let config: typeof import('../src/config.ts').config;

before(async () => {
  dataDir = freshDataDir({ TURN_URLS: 'turn:a.example.com, turn:b.example.com', TURN_USERNAME: 'u', TURN_PASSWORD: 'p', STUN_URLS: 'stun:x.example.com', SECRET_KEY: 'fixed-secret', SECURE_COOKIES: 'true' });
  util = await import('../src/lib/util.ts');
  files = await import('../src/lib/files.ts');
  db = await import('../src/db.ts');
  model = await import('../src/model.ts');
  auth = await import('../src/lib/auth.ts');
  ({ config } = await import('../src/config.ts'));
});
after(() => {
  db.db.close();
});

describe('config', () => {
  test('environment is honoured', () => {
    assert.equal(config.dataDir, dataDir);
    assert.equal(config.secret, 'fixed-secret');
    assert.equal(config.secureCookies, true);
    assert.deepEqual(config.iceServers, [{ urls: ['stun:x.example.com'] }, { urls: ['turn:a.example.com', 'turn:b.example.com'], username: 'u', credential: 'p' }]);
    assert.ok(fs.existsSync(path.join(dataDir, 'uploads')));
    assert.ok(fs.existsSync(config.dbFile));
  });
});

describe('util', () => {
  test('newId / randomToken / sha256', () => {
    const id = util.newId('U');
    assert.match(id, /^U[0-9A-HJ-NP-Z]{10}$/);
    assert.match(util.newId('F', 12), /^F[0-9A-Z]{12}$/);
    assert.notEqual(util.newId('U'), util.newId('U'));
    assert.match(util.randomToken(), /^[\w-]{43}$/);
    assert.equal(util.randomToken(3).length, 4);
    assert.equal(util.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('normalizeChannelName', () => {
    assert.equal(util.normalizeChannelName('  Hello World  '), 'hello-world');
    assert.equal(util.normalizeChannelName('a__b   c'), 'a-b-c');
    assert.equal(util.normalizeChannelName('Ünïcödé #1!'), 'ünïcödé-1');
    assert.equal(util.normalizeChannelName('a---b'), 'a-b');
    assert.equal(util.normalizeChannelName('x'.repeat(100)).length, 80);
    assert.equal(util.normalizeChannelName('!!!'), '');
  });

  test('normalizeUsername', () => {
    assert.equal(util.normalizeUsername('Jiří Novák'), 'jiri.novak');
    assert.equal(util.normalizeUsername('..John_Doe--'), 'john_doe');
    assert.equal(util.normalizeUsername('a@b!c'), 'a.b.c');
    assert.equal(util.normalizeUsername('x'.repeat(50)).length, 40);
    assert.equal(util.normalizeUsername('???'), '');
  });

  test('parse reports the first issue', () => {
    const schema = z.object({ name: z.string(), n: z.number() });
    assert.deepEqual(util.parse(schema, { name: 'a', n: 1 }), { name: 'a', n: 1 });
    assert.throws(
      () => util.parse(schema, { name: 'a', n: 'x' }),
      (e: any) => e instanceof util.HttpError && e.status === 400 && e.code === 'invalid_input' && /^n: /.test(e.message),
    );
    assert.throws(() => util.parse(z.string(), 5), (e: any) => /^input: /.test(e.message));
  });

  test('errors, json, bool, colors', () => {
    const e = util.forbidden();
    assert.equal(e.status, 403);
    assert.equal(e.code, 'forbidden');
    assert.equal(util.notFound().status, 404);
    assert.equal(util.badRequest('x', 'msg').message, 'msg');
    assert.equal(new util.HttpError(418, 'teapot').message, 'teapot');
    assert.deepEqual(util.json('{"a":1}', {}), { a: 1 });
    assert.deepEqual(util.json('{broken', { d: 1 }), { d: 1 });
    assert.deepEqual(util.json(null, []), []);
    assert.equal(util.bool(1), true);
    assert.equal(util.bool('1'), true);
    assert.equal(util.bool(true), true);
    assert.equal(util.bool(0), false);
    assert.equal(util.bool('true'), false);
    assert.match(util.randomAvatarColor(), /^#[0-9a-f]{6}$/);
    assert.ok(Math.abs(util.now() - Date.now()) < 1000);
  });
});

describe('files', () => {
  const write = (name: string, buf: Buffer) => {
    const p = path.join(dataDir, name);
    fs.writeFileSync(p, buf);
    return p;
  };

  test('imageSize for PNG, GIF, JPEG and WebP', () => {
    assert.deepEqual(files.imageSize(write('a.png', png(17, 33))), { width: 17, height: 33 });
    assert.deepEqual(files.imageSize(write('a.gif', gif(320, 200))), { width: 320, height: 200 });
    assert.deepEqual(files.imageSize(write('a.jpg', jpeg(640, 480))), { width: 640, height: 480 });
    assert.deepEqual(files.imageSize(write('x.webp', webp('VP8X', 1920, 1080))), { width: 1920, height: 1080 });
    assert.deepEqual(files.imageSize(write('y.webp', webp('VP8 ', 300, 150))), { width: 300, height: 150 });
    assert.deepEqual(files.imageSize(write('z.webp', webp('VP8L', 64, 48))), { width: 64, height: 48 });
  });

  test('imageSize returns null for unknown or broken data', () => {
    assert.equal(files.imageSize(write('t.txt', Buffer.from('just some text, not an image at all'))), null);
    assert.equal(files.imageSize(write('e.bin', Buffer.alloc(0))), null);
    // JPEG without a frame header
    assert.equal(files.imageSize(write('b.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0]), Buffer.alloc(20)]))), null);
    // WebP with an unknown chunk
    const w = webp('VP8X', 1, 1);
    w.write('ABCD', 12, 'ascii');
    assert.equal(files.imageSize(write('u.webp', w)), null);
    assert.equal(files.imageSize(path.join(dataDir, 'missing.png')), null);
  });

  test('isSafeInline', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/jpg', 'video/mp4', 'audio/mpeg', 'application/pdf', 'text/plain']) assert.equal(files.isSafeInline(m), true, m);
    for (const m of ['image/svg+xml', 'text/html', 'application/javascript', 'text/plain; charset=x', 'application/octet-stream']) assert.equal(files.isSafeInline(m), false, m);
  });

  test('absPath refuses traversal; removeUpload ignores problems', () => {
    assert.equal(files.absPath('2024-01/x.png'), path.join(config.uploadsDir, '2024-01/x.png'));
    assert.throws(() => files.absPath('../relay.db'), (e: any) => e.code === 'bad_path');
    const p = path.join(config.uploadsDir, 'del.txt');
    fs.writeFileSync(p, 'x');
    files.removeUpload('del.txt');
    assert.equal(fs.existsSync(p), false);
    files.removeUpload(null);
    files.removeUpload('../../outside');
    files.removeUpload('never-existed.txt');
    assert.ok(fs.existsSync(config.dbFile));
  });
});

describe('db', () => {
  test('migrations ran to the latest version', () => {
    assert.equal(db.get<{ version: number }>('SELECT version FROM schema_version')!.version, 5);
  });

  test('tx commits, rolls back and nests', () => {
    db.run("INSERT INTO settings (key, value) VALUES ('a', '1')");
    assert.throws(() =>
      db.tx(() => {
        db.run("UPDATE settings SET value = '2' WHERE key = 'a'");
        db.tx(() => db.run("INSERT INTO settings (key, value) VALUES ('b', '1')"));
        throw new Error('boom');
      }),
    );
    assert.equal(db.getSetting('a'), '1');
    assert.equal(db.getSetting('b'), null);
    assert.equal(
      db.tx(() => {
        db.run("UPDATE settings SET value = '3' WHERE key = 'a'");
        return 'ok';
      }),
      'ok',
    );
    assert.equal(db.getSetting('a'), '3');
  });

  test('settings helpers and placeholders', () => {
    db.setSetting('k', 'v');
    db.setSetting('k', 'w');
    assert.equal(db.getSetting('k'), 'w');
    db.setSetting('k', null);
    assert.equal(db.getSetting('k'), null);
    assert.equal(db.placeholders(3), '?, ?, ?');
    assert.equal(db.placeholders(0), '');
  });
});

describe('model', () => {
  test('serializeUser hides expired status and dnd; avatar urls', () => {
    const base: any = {
      id: 'U1',
      email: 'a@b.c',
      password_hash: '',
      username: 'a',
      full_name: 'A',
      display_name: '',
      title: '',
      phone: '',
      timezone: '',
      avatar_path: 'avatars/abc123.png',
      avatar_color: '#000000',
      role: 'member',
      status_emoji: 'x',
      status_text: 'busy',
      status_expires_at: Date.now() - 1,
      dnd_until: Date.now() - 1,
      away_manual: 0,
      prefs: '{}',
      deactivated: 0,
      is_bot: 0,
      external: null,
      created_at: 1,
    };
    const u = model.serializeUser(base);
    assert.equal(u.statusText, '');
    assert.equal(u.statusEmoji, '');
    assert.equal(u.statusExpiresAt, null);
    assert.equal(u.dndUntil, null);
    assert.equal(u.avatarUrl, '/api/avatars/U1?v=abc123');
    assert.equal(u.email, undefined);
    assert.equal(model.serializeUser(base, true).email, 'a@b.c');
    assert.equal(model.avatarUrl({ id: 'U1', avatar_path: null }), null);
    const active = model.serializeUser({ ...base, status_expires_at: null, dnd_until: Date.now() + 60_000 });
    assert.equal(active.statusText, 'busy');
    assert.ok(active.dndUntil);
  });

  test('workspace defaults and lookups of missing rows', () => {
    const w = model.getWorkspace();
    assert.equal(w.name, 'Relay');
    assert.equal(w.iconUrl, null);
    assert.equal(model.getUser('NOPE'), null);
    assert.equal(model.getChannel('NOPE'), null);
    assert.equal(model.getMessage(123456), null);
    assert.equal(model.getMembership('U', 'C'), null);
    assert.deepEqual(model.hydrateMessages([]), []);
    assert.throws(() => model.getMe('NOPE'), (e: any) => e.code === 'user_not_found');
    assert.throws(() => model.assertMember('U', 'NOPE'), (e: any) => e.code === 'channel_not_found');
  });
});

describe('auth helpers', () => {
  test('password hashing and token lookup', async () => {
    const h = await auth.hashPassword('secret-pass');
    assert.equal(await auth.verifyPassword('secret-pass', h), true);
    assert.equal(await auth.verifyPassword('wrong', h), false);
    assert.equal(auth.userFromToken(null), null);
    assert.equal(auth.userFromToken(''), null);
    assert.equal(auth.userFromToken('unknown'), null);
    assert.equal(auth.isAdmin({ role: 'owner' }), true);
    assert.equal(auth.isAdmin({ role: 'admin' }), true);
    assert.equal(auth.isAdmin({ role: 'member' }), false);
    assert.throws(() => auth.requireAdmin({ user: { role: 'guest' } } as any), (e: any) => e.code === 'admin_only');
  });
});
