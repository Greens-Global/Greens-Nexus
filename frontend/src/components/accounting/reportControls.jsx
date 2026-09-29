import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, BookmarkPlus, Building2, Check, ChevronDown, ChevronLeft, ChevronRight, Layers, ListFilter, Search, Settings2, SlidersHorizontal, Trash2, Users, X } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import { EMPTY_DIMS, POPOVER_DIMS, PRESETS, countDims, isHistorical, iso, presetRange, stepAsOf, stepRange } from './reportModel';

// The Reports toolbar's controls (Neil and Charmi, Sep 25): everything is a
// dropdown on ONE slim row, so the statement starts high on the page - no
// chips, no second and third row of filters. Entities is a searchable
// multi-select; Dimensions holds every other Intacct dimension behind one
// button with a count; Saved Reports lists the memorized views.
//
// Sep 29 (Visesh): the row carries what the accounting app's Reports page
// carries - the period stepper with its arrows, departments and accounts as
// their own dropdowns, and Customize.

export const control = {
  height: 30, padding: '0 9px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: '0.78rem',
  fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-primary)', boxSizing: 'border-box',
};
const button = (active) => ({
  ...control, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', maxWidth: 300, whiteSpace: 'nowrap',
  border: `1px solid ${active ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`,
  color: active ? 'var(--wk-brand, #2b45e1)' : 'var(--text-primary)', fontWeight: active ? 600 : 400,
});
const panel = (width, align) => ({
  position: 'absolute', top: 'calc(100% + 4px)', [align === 'right' ? 'right' : 'left']: 0, zIndex: 40, width, maxWidth: '94vw',
  background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10,
  boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))', padding: 10,
});
const row = (on) => ({
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', border: 'none', borderRadius: 6,
  background: on ? 'var(--wk-brand-tint, #e8ecfd)' : 'none', padding: '5px 8px', font: 'inherit', fontSize: '0.8rem',
  color: 'var(--text-primary)', cursor: 'pointer',
});
const link = { border: 'none', background: 'none', font: 'inherit', fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer', textDecoration: 'underline', padding: 0 };
const count = { fontSize: '0.68rem', fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'var(--wk-brand, #2b45e1)', color: '#fff' };

// Open / close, closing on Escape and on a click outside.
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [open]);
  return [open, setOpen, ref];
}

// A searchable list with a tick per row. `options`: [{ code, name, depth?, group? }];
// a heading is drawn wherever `group` changes.
function OptionList({ options, value, onChange, placeholder, empty, loading, error, allLabel }) {
  const [q, setQ] = useState('');
  const chosen = useMemo(() => new Set(value), [value]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s ? options.filter((o) => o.code.toLowerCase().includes(s) || (o.name || '').toLowerCase().includes(s)) : options;
    return list.slice(0, 400);
  }, [options, q]);
  const toggle = (code) => {
    const next = new Set(chosen);
    if (next.has(code)) next.delete(code); else next.add(code);
    onChange([...next]);
  };
  const onKeyDown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (q.trim() && shown[0]) toggle(shown[0].code);
  };
  return (
    <>
      <div style={{ position: 'relative' }}>
        <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--text-muted)' }} />
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} placeholder={placeholder} aria-label={placeholder} autoFocus
          style={{ ...control, width: '100%', paddingLeft: 26 }} />
      </div>
      <div style={{ maxHeight: 280, overflowY: 'auto', marginTop: 6, display: 'grid', gap: 1 }}>
        {error && <div style={{ fontSize: '0.78rem', color: 'var(--bad-fg, #dc2626)', padding: 6 }}>{error}</div>}
        {loading && <SkeletonBlocks count={3} />}
        {allLabel && !q.trim() && (
          <button type="button" style={row(!value.length)} onClick={() => onChange([])}>
            <span style={{ width: 14, display: 'inline-flex', color: 'var(--wk-brand, #2b45e1)' }}>{!value.length ? <Check size={14} /> : null}</span>
            <span style={{ flex: 1, fontWeight: 600 }}>{allLabel}</span>
          </button>
        )}
        {shown.map((o, i) => {
          const on = chosen.has(o.code);
          return (
            <Fragment key={o.code}>
              {o.group && o.group !== shown[i - 1]?.group && (
                <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', padding: '6px 8px 2px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{o.group}</div>
              )}
              <button type="button" role="option" aria-selected={on} style={row(on)} onClick={() => toggle(o.code)}>
                <span style={{ width: 14, display: 'inline-flex', color: 'var(--wk-brand, #2b45e1)' }}>{on ? <Check size={14} /> : null}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: o.depth ? 14 : 0 }}>{o.name || o.code}</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{o.name ? o.code : ''}</span>
              </button>
            </Fragment>
          );
        })}
        {!loading && !error && !shown.length && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: 6 }}>{options.length ? 'No match.' : empty}</div>}
      </div>
    </>
  );
}

// Top-level entities first, each followed by its sub-entities, by name.
export function entityOptions(entities) {
  const byName = (a, b) => (a.name || a.code).localeCompare(b.name || b.code, 'en-US', { numeric: true });
  const roots = entities.filter((e) => !e.parent_code || !entities.some((p) => p.code === e.parent_code)).sort(byName);
  const out = [];
  roots.forEach((r) => {
    out.push({ code: r.code, name: r.name || '', depth: 0 });
    entities.filter((e) => e.parent_code === r.code).sort(byName).forEach((k) => out.push({ code: k.code, name: k.name || '', depth: 1 }));
  });
  entities.forEach((e) => { if (!out.some((o) => o.code === e.code)) out.push({ code: e.code, name: e.name || '', depth: 1 }); });
  return out;
}

// One entity, several, or all of them - searchable from inside the dropdown
// (Charmi, Sep 25: "search the entity directly from the drop-down").
export function EntitiesPicker({ entities, value, onChange, limited = false, align = 'left' }) {
  const [open, setOpen, ref] = usePopover();
  const options = useMemo(() => entityOptions(entities), [entities]);
  const one = value.length === 1 ? entities.find((e) => e.code === value[0]) : null;
  const all = limited ? 'All my entities' : 'All entities';
  const label = !value.length ? all : value.length === 1 ? `${one?.name || 'Unnamed'} (${value[0]})` : `${value.length} entities`;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" style={button(value.length > 0)} onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open} aria-label="Entities" title={label}>
        <Building2 size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
      </button>
      {open && (
        <div role="listbox" aria-label="Entities" aria-multiselectable="true" style={panel(380, align)}>
          <OptionList options={options} value={value} onChange={onChange} allLabel={all}
            placeholder="Search entity by name or code" empty="No entities on the ledger yet." />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{value.length > 1 ? 'Several entities add together.' : 'An entity includes its sub-entities.'}</span>
            <button type="button" className="primary-btn" style={{ fontSize: '0.75rem', padding: '3px 12px' }} onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Vendor, customer, employee, Project-Job and item behind one button
// (department has its own dropdown beside Entities). The kinds are listed on
// the left with what is picked; the right side is the searchable list of the
// kind that is open.
export function DimensionsButton({ dims, onChange, align = 'left' }) {
  const [open, setOpen, ref] = usePopover();
  const [kind, setKind] = useState(POPOVER_DIMS[0]);
  const [lists, setLists] = useState({});       // kind -> { values } | { error }
  const n = countDims(dims);
  useEffect(() => {
    if (!open || lists[kind.kind]) return undefined;
    let alive = true;
    api.getAccountingDimensionValues(kind.kind)
      .then((d) => { if (alive) setLists((l) => ({ ...l, [kind.kind]: { values: d?.values || [] } })); })
      .catch((e) => { if (alive) setLists((l) => ({ ...l, [kind.kind]: { values: [], error: e?.message || 'Could not load the list.' } })); });
    return () => { alive = false; };
  }, [open, kind, lists]);
  const picked = dims[kind.key] || [];
  const options = useMemo(() => {
    const keep = new Set(picked);
    return (lists[kind.kind]?.values || [])
      .filter((v) => !isHistorical(v.name) || keep.has(v.code))
      .map((v) => ({ code: v.code, name: v.name || '', depth: v.parent_code ? 1 : 0 }))
      .sort((a, b) => (keep.has(b.code) - keep.has(a.code)) || (a.name || a.code).localeCompare(b.name || b.code, 'en-US', { numeric: true }));
  }, [lists, kind, picked]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" style={button(n > 0)} onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open} aria-label="Dimensions">
        <SlidersHorizontal size={14} style={{ flexShrink: 0, color: n ? 'inherit' : 'var(--text-muted)' }} />
        Dimensions
        {n > 0 && <span style={count}>{n}</span>}
        <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
      </button>
      {open && (
        <div role="dialog" aria-label="Dimensions" style={{ ...panel(560, align), display: 'grid', gridTemplateColumns: '170px 1fr', gap: 10 }}>
          <div style={{ display: 'grid', gap: 1, alignContent: 'start' }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', padding: '2px 8px 6px' }}>Filter this report by</div>
            {POPOVER_DIMS.map((k) => {
              const c = (dims[k.key] || []).length;
              return (
                <button key={k.key} type="button" style={row(k.key === kind.key)} onClick={() => setKind(k)} aria-pressed={k.key === kind.key}>
                  <span style={{ flex: 1 }}>{k.label}</span>
                  {c > 0 ? <span style={count}>{c}</span> : <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />}
                </button>
              );
            })}
            {n > 0 && <button type="button" style={{ ...link, textAlign: 'left', padding: '8px 8px 0' }} onClick={() => onChange({ ...EMPTY_DIMS, departments: dims.departments || [] })}>Clear all</button>}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <strong style={{ fontSize: '0.8rem' }}>{kind.label}{picked.length ? ` · ${picked.length} selected` : ''}</strong>
              <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
                {picked.length > 0 && <button type="button" style={link} onClick={() => onChange({ ...dims, [kind.key]: [] })}>Clear</button>}
                <button type="button" className="primary-btn" style={{ fontSize: '0.75rem', padding: '3px 12px' }} onClick={() => setOpen(false)}>Done</button>
              </span>
            </div>
            <OptionList key={kind.key} options={options} value={picked} onChange={(codes) => onChange({ ...dims, [kind.key]: codes })}
              loading={!lists[kind.kind]} error={lists[kind.kind]?.error}
              placeholder={`Search ${kind.label.toLowerCase()} by name or code`} empty={`No ${kind.plural} on the ledger yet.`} />
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 6 }}>
              Lines without a {kind.label.toLowerCase()} are left out when one is picked. Historical (H) entries are hidden.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// One department, several, or all of them - the same searchable dropdown as
// Entities, listing the departments Intacct has.
export function DepartmentsPicker({ value, onChange, align = 'left' }) {
  const [open, setOpen, ref] = usePopover();
  const [list, setList] = useState(null);       // { values } | { values: [], error }
  useEffect(() => {
    // The names are needed for the button as soon as something is picked.
    if (list || (!open && !value.length)) return undefined;
    let alive = true;
    api.getAccountingDimensionValues('department')
      .then((d) => { if (alive) setList({ values: d?.values || [] }); })
      .catch((e) => { if (alive) setList({ values: [], error: e?.message || 'Could not load the departments.' }); });
    return () => { alive = false; };
  }, [open, value.length, list]);
  const options = useMemo(() => {
    const keep = new Set(value);
    return (list?.values || [])
      .filter((v) => !isHistorical(v.name) || keep.has(v.code))
      .map((v) => ({ code: v.code, name: v.name || '', depth: 0 }))
      .sort((a, b) => (a.name || a.code).localeCompare(b.name || b.code, 'en-US', { numeric: true }));
  }, [list, value]);
  const one = value.length === 1 ? options.find((o) => o.code === value[0]) : null;
  const label = !value.length ? 'All departments' : value.length === 1 ? (one?.name ? `${one.name} (${value[0]})` : `Department ${value[0]}`) : `${value.length} departments`;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" style={button(value.length > 0)} onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open} aria-label="Departments" title={label}>
        <Layers size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
      </button>
      {open && (
        <div role="listbox" aria-label="Departments" aria-multiselectable="true" style={panel(360, align)}>
          <OptionList options={options} value={value} onChange={onChange} allLabel="All departments" loading={!list} error={list?.error}
            placeholder="Search department by name or code" empty="No departments on the ledger yet." />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Historical (H) departments are hidden.</span>
            <button type="button" className="primary-btn" style={{ fontSize: '0.75rem', padding: '3px 12px' }} onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Which accounts the statement shows: every account it could show, by
// section, with a tick per account. Nothing ticked = all of them.
export function AccountsPicker({ accounts, value, onChange, align = 'left' }) {
  const [open, setOpen, ref] = usePopover();
  const options = useMemo(() => {
    const known = new Set(accounts.map((a) => a.code));
    const list = accounts.map((a) => ({ code: a.code, name: a.title, group: a.section }));
    // A picked account with nothing in this period still shows, so it can be unticked.
    value.forEach((code) => { if (!known.has(code)) list.push({ code, name: '', group: 'Not on this statement' }); });
    return list;
  }, [accounts, value]);
  const label = !value.length ? 'All accounts' : value.length === 1 ? `Account ${value[0]}` : `${value.length} accounts`;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" style={button(value.length > 0)} onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open} aria-label="Accounts" title={label}>
        <ListFilter size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
      </button>
      {open && (
        <div role="listbox" aria-label="Accounts" aria-multiselectable="true" style={panel(400, align)}>
          <OptionList options={options} value={value} onChange={onChange} allLabel="All accounts"
            placeholder="Search account by name or GL code" empty="No accounts with activity for this selection." />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Totals add up the picked accounts only.</span>
            <button type="button" className="primary-btn" style={{ fontSize: '0.75rem', padding: '3px 12px' }} onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

// The period, with an arrow on each side (the accounting app's stepper): the
// dropdown names the period, the arrows move one month, quarter or year back
// or forward. A statement as of a date steps from month-end to month-end.
const arrow = { ...control, width: 26, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-secondary)' };
export function PeriodStepper({ config, period, onChange }) {
  const group = { display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' };
  if (period === 'asof') {
    const to = (asof) => onChange({ asof, asofToday: asof === iso(new Date()) });
    return (
      <div role="group" aria-label="Report period" style={group}>
        <button type="button" style={arrow} onClick={() => to(stepAsOf(config.asof, -1))} aria-label="Previous month-end" title="Previous month-end"><ChevronLeft size={14} /></button>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>As of</span>
        <input type="date" value={config.asof} aria-label="As of" style={control} onChange={(e) => e.target.value && to(e.target.value)} />
        <button type="button" style={arrow} onClick={() => to(stepAsOf(config.asof, 1))} aria-label="Next month-end" title="Next month-end"><ChevronRight size={14} /></button>
      </div>
    );
  }
  const step = (dir) => {
    const [from, end] = stepRange(config.preset, config.from, config.to, dir);
    onChange({ preset: 'custom', from, to: end });
  };
  return (
    <div role="group" aria-label="Report period" style={group}>
      <button type="button" style={arrow} onClick={() => step(-1)} aria-label="Previous period" title="Previous period"><ChevronLeft size={14} /></button>
      <select value={config.preset} onChange={(e) => onChange({ preset: e.target.value })} aria-label="Period" style={{ ...control, maxWidth: 300 }}>
        {PRESETS.map((p) => {
          const r = p.key === 'custom' ? null : presetRange(p.key).map(iso);
          return <option key={p.key} value={p.key}>{r ? `${p.label} · ${formatDate(r[0])} - ${formatDate(r[1])}` : 'Custom Dates'}</option>;
        })}
      </select>
      {config.preset === 'custom' && (
        <>
          {/* No min / max on these: a calendar capped at the other date could not
              move to a later month at all (Charmi, Sep 25). Picking a start after
              the end moves the end with it. */}
          <input type="date" value={config.from} aria-label="From" style={control}
            onChange={(e) => e.target.value && onChange({ from: e.target.value, to: e.target.value > config.to ? e.target.value : config.to })} />
          <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>to</span>
          <input type="date" value={config.to} aria-label="To" style={control}
            onChange={(e) => e.target.value && onChange({ to: e.target.value, from: e.target.value < config.from ? e.target.value : config.from })} />
        </>
      )}
      <button type="button" style={arrow} onClick={() => step(1)} aria-label="Next period" title="Next period"><ChevronRight size={14} /></button>
    </div>
  );
}

// Row density, the finance app's three steps.
export const DENSITIES = [
  { key: 'comfortable', label: 'Comfortable', py: '10px', title: 'Roomy rows' },
  { key: 'compact', label: 'Compact', py: '5px', title: 'Tight rows, like Intacct' },
  { key: 'condensed', label: 'Condensed', py: '2px', title: 'As many rows on screen as possible' },
];

// Customize: how the statement is drawn. The density is the person's own
// (every accounting screen follows it); leaving out the accounts with nothing
// in them belongs to the report and is memorized with it.
export function CustomizeButton({ density, onDensity, suppressZero, onSuppressZero, align = 'right' }) {
  const [open, setOpen, ref] = usePopover();
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" style={button(suppressZero)} onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}>
        <Settings2 size={14} style={{ flexShrink: 0, color: suppressZero ? 'inherit' : 'var(--text-muted)' }} /> Customize
      </button>
      {open && (
        <div role="dialog" aria-label="Customize" style={{ ...panel(300, align), display: 'grid', gap: 10 }}>
          <div>
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>Row density</div>
            <div role="group" aria-label="Row density" style={{ display: 'inline-flex', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' }}>
              {DENSITIES.map((d) => (
                <button key={d.key} type="button" onClick={() => onDensity(d.key)} title={d.title} aria-pressed={density === d.key}
                  style={{ border: 'none', borderRight: '1px solid var(--border-color)', background: density === d.key ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)', color: density === d.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', font: 'inherit', fontSize: '0.74rem', fontWeight: 600, padding: '5px 10px', cursor: 'pointer' }}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.8rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={suppressZero} onChange={(e) => onSuppressZero(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              Hide zero balances
              <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>Accounts with 0.00 in every column are left off.</span>
            </span>
          </label>
        </div>
      )}
    </div>
  );
}

// "Memorize": name the view on screen and keep it (Neil, Sep 25: "she's going
// to pull the same report 50 times").
export function MemorizeButton({ onSave, suggestion, align = 'right' }) {
  const [open, setOpen, ref] = usePopover();
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setName(suggestion || ''); setShared(false); setError(''); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (e) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    Promise.resolve(onSave(name.trim(), shared))
      .then(() => setOpen(false))
      .catch((err) => setError(err?.message || 'Could not save the report.'))
      .finally(() => setBusy(false));
  };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" style={button(false)} onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}>
        <BookmarkPlus size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} /> Memorize
      </button>
      {open && (
        <form role="dialog" aria-label="Memorize this report" onSubmit={save} style={{ ...panel(330, align), display: 'grid', gap: 8 }}>
          <label style={{ fontSize: '0.78rem', fontWeight: 600 }} htmlFor="acct-memorize-name">What would you like to name it?</label>
          <input id="acct-memorize-name" type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus
            placeholder="Income Statement - GG Inc - YTD" style={{ ...control, width: '100%' }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.78rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with the accounting team
          </label>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Saves the report, period, columns, book, entities and filters - not the figures. A name you already use is replaced.</div>
          {error && <div style={{ fontSize: '0.78rem', color: 'var(--bad-fg, #dc2626)' }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="secondary-btn" style={{ fontSize: '0.75rem', padding: '4px 12px' }} onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="primary-btn" style={{ fontSize: '0.75rem', padding: '4px 12px' }} disabled={!name.trim() || busy}>{busy ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      )}
    </div>
  );
}

// The memorized reports: one click opens one. The person who saved a report
// can share it with the team or delete it.
export function SavedReportsMenu({ reports, loading, error, activeId, onOpen, onDelete, onShare, nameOf, align = 'right' }) {
  const [open, setOpen, ref] = usePopover();
  const [q, setQ] = useState('');
  const [confirm, setConfirm] = useState('');
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? reports.filter((r) => r.name.toLowerCase().includes(s)) : reports;
  }, [reports, q]);
  const active = reports.find((r) => r.id === activeId);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" style={button(!!active)} onClick={() => { setOpen((v) => !v); setConfirm(''); }} aria-haspopup="menu" aria-expanded={open} title={active ? active.name : 'Saved Reports'}>
        <Bookmark size={14} style={{ flexShrink: 0, color: active ? 'inherit' : 'var(--text-muted)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{active ? active.name : 'Saved Reports'}</span>
        {!active && reports.length > 0 && <span style={{ ...count, background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>{reports.length}</span>}
        <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
      </button>
      {open && (
        <div role="menu" aria-label="Saved Reports" style={panel(400, align)}>
          {reports.length > 6 && (
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search saved reports" aria-label="Search saved reports" style={{ ...control, width: '100%', marginBottom: 6 }} />
          )}
          <div style={{ maxHeight: 320, overflowY: 'auto', display: 'grid', gap: 1 }}>
            {error && <div style={{ fontSize: '0.78rem', color: 'var(--bad-fg, #dc2626)', padding: 6 }}>{error}</div>}
            {loading && <SkeletonBlocks count={2} />}
            {!loading && !error && !reports.length && (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '8px 6px' }}>Nothing saved yet. Set up a report, then press Memorize.</div>
            )}
            {shown.map((r) => (
              <div key={r.id} style={{ ...row(r.id === activeId), cursor: 'default', padding: 0 }}>
                <button type="button" role="menuitem" onClick={() => { onOpen(r); setOpen(false); }}
                  style={{ flex: 1, minWidth: 0, border: 'none', background: 'none', padding: '6px 8px', font: 'inherit', fontSize: '0.8rem', color: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{r.name}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    {r.mine ? (r.shared ? 'Shared with the team' : 'Only you') : `Shared by ${nameOf ? nameOf(r.owner) : 'a teammate'}`}
                  </div>
                </button>
                {r.mine && (confirm === r.id ? (
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', paddingRight: 8 }}>
                    <button type="button" style={{ ...link, color: 'var(--bad-fg, #dc2626)' }} onClick={() => { onDelete(r); setConfirm(''); }}>Delete</button>
                    <button type="button" style={link} onClick={() => setConfirm('')}>Keep</button>
                  </span>
                ) : (
                  <span style={{ display: 'inline-flex', gap: 2, paddingRight: 4 }}>
                    <button type="button" onClick={() => onShare(r, !r.shared)} aria-pressed={r.shared} aria-label={r.shared ? `Stop sharing ${r.name}` : `Share ${r.name} with the team`}
                      title={r.shared ? 'Shared with the team - click to make it yours only' : 'Share with the accounting team'}
                      style={{ border: 'none', background: 'none', padding: 5, cursor: 'pointer', display: 'inline-flex', color: r.shared ? 'var(--wk-brand, #2b45e1)' : 'var(--text-muted)' }}>
                      <Users size={14} />
                    </button>
                    <button type="button" onClick={() => setConfirm(r.id)} aria-label={`Delete ${r.name}`} title="Delete"
                      style={{ border: 'none', background: 'none', padding: 5, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' }}>
                      <Trash2 size={14} />
                    </button>
                  </span>
                ))}
              </div>
            ))}
            {!loading && reports.length > 0 && !shown.length && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: 6 }}>No saved report matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// A small "x" for a text box.
export function ClearButton({ onClick, label }) {
  return (
    <button type="button" onClick={onClick} aria-label={label}
      style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 2 }}>
      <X size={14} />
    </button>
  );
}
