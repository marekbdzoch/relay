import { useEffect, useMemo, useState } from 'react';
import type { AgentSettings, AIConnectionTest, AIProviderId, AIProviderInfo } from '../../../shared/types.ts';
import { GET, POST, PUT } from '../api.ts';
import { toast } from '../store.ts';
import { t, tp } from '../i18n.ts';
import { fail } from '../actions.ts';
import { Spinner } from './ui.tsx';
import { CircleAlert, CircleCheck, ExternalLink, Globe } from './icons.tsx';
import '../styles/ai-provider.css';

type TestState = { status: 'idle' } | { status: 'testing' } | ({ status: 'done' } & AIConnectionTest);

const KEY_PLACEHOLDER: Partial<Record<AIProviderId, string>> = {
  anthropic: 'sk-ant-…',
  openai: 'sk-…',
  gemini: 'AIza…',
  openrouter: 'sk-or-…',
  mistral: '',
};

/**
 * Picks the AI provider for agents: provider cards, API key, base URL (local / custom endpoints), connection test,
 * default model and Save. Used in Workspace settings → AI agents and in the onboarding wizard.
 */
export function AIProviderSetup({ onSaved }: { onSaved?: () => void }) {
  const [st, setSt] = useState<AgentSettings | null>(null);
  const [provider, setProvider] = useState<AIProviderId>('anthropic');
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const [busy, setBusy] = useState(false);

  const load = (s: AgentSettings) => {
    setSt(s);
    setProvider(s.provider);
    setBaseUrl(s.baseUrl);
    setModel(s.defaultModel);
  };

  useEffect(() => {
    GET<AgentSettings>('/api/agents/settings').then(load).catch(fail);
  }, []);

  const info = st?.providers.find((p) => p.id === provider);
  const isActive = !!st && provider === st.provider;

  // models to choose the default from: the last successful test, else the cached list of the active provider
  const models = useMemo(() => {
    if (test.status === 'done' && test.ok) return test.models;
    return isActive ? (st?.models ?? []) : [];
  }, [test, isActive, st]);

  if (!st || !info) return <Spinner />;

  const pick = (p: AIProviderInfo) => {
    if (p.id === provider) return;
    setProvider(p.id);
    setKey('');
    setTest({ status: 'idle' });
    const active = p.id === st.provider;
    setBaseUrl(active ? st.baseUrl : (p.defaultBaseUrl ?? ''));
    setModel(active ? st.defaultModel : '');
  };

  const keyFromEnv = isActive && st.fromEnv;
  const hasKey = !!key.trim() || info.keySet;
  const canTest = (!info.needsKey || hasKey) && (!info.needsBaseUrl || !!baseUrl.trim()) && test.status !== 'testing';
  const canSave = !busy && !(st.providerFromEnv && !isActive) && (!info.needsKey || hasKey) && (!info.needsBaseUrl || !!baseUrl.trim());

  const runTest = async () => {
    setTest({ status: 'testing' });
    try {
      const r = await POST<AIConnectionTest>('/api/agents/settings/test', {
        provider,
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        ...(info.needsBaseUrl && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      });
      setTest({ status: 'done', ...r });
      if (r.ok && r.models.length && !r.models.some((m) => m.id === model)) setModel(r.models[0].id);
    } catch (e) {
      setTest({ status: 'idle' });
      fail(e);
    }
  };

  const save = async (removeKey = false) => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { provider };
      if (removeKey) body.apiKey = null;
      else if (key.trim()) body.apiKey = key.trim();
      if (info.needsBaseUrl) body.baseUrl = baseUrl.trim();
      if (!removeKey && model.trim()) body.defaultModel = model.trim();
      const s = await PUT<AgentSettings>('/api/agents/settings', body);
      load(s);
      setKey('');
      toast(removeKey ? t('API key removed') : t('AI settings saved'));
      if (!removeKey) onSaved?.();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-setup">
      <div className={`slack-status ${st.configured ? 'ok' : ''}`}>
        <span className={`presence-dot ${st.configured ? 'online' : 'away'}`} />
        {st.configured
          ? t('Connected to {provider} – agents can reply', { provider: st.providers.find((p) => p.id === st.provider)?.name ?? st.provider })
          : t('Not connected – agents can’t reply yet')}
      </div>

      {st.providerFromEnv && <p className="field-help">{t('The provider is set by the AI_PROVIDER environment variable.')}</p>}

      <div className="ai-provider-grid" role="radiogroup" aria-label={t('AI provider')}>
        {st.providers.map((p) => {
          const disabled = !!st.providerFromEnv && p.id !== st.provider;
          return (
            <label key={p.id} className={`ai-provider-card${p.id === provider ? ' active' : ''}${disabled ? ' disabled' : ''}`}>
              <input type="radio" name="ai-provider" checked={p.id === provider} disabled={disabled} onChange={() => pick(p)} />
              <span className="ai-provider-name">
                {p.name}
                {p.id === 'anthropic' && <span className="ai-provider-badge">{t('Recommended')}</span>}
                {p.id === st.provider && st.configured && <span className="ai-provider-badge ok">{t('Active')}</span>}
              </span>
              <span className="ai-provider-desc">{t(p.description)}</span>
              {p.supportsWebSearch && (
                <span className="ai-provider-feature">
                  <Globe size={12} /> {t('Web search')}
                </span>
              )}
            </label>
          );
        })}
      </div>

      {(info.needsKey || provider === 'custom') && (
        <label className="field">
          <span className="field-label">
            {t('API key')} {!info.needsKey && <span className="optional">({t('optional')})</span>}
          </span>
          {keyFromEnv ? (
            <span className="field-help">{t('The key is configured via an environment variable on the server.')}</span>
          ) : (
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="mono-input"
              placeholder={info.keySet ? `•••••••• (${t('saved')})` : KEY_PLACEHOLDER[provider] || t('Paste your API key')}
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setTest({ status: 'idle' });
              }}
            />
          )}
          <span className="field-help ai-key-help">
            {info.keyUrl && (
              <a href={info.keyUrl} target="_blank" rel="noreferrer" className="inline-icon">
                {t('Get an API key')} <ExternalLink size={13} />
              </a>
            )}
            <span>{t('The key is stored on your server only and never shown again.')}</span>
          </span>
        </label>
      )}

      {info.needsBaseUrl && (
        <label className="field">
          <span className="field-label">{t('Base URL')}</span>
          <input
            type="text"
            spellCheck={false}
            className="mono-input"
            placeholder={info.defaultBaseUrl ?? 'https://example.com/v1'}
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setTest({ status: 'idle' });
            }}
          />
          <span className="field-help">
            {provider === 'ollama'
              ? t('Ollama must be reachable from the Relay server. With Docker, use http://host.docker.internal:11434/v1.')
              : t('The OpenAI-compatible API root, usually ending with /v1.')}
          </span>
        </label>
      )}

      <div className="ai-test-row">
        <button className="btn" disabled={!canTest} onClick={() => void runTest()}>
          {test.status === 'testing' ? <Spinner size={14} /> : null}
          {t('Test connection')}
        </button>
        {test.status === 'done' && test.ok && (
          <span className="ai-test-result ok" role="status">
            <CircleCheck size={16} /> {tp(test.models.length, 'Connected – {n} model available', 'Connected – {n} models available')}
          </span>
        )}
        {test.status === 'done' && !test.ok && (
          <span className="ai-test-result error" role="alert">
            <CircleAlert size={16} /> {test.error}
          </span>
        )}
      </div>

      {(provider !== 'anthropic' || models.length > 0) && (
        <label className="field">
          <span className="field-label">{t('Default model')}</span>
          {provider === 'anthropic' ? (
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input
                type="text"
                list="ai-provider-models"
                spellCheck={false}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={t('Test the connection to load the models')}
              />
              <datalist id="ai-provider-models">
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name !== m.id ? m.name : undefined}
                  </option>
                ))}
              </datalist>
            </>
          )}
          <span className="field-help">
            {provider === 'anthropic'
              ? t('Agents use this model unless you pick another one for an agent.')
              : t('Agents use this model unless you pick another one for an agent. Pick a model that supports tool calling (function calling).')}
          </span>
        </label>
      )}

      {provider !== 'anthropic' && (
        <p className="field-help">
          {t(
            'Web search is only available with Anthropic Claude. Everything else – delegation, reading channels, search, reactions – works with every provider.',
          )}
        </p>
      )}

      <div className="ai-actions">
        {isActive && info.keySet && !keyFromEnv && (
          <button className="btn danger" disabled={busy} onClick={() => void save(true)}>
            {t('Remove key')}
          </button>
        )}
        <button className="btn primary" disabled={!canSave} onClick={() => void save()}>
          {t('Save')}
        </button>
      </div>
    </div>
  );
}
