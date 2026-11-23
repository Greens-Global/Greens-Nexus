// Operations: the same column controls on every table (Oct 28 2026 call, B5),
// the preset column library (B10) and one Export button (B8).
//   ColumnsButton - show / hide, reorder (drag, or the arrows), add a preset
//                   column, Reset Columns
//   HeaderFilter  - the funnel in a header: words, a range, or tick the values
//   FilterLine    - one quiet line saying what is filtered, with Clear
//   ExportMenu    - "Export", then Excel, CSV or PDF
// The rules are columnControls.js; where it is kept, opsPrefs.js.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, Columns3, FileSpreadsheet, FileText, Filter, GripVertical, Plus, RotateCcw, Search, Sheet } from 'lucide-react';
import { distinctValues, filterWords, move, ordered } from './columnControls';
import { NUMERIC_TYPES } from './reportFormat';
import { DateField } from '../tasks/components';

/** Open / close a popover; closes on a click outside it and on Escape. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    // A calendar or menu a control inside opened sits in a portal of its own.
    const away = (e) => { if (!box.current?.contains(e.target) && !e.target?.closest?.('[data-nx-esc-layer]')) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return { open, setOpen, box };
}

export const EXPORT_FORMATS = [
  ['xlsx', 'Excel', 'A spreadsheet with every line, ready to sort and sum.', FileSpreadsheet],
  ['csv', 'CSV', 'Plain values, for another program.', Sheet],
  ['pdf', 'PDF', 'A page to print or send.', FileText],
];

/** The green Export button (B8: "Download" became "Export"); asks the format. */
export function ExportMenu({ onPick, busy = false, disabled = false, small = true, label = 'Export', ariaLabel }) {
  const { open, setOpen, box } = usePopover();
  return (
    <div className="ops-menu" ref={box}>
      <button type="button" className={`primary-btn${small ? ' ops-btn-sm' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel}
        disabled={disabled || busy} onClick={() => setOpen((o) => !o)}>
        {busy ? 'Preparing...' : label} <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="ops-menu-pop dash-card" role="menu" aria-label="Export As">
          {EXPORT_FORMATS.map(([k, l, about, Icon]) => (
            <button key={k} type="button" role="menuitem" className="ops-menu-item" onClick={() => { setOpen(false); onPick(k); }}>
              <Icon size={16} aria-hidden="true" />
              <span><span className="ops-fmt-l">{l}</span><span className="ops-rd-hint">{about}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const LEVEL = { unit: 'About the Unit', tenant: 'About the Tenant' };

/** Columns: every column with a box to show it, dragged or nudged into order,
 *  and - for a report - the preset columns it can take. */
export function ColumnsButton({ columns, shape, onShape, presets = null, canAdd = { unit: true, tenant: true } }) {
  const { open, setOpen, box } = usePopover();
  const [q, setQ] = useState('');
  const [drag, setDrag] = useState(null);
  const all = useMemo(() => ordered(columns, shape), [columns, shape]);
  const hidden = new Set(shape.hidden);
  const keys = all.map((c) => c.key);
  const shownCount = all.length - all.filter((c) => hidden.has(c.key)).length;

  const setOrder = (next) => onShape((s) => ({ ...s, order: next }));
  const toggle = (key) => onShape((s) => {
    const h = new Set(s.hidden);
    if (h.has(key)) h.delete(key);
    else if (shownCount > 1) h.add(key);
    return { ...s, hidden: [...h] };
  });
  const addPreset = (p) => onShape((s) => ({ ...s, add: [...s.add.filter((k) => k !== p.key), p.key],
    hidden: s.hidden.filter((k) => k !== p.column) }));
  const removePreset = (p) => onShape((s) => ({ ...s, add: s.add.filter((k) => k !== p.key),
    order: s.order.filter((k) => k !== p.column), hidden: s.hidden.filter((k) => k !== p.column),
    sort: s.sort?.key === p.column ? null : s.sort,
    filters: Object.fromEntries(Object.entries(s.filters).filter(([k]) => k !== p.column)) }));
  const reset = () => onShape((s) => ({ ...s, add: [], order: [], hidden: [] }));
  const presetOf = new Map((presets || []).map((p) => [p.column, p]));
  const needle = q.trim().toLowerCase();
  const offered = (presets || []).filter((p) => !shape.add.includes(p.key) && canAdd[p.level] !== false
    && !columns.some((c) => c.key === p.column) && (!needle || p.label.toLowerCase().includes(needle)));
  const arranged = shape.order.length || shape.hidden.length || shape.add.length;

  const onDrop = (target) => {
    if (!drag || drag === target) return;
    const next = keys.filter((k) => k !== drag);
    next.splice(next.indexOf(target) + (keys.indexOf(drag) < keys.indexOf(target) ? 1 : 0), 0, drag);
    setOrder(next);
    setDrag(null);
  };

  return (
    <div className="ops-menu" ref={box}>
      <button type="button" className="secondary-btn ops-btn-sm" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Columns3 size={14} aria-hidden="true" /> Columns
      </button>
      {open && (
        <div className="ops-menu-pop ops-cols-pop dash-card" role="dialog" aria-label="Columns">
          <div className="ops-cols-head">
            <span>{shownCount} of {all.length} shown</span>
            {arranged ? (
              <button type="button" className="ops-linkbtn" onClick={reset}><RotateCcw size={12} aria-hidden="true" /> Reset Columns</button>
            ) : null}
          </div>
          <ul className="ops-cols-list">
            {all.map((c, i) => {
              const on = !hidden.has(c.key);
              const preset = presetOf.get(c.key);
              return (
                <li key={c.key} draggable onDragStart={() => setDrag(c.key)} onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(c.key)}
                  className={drag === c.key ? 'is-drag' : ''}>
                  <GripVertical size={14} className="ops-cols-grip" aria-hidden="true" />
                  <label className="ops-cols-name">
                    <input type="checkbox" checked={on} onChange={() => toggle(c.key)} disabled={on && shownCount <= 1} />
                    <span>{c.label}</span>
                  </label>
                  <span className="ops-cols-moves">
                    <button type="button" className="ops-icon-btn" aria-label={`Move ${c.label} up`} disabled={i === 0} onClick={() => setOrder(move(keys, c.key, -1))}><ArrowUp size={13} /></button>
                    <button type="button" className="ops-icon-btn" aria-label={`Move ${c.label} down`} disabled={i === all.length - 1} onClick={() => setOrder(move(keys, c.key, 1))}><ArrowDown size={13} /></button>
                    {preset && <button type="button" className="ops-linkbtn" onClick={() => removePreset(preset)}>Remove</button>}
                  </span>
                </li>
              );
            })}
          </ul>
          {presets && (
            <div className="ops-cols-add">
              <div className="ops-cols-add-h">Add a Column</div>
              <label className="ops-search" style={{ margin: '0 0 6px' }}>
                <Search size={13} aria-hidden="true" />
                <input type="search" value={q} placeholder="Search the preset columns" aria-label="Search the preset columns" onChange={(e) => setQ(e.target.value)} />
              </label>
              {!offered.length ? <div className="ops-rd-hint" style={{ padding: '4px 2px' }}>{needle ? 'No preset column matches.' : 'Every preset column this report can take is on it.'}</div> : (
                ['unit', 'tenant'].map((lvl) => {
                  const list = offered.filter((p) => p.level === lvl);
                  if (!list.length) return null;
                  return (
                    <div key={lvl}>
                      <div className="ops-cols-group">{LEVEL[lvl]}</div>
                      {list.map((p) => (
                        <button key={p.key} type="button" className="ops-cols-preset" onClick={() => addPreset(p)}>
                          <Plus size={13} aria-hidden="true" /> {p.label}
                        </button>
                      ))}
                    </div>
                  );
                })
              )}
              <p className="ops-rd-hint" style={{ margin: '6px 2px 0' }}>Preset columns fill in from Cubby for the unit or tenant on each line.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const dollars = (cents) => (cents === undefined || cents === null || cents === '' ? '' : String(Number(cents) / 100));
const toCents = (v) => (String(v).trim() === '' ? undefined : Math.round(Number(v) * 100));

/** The funnel in one header: words for text, a range for numbers and dates,
 *  or tick the values when a column has only a few. */
export function HeaderFilter({ col, rows, filter, onChange }) {
  const { open, setOpen, box } = usePopover();
  const values = useMemo(() => (open ? distinctValues(rows, col) : null), [open, rows, col]);
  const f = filter || {};
  const numeric = NUMERIC_TYPES.has(col.type);
  const isDate = col.type === 'date';
  const money = col.type === 'money';
  const set = (patch) => onChange({ ...f, ...patch });
  const on = !!filter;
  return (
    <span className="ops-hf" ref={box}>
      <button type="button" className="ops-hf-btn" data-on={on} aria-label={on ? `${col.label} is filtered. Change the filter` : `Filter ${col.label}`}
        aria-haspopup="dialog" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        <Filter size={11} fill={on ? 'currentColor' : 'none'} aria-hidden="true" />
      </button>
      {open && (
        <div className="ops-menu-pop ops-hf-pop dash-card" role="dialog" aria-label={`Filter ${col.label}`} onClick={(e) => e.stopPropagation()}>
          <div className="ops-cols-add-h">{col.label}</div>
          {isDate ? (
            <div className="ops-hf-range">
              <label>From <DateField value={f.min || ''} onChange={(v) => set({ min: v || undefined })} placeholder="Any Day" /></label>
              <label>To <DateField value={f.max || ''} onChange={(v) => set({ max: v || undefined })} placeholder="Any Day" /></label>
            </div>
          ) : numeric ? (
            <div className="ops-hf-range">
              <label>From
                <input className="form-input" type="number" inputMode="decimal" placeholder={money ? '$' : ''} aria-label={`${col.label} from`}
                  defaultValue={money ? dollars(f.min) : (f.min ?? '')}
                  onBlur={(e) => set({ min: money ? toCents(e.target.value) : numOrUndef(e.target.value) })} />
              </label>
              <label>To
                <input className="form-input" type="number" inputMode="decimal" placeholder={money ? '$' : ''} aria-label={`${col.label} to`}
                  defaultValue={money ? dollars(f.max) : (f.max ?? '')}
                  onBlur={(e) => set({ max: money ? toCents(e.target.value) : numOrUndef(e.target.value) })} />
              </label>
            </div>
          ) : values ? (
            <ul className="ops-hf-values">
              {values.map((v) => {
                const ticked = (f.values || []).includes(v);
                return (
                  <li key={v || '(blank)'}>
                    <label>
                      <input type="checkbox" checked={ticked}
                        onChange={() => set({ values: ticked ? (f.values || []).filter((x) => x !== v) : [...(f.values || []), v] })} />
                      <span>{v || '(Blank)'}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <label className="ops-search" style={{ margin: 0 }}>
              <Search size={13} aria-hidden="true" />
              <input type="search" autoFocus defaultValue={f.q || ''} placeholder="Contains (commas for several)" aria-label={`${col.label} contains`}
                onKeyDown={(e) => { if (e.key === 'Enter') { set({ q: e.currentTarget.value }); setOpen(false); } }}
                onBlur={(e) => set({ q: e.target.value })} />
            </label>
          )}
          <div className="ops-hf-foot">
            <button type="button" className="ops-linkbtn" onClick={() => { onChange(null); setOpen(false); }} disabled={!on}>Clear</button>
            <button type="button" className="secondary-btn ops-btn-sm" onClick={() => setOpen(false)}><Check size={13} aria-hidden="true" /> Done</button>
          </div>
        </div>
      )}
    </span>
  );
}

const numOrUndef = (v) => (String(v).trim() === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

/** "Filtered: Status Rented - Rent at least $150.00. Clear Filters" - one quiet line. */
export function FilterLine({ columns, shape, onShape, shown, total }) {
  const active = Object.entries(shape.filters).map(([k, f]) => [columns.find((c) => c.key === k), f]).filter(([c]) => c);
  if (!active.length) return null;
  return (
    <p className="ops-filter-line" role="status">
      <span>Filtered: {active.map(([c, f]) => filterWords(c, f)).join(' - ')}.</span>
      {total !== undefined && <span> {shown.toLocaleString('en-US')} of {total.toLocaleString('en-US')} lines.</span>}
      <button type="button" className="ops-linkbtn" onClick={() => onShape((s) => ({ ...s, filters: {} }))}>Clear Filters</button>
    </p>
  );
}
