/** Workspace AI settings (provider, key, base URL, default model) and the connection test behind /api/agents/settings. */
import Anthropic from '@anthropic-ai/sdk';
import type { AgentSettings, AIConnectionTest, AIProviderId } from '../../../shared/types.ts';
import { getSetting, setSetting } from '../db.ts';
import { badRequest } from '../lib/util.ts';
import { AGENT_MODELS, workspaceDefaultModel } from './store.ts';
import {
  activeProvider,
  cachedModels,
  cacheModels,
  keyFromEnv,
  limits,
  normalizeBaseUrl,
  providerBaseUrl,
  providerDef,
  providerFromEnv,
  providerInfo,
  providerKey,
  setProviderKey,
  type ModelEntry,
} from './providers.ts';
import { ProviderError, listModels } from './openai.ts';
import { agentApiConfigured } from './runtime.ts';

export function getAgentSettings(admin: boolean): AgentSettings {
  const provider = activeProvider();
  const models =
    provider === 'anthropic' ? AGENT_MODELS : cachedModels(provider).map((m) => ({ id: m.id, name: m.name, description: m.name !== m.id ? m.id : '' }));
  return {
    configured: agentApiConfigured(),
    fromEnv: keyFromEnv(provider),
    models,
    provider,
    providers: providerInfo(),
    baseUrl: admin ? providerBaseUrl(provider) : '',
    defaultModel: workspaceDefaultModel(),
    providerFromEnv: !!providerFromEnv(),
  };
}

export interface SettingsUpdate {
  provider?: AIProviderId;
  apiKey?: string | null;
  baseUrl?: string;
  defaultModel?: string;
}

/** PUT /api/agents/settings. Also accepts the old body shape `{ apiKey }`, which applies to the active provider. */
export async function updateAgentSettings(body: SettingsUpdate): Promise<void> {
  const current = activeProvider();
  const envProvider = providerFromEnv();
  const provider = body.provider ?? current;
  if (envProvider && provider !== envProvider)
    throw badRequest('provider_from_env', `The AI provider is set to ${envProvider} by the AI_PROVIDER environment variable`);
  const def = providerDef(provider);
  const apiKey = body.apiKey === undefined ? undefined : body.apiKey?.trim() || null;
  if (apiKey && provider === 'anthropic' && !apiKey.startsWith('sk-ant-')) throw badRequest('invalid_key', 'Anthropic API keys start with sk-ant-');
  let baseUrl: string | null | undefined;
  if (body.baseUrl !== undefined) {
    baseUrl = body.baseUrl.trim() ? normalizeBaseUrl(body.baseUrl) : null;
    if (baseUrl === null && body.baseUrl.trim()) throw badRequest('invalid_url', 'The base URL must be an http:// or https:// URL');
  }
  let defaultModel: string | null | undefined;
  if (body.defaultModel !== undefined) {
    defaultModel = body.defaultModel.trim() || null;
    if (defaultModel && provider === 'anthropic' && !AGENT_MODELS.some((m) => m.id === defaultModel)) throw badRequest('invalid_model', 'Unknown Claude model');
  }

  const changedProvider = provider !== (getSetting('ai.provider') ?? 'anthropic');
  if (changedProvider) {
    setSetting('ai.provider', provider === 'anthropic' ? null : provider);
    // base URL and default model belong to the previous provider
    if (baseUrl === undefined) baseUrl = null;
    if (defaultModel === undefined) defaultModel = null;
  }
  if (apiKey !== undefined) setProviderKey(provider, apiKey);
  if (baseUrl !== undefined) setSetting('ai.baseUrl', provider === 'anthropic' ? null : baseUrl);
  if (defaultModel !== undefined) setSetting('ai.defaultModel', defaultModel);

  if (provider === 'anthropic') return;
  // fetch and cache the model list, and pick a default model when none is chosen yet
  const url = providerBaseUrl(provider);
  const key = providerKey(provider);
  if (!url || (def.needsKey && !key)) return;
  let models = cachedModels(provider, url);
  if (!models.length || apiKey !== undefined || baseUrl !== undefined || changedProvider) {
    try {
      models = await listModels(provider, url, key, limits.testTimeoutMs);
      cacheModels(provider, url, models);
    } catch (e) {
      console.warn(`[agents] could not list ${provider} models: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!getSetting('ai.defaultModel') && models.length) setSetting('ai.defaultModel', models[0].id);
}

const seconds = () => Math.round(limits.testTimeoutMs / 1000);

/** POST /api/agents/settings/test: checks a key / endpoint without saving anything. */
export async function testConnection(body: { provider: AIProviderId; apiKey?: string; baseUrl?: string }): Promise<AIConnectionTest> {
  const def = providerDef(body.provider);
  const key = body.apiKey?.trim() || providerKey(body.provider);
  if (def.needsKey && !key) return { ok: false, error: 'Enter an API key first.' };

  if (body.provider === 'anthropic') {
    if (!key.startsWith('sk-ant-')) return { ok: false, error: 'Anthropic API keys start with sk-ant-. Copy the whole key from the Anthropic Console.' };
    try {
      await new Anthropic({ apiKey: key, maxRetries: 0, timeout: limits.testTimeoutMs }).models.list({ limit: 1 });
      return { ok: true, models: AGENT_MODELS.map(({ id, name }) => ({ id, name })) };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return { ok: false, error: 'The API key was rejected. Check that it is correct and still active.' };
      if (e instanceof Anthropic.PermissionDeniedError) return { ok: false, error: 'The API key is not allowed to use the API. Check your Anthropic account.' };
      if (e instanceof Anthropic.APIConnectionTimeoutError) return { ok: false, error: `The Anthropic API did not respond within ${seconds()} seconds.` };
      if (e instanceof Anthropic.APIConnectionError) return { ok: false, error: 'Cannot reach the Anthropic API. Check the server’s internet connection.' };
      if (e instanceof Anthropic.APIError) return { ok: false, error: `The Anthropic API returned an error (HTTP ${e.status}).` };
      return { ok: false, error: `Unexpected error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  let url = '';
  if (body.baseUrl?.trim()) {
    const u = normalizeBaseUrl(body.baseUrl);
    if (!u) return { ok: false, error: 'The base URL must be an http:// or https:// URL.' };
    url = u;
  } else url = providerBaseUrl(body.provider);
  if (!url) return { ok: false, error: 'Enter the base URL of the API first.' };

  let models: ModelEntry[];
  try {
    models = await listModels(body.provider, url, key, limits.testTimeoutMs);
  } catch (e) {
    return { ok: false, error: connectionError(e, url) };
  }
  if (!models.length)
    return {
      ok: false,
      error: `Connected, but ${url}/models lists no models.${body.provider === 'ollama' ? ' Pull one first, e.g. “ollama pull llama3.2”.' : ''}`,
    };
  return { ok: true, models };
}

function connectionError(e: unknown, url: string): string {
  if (!(e instanceof ProviderError)) return `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
  if (e.kind === 'timeout') return `${url} did not respond within ${seconds()} seconds.`;
  if (e.kind === 'network') return `Cannot reach ${url} (${e.message}). Check the URL and that the server is running and reachable from the Relay server.`;
  if (e.kind === 'invalid') return `${url} does not look like an OpenAI-compatible API (no model list at ${url}/models).`;
  if (e.status === 401 || e.status === 403) return `The API key was rejected (HTTP ${e.status}). Check that it is correct and still active.`;
  if (e.status === 404) return `Nothing found at ${url}/models (HTTP 404). Check the base URL – it usually ends with /v1.`;
  if (e.status === 429) return 'The provider is rate limiting requests. Try again in a minute.';
  return `The provider returned an error (HTTP ${e.status}${e.message ? `: ${e.message.slice(0, 160)}` : ''}).`;
}
