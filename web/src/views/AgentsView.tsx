import { useEffect, useMemo, useState } from 'react';
import { Bot, KeyRound, MessageSquare, Pencil, Plus, Search, Trash2 } from '../components/icons.tsx';
import type { AgentSettings } from '../../../shared/types.ts';
import { DEL, GET } from '../api.ts';
import { displayName, isAdmin, useStore } from '../store.ts';
import { t, tp } from '../i18n.ts';
import { confirmDialog, fail, openDm, openModal } from '../actions.ts';
import { agentTemplates } from '../lib/agentTemplates.ts';
import { Avatar } from '../components/ui.tsx';

export function AgentsView() {
  const agents = useStore((s) => s.agents);
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const me = useStore((s) => s.me);
  const [q, setQ] = useState('');
  const [settings, setSettings] = useState<AgentSettings | null>(null);

  useEffect(() => {
    GET<AgentSettings>('/api/agents/settings').then(setSettings).catch(() => {});
  }, []);

  const active = useMemo(
    () =>
      Object.values(agents)
        .filter((a) => users[a.userId] && !users[a.userId].deactivated)
        .filter((a) => !q || `${users[a.userId]?.fullName} ${a.role} ${a.department}`.toLowerCase().includes(q.toLowerCase())),
    [agents, users, q],
  );

  // agents grouped into teams by department
  const teams = useMemo(() => {
    const map = new Map<string, typeof active>();
    for (const a of active) {
      const key = a.department || t('No team');
      map.set(key, [...(map.get(key) ?? []), a]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [active]);

  const channelCount = (userId: string) => Object.values(channels).filter((c) => c.memberIds?.includes(userId)).length;
  const modelName = (id: string) => (id ? (settings?.models.find((m) => m.id === id)?.name ?? id) : t('Workspace default'));

  return (
    <main className="main-view">
      <div className="view-header">
        <h2>
          <Bot size={18} /> {t('AI agents')}
        </h2>
        <button className="btn small primary view-header-action" onClick={() => openModal({ type: 'agent' })}>
          <Plus size={14} /> {t('New agent')}
        </button>
      </div>
      <div className="view-body agents-view">
        {settings && !settings.configured && (
          <div className="agents-banner warn">
            <KeyRound size={20} />
            <div>
              <b>{t('Connect an AI model')}</b>
              <p>
                {isAdmin(me)
                  ? t('Agents need an AI provider to think and reply – Anthropic Claude, OpenAI, Google Gemini, a local model and more. Set it up once for the whole workspace.')
                  : t('Agents need an AI provider. Ask a workspace admin to set one up in Workspace settings → AI agents.')}
              </p>
            </div>
            {isAdmin(me) && (
              <button className="btn small primary" onClick={() => openModal({ type: 'admin', tab: 'agents' })}>
                {t('Set up AI')}
              </button>
            )}
          </div>
        )}
        <div className="agents-hero">
          <div>
            <h3>{t('Put agents to work in your team')}</h3>
            <p>
              {t(
                'Agents are teammates powered by AI. Give them a name, a role and responsibilities – then DM them, invite them to channels, mention them with @ and give them tasks, just like a colleague. Build a team per department: Marketing, Development, Support…',
              )}
            </p>
          </div>
        </div>
        <h3 className="section-title">{t('Start from a template')}</h3>
        <div className="agent-templates">
          {agentTemplates().map((tpl) => (
            <button key={tpl.id} className="agent-template" onClick={() => openModal({ type: 'agent', template: tpl.id })}>
              <span className="agent-template-emoji" style={{ background: tpl.color }}>
                {tpl.emoji}
              </span>
              <b>{tpl.role}</b>
              <span className="muted-text">{tpl.department}</span>
            </button>
          ))}
        </div>

        <div className="agents-list-head">
          <h3 className="section-title">{tp(active.length, '{n} agent', '{n} agents')}</h3>
          <div className="browse-search">
            <Search size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search agents')} />
          </div>
        </div>
        {!active.length && <p className="muted-text">{t('No agents yet. Create one from a template or from scratch.')}</p>}
        {teams.map(([team, list]) => (
          <div key={team} className="agent-team">
            <div className="agent-team-name">{team}</div>
            {list.map((a) => {
              const u = users[a.userId];
              const canEdit = isAdmin(me) || a.createdBy === me?.id;
              return (
                <div key={a.userId} className="agent-row">
                  <Avatar userId={a.userId} size={40} />
                  <div className="agent-row-main">
                    <div>
                      <b>{displayName(u)}</b> <span className="agent-badge">{t('AGENT')}</span>
                    </div>
                    <div className="muted-text">
                      {a.role} · {tp(channelCount(a.userId), 'Active in {n} channel', 'Active in {n} channels')} · {modelName(a.model)}
                    </div>
                  </div>
                  <button className="btn small" onClick={() => void openDm([a.userId])}>
                    <MessageSquare size={14} /> {t('Message')}
                  </button>
                  {canEdit && (
                    <>
                      <button className="icon-btn small" title={t('Edit')} onClick={() => openModal({ type: 'agent', userId: a.userId })}>
                        <Pencil size={14} />
                      </button>
                      <button
                        className="icon-btn small"
                        title={t('Remove')}
                        onClick={() =>
                          confirmDialog({
                            title: t('Remove {name}?', { name: displayName(u) }),
                            body: t('The agent leaves all channels and stops replying. Its messages stay.'),
                            danger: true,
                            confirmLabel: t('Remove'),
                            onConfirm: async () => {
                              await DEL(`/api/agents/${a.userId}`).catch(fail);
                            },
                          })
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </main>
  );
}
