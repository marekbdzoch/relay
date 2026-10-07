import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bell, Bookmark, Bot, Clock, Files, Globe, GripVertical, Headphones, Home, Lock, MessagesSquare, Palette, MessageSquare, PanelLeft, RotateCcw, Smile, X } from '../components/icons.tsx';
import type { Me, NavSection } from '../../../shared/types.ts';
import { DEL, PATCH, POST, PUT, upload } from '../api.ts';
import { toast, useStore } from '../store.ts';
import { LANGUAGES, t, tp } from '../i18n.ts';
import { fail, setMe, setStatus, updatePrefs } from '../actions.ts';
import { DEFAULT_COLOR_MODE, DEFAULT_THEME, THEMES } from '../lib/theme.ts';
import { moveNavTab, navTabsOf, setNavTabVisible, type NavTabs } from '../lib/navTabs.ts';
import { notificationPermission, playKnock, requestNotificationPermission } from '../lib/notify.ts';
import { Emoji } from '../lib/mrkdwn.tsx';
import { Avatar, Modal, Toggle } from '../components/ui.tsx';
import { EmojiPickerPopover } from '../components/EmojiPicker.tsx';

const TIMEZONES: string[] = (() => {
  try {
    return (Intl as any).supportedValuesOf('timeZone') as string[];
  } catch {
    return ['UTC', 'Europe/Prague', 'Europe/London', 'America/New_York'];
  }
})();

export function PreferencesModal({ tab: initial = 'availability', onClose }: { tab?: string; onClose: () => void }) {
  const me = useStore((s) => s.me)!;
  const [tab, setTab] = useState(initial);
  const [perm, setPerm] = useState(notificationPermission());
  const p = me.prefs;
  const tabs: [string, string, React.ReactNode][] = [
    ['availability', t('Availability'), <Clock size={16} />],
    ['notifications', t('Notifications'), <Bell size={16} />],
    ['appearance', t('Themes'), <Palette size={16} />],
    ['navigation', t('Navigation'), <PanelLeft size={16} />],
    ['messages', t('Messages & media'), <MessageSquare size={16} />],
    ['language', t('Language & region'), <Globe size={16} />],
    ['audio', t('Audio & video'), <Headphones size={16} />],
    ['account', t('Account & security'), <Lock size={16} />],
  ];
  return (
    <Modal title={t('Preferences')} onClose={onClose} width={820} className="prefs-modal" bodyClassName="prefs-body">
      <nav className="prefs-nav">
        {tabs.map(([k, label, icon]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {icon} {label}
          </button>
        ))}
      </nav>
      <div className="prefs-content">
        {tab === 'notifications' && (
          <>
            <h3>{t('Notify me about…')}</h3>
            {(['all', 'mentions', 'none'] as const).map((lvl) => (
              <label key={lvl} className="radio">
                <input type="radio" checked={(p.notifyLevel ?? 'mentions') === lvl} onChange={() => void updatePrefs({ notifyLevel: lvl })} />
                {lvl === 'all' ? t('All new messages') : lvl === 'mentions' ? t('Direct messages, mentions & threads') : t('Nothing')}
              </label>
            ))}
            <h3>{t('Desktop notifications')}</h3>
            {perm === 'granted' ? (
              <p className="muted-text">{t('Desktop notifications are enabled for this browser.')}</p>
            ) : perm === 'unsupported' ? (
              <p className="muted-text">{t('This browser does not support notifications.')}</p>
            ) : (
              <button className="btn primary" onClick={async () => setPerm(await requestNotificationPermission())}>
                {t('Enable desktop notifications')}
              </button>
            )}
            <div className="pref-row">
              <Toggle checked={p.notifySound !== false} onChange={(v) => void updatePrefs({ notifySound: v })} label={t('Play a sound for notifications')} />
              <button className="link" onClick={playKnock}>
                {t('Test')}
              </button>
            </div>
            <div className="pref-row">
              <Toggle checked={p.showMessagePreviews !== false} onChange={(v) => void updatePrefs({ showMessagePreviews: v })} label={t('Show message previews in notifications')} />
            </div>
            <h3>{t('Also notify me about')}</h3>
            <Toggle checked={p.notifyThreads !== false} onChange={(v) => void updatePrefs({ notifyThreads: v })} label={t('Replies to threads I follow')} />
            <Toggle checked={p.notifyHuddles !== false} onChange={(v) => void updatePrefs({ notifyHuddles: v })} label={t('New huddles in my direct messages')} />
            <h3>{t('My keywords')}</h3>
            <p className="field-help">{t('Messages containing these words notify you like a mention. Separate keywords with commas.')}</p>
            <KeywordsInput value={p.keywords ?? ''} />
          </>
        )}
        {tab === 'availability' && <AvailabilityPrefs />}
        {tab === 'audio' && <AudioVideoPrefs />}
        {tab === 'navigation' && <NavigationPrefs />}
        {tab === 'appearance' && (
          <>
            <h3>{t('Color mode')}</h3>
            <div className="mode-picker">
              {(['light', 'dark', 'system'] as const).map((m) => (
                <button key={m} className={`mode-option${(p.colorMode ?? DEFAULT_COLOR_MODE) === m ? ' active' : ''}`} onClick={() => void updatePrefs({ colorMode: m })}>
                  <span className={`mode-swatch ${m}`} />
                  {m === 'light' ? t('Light') : m === 'dark' ? t('Dark') : t('Sync with OS')}
                </button>
              ))}
            </div>
            <h3>{t('Theme')}</h3>
            <div className="theme-grid">
              {THEMES.map((th) => (
                <button key={th.id} className={`theme-option${(p.theme ?? DEFAULT_THEME) === th.id ? ' active' : ''}`} onClick={() => void updatePrefs({ theme: th.id })}>
                  <span className="theme-swatch" style={{ background: `linear-gradient(135deg, ${th.light.container} 0 50%, ${th.light.accent} 50% 100%)` }} />
                  {th.name}
                </button>
              ))}
            </div>
          </>
        )}
        {tab === 'messages' && (
          <>
            <h3>{t('When writing a message, press Enter to…')}</h3>
            <label className="radio">
              <input type="radio" checked={p.enterToSend !== false} onChange={() => void updatePrefs({ enterToSend: true })} />
              {t('Send the message (Shift+Enter starts a new line)')}
            </label>
            <label className="radio">
              <input type="radio" checked={p.enterToSend === false} onChange={() => void updatePrefs({ enterToSend: false })} />
              {t('Start a new line (use Ctrl/⌘+Enter to send)')}
            </label>
            <h3>{t('Composer')}</h3>
            <Toggle checked={p.compact !== true} onChange={(v) => void updatePrefs({ compact: !v })} label={t('Show the formatting toolbar by default')} />
          </>
        )}
        {tab === 'language' && (
          <>
            <h3>{t('Language')}</h3>
            <select value={p.language ?? (navigator.language.startsWith('cs') ? 'cs' : 'en')} onChange={(e) => void updatePrefs({ language: e.target.value }).then(() => location.reload())}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
            <h3>{t('Time format')}</h3>
            <Toggle checked={p.timeFormat24 ?? true} onChange={(v) => void updatePrefs({ timeFormat24: v })} label={t('Use 24-hour clock')} />
            <h3>{t('Time zone')}</h3>
            <select
              value={me.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}
              onChange={async (e) => {
                try {
                  setMe(await PATCH<Me>('/api/users/me', { timezone: e.target.value }));
                } catch (err) {
                  fail(err);
                }
              }}
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </>
        )}
        {tab === 'account' && <AccountPrefs />}
      </div>
    </Modal>
  );
}

function KeywordsInput({ value }: { value: string }) {
  const [v, setV] = useState(value);
  return <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && void updatePrefs({ keywords: v })} placeholder={t('e.g. invoice, release, my-project')} />;
}

function AvailabilityPrefs() {
  const wh = useStore((s) => s.me?.prefs.workingHours) ?? { enabled: false, days: 'weekdays' as const, from: '09:00', to: '17:00' };
  const save = (patch: Partial<typeof wh>) => void updatePrefs({ workingHours: { ...wh, ...patch } });
  return (
    <>
      <h3>{t('Working hours')}</h3>
      <p className="field-help">{t('You only receive notifications during the hours you choose. Outside of them, notifications are paused automatically.')}</p>
      <Toggle checked={wh.enabled} onChange={(v) => save({ enabled: v })} label={t('Pause notifications outside working hours')} />
      <div className={`working-hours${wh.enabled ? '' : ' disabled'}`}>
        <select value={wh.days} onChange={(e) => save({ days: e.target.value as 'every' | 'weekdays' })} disabled={!wh.enabled}>
          <option value="weekdays">{t('Weekdays')}</option>
          <option value="every">{t('Every day')}</option>
        </select>
        <input type="time" value={wh.from} onChange={(e) => save({ from: e.target.value })} disabled={!wh.enabled} />
        <span>{t('to')}</span>
        <input type="time" value={wh.to} onChange={(e) => save({ to: e.target.value })} disabled={!wh.enabled} />
      </div>
      <h3>{t('Automatic statuses')}</h3>
      <p className="field-help">{t('While you are in a huddle, your status shows 🎧 In a huddle (unless you set your own status).')}</p>
    </>
  );
}

const NAV_META: Record<NavSection, [() => string, (n: number) => React.ReactNode]> = {
  home: [() => t('Home'), (n) => <Home size={n} />],
  dms: [() => t('DMs'), (n) => <MessagesSquare size={n} />],
  activity: [() => t('Activity'), (n) => <Bell size={n} />],
  files: [() => t('Files'), (n) => <Files size={n} />],
  later: [() => t('Later'), (n) => <Bookmark size={n} />],
  agents: [() => t('Agents'), (n) => <Bot size={n} />],
};

/** Which section icons sit at the top of the left column, and in what order. */
function NavigationPrefs() {
  const saved = useStore((s) => s.me?.prefs.navTabs);
  const tabs = navTabsOf({ navTabs: saved });
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const save = (navTabs: NavTabs) => void updatePrefs({ navTabs });
  const hidden = tabs.filter((x) => !x.visible).length;
  return (
    <>
      <h3>{t('Sections')}</h3>
      <p className="field-help">{t('Choose which icons appear at the top of the sidebar and drag them into the order you like. Hidden sections stay available under “More”.')}</p>
      <ol className="nav-prefs" aria-label={t('Sections')}>
        {tabs.map((tab, i) => {
          const [label, icon] = NAV_META[tab.id];
          return (
            <li
              key={tab.id}
              className={`nav-pref${tab.visible ? '' : ' off'}${dragging === i ? ' dragging' : ''}${over === i && dragging !== null && dragging !== i ? ' over' : ''}`}
              draggable
              onDragStart={(e) => {
                setDragging(i);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging !== null) save(moveNavTab(tabs, dragging, i));
                setDragging(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
            >
              <span className="nav-pref-grip" aria-hidden>
                <GripVertical size={16} />
              </span>
              <span className="nav-pref-icon">{icon(18)}</span>
              <span className="nav-pref-label">{label()}</span>
              <button className="icon-btn" disabled={i === 0} onClick={() => save(moveNavTab(tabs, i, i - 1))} aria-label={t('Move {name} up', { name: label() })}>
                <ArrowUp size={15} />
              </button>
              <button className="icon-btn" disabled={i === tabs.length - 1} onClick={() => save(moveNavTab(tabs, i, i + 1))} aria-label={t('Move {name} down', { name: label() })}>
                <ArrowDown size={15} />
              </button>
              <Toggle
                checked={tab.visible}
                disabled={tab.id === 'home'}
                onChange={(v) => save(setNavTabVisible(tabs, tab.id, v))}
                ariaLabel={t('Show {name}', { name: label() })}
              />
            </li>
          );
        })}
      </ol>
      <div className="nav-prefs-foot">
        <span className="field-help">{hidden ? tp(hidden, '{n} section hidden', '{n} sections hidden') : t('All sections are shown.')}</span>
        <button className="btn" disabled={!saved?.length} onClick={() => void updatePrefs({ navTabs: [] })}>
          <RotateCcw size={15} /> {t('Reset to default')}
        </button>
      </div>
    </>
  );
}

function AudioVideoPrefs() {
  const prefs = useStore((s) => s.me?.prefs);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [granted, setGranted] = useState(false);
  const load = async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list);
      setGranted(list.some((d) => d.label));
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const mics = devices.filter((d) => d.kind === 'audioinput');
  const cams = devices.filter((d) => d.kind === 'videoinput');
  return (
    <>
      <h3>{t('Microphone')}</h3>
      <select value={prefs?.audioInput ?? ''} onChange={(e) => void updatePrefs({ audioInput: e.target.value })}>
        <option value="">{t('System default')}</option>
        {mics.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || t('Microphone')}
          </option>
        ))}
      </select>
      <h3>{t('Camera')}</h3>
      <select value={prefs?.videoInput ?? ''} onChange={(e) => void updatePrefs({ videoInput: e.target.value })}>
        <option value="">{t('System default')}</option>
        {cams.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || t('Camera')}
          </option>
        ))}
      </select>
      {!granted && (
        <p>
          <button
            className="btn small"
            onClick={async () => {
              try {
                const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
                s.getTracks().forEach((tr) => tr.stop());
              } catch {
                /* ignore */
              }
              void load();
            }}
          >
            {t('Allow access to see device names')}
          </button>
        </p>
      )}
    </>
  );
}

function AccountPrefs() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h3>{t('Change password')}</h3>
      <label className="field">
        <span className="field-label">{t('Current password')}</span>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </label>
      <label className="field">
        <span className="field-label">{t('New password')}</span>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} />
        <span className="field-help">{t('At least 8 characters.')}</span>
      </label>
      <button
        className="btn primary"
        disabled={busy || !current || next.length < 8}
        onClick={async () => {
          setBusy(true);
          try {
            await PUT('/api/auth/password', { current, password: next });
            toast(t('Password changed'));
            setCurrent('');
            setNext('');
          } catch (e) {
            fail(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('Save password')}
      </button>
      <h3>{t('Sessions')}</h3>
      <p className="muted-text">{t('Signed in on another computer you no longer use? Sign out everywhere else.')}</p>
      <button
        className="btn"
        onClick={async () => {
          try {
            const r = await POST<{ count: number }>('/api/auth/logout-others');
            toast(t('Signed out of {n} other sessions', { n: r.count }));
          } catch (e) {
            fail(e);
          }
        }}
      >
        {t('Sign out all other sessions')}
      </button>
    </>
  );
}

export function EditProfileModal({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me)!;
  const [form, setForm] = useState({ fullName: me.fullName, displayName: me.displayName, title: me.title, phone: me.phone, username: me.username });
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    setBusy(true);
    try {
      setMe(await PATCH<Me>('/api/users/me', form));
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('Edit your profile')}
      onClose={onClose}
      width={720}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !form.fullName.trim()} onClick={() => void save()}>
            {t('Save changes')}
          </button>
        </>
      }
    >
      <div className="profile-edit">
        <div className="profile-edit-fields">
          <label className="field">
            <span className="field-label">{t('Full name')}</span>
            <input value={form.fullName} onChange={set('fullName')} maxLength={80} />
          </label>
          <label className="field">
            <span className="field-label">{t('Display name')}</span>
            <input value={form.displayName} onChange={set('displayName')} maxLength={80} />
            <span className="field-help">{t('This could be your first name, or a nickname — however you’d like people to refer to you.')}</span>
          </label>
          <label className="field">
            <span className="field-label">{t('Title')}</span>
            <input value={form.title} onChange={set('title')} maxLength={120} placeholder={t('e.g. Marketing lead')} />
          </label>
          <label className="field">
            <span className="field-label">{t('Username')}</span>
            <div className="input-prefix">
              @
              <input value={form.username} onChange={set('username')} maxLength={40} />
            </div>
          </label>
          <label className="field">
            <span className="field-label">{t('Phone')}</span>
            <input value={form.phone} onChange={set('phone')} maxLength={40} />
          </label>
        </div>
        <div className="profile-edit-photo">
          <span className="field-label">{t('Profile photo')}</span>
          <Avatar user={me} size={192} />
          <button className="btn" onClick={() => file.current?.click()}>
            {t('Upload photo')}
          </button>
          {me.avatarUrl && (
            <button
              className="link"
              onClick={async () => {
                try {
                  setMe(await DEL<Me>('/api/users/me/avatar'));
                } catch (e) {
                  fail(e);
                }
              }}
            >
              {t('Remove photo')}
            </button>
          )}
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const form = new FormData();
              form.append('file', f, f.name);
              try {
                setMe(await upload<Me>('/api/users/me/avatar', form, undefined, 'PUT').promise);
              } catch (err) {
                fail(err);
              }
            }}
          />
        </div>
      </div>
    </Modal>
  );
}

const STATUS_PRESETS = [
  { emoji: 'spiral_calendar_pad', text: 'In a meeting', mins: 60 },
  { emoji: 'bus', text: 'Commuting', mins: 30 },
  { emoji: 'face_with_thermometer', text: 'Out sick', mins: -1 },
  { emoji: 'palm_tree', text: 'Vacationing', mins: 0 },
  { emoji: 'house_with_garden', text: 'Working remotely', mins: -1 },
  { emoji: 'knife_fork_plate', text: 'Lunch', mins: 60 },
];

function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 0);
  return d.getTime();
}

export function SetStatusModal({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me)!;
  const [emoji, setEmoji] = useState(me.statusEmoji);
  const [text, setText] = useState(me.statusText);
  const [expiry, setExpiry] = useState<string>('never');
  const [picker, setPicker] = useState(false);
  const emojiBtn = useRef<HTMLButtonElement>(null);

  const expiresAt = () => {
    switch (expiry) {
      case '30m':
        return Date.now() + 30 * 60_000;
      case '1h':
        return Date.now() + 60 * 60_000;
      case '4h':
        return Date.now() + 4 * 60 * 60_000;
      case 'today':
        return endOfToday();
      case 'week': {
        const d = new Date();
        d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
        d.setHours(23, 59, 59, 0);
        return d.getTime();
      }
      default:
        return null;
    }
  };

  const save = async () => {
    await setStatus(text.trim() && !emoji ? 'speech_balloon' : emoji, text.trim(), expiresAt());
    onClose();
  };

  return (
    <Modal
      title={t('Set a status')}
      onClose={onClose}
      footer={
        <>
          {(me.statusEmoji || me.statusText) && (
            <button
              className="btn"
              onClick={async () => {
                await setStatus('', '', null);
                onClose();
              }}
            >
              {t('Clear status')}
            </button>
          )}
          <button className="btn primary" disabled={!emoji && !text.trim()} onClick={() => void save()}>
            {t('Save')}
          </button>
        </>
      }
    >
      <div className="status-field">
        <button ref={emojiBtn} className="status-emoji-btn" onClick={() => setPicker(true)}>
          {emoji ? <Emoji code={emoji} size={20} /> : <Smile size={20} />}
        </button>
        <input autoFocus value={text} maxLength={100} onChange={(e) => setText(e.target.value)} placeholder={t('What’s your status?')} onKeyDown={(e) => e.key === 'Enter' && void save()} />
        {(emoji || text) && (
          <button
            className="icon-btn small"
            onClick={() => {
              setEmoji('');
              setText('');
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {picker && <EmojiPickerPopover anchor={emojiBtn.current} onClose={() => setPicker(false)} onPick={(e) => setEmoji(e.code)} placement="bottom-start" />}
      {!text && (
        <div className="status-presets">
          <div className="field-label">{t('For your workspace')}</div>
          {STATUS_PRESETS.map((s) => (
            <button
              key={s.text}
              className="status-preset"
              onClick={() => {
                setEmoji(s.emoji);
                setText(t(s.text));
                setExpiry(s.mins === 30 ? '30m' : s.mins === 60 ? '1h' : s.mins === -1 ? 'today' : 'never');
              }}
            >
              <Emoji code={s.emoji} size={18} /> <b>{t(s.text)}</b>
              <span className="muted-text">
                {' '}
                — {s.mins === 30 ? t('30 minutes') : s.mins === 60 ? t('1 hour') : s.mins === -1 ? t('Today') : t('Don’t clear')}
              </span>
            </button>
          ))}
        </div>
      )}
      <label className="field">
        <span className="field-label">{t('Clear after…')}</span>
        <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
          <option value="never">{t('Don’t clear')}</option>
          <option value="30m">{t('30 minutes')}</option>
          <option value="1h">{t('1 hour')}</option>
          <option value="4h">{t('4 hours')}</option>
          <option value="today">{t('Today')}</option>
          <option value="week">{t('This week')}</option>
        </select>
      </label>
    </Modal>
  );
}
