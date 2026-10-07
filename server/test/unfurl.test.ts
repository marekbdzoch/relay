import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { addUser, api, closeApp, createApp, setupOwner, waitFor, type Session } from './helpers.ts';

let app: FastifyInstance;
let owner: Session;
let alice: Session;
let unfurl: typeof import('../src/unfurl.ts');
let config: typeof import('../src/config.ts').config;
let local: http.Server;
let localUrl: string;
let localHits = 0;

// a public IP literal: safeHost() accepts it without DNS, and fetch is mocked for it
const PUBLIC = 'http://93.184.216.34';
const realFetch = globalThis.fetch;
const fetched: string[] = [];
const pages: Record<string, () => Response> = {
  '/article': () =>
    new Response(
      `<html><head><meta property="og:title" content="Big &amp; News &#39;24&#8482;"><meta name='og:description' content='All the &quot;details&quot;'>
       <meta property="og:site_name" content="Example Times"><meta property="og:image" content="/img/cover.png"></head><body>ignored</body></html>`,
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    ),
  '/redirect': () => new Response(null, { status: 301, headers: { location: '/article' } }),
  '/to-private': () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/admin' } }),
  '/loop': () => new Response(null, { status: 302, headers: { location: '/loop' } }),
  '/json': () => Response.json({ title: 'nope' }),
  '/missing': () => new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } }),
  '/notitle': () => new Response('<html><head></head></html>', { headers: { 'content-type': 'text/html' } }),
  '/title': () => new Response('<html><head><title> Plain title </title><meta name="description" content="desc"></head>', { headers: { 'content-type': 'text/html' } }),
  '/throws': () => {
    throw new Error('network down');
  },
};

before(async () => {
  local = http.createServer((_req, res) => {
    localHits++;
    res.writeHead(200, { 'content-type': 'text/html' }).end('<title>internal</title>');
  });
  await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
  localUrl = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = new URL(String(input));
    if (u.origin === PUBLIC) {
      fetched.push(u.pathname);
      return (pages[u.pathname] ?? (() => new Response('', { status: 404 })))();
    }
    return realFetch(input, init);
  }) as typeof fetch;
  ({ app } = await createApp({ UNFURL_LINKS: 'true' }));
  unfurl = await import('../src/unfurl.ts');
  ({ config } = await import('../src/config.ts'));
  owner = await setupOwner(app);
  alice = await addUser(app, owner.token);
});
after(async () => {
  globalThis.fetch = realFetch;
  await closeApp(app);
  await new Promise((r) => local.close(r));
});

describe('SSRF guards', () => {
  test('isPrivateIp', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '0.0.0.0', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', '[::1]', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::7f00:1', '64:ff9b::7f00:1', '::ffff:zz']) {
      assert.equal(unfurl.isPrivateIp(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '93.184.216.34', '2606:4700::1111', '::ffff:8.8.8.8', '::ffff:808:808']) {
      assert.equal(unfurl.isPrivateIp(ip), false, ip);
    }
  });

  test('safeHost resolves names and rejects private targets', async () => {
    assert.equal(await unfurl.safeHost('127.0.0.1'), false);
    assert.equal(await unfurl.safeHost('[::1]'), false);
    assert.equal(await unfurl.safeHost('[::ffff:7f00:1]'), false);
    assert.equal(await unfurl.safeHost('localhost'), false);
    assert.equal(await unfurl.safeHost('does-not-exist.invalid'), false);
    assert.equal(await unfurl.safeHost('93.184.216.34'), true);
  });

  test('never fetches private addresses', async () => {
    assert.equal(await unfurl.fetchUnfurl(`${localUrl}/`), null);
    assert.equal(await unfurl.fetchUnfurl(`http://localhost:${new URL(localUrl).port}/`), null);
    assert.equal(await unfurl.fetchUnfurl(`http://[::ffff:127.0.0.1]:${new URL(localUrl).port}/`), null);
    assert.equal(await unfurl.fetchUnfurl(`${PUBLIC}/to-private`), null);
    assert.equal(localHits, 0);
    assert.equal(await unfurl.fetchUnfurl('ftp://93.184.216.34/file'), null);
    assert.equal(await unfurl.fetchUnfurl('not a url'), null);
  });
});

describe('parsing', () => {
  test('Open Graph tags, entities and absolute images', () => {
    const r = unfurl.parseUnfurl(
      '<meta property="og:title" content="A &lt;b&gt; title"><meta name="twitter:description" content="tw"><meta property="og:image" content="https://cdn.example.com/i.png">',
      'https://www.example.com/x',
    );
    assert.deepEqual(r, { url: 'https://www.example.com/x', title: 'A <b> title', description: 'tw', siteName: 'example.com', image: 'https://cdn.example.com/i.png' });
  });

  test('falls back to <title>, keeps only https images, truncates', () => {
    const r = unfurl.parseUnfurl(`<title>${'t'.repeat(300)}</title><meta name="description" content="${'d'.repeat(500)}"><meta name="twitter:image" content="img.png">`, 'http://site.org/p', 'http://site.org/final/');
    assert.equal(r?.title?.length, 200);
    assert.equal(r!.description!.length, 400);
    assert.equal(r!.image, undefined); // http image is dropped
    assert.equal(r!.siteName, 'site.org');
    assert.equal(unfurl.parseUnfurl('<html></html>', 'https://x.y'), null);
    assert.equal(unfurl.parseUnfurl('<meta property="og:title" content="">', 'https://x.y'), null);
  });
});

describe('fetching', () => {
  test('follows redirects, parses and caches', async () => {
    const r = await unfurl.fetchUnfurl(`${PUBLIC}/redirect`);
    assert.deepEqual(r, {
      url: `${PUBLIC}/redirect`,
      title: 'Big & News \'24™',
      description: 'All the "details"',
      siteName: 'Example Times',
      image: undefined, // resolved against http:// -> not https
    });
    assert.deepEqual(fetched.slice(-2), ['/redirect', '/article']);
    const n = fetched.length;
    assert.deepEqual(await unfurl.fetchUnfurl(`${PUBLIC}/redirect`), r);
    assert.equal(fetched.length, n); // cached
  });

  test('rejects non-HTML, errors, redirect loops and pages without title', async () => {
    assert.equal(await unfurl.fetchUnfurl(`${PUBLIC}/json`), null);
    assert.equal(await unfurl.fetchUnfurl(`${PUBLIC}/missing`), null);
    assert.equal(await unfurl.fetchUnfurl(`${PUBLIC}/loop`), null);
    assert.equal(await unfurl.fetchUnfurl(`${PUBLIC}/notitle`), null);
    assert.equal(await unfurl.fetchUnfurl(`${PUBLIC}/throws`), null);
    assert.equal((await unfurl.fetchUnfurl(`${PUBLIC}/title`))!.title, 'Plain title');
  });
});

describe('message unfurls', () => {
  test('posting and editing a message adds link previews', async () => {
    const general = (await api(app, alice.token).get('/api/bootstrap')).body.channels.find((c: any) => c.name === 'general');
    const m = (await api(app, alice.token).post(`/api/channels/${general.id}/messages`, { text: `read <${PUBLIC}/article|this>, \`${PUBLIC}/title\` and ${PUBLIC}/missing.` })).body;
    const withUnfurl = await waitFor(async () => {
      const msg = (await api(app, alice.token).get(`/api/messages/${m.id}`)).body;
      return msg.unfurls.length ? msg : null;
    });
    assert.deepEqual(withUnfurl.unfurls.map((u: any) => u.title), ['Big & News \'24™']);
    // links listing uses the unfurl title
    const links = (await api(app, alice.token).get(`/api/channels/${general.id}/links`)).body;
    assert.equal(links.find((l: any) => l.url === `${PUBLIC}/article`).title, 'Big & News \'24™');

    await api(app, alice.token).patch(`/api/messages/${m.id}`, { text: `now ${PUBLIC}/title` });
    const edited = await waitFor(async () => {
      const msg = (await api(app, alice.token).get(`/api/messages/${m.id}`)).body;
      return msg.unfurls[0]?.title === 'Plain title' ? msg : null;
    });
    assert.equal(edited.unfurls.length, 1);
  });

  test('no unfurls when disabled, for deleted messages or without results', async () => {
    const { postMessage } = await import('../src/services.ts');
    const general = (await api(app, alice.token).get('/api/bootstrap')).body.channels.find((c: any) => c.name === 'general');
    const m = postMessage({ channelId: general.id, userId: alice.me.id, text: 'no links' });
    await unfurl.unfurlMessage(m.id, `${PUBLIC}/missing`);
    await unfurl.unfurlMessage(m.id, 'plain');
    await api(app, alice.token).del(`/api/messages/${m.id}`);
    await unfurl.unfurlMessage(m.id, `${PUBLIC}/article`);
    config.unfurlLinks = false;
    try {
      const m2 = postMessage({ channelId: general.id, userId: alice.me.id, text: 'x' });
      await unfurl.unfurlMessage(m2.id, `${PUBLIC}/article`);
      assert.deepEqual((await api(app, alice.token).get(`/api/messages/${m2.id}`)).body.unfurls, []);
    } finally {
      config.unfurlLinks = true;
    }
    assert.deepEqual((await api(app, alice.token).get(`/api/messages/${m.id}`)).body.unfurls, []);
  });
});
