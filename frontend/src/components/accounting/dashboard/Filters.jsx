import { useMemo } from 'react';
import { CalendarRange, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { monthLong, shiftKey } from '../../../accounting/dashboard/model/months';
import { SCOPE_LABEL } from '../../../accounting/dashboard/model/scope';
import { useDash } from './DashContext';
import { card, input, pill } from './Bits';
import { EntityPicker } from '../reportControls';
import { formatDateTime, formatTime } from '../../../lib/datetime';

// The dashboard's global filter row: scope (consolidation group or one
// entity), month, and book. Pinned above every tab.

const BOOKS = [['accrual', 'Accrual'], ['cash', 'Cash'], ['all', 'Both books']];

// Oct 7 (Neil, comment 8): the module's one entity picker - searchable by
// name or number, numbers shown - with the three consolidation scopes on top.
// A scope is a top-level entity (the figures roll up to roots), so only roots
// are listed, controllable first, then the partner ones.
const SCOPE_EXTRA = ['ALL', 'CTL', 'NC'].map((code) => ({ code, name: SCOPE_LABEL[code] }));
const SCOPE_GROUPS = [
  { label: 'Controllable Entities', match: (e) => !e.is_partner },
  { label: 'Partner Entities (Non-Controllable)', match: (e) => !!e.is_partner },
];

export function ScopeSelect() {
  const { ix, scope, setScope, hasPartners } = useDash();
  // No partner entity at all: "Partner Entities Only" would only ever show
  // zeros, so it is not offered (Oct 7, Neil comment 7).
  const extra = useMemo(() => (hasPartners ? SCOPE_EXTRA : SCOPE_EXTRA.filter((x) => x.code !== 'NC')), [hasPartners]);
  const roots = useMemo(
    () => ix.roots.map((e) => ({ ...e, parent_code: '', name: (e.name || e.code) + (e.currency === 'INR' ? ' (INR)' : '') })),
    [ix],
  );
  return (
    <EntityPicker entities={roots} value={scope} onChange={setScope} extra={extra} groups={SCOPE_GROUPS} ariaLabel="Scope" active={scope !== 'ALL'} />
  );
}

/** Range presets, all ending at the chosen month. `months` is how many to include; null = custom start. */
const RANGES = [
  { id: 'month', label: 'Single month', months: 1 },
  { id: 'quarter', label: 'Quarter to date', months: null, quarter: true },
  { id: 'ytd', label: 'Year to date', months: null, ytd: true },
  { id: 'l3', label: 'Last 3 months', months: 3 },
  { id: 'l6', label: 'Last 6 months', months: 6 },
  { id: 't12', label: 'Trailing 12 months', months: 12 },
  { id: 'custom', label: 'Custom start…', months: null },
];
const quarterStart = (k) => `${k.slice(0, 4)}-${String(Math.floor((Number(k.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}`;
const rangeStart = (preset, to) => {
  if (preset.quarter) return quarterStart(to);
  if (preset.ytd) return `${to.slice(0, 4)}-01`;
  return shiftKey(to, (preset.months ?? 1) - 1);
};
const presetOf = (from, to) => RANGES.find((p) => p.id !== 'custom' && rangeStart(p, to) === from)?.id ?? 'custom';

/** Month picker with ranges: pick a preset (or a custom start) and step the end month; the range keeps its length. */
export function MonthStepper() {
  const { period, fromKey, setPeriod, setRange, periodOptions, lastClosed } = useDash();
  const options = periodOptions.includes(period) ? periodOptions : [period, ...periodOptions];
  const btn = { ...input, padding: '4px 6px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' };
  const active = { borderColor: 'var(--wk-brand, #2b45e1)', color: 'var(--wk-brand, #2b45e1)', fontWeight: 600 };
  const preset = presetOf(fromKey, period);
  const fromOptions = periodOptions.filter((k) => k <= period);
  return (
    <div style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      <CalendarRange size={14} style={{ color: 'var(--text-muted)' }} />
      <select value={preset} aria-label="Period range" style={{ ...input, ...(preset !== 'month' ? active : {}) }}
        onChange={(e) => { const p = RANGES.find((x) => x.id === e.target.value); if (!p) return; if (p.id === 'custom') setRange(shiftKey(period, 2), period); else setRange(rangeStart(p, period), period); }}>
        {RANGES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      {preset !== 'month' ? (
        <>
          <select value={fromKey} onChange={(e) => setRange(e.target.value, period)} aria-label="From month" style={{ ...input, ...active }}>
            {(fromOptions.includes(fromKey) ? fromOptions : [fromKey, ...fromOptions]).map((k) => <option key={k} value={k}>{monthLong(k)}</option>)}
          </select>
          <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>through</span>
        </>
      ) : null}
      <button type="button" aria-label="Previous month" style={btn} onClick={() => setPeriod(shiftKey(period, 1))}><ChevronLeft size={14} /></button>
      <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Month" style={{ ...input, ...(period !== lastClosed ? active : {}) }}>
        {options.map((k) => <option key={k} value={k}>{monthLong(k)}{k === lastClosed ? ' · last closed' : ''}</option>)}
      </select>
      <button type="button" aria-label="Next month" style={{ ...btn, opacity: period >= lastClosed ? 0.4 : 1 }} disabled={period >= lastClosed} onClick={() => setPeriod(shiftKey(period, -1))}><ChevronRight size={14} /></button>
    </div>
  );
}

export function BookPills() {
  const { book, setBook } = useDash();
  return (
    <div className="scroll-tabs" style={{ display: 'flex', gap: 4 }}>
      {BOOKS.map(([k, label]) => <button key={k} type="button" style={{ ...pill(book === k), padding: '4px 10px', fontSize: '0.74rem' }} onClick={() => setBook(k)}>{label}</button>)}
    </div>
  );
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const whenShort = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : sameDay(d, new Date()) ? formatTime(d) : formatDateTime(d); };

/** Refresh (Oct 7, Priyanka): fresh figures from the accounting app, the icon
 *  spins while any dashboard figure loads, then a quiet "Updated 2:41 PM" -
 *  and how fresh the ledger itself is when the accounting app says. */
export function RefreshButton() {
  const { refetchAll, fetching, updatedAt, ledgerSyncedAt } = useDash();
  const synced = ledgerSyncedAt ? whenShort(ledgerSyncedAt) : '';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {updatedAt || synced ? (
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {updatedAt ? `Updated ${formatTime(updatedAt)}` : ''}{updatedAt && synced ? ' · ' : ''}{synced ? `Ledger synced from Intacct ${synced}` : ''}
        </span>
      ) : null}
      <button type="button" className="icon-btn" title="Refresh figures" aria-label="Refresh figures" aria-busy={fetching} disabled={fetching} onClick={() => { refetchAll(); }} style={{ padding: 6, cursor: fetching ? 'default' : 'pointer' }}>
        <RefreshCw size={14} data-spinning={fetching ? 'true' : undefined} style={fetching ? { animation: 'spin 0.9s linear infinite' } : undefined} />
      </button>
    </span>
  );
}

/** The pinned filter row. `right` holds tab-specific controls (view picker, scenario).
 *  Oct 6 (Neil: "standardize this and the filters as well"): the same slim
 *  card row, directly under the tabs and left aligned, that Reports, Budget,
 *  Vendors & Customers and Allocations draw. */
export function Toolbar({ right, hidePeriod }) {
  const { ix, scope } = useDash();
  const partners = ['ALL', 'CTL', 'NC'].includes(scope) ? '' : ix.byCode.get(scope)?.partners;
  return (
    <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
      <ScopeSelect />
      {!hidePeriod ? <MonthStepper /> : null}
      <BookPills />
      {partners ? <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Partner entity · {partners}</span> : null}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        {right}
        <RefreshButton />
      </div>
    </div>
  );
}
