import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, BookmarkPlus, Building2, Check, ChevronDown, ChevronLeft, ChevronRight, Download, FileDown, FileSpreadsheet, ListFilter, Loader2, Search, Settings2, SlidersHorizontal, Trash2, Users, X } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import AnchoredMenu from '../AnchoredMenu';
import { formatDate } from '../../lib/datetime';
import { EMPTY_DIMS, JOURNAL_KINDS, POPOVER_DIMS, PRESETS, countDims, isHistorical, isHistoricalEntity, iso, presetRange, stepAsOf, stepRange } from './reportModel';

// The Reports toolbar's controls (Neil and Charmi, Sep 25): everything is a
// dropdown on ONE slim row, so the statement starts high on the page - no
// second and third row of filters. Entities is a searchable multi-select;
// Filters holds every other Intacct dimension behind one button with a
// count; Saved Reports lists the memorized views.
//
// Sep 29 (Visesh): the row carries what the accounting app's Reports page
// carries - the period stepper with its arrows, accounts as a dropdown, and
// Customize.
//
// Sep 30 (Charmi and Neil, call of 09/29): "Dimensions" is "Filters" and
// Department moved inside it; Entities and Accounts stay outside as the
// major filters; the pickers are wide enough for the whole name and number
// and run to the bottom of the screen; entities read in number order, with
// the historical (H) ones off unless Customize shows them; one Export
// button with a menu instead of two.
//
// Oct 2 (Charmi, Neil): the row reads Entities, Filters, then Accounts
// (Charmi: "keep accounts as the last tab"); Customize gets "Show historical
// accounts" for the Accounts and Filters lists (item 18 of 09/29); Filters
// gets Journals (Neil: AP, AR, user defined, statistical), grouped by kind,
// and says "Not available yet" until the accounting app lists them; the
// Flux Analysis thresholds sit under Customize too.

export const control = {
  height: 30, padding: '0 9px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: '0.78rem',
  fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-primary)', boxSizing: 'border-box',
};
const button = (active) => ({
  ...control, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', maxWidth: 300, whiteSpace: 'nowrap',
  border: `1px solid ${active ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`,
  color: active ? 'var(--wk-brand, #2b45e1)' : 'var(--text-primary)', fontWeight: active ? 600 : 400,
});
// Where it sits is PopoverPanel's job; this is only how it looks.
const panel = (width) => ({
  width,
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

// A picker's list runs to the bottom of the screen (Charmi, 09/29 call);
// AnchoredMenu keeps the whole panel inside the viewport.
const LIST_HEIGHT = 'min(640px, calc(100vh - 230px))';

// Open / close state plus the anchor (the wrapper around the button).
// Escape and a tap outside are handled by PopoverPanel.
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  return [open, setOpen, ref];
}

// A toolbar dropdown's panel, pinned under its button. Portaled
// (AnchoredMenu): on a phone the toolbar row scrolls sideways, and a
// scroller clips an in-place panel at its bottom edge.
export function PopoverPanel({ anchor, open, setOpen, align, ...rest }) {
  return <AnchoredMenu anchorRef={anchor} open={open} onClose={() => setOpen(false)} align={align === 'right' ? 'end' : 'start'} {...rest} />;
}

// A searchable list with a tick per row. `options`: [{ code, name, depth?, group? }];
// a heading is drawn wherever `group` changes.
function OptionList({ options, value, onChange, placeholder, empty, loading, error, allLabel, maxHeight = LIST_HEIGHT }) {
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
      <div style={{ maxHeight, overflowY: 'auto', overflowX: 'hidden', marginTop: 6, display: 'grid', gap: 1 }}>
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

// Top-level entities first, each followed by its sub-entities, in NUMBER
// order (Neil, 09/29 call: 30000 sat above 10000 when they read by name).
// Historical (H) entities are left out unless asked for or already picked.
export function entityOptions(entities, { showHistorical = false, keep = [] } = {}) {
  const kept = new Set(keep);
  const list = entities.filter((e) => showHistorical || kept.has(e.code) || !isHistoricalEntity(e));
  const byCode = (a, b) => a.code.localeCompare(b.code, 'en-US', { numeric: true });
  const roots = list.filter((e) => !e.parent_code || !list.some((p) => p.code === e.parent_code)).sort(byCode);
  const out = [];
  roots.forEach((r) => {
    out.push({ code: r.code, name: r.name || '', depth: 0 });
    list.filter((e) => e.parent_code === r.code).sort(byCode).forEach((k) => out.push({ code: k.code, name: k.name || '', depth: 1 }));
  });
  list.forEach((e) => { if (!out.some((o) => o.code === e.code)) out.push({ code: e.code, name: e.name || '', depth: 1 }); });
  return out;
}

// One entity, several, or all of them - searchable from inside the dropdown
// (Charmi, Sep 25: "search the entity directly from the drop-down").
export function EntitiesPicker({ entities, value, onChange, limited = false, showHistorical = false, align = 'left' }) {
  const [open, setOpen, ref] = usePopover();
  const options = useMemo(() => entityOptions(entities, { showHistorical, keep: value }), [entities, showHistorical, value]);
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
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} align={align} role="listbox" aria-label="Entities" aria-multiselectable="true" style={panel(540)}>
        <OptionList options={options} value={value} onChange={onChange} allLabel={all}
          placeholder="Search entity by name or code" empty="No entities on the ledger yet." />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 10 }}>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{value.length > 1 ? 'Several entities add together.' : showHistorical ? 'An entity includes its sub-entities.' : 'An entity includes its sub-entities. Customize > Show historical entities lists the (H) ones too.'}</span>
          <button type="button" className="primary-btn" style={{ fontSize: '0.75rem', padding: '3px 12px' }} onClick={() => setOpen(false)}>Done</button>
        </div>
      </PopoverPanel>
    </div>
  );
}

// Department, vendor, customer, employee, Project-Job and item behind one
// "Filters" button (Charmi, 09/29 call). The kinds are listed on the left
// with what is picked; the right side is the searchable list of the kind
// that is open. `onNames` hands the names of each list up as it loads, so
// the chips under the report can say "Vendor: Amazon" instead of a code.
export function FiltersButton({ dims, onChange, onNames, showHistorical = false, align = 'left' }) {
  const [open, setOpen, ref] = usePopover();
  const [kind, setKind] = useState(POPOVER_DIMS[0]);
  const [lists, setLists] = useState({});       // kind -> { values } | { error } | { unavailable }
  const n = countDims(dims);
  // A picked kind loads its names even while the panel is closed, for the chips.
  const wanted = POPOVER_DIMS.filter((k) => (dims[k.key] || []).length && !lists[k.kind]).map((k) => k.kind);
  const need = open && !lists[kind.kind] ? kind.kind : wanted[0];
  useEffect(() => {
    if (!need) return undefined;
    let alive = true;
    // Journals come from their own list (CONTRACT2 J1), grouped by kind; the
    // accounting app may not have it yet, and then the panel says so.
    const load = need === 'journal'
      ? api.getAccountingJournals().then((d) => (d?.available === false
        ? { values: [], unavailable: true }
        : { values: (d?.journals || []).map((j) => ({ code: j.symbol, name: j.title || '', group: JOURNAL_KINDS[j.kind] || JOURNAL_KINDS.user })) }))
      : api.getAccountingDimensionValues(need).then((d) => ({ values: d?.values || [] }));
    load
      .then((got) => {
        if (!alive) return;
        setLists((l) => ({ ...l, [need]: got }));
        onNames?.(need, Object.fromEntries(got.values.map((v) => [v.code, v.name || ''])));
      })
      .catch((e) => { if (alive) setLists((l) => ({ ...l, [need]: { values: [], error: e?.message || 'Could not load the list.' } })); });
    return () => { alive = false; };
  }, [need]); // eslint-disable-line react-hooks/exhaustive-deps
  const picked = dims[kind.key] || [];
  const options = useMemo(() => {
    const keep = new Set(picked);
    const values = lists[kind.kind]?.values || [];
    // Journals keep their order: by kind, the way the list is grouped.
    if (kind.kind === 'journal') return values.map((v) => ({ code: v.code, name: v.name, group: v.group }));
    return values
      .filter((v) => showHistorical || !isHistorical(v.name) || keep.has(v.code))
      .map((v) => ({ code: v.code, name: v.name || '', depth: v.parent_code ? 1 : 0 }))
      .sort((a, b) => (keep.has(b.code) - keep.has(a.code)) || (a.name || a.code).localeCompare(b.name || b.code, 'en-US', { numeric: true }));
  }, [lists, kind, picked, showHistorical]);
  const unavailable = !!lists[kind.kind]?.unavailable;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" style={button(n > 0)} onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open} aria-label="Filters">
        <SlidersHorizontal size={14} style={{ flexShrink: 0, color: n ? 'inherit' : 'var(--text-muted)' }} />
        Filters
        {n > 0 && <span style={count}>{n}</span>}
        <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
      </button>
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} align={align} role="dialog" aria-label="Filters" style={{ ...panel(640), display: 'grid', gridTemplateColumns: '170px 1fr', gap: 10 }}>
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
          {n > 0 && <button type="button" style={{ ...link, textAlign: 'left', padding: '8px 8px 0' }} onClick={() => onChange({ ...EMPTY_DIMS })}>Clear all</button>}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <strong style={{ fontSize: '0.8rem' }}>{kind.label}{picked.length ? ` · ${picked.length} selected` : ''}</strong>
            <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
              {picked.length > 0 && <button type="button" style={link} onClick={() => onChange({ ...dims, [kind.key]: [] })}>Clear</button>}
              <button type="button" className="primary-btn" style={{ fontSize: '0.75rem', padding: '3px 12px' }} onClick={() => setOpen(false)}>Done</button>
            </span>
          </div>
          {unavailable ? (
            <div role="status" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '14px 6px' }}>
              <strong>Not available yet.</strong> Nexus Accounting does not list its journals yet; the filter switches on by itself once it does.
            </div>
          ) : (
            <OptionList key={kind.key} options={options} value={picked} onChange={(codes) => onChange({ ...dims, [kind.key]: codes })}
              loading={!lists[kind.kind]} error={lists[kind.kind]?.error}
              placeholder={kind.kind === 'journal' ? 'Search journals by symbol or title' : `Search ${kind.label.toLowerCase()} by name or code`} empty={`No ${kind.plural} on the ledger yet.`} />
          )}
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 6 }}>
            {kind.kind === 'journal' ? 'Statistical journals carry no money: their lines show in the drill-down and never add into a total.'
              : kind.key === 'departments' ? 'A department includes the departments under it.' : `Lines without a ${(kind.one || kind.label).toLowerCase()} are left out when one is picked.`}
            {kind.kind !== 'journal' && !showHistorical ? ' Customize > Show historical accounts lists the (H) entries too.' : ''}
          </div>
        </div>
      </PopoverPanel>
    </div>
  );
}

// Which accounts the statement shows: every account it could show, by
// section, with a tick per account. Nothing ticked = all of them.
export function AccountsPicker({ accounts, value, onChange, showHistorical = false, align = 'left' }) {
  const [open, setOpen, ref] = usePopover();
  const options = useMemo(() => {
    const known = new Set(accounts.map((a) => a.code));
    const keep = new Set(value);
    // Historical (H) accounts are off the list until Customize shows them
    // (Charmi, item 18 of 09/29), unless already picked.
    const list = accounts.filter((a) => showHistorical || keep.has(a.code) || !isHistorical(a.title)).map((a) => ({ code: a.code, name: a.title, group: a.section }));
    // A picked account with nothing in this period still shows, so it can be unticked.
    value.forEach((code) => { if (!known.has(code)) list.push({ code, name: '', group: 'Not on this statement' }); });
    return list;
  }, [accounts, value, showHistorical]);
  const label = !value.length ? 'All accounts' : value.length === 1 ? `Account ${value[0]}` : `${value.length} accounts`;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" style={button(value.length > 0)} onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open} aria-label="Accounts" title={label}>
        <ListFilter size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
      </button>
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} align={align} role="listbox" aria-label="Accounts" aria-multiselectable="true" style={panel(480)}>
        <OptionList options={options} value={value} onChange={onChange} allLabel="All accounts"
          placeholder="Search account by name or GL code" empty="No accounts with activity for this selection." />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Totals add up the picked accounts only.{showHistorical ? '' : ' Customize > Show historical accounts lists the (H) ones too.'}</span>
          <button type="button" className="primary-btn" style={{ fontSize: '0.75rem', padding: '3px 12px' }} onClick={() => setOpen(false)}>Done</button>
        </div>
      </PopoverPanel>
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
  // A preset keeps arrow - period - arrow on one row: on a phone the long
  // "Year-to-Date · dates" option narrows instead of pushing each arrow onto
  // a line of its own (QA, Sep 23). Custom dates still wrap.
  const custom = config.preset === 'custom';
  return (
    <div role="group" aria-label="Report period" style={custom ? group : { ...group, flexWrap: 'nowrap', minWidth: 0, maxWidth: '100%' }}>
      <button type="button" style={{ ...arrow, flexShrink: 0 }} onClick={() => step(-1)} aria-label="Previous period" title="Previous period"><ChevronLeft size={14} /></button>
      <select value={config.preset} onChange={(e) => onChange({ preset: e.target.value })} aria-label="Period" style={{ ...control, maxWidth: 300, minWidth: 0 }}>
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
      <button type="button" style={{ ...arrow, flexShrink: 0 }} onClick={() => step(1)} aria-label="Next period" title="Next period"><ChevronRight size={14} /></button>
    </div>
  );
}

// Row density, the finance app's three steps.
export const DENSITIES = [
  { key: 'comfortable', label: 'Comfortable', py: '10px', title: 'Roomy rows' },
  { key: 'compact', label: 'Compact', py: '5px', title: 'Tight rows, like Intacct' },
  { key: 'condensed', label: 'Condensed', py: '2px', title: 'As many rows on screen as possible' },
];

// Customize: how the statement is drawn. The density and whether historical
// entities are offered are the person's own (every accounting screen follows
// them); showing the accounts with nothing in them belongs to the report and
// is memorized with it.
export function CustomizeButton({ density, onDensity, showZero, onShowZero, showHistorical, onShowHistorical, showHistoricalAccounts, onShowHistoricalAccounts, flux = null, onFlux, align = 'right', active = false, children = null }) {
  const [open, setOpen, ref] = usePopover();
  // Oct 6 (MRI): `children` adds a screen's own toggles at the foot (Show Inactive...), `active` lights the button for them; no onShowZero, no zero-balances toggle.
  const on = !!showZero || !!showHistorical || !!showHistoricalAccounts || active;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" style={button(on)} onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}>
        <Settings2 size={14} style={{ flexShrink: 0, color: on ? 'inherit' : 'var(--text-muted)' }} /> Customize
      </button>
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} align={align} role="dialog" aria-label="Customize" style={{ ...panel(320), display: 'grid', gap: 10 }}>
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
        {onShowZero && <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.8rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={!!showZero} onChange={(e) => onShowZero(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            Show zero balances
            <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>Accounts with 0.00 in every column are hidden until this is on. One column with activity keeps a line.</span>
          </span>
        </label>}
        {onShowHistorical && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.8rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!showHistorical} onChange={(e) => onShowHistorical(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              Show historical entities
              <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>The (H) entities Intacct keeps for old books, in the Entities list.</span>
            </span>
          </label>
        )}
        {onShowHistoricalAccounts && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.8rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!showHistoricalAccounts} onChange={(e) => onShowHistoricalAccounts(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              Show historical accounts
              <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>The (H) accounts, departments, vendors and the rest, in the Accounts and Filters lists.</span>
            </span>
          </label>
        )}
        {flux && onFlux && (
          <div>
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>Flux thresholds</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                Variance %
                <input type="number" min={0} step={0.5} value={flux.fluxPct} aria-label="Flux variance percent threshold" onChange={(e) => onFlux({ fluxPct: Math.max(0, Number(e.target.value) || 0) })} style={{ ...control, width: 72 }} className="num" />
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                Variance $
                <input type="number" min={0} step={100} value={flux.fluxAmount} aria-label="Flux variance amount threshold" onChange={(e) => onFlux({ fluxAmount: Math.max(0, Number(e.target.value) || 0) })} style={{ ...control, width: 96 }} className="num" />
              </label>
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>A line is flagged when its variance passes both. Memorized with the report.</div>
          </div>
        )}
        {children}
      </PopoverPanel>
    </div>
  );
}

// One "Export" button with a menu (Charmi, 09/29 call): the file formats
// first, then the ways to send the statement somewhere. `items`:
// [{ key, label, hint?, Icon?, onPick, disabled?, busy?, group? }]. A divider
// is drawn before the first item whose `group` is 'send'.
export function ExportMenu({ items, disabled = false, align = 'right' }) {
  const [open, setOpen, ref] = usePopover();
  const busy = items.some((i) => i.busy);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="primary-btn" onClick={() => setOpen((v) => !v)} disabled={disabled} aria-haspopup="menu" aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' }}>
        {busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Export <ChevronDown size={13} />
      </button>
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} align={align} role="menu" aria-label="Export" style={{ ...panel(270), padding: 6 }}>
        {items.map((it, i) => {
          const Icon = it.Icon || (it.key === 'pdf' ? FileDown : it.key === 'excel' ? FileSpreadsheet : Download);
          return (
            <Fragment key={it.key}>
              {it.group === 'send' && items[i - 1]?.group !== 'send' && <div style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />}
              <button type="button" role="menuitem" disabled={it.disabled || it.busy} onClick={() => { setOpen(false); it.onPick(); }}
                style={{ ...row(false), opacity: it.disabled ? 0.5 : 1, cursor: it.disabled ? 'default' : 'pointer', padding: '7px 8px' }}>
                {it.busy ? <Loader2 size={14} className="spin" style={{ color: 'var(--text-muted)' }} /> : <Icon size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600 }}>{it.label}</span>
                  {it.hint && <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>{it.hint}</span>}
                </span>
              </button>
            </Fragment>
          );
        })}
      </PopoverPanel>
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
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} align={align} role="dialog" aria-label="Memorize this report" style={panel(330)}>
        <form onSubmit={save} style={{ display: 'grid', gap: 8 }}>
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
      </PopoverPanel>
    </div>
  );
}

// The memorized reports: one click opens one. The person who saved a report
// can share it with the team or delete it.
export function SavedReportsMenu({ reports, loading, error, activeId, onOpen, onDelete, onShare, onManage, nameOf, align = 'right' }) {
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
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} align={align} role="menu" aria-label="Saved Reports" style={panel(480)}>
        {reports.length > 6 && (
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search saved reports" aria-label="Search saved reports" style={{ ...control, width: '100%', marginBottom: 6 }} />
        )}
        <div style={{ maxHeight: LIST_HEIGHT, overflowY: 'auto', display: 'grid', gap: 1 }}>
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
        {onManage && (
          <div style={{ borderTop: '1px solid var(--border-color)', marginTop: 6, paddingTop: 6 }}>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onManage(); }} style={{ ...row(false), fontWeight: 600, color: 'var(--wk-brand, #2b45e1)' }}>
              Manage Saved Reports...
            </button>
          </div>
        )}
      </PopoverPanel>
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
