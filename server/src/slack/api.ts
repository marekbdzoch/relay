/** Minimal Slack Web API client (form-encoded POSTs, automatic 429 back-off). */
export class SlackError extends Error {
  code: string;
  constructor(code: string, method: string) {
    super(`Slack ${method}: ${code}`);
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SlackApi {
  token: string;
  constructor(token: string) {
    this.token = token;
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}, attempt = 0): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get('retry-after') ?? '1');
      await sleep((wait + 0.2) * 1000);
      return this.call(method, params, attempt + 1);
    }
    const data = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!data.ok) throw new SlackError(data.error ?? `http_${res.status}`, method);
    return data;
  }

  /** Downloads a private Slack file (url_private / url_private_download). */
  async download(url: string): Promise<Response> {
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.token}` }, redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Slack file download failed: ${res.status}`);
    return res;
  }

  /** Uploads a file to a channel (files.getUploadURLExternal + completeUploadExternal). */
  async uploadFile(o: { channel: string; threadTs?: string; filename: string; data: Buffer; title?: string; initialComment?: string }) {
    const { upload_url, file_id } = await this.call<{ upload_url: string; file_id: string }>('files.getUploadURLExternal', { filename: o.filename, length: o.data.length });
    const up = await fetch(upload_url, { method: 'POST', body: new Uint8Array(o.data), signal: AbortSignal.timeout(120_000) });
    if (!up.ok) throw new Error(`Slack upload failed: ${up.status}`);
    return this.call('files.completeUploadExternal', {
      files: [{ id: file_id, title: o.title ?? o.filename }],
      channel_id: o.channel,
      thread_ts: o.threadTs,
      initial_comment: o.initialComment,
    });
  }
}
