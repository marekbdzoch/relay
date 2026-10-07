import { useEffect, useMemo, useState } from 'react';
import { Globe, Hash, Lock } from '../components/icons.tsx';
import type { AgentInfo, AgentSettings, User } from '../../../shared/types.ts';
import { GET, PATCH, POST } from '../api.ts';
import { isAdmin, set, toast, useStore } from '../store.ts';
import { t } from '../i18n.ts';
import { fail, openDm, openModal } from '../actions.ts';
import { AGENT_COLORS, AGENT_EMOJI, agentTemplates } from '../lib/agentTemplates.ts';
import { Modal, Toggle } from '../components/ui.tsx';

export function AgentModal({ userId, template, onClose }: { userId?: string; template?: string; onClose: () => void }) {
  const existing = useStore((s) => (userId ? s.agents[userId] : undefined));
  const user = useStore((s) => (userId ? s.users[userId] : undefined));
  const me = useStore((s) => s.me);
  const channels = useStore((s) => s.channels);
  const memberships = useStore((s) => s.memberships);
  const agents = useStore((s) => s.agents);
  const tpl = useMemo(() => agentTemplates().find((x) => x.id === template), [template]);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [name, setName] = useState(user?.fullName ?? tpl?.name ?? '');
  const [role, setRole] = useState(existing?.role ?? tpl?.role ?? '');
  const [department, setDepartment] = useState(existing?.department ?? tpl?.department ?? '');
  const [instructions, setInstructions] = useState(existing?.instructions ?? tpl?.instructions ?? '');
  const [emoji, setEmoji] = useState(existing?.avatarEmoji || tpl?.emoji || '🤖');
  const [color, setColor] = useState(user?.avatarColor ?? tpl?.color ?? AGENT_COLORS[0]);
  const [model, setModel] = useState(existing?.model ?? '');
  const [webSearch, setWebSearch] = useState(existing?.webSearch ?? true);
  const [replyMode, setReplyMode] = useState<AgentInfo['replyMode']>(existing?.replyMode ?? 'mentions');
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    GET<AgentSettings>('/api/agents/settings')
      .then((s) => {
        setSettings(s);
        // Claude: always a concrete model; other providers: '' means the workspace default
        if (s.provider === 'anthropic') setModel((m) => m || s.defaultModel || s.models[0]?.id || '');
      })
      .catch(() => {});
  }, []);

  const departments = useMemo(
    () => [
      ...new Set(
        Object.values(agents)
          .map((a) => a.department)
          .filter(Boolean),
      ),
    ],
    [agents],
  );
  const myChannels = useMemo(
    () =>
      Object.values(channels)
        .filter((c) => (c.kind === 'public' || c.kind === 'private') && memberships[c.id] && !c.archived)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [channels, memberships],
  );

  const isClaude = !settings || settings.provider === 'anthropic';
  const webSearchSupported = settings?.providers?.find((p) => p.id === settings.provider)?.supportsWebSearch ?? true;

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name,
        role,
        department,
        instructions,
        model: model.trim(),
        // web search is a Claude feature; with other providers the stored choice is left as it is
        ...(webSearchSupported ? { webSearch } : {}),
        replyMode,
        avatarEmoji: emoji,
        avatarColor: color,
      };
      if (userId) {
        const r = await PATCH<{ agent: AgentInfo; user: User }>(`/api/agents/${userId}`, body);
        set((s) => {
          s.agents[r.agent.userId] = r.agent;
          s.users[r.user.id] = r.user;
        });
        toast(t('Agent updated'));
        onClose();
      } else {
        const r = await POST<{ agent: AgentInfo; user: User }>('/api/agents', { ...body, channelIds });
        set((s) => {
          s.agents[r.agent.userId] = r.agent;
          s.users[r.user.id] = r.user;
        });
        onClose();
        toast(t('{name} joined the team', { name: r.user.fullName }));
        await openDm([r.user.id]);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={userId ? t('Edit agent') : t('New AI agent')}
      subtitle={userId ? undefined : t('An agent is a teammate powered by AI. People can DM it, add it to channels and give it tasks.')}
      onClose={onClose}
      width={680}
      footer={
        <>
          {settings && !settings.configured && (
            <span className="modal-foot-hint">
              {t('No AI provider connected yet – the agent will reply once an admin sets one up.')}{' '}
              {isAdmin(me) && (
                <button className="link" onClick={() => openModal({ type: 'admin', tab: 'agents' })}>
                  {t('Set up AI')}
                </button>
              )}
            </span>
          )}
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !name.trim() || !role.trim()} onClick={() => void save()}>
            {userId ? t('Save changes') : t('Create agent')}
          </button>
        </>
      }
    >
      <div className="agent-form">
        <div className="agent-form-avatar">
          <span className="agent-avatar-preview" style={{ background: color }}>
            {emoji}
          </span>
          <div className="agent-emoji-grid">
            {AGENT_EMOJI.map((e) => (
              <button key={e} className={emoji === e ? 'active' : ''} onClick={() => setEmoji(e)}>
                {e}
              </button>
            ))}
          </div>
          <div className="agent-color-grid">
            {AGENT_COLORS.map((c) => (
              <button key={c} className={color === c ? 'active' : ''} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
            ))}
          </div>
        </div>
        <div className="agent-form-fields">
          <label className="field">
            <span className="field-label">{t('Name')}</span>
            <input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. Mia Marketing')} />
          </label>
          <div className="field-row">
            <label className="field">
              <span className="field-label">{t('Role')}</span>
              <input value={role} maxLength={120} onChange={(e) => setRole(e.target.value)} placeholder={t('e.g. Marketing specialist')} />
            </label>
            <label className="field">
              <span className="field-label">{t('Team / department')}</span>
              <input
                value={department}
                maxLength={80}
                list="agent-departments"
                onChange={(e) => setDepartment(e.target.value)}
                placeholder={t('e.g. Marketing')}
              />
              <datalist id="agent-departments">
                {departments.map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
            </label>
          </div>
        </div>
      </div>
      <label className="field">
        <span className="field-label">{t('Responsibilities, tasks and instructions')}</span>
        <textarea
          rows={8}
          value={instructions}
          maxLength={8000}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={t('What is this agent responsible for? What should it do, how should it write, whom should it ask for help?')}
        />
        <span className="field-help">
          {t('Write it like a job description. The agent also knows who is in the workspace and can ask colleagues or other agents for help.')}
        </span>
      </label>
      <div className="field-row">
        <label className="field">
          <span className="field-label">{t('AI model')}</span>
          {isClaude ? (
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {settings?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input
                type="text"
                list="agent-models"
                spellCheck={false}
                maxLength={200}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={settings.defaultModel ? t('Workspace default ({model})', { model: settings.defaultModel }) : t('Workspace default')}
              />
              <datalist id="agent-models">
                {settings.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name !== m.id ? m.name : undefined}
                  </option>
                ))}
              </datalist>
            </>
          )}
          <span className="field-help">
            {isClaude ? settings?.models.find((m) => m.id === model)?.description : t('Leave empty to use the workspace default model.')}
          </span>
        </label>
        <div className="field">
          <span className="field-label">{t('When should it reply in channels?')}</span>
          <label className="radio">
            <input type="radio" checked={replyMode === 'mentions'} onChange={() => setReplyMode('mentions')} />
            {t('When @mentioned or in its threads')}
          </label>
          <label className="radio">
            <input type="radio" checked={replyMode === 'all'} onChange={() => setReplyMode('all')} />
            {t('To every message in its channels')}
          </label>
          <span className="field-help">{t('In direct messages it always replies.')}</span>
        </div>
      </div>
      {webSearchSupported && (
        <div className="field">
          <Toggle
            checked={webSearch}
            onChange={setWebSearch}
            label={
              <span className="inline-icon">
                <Globe size={14} /> {t('Can search the web')}
              </span>
            }
          />
        </div>
      )}
      {!userId && myChannels.length > 0 && (
        <div className="field">
          <span className="field-label">{t('Add to channels')}</span>
          <div className="agent-channel-picks">
            {myChannels.map((c) => (
              <label key={c.id} className={`chip${channelIds.includes(c.id) ? ' active' : ''}`}>
                <input
                  type="checkbox"
                  hidden
                  checked={channelIds.includes(c.id)}
                  onChange={(e) => setChannelIds((l) => (e.target.checked ? [...l, c.id] : l.filter((x) => x !== c.id)))}
                />
                {c.kind === 'private' ? <Lock size={12} /> : <Hash size={12} />} {c.name}
              </label>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
