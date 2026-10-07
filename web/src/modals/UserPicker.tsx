import { useMemo, useRef, useState } from 'react';
import { X } from '../components/icons.tsx';
import { displayName, useStore } from '../store.ts';
import { t } from '../i18n.ts';
import { Avatar, UserPresenceDot } from '../components/ui.tsx';

export function UserPicker({
  value,
  onChange,
  exclude = [],
  placeholder,
  autoFocus = true,
  max,
  onEnter,
  allowExternal = false,
}: {
  allowExternal?: boolean;
  value: string[];
  onChange: (ids: string[]) => void;
  exclude?: string[];
  placeholder?: string;
  autoFocus?: boolean;
  max?: number;
  onEnter?: () => void;
}) {
  const users = useStore((s) => s.users);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const options = useMemo(() => {
    const term = q.toLowerCase();
    return Object.values(users)
      .filter((u) => !u.deactivated && (u.external !== 'slack' || allowExternal) && !exclude.includes(u.id) && !value.includes(u.id))
      .filter((u) => !term || `${u.fullName} ${u.displayName} ${u.username} ${u.email ?? ''}`.toLowerCase().includes(term))
      .sort((a, b) => displayName(a).localeCompare(displayName(b)))
      .slice(0, 8);
  }, [users, q, exclude, value]);

  const add = (id: string) => {
    if (max && value.length >= max) return;
    onChange([...value, id]);
    setQ('');
    setSel(0);
    input.current?.focus();
  };

  return (
    <div className="user-picker">
      <div className="up-field" onClick={() => input.current?.focus()}>
        {value.map((id) => (
          <span key={id} className="up-chip">
            <Avatar userId={id} size={18} />
            {displayName(users[id])}
            <button onClick={() => onChange(value.filter((x) => x !== id))} aria-label={t('Remove')}>
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          autoFocus={autoFocus}
          value={q}
          placeholder={value.length ? '' : placeholder ?? t('Type the name of a person')}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, options.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (q && options[sel]) add(options[sel].id);
              else onEnter?.();
            } else if (e.key === 'Backspace' && !q && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
        />
      </div>
      {(q || !value.length) && options.length > 0 && (
        <div className="up-options">
          {options.map((u, i) => (
            <button key={u.id} className={`up-option${i === sel ? ' selected' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => add(u.id)}>
              <Avatar user={u} size={24} />
              <span className="up-name">{displayName(u)}</span>
              <UserPresenceDot userId={u.id} />
              <span className="up-sub">{u.fullName !== displayName(u) ? u.fullName : u.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
