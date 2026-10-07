import { Suspense, useState } from 'react';
import type { Invite, SidebarSection, Workspace } from '../../../shared/types.ts';
import { POST } from '../api.ts';
import { set, toast, useStore } from '../store.ts';
import { t } from '../i18n.ts';
import { fail } from '../actions.ts';
import { lazyNamed } from '../lib/lazy.ts';
import { useOnboarding } from '../lib/onboarding.ts';
import { ArrowLeft, ArrowRight, Bot, Check, Copy, Hash, Link2, Lock, Plus, Trash2, Upload, Users, X } from '../components/icons.tsx';
import { Spinner, Toggle } from '../components/ui.tsx';
import '../styles/onboarding.css';

const AIProviderSetup = lazyNamed(() => import('../components/AIProviderSetup.tsx'), 'AIProviderSetup');
const SlackImportPanel = lazyNamed(() => import('../components/SlackImport.tsx'), 'SlackImportPanel');


type StepId = 'welcome' | 'channels' | 'ai' | 'slack' | 'invite' | 'done';

interface DraftChannel {
  key: number;
  name: string;
  description: string;
  section: string;
  everyone: boolean;
  isPrivate: boolean;
}
interface DraftSection {
  name: string;
  emoji: string;
}
interface Template {
  id: string;
  title: string;
  description: string;
  sections: DraftSection[];
  channels: Omit<DraftChannel, 'key'>[];
}

let seq = 0;
const ch = (name: string, description: string, section = '', everyone = false, isPrivate = false): Omit<DraftChannel, 'key'> => ({ name, description, section, everyone, isPrivate });

function templates(): Template[] {
  const company = t('Company');
  const teams = t('Teams');
  const projects = t('Projects');
  const clients = t('Clients');
  return [
    {
      id: 'small',
      title: t('Small team'),
      description: t('A few channels for a team that works closely together.'),
      sections: [],
      channels: [
        ch('general', t('Company-wide announcements and work-based matters'), '', true),
        ch('random', t('Non-work banter and water cooler conversation'), '', true),
        ch(t('projects'), t('Everything about what we are working on')),
        ch(t('help'), t('Ask anything – someone will know')),
      ],
    },
    {
      id: 'departments',
      title: t('Company with departments'),
      description: t('A section for the whole company and a channel for every department.'),
      sections: [
        { name: company, emoji: '🏢' },
        { name: teams, emoji: '👥' },
        { name: projects, emoji: '🚀' },
      ],
      channels: [
        ch(t('announcements'), t('Important news for everyone'), company, true),
        ch('general', t('Company-wide announcements and work-based matters'), company, true),
        ch('random', t('Non-work banter and water cooler conversation'), company, true),
        ch('marketing', t('Campaigns, content and brand'), teams),
        ch(t('development'), t('Product and engineering'), teams),
        ch(t('sales'), t('Deals, leads and customers'), teams),
        ch(t('support'), t('Customer questions and issues'), teams),
        ch('hr', t('People matters – private'), teams, false, true),
        ch(t('projects'), t('Everything about what we are working on'), projects),
      ],
    },
    {
      id: 'agency',
      title: t('Agency or studio'),
      description: t('Internal channels plus a channel for each client.'),
      sections: [
        { name: company, emoji: '🏢' },
        { name: clients, emoji: '🤝' },
      ],
      channels: [
        ch('general', t('Company-wide announcements and work-based matters'), company, true),
        ch('random', t('Non-work banter and water cooler conversation'), company, true),
        ch('design', t('Design work and reviews'), company),
        ch(t('development'), t('Product and engineering'), company),
        ch(t('new-business'), t('Pitches and new leads'), company),
        ch(t('client-example'), t('Rename this to your first client'), clients),
      ],
    },
    {
      id: 'scratch',
      title: t('Start from scratch'),
      description: t('Just #general and #random – add the rest yourself.'),
      sections: [],
      channels: [ch('general', t('Company-wide announcements and work-based matters'), '', true), ch('random', t('Non-work banter and water cooler conversation'), '', true)],
    },
  ];
}

const EMOJI_CHOICES = ['🏢', '👥', '🚀', '🤝', '⭐', '💼', '💡', '⚙️', '📣', '🎨'];

function ChannelsStep({ onNext }: { onNext: () => void }) {
  const all = templates();
  const [tpl, setTpl] = useState('departments');
  const pick = (id: string) => {
    const x = all.find((y) => y.id === id)!;
    setTpl(id);
    setSections(x.sections);
    setChannels(x.channels.map((c) => ({ ...c, key: ++seq })));
  };
  const initial = all.find((x) => x.id === tpl)!;
  const [sections, setSections] = useState<DraftSection[]>(initial.sections);
  const [channels, setChannels] = useState<DraftChannel[]>(() => initial.channels.map((c) => ({ ...c, key: ++seq })));
  const [newSection, setNewSection] = useState('');
  const [busy, setBusy] = useState(false);

  const update = (key: number, patch: Partial<DraftChannel>) => setChannels((list) => list.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const addSection = () => {
    const name = newSection.trim();
    if (!name || sections.some((s) => s.name.toLowerCase() === name.toLowerCase())) return;
    setSections([...sections, { name, emoji: EMOJI_CHOICES[sections.length % EMOJI_CHOICES.length] }]);
    setNewSection('');
  };
  const removeSection = (name: string) => {
    setSections(sections.filter((s) => s.name !== name));
    setChannels((list) => list.map((c) => (c.section === name ? { ...c, section: '' } : c)));
  };
  const save = async () => {
    const valid = channels.filter((c) => c.name.trim());
    setBusy(true);
    try {
      await POST<{ sections: SidebarSection[] }>('/api/onboarding/channels', {
        channels: valid.map((c) => ({ name: c.name, description: c.description || undefined, section: c.section || undefined, everyone: c.everyone, isPrivate: c.isPrivate })),
        sections,
      });
      onNext();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>{t('Channels and sections')}</h2>
      <p className="ob-lead">{t('Channels are where conversations happen – one per team, project or topic. Sections group them in everyone’s sidebar. Pick a starting point and adjust it; you can change everything later.')}</p>
      <div className="ob-templates" role="radiogroup" aria-label={t('Starting point')}>
        {all.map((x) => (
          <button key={x.id} role="radio" aria-checked={tpl === x.id} className={`ob-template${tpl === x.id ? ' active' : ''}`} onClick={() => pick(x.id)}>
            <b>{x.title}</b>
            <span>{x.description}</span>
          </button>
        ))}
      </div>

      <h3>{t('Sections')}</h3>
      <div className="ob-sections">
        {sections.map((s) => (
          <span key={s.name} className="ob-chip">
            <button
              className="ob-chip-emoji"
              title={t('Change icon')}
              onClick={() => setSections(sections.map((x) => (x.name === s.name ? { ...x, emoji: EMOJI_CHOICES[(EMOJI_CHOICES.indexOf(x.emoji) + 1) % EMOJI_CHOICES.length] } : x)))}
            >
              {s.emoji || '📁'}
            </button>
            {s.name}
            <button className="ob-chip-x" onClick={() => removeSection(s.name)} aria-label={t('Remove {name}', { name: s.name })}>
              <X size={13} />
            </button>
          </span>
        ))}
        <span className="ob-add-section">
          <input value={newSection} onChange={(e) => setNewSection(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addSection()} placeholder={t('New section…')} maxLength={60} />
          <button className="icon-btn" onClick={addSection} disabled={!newSection.trim()} aria-label={t('Add section')}>
            <Plus size={16} />
          </button>
        </span>
      </div>

      <h3>{t('Channels')}</h3>
      <div className="ob-channels">
        {channels.map((c) => (
          <div key={c.key} className="ob-channel">
            <span className="ob-channel-icon">{c.isPrivate ? <Lock size={16} /> : <Hash size={16} />}</span>
            <div className="ob-channel-main">
              <input className="ob-channel-name" value={c.name} onChange={(e) => update(c.key, { name: e.target.value })} placeholder={t('channel-name')} maxLength={80} aria-label={t('Channel name')} />
              <input className="ob-channel-desc" value={c.description} onChange={(e) => update(c.key, { description: e.target.value })} placeholder={t('What is it for? (optional)')} maxLength={250} aria-label={t('Description')} />
            </div>
            <select value={c.section} onChange={(e) => update(c.key, { section: e.target.value })} aria-label={t('Section')}>
              <option value="">{t('Channels')}</option>
              {sections.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
            <label className="ob-check" title={t('Everyone joins this channel, including people who join later')}>
              <Toggle checked={c.everyone && !c.isPrivate} disabled={c.isPrivate} onChange={(v) => update(c.key, { everyone: v })} ariaLabel={t('Everyone')} />
              <span>{t('Everyone')}</span>
            </label>
            <label className="ob-check" title={t('Only invited people can see it')}>
              <Toggle checked={c.isPrivate} disabled={c.name === 'general' || c.name === 'random'} onChange={(v) => update(c.key, { isPrivate: v, everyone: v ? false : c.everyone })} ariaLabel={t('Private')} />
              <span>{t('Private')}</span>
            </label>
            <button className="icon-btn" onClick={() => setChannels(channels.filter((x) => x.key !== c.key))} disabled={c.name === 'general'} aria-label={t('Remove {name}', { name: c.name || t('channel') })}>
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        <button className="btn ob-add-channel" onClick={() => setChannels([...channels, { key: ++seq, name: '', description: '', section: sections[0]?.name ?? '', everyone: false, isPrivate: false }])}>
          <Plus size={15} /> {t('Add a channel')}
        </button>
      </div>
      <StepFooter>
        <button className="btn primary big" onClick={() => void save()} disabled={busy}>
          {busy ? <Spinner size={16} /> : null} {t('Create channels')} <ArrowRight size={16} />
        </button>
      </StepFooter>
    </>
  );
}

function InviteStep() {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const inv = await POST<Invite>('/api/invites', { role: 'member', maxUses: null });
      setUrl(`${location.origin}/invite/${inv.code}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const copy = () => {
    void navigator.clipboard?.writeText(url);
    toast(t('Link copied to clipboard'));
  };
  return (
    <>
      <h2>{t('Invite your team')}</h2>
      <p className="ob-lead">{t('Relay doesn’t send e-mails, so you share an invite link yourself – in an e-mail, on Slack, anywhere. Everyone who opens it can create an account and lands in the channels marked “Everyone”.')}</p>
      <div className="ob-card">
        {url ? (
          <div className="invite-link">
            <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label={t('Invite link')} />
            <button className="btn primary" onClick={copy}>
              <Copy size={14} /> {t('Copy')}
            </button>
          </div>
        ) : (
          <button className="btn primary big" onClick={() => void create()} disabled={busy}>
            <Link2 size={16} /> {t('Create invite link')}
          </button>
        )}
        <p className="field-help">{t('The link works for 30 days and can be used many times. Colleagues imported from Slack get their history back by signing up with the same e-mail address.')}</p>
      </div>
    </>
  );
}

function StepFooter({ children }: { children?: React.ReactNode }) {
  return <div className="ob-footer">{children}</div>;
}

export function Onboarding() {
  const ws = useStore((s) => s.workspace);
  const me = useStore((s) => s.me);
  const [step, setStep] = useState<StepId>('welcome');
  const steps: { id: StepId; label: string; icon: React.ReactNode }[] = [
    { id: 'welcome', label: t('Welcome'), icon: <Check size={16} /> },
    { id: 'channels', label: t('Channels and sections'), icon: <Hash size={16} /> },
    { id: 'ai', label: t('AI teammates'), icon: <Bot size={16} /> },
    { id: 'slack', label: t('Import from Slack'), icon: <Upload size={16} /> },
    { id: 'invite', label: t('Invite your team'), icon: <Users size={16} /> },
  ];
  const index = steps.findIndex((s) => s.id === step);
  const next = () => setStep(index >= 0 && index < steps.length - 1 ? steps[index + 1].id : 'done');
  const back = () => index > 0 && setStep(steps[index - 1].id);

  const finish = async () => {
    try {
      const w = await POST<Workspace>('/api/onboarding/complete');
      set((s) => void (s.workspace = w));
    } catch (e) {
      fail(e);
    }
    useOnboarding.setState({ open: false });
  };

  return (
    <div className="onboarding" role="dialog" aria-modal="true" aria-label={t('Set up {name}', { name: ws?.name ?? 'Relay' })}>
      <aside className="ob-rail">
        <div className="ob-brand">
          <img src="/favicon.svg" alt="" width={32} height={32} />
          <span>{ws?.name}</span>
        </div>
        <ol className="ob-steps">
          {steps.map((s, i) => (
            <li key={s.id}>
              <button className={`ob-step${s.id === step ? ' active' : ''}${i < index || step === 'done' ? ' done' : ''}`} onClick={() => setStep(s.id)}>
                <span className="ob-step-icon">{i < index || step === 'done' ? <Check size={15} /> : s.icon}</span>
                {s.label}
              </button>
            </li>
          ))}
        </ol>
        <button className="btn ob-skip" onClick={() => void finish()}>
          {t('Skip setup')}
        </button>
      </aside>
      <main className="ob-main">
        <div className="ob-content">
          {step === 'welcome' && (
            <>
              <h1>{t('Welcome to Relay, {name}!', { name: me?.displayName || me?.fullName.split(' ')[0] || '' })}</h1>
              <p className="ob-lead">{t('Let’s get {workspace} ready for your team. It takes about five minutes and every step can be skipped or changed later in the workspace settings.', { workspace: ws?.name ?? '' })}</p>
              <ul className="ob-list">
                <li>
                  <Hash size={18} /> {t('Create channels for your teams and projects, grouped into sections')}
                </li>
                <li>
                  <Bot size={18} /> {t('Connect an AI provider so you can add AI teammates')}
                </li>
                <li>
                  <Upload size={18} /> {t('Bring over your Slack history – channels, messages, threads and files')}
                </li>
                <li>
                  <Users size={18} /> {t('Invite your colleagues')}
                </li>
              </ul>
              <StepFooter>
                <button className="btn primary big" onClick={next}>
                  {t('Let’s start')} <ArrowRight size={16} />
                </button>
              </StepFooter>
            </>
          )}
          {step === 'channels' && <ChannelsStep onNext={next} />}
          {step === 'ai' && (
            <>
              <h2>{t('AI teammates')}</h2>
              <p className="ob-lead">{t('AI agents work like colleagues: you DM them, add them to channels and give them tasks. Choose which AI provider powers them – you pay the provider directly for what the agents use. You can skip this and do it later.')}</p>
              <Suspense fallback={<Spinner size={24} />}>
                <AIProviderSetup onSaved={() => toast(t('AI provider saved'))} />
              </Suspense>
            </>
          )}
          {step === 'slack' && (
            <>
              <h2>{t('Import from Slack')}</h2>
              <p className="ob-lead">{t('Moving from Slack? Import an export of your Slack workspace and your channels, messages, threads, reactions and files will be here, with the original dates. Not using Slack? Just skip this step.')}</p>
              <Suspense fallback={<Spinner size={24} />}>
                <SlackImportPanel />
              </Suspense>
            </>
          )}
          {step === 'invite' && <InviteStep />}
          {step === 'done' && (
            <>
              <div className="ob-done-icon">
                <Check size={36} />
              </div>
              <h1>{t('You’re all set!')}</h1>
              <p className="ob-lead">{t('Your workspace is ready. You can come back to this guide any time from the workspace menu.')}</p>
              <StepFooter>
                <button className="btn primary big" onClick={() => void finish()}>
                  {t('Open {name}', { name: ws?.name ?? 'Relay' })} <ArrowRight size={16} />
                </button>
              </StepFooter>
            </>
          )}
          {step !== 'welcome' && step !== 'done' && step !== 'channels' && (
            <StepFooter>
              <button className="btn primary big" onClick={next}>
                {t('Continue')} <ArrowRight size={16} />
              </button>
            </StepFooter>
          )}
          {index > 0 && (
            <button className="btn ob-back" onClick={back}>
              <ArrowLeft size={15} /> {t('Back')}
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
