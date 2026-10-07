import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { config } from './config.ts';
import './db.ts';
import { HttpError } from './lib/util.ts';
import { initRealtime } from './realtime.ts';
import compress from '@fastify/compress';
import { authRoutes } from './routes/auth.ts';
import { assetRoutes, userRoutes } from './routes/users.ts';
import { channelRoutes } from './routes/channels.ts';
import { hookRoutes, messageRoutes } from './routes/messages.ts';
import { miscRoutes } from './routes/misc.ts';
import { slackRoutes } from './routes/slack.ts';
import { agentRoutes } from './routes/agents.ts';
import { importRoutes } from './routes/import.ts';
import { onboardingRoutes } from './routes/onboarding.ts';
import { demoGuard, demoRoutes } from './demo.ts';


export interface BuildOptions {
  logger?: boolean;
  serveWeb?: boolean;
}

/** Creates the HTTP + websocket server (routes registered, not listening yet). */
export async function buildApp(opts: BuildOptions = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(compress, { global: true, threshold: 1024 });
  await app.register(cookie);
  if (config.corsOrigins.length) await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024 } });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code ?? 'bad_request', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  app.get('/api/health', async () => ({ ok: true, version: config.version }));

  if (config.demo) app.addHook('onRequest', demoGuard);
  await app.register(demoRoutes);
  await app.register(authRoutes);
  await app.register(assetRoutes);
  await app.register(hookRoutes);
  await app.register(userRoutes);
  await app.register(channelRoutes);
  await app.register(messageRoutes);
  await app.register(miscRoutes);
  await app.register(slackRoutes);
  await app.register(agentRoutes);
  await app.register(importRoutes);
  await app.register(onboardingRoutes);

  // Serve the built web client (single page app) when available.
  if (opts.serveWeb !== false && fs.existsSync(path.join(config.webDist, 'index.html'))) {
    const assetsDir = path.join(config.webDist, 'assets') + path.sep;
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
      maxAge: '1h',
      // files present at startup get their own routes (wildcard: false), so the not-found handler below never sees
      // them: content-hashed build assets need their long-lived cache header here
      setHeaders: (reply, filePath) => {
        if (filePath.startsWith(assetsDir)) reply.header('cache-control', 'public, max-age=31536000, immutable');
      },
    });
    // re-read index.html when it changes, so rebuilding the client under a running server doesn't serve a page that
    // points at deleted asset files
    const indexFile = path.join(config.webDist, 'index.html');
    let index = { mtime: 0, html: Buffer.alloc(0) };
    const indexHtml = () => {
      try {
        const mtime = fs.statSync(indexFile).mtimeMs;
        if (mtime !== index.mtime) index = { mtime, html: fs.readFileSync(indexFile) };
      } catch {
        /* keep serving the last good copy */
      }
      return index.html;
    };
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/socket.io')) return reply.code(404).send({ error: 'not_found' });
      if (req.url.startsWith('/assets/')) {
        const file = path.join(config.webDist, req.url.split('?')[0]);
        if (file.startsWith(config.webDist) && fs.existsSync(file)) {
          reply.header('cache-control', 'public, max-age=31536000, immutable');
          return reply.sendFile(req.url.split('?')[0].slice(1));
        }
        return reply.code(404).send('Not found');
      }
      return reply.type('text/html').header('cache-control', 'no-cache').send(indexHtml());
    });
  } else if (opts.serveWeb !== false) {
    app.log.warn(`Web client not found in ${config.webDist} – run "npm run build" (API only mode)`);
  }

  await app.ready();
  initRealtime(app.server);
  return app;
}
