import { useEffect, useRef, useState } from 'react';
import { Bot, Copy, FileImport, Link2, Trash2, Upload, Users, Settings, Smile, Plug, Ticket, Unplug } from '../components/icons.tsx';
import type { Channel, CustomEmoji, Invite, User, Webhook, Workspace } from '../../../shared/types.ts';
import { DEL, GET, PATCH, POST, PUT, upload, assetUrl } from '../api.ts';
import { displayName, isAdmin, set, toast, useStore } from '../store.ts';
import { t } from '../i18n.ts';
import { confirmDialog, fail } from '../actions.ts';
import { formatShortDate } from '../lib/format.ts';
import { Avatar, Modal, Spinner } from '../components/ui.tsx';
import { WorkspaceIcon } from '../components/AppNav.tsx';
import { SlackImportPanel } from '../components/SlackImport.tsx';
import { AIProviderSetup } from '../components/AIProviderSetup.tsx';

function inviteUrl(code: string) {
  return `${location.origin}/invite/${code}`;
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text);
  toast(t('Copied to clipboard'));
}

export function InviteModal({ onClose }: { onClose: () => void }) {
  const ws = useStore((s) => s.workspace);
  const admin = useStore((s) => isAdmin(s.me));
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<'member' | 'guest' | 'admin'>('member');
  const [links, setLinks] = useState<{ email: string | null; url: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const list = emails
        .split(/[\s,;]+/)
        .map((e) => e.trim())
        .filter(Boolean);
      const out: { email: string | null; url: string }[] = [];
      if (!list.length) {
        const inv = await POST<Invite>('/api/invites', { role, maxUses: null });
        out.push({ email: null, url: inviteUrl(inv.code) });
      } else {
        for (const email of list) {
          const inv = await POST<Invite>('/api/invites', { email, role });
          out.push({ email, url: inviteUrl(inv.code) });
        }
      }
      setLinks(out);
      setEmails('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('Invite people to {name}', { name: ws?.name ?? '' })} onClose={onClose} width={560}>
      <label className="field">
        <span className="field-label">{t('To:')}</span>
        <textarea rows={3} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder={t('name@example.com, name@example.com (optional)')} />
        <span className="field-help">{t('Leave empty to create a reusable invite link valid for 30 days. Personal links can be used once by the given email address.')}</span>
      </label>
      {admin && (
        <label className="field">
          <span className="field-label">{t('Invite as')}</span>
          <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            <option value="member">{t('Member')}</option>
            <option value="guest">{t('Guest (only invited channels)')}</option>
            <option value="admin">{t('Admin')}</option>
          </select>
        </label>
      )}
      <div className="modal-row-end">
        <button className="btn primary" onClick={() => void create()} disabled={busy}>
          <Link2 size={14} /> {emails.trim() ? t('Create invite links') : t('Create invite link')}
        </button>
      </div>
      {links.length > 0 && (
        <div className="invite-links">
          <p className="field-help">{t('Send these links to your coworkers (email, chat…). Self-hosted servers don’t send emails by default.')}</p>
          {links.map((l) => (
            <div key={l.url} className="invite-link">
              {l.email && <span className="invite-email">{l.email}</span>}
              <input readOnly value={l.url} onFocus={(e) => e.target.select()} />
              <button className="btn small" onClick={() => copy(l.url)}>
                <Copy size={13} /> {t('Copy')}
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function GeneralTab() {
  const ws = useStore((s) => s.workspace)!;
  const [name, setName] = useState(ws.name);
  const [domains, setDomains] = useState(ws.allowedDomains);
  const file = useRef<HTMLInputElement>(null);
  const save = async () => {
    try {
      const w = await PATCH<Workspace>('/api/workspace', { name, allowedDomains: domains });
      set((s) => void (s.workspace = w));
      toast(t('Saved'));
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div className="admin-section">
      <div className="admin-icon-row">
        <WorkspaceIcon size={72} />
        <div>
          <button className="btn" onClick={() => file.current?.click()}>
            <Upload size={14} /> {t('Upload workspace icon')}
          </button>
          <p className="field-help">{t('Square image, at least 132×132 px.')}</p>
        </div>
        <input
          ref={file}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const form = new FormData();
            form.append('file', f, f.name);
            try {
              const w = await upload<Workspace>('/api/workspace/icon', form, undefined, 'PUT').promise;
              set((s) => void (s.workspace = w));
            } catch (err) {
              fail(err);
            }
          }}
        />
      </div>
      <label className="field">
        <span className="field-label">{t('Workspace name')}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </label>
      <label className="field">
        <span className="field-label">{t('Allow sign up without invitation for email domains')}</span>
        <input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com, example.org" />
        <span className="field-help">{t('Anyone with an email address at these domains can create an account. Leave empty to require an invitation.')}</span>
      </label>
      <button className="btn primary" onClick={() => void save()}>
        {t('Save changes')}
      </button>
    </div>
  );
}

function MembersTab() {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const [q, setQ] = useState('');
  const list = Object.values(users)
    .filter((u) => !u.isBot && (!q || `${u.fullName} ${u.username} ${u.email ?? ''}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => Number(a.deactivated) - Number(b.deactivated) || displayName(a).localeCompare(displayName(b)));

  const update = async (u: User, body: Partial<{ role: string; deactivated: boolean }>) => {
    try {
      const r = await PATCH<User>(`/api/users/${u.id}`, body);
      set((s) => void (s.users[u.id] = r));
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="admin-section">
      <input className="admin-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search members')} />
      <table className="admin-table">
        <thead>
          <tr>
            <th>{t('Name')}</th>
            <th>{t('Email')}</th>
            <th>{t('Role')}</th>
            <th>{t('Status')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((u) => (
            <tr key={u.id} className={u.deactivated ? 'deactivated' : ''}>
              <td>
                <span className="admin-user">
                  <Avatar user={u} size={24} /> {u.fullName}
                  <span className="muted-text">@{u.username}</span>
                </span>
              </td>
              <td className="muted-text">{u.email}</td>
              <td>
                <select value={u.role} disabled={u.id === me.id || (u.role === 'owner' && me.role !== 'owner')} onChange={(e) => void update(u, { role: e.target.value })}>
                  {me.role === 'owner' && <option value="owner">{t('Owner')}</option>}
                  {u.role === 'owner' && me.role !== 'owner' && <option value="owner">{t('Owner')}</option>}
                  <option value="admin">{t('Admin')}</option>
                  <option value="member">{t('Member')}</option>
                  <option value="guest">{t('Guest')}</option>
                </select>
              </td>
              <td title={u.imported ? t('Imported from Slack. Send a personal invite to this e-mail address so they can claim the account.') : undefined}>
                {u.deactivated ? t('Deactivated') : u.imported ? t('Not joined yet') : t('Active')}
              </td>
              <td>
                {u.id !== me.id && !(u.role === 'owner' && me.role !== 'owner') && (
                  <button
                    className={`btn small${u.deactivated ? '' : ' danger'}`}
                    onClick={() =>
                      u.deactivated
                        ? void update(u, { deactivated: false })
                        : confirmDialog({
                            title: t('Deactivate {name}?', { name: u.fullName }),
                            body: t('They will be signed out everywhere and can no longer sign in. Their messages stay.'),
                            danger: true,
                            confirmLabel: t('Deactivate'),
                            onConfirm: () => update(u, { deactivated: true }),
                          })
                    }
                  >
                    {u.deactivated ? t('Reactivate') : t('Deactivate')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvitesTab() {
  const [list, setList] = useState<Invite[] | null>(null);
  const users = useStore((s) => s.users);
  const load = () => GET<Invite[]>('/api/invites').then(setList).catch(fail);
  useEffect(() => void load(), []);
  if (!list) return <Spinner />;
  return (
    <div className="admin-section">
      <table className="admin-table">
        <thead>
          <tr>
            <th>{t('Link')}</th>
            <th>{t('Email')}</th>
            <th>{t('Role')}</th>
            <th>{t('Used')}</th>
            <th>{t('Expires')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((i) => {
            const expired = (i.expiresAt && i.expiresAt < Date.now()) || (i.maxUses && i.uses >= i.maxUses);
            return (
              <tr key={i.code} className={expired ? 'deactivated' : ''}>
                <td>
                  <button className="link" onClick={() => copy(inviteUrl(i.code))} title={t('Copy link')}>
                    <Copy size={12} /> …{i.code.slice(-6)}
                  </button>
                  <div className="muted-text small">{t('by {name}', { name: displayName(users[i.createdBy]) })}</div>
                </td>
                <td>{i.email ?? '—'}</td>
                <td>{t(i.role)}</td>
                <td>
                  {i.uses}
                  {i.maxUses ? ` / ${i.maxUses}` : ''}
                </td>
                <td>{i.expiresAt ? formatShortDate(i.expiresAt) : '—'}</td>
                <td>
                  <button
                    className="icon-btn small"
                    title={t('Revoke')}
                    onClick={async () => {
                      await DEL(`/api/invites/${i.code}`).catch(fail);
                      void load();
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            );
          })}
          {!list.length && (
            <tr>
              <td colSpan={6} className="muted-text">
                {t('No invites yet.')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function EmojiTab() {
  const list = useStore((s) => s.customEmojiList);
  const me = useStore((s) => s.me)!;
  const users = useStore((s) => s.users);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const add = async () => {
    if (!file || !name) return;
    const form = new FormData();
    form.append('name', name);
    form.append('file', file, file.name);
    try {
      const l = await upload<CustomEmoji[]>('/api/emoji', form).promise;
      set((s) => {
        s.customEmojiList = l;
        s.customEmoji = Object.fromEntries(l.map((e) => [e.name, e.url]));
      });
      setName('');
      setFile(null);
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div className="admin-section">
      <p className="field-help">{t('Add custom emoji that anyone in the workspace can use. Square images under 128 KB work best.')}</p>
      <div className="emoji-add">
        <button className="btn" onClick={() => input.current?.click()}>
          <Upload size={14} /> {file ? file.name : t('Choose image')}
        </button>
        <div className="input-prefix">
          :
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_+-]/g, ''))} placeholder="party-parrot" />:
        </div>
        <button className="btn primary" disabled={!file || !name} onClick={() => void add()}>
          {t('Save')}
        </button>
        <input ref={input} type="file" hidden accept="image/png,image/gif,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <div className="emoji-list">
        {list.map((e) => (
          <div key={e.name} className="emoji-list-item">
            <img src={assetUrl(e.url)} alt="" />
            <span>:{e.name}:</span>
            <span className="muted-text">{displayName(users[e.createdBy])}</span>
            {(e.createdBy === me.id || isAdmin(me)) && (
              <button
                className="icon-btn small"
                onClick={async () => {
                  try {
                    const l = await DEL<CustomEmoji[]>(`/api/emoji/${encodeURIComponent(e.name)}`);
                    set((s) => {
                      s.customEmojiList = l;
                      s.customEmoji = Object.fromEntries(l.map((x) => [x.name, x.url]));
                    });
                  } catch (err) {
                    fail(err);
                  }
                }}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function IntegrationsTab() {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [name, setName] = useState('');
  const [channelId, setChannelId] = useState('');
  const load = () => GET<Webhook[]>('/api/webhooks').then(setHooks).catch(fail);
  useEffect(() => {
    void load();
    GET<Channel[]>('/api/channels').then((l) => {
      setChannels(l.filter((c) => !c.archived));
      setChannelId(l[0]?.id ?? '');
    });
  }, []);
  const fullUrl = (u: string) => (u.startsWith('http') ? u : `${location.origin}${u}`);
  return (
    <div className="admin-section">
      <h3>{t('Incoming webhooks')}</h3>
      <p className="field-help">
        {t('Post messages from other apps (CI, monitoring, forms…) by sending JSON to the webhook URL:')} <code>{'{"text": "Hello", "username": "Bot"}'}</code>
      </p>
      <div className="emoji-add">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Name, e.g. GitHub')} />
        <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
        <button
          className="btn primary"
          disabled={!name || !channelId}
          onClick={async () => {
            try {
              await POST('/api/webhooks', { name, channelId });
              setName('');
              void load();
            } catch (e) {
              fail(e);
            }
          }}
        >
          {t('Add webhook')}
        </button>
      </div>
      {hooks?.map((h) => (
        <div key={h.id} className="invite-link">
          <b>{h.name}</b>
          <span className="muted-text">#{channels.find((c) => c.id === h.channelId)?.name}</span>
          <input readOnly value={fullUrl(h.url)} onFocus={(e) => e.target.select()} />
          <button className="btn small" onClick={() => copy(fullUrl(h.url))}>
            <Copy size={13} />
          </button>
          <button
            className="icon-btn small"
            onClick={async () => {
              await DEL(`/api/webhooks/${h.id}`).catch(fail);
              void load();
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function AdminModal({ tab: initial = 'general', onClose }: { tab?: string; onClose: () => void }) {
  const admin = useStore((s) => isAdmin(s.me));
  const [tab, setTab] = useState(admin ? initial : 'emoji');
  const tabs: [string, string, React.ReactNode, boolean][] = [
    ['general', t('General'), <Settings size={16} />, admin],
    ['members', t('Members'), <Users size={16} />, admin],
    ['invites', t('Invitations'), <Ticket size={16} />, admin],
    ['emoji', t('Custom emoji'), <Smile size={16} />, true],
    ['integrations', t('Integrations'), <Plug size={16} />, admin],
    ['agents', t('AI agents'), <Bot size={16} />, admin],
    ['slack', t('Slack bridge'), <Unplug size={16} />, admin],
    ['import', t('Import from Slack'), <FileImport size={16} />, admin],
  ];
  return (
    <Modal title={admin ? t('Workspace settings') : t('Customize workspace')} onClose={onClose} width={900} className="prefs-modal" bodyClassName="prefs-body">
      <nav className="prefs-nav">
        {tabs
          .filter((x) => x[3])
          .map(([k, label, icon]) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              {icon} {label}
            </button>
          ))}
      </nav>
      <div className="prefs-content">
        {tab === 'general' && admin && <GeneralTab />}
        {tab === 'members' && admin && <MembersTab />}
        {tab === 'invites' && admin && <InvitesTab />}
        {tab === 'emoji' && <EmojiTab />}
        {tab === 'integrations' && admin && <IntegrationsTab />}
        {tab === 'slack' && admin && <SlackTab />}
        {tab === 'agents' && admin && <AgentsTab />}
        {tab === 'import' && admin && (
          <div className="admin-section">
            <h3>{t('Import from Slack')}</h3>
            <p className="field-help">{t('Bring over your Slack history: people, channels, messages, threads, reactions and files. People keep their history when they join with the same e-mail address.')}</p>
            <SlackImportPanel />
          </div>
        )}
      </div>
    </Modal>
  );
}

interface SlackState {
  enabled: boolean;
  connected: boolean;
  team: string | null;
  teamUrl: string | null;
  error: string | null;
  botTokenSet: boolean;
  appTokenSet: boolean;
  fromEnv: boolean;
  links: { relayChannelId: string; slackChannelId: string; slackChannelName: string }[];
  manifest: string;
}

function SlackTab() {
  const [st, setSt] = useState<SlackState | null>(null);
  const [bot, setBot] = useState('');
  const [appTok, setAppTok] = useState('');
  const [busy, setBusy] = useState(false);
  const [slackChannels, setSlackChannels] = useState<{ id: string; name: string; isPrivate: boolean; isMember: boolean }[]>([]);
  const [relayChannels, setRelayChannels] = useState<Channel[]>([]);
  const [relayId, setRelayId] = useState('');
  const [slackId, setSlackId] = useState('');
  const [history, setHistory] = useState(50);

  const load = async () => {
    try {
      const s = await GET<SlackState>('/api/slack');
      setSt(s);
      if (s.connected) {
        GET<typeof slackChannels>('/api/slack/channels').then(setSlackChannels).catch(fail);
        GET<Channel[]>('/api/channels').then((l) => setRelayChannels(l.filter((c) => !c.archived)));
      }
    } catch (e) {
      fail(e);
    }
  };
  useEffect(() => void load(), []);
  if (!st) return <Spinner />;

  const linkedRelay = new Set(st.links.map((l) => l.relayChannelId));
  const linkedSlack = new Set(st.links.map((l) => l.slackChannelId));

  return (
    <div className="admin-section">
      <h3>{t('Slack bridge')}</h3>
      <p className="field-help">
        {t('Connect channels with an existing Slack workspace. People in Slack keep using Slack, you use Relay – messages, threads, reactions and files are mirrored both ways. Free: it uses a custom Slack app (also works on the free Slack plan).')}
      </p>
      <div className={`slack-status ${st.connected ? 'ok' : st.enabled ? 'warn' : ''}`}>
        <span className={`presence-dot ${st.connected ? 'online' : 'away'}`} />
        {st.connected ? t('Connected to {team}', { team: st.team ?? 'Slack' }) : st.enabled ? t('Connecting…') : t('Not connected')}
        {st.error && <span className="field-error"> – {st.error}</span>}
      </div>

      {!st.connected && (
        <details className="slack-setup" open={!st.botTokenSet}>
          <summary>{t('How to connect (5 minutes)')}</summary>
          <ol>
            <li>
              {t('Open')} <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer">api.slack.com/apps</a> → <b>Create New App</b> → <b>From a manifest</b>, {t('choose the Slack workspace and paste this manifest:')}
              <textarea readOnly rows={8} className="mono" value={st.manifest} onFocus={(e) => e.target.select()} />
              <button className="btn small" onClick={() => copy(st.manifest)}>
                <Copy size={13} /> {t('Copy manifest')}
              </button>
            </li>
            <li>
              <b>Install App</b> → {t('install it to the workspace (a Slack admin may need to approve it), then copy the')} <b>Bot User OAuth Token</b> (xoxb-…).
            </li>
            <li>
              <b>Basic Information → App-Level Tokens</b> → <b>Generate Token</b> {t('with scope')} <code>connections:write</code> {t('and copy it')} (xapp-…).
            </li>
            <li>{t('Paste both tokens below.')}</li>
          </ol>
        </details>
      )}

      {st.fromEnv ? (
        <p className="field-help">{t('Tokens are configured via environment variables (SLACK_BOT_TOKEN, SLACK_APP_TOKEN).')}</p>
      ) : (
        <div className="slack-tokens">
          <input placeholder={st.botTokenSet ? 'xoxb-•••••••• (' + t('saved') + ')' : 'xoxb-…'} value={bot} onChange={(e) => setBot(e.target.value)} />
          <input placeholder={st.appTokenSet ? 'xapp-•••••••• (' + t('saved') + ')' : 'xapp-…'} value={appTok} onChange={(e) => setAppTok(e.target.value)} />
          <button
            className="btn primary"
            disabled={busy || !bot.startsWith('xoxb-') || !appTok.startsWith('xapp-')}
            onClick={async () => {
              setBusy(true);
              try {
                await PUT('/api/slack/tokens', { botToken: bot.trim(), appToken: appTok.trim() });
                setBot('');
                setAppTok('');
                await load();
              } catch (e) {
                fail(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('Connect')}
          </button>
          {st.botTokenSet && (
            <button
              className="btn danger"
              onClick={async () => {
                await DEL('/api/slack/tokens').catch(fail);
                await load();
              }}
            >
              {t('Disconnect')}
            </button>
          )}
        </div>
      )}

      {st.connected && (
        <>
          <h3>{t('Linked channels')}</h3>
          {st.links.map((l) => {
            const rc = relayChannels.find((c) => c.id === l.relayChannelId);
            return (
              <div key={l.relayChannelId} className="slack-link">
                <b>#{rc?.name ?? l.relayChannelId}</b>
                <span className="muted-text">⇄</span>
                <span className="slack-badge">Slack</span> <b>#{l.slackChannelName}</b>
                <button
                  className="icon-btn small"
                  title={t('Unlink')}
                  onClick={async () => {
                    await DEL(`/api/slack/links/${l.relayChannelId}`).catch(fail);
                    await load();
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
          {!st.links.length && <p className="muted-text">{t('No channels linked yet.')}</p>}
          <div className="emoji-add">
            <select value={relayId} onChange={(e) => setRelayId(e.target.value)}>
              <option value="">{t('Relay channel…')}</option>
              {relayChannels
                .filter((c) => !linkedRelay.has(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
            </select>
            <span>⇄</span>
            <select value={slackId} onChange={(e) => setSlackId(e.target.value)}>
              <option value="">{t('Slack channel…')}</option>
              {slackChannels
                .filter((c) => !linkedSlack.has(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id} disabled={c.isPrivate && !c.isMember}>
                    {c.isPrivate ? '🔒' : '#'}
                    {c.name}
                    {c.isPrivate && !c.isMember ? ` (${t('invite @Relay first')})` : ''}
                  </option>
                ))}
            </select>
            <select value={history} onChange={(e) => setHistory(Number(e.target.value))} title={t('Import history')}>
              <option value={0}>{t('No history')}</option>
              <option value={50}>{t('Last 50 messages')}</option>
              <option value={200}>{t('Last 200 messages')}</option>
              <option value={500}>{t('Last 500 messages')}</option>
            </select>
            <button
              className="btn primary"
              disabled={!relayId || !slackId || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await POST('/api/slack/links', { relayChannelId: relayId, slackChannelId: slackId, importHistory: history });
                  setRelayId('');
                  setSlackId('');
                  await load();
                  toast(t('Channels linked'));
                } catch (e) {
                  fail(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('Link')}
            </button>
          </div>
          <p className="field-help">
            {t('Tip: set PUBLIC_URL so your profile photos show up in Slack. People in Slack can mention you by typing @username.')}
          </p>
        </>
      )}
    </div>
  );
}

function AgentsTab() {
  return (
    <div className="admin-section">
      <h3>{t('AI agents')}</h3>
      <p className="field-help">
        {t('Choose the AI provider that powers your agents. You pay the provider only for what agents actually use; keys are stored on your server only.')}
      </p>
      <AIProviderSetup />
    </div>
  );
}
