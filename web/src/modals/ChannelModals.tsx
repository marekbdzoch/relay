import { useEffect, useMemo, useState } from 'react';
import { Hash, Lock, Search, Archive, LogOut, Trash2, Bell, Star, UserMinus } from '../components/icons.tsx';
import type { Channel, Membership } from '../../../shared/types.ts';
import { DEL, PATCH, POST, GET } from '../api.ts';
import { channelTitle, displayName, isAdmin, isDmKind, toast, useStore, set } from '../store.ts';
import { t, tp } from '../i18n.ts';
import { fail, leaveChannel, openChannel, openDm, openModal, openProfile, setChannelPrefs, upsertChannel, confirmDialog } from '../actions.ts';
import { formatShortDate } from '../lib/format.ts';
import { navigate } from '../lib/nav.ts';
import { Avatar, Modal, Toggle, UserPresenceDot } from '../components/ui.tsx';
import { UserPicker } from './UserPicker.tsx';

export function normalizeName(v: string) {
  return v
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .slice(0, 80);
}

export function CreateChannelModal({ initialName = '', onClose }: { initialName?: string; onClose: () => void }) {
  const [step, setStep] = useState<'details' | 'members'>('details');
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Channel | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const meId = useStore((s) => s.me?.id);
  const exists = useStore((s) => Object.values(s.channels).some((c) => c.name === normalizeName(name) && !isDmKind(c)));

  const create = async () => {
    if (!normalizeName(name)) return;
    setBusy(true);
    try {
      const ch = await POST<Channel>('/api/channels', { name, description, isPrivate });
      upsertChannel(ch);
      setCreated(ch);
      setStep('members');
      openChannel(ch.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'members' && created) {
    return (
      <Modal title={t('Add people to #{name}', { name: created.name })} onClose={onClose} footer={
        <>
          <button className="btn" onClick={onClose}>{t('Skip for now')}</button>
          <button
            className="btn primary"
            disabled={!members.length || busy}
            onClick={async () => {
              setBusy(true);
              try {
                upsertChannel(await POST<Channel>(`/api/channels/${created.id}/members`, { userIds: members }));
                onClose();
              } catch (e) {
                fail(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('Add')}
          </button>
        </>
      }>
        <UserPicker value={members} onChange={setMembers} exclude={meId ? [meId] : []} />
      </Modal>
    );
  }

  return (
    <Modal
      title={t('Create a channel')}
      onClose={onClose}
      footer={
        <>
          <span className="modal-foot-hint">{isPrivate ? t('Only invited people can see a private channel.') : t('Anyone in the workspace can find and join.')}</span>
          <button className="btn primary" disabled={!normalizeName(name) || busy || exists} onClick={() => void create()}>
            {t('Create')}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">{t('Name')}</span>
        <div className="input-prefix">
          {isPrivate ? <Lock size={16} /> : <Hash size={16} />}
          <input autoFocus value={name} maxLength={80} onChange={(e) => setName(normalizeName(e.target.value))} placeholder={t('e.g. plan-budget')} onKeyDown={(e) => e.key === 'Enter' && void create()} />
          <span className="input-count">{80 - name.length}</span>
        </div>
        {exists && <span className="field-error">{t('That name is already taken by a channel.')}</span>}
        <span className="field-help">{t('Channels are where conversations happen around a topic. Use a name that is easy to find and understand.')}</span>
      </label>
      <label className="field">
        <span className="field-label">
          {t('Description')} <span className="optional">({t('optional')})</span>
        </span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('What is this channel about?')} />
      </label>
      <div className="field">
        <Toggle checked={isPrivate} onChange={setPrivate} label={<b>{t('Make private')}</b>} />
      </div>
    </Modal>
  );
}

export function ChannelDetailsModal({ channelId, tab: initialTab = 'about', onClose }: { channelId: string; tab?: 'about' | 'members' | 'settings'; onClose: () => void }) {
  const channel = useStore((s) => s.channels[channelId]);
  const membership = useStore((s) => s.memberships[channelId]);
  const me = useStore((s) => s.me);
  const users = useStore((s) => s.users);
  const presence = useStore((s) => s.presence);
  const [tab, setTab] = useState(initialTab);
  const [editing, setEditing] = useState<'name' | 'topic' | 'description' | null>(null);
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>(channel?.memberIds ?? []);

  useEffect(() => {
    if (tab === 'members') GET<string[]>(`/api/channels/${channelId}/members`).then(setMemberIds).catch(fail);
  }, [tab, channelId, channel?.memberCount]);

  const filteredMembers = useMemo(
    () =>
      memberIds
        .map((id) => users[id])
        .filter(Boolean)
        .filter((u) => !q || `${u.fullName} ${u.displayName} ${u.username}`.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => (presence[b.id] === 'active' ? 1 : 0) - (presence[a.id] === 'active' ? 1 : 0) || displayName(a).localeCompare(displayName(b))),
    [memberIds, users, q, presence],
  );

  if (!channel) return null;
  const isDm = isDmKind(channel);
  const canManage = isAdmin(me) || channel.createdBy === me?.id;
  const creator = channel.createdBy ? users[channel.createdBy] : undefined;

  const save = async (field: 'name' | 'topic' | 'description') => {
    try {
      upsertChannel(await PATCH<Channel>(`/api/channels/${channelId}`, { [field]: draft }));
      setEditing(null);
    } catch (e) {
      fail(e);
    }
  };

  const editField = (field: 'name' | 'topic' | 'description', label: string, value: string, empty: string, allowed = true) => (
    <div className="detail-block">
      <div className="detail-head">
        <b>{label}</b>
        {allowed && membership && editing !== field && (
          <button
            className="link"
            onClick={() => {
              setDraft(value);
              setEditing(field);
            }}
          >
            {t('Edit')}
          </button>
        )}
      </div>
      {editing === field ? (
        <div className="detail-edit">
          {field === 'name' ? (
            <input autoFocus value={draft} onChange={(e) => setDraft(normalizeName(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && void save(field)} />
          ) : (
            <textarea autoFocus rows={3} value={draft} maxLength={250} onChange={(e) => setDraft(e.target.value)} />
          )}
          <div className="detail-edit-actions">
            <button className="btn" onClick={() => setEditing(null)}>
              {t('Cancel')}
            </button>
            <button className="btn primary" onClick={() => void save(field)}>
              {t('Save')}
            </button>
          </div>
        </div>
      ) : (
        <div className={value ? '' : 'muted-text'}>{field === 'name' ? `#${value}` : value || empty}</div>
      )}
    </div>
  );

  return (
    <Modal
      className="channel-details"
      width={620}
      onClose={onClose}
      title={
        <span className="cd-title">
          {isDm ? null : channel.kind === 'private' ? <Lock size={20} /> : <Hash size={20} />}
          {channelTitle(channel)}
        </span>
      }
    >
      {membership && (
        <div className="cd-quick">
          <button className={`btn${membership.starred ? ' on' : ''}`} onClick={() => void setChannelPrefs(channelId, { starred: !membership.starred })}>
            <Star size={14} /> {membership.starred ? t('Starred') : t('Star')}
          </button>
          <button className="btn" onClick={() => setTab('settings')}>
            <Bell size={14} /> {membership.muted ? t('Muted') : membership.notify === 'default' ? t('Notifications') : membership.notify === 'all' ? t('All new messages') : membership.notify === 'mentions' ? t('Mentions') : t('Nothing')}
          </button>
        </div>
      )}
      <div className="modal-tabs">
        <button className={tab === 'about' ? 'active' : ''} onClick={() => setTab('about')}>
          {t('About')}
        </button>
        <button className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>
          {t('Members')} <span className="ch-tab-count">{channel.memberCount}</span>
        </button>
        {membership && (
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            {t('Settings')}
          </button>
        )}
      </div>
      {tab === 'about' && (
        <div className="cd-about">
          {!isDm && editField('name', t('Channel name'), channel.name, '', canManage)}
          {editField('topic', t('Topic'), channel.topic, t('Add a topic'))}
          {!isDm && editField('description', t('Description'), channel.description, t('Add a description'))}
          {!isDm && (
            <div className="detail-block">
              <b>{t('Created by')}</b>
              <div>
                {creator ? displayName(creator) : t('Unknown')} {t('on')} {formatShortDate(channel.createdAt)}
              </div>
            </div>
          )}
          {!isDm && (
            <div className="detail-block">
              <b>{t('Channel ID')}</b>
              <div className="muted-text mono">{channel.id}</div>
            </div>
          )}
          {membership && !isDm && !(channel.isDefault && channel.name === 'general') && (
            <div className="detail-block">
              <button
                className="link danger"
                onClick={() => {
                  onClose();
                  leaveChannel(channelId);
                }}
              >
                {t('Leave channel')}
              </button>
            </div>
          )}
        </div>
      )}
      {tab === 'members' && (
        <div className="cd-members">
          <div className="browse-search">
            <Search size={16} />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Find members')} />
          </div>
          {!isDm && membership && !channel.archived && (
            <button className="cd-member add" onClick={() => openModal({ type: 'addMembers', channelId })}>
              <span className="cd-add-icon">+</span> {t('Add people')}
            </button>
          )}
          {filteredMembers.map((u) => (
            <div key={u.id} className="cd-member" onClick={() => (onClose(), openProfile(u.id))}>
              <Avatar user={u} size={36} />
              <span className="cd-member-name">
                {displayName(u)}
                {u.id === me?.id && <span className="muted-text"> ({t('you')})</span>}
                {u.id === channel.createdBy && !isDm && <span className="muted-text"> · {t('Channel Manager')}</span>}
              </span>
              <UserPresenceDot userId={u.id} />
              {canManage && !isDm && u.id !== me?.id && !(channel.isDefault && channel.name === 'general') && (
                <button
                  className="icon-btn small cd-remove"
                  title={t('Remove from channel')}
                  onClick={(e) => {
                    e.stopPropagation();
                    confirmDialog({
                      title: t('Remove {name}?', { name: displayName(u) }),
                      body: t('They will no longer be able to see new messages in this channel.'),
                      danger: true,
                      confirmLabel: t('Remove'),
                      onConfirm: async () => {
                        await DEL(`/api/channels/${channelId}/members/${u.id}`).catch(fail);
                        setMemberIds((l) => l.filter((x) => x !== u.id));
                        openModal({ type: 'channelDetails', channelId, tab: 'members' });
                      },
                    });
                  }}
                >
                  <UserMinus size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {tab === 'settings' && membership && <ChannelSettings channel={channel} membership={membership} canManage={canManage} onClose={onClose} />}
    </Modal>
  );
}

function ChannelSettings({ channel, membership, canManage, onClose }: { channel: Channel; membership: Membership; canManage: boolean; onClose: () => void }) {
  const me = useStore((s) => s.me);
  const isDm = isDmKind(channel);
  return (
    <div className="cd-settings">
      <div className="detail-block">
        <b>{t('Notifications')}</b>
        {(['default', 'all', 'mentions', 'none'] as const).map((n) => (
          <label key={n} className="radio">
            <input type="radio" checked={membership.notify === n} onChange={() => void setChannelPrefs(channel.id, { notify: n })} />
            {n === 'default' ? t('Use my default setting') : n === 'all' ? t('All new messages') : n === 'mentions' ? t('Mentions and DMs') : t('Nothing')}
          </label>
        ))}
        <Toggle checked={membership.muted} onChange={(v) => void setChannelPrefs(channel.id, { muted: v })} label={isDm ? t('Mute conversation') : t('Mute channel')} />
      </div>
      {!isDm && isAdmin(me) && channel.kind === 'public' && (
        <div className="detail-block">
          <Toggle
            checked={channel.isDefault}
            onChange={async (v) => {
              try {
                upsertChannel(await PATCH<Channel>(`/api/channels/${channel.id}`, { isDefault: v }));
              } catch (e) {
                fail(e);
              }
            }}
            label={t('Default channel – new members join automatically')}
          />
        </div>
      )}
      {!isDm && canManage && !(channel.isDefault && channel.name === 'general') && (
        <div className="detail-block danger-zone">
          {channel.archived ? (
            <button
              className="btn"
              onClick={async () => {
                try {
                  upsertChannel(await POST<Channel>(`/api/channels/${channel.id}/unarchive`));
                } catch (e) {
                  fail(e);
                }
              }}
            >
              <Archive size={14} /> {t('Unarchive channel')}
            </button>
          ) : (
            <button
              className="btn danger"
              onClick={() =>
                confirmDialog({
                  title: t('Archive #{name}?', { name: channel.name }),
                  body: t('No one will be able to send messages to an archived channel. You can unarchive it later.'),
                  danger: true,
                  confirmLabel: t('Archive'),
                  onConfirm: async () => {
                    try {
                      upsertChannel(await POST<Channel>(`/api/channels/${channel.id}/archive`));
                    } catch (e) {
                      fail(e);
                    }
                  },
                })
              }
            >
              <Archive size={14} /> {t('Archive channel')}
            </button>
          )}
          {isAdmin(me) && (
            <button
              className="btn danger"
              onClick={() =>
                confirmDialog({
                  title: t('Delete #{name}?', { name: channel.name }),
                  body: t('All messages and files in this channel will be permanently deleted. This cannot be undone.'),
                  danger: true,
                  confirmLabel: t('Delete channel'),
                  onConfirm: async () => {
                    try {
                      await DEL(`/api/channels/${channel.id}`);
                      set((s) => {
                        delete s.channels[channel.id];
                        delete s.memberships[channel.id];
                      });
                      onClose();
                      navigate('/');
                    } catch (e) {
                      fail(e);
                    }
                  },
                })
              }
            >
              <Trash2 size={14} /> {t('Delete channel')}
            </button>
          )}
        </div>
      )}
      {!isDm && (
        <div className="detail-block">
          <button
            className="link danger"
            onClick={() => {
              onClose();
              leaveChannel(channel.id);
            }}
          >
            <LogOut size={14} /> {t('Leave channel')}
          </button>
        </div>
      )}
    </div>
  );
}

export function AddMembersModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const channel = useStore((s) => s.channels[channelId]);
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [existing, setExisting] = useState<string[]>(channel?.memberIds ?? []);
  useEffect(() => {
    GET<string[]>(`/api/channels/${channelId}/members`).then(setExisting).catch(() => {});
  }, [channelId]);
  const submit = async () => {
    if (!ids.length) return;
    setBusy(true);
    try {
      upsertChannel(await POST<Channel>(`/api/channels/${channelId}/members`, { userIds: ids }));
      toast(tp(ids.length, '{n} person added', '{n} people added'));
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t('Add people to #{name}', { name: channel?.name ?? '' })}
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!ids.length || busy} onClick={() => void submit()}>
          {t('Add')}
        </button>
      }
    >
      <UserPicker value={ids} onChange={setIds} exclude={existing} onEnter={() => void submit()} />
    </Modal>
  );
}

export function NewMessageModal({ onClose }: { onClose: () => void }) {
  const [ids, setIds] = useState<string[]>([]);
  const meId = useStore((s) => s.me?.id);
  const go = async () => {
    if (!ids.length) return;
    onClose();
    await openDm(ids);
  };
  return (
    <Modal
      title={t('New message')}
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!ids.length} onClick={() => void go()}>
          {t('Go')}
        </button>
      }
    >
      <div className="field-label">{t('To:')}</div>
      <UserPicker value={ids} onChange={setIds} max={8} onEnter={() => void go()} placeholder={t('@somebody or somebody@example.com')} exclude={ids.length ? [] : []} />
      <p className="field-help">{ids.length === 0 && meId ? t('Start a conversation with one or more people.') : ''}</p>
    </Modal>
  );
}

