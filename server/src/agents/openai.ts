/**
 * Minimal client for OpenAI-compatible APIs (OpenAI, Gemini, OpenRouter, Mistral, Ollama, custom endpoints) using fetch:
 * GET {baseUrl}/models and POST {baseUrl}/chat/completions with function calling.
 */
import type { AIProviderId } from '../../../shared/types.ts';
import type { ModelEntry } from './providers.ts';

export class ProviderError extends Error {
  status: number | null;
  kind: 'http' | 'network' | 'timeout' | 'invalid';
  constructor(kind: ProviderError['kind'], status: number | null, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
  }
}

function headers(provider: AIProviderId, key: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    ...(key ? { authorization: `Bearer ${key}` } : {}),
    ...(provider === 'openrouter' ? { 'X-Title': 'Relay' } : {}),
  };
}

function errorText(body: any, raw: string): string {
  const b = Array.isArray(body) ? body[0] : body;
  const msg = b?.error?.message ?? (typeof b?.error === 'string' ? b.error : null) ?? b?.message ?? b?.detail;
  return typeof msg === 'string' && msg ? msg : raw.slice(0, 200);
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const signal = AbortSignal.timeout(timeoutMs);
  let raw: string;
  let status: number;
  let ok: boolean;
  try {
    const res = await fetch(url, { ...init, signal });
    status = res.status;
    ok = res.ok;
    raw = await res.text();
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError')
      throw new ProviderError('timeout', null, `No response within ${Math.round(timeoutMs / 1000)} s`);
    throw new ProviderError('network', null, err?.cause?.code || err?.cause?.message || err?.message || 'network error');
  }
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    /* not JSON */
  }
  if (!ok) throw new ProviderError('http', status, errorText(body, raw));
  if (body === null || typeof body !== 'object') throw new ProviderError('invalid', status, 'The response is not JSON');
  return body;
}

const NON_CHAT = /(embed|whisper|tts|dall-e|moderation|transcribe|rerank|imagen|davinci|babbage|text-similarity)/i;

/** Lists the models of an OpenAI-compatible API (chat models first; embedding, audio and image models are dropped). */
export async function listModels(provider: AIProviderId, baseUrl: string, key: string, timeoutMs: number): Promise<ModelEntry[]> {
  const body = await request(`${baseUrl}/models`, { headers: headers(provider, key) }, timeoutMs);
  const list: any[] | null = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : null;
  if (!list) throw new ProviderError('invalid', 200, 'The response is not a model list');
  const seen = new Set<string>();
  const out: ModelEntry[] = [];
  for (const m of list) {
    const id = String(m?.id ?? m?.name ?? '').replace(/^models\//, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name =
      typeof m?.name === 'string' && m.name && !m.name.startsWith('models/')
        ? m.name
        : typeof m?.display_name === 'string' && m.display_name
          ? m.display_name
          : id;
    out.push({ id, name });
  }
  const chat = out.filter((m) => !NON_CHAT.test(m.id));
  return chat.length ? chat : out;
}

export async function chatCompletion(provider: AIProviderId, baseUrl: string, key: string, body: Record<string, unknown>, timeoutMs: number): Promise<any> {
  return request(`${baseUrl}/chat/completions`, { method: 'POST', headers: headers(provider, key), body: JSON.stringify(body) }, timeoutMs);
}

/** Message content of a chat completion (a string, or an array of parts with some providers). */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}
