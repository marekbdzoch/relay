import { useEffect, useMemo, useState } from 'react';
import { Headphones, Plus } from '../components/icons.tsx';
import { useNavigate } from 'react-router-dom';
import type { HuddleSession } from '../../../shared/types.ts';
import { GET } from '../api.ts';
import { channelTitle, dmPartner, isDmKind, useStore, userName } from '../store.ts';
import { t, tp } from '../i18n.ts';
import { fail, openDm, openModal } from '../actions.ts';
import { joinHuddle, useHuddle } from '../lib/huddle.ts';
import { timeAgo } from '../lib/format.ts';
import { Avatar, Spinner } from '../components/ui.tsx';

function duration(ms: number) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return tp(m, '{n} minute', '{n} minutes');
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${tp(h, '{n} hour', '{n} hours')}${rest ? ` ${tp(rest, '{n} minute', '{n} minutes')}` : ''}`;
}

export function HuddlesView() {
  const nav = useNavigate();
  const [list, setList] = useState<HuddleSession[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'dms' | 'channels'>('all');
  const channels = useStore((s) => s.channels);
  const live = useStore((s) => s.huddles);
  const meId = useStore((s) => s.me?.id);
  const myHuddle = useHuddle((s) => s.channelId);

  useEffect(() => {
    GET<HuddleSession[]>('/api/huddles').then(setList).catch(fail);
  }, [Object.keys(live).join(',')]);

  // the person you huddle with the most recently
  const suggestion = useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of list ?? []) {
      const ch = channels[h.channelId];
      if (ch?.kind !== 'dm' || Date.now() - h.startedAt > 14 * 86400_000) continue;
      const p = dmPartner(ch);
      if (p && p !== meId) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? { userId: best[0], times: best[1] } : null;
  }, [list, channels, meId]);

  const filtered = (list ?? []).filter((h) => {
    const ch = channels[h.channelId];
    if (filter === 'dms') return isDmKind(ch);
    if (filter === 'channels') return ch && !isDmKind(ch);
    return true;
  });

  return (
    <main className="main-view">
      <div className="view-header">
        <h2>
          <Headphones size={18} /> {t('Huddles')}
        </h2>
        <button className="btn small view-header-action" onClick={() => openModal({ type: 'newMessage' })}>
          <Plus size={14} /> {t('New huddle')}
        </button>
      </div>
      <div className="view-body huddles-view">
        {Object.values(live).length > 0 && (
          <>
            <h3 className="section-title">{t('Happening now')}</h3>
            {Object.values(live).map((h) => (
              <div key={h.channelId} className="huddle-row live">
                <span className="huddle-row-icon live">
                  <Headphones size={16} />
                </span>
                <div className="huddle-row-main">
                  <b>{isDmKind(channels[h.channelId]) ? channelTitle(channels[h.channelId]) : `#${channels[h.channelId]?.name ?? ''}`}</b>
                  <span className="muted-text">{tp(h.participants.length, '{n} person', '{n} people')} · {timeAgo(h.startedAt)}</span>
                </div>
                <span className="huddle-row-faces">
                  {h.participants.slice(0, 4).map((p) => (
                    <Avatar key={p.userId} userId={p.userId} size={24} />
                  ))}
                </span>
                {myHuddle !== h.channelId && (
                  <button className="btn small primary" onClick={() => void joinHuddle(h.channelId)}>
                    {t('Join')}
                  </button>
                )}
              </div>
            ))}
          </>
        )}
        {suggestion && (
          <div className="huddle-suggestion">
            <Avatar userId={suggestion.userId} size={48} />
            <div>
              <b>{t('Start a huddle with {name}?', { name: userName(suggestion.userId) })}</b>
              <div className="muted-text">{tp(suggestion.times, 'You huddled once in the last two weeks', 'You huddled {n} times in the last two weeks')}</div>
            </div>
            <button
              className="btn small"
              onClick={async () => {
                const ch = await openDm([suggestion.userId]);
                if (ch) void joinHuddle(ch.id);
              }}
            >
              <Headphones size={14} /> {t('Start')}
            </button>
          </div>
        )}
        <h3 className="section-title">{t('Recent huddles')}</h3>
        <div className="view-filters">
          {(
            [
              ['all', t('All huddles')],
              ['dms', t('Direct messages')],
              ['channels', t('Channels')],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={`chip${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        {!list ? (
          <Spinner />
        ) : !filtered.length ? (
          <p className="muted-text">{t('No huddles yet. Start one from any channel or DM with the headphones button.')}</p>
        ) : (
          filtered.map((h) => {
            const ch = channels[h.channelId];
            return (
              <button key={h.id} className="huddle-row" onClick={() => ch && nav(`/c/${ch.id}`)}>
                <span className="huddle-row-icon">
                  <Headphones size={16} />
                </span>
                <div className="huddle-row-main">
                  <b>{ch ? (isDmKind(ch) ? channelTitle(ch) : `#${ch.name}`) : t('Unknown')}</b>
                  <span className="muted-text">
                    {timeAgo(h.startedAt)} · {h.endedAt ? duration(h.endedAt - h.startedAt) : t('in progress')}
                  </span>
                </div>
                <span className="huddle-row-faces">
                  {h.participantIds.slice(0, 4).map((id) => (
                    <Avatar key={id} userId={id} size={24} />
                  ))}
                </span>
              </button>
            );
          })
        )}
      </div>
    </main>
  );
}
