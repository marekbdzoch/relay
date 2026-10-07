import { useEffect, useState } from 'react';
import { AlarmClock, Archive, Bookmark, Check, EllipsisVertical, RotateCcw, Trash2 } from '../components/icons.tsx';
import { useNavigate } from 'react-router-dom';
import type { SavedItem, SavedState } from '../../../shared/types.ts';
import { DEL, GET, PUT } from '../api.ts';
import { isDmKind, set, useStore, userName, upsertMessages } from '../store.ts';
import { t } from '../i18n.ts';
import { fail, openModal, remindOptions } from '../actions.ts';
import { toPlainText } from '../lib/mrkdwn.tsx';
import { formatDateTime, formatShortDate } from '../lib/format.ts';
import { Avatar, Menu, MenuItem, MenuSep, Popover, Spinner } from '../components/ui.tsx';

function LaterRow({ item, active, state, onChange }: { item: SavedItem; active: boolean; state: SavedState; onChange: () => void }) {
  const nav = useNavigate();
  const m = item.message;
  const ch = useStore((s) => s.channels[m.channelId]);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const key = `${m.channelId}/${m.id}`;
  const overdue = item.remindAt && item.remindAt < Date.now();

  const update = async (body: { state?: SavedState; remindAt?: number | null }) => {
    await PUT(`/api/messages/${m.id}/save`, body).catch(fail);
    onChange();
  };

  return (
    <div className={`later-row${active ? ' active' : ''}`} onClick={() => nav(`/later/${key}${m.threadRootId && !m.alsoInChannel ? `?thread=${m.threadRootId}` : ''}`)}>
      <div className="later-top">
        <span>{ch ? (isDmKind(ch) ? t('Direct message') : `#${ch.name}`) : ''}</span>
        {item.remindAt ? (
          <span className={`later-due${overdue ? ' overdue' : ''}`}>
            <AlarmClock size={12} /> {overdue ? t('Overdue') : t('Due {when}', { when: formatDateTime(item.remindAt) })}
          </span>
        ) : (
          <span>{formatShortDate(item.savedAt)}</span>
        )}
      </div>
      <div className="later-body">
        <Avatar userId={m.userId} size={20} />
        <div>
          <b>{m.botName ?? userName(m.userId)}</b>
          <div className="later-text">{toPlainText(m.text).slice(0, 200) || (m.files.length ? m.files[0].name : '')}</div>
        </div>
      </div>
      <div className="later-actions" onClick={(e) => e.stopPropagation()}>
        {state === 'progress' ? (
          <button className="icon-btn small" title={t('Mark complete')} onClick={() => void update({ state: 'completed' })}>
            <Check size={14} />
          </button>
        ) : (
          <button className="icon-btn small" title={t('Move to in progress')} onClick={() => void update({ state: 'progress' })}>
            <RotateCcw size={14} />
          </button>
        )}
        <button className="icon-btn small" title={t('More actions')} onClick={(e) => setMenu(e.currentTarget)}>
          <EllipsisVertical size={14} />
        </button>
      </div>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} placement="bottom-end">
          <Menu>
            <div className="menu-header">{t('Remind me')}</div>
            {remindOptions().map((o) => (
              <MenuItem
                key={o.label}
                icon={<AlarmClock size={15} />}
                onClick={() => {
                  setMenu(null);
                  void update({ remindAt: o.at, state: 'progress' });
                }}
              >
                {o.label}
              </MenuItem>
            ))}
            <MenuItem
              onClick={() => {
                setMenu(null);
                openModal({ type: 'remind', messageId: m.id });
              }}
            >
              {t('Custom…')}
            </MenuItem>
            {item.remindAt && (
              <MenuItem
                onClick={() => {
                  setMenu(null);
                  void update({ remindAt: null });
                }}
              >
                {t('Remove reminder')}
              </MenuItem>
            )}
            <MenuSep />
            {state !== 'archived' && (
              <MenuItem
                icon={<Archive size={15} />}
                onClick={() => {
                  setMenu(null);
                  void update({ state: 'archived' });
                }}
              >
                {t('Archive')}
              </MenuItem>
            )}
            <MenuItem
              icon={<Trash2 size={15} />}
              danger
              onClick={async () => {
                setMenu(null);
                await DEL(`/api/messages/${m.id}/save`).catch(fail);
                onChange();
              }}
            >
              {t('Remove from Later')}
            </MenuItem>
          </Menu>
        </Popover>
      )}
    </div>
  );
}

export function LaterList({ activeKey }: { activeKey?: string }) {
  const [state, setState] = useState<SavedState>('progress');
  const [items, setItems] = useState<SavedItem[] | null>(null);
  const savedVersion = useStore((s) => Object.keys(s.saved).join(','));
  const [tick, setTick] = useState(0);

  useEffect(() => {
    GET<SavedItem[]>(`/api/saved?state=${state}`)
      .then((list) => {
        set((s) => upsertMessages(s, list.map((i) => i.message)));
        setItems(list);
      })
      .catch(fail);
  }, [state, savedVersion, tick]);

  const tabs: [SavedState, string][] = [
    ['progress', t('In progress')],
    ['archived', t('Archived')],
    ['completed', t('Completed')],
  ];

  return (
    <div className="pane">
      <div className="pane-head">
        <span className="pane-title">{t('Later')}</span>
      </div>
      <div className="pane-tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={`pane-tab${state === k ? ' active' : ''}`} onClick={() => setState(k)}>
            {label}
            {k === 'progress' && items && state === 'progress' && items.length > 0 && <span className="pane-tab-count">{items.length}</span>}
          </button>
        ))}
      </div>
      <div className="sidebar-scroll">
        {!items ? (
          <div className="center-fill">
            <Spinner />
          </div>
        ) : !items.length ? (
          <div className="pane-empty">
            <Bookmark size={28} />
            <p>
              {state === 'progress'
                ? t('Save messages for later by hovering a message and clicking the bookmark icon. Set a reminder to get nudged at the right time.')
                : state === 'completed'
                  ? t('Nothing completed yet.')
                  : t('Nothing archived.')}
            </p>
          </div>
        ) : (
          items.map((item) => (
            <LaterRow
              key={item.message.id}
              item={item}
              state={state}
              active={activeKey === `${item.message.channelId}/${item.message.id}`}
              onChange={() => setTick((n) => n + 1)}
            />
          ))
        )}
      </div>
    </div>
  );
}

