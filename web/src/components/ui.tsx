import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, X } from './icons.tsx';
import type { User } from '../../../shared/types.ts';
import { assetUrl } from '../api.ts';
import { displayName, useStore } from '../store.ts';
import { t } from '../i18n.ts';
import { Emoji } from '../lib/mrkdwn.tsx';

// ---------- Avatar ----------

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function Avatar({ user, userId, size = 36, presence, className = '', onClick }: { user?: User | null; userId?: string | null; size?: number; presence?: boolean; className?: string; onClick?: (e: React.MouseEvent) => void }) {
  const fromStore = useStore((s) => (userId ? s.users[userId] : undefined));
  const u = user ?? fromStore;
  const agentEmoji = useStore((s) => (u ? s.agents[u.id]?.avatarEmoji : undefined));
  const online = useStore((s) => (u ? s.presence[u.id] === 'active' || !!s.agents[u.id] : false));
  const radius = '50%';
  const style: CSSProperties = { width: size, height: size, borderRadius: radius, fontSize: Math.max(9, size * 0.4) };
  return (
    <span className={`avatar ${className}${onClick ? ' clickable' : ''}${agentEmoji ? ' agent-avatar' : ''}`} style={style} onClick={onClick}>
      {agentEmoji && !u?.avatarUrl ? (
        <span className="avatar-initials avatar-emoji" style={{ background: u?.avatarColor ?? '#888', borderRadius: radius, fontSize: size * 0.58 }}>
          {agentEmoji}
        </span>
      ) : u?.avatarUrl ? (
        <img src={assetUrl(u.avatarUrl)} alt="" style={{ borderRadius: radius }} draggable={false} />
      ) : (
        <span className="avatar-initials" style={{ background: u?.avatarColor ?? '#888', borderRadius: radius }}>
          {u ? initials(displayName(u)) : '?'}
        </span>
      )}
      {presence && u && <PresenceDot online={online} dnd={!!u.dndUntil} className="avatar-presence" />}
    </span>
  );
}

export function PresenceDot({ online, dnd, className = '' }: { online: boolean; dnd?: boolean; className?: string }) {
  return <span className={`presence-dot ${online ? 'online' : 'away'}${dnd ? ' dnd' : ''} ${className}`} />;
}

export function UserPresenceDot({ userId, className }: { userId: string; className?: string }) {
  const online = useStore((s) => s.presence[userId] === 'active' || !!s.agents[userId]);
  const dnd = useStore((s) => !!s.users[userId]?.dndUntil);
  return <PresenceDot online={online} dnd={dnd} className={className} />;
}

export function StatusEmoji({ userId, size = 14 }: { userId: string; size?: number }) {
  const emoji = useStore((s) => s.users[userId]?.statusEmoji);
  const text = useStore((s) => s.users[userId]?.statusText);
  if (!emoji) return null;
  return (
    <span className="status-emoji" title={text}>
      <Emoji code={emoji} size={size} />
    </span>
  );
}

// ---------- Popover ----------

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'left-start' | 'right-end';

export function Popover({
  anchor,
  onClose,
  children,
  placement = 'bottom-start',
  className = '',
  offset = 4,
}: {
  anchor: HTMLElement | DOMRect | { x: number; y: number } | null;
  onClose: () => void;
  children: ReactNode;
  placement?: Placement;
  className?: string;
  offset?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : 'width' in anchor ? anchor : new DOMRect(anchor.x, anchor.y, 0, 0);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = 0;
    let top = 0;
    const [side, align] = placement.split('-') as [string, string];
    if (side === 'bottom' || side === 'top') {
      left = align === 'end' ? r.right - w : r.left;
      top = side === 'bottom' ? r.bottom + offset : r.top - h - offset;
      if (side === 'bottom' && top + h > vh - 8 && r.top - h - offset > 8) top = r.top - h - offset;
      if (side === 'top' && top < 8) top = r.bottom + offset;
    } else {
      left = side === 'right' ? r.right + offset : r.left - w - offset;
      top = align === 'end' ? r.bottom - h : r.top;
      if (side === 'right' && left + w > vw - 8) left = r.left - w - offset;
    }
    left = Math.max(8, Math.min(left, vw - w - 8));
    top = Math.max(8, Math.min(top, vh - h - 8));
    setPos({ left, top });
  }, [anchor, placement, offset]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchor instanceof HTMLElement && anchor.contains(target)) return;
      // clicks inside nested popovers (portals) must not close the parent
      if ((target as HTMLElement).closest?.('.popover')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden' }}>
      {children}
    </div>,
    document.body,
  );
}

export function usePopover<T extends HTMLElement = HTMLButtonElement>() {
  const ref = useRef<T>(null);
  const [open, setOpen] = useState(false);
  return {
    ref,
    open,
    toggle: () => setOpen((o) => !o),
    show: () => setOpen(true),
    close: () => setOpen(false),
  };
}

// ---------- Menu ----------

export function Menu({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`menu ${className}`} role="menu">
      {children}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  icon,
  danger,
  hint,
  disabled,
  right,
  onMouseEnter,
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseEnter?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  icon?: ReactNode;
  danger?: boolean;
  hint?: string;
  disabled?: boolean;
  right?: ReactNode;
}) {
  return (
    <button className={`menu-item${danger ? ' danger' : ''}`} onClick={onClick} onMouseEnter={onMouseEnter} disabled={disabled} role="menuitem">
      {icon && <span className="menu-icon">{icon}</span>}
      <span className="menu-label">{children}</span>
      {hint && <span className="menu-hint">{hint}</span>}
      {right}
    </button>
  );
}

export const MenuSep = () => <div className="menu-sep" />;

export function MenuHeader({ children }: { children: ReactNode }) {
  return <div className="menu-header">{children}</div>;
}

// ---------- Modal ----------

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 520,
  className = '',
  bodyClassName = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
  bodyClassName?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.popover')) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className}`} style={{ width }} role="dialog" aria-modal="true">
        {title !== undefined && (
          <div className="modal-head">
            <div>
              <h2>{title}</h2>
              {subtitle && <div className="modal-subtitle">{subtitle}</div>}
            </div>
            <button className="icon-btn" onClick={onClose} aria-label={t('Close')}>
              <X size={20} />
            </button>
          </div>
        )}
        <div className={`modal-body ${bodyClassName}`}>{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- misc ----------

export function Spinner({ size = 20 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function Toggle({
  checked,
  onChange,
  label,
  ariaLabel,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      {label && <span className="toggle-label">{label}</span>}
    </label>
  );
}

export function Badge({ count, className = '' }: { count: number; className?: string }) {
  if (!count) return null;
  return <span className={`badge ${className}`}>{count > 99 ? '99+' : count}</span>;
}

export function Tip({ label, children, placement = 'top' }: { label: ReactNode; children: ReactNode; placement?: 'top' | 'bottom' | 'right' }) {
  return (
    <span className={`tip tip-${placement}`}>
      {children}
      <span className="tip-label" role="tooltip">
        {label}
      </span>
    </span>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function useInterval(fn: () => void, ms: number) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** Re-renders the component every `ms` (for relative times, typing expiry). */
export function useTick(ms: number) {
  const [, setN] = useState(0);
  useInterval(() => setN((n) => n + 1), ms);
}

/** A menu item that opens a nested menu on hover / click. */
export function SubmenuItem({ label, icon, children }: { label: string; icon?: ReactNode; children: (close: () => void) => ReactNode }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <MenuItem icon={icon} right={<ChevronRight size={14} />} onClick={(e) => setAnchor(e.currentTarget)} onMouseEnter={(e) => setAnchor(e.currentTarget)}>
        {label}
      </MenuItem>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} placement="right-start" offset={0}>
          <Menu>{children(() => setAnchor(null))}</Menu>
        </Popover>
      )}
    </>
  );
}


/** Width of a resizable side panel, persisted in localStorage. */
export function useResizableWidth(key: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem(key));
    return v >= min && v <= max ? v : initial;
  });
  const onDown = (e: React.PointerEvent, dir = 1) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => {
      const w = Math.min(max, Math.max(min, startW + dir * (ev.clientX - startX)));
      setWidth(w);
      localStorage.setItem(key, String(w));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { width, onDown };
}

