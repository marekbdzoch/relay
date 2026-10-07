import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { get, setSetting } from '../db.ts';
import { requireAdmin, requireAuth } from '../lib/auth.ts';
import { absPath } from '../lib/files.ts';
import { badRequest, notFound, parse } from '../lib/util.ts';
import { emitChannel, postMessage } from '../services.ts';
import {
  SLACK_MANIFEST,
  linkChannel,
  listLinks,
  listSlackChannels,
  slackStatus,
  slackTokens,
  startSlackBridge,
  stopSlackBridge,
  unlinkChannel,
  verifyAvatarSignature,
} from '../slack/bridge.ts';

export async function slackRoutes(app: FastifyInstance) {
  // signed, public avatar URLs so Slack can show the author's picture
  app.get('/api/public/avatars/:id/:sig', async (req, reply) => {
    const { id, sig } = req.params as { id: string; sig: string };
    const u = verifyAvatarSignature(id, sig);
    if (!u?.avatar_path) throw notFound();
    const abs = absPath(u.avatar_path);
    if (!fs.existsSync(abs)) throw notFound();
    const ext = u.avatar_path.split('.').pop()?.toLowerCase();
    reply.type(ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
    reply.header('cache-control', 'public, max-age=86400');
    return reply.send(fs.createReadStream(abs));
  });

  app.register(async (admin) => {
    admin.addHook('preHandler', requireAuth);
    admin.addHook('preHandler', async (req) => requireAdmin(req));

    admin.get('/api/slack', async () => {
      const t = slackTokens();
      return {
        ...slackStatus(),
        botTokenSet: !!t.bot,
        appTokenSet: !!t.app,
        fromEnv: t.fromEnv,
        links: listLinks(),
        manifest: SLACK_MANIFEST,
      };
    });

    admin.put('/api/slack/tokens', async (req) => {
      const body = parse(z.object({ botToken: z.string().trim().startsWith('xoxb-'), appToken: z.string().trim().startsWith('xapp-') }), req.body);
      setSetting('slack.botToken', body.botToken);
      setSetting('slack.appToken', body.appToken);
      await startSlackBridge();
      // give the socket a moment to say hello
      await new Promise((r) => setTimeout(r, 1500));
      return slackStatus();
    });

    admin.delete('/api/slack/tokens', async () => {
      setSetting('slack.botToken', null);
      setSetting('slack.appToken', null);
      stopSlackBridge();
      return slackStatus();
    });

    admin.get('/api/slack/channels', async () => {
      try {
        return await listSlackChannels();
      } catch (e) {
        throw badRequest('slack_error', e instanceof Error ? e.message : String(e));
      }
    });

    admin.post('/api/slack/links', async (req) => {
      const body = parse(z.object({ relayChannelId: z.string(), slackChannelId: z.string(), importHistory: z.number().int().min(0).max(500).optional() }), req.body);
      const ch = get<{ kind: string; name: string }>('SELECT kind, name FROM channels WHERE id = ?', body.relayChannelId);
      if (!ch || (ch.kind !== 'public' && ch.kind !== 'private')) throw badRequest('invalid_channel');
      try {
        await linkChannel(body.relayChannelId, body.slackChannelId, body.importHistory ?? 0);
      } catch (e) {
        throw badRequest('slack_error', e instanceof Error ? e.message : String(e));
      }
      const link = listLinks().find((l) => l.relayChannelId === body.relayChannelId);
      postMessage({ channelId: body.relayChannelId, userId: req.user.id, text: `Slack #${link?.slackChannelName ?? ''}`, subtype: 'bridge' });
      emitChannel(body.relayChannelId);
      return listLinks();
    });

    admin.delete('/api/slack/links/:id', async (req) => {
      const { id } = req.params as { id: string };
      unlinkChannel(id);
      emitChannel(id);
      return listLinks();
    });
  });
}
