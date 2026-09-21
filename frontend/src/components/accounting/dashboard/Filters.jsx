import { useMemo } from 'react';
import { Building2, CalendarRange, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { monthLong, shiftKey } from '../../../accounting/dashboard/model/months';
import { SCOPE_LABEL } from '../../../accounting/dashboard/model/scope';
import { useDash } from './DashContext';
import { input, pill } from './Bits';

// The dashboard's global filter row: scope (consolidation group or one
// entity), month, and book. Pinned above every tab.

const BOOKS = [['accrual', 'Accrual'], ['cash', 'Cash'], ['all', 'Both books']];

export function ScopeSelect() {
  const { ix, scope, setScope } = useDash();
  const { ctl, nc } = useMemo(() => {
    const byName = (a, b) => (a.name || a.code).localeCompare(b.name || b.code, 'en-US', { numeric: true });
    const roots = [...ix.roots].sort(byName);
    return { ctl: roots.filter((e) => !e.is_partner), nc: roots.filter((e) => e.is_partner) };
  }, [ix]);
  const opt = (e) => <option key={e.code} value={e.code}>{(e.name || e.code) + (e.currency === 'INR' ? ' (INR)' : '')}</option>;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Building2 size={14} style={{ color: 'var(--text-muted)' }} />
      <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope" style={{ ...input, maxWidth: 300, ...(scope !== 'ALL' ? { borderColor: 'var(--wk-brand, #2b45e1)', color: 'var(--wk-brand, #2b45e1)', fontWeight: 600 } : {}) }}>
        {['ALL', 'CTL', 'NC'].map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
        <optgroup label="Controllable entities">{ctl.map(opt)}</optgroup>
        {nc.length ? <optgroup label="Partner entities (non-controllable)">{nc.map(opt)}</optgroup> : null}
      </select>
    </div>
  );
}

export function MonthStepper() {
  const { period, setPeriod, periodOptions, lastClosed } = useDash();
  const options = periodOptions.includes(period) ? periodOptions : [period, ...periodOptions];
  const btn = { ...input, padding: '4px 6px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' };
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button type="button" aria-label="Previous month" style={btn} onClick={() => setPeriod(shiftKey(period, 1))}><ChevronLeft size={14} /></button>
      <CalendarRange size={14} style={{ color: 'var(--text-muted)' }} />
      <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Month" style={{ ...input, ...(period !== lastClosed ? { borderColor: 'var(--wk-brand, #2b45e1)', color: 'var(--wk-brand, #2b45e1)', fontWeight: 600 } : {}) }}>
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

/** The pinned filter row. `right` holds tab-specific controls (view picker, scenario). */
export function Toolbar({ right, hidePeriod }) {
  const { refetchAll, ix, scope } = useDash();
  const partners = ['ALL', 'CTL', 'NC'].includes(scope) ? '' : ix.byCode.get(scope)?.partners;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
      <ScopeSelect />
      {!hidePeriod ? <MonthStepper /> : null}
      <BookPills />
      {partners ? <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Partner entity · {partners}</span> : null}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        {right}
        <button type="button" className="icon-btn" title="Refresh figures" aria-label="Refresh figures" onClick={refetchAll} style={{ padding: 6 }}><RefreshCw size={14} /></button>
      </div>
    </div>
  );
}
