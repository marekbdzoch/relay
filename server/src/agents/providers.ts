/**
 * AI providers for agents.
 *
 * Anthropic (Claude) is the default and uses the official SDK (see runtime.ts). Every other provider is reached through
 * its OpenAI-compatible Chat Completions API with plain fetch (see openai.ts). This module holds the provider registry and
 * the workspace settings: which provider is active, its key, base URL, default model and the cached model list.
 *
 * Settings (settings table): ai.provider, anthropic.apiKey / ai.<provider>.apiKey, ai.baseUrl, ai.defaultModel, ai.models.
 * Environment overrides: AI_PROVIDER, AI_BASE_URL, AI_MODEL, ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,
 * OPENROUTER_API_KEY, MISTRAL_API_KEY, AI_API_KEY (custom endpoint).
 */
import type { AIProviderId, AIProviderInfo } from '../../../shared/types.ts';
import { getSetting, setSetting } from '../db.ts';

export interface ProviderDef {
  id: AIProviderId;
  name: string;
  description: string;
  keyUrl?: string;
  needsKey: boolean;
  needsBaseUrl: boolean;
  defaultBaseUrl?: string;
  supportsWebSearch: boolean;
  /** environment variable holding the key */
  envKey?: string;
  /** settings key holding the key */
  settingKey?: string;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    description: 'Claude Opus, Sonnet and Haiku. Recommended – best at tool use and delegation, with built-in web search.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    needsKey: true,
    needsBaseUrl: false,
    supportsWebSearch: true,
    envKey: 'ANTHROPIC_API_KEY',
    settingKey: 'anthropic.apiKey',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models from OpenAI.',
    keyUrl: 'https://platform.openai.com/api-keys',
    needsKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: 'https://api.openai.com/v1',
    supportsWebSearch: false,
    envKey: 'OPENAI_API_KEY',
    settingKey: 'ai.openai.apiKey',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Gemini models from Google AI Studio.',
    keyUrl: 'https://aistudio.google.com/apikey',
    needsKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    supportsWebSearch: false,
    envKey: 'GEMINI_API_KEY',
    settingKey: 'ai.gemini.apiKey',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'One key for hundreds of models from many vendors.',
    keyUrl: 'https://openrouter.ai/keys',
    needsKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    supportsWebSearch: false,
    envKey: 'OPENROUTER_API_KEY',
    settingKey: 'ai.openrouter.apiKey',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    description: 'Mistral models, hosted in the EU.',
    keyUrl: 'https://console.mistral.ai/api-keys',
    needsKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    supportsWebSearch: false,
    envKey: 'MISTRAL_API_KEY',
    settingKey: 'ai.mistral.apiKey',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Open models running on your own hardware. No data leaves your network; no key needed.',
    needsKey: false,
    needsBaseUrl: true,
    defaultBaseUrl: 'http://localhost:11434/v1',
    supportsWebSearch: false,
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    description: 'Any endpoint that speaks the OpenAI Chat Completions API: LM Studio, vLLM, LiteLLM, Groq, Together, Azure…',
    needsKey: false,
    needsBaseUrl: true,
    supportsWebSearch: false,
    envKey: 'AI_API_KEY',
    settingKey: 'ai.custom.apiKey',
  },
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id) as [AIProviderId, ...AIProviderId[]];

/** Timeouts (ms); tests shorten them. */
export const limits = { testTimeoutMs: 10_000, requestTimeoutMs: 180_000 };

export function providerDef(id: AIProviderId): ProviderDef {
  return PROVIDERS.find((p) => p.id === id)!;
}

export function isProviderId(v: unknown): v is AIProviderId {
  return typeof v === 'string' && PROVIDERS.some((p) => p.id === v);
}

export function providerFromEnv(): AIProviderId | null {
  const v = process.env.AI_PROVIDER?.trim().toLowerCase();
  return isProviderId(v) ? v : null;
}

export function activeProvider(): AIProviderId {
  const stored = getSetting('ai.provider');
  return providerFromEnv() ?? (isProviderId(stored) ? stored : 'anthropic');
}

export function storedKey(id: AIProviderId) {
  const def = providerDef(id);
  return def.settingKey ? getSetting(def.settingKey) || '' : '';
}

export function keyFromEnv(id: AIProviderId) {
  const def = providerDef(id);
  return !!(def.envKey && process.env[def.envKey]);
}

export function providerKey(id: AIProviderId) {
  const def = providerDef(id);
  return (def.envKey && process.env[def.envKey]) || storedKey(id);
}

export function setProviderKey(id: AIProviderId, key: string | null) {
  const def = providerDef(id);
  if (def.settingKey) setSetting(def.settingKey, key || null);
}

/** Trims and validates a base URL; returns null when it isn't an http(s) URL. */
export function normalizeBaseUrl(v: string): string | null {
  const s = v.trim().replace(/\/+$/, '');
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
}

/**
 * Base URL of an OpenAI-compatible provider. For the active provider: AI_BASE_URL, then the stored ai.baseUrl, then the
 * provider default. For any other provider (e.g. while testing one before switching) only the default applies.
 */
export function providerBaseUrl(id: AIProviderId): string {
  if (id === 'anthropic') return '';
  const def = providerDef(id);
  if (id === activeProvider()) {
    const env = process.env.AI_BASE_URL && normalizeBaseUrl(process.env.AI_BASE_URL);
    if (env) return env;
    const stored = getSetting('ai.baseUrl');
    if (stored) return stored;
  }
  return def.defaultBaseUrl ?? '';
}

export interface ModelEntry {
  id: string;
  name: string;
}

/** Model list fetched from the provider, cached per provider + base URL. */
export function cachedModels(id: AIProviderId, baseUrl = providerBaseUrl(id)): ModelEntry[] {
  const raw = getSetting('ai.models');
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as { provider: string; baseUrl: string; models: ModelEntry[] };
    return v.provider === id && v.baseUrl === baseUrl && Array.isArray(v.models) ? v.models : [];
  } catch {
    return [];
  }
}

export function cacheModels(id: AIProviderId, baseUrl: string, models: ModelEntry[]) {
  setSetting('ai.models', JSON.stringify({ provider: id, baseUrl, models, fetchedAt: Date.now() }));
}

export function storedDefaultModel() {
  return process.env.AI_MODEL?.trim() || getSetting('ai.defaultModel') || '';
}

export function providerInfo(): AIProviderInfo[] {
  return PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    ...(p.keyUrl ? { keyUrl: p.keyUrl } : {}),
    needsKey: p.needsKey,
    needsBaseUrl: p.needsBaseUrl,
    ...(p.defaultBaseUrl ? { defaultBaseUrl: p.defaultBaseUrl } : {}),
    supportsWebSearch: p.supportsWebSearch,
    keySet: !!providerKey(p.id),
  }));
}
