import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, BookmarkPlus, Building2, Check, ChevronDown, ChevronLeft, ChevronRight, Download, FileDown, FileSpreadsheet, Funnel, ListFilter, Loader2, Search, SlidersHorizontal, Trash2, Users, X } from 'lucide-react';
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

// What a search leaves on a list: the rows that match, plus - for a tree
// (rows carrying `parent`) - every ancestor of a match, flagged `dim`, so the
// hierarchy still reads (Charmi, 10/06: "66001-1" alone says nothing about
// where it sits). Order is kept. Exported for the tests.
export function filterOptions(options, query) {
  const s = (query || '').trim().toLowerCase();
  if (!s) return options;
  const hit = (o) => o.code.toLowerCase().includes(s) || (o.name || '').toLowerCase().includes(s);
  const matched = new Set(options.filter(hit).map((o) => o.code));
  const byCode = new Map(options.map((o) => [o.code, o]));
  const need = new Set(matched);
  matched.forEach((code) => {
    let p = byCode.get(code)?.parent;
    for (let guard = 0; p && !need.has(p) && guard < 50; guard += 1) { need.add(p); p = byCode.get(p)?.parent; }
  });
  return options.filter((o) => need.has(o.code)).map((o) => (matched.has(o.code) ? o : { ...o, dim: true }));
}

// A searchable list with a tick per row. `options`: [{ code, name, depth?, group?, parent?, plain? }];
// a heading is drawn wherever `group` changes. `codeFirst` draws the code on
// the LEFT in a fixed, muted, tabular column (the entity pickers, Charmi
// 10/06); `plain` rows (a picker's extra top options) have no code shown.
// `onPick(code)` turns it into a single-select list: a click or Enter picks.
// Arrow keys move through the rows, Enter ticks / picks the highlighted one.
function OptionList({ options, value, onChange, onPick, placeholder, empty, loading, error, allLabel, codeFirst = false, maxHeight = LIST_HEIGHT }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(-1);
  const listRef = useRef(null);
  const chosen = useMemo(() => new Set(value), [value]);
  const shown = useMemo(() => filterOptions(options, q).slice(0, 400), [options, q]);
  const toggle = (code) => {
    if (onPick) { onPick(code); return; }
    const next = new Set(chosen);
    if (next.has(code)) next.delete(code); else next.add(code);
    onChange([...next]);
  };
  const step = (from, dir) => {
    for (let i = from + dir; i >= 0 && i < shown.length; i += dir) if (!shown[i].dim) return i;
    return from;
  };
  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector(`[data-opt-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => step(a, e.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const target = active >= 0 ? shown[active] : q.trim() ? shown[step(-1, 1)] : null;
    if (target && !target.dim) toggle(target.code);
  };
  return (
    <>
      <div style={{ position: 'relative' }}>
        <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--text-muted)' }} />
        <input type="text" value={q} onChange={(e) => { setQ(e.target.value); setActive(-1); }} onKeyDown={onKeyDown} placeholder={placeholder} aria-label={placeholder} autoFocus
          style={{ ...control, width: '100%', paddingLeft: 26 }} />
      </div>
      <div ref={listRef} style={{ maxHeight, overflowY: 'auto', overflowX: 'hidden', marginTop: 6, display: 'grid', gap: 1 }}>
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
          const indent = (o.depth || 0) * 14;
          return (
            <Fragment key={o.code}>
              {o.group && o.group !== shown[i - 1]?.group && (
                <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', padding: '6px 8px 2px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{o.group}</div>
              )}
              <button type="button" role="option" aria-selected={on} data-opt-index={i} disabled={o.dim} tabIndex={-1}
                style={{ ...row(on), ...(i === active ? { outline: '2px solid var(--wk-brand, #2b45e1)', outlineOffset: -2 } : {}), ...(o.dim ? { opacity: 0.5, cursor: 'default' } : {}) }}
                onClick={() => toggle(o.code)} onMouseMove={() => { if (!o.dim && active !== i && active >= 0) setActive(i); }}>
                <span style={{ width: 14, flexShrink: 0, display: 'inline-flex', color: 'var(--wk-brand, #2b45e1)' }}>{on ? <Check size={14} /> : null}</span>
                {codeFirst ? (
                  <>
                    {!o.plain && <span style={{ width: 64, flexShrink: 0, fontSize: '0.72rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.code}</span>}
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: indent, fontWeight: o.plain ? 600 : 400 }}>{o.name || (o.plain ? o.code : 'Unnamed')}</span>
                  </>
                ) : (
                  <>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: o.depth ? 14 : 0 }}>{o.name || o.code}</span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{o.name ? o.code : ''}</span>
                  </>
                )}
              </button>
            </Fragment>
          );
        })}
        {!loading && !error && !shown.length && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: 6 }}>{options.length ? 'No match.' : empty}</div>}
      </div>
    </>
  );
}

const byCodeNumeric = (a, b) => a.code.localeCompare(b.code, 'en-US', { numeric: true });

// The entity tree, flattened for a picker (Oct 7, item 40): roots first, each
// followed by its sub-entities to ANY depth (66000 > 66001 > 66001-1), in
// NUMBER order at every level (Neil, 09/29 call: 30000 sat above 10000 when
// they read by name). Historical (H) entities are left out unless asked for
// or kept (`keep`: codes already picked, so an edit never blanks); the child
// of a hidden parent hangs under its nearest VISIBLE ancestor instead of
// falling to the end of the list.
//
// Returns [{ code, name, depth, parent }] - `parent` is the visible parent's
// code ('' for a root), which the search uses to keep ancestors on screen.
export function entityOptions(entities, { showHistorical = false, keep = [] } = {}) {
  const kept = new Set(keep);
  const all = new Map((entities || []).map((e) => [e.code, e]));
  const list = (entities || []).filter((e) => e?.code && (showHistorical || kept.has(e.code) || !isHistoricalEntity(e)));
  const visible = new Set(list.map((e) => e.code));
  const parentOf = (e) => {
    let p = e.parent_code;
    const seen = new Set([e.code]);
    while (p && !visible.has(p) && all.has(p) && !seen.has(p)) { seen.add(p); p = all.get(p).parent_code; }
    return p && visible.has(p) && p !== e.code ? p : '';
  };
  const kids = new Map();
  const roots = [];
  list.forEach((e) => {
    const p = parentOf(e);
    if (!p) roots.push(e);
    else { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(e); }
  });
  const out = [];
  const done = new Set();
  const walk = (e, depth, parent) => {
    if (done.has(e.code)) return;      // a parent loop in the data: draw each entity once
    done.add(e.code);
    out.push({ code: e.code, name: e.name || '', depth, parent });
    (kids.get(e.code) || []).sort(byCodeNumeric).forEach((k) => walk(k, depth + 1, e.code));
  };
  roots.sort(byCodeNumeric).forEach((r) => walk(r, 0, ''));
  // Anything only reachable through a loop still gets a row.
  list.filter((e) => !done.has(e.code)).sort(byCodeNumeric).forEach((e) => walk(e, 0, ''));
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
        <OptionList options={options} value={value} onChange={onChange} allLabel={all} codeFirst
          placeholder="Search entity by name or code" empty="No entities on the ledger yet." />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 10 }}>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{value.length > 1 ? 'Several entities add together.' : showHistorical ? 'An entity includes its sub-entities.' : 'An entity includes its sub-entities. Customize > Show Historical Entities lists the (H) ones too.'}</span>
          <button type="button" className="primary-btn" style={{ fontSize: '0.75rem', padding: '3px 12px' }} onClick={() => setOpen(false)}>Done</button>
        </div>
      </PopoverPanel>
    </div>
  );
}

// ONE entity, the module's standard single-select picker (Oct 7, items 12 +
// 14: "standardize this across the module as you have done in reports").
// Same list as EntitiesPicker: search by name or code, code on the left,
// the real tree, arrow keys + Enter, historical (H) entities hidden unless
// `showHistorical` (the current value always stays listed).
//
// Props:
//   entities        [{ code, name, parent_code? }] - the ledger's entity list
//   value           the picked code ('' = none)
//   onChange(code)  called with the new code (an extra's code, or '' for None)
//   extra           [{ code, name }] options drawn above the entities, e.g. the
//                   dashboard's ALL / CTL / NC scopes
//   groups          [{ label, match(entity) }] to split the entities under
//                   headings (each group is its own tree), e.g. Controllable / Partner
//   noneLabel       adds a top row that clears the value ('' ) - e.g. "None"
//   placeholder     the button text with nothing picked (default "Pick an Entity")
//   showHistorical, align ('left' | 'right'), disabled, ariaLabel (default "Entity"),
//   active          light the button (default: a value that is not extra[0])
//   style           merged over the button style (e.g. a width inside a table cell)
export function EntityPicker({ entities, value = '', onChange, extra = [], groups = null, noneLabel = '', placeholder = 'Pick an Entity', showHistorical = false, align = 'left', disabled = false, ariaLabel = 'Entity', active, style = null }) {
  const [open, setOpen, ref] = usePopover();
  const options = useMemo(() => {
    const keep = value ? [value] : [];
    const top = [
      ...(noneLabel ? [{ code: '', name: noneLabel, plain: true, depth: 0 }] : []),
      ...extra.map((x) => ({ code: x.code, name: x.name, plain: true, depth: 0 })),
    ];
    const list = entities || [];
    const body = groups?.length
      ? groups.flatMap((g) => entityOptions(list.filter(g.match), { showHistorical, keep }).map((o) => ({ ...o, group: g.label })))
      : entityOptions(list, { showHistorical, keep });
    return [...top, ...body];
  }, [entities, value, extra, groups, noneLabel, showHistorical]);
  const x = extra.find((o) => o.code === value);
  const e = !x && value ? (entities || []).find((o) => o.code === value) : null;
  const label = x ? x.name : value ? `${e?.name || 'Unnamed'} (${value})` : (noneLabel || placeholder);
  const lit = active ?? (!!value && value !== extra[0]?.code);
  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 0 }}>
      <button type="button" style={{ ...button(lit), ...(disabled ? { opacity: 0.6, cursor: 'default' } : {}), ...(style || {}) }} disabled={disabled}
        onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} title={label}>
        <Building2 size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, textAlign: 'left' }}>{label}</span>
        <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
      </button>
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} align={align} role="listbox" aria-label={ariaLabel} style={panel(500)}>
        <OptionList options={options} value={[value]} onPick={(code) => { setOpen(false); if (code !== value) onChange(code); }} codeFirst
          placeholder="Search entity by name or code" empty="No entities on the ledger yet." />
      </PopoverPanel>
    </div>
  );
}

// A header checkbox for a list of rows: ticked when every row is, a dash
// (indeterminate) when some are, empty when none (Oct 7, item 45). Clicking
// it ticks all when not all are ticked, else clears all.
//   checked   number of rows ticked        total   number of rows it acts on
//   onChange(all: boolean)                 label   aria-label (default "Select All")
export function SelectAllCheckbox({ checked, total, onChange, label = 'Select All', disabled = false, style = null }) {
  const ref = useRef(null);
  const all = total > 0 && checked >= total;
  const some = checked > 0 && !all;
  useEffect(() => { if (ref.current) ref.current.indeterminate = some; }, [some]);
  return (
    <input ref={ref} type="checkbox" checked={all} aria-checked={some ? 'mixed' : all} aria-label={label} title={all ? 'Clear All' : 'Select All'}
      disabled={disabled || !total} onChange={() => onChange(!all)} style={{ cursor: disabled || !total ? 'default' : 'pointer', ...(style || {}) }} />
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
        <Funnel size={14} style={{ flexShrink: 0, color: n ? 'inherit' : 'var(--text-muted)' }} />
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

// Rows per page (Oct 7, item 21): Off is one long list, as before.
export const PAGE_SIZES = [
  { key: 0, label: 'Off' },
  { key: 50, label: '50' },
  { key: 100, label: '100' },
  { key: 150, label: '150' },
];

const sectionHead = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 };
const segGroup = { display: 'inline-flex', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' };
const seg = (on) => ({ border: 'none', borderRight: '1px solid var(--border-color)', background: on ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)', color: on ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', font: 'inherit', fontSize: '0.74rem', fontWeight: 600, padding: '5px 10px', cursor: 'pointer' });

function Toggle({ checked, onChange, label, hint }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.8rem', cursor: 'pointer' }}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 2 }} />
      <span>
        {label}
        {hint && <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>{hint}</span>}
      </span>
    </label>
  );
}

function PageSizeChoice({ pageSize, onPageSize }) {
  const n = Number(pageSize) || 0;
  const standard = PAGE_SIZES.some((p) => p.key === n);
  const [other, setOther] = useState(!standard);
  const [text, setText] = useState(standard ? '' : String(n));
  const pick = (k) => { setOther(false); onPageSize(k); };
  return (
    <div>
      <div style={sectionHead}>Rows per Page</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div role="group" aria-label="Rows per Page" style={segGroup}>
          {PAGE_SIZES.map((p) => (
            <button key={p.key} type="button" onClick={() => pick(p.key)} aria-pressed={!other && n === p.key} style={seg(!other && n === p.key)}>{p.label}</button>
          ))}
          <button type="button" onClick={() => setOther(true)} aria-pressed={other} style={{ ...seg(other), borderRight: 'none' }}>Other</button>
        </div>
        {other && (
          <input type="number" min={1} step={1} value={text} placeholder="Rows" aria-label="Rows per page" className="num" autoFocus
            onChange={(e) => { setText(e.target.value); const v = Math.floor(Number(e.target.value)); if (v >= 1) onPageSize(Math.min(v, 10000)); }}
            style={{ ...control, width: 80 }} />
        )}
      </div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>Off shows one long list. Exports always include every row.</div>
    </div>
  );
}

// Customize - the ONE standard customize button of the Accounting module
// (Oct 7, items 9 / 21 / 34: Neil, "standardize Customize across the entire
// module"): the SlidersHorizontal icon used all across Nexus, then a panel
// of sections. Every section draws only when its handler is passed, so a
// screen offers just what applies to it:
//   density / onDensity                     Row Density (Comfortable / Compact / Condensed)
//   pageSize / onPageSize                   Rows per Page (Off = 0, 50, 100, 150, Other n)
//   showZero / onShowZero                   Show Zero Balances
//   showHistorical / onShowHistorical       Show Historical Entities
//   showHistoricalAccounts / onShowHistoricalAccounts   Show Historical Accounts
//   showInactiveAccounts / onShowInactiveAccounts       Show Inactive Accounts (off by default)
//   flux / onFlux                           the Flux Analysis thresholds
//   children                                the screen's own options, under the shared ones
//   active                                  light the button for a screen option that is on
// `useCustomizePrefs` (./tableHooks) hands back the person's saved values and
// handlers for the shared ones, ready to spread onto this button.
export function CustomizeButton({ density, onDensity, pageSize = 0, onPageSize, showZero, onShowZero, showHistorical, onShowHistorical, showHistoricalAccounts, onShowHistoricalAccounts, showInactiveAccounts, onShowInactiveAccounts, flux = null, onFlux, align = 'right', active = false, children = null }) {
  const [open, setOpen, ref] = usePopover();
  const on = !!showZero || !!showHistorical || !!showHistoricalAccounts || !!showInactiveAccounts || !!active;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" style={button(on)} onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}>
        <SlidersHorizontal size={14} style={{ flexShrink: 0, color: on ? 'inherit' : 'var(--text-muted)' }} /> Customize
      </button>
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} align={align} role="dialog" aria-label="Customize" style={{ ...panel(340), display: 'grid', gap: 12 }}>
        {onDensity && (
          <div>
            <div style={sectionHead}>Row Density</div>
            <div role="group" aria-label="Row Density" style={segGroup}>
              {DENSITIES.map((d, i) => (
                <button key={d.key} type="button" onClick={() => onDensity(d.key)} title={d.title} aria-pressed={density === d.key}
                  style={{ ...seg(density === d.key), ...(i === DENSITIES.length - 1 ? { borderRight: 'none' } : {}) }}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {onPageSize && <PageSizeChoice pageSize={pageSize} onPageSize={onPageSize} />}
        {onShowZero && <Toggle checked={showZero} onChange={onShowZero} label="Show Zero Balances"
          hint="Accounts with 0.00 in every column are hidden until this is on. One column with activity keeps a line." />}
        {onShowHistorical && <Toggle checked={showHistorical} onChange={onShowHistorical} label="Show Historical Entities"
          hint="The (H) entities Intacct keeps for old books, in the entity lists." />}
        {onShowHistoricalAccounts && <Toggle checked={showHistoricalAccounts} onChange={onShowHistoricalAccounts} label="Show Historical Accounts"
          hint="The (H) accounts, departments, vendors and the rest, in the Accounts and Filters lists." />}
        {onShowInactiveAccounts && <Toggle checked={showInactiveAccounts} onChange={onShowInactiveAccounts} label="Show Inactive Accounts"
          hint="Accounts marked inactive in Intacct are hidden until this is on. Totals still include them." />}
        {flux && onFlux && (
          <div>
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>Flux Thresholds</div>
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

// Previous / "Page 2 of 7 · Rows 51-100 of 312" / Next, under a long table
// (Oct 7, item 21). Takes what `usePaged` (./tableHooks) returns - spread it:
// <Pager {...paged} />. Draws nothing while everything fits on one page.
//   page, pages, from, to (1-based, inclusive), total, setPage(n)
export function Pager({ page, pages, from, to, total, setPage, style = null }) {
  if (!pages || pages <= 1) return null;
  const n = (v) => Number(v).toLocaleString('en-US');
  const btn = (disabled) => ({ ...control, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1, color: 'var(--text-secondary)' });
  return (
    <nav aria-label="Pages" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '10px 0', flexWrap: 'wrap', ...(style || {}) }}>
      <button type="button" style={btn(page <= 1)} disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={14} /> Previous</button>
      <span role="status" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
        Page {n(page)} of {n(pages)} · Rows {n(from)}-{n(to)} of {n(total)}
      </span>
      <button type="button" style={btn(page >= pages)} disabled={page >= pages} onClick={() => setPage(page + 1)}>Next <ChevronRight size={14} /></button>
    </nav>
  );
}

// The drag handle on a report column's right edge (Oct 7, item 32). Put it
// inside the <th> (which needs position: relative) and spread what
// `useColumnWidths(...).resizer(key)` (./tableHooks) returns:
//   <th style={{ position: 'relative', width: cols.width('memo') }}>Memo <ColumnResizer {...cols.resizer('memo')} /></th>
// Drag = resize (live), release = saved, double-click = fit the content.
export function ColumnResizer({ label = 'Resize the column', onStart, onDrag, onEnd, onFit }) {
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.parentElement;
    const startX = e.clientX;
    const startW = th ? th.getBoundingClientRect().width : 0;
    onStart?.(startW);
    setDragging(true);
    const move = (ev) => onDrag(Math.round(startW + ev.clientX - startX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragging(false);
      onEnd?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onDoubleClick = (e) => {
    e.stopPropagation();
    const th = e.currentTarget.parentElement;
    const table = th?.closest('table');
    if (!th || !table) { onFit(0); return; }
    // The widest cell in the column: scrollWidth is the full text even where
    // the cell truncates it with "...".
    const idx = th.cellIndex;
    let widest = th.scrollWidth;
    Array.from(table.rows).forEach((r) => { const c = r.cells[idx]; if (c && c.colSpan === 1) widest = Math.max(widest, c.scrollWidth); });
    onFit(Math.ceil(widest) + 4);
  };
  return (
    <span role="separator" aria-orientation="vertical" aria-label={label} title="Drag to resize · double-click to fit"
      onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} onClick={(e) => e.stopPropagation()}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ position: 'absolute', top: 0, right: 0, width: 6, height: '100%', cursor: 'col-resize', touchAction: 'none', zIndex: 2,
        background: hover || dragging ? 'var(--wk-brand, #2b45e1)' : 'transparent', opacity: hover || dragging ? 0.35 : 1 }} />
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
