// The Word-style ribbon's building blocks (Pranshu, Nov 4 2026: "check the
// ribbons which Word Online has and get the missing ones into the Documents
// module"). A ribbon tab is a row of GROUPS, each a cluster of buttons with
// its caption underneath; a big button carries its label, a small one its
// icon and a title. Menus open under their button and close on an outside
// click or Escape. Styles are the `.doc-ribbon*` rules in style.css.
import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export function Group({ label, children, className = '' }) {
  return (
    <div className={`doc-ribbon-group ${className}`.trim()}>
      <div className="doc-ribbon-items">{children}</div>
      {label && <div className="doc-ribbon-caption">{label}</div>}
    </div>
  );
}

export function BigBtn({ icon: Icon, label, title, onClick, onDoubleClick, active, disabled }) {
  return (
    <button type="button" className={`doc-ribbon-big${active ? ' is-active' : ''}`} title={title || label}
      onClick={onClick} onDoubleClick={onDoubleClick} disabled={disabled} aria-pressed={active ? 'true' : undefined}>
      {Icon && <Icon size={20} />}
      <span>{label}</span>
    </button>
  );
}

export function SmallBtn({ icon: Icon, title, onClick, active, disabled, children }) {
  return (
    <button type="button" className={`doc-ribbon-small${active ? ' is-active' : ''}`} title={title}
      onClick={onClick} disabled={disabled} aria-label={title} aria-pressed={active ? 'true' : undefined}>
      {Icon ? <Icon size={15} /> : children}
    </button>
  );
}

// Closes `onClose` on an outside click or Escape while `open`.
export function useDismiss(ref, open, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [ref, open, onClose]);
}

// A button that opens a panel under itself. `items` draws a plain list
// ({ label, onClick, active, disabled, title, icon }); `children` draws
// anything else (a color grid, a table picker). `big` draws the Word-style
// labeled button, else a small one.
export function Menu({ icon: Icon, label, title, items, children, big = false, active, disabled, width, align = 'left', onOpenChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = () => { setOpen(false); onOpenChange?.(false); };
  useDismiss(ref, open, close);
  const toggle = () => { setOpen((o) => { onOpenChange?.(!o); return !o; }); };
  return (
    <div className="doc-ribbon-menu" ref={ref}>
      {big ? (
        <button type="button" className={`doc-ribbon-big${active || open ? ' is-active' : ''}`} title={title || label} onClick={toggle} disabled={disabled} aria-haspopup="true" aria-expanded={open}>
          {Icon && <Icon size={20} />}
          <span>{label} <ChevronDown size={11} /></span>
        </button>
      ) : (
        <button type="button" className={`doc-ribbon-small doc-ribbon-small-menu${active || open ? ' is-active' : ''}`} title={title || label} onClick={toggle} disabled={disabled} aria-haspopup="true" aria-expanded={open} aria-label={title || label}>
          {Icon ? <Icon size={15} /> : <span className="doc-ribbon-small-text">{label}</span>}
          <ChevronDown size={10} />
        </button>
      )}
      {open && (
        <div className="doc-ribbon-panel" style={{ width, [align === 'right' ? 'right' : 'left']: 0 }} role="menu">
          {items && items.map((it, i) => (it === '-' ? <div key={i} className="doc-ribbon-sep" /> : (
            <button key={it.label} type="button" role="menuitem" className={`doc-ribbon-item${it.active ? ' is-active' : ''}`}
              title={it.title} disabled={it.disabled}
              onClick={() => { it.onClick?.(); if (!it.keepOpen) close(); }}>
              {it.icon && <it.icon size={14} />}
              {it.swatch && <span className="doc-ribbon-swatch" style={{ background: it.swatch }} />}
              <span>{it.label}</span>
            </button>
          )))}
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}

// Word's color palettes: the theme row and the standard row.
export const THEME_COLORS = ['#000000', '#ffffff', '#44546a', '#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47', '#7f7f7f'];
export const STANDARD_COLORS = ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0'];
// Word's 15 highlight colors.
export const HIGHLIGHT_COLORS = [
  ['#ffff00', 'Yellow'], ['#00ff00', 'Bright Green'], ['#00ffff', 'Turquoise'], ['#ff00ff', 'Pink'], ['#0000ff', 'Blue'],
  ['#ff0000', 'Red'], ['#000080', 'Dark Blue'], ['#008080', 'Teal'], ['#008000', 'Green'], ['#800080', 'Violet'],
  ['#800000', 'Dark Red'], ['#808000', 'Dark Yellow'], ['#808080', 'Gray 50%'], ['#c0c0c0', 'Gray 25%'], ['#000000', 'Black'],
];

// A grid of color swatches with "No Color" and (optionally) "More Colors",
// the latter through the browser's own color input.
export function ColorGrid({ rows, onPick, onNone, noneLabel = 'No Color', more = true, current }) {
  const inputRef = useRef(null);
  return (
    <div className="doc-ribbon-colors">
      {rows.map((row, ri) => (
        <div key={ri} className="doc-ribbon-color-row">
          {row.map(([hex, name]) => (
            <button key={hex} type="button" title={name || hex} className={`doc-ribbon-swatch-btn${current === hex ? ' is-active' : ''}`}
              style={{ background: hex }} onClick={() => onPick(hex)} aria-label={name || hex} />
          ))}
        </div>
      ))}
      {onNone && <button type="button" className="doc-ribbon-item" onClick={onNone}>{noneLabel}</button>}
      {more && (
        <label className="doc-ribbon-item" style={{ cursor: 'pointer' }}>
          More Colors…
          <input ref={inputRef} type="color" onChange={(e) => onPick(e.target.value)} style={{ width: 0, height: 0, opacity: 0, position: 'absolute' }} />
        </label>
      )}
    </div>
  );
}

// Word's Insert > Table picker: hover across a 10 x 8 grid, click to insert.
export function TableGrid({ onPick, cols = 10, rows = 8 }) {
  const [hover, setHover] = useState({ r: 0, c: 0 });
  return (
    <div className="doc-ribbon-tablegrid" onMouseLeave={() => setHover({ r: 0, c: 0 })}>
      <div className="doc-ribbon-tablegrid-cells" style={{ gridTemplateColumns: `repeat(${cols}, 16px)` }}>
        {Array.from({ length: rows * cols }, (_, i) => {
          const r = Math.floor(i / cols) + 1, c = (i % cols) + 1;
          const on = r <= hover.r && c <= hover.c;
          return (
            <button key={i} type="button" className={`doc-ribbon-tablegrid-cell${on ? ' is-on' : ''}`}
              onMouseEnter={() => setHover({ r, c })} onFocus={() => setHover({ r, c })}
              onClick={() => onPick(r, c)} aria-label={`${r} by ${c} table`} />
          );
        })}
      </div>
      <div className="doc-ribbon-tablegrid-label">{hover.r && hover.c ? `${hover.c} x ${hover.r} Table` : 'Insert Table'}</div>
    </div>
  );
}
