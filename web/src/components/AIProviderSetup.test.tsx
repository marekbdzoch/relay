import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSettings, AIProviderInfo } from '../../../shared/types.ts';
import { AIProviderSetup } from './AIProviderSetup.tsx';
import { resetStore } from '../test/helpers.ts';

const provider = (p: Partial<AIProviderInfo> & Pick<AIProviderInfo, 'id' | 'name'>): AIProviderInfo => ({
  description: `${p.name} models`,
  needsKey: true,
  needsBaseUrl: false,
  supportsWebSearch: false,
  keySet: false,
  ...p,
});

const anthropicSettings: AgentSettings = {
  configured: false,
  fromEnv: false,
  provider: 'anthropic',
  baseUrl: '',
  defaultModel: 'claude-opus-5-5',
  models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', description: '' }],
  providers: [
    provider({ id: 'anthropic', name: 'Anthropic Claude', supportsWebSearch: true, keyUrl: 'https://console.anthropic.com/settings/keys' }),
    provider({ id: 'openai', name: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys', defaultBaseUrl: 'https://api.openai.com/v1' }),
    provider({ id: 'ollama', name: 'Ollama', needsKey: false, needsBaseUrl: true, defaultBaseUrl: 'http://localhost:11434/v1' }),
  ],
};

type Call = { method: string; url: string; body: any };
let calls: Call[];
let handler: (c: Call) => unknown;

beforeEach(() => {
  resetStore();
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const c = { method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(c);
      return new Response(JSON.stringify(handler(c)), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});

describe('AIProviderSetup', () => {
  it('switches provider, tests the connection and saves key + default model', async () => {
    const saved: AgentSettings = {
      ...anthropicSettings,
      configured: true,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-b',
      models: [],
    };
    handler = (c) => {
      if (c.url.endsWith('/test'))
        return {
          ok: true,
          models: [
            { id: 'gpt-a', name: 'gpt-a' },
            { id: 'gpt-b', name: 'GPT B' },
          ],
        };
      if (c.method === 'PUT') return saved;
      return anthropicSettings;
    };
    const onSaved = vi.fn();
    render(<AIProviderSetup onSaved={onSaved} />);
    await screen.findByText('Anthropic Claude', undefined, { timeout: 5000 });
    expect(screen.getByText('Not connected – agents can’t reply yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Get an API key/ })).toHaveAttribute('href', 'https://console.anthropic.com/settings/keys');

    fireEvent.click(screen.getByRole('radio', { name: /OpenAI/ }));
    expect(screen.getByRole('link', { name: /Get an API key/ })).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
    expect(screen.getByText(/Web search is only available with Anthropic Claude/)).toBeInTheDocument();
    const testBtn = screen.getByRole('button', { name: 'Test connection' });
    expect(testBtn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: ' sk-test ' } });
    fireEvent.click(testBtn);
    expect(await screen.findByText('Connected – 2 models available', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(calls.at(-1)).toEqual({ method: 'POST', url: '/api/agents/settings/test', body: { provider: 'openai', apiKey: 'sk-test' } });

    const modelInput = screen.getByPlaceholderText('Test the connection to load the models') as HTMLInputElement;
    expect(modelInput.value).toBe('gpt-a');
    fireEvent.change(modelInput, { target: { value: 'gpt-b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled(), { timeout: 5000 });
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ provider: 'openai', apiKey: 'sk-test', defaultModel: 'gpt-b' });
    expect(await screen.findByText('Connected to OpenAI – agents can reply', undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it('shows the base URL for local providers and test errors', async () => {
    handler = (c) => (c.url.endsWith('/test') ? { ok: false, error: 'Cannot reach http://localhost:11434/v1' } : anthropicSettings);
    render(<AIProviderSetup />);
    fireEvent.click(await screen.findByRole('radio', { name: /Ollama/ }, { timeout: 5000 }));
    expect(screen.queryByText('API key')).not.toBeInTheDocument();
    const url = screen.getByPlaceholderText('http://localhost:11434/v1') as HTMLInputElement;
    expect(url.value).toBe('http://localhost:11434/v1');
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByRole('alert', undefined, { timeout: 5000 })).toHaveTextContent('Cannot reach http://localhost:11434/v1');
    expect(calls.at(-1)!.body).toEqual({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1' });
  });
});
