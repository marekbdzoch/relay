import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { requireAdmin, requireAuth } from '../lib/auth.ts';
import { HttpError, badRequest, notFound, randomToken } from '../lib/util.ts';
import { getImportJob, importRunning, inspectSlackExport, latestImportJob, startSlackImport, type SlackImportOptions } from '../import/slack.ts';

/** Slack exports can be big: at least 1 GB, more when MAX_UPLOAD_MB / MAX_IMPORT_MB allow it. */
export function importLimitBytes() {
  const mb = Math.max(config.maxUploadMb, Number(process.env.MAX_IMPORT_MB ?? 0) || 0, 1024);
  return mb * 1024 * 1024;
}

const parseBool = (v: unknown, fallback: boolean) => {
  if (v === undefined || v === null || v === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(v).toLowerCase());
};

export async function importRoutes(app: FastifyInstance) {
  app.register(async (admin) => {
    admin.addHook('preHandler', requireAuth);
    admin.addHook('preHandler', async (req) => requireAdmin(req));

    // multipart: one .zip file (field name is free) + optional fields importFiles / importPrivate / importDms
    admin.post('/api/admin/import/slack', async (req) => {
      if (!req.isMultipart()) throw badRequest('multipart_required', 'Upload the Slack export as multipart/form-data.');
      if (importRunning()) throw new HttpError(409, 'import_running', 'An import is already running.');
      const query = (req.query ?? {}) as Record<string, string | undefined>;
      const fields: Record<string, string> = {};
      const dir = path.join(config.dataDir, 'tmp');
      let tmp: string | null = null;
      try {
        for await (const part of req.parts({ limits: { fileSize: importLimitBytes(), files: 1, fields: 20 } })) {
          if (part.type === 'file') {
            if (tmp) {
              part.file.resume();
              continue;
            }
            fs.mkdirSync(dir, { recursive: true });
            tmp = path.join(dir, `slack-import-${Date.now().toString(36)}${randomToken(6)}.zip`);
            await pipeline(part.file, fs.createWriteStream(tmp));
            if (part.file.truncated) throw new HttpError(413, 'file_too_large');
          } else {
            fields[part.fieldname] = String(part.value ?? '');
          }
        }
        if (!tmp) throw badRequest('file_required', 'Choose the Slack export ZIP file.');
        await inspectSlackExport(tmp);
        const opts: SlackImportOptions = {
          importFiles: parseBool(fields.importFiles ?? query.importFiles, true),
          importPrivate: parseBool(fields.importPrivate ?? query.importPrivate, true),
          importDms: parseBool(fields.importDms ?? query.importDms, true),
        };
        // a concurrent upload may have started a job meanwhile
        if (importRunning()) throw new HttpError(409, 'import_running', 'An import is already running.');
        const job = startSlackImport(tmp, opts, req.user.id);
        return { jobId: job.id };
      } catch (e) {
        if (tmp) fs.rmSync(tmp, { force: true });
        throw e;
      }
    });

    /** The latest import job (to resume showing progress after a reload). */
    admin.get('/api/admin/import/slack', async () => ({ job: latestImportJob() }));

    admin.get('/api/admin/import/slack/:jobId', async (req) => {
      const job = getImportJob((req.params as { jobId: string }).jobId);
      if (!job) throw notFound('job_not_found');
      return job;
    });
  });
}
