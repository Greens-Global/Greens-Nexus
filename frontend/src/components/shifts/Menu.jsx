// Small menu primitives for the Shifts module (Oct 2026): a popover anchored
// to its button, and a context menu at a point. Both close on an outside
// press or Escape, trap Tab, and move with the arrow keys - the old shift
// menu was mouse-only (Shifts QA 24).
import { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';

export const POP = { position: 'absolute', zIndex: 1300, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10,
  boxShadow: '0 12px 32px rgba(0,0,0,0.16)', fontFamily: 'Inter,sans-serif', padding: '4px 0' };
export const ITEM = { display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 12px', border: 'none', background: 'none',
  cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit', color: 'var(--ink)', textAlign: 'left', whiteSpace: 'nowrap' };
export const HEAD = { fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', padding: '8px 12px 4px' };

export function useDismiss(open, onClose) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [open, onClose]);
  return ref;
}

// Arrow keys between the items of a role="menu"; Home/End; Tab stays inside.
export function menuKeys(e) {
  const items = [...e.currentTarget.querySelectorAll('[role^="menuitem"]:not(:disabled)')];
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(items.length - 1);
  else if (e.key === 'Tab') go(i + (e.shiftKey ? -1 : 1));
}

// A button that opens a menu under itself. `items` = [{ key, label, Icon,
// hint, danger, disabled, onClick, checked }] or 'sep' or { head: 'Section' }.
// An item with a boolean `checked` is a switch (menuitemcheckbox).
export function MenuButton({ label, Icon, items, className = 'secondary-btn', align = 'left', ariaLabel, badge, primary = false, disabled = false, style, width = 220, children }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const listRef = useRef(null);
  useEffect(() => { if (open) listRef.current?.querySelector('[role^="menuitem"]:not(:disabled)')?.focus(); }, [open]);
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" className={primary ? 'primary-btn' : className} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel} disabled={disabled}
        style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, ...style }}>
        {Icon && <Icon size={14} />}{label}{badge}{children}{label && <ChevronDown size={13} />}
      </button>
      {open && (
        <div ref={listRef} role="menu" aria-label={ariaLabel || label} onKeyDown={menuKeys}
          style={{ ...POP, top: 'calc(100% + 6px)', [align]: 0, minWidth: width }}>
          {items.map((it, i) => (it === 'sep' ? <div key={`sep${i}`} style={{ height: 1, background: 'var(--line)', margin: '4px 0' }} />
            : it.head ? <div key={`h${i}`} style={HEAD}>{it.head}</div>
              : (
                <button key={it.key || it.label} type="button" role={typeof it.checked === 'boolean' ? 'menuitemcheckbox' : 'menuitem'}
                  aria-checked={typeof it.checked === 'boolean' ? it.checked : undefined} disabled={it.disabled} title={it.title}
                  onClick={() => { setOpen(false); it.onClick?.(); }} className="shift-menu-item"
                  style={{ ...ITEM, color: it.danger ? 'hsl(var(--color-red))' : it.disabled ? 'var(--muted)' : 'var(--ink)', opacity: it.disabled ? 0.55 : 1, cursor: it.disabled ? 'default' : 'pointer' }}>
                  {it.Icon && <it.Icon size={14} />} <span style={{ flex: 1 }}>{it.label}</span>
                  {it.hint && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{it.hint}</span>}
                  {typeof it.checked === 'boolean' && <Switch on={it.checked} />}
                </button>
              )))}
        </div>
      )}
    </span>
  );
}

// A menu at a point (right-click or long-press): a full-screen catcher
// closes it on any press outside.
export function ContextMenu({ x, y, label, onClose, children, width = 230 }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector('[role^="menuitem"]:not(:disabled)')?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const left = Math.max(8, Math.min(x, (window.innerWidth || 1000) - width - 12));
  const top = Math.max(8, Math.min(y, (window.innerHeight || 800) - 380));
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1500 }} onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div ref={ref} role="menu" aria-label={label} onPointerDown={(e) => e.stopPropagation()} onKeyDown={menuKeys}
        style={{ ...POP, position: 'fixed', left, top, width, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' }}>
        {children}
      </div>
    </div>
  );
}

export function MenuItem({ Icon, label, hint, danger, disabled, onClick, role = 'menuitem', checked }) {
  return (
    <button type="button" role={role} aria-checked={role === 'menuitemradio' ? !!checked : undefined} disabled={disabled} onClick={onClick} className="shift-menu-item"
      style={{ ...ITEM, color: danger ? 'hsl(var(--color-red))' : disabled ? 'var(--muted)' : 'var(--ink)', opacity: disabled ? 0.55 : 1, cursor: disabled ? 'default' : 'pointer' }}>
      {Icon ? <Icon size={14} /> : role === 'menuitemradio' ? <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center', fontWeight: 800 }}>{checked ? '✓' : ''}</span> : null}
      <span style={{ flex: 1 }}>{label}</span>
      {hint && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{hint}</span>}
    </button>
  );
}
export const MenuSep = () => <div style={{ height: 1, background: 'var(--line)', margin: '4px 0' }} />;
export const MenuHead = ({ children }) => <div style={HEAD}>{children}</div>;

// The small on/off switch a checkbox menu item wears.
export const Switch = ({ on }) => (
  <span aria-hidden="true" style={{ width: 26, height: 15, borderRadius: 999, background: on ? 'var(--wk-brand)' : 'var(--line)', position: 'relative', flexShrink: 0, transition: 'background .15s' }}>
    <span style={{ position: 'absolute', top: 2, left: on ? 13 : 2, width: 11, height: 11, borderRadius: '50%', background: '#fff', transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,.2)' }} />
  </span>
);
