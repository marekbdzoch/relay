import { useEffect, useRef, useState } from 'react';
import type { SlackImportJob } from '../../../shared/types.ts';
import { GET, upload } from '../api.ts';
import { errorMessage, reloadAfterImport } from '../actions.ts';
import { socket } from '../socket.ts';
import { t } from '../i18n.ts';
import { AlertTriangle, CircleCheck, FileArchive, FileImport, Info, RotateCcw, Upload, X } from './icons.tsx';
import { Spinner, Toggle } from './ui.tsx';
import '../styles/slack-import.css';

const HELP_URL = 'https://slack.com/help/articles/201658943';

function phaseLabel(phase: string) {
  const labels: Record<string, string> = {
    queued: t('Waiting to start…'),
    reading: t('Reading the export…'),
    users: t('Importing people…'),
    channels: t('Creating channels…'),
    messages: t('Importing messages…'),
    files: t('Copying files…'),
    finishing: t('Finishing up…'),
    done: t('Done'),
  };
  return labels[phase] ?? phase;
}

function formatSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

function Counts({ job }: { job: SlackImportJob }) {
  const items: [string, number][] = [
    [t('People'), job.counts.users],
    [t('Channels'), job.counts.channels],
    [t('Messages'), job.counts.messages],
    [t('Files'), job.counts.files],
    [t('Reactions'), job.counts.reactions],
  ];
  return (
    <div className="slack-import-counts">
      {items.map(([label, n]) => (
        <div key={label} className="slack-import-count">
          <b>{n.toLocaleString()}</b>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

function Guide() {
  const steps = [
    t('In Slack, click the workspace name in the top left and open Tools & settings → Workspace settings.'),
    t('Click Import/Export Data in the top right and switch to the Export tab.'),
    t('Pick the date range (for example Entire history) and click Start Export. Slack e-mails you when the export is ready.'),
    t('Download the ZIP file from the link in that e-mail and drop it below. Don’t unpack it.'),
  ];
  return (
    <div className="slack-import-guide">
      <ol>
        {steps.map((s, i) => (
          <li key={i}>
            <span className="slack-import-step">{i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <p className="slack-import-note">
        <Info size={16} />
        <span>
          {t('Only workspace owners and admins can export. Free and Pro plans export public channels only; Business+ and Enterprise Grid can also include private channels and direct messages.')}{' '}
          <a href={HELP_URL} target="_blank" rel="noreferrer">
            {t('Slack help: Export your workspace data')}
          </a>
        </span>
      </p>
    </div>
  );
}

/** Self-contained "Import from Slack" flow: how-to, file picker, options, upload + live import progress. */
export function SlackImportPanel({ onDone }: { onDone?: (job: SlackImportJob) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [importFiles, setImportFiles] = useState(true);
  const [importPrivate, setImportPrivate] = useState(true);
  const [importDms, setImportDms] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [job, setJob] = useState<SlackImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<(() => void) | null>(null);
  const finished = useRef<string | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const running = !!job && (job.state === 'queued' || job.state === 'running');

  // resume showing a running import (e.g. after a reload)
  useEffect(() => {
    GET<{ job: SlackImportJob | null }>('/api/admin/import/slack')
      .then((r) => {
        if (r.job && (r.job.state === 'queued' || r.job.state === 'running')) setJob(r.job);
      })
      .catch(() => {});
    return () => abort.current?.();
  }, []);

  // live progress over the socket, polling as a fallback
  useEffect(() => {
    if (!job || !running) return;
    const id = job.id;
    const onProgress = (j: SlackImportJob) => j.id === id && setJob(j);
    const s = socket;
    s?.on('import:progress', onProgress);
    const timer = setInterval(() => {
      GET<SlackImportJob>(`/api/admin/import/slack/${id}`)
        .then((j) => setJob(j))
        .catch(() => {});
    }, 2000);
    return () => {
      s?.off('import:progress', onProgress);
      clearInterval(timer);
    };
  }, [job?.id, running]);

  // finished: reload the app's data once and tell the host
  useEffect(() => {
    if (!job || running || finished.current === job.id) return;
    finished.current = job.id;
    if (job.state === 'done') void reloadAfterImport(job.id);
    onDoneRef.current?.(job);
  }, [job, running]);

  const pick = (f: File | undefined | null) => {
    setError(null);
    if (!f) return;
    if (!/\.zip$/i.test(f.name)) {
      setError(t('Choose the .zip file you downloaded from Slack.'));
      return;
    }
    setFile(f);
  };

  const start = async () => {
    if (!file) return;
    setError(null);
    setUploading(0);
    const form = new FormData();
    form.append('importFiles', String(importFiles));
    form.append('importPrivate', String(importPrivate));
    form.append('importDms', String(importDms));
    form.append('file', file, file.name);
    const req = upload<{ jobId: string }>('/api/admin/import/slack', form, (f) => setUploading(f));
    abort.current = req.abort;
    try {
      const { jobId } = await req.promise;
      setJob(await GET<SlackImportJob>(`/api/admin/import/slack/${jobId}`));
      setFile(null);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'aborted') {
        setError(
          code === 'not_a_slack_export'
            ? t('This file doesn’t look like a Slack export. Upload the ZIP exactly as Slack created it.')
            : code === 'import_running'
              ? t('Another import is already running. Wait until it finishes.')
              : errorMessage(e),
        );
      }
    } finally {
      abort.current = null;
      setUploading(null);
    }
  };

  const reset = () => {
    setJob(null);
    setFile(null);
    setError(null);
  };

  // ----- importing / finished -----
  if (job) {
    const pct = Math.round((job.state === 'done' ? 1 : job.progress) * 100);
    return (
      <div className="slack-import">
        <div className={`slack-import-card slack-import-status ${job.state}`}>
          <div className="slack-import-status-head">
            {job.state === 'done' ? (
              <CircleCheck size={28} />
            ) : job.state === 'error' ? (
              <AlertTriangle size={28} />
            ) : (
              <Spinner size={24} />
            )}
            <div>
              <h4>{job.state === 'done' ? t('Import finished') : job.state === 'error' ? t('The import failed') : t('Importing from Slack…')}</h4>
              <p className="muted-text">
                {job.state === 'error' ? job.error : job.state === 'done' ? t('Your Slack history is now here. Invite your colleagues so they can claim their accounts.') : phaseLabel(job.phase)}
              </p>
            </div>
          </div>
          {job.state !== 'error' && (
            <div className="slack-import-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct}%` }} />
            </div>
          )}
          <Counts job={job} />
          {running && <p className="field-help">{t('You can close this window – the import keeps running on the server.')}</p>}
        </div>
        {job.warnings.length > 0 && (
          <details className="slack-import-card slack-import-warnings" open={job.state !== 'running'}>
            <summary>
              <AlertTriangle size={16} /> {t('Notes ({n})', { n: job.warnings.length })}
            </summary>
            <ul>
              {job.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
        {!running && (
          <div className="slack-import-actions">
            <button className="btn" onClick={reset}>
              <RotateCcw size={14} /> {job.state === 'error' ? t('Try again') : t('Import another export')}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ----- choose file -----
  return (
    <div className="slack-import">
      <Guide />
      <div
        className={`slack-import-drop${dragging ? ' dragging' : ''}${file ? ' has-file' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files?.[0]);
        }}
        onClick={() => uploading === null && input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      >
        {file ? (
          <>
            <FileArchive size={32} />
            <div className="slack-import-file">
              <b>{file.name}</b>
              <span className="muted-text">{formatSize(file.size)}</span>
            </div>
            {uploading === null && (
              <button
                className="icon-btn small"
                title={t('Remove')}
                onClick={(e) => {
                  e.stopPropagation();
                  setFile(null);
                }}
              >
                <X size={16} />
              </button>
            )}
          </>
        ) : (
          <>
            <FileImport size={32} />
            <b>{t('Drop the Slack export ZIP here')}</b>
            <span className="muted-text">{t('or click to choose a file')}</span>
          </>
        )}
        <input
          ref={input}
          type="file"
          hidden
          accept=".zip,application/zip,application/x-zip-compressed"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      <div className="slack-import-card slack-import-options">
        <Toggle checked={importFiles} onChange={setImportFiles} disabled={uploading !== null} label={t('Copy files and profile photos from Slack')} />
        <Toggle checked={importPrivate} onChange={setImportPrivate} disabled={uploading !== null} label={t('Import private channels (if the export includes them)')} />
        <Toggle checked={importDms} onChange={setImportDms} disabled={uploading !== null} label={t('Import direct messages (if the export includes them)')} />
        <p className="field-help">{t('Importing the same export again is safe: nothing is duplicated, newer messages are added.')}</p>
      </div>

      {error && (
        <p className="slack-import-error">
          <AlertTriangle size={16} /> {error}
        </p>
      )}

      {uploading !== null ? (
        <div className="slack-import-card">
          <div className="slack-import-status-head">
            <Spinner size={20} />
            <span>{t('Uploading… {pct} %', { pct: Math.round(uploading * 100) })}</span>
            <button className="btn small" onClick={() => abort.current?.()}>
              {t('Cancel')}
            </button>
          </div>
          <div className="slack-import-bar">
            <span style={{ width: `${Math.round(uploading * 100)}%` }} />
          </div>
        </div>
      ) : (
        <div className="slack-import-actions">
          <button className="btn primary" disabled={!file} onClick={() => void start()}>
            <Upload size={14} /> {t('Start import')}
          </button>
        </div>
      )}
    </div>
  );
}
