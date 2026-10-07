import { useState } from 'react';
import { BellOff, ChevronRight, Smile } from './icons.tsx';
import { displayName, useStore } from '../store.ts';
import { t } from '../i18n.ts';
import { logout, openModal, openProfile, setAway, setDnd, setStatus } from '../actions.ts';
import { formatTime } from '../lib/format.ts';
import { Emoji } from '../lib/mrkdwn.tsx';
import { Avatar, Menu, MenuItem, MenuSep, Popover, type Placement } from './ui.tsx';

export function dndOptions() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [
    { label: t('For 30 minutes'), until: Date.now() + 30 * 60_000 },
    { label: t('For 1 hour'), until: Date.now() + 60 * 60_000 },
    { label: t('For 2 hours'), until: Date.now() + 120 * 60_000 },
    { label: t('Until tomorrow'), until: tomorrow.getTime() },
  ];
}

export function UserMenu({ anchor, onClose, placement = 'right-end' }: { anchor: HTMLElement | null; onClose: () => void; placement?: Placement }) {
  const me = useStore((s) => s.me);
  const online = useStore((s) => (me ? s.presence[me.id] === 'active' : false));
  const [dndOpen, setDndOpen] = useState<HTMLElement | null>(null);
  if (!me) return null;
  const dndActive = !!me.dndUntil && me.dndUntil > Date.now();
  const close = (fn?: () => void) => () => {
    onClose();
    fn?.();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} placement={placement}>
      <Menu className="user-menu">
        <div className="user-menu-head">
          <Avatar user={me} size={36} />
          <div>
            <div className="user-menu-name">{displayName(me)}</div>
            <div className="user-menu-presence">
              <span className={`presence-dot ${online && !me.awayManual ? 'online' : 'away'}`} /> {me.awayManual ? t('Away') : t('Active')}
            </div>
          </div>
        </div>
        <button className="status-input" onClick={close(() => openModal({ type: 'setStatus' }))}>
          {me.statusEmoji ? <Emoji code={me.statusEmoji} size={16} /> : <Smile size={16} />}
          <span>{me.statusText || (me.statusEmoji ? '' : t('Update your status'))}</span>
          {(me.statusEmoji || me.statusText) && (
            <span
              className="status-clear"
              onClick={(e) => {
                e.stopPropagation();
                void setStatus('', '', null);
              }}
            >
              ×
            </span>
          )}
        </button>
        <MenuItem onClick={close(() => void setAway(!me.awayManual))}>
          {me.awayManual ? t('Set yourself as active') : t('Set yourself as away')}
        </MenuItem>
        <MenuItem
          icon={<BellOff size={15} />}
          onClick={(e) => setDndOpen(e.currentTarget)}
          onMouseEnter={(e) => setDndOpen(e.currentTarget)}
          right={<ChevronRight size={14} />}
          hint={dndActive ? t('Until {time}', { time: formatTime(me.dndUntil!) }) : undefined}
        >
          {t('Pause notifications')}
        </MenuItem>
        {dndOpen && (
          <Popover anchor={dndOpen} onClose={() => setDndOpen(null)} placement="right-start" offset={0}>
            <Menu>
              {dndActive && <MenuItem onClick={close(() => void setDnd(null))}>{t('Resume notifications')}</MenuItem>}
              {dndOptions().map((o) => (
                <MenuItem key={o.label} onClick={close(() => void setDnd(o.until))}>
                  {o.label}
                </MenuItem>
              ))}
            </Menu>
          </Popover>
        )}
        <MenuSep />
        <MenuItem onClick={close(() => openProfile(me.id))}>{t('Profile')}</MenuItem>
        <MenuItem onClick={close(() => openModal({ type: 'preferences' }))} hint="⌘,">
          {t('Preferences')}
        </MenuItem>
        <MenuSep />
        <MenuItem onClick={close(() => void logout())}>{t('Sign out')}</MenuItem>
      </Menu>
    </Popover>
  );
}
