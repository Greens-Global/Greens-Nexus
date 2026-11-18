// The small parts the portfolio-wide tabs share (Overview, Fleet, Development, Maintenance,
// Dates, Activity - Neil, 11/17/2026): the summary sentence, the toolbar's search box, the
// segmented control, the Filters popover, hairline tables and plain-word colors. House rules:
// no boxes or tinted panels per section, no pills, no uppercase, type on the scale.

import { useRef, useState, Fragment } from 'react';
import { Search, SlidersHorizontal, Check } from 'lucide-react';
import AnchoredMenu from '../../../components/AnchoredMenu';

export const C = {
  ink: 'var(--text-primary)',
  muted: 'var(--text-secondary)',
  faint: 'var(--text-muted)',
  line: 'var(--border-color)',
  red: 'hsl(var(--color-red))',
  orange: 'hsl(var(--color-orange))',
  green: 'hsl(var(--color-green))',
  blue: 'hsl(var(--color-blue))',
  live: 'var(--wk-live-ink)',
};

/** A tone word -> its color ('quiet' = the muted ink). */
export const toneColor = (tone) => ({ red: C.red, orange: C.orange, green: C.green, blue: C.blue, live: C.live, quiet: C.muted, faint: C.faint })[tone] || C.ink;

/** One summary sentence: its clauses joined by a quiet dot; empty clauses dropped. */
export function Sentence({ parts, size = 15, style }) {
  const list = (parts || []).filter(Boolean);
  if (!list.length) return null;
  return (
    <div data-summary style={{ fontSize: size, fontWeight: 500, color: C.ink, lineHeight: 1.5, ...style }}>
      {list.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden="true" style={{ color: C.faint, margin: '0 8px' }}>·</span>}
          {p}
        </Fragment>
      ))}
    </div>
  );
}

/** A text button that reads as a link (green, never underlined until hover). */
export function LinkButton({ children, onClick, tone = 'green', style, ...rest }) {
  return (
    <button type="button" onClick={onClick} {...rest}
      style={{ border: 'none', background: 'none', padding: 0, margin: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 500, color: toneColor(tone), whiteSpace: 'nowrap', ...style }}
      onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
      onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}>
      {children}
    </button>
  );
}

/** The toolbar row under the sentence: left controls, right controls. */
export function Toolbar({ children, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '16px 0 6px' }}>
      {children}
      {right && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>{right}</div>}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder, label }) {
  return (
    <label style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flex: '0 1 320px', minWidth: 180 }}>
      <Search size={15} aria-hidden="true" style={{ position: 'absolute', left: 11, color: C.faint, pointerEvents: 'none' }} />
      <input type="search" className="form-input" value={value} placeholder={placeholder} aria-label={label || placeholder}
        onChange={(e) => onChange(e.target.value)} style={{ paddingLeft: 32, fontSize: 13, width: '100%' }} />
    </label>
  );
}

/** A segmented control (a mode switch, not a tab strip). */
export function Segmented({ value, onChange, options, label }) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'inline-flex', padding: 3, borderRadius: 10, background: 'var(--bg-secondary)', border: `1px solid ${C.line}`, gap: 2, maxWidth: '100%', overflowX: 'auto' }}>
      {options.map((o) => {
        const on = value === o.key;
        return (
          <button key={o.key} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.key)}
            style={{ padding: '5px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: on ? 600 : 500,
              whiteSpace: 'nowrap', background: on ? 'var(--bg-card)' : 'transparent', color: on ? C.ink : C.muted, boxShadow: on ? 'var(--shadow-sm)' : 'none',
              display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {o.icon}{o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The Filters button and its popover: groups of checkable options.
 *   groups  [{ key, title, options: [{ value, label, count? }] }]
 *   value   { [groupKey]: string[] }
 */
export function FilterMenu({ groups, value, onChange }) {
  const btn = useRef(null);
  const [open, setOpen] = useState(false);
  const picked = Object.values(value || {}).reduce((n, l) => n + (l || []).length, 0);
  const toggle = (g, v) => {
    const cur = new Set((value || {})[g] || []);
    if (cur.has(v)) cur.delete(v); else cur.add(v);
    onChange({ ...(value || {}), [g]: [...cur] });
  };
  const shown = (groups || []).filter((g) => g.options.length);
  return (
    <>
      <button ref={btn} type="button" className="secondary-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
        <SlidersHorizontal size={14} /> Filters{picked > 0 && <span style={{ color: C.green, fontWeight: 600 }}>{picked}</span>}
      </button>
      <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)} role="dialog" aria-label="Filters"
        style={{ background: 'var(--bg-card)', border: `1px solid ${C.line}`, borderRadius: 12, boxShadow: 'var(--shadow-lg)', padding: '12px 14px', minWidth: 240, maxWidth: 420 }}>
        {!shown.length && <div style={{ fontSize: 13, color: C.muted }}>Nothing to filter by yet.</div>}
        {shown.map((g, gi) => (
          <div key={g.key} style={{ paddingTop: gi ? 10 : 0, marginTop: gi ? 10 : 0, borderTop: gi ? `1px solid ${C.line}` : 'none' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 4 }}>{g.title}</div>
            {g.options.map((o) => {
              const on = ((value || {})[g.key] || []).includes(o.value);
              return (
                <button key={o.value} type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => toggle(g.key, o.value)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none', background: 'none', padding: '5px 0', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, color: C.ink, textAlign: 'left' }}>
                  <span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: 4, border: `1px solid ${on ? C.green : C.line}`, background: on ? C.green : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {on && <Check size={12} color="#fff" strokeWidth={3} />}
                  </span>
                  <span style={{ flex: 1 }}>{o.label}</span>
                  {o.count != null && <span style={{ color: o.count ? C.muted : C.faint, fontSize: 12 }}>{o.count}</span>}
                </button>
              );
            })}
          </div>
        ))}
        {picked > 0 && (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
            <LinkButton onClick={() => onChange({})}>Clear All</LinkButton>
          </div>
        )}
      </AnchoredMenu>
    </>
  );
}

/** Does an item pass the picked filters? `get(groupKey, item)` returns its value. */
export function passesFilters(item, value, get) {
  return Object.entries(value || {}).every(([k, list]) => !list || !list.length || list.includes(get(k, item)));
}

// ── Hairline tables ─────────────────────────────────────────────────────────
export const th = { textAlign: 'left', fontSize: 12, fontWeight: 500, color: C.muted, padding: '10px 12px', borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap' };
export const td = { padding: '11px 12px', borderBottom: `1px solid ${C.line}`, fontSize: 13, color: C.ink, verticalAlign: 'middle' };
export const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

export function Table({ head, children, label, minWidth = 720 }) {
  return (
    <div style={{ overflowX: 'auto', margin: '6px 0 0' }}>
      <table aria-label={label} style={{ width: '100%', minWidth, borderCollapse: 'collapse' }}>
        <thead>
          <tr>{head.map((h) => <th key={h.key || h.label} scope="col" style={{ ...th, ...(h.num ? num : {}), ...(h.style || {}) }}>{h.label}</th>)}</tr>
        </thead>
        {children}
      </table>
    </div>
  );
}

/** A clickable body row: the whole row opens, Enter too. */
export function RowButton({ onOpen, children, label, style }) {
  return (
    <tr tabIndex={0} aria-label={label} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen?.(); }}
      style={{ cursor: 'pointer', ...style }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-secondary)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
      {children}
    </tr>
  );
}

/** A group label inside a table ("Entitlement 5"), on its own row. */
export function GroupRow({ cols, label, count, tone }) {
  return (
    <tr>
      <td colSpan={cols} style={{ padding: '18px 12px 8px', borderBottom: `1px solid ${C.line}`, fontSize: 13 }}>
        <span style={{ fontWeight: 600, color: tone ? toneColor(tone) : C.ink }}>{label}</span>
        {count != null && <span style={{ color: C.muted, marginLeft: 6 }}>{count}</span>}
      </td>
    </tr>
  );
}

/** A 48x34 photo (cover for a property, contain on white for a vehicle). */
export function Thumb({ src, contain = false }) {
  return (
    <span aria-hidden="true" style={{
      width: 48, height: 34, borderRadius: 6, flexShrink: 0, display: 'inline-block',
      background: src ? `${contain ? '#fff' : 'var(--bg-secondary)'} url("${String(src).replace(/"/g, '%22')}") center / ${contain ? 'contain' : 'cover'} no-repeat` : 'var(--bg-secondary)',
      border: contain ? `1px solid ${C.line}` : 'none',
    }} />
  );
}

/** The two-line name cell: photo, name, a quiet line under it. */
export function NameCell({ src, contain, name, sub }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      <Thumb src={src} contain={contain} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        {sub && <div style={{ fontSize: 12, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>}
      </div>
    </div>
  );
}

export const Faint = ({ children = 'Not set' }) => <span style={{ color: C.faint }}>{children}</span>;

/** A quiet line under a list (empty states, notes). */
export function Quiet({ children, style }) {
  return <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, padding: '14px 0', ...style }}>{children}</div>;
}

/** The asset's photo: its first image. */
export const photoOf = (a) => {
  const first = a && Array.isArray(a.images) ? a.images[0] : '';
  const src = (first && (typeof first === 'string' ? first : first.url)) || (a && a.image) || '';
  return typeof src === 'string' ? src : '';
};

/** "Not Set"-safe names: "  neil  kadakia " -> "Neil Kadakia" key "neil kadakia". */
export const personKey = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
