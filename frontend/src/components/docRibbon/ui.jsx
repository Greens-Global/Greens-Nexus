// The Word-style ribbon's building blocks (Pranshu, Nov 4 2026: "check the
// ribbons which Word Online has and get the missing ones into the Documents
// module"). A ribbon tab is a row of GROUPS, each a cluster of buttons with
// its caption underneath; a big button carries its label, a small one its
// icon and a title. Menus open under their button and close on an outside
// click or Escape. Styles are the `.doc-ribbon*` rules in style.css.
//
// Menus (Neil, 11/10/2026: "make sure the menus are better and robust") open
// through AnchoredMenu: rendered at the top of the page, so no toolbar edge,
// scroller or card clips them; flipped above the button when there is more
// room there; never off screen; scrolling inside when tall. Arrow keys,
// Home / End move through the items, Tab and Escape close and hand focus
// back to the button, and opening one closes any other. The panel carries
// `doc-toolbar doc-ribbon` so every ribbon button rule still styles what is
// inside it (`.doc-ribbon-panel.doc-toolbar` resets the shape, style.css).
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownRight, ChevronDown, MoreHorizontal, Search } from 'lucide-react';
import AnchoredMenu from '../AnchoredMenu';

// `onLaunch` draws Word's dialog launcher - the small arrow in the group's
// corner that opens the whole dialog (Font, Paragraph, Page Setup).
export function Group({ label, children, className = '', onLaunch, launchTitle }) {
  return (
    <div className={`doc-ribbon-group ${className}`.trim()}>
      <div className="doc-ribbon-items">{children}</div>
      {label && (
        <div className="doc-ribbon-caption">
          {label}
          {onLaunch && (
            <button type="button" className="doc-ribbon-launch" onClick={onLaunch} title={launchTitle || `${label} Settings`} aria-label={launchTitle || `${label} Settings`}>
              <ArrowDownRight size={10} />
            </button>
          )}
        </div>
      )}
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

// The items a keyboard steps through in an open menu.
const FOCUSABLE = 'button:not(:disabled), [role="menuitem"]:not([aria-disabled="true"]), input:not([type="hidden"]):not(:disabled), select:not(:disabled), label.doc-ribbon-item';
const TYPING = /^(INPUT|SELECT|TEXTAREA)$/;

// Arrow keys / Home / End / Tab inside an open menu panel.
export function menuKeys(e, close) {
  const items = [...e.currentTarget.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!items.length) return;
  const at = items.indexOf(document.activeElement);
  const typing = TYPING.test(e.target.tagName) && e.target.type !== 'checkbox' && e.target.type !== 'color';
  const go = (i) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
  if (e.key === 'ArrowDown' && !(typing && e.target.tagName === 'SELECT')) go(at + 1);
  else if (e.key === 'ArrowUp' && !(typing && e.target.tagName === 'SELECT')) go(at < 0 ? items.length - 1 : at - 1);
  else if (e.key === 'Home' && !typing) go(0);
  else if (e.key === 'End' && !typing) go(items.length - 1);
  else if (e.key === 'Tab') { e.preventDefault(); close(true); }
}

// The panel every ribbon menu opens: AnchoredMenu plus the keyboard rules.
// `close(refocus)` hands focus back to the button when the keyboard closed it.
export function RibbonPanel({ anchorRef, open, onClose, width, align = 'left', className = '', children, focusFirst = false, ...rest }) {
  const id = useId();
  const close = useCallback((refocus) => { onClose(); if (refocus) anchorRef.current?.focus(); }, [onClose, anchorRef]);
  // A menu opened from the keyboard puts focus on its first item, as Word does.
  useEffect(() => {
    if (!open || !focusFirst) return undefined;
    const t = requestAnimationFrame(() => document.getElementById(id)?.querySelector(FOCUSABLE)?.focus());
    return () => cancelAnimationFrame(t);
  }, [open, focusFirst, id]);
  return (
    <AnchoredMenu anchorRef={anchorRef} open={open} onClose={() => close(false)} id={id} align={align === 'right' ? 'end' : 'start'}
      className={`doc-toolbar doc-ribbon doc-ribbon-panel ${className}`.trim()} style={width ? { width } : undefined}
      onKeyDown={(e) => menuKeys(e, close)} {...rest}>
      {typeof children === 'function' ? children(close) : children}
    </AnchoredMenu>
  );
}

// A button that opens a panel under itself. `items` draws a plain list
// ({ label, onClick, active, disabled, title, icon }); `children` draws
// anything else (a color grid, a table picker). `big` draws the Word-style
// labeled button, else a small one.
export function Menu({ icon: Icon, label, title, items, children, big = false, active, disabled, width, align = 'left', onOpenChange, panelClassName = '' }) {
  const [open, setOpen] = useState(false);
  const [byKey, setByKey] = useState(false);
  const btnRef = useRef(null);
  const onOpenRef = useRef(onOpenChange);
  useLayoutEffect(() => { onOpenRef.current = onOpenChange; });
  const set = useCallback((next) => { setOpen(next); onOpenRef.current?.(next); }, []);
  const close = useCallback((refocus) => { set(false); if (refocus === true) btnRef.current?.focus(); }, [set]);
  const toggle = () => { setByKey(false); set(!open); };
  // Enter / Space / Arrow Down open it from the keyboard with the first item focused.
  const onKey = (e) => {
    if (open || disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setByKey(true); set(true); }
  };
  const btnProps = { type: 'button', title: title || label, onClick: toggle, onKeyDown: onKey, disabled, 'aria-haspopup': 'menu', 'aria-expanded': open };
  return (
    <div className="doc-ribbon-menu">
      {big ? (
        <button ref={btnRef} {...btnProps} className={`doc-ribbon-big${active || open ? ' is-active' : ''}`}>
          {Icon && <Icon size={20} />}
          <span>{label} <ChevronDown size={11} /></span>
        </button>
      ) : (
        <button ref={btnRef} {...btnProps} className={`doc-ribbon-small doc-ribbon-small-menu${active || open ? ' is-active' : ''}`} aria-label={title || label}>
          {Icon ? <Icon size={15} /> : <span className="doc-ribbon-small-text">{label}</span>}
          <ChevronDown size={10} />
        </button>
      )}
      <RibbonPanel anchorRef={btnRef} open={open} onClose={close} width={width} align={align} focusFirst={byKey} className={panelClassName}>
        {(closePanel) => (
          <>
            {items && items.map((it, i) => (it === '-' ? <div key={i} className="doc-ribbon-sep" role="separator" /> : (
              <button key={it.label} type="button" role="menuitem" className={`doc-ribbon-item${it.active ? ' is-active' : ''}`}
                title={it.title} disabled={it.disabled} aria-checked={it.active ? 'true' : undefined}
                onClick={() => { it.onClick?.(); if (!it.keepOpen) closePanel(true); }}>
                {it.icon && <it.icon size={14} />}
                {it.swatch && <span className="doc-ribbon-swatch" style={{ background: it.swatch }} />}
                <span>{it.label}</span>
                {it.hint && <span className="doc-ribbon-item-hint">{it.hint}</span>}
              </button>
            )))}
            {typeof children === 'function' ? children(() => closePanel(true)) : children}
          </>
        )}
      </RibbonPanel>
    </div>
  );
}

// A searchable, grouped pick list behind a button that shows the current
// choice - the Font box, Insert A Variable. `groups` is [[heading, [[value,
// label]]]]; `preview(value)` styles a row (a font shown in its own face).
export function PickList({ label, value, placeholder, groups, onPick, preview, ariaLabel, width = 240, buttonWidth, searchable = true, emptyLabel, disabled }) {
  const [open, setOpen] = useState(false);
  const [byKey, setByKey] = useState(false);
  const [q, setQ] = useState('');
  const btnRef = useRef(null);
  const close = useCallback((refocus) => { setOpen(false); setQ(''); if (refocus === true) btnRef.current?.focus(); }, []);
  const needle = q.trim().toLowerCase();
  const shown = groups.map(([h, rows]) => [h, needle ? rows.filter(([v, l]) => `${l} ${v}`.toLowerCase().includes(needle)) : rows]).filter(([, rows]) => rows.length);
  const first = shown[0]?.[1][0];
  return (
    <div className="doc-ribbon-menu">
      <button ref={btnRef} type="button" className="doc-ribbon-pick" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel || label}
        title={ariaLabel || label} disabled={disabled} style={buttonWidth ? { width: buttonWidth } : undefined}
        onClick={() => { setByKey(false); setOpen((o) => !o); }}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setByKey(true); setOpen(true); } }}>
        <span className="doc-ribbon-pick-value" style={value && preview ? preview(value) : undefined}>{label || placeholder}</span>
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      <RibbonPanel anchorRef={btnRef} open={open} onClose={close} width={width} focusFirst={byKey || searchable} className="doc-ribbon-picklist" role="listbox">
        {(closePanel) => (
          <>
            {searchable && (
              <div className="doc-ribbon-pick-search">
                <Search size={13} aria-hidden="true" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label={`Search ${ariaLabel || label || ''}`.trim()}
                  onKeyDown={(e) => { if (e.key === 'Enter' && first) { e.preventDefault(); onPick(first[0]); closePanel(true); } }} />
              </div>
            )}
            {emptyLabel && !needle && (
              <button type="button" role="option" aria-selected={!value} className={`doc-ribbon-item${!value ? ' is-active' : ''}`} onClick={() => { onPick(''); closePanel(true); }}>
                <span>{emptyLabel}</span>
              </button>
            )}
            {shown.map(([heading, rows]) => (
              <div key={heading || 'rows'} role="group" aria-label={heading || undefined}>
                {heading && <div className="doc-ribbon-pick-head">{heading}</div>}
                {rows.map(([v, l]) => (
                  <button key={v} type="button" role="option" aria-selected={value === v} className={`doc-ribbon-item${value === v ? ' is-active' : ''}`}
                    style={preview ? preview(v) : undefined} onClick={() => { onPick(v); closePanel(true); }}>
                    <span>{l}</span>
                  </button>
                ))}
              </div>
            ))}
            {!shown.length && <div className="doc-ribbon-pick-none">Nothing matches.</div>}
          </>
        )}
      </RibbonPanel>
    </div>
  );
}

// Word's font size box: type a size and press Enter, or pick one from the list.
export function SizeBox({ value, sizes, onPick, ariaLabel = 'Font Size', min = 1, max = 400 }) {
  const [draft, setDraft] = useState(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const close = useCallback((refocus) => { setOpen(false); if (refocus === true) inputRef.current?.focus(); }, []);
  const commit = () => {
    if (draft == null) return;
    const n = Number(String(draft).replace(/[^\d.]/g, ''));
    setDraft(null);
    if (!draft.trim()) { onPick(''); return; }
    if (Number.isFinite(n) && n > 0) { const size = Math.round(Math.min(max, Math.max(min, n)) * 2) / 2; onPick(String(size)); }
  };
  return (
    <div className="doc-ribbon-menu doc-ribbon-sizebox" ref={wrapRef}>
      <input ref={inputRef} aria-label={ariaLabel} title={ariaLabel} inputMode="decimal" placeholder="Size"
        value={draft ?? value ?? ''} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); e.currentTarget.blur(); }
          else if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); }
          else if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); setOpen(true); }
        }} />
      <button type="button" className="doc-ribbon-sizebox-btn" aria-label={`${ariaLabel} List`} aria-haspopup="listbox" aria-expanded={open} tabIndex={-1}
        onClick={() => setOpen((o) => !o)}><ChevronDown size={10} /></button>
      <RibbonPanel anchorRef={wrapRef} open={open} onClose={close} width={88} className="doc-ribbon-picklist" role="listbox">
        {(closePanel) => sizes.map((s) => (
          <button key={s} type="button" role="option" aria-selected={String(value) === String(s)} className={`doc-ribbon-item${String(value) === String(s) ? ' is-active' : ''}`}
            onClick={() => { onPick(String(s)); closePanel(true); }}><span>{s}</span></button>
        ))}
      </RibbonPanel>
    </div>
  );
}

// The ribbon row, never wrapped onto a second line (Neil, 11/10/2026): the
// groups that do not fit move, in order, into a More menu at its end - Word's
// own collapsing ribbon. `render()` draws the tab's groups; it is drawn again
// inside More while that is open, showing only the groups the row hid.
export function RibbonBar({ render, tabKey, className = '', ...rest }) {
  const barRef = useRef(null);
  const moreRef = useRef(null);
  const [hideFrom, setHideFrom] = useState(-1);   // index of the first hidden group, -1 = all fit
  // Open for one tab only: switching tabs closes More with no effect needed.
  const [openFor, setOpenFor] = useState(null);
  const open = openFor !== null && openFor === tabKey;
  const setOpen = (fn) => setOpenFor((cur) => ((typeof fn === 'function' ? fn(cur !== null && cur === tabKey) : fn) ? tabKey : null));
  const close = useCallback((refocus) => { setOpenFor(null); if (refocus === true) moreRef.current?.focus(); }, []);

  const fit = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;
    const kids = [...bar.children].filter((c) => !c.classList.contains('doc-ribbon-more'));
    kids.forEach((c) => c.classList.remove('is-overflow'));
    const cs = getComputedStyle(bar);
    const room = bar.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    const widths = kids.map((c) => c.getBoundingClientRect().width);
    const total = widths.reduce((a, b) => a + b, 0);
    let cut = -1;
    if (total > room + 1) {
      const moreW = 64;
      let used = 0;
      cut = 0;
      while (cut < kids.length && used + widths[cut] <= room - moreW) { used += widths[cut]; cut += 1; }
      cut = Math.max(1, cut);
    }
    if (cut >= 0) kids.slice(cut).forEach((c) => c.classList.add('is-overflow'));
    setHideFrom((h) => (h === cut ? h : cut));
  }, []);

  // Every render: a group can change width (a picked font name, a context tab).
  useLayoutEffect(() => { fit(); });
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => fit());
    ro.observe(bar);
    return () => ro.disconnect();
  }, [fit]);

  return (
    <div ref={barRef} className={`doc-toolbar doc-ribbon doc-ribbon-bar ${className}`.trim()} {...rest}>
      {render()}
      {hideFrom >= 0 && (
        <div className="doc-ribbon-group doc-ribbon-more">
          <div className="doc-ribbon-items">
            <button ref={moreRef} type="button" className={`doc-ribbon-big${open ? ' is-active' : ''}`} aria-haspopup="menu" aria-expanded={open}
              title="More tools from this tab" onClick={() => setOpen((o) => !o)}>
              <MoreHorizontal size={20} /><span>More <ChevronDown size={11} /></span>
            </button>
          </div>
          <div className="doc-ribbon-caption">&nbsp;</div>
        </div>
      )}
      {/* A command run from More closes it; a button that opens its own menu keeps it. */}
      <RibbonPanel anchorRef={moreRef} open={open && hideFrom >= 0} onClose={close} align="right" className="doc-ribbon-overflow" role="toolbar" aria-label="More tools">
        {() => (
          <div className="doc-ribbon-overflow-body" ref={(el) => {
            if (!el) return;
            [...el.children].forEach((c, i) => { c.style.display = i < hideFrom ? 'none' : ''; });
          }}
          onClick={(e) => { const b = e.target.closest('button'); if (b && !b.hasAttribute('aria-haspopup') && !b.closest('.nx-anchored:not(.doc-ribbon-overflow)')) close(false); }}>
            {render()}
          </div>
        )}
      </RibbonPanel>
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
