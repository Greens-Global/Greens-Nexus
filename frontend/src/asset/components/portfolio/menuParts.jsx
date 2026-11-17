import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import AnchoredMenu from '../../../components/AnchoredMenu';

// The pieces every menu on the register shares (Views, Group By, Sort, Columns, the bulk
// actions): a floating panel (a menu floats, so it may carry a hairline and a shadow), rows
// with a check for the picked one and a quiet count on the right, a plain heading, a hairline.
// Arrow keys, Home and End walk the rows; Escape closes (AnchoredMenu) and gives focus back.

export const MENU_PANEL = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10,
  boxShadow: 'var(--shadow-menu, var(--shadow-lg))', padding: 6,
};

const ROW_SEL = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';

/** Up / Down / Home / End across a panel's rows. */
export function menuKeys(e) {
  if (e.target.tagName === 'INPUT' && e.key !== 'ArrowDown') return;   // typing keeps Home / End
  const panel = e.currentTarget;
  const rows = [...panel.querySelectorAll(ROW_SEL)].filter((r) => !r.disabled);
  if (!rows.length) return;
  const at = rows.indexOf(document.activeElement);
  const to = { ArrowDown: at + 1, ArrowUp: at < 0 ? rows.length - 1 : at - 1, Home: 0, End: rows.length - 1 }[e.key];
  if (to == null) return;
  e.preventDefault();
  rows[(to + rows.length) % rows.length].focus();
}

/** Focus the first row (or the picked one) once a panel opens from the keyboard or a click. */
export function focusFirst(ref) {
  setTimeout(() => {
    const panel = ref?.current;
    if (!panel) return;
    const on = panel.querySelector('[data-autofocus]') || panel.querySelector('[aria-checked="true"]') || panel.querySelector(ROW_SEL);
    on?.focus();
  }, 30);
}

/** Open state for a menu whose first row takes focus as it opens. */
export function useMenu() {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const panel = useRef(null);
  useEffect(() => { if (open) focusFirst(panel); }, [open]);
  const close = (refocus = true) => { setOpen(false); if (refocus) btn.current?.focus(); };
  return { open, setOpen, btn, panel, close };
}

export function MenuHeading({ children }) {
  return <div className="pt-menu-heading" role="presentation">{children}</div>;
}

export function MenuSep() {
  return <div className="pt-menu-sep" role="separator" />;
}

/** A row: a check when `checked` (radio rows), the words, a quiet count or hint on the right. */
export function MenuItem({ children, onClick, checked, radio = false, count, hint, tone, disabled, Icon, title }) {
  const role = radio ? 'menuitemradio' : checked !== undefined ? 'menuitemcheckbox' : 'menuitem';
  return (
    <button type="button" role={role} aria-checked={checked === undefined ? undefined : !!checked} disabled={disabled} title={title}
      className={`pt-menu-row${tone ? ` is-${tone}` : ''}`} onClick={onClick}>
      <span className="pt-menu-check" aria-hidden="true">{checked ? <Check size={14} /> : Icon ? <Icon size={14} /> : null}</span>
      <span className="pt-menu-words">{children}</span>
      {hint ? <span className="pt-menu-hint">{hint}</span> : null}
      {count !== undefined && count !== null ? <span className={`pt-menu-count${count === 0 ? ' is-zero' : ''}`}>{count}</span> : null}
    </button>
  );
}

/**
 * A quiet "Label Value v" button that opens a menu of choices (Group by Stage, Sort Name).
 * options: [[key, label]]; value: the picked key.
 */
export function PickMenu({ label, value, options, onPick, minWidth = 200 }) {
  const { open, setOpen, btn, panel, close } = useMenu();
  const current = (options.find(([k]) => k === value) || options[0] || [])[1];
  return (
    <>
      <button ref={btn} type="button" className="pt-pick" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}>
        <span className="pt-pick-label">{label}</span> <b>{current}</b>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)} minWidth={minWidth} style={MENU_PANEL} aria-label={label}>
        <div ref={panel} onKeyDown={menuKeys}>
          {options.map(([k, l]) => (
            <MenuItem key={k} radio checked={k === value} onClick={() => { close(); onPick(k); }}>{l}</MenuItem>
          ))}
        </div>
      </AnchoredMenu>
    </>
  );
}
