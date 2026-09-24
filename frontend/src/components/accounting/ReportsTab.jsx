import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, RefreshCw, Building2, Search, X, Plus, Check, ChevronDown } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import LedgerSearch from './LedgerSearch';

// Accounting -> Reports. Pull any statement for any entity straight from the
// ledger without opening Nexus Accounting: Profit & Loss, Balance Sheet,
// Trial Balance, filtered by Intacct location (entity) and period. Read-only,
// served by the accounting app's internal API through the backend proxy (the
// Accounting grant is the gate). Export writes a CSV of the table shown.
//
// The search box on top is the global search (Neil, Sep 17): type a vendor, a
// customer, an invoice number or an amount and every posted line containing it
// replaces the report, inside the entity picked here. Every account amount on
// a report is a drill-down into the same view - the lines behind that number,
// for the report's period and entity - so nobody has to open Intacct to see
// what an amount is made of.
//
// Sep 23-24 (Charmi, Priyanka): every Intacct dimension is a filter (several
// entities, department, employee, vendor, customer, Project-Job, item); the
// period is ONE control that reads "Year to Date · 01/01/2026 - 09/23/2026";
// and a statement can stand beside its prior year or prior period with $ and
// % variance columns.

const REPORTS = [
  { key: 'pnl', label: 'Profit & Loss', period: 'range' },
  { key: 'balance-sheet', label: 'Balance Sheet', period: 'asof' },
  { key: 'trial-balance', label: 'Trial Balance', period: 'range' },
  { key: 'cash-position', label: 'Cash Position', period: 'asof' },
];

const PRESETS = [
  { key: 'month', label: 'This Month' },
  { key: 'last-month', label: 'Last Month' },
  { key: 'quarter', label: 'This Quarter' },
  { key: 'ytd', label: 'Year to Date' },
  { key: 'last-year', label: 'Last Year' },
  { key: 'custom', label: 'Custom' },
];

// What a statement can be compared against. A P&L range compares to the same
// dates a year earlier or to the run of equal length just before it; a
// balance sheet compares to the same date a year earlier or to the previous
// month end.
const COMPARE = {
  range: [
    { key: 'none', label: 'No Comparison' },
    { key: 'prior-year', label: 'vs Prior Year' },
    { key: 'prior-period', label: 'vs Prior Period' },
  ],
  asof: [
    { key: 'none', label: 'No Comparison' },
    { key: 'prior-year', label: 'vs Prior Year' },
    { key: 'prior-month', label: 'vs Prior Month End' },
  ],
};

// The dimensions a report can be narrowed by, in the order Charmi listed them.
// Entities come from the locations endpoint (with parents); the rest list the
// codes that actually appear on the ledger.
const DIM_KINDS = [
  { key: 'departments', kind: 'department', label: 'Department' },
  { key: 'locations', kind: 'location', label: 'Entities' },
  { key: 'employee', kind: 'employee', label: 'Employee' },
  { key: 'vendor', kind: 'vendor', label: 'Vendor' },
  { key: 'customer', kind: 'customer', label: 'Customer' },
  { key: 'project', kind: 'project', label: 'Project-Job' },
  { key: 'item', kind: 'item', label: 'Item' },
];
const EMPTY_DIMS = { locations: [], departments: [], vendor: [], customer: [], employee: [], project: [], item: [] };
const hasDims = (d) => DIM_KINDS.some((k) => d[k.key].length > 0);

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (s) => new Date(`${s}T00:00:00`);
const money = (n) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
};
const pct = (cur, prev) => {
  if (Math.abs(prev) < 0.005) return '';
  const p = ((cur - prev) / Math.abs(prev)) * 100;
  return `${p < 0 ? '(' : ''}${Math.abs(p).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%${p < 0 ? ')' : ''}`;
};

function presetRange(key) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (key) {
    case 'month': return [new Date(y, m, 1), now];
    case 'last-month': return [new Date(y, m - 1, 1), new Date(y, m, 0)];
    case 'quarter': return [new Date(y, Math.floor(m / 3) * 3, 1), now];
    case 'last-year': return [new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)];
    default: return [new Date(y, 0, 1), now];
  }
}

const isMonthStart = (s) => s.slice(8, 10) === '01';
const isMonthEnd = (s) => { const d = parse(s); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() === d.getDate(); };
const endOfMonth = (y, m) => new Date(y, m + 1, 0);
// Same calendar dates a year back; a month end stays a month end (02/29 -> 02/28).
function yearBack(s) {
  const d = parse(s);
  if (isMonthEnd(s)) return iso(endOfMonth(d.getFullYear() - 1, d.getMonth()));
  return iso(new Date(d.getFullYear() - 1, d.getMonth(), Math.min(d.getDate(), endOfMonth(d.getFullYear() - 1, d.getMonth()).getDate())));
}
// The run of months (or days) of the same length just before [from, to].
function priorPeriod(from, to) {
  const f = parse(from);
  const t = parse(to);
  if (isMonthStart(from) && isMonthEnd(to)) {
    const months = (t.getFullYear() - f.getFullYear()) * 12 + (t.getMonth() - f.getMonth()) + 1;
    return [iso(new Date(f.getFullYear(), f.getMonth() - months, 1)), iso(endOfMonth(f.getFullYear(), f.getMonth() - 1))];
  }
  const days = Math.max(1, Math.round((t - f) / 86_400_000) + 1);
  const pt = new Date(f.getTime() - 86_400_000);
  return [iso(new Date(pt.getTime() - (days - 1) * 86_400_000)), iso(pt)];
}
const priorMonthEnd = (s) => { const d = parse(s); return iso(endOfMonth(d.getFullYear(), d.getMonth() - 1)); };

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function downloadCsv(name, rows) {
  const text = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ReportsTab() {
  const [report, setReport] = useState('pnl');
  const [preset, setPreset] = useState('ytd');
  const [[from, to], setRange] = useState(() => presetRange('ytd').map(iso));
  const [asof, setAsof] = useState(() => iso(new Date()));
  const [entity, setEntity] = useState('');
  const [entityFilter, setEntityFilter] = useState('');
  const [entities, setEntities] = useState([]);
  const [dims, setDims] = useState(EMPTY_DIMS);
  const [compare, setCompare] = useState('none');
  const [data, setData] = useState(null);
  const [prior, setPrior] = useState(null);   // the comparison statement, same shape as `data`
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showAccounts, setShowAccounts] = useState(true);
  // Global search + drill-down. `searchText` is what is typed; `term` follows it
  // after a pause so the ledger is not queried on every keystroke.
  const [searchText, setSearchText] = useState('');
  const [term, setTerm] = useState('');
  const [drill, setDrill] = useState(null);   // { account, accountName, from, to }
  useEffect(() => {
    const t = setTimeout(() => setTerm(searchText.trim()), 300);
    return () => clearTimeout(t);
  }, [searchText]);
  const searching = term.length >= 2 || !!drill;
  const closeSearch = () => { setSearchText(''); setTerm(''); setDrill(null); };
  // The lines behind one account's amount, for what the report is showing.
  // Balance-type reports (as of a date) drill from the beginning of the books.
  const drillInto = (accountNo, title) => {
    if (!accountNo) return;
    setDrill({ account: accountNo, accountName: title || '', from: def.period === 'asof' ? '' : from, to: def.period === 'asof' ? asof : to });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const def = REPORTS.find((r) => r.key === report);
  const compareOptions = COMPARE[def.period];
  const canCompare = report === 'pnl' || report === 'balance-sheet';
  const canDims = report !== 'cash-position';
  const activeCompare = canCompare && compare !== 'none' ? compare : 'none';
  // Several entities picked in the Entities filter replace the single picker.
  const effectiveEntity = dims.locations.length ? '' : entity;
  const dimsSent = canDims && hasDims(dims) ? dims : null;

  useEffect(() => {
    api.getAccountingLocations().then((d) => setEntities(d?.entities || [])).catch(() => setEntities([]));
  }, []);

  useEffect(() => {
    if (preset !== 'custom') setRange(presetRange(preset).map(iso));
  }, [preset]);

  // Where the comparison column reads from.
  const priorRange = useMemo(() => {
    if (activeCompare === 'none') return null;
    if (def.period === 'asof') return { asof: activeCompare === 'prior-year' ? yearBack(asof) : priorMonthEnd(asof) };
    if (activeCompare === 'prior-year') return { from: yearBack(from), to: yearBack(to) };
    const [pf, pt] = priorPeriod(from, to);
    return { from: pf, to: pt };
  }, [activeCompare, def.period, from, to, asof]);

  const fetchReport = (range) => {
    const loc = effectiveEntity || undefined;
    if (report === 'pnl') return api.getAccountingPnl(range.from, range.to, loc, dimsSent);
    if (report === 'balance-sheet') return api.getAccountingBalanceSheet(range.asof, loc, dimsSent);
    if (report === 'cash-position') return api.getAccountingCashPosition(range.asof, loc);
    return api.getAccountingTrialBalance(range.from, range.to, loc, dimsSent);
  };

  const seq = useRef(0);
  const run = () => {
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    const current = def.period === 'asof' ? { asof } : { from, to };
    Promise.all([fetchReport(current), priorRange ? fetchReport(priorRange) : Promise.resolve(null)])
      .then(([d, p]) => { if (mine !== seq.current) return; setData({ report, ...d }); setPrior(p ? { report, ...p } : null); })
      .catch((e) => { if (mine !== seq.current) return; setData(null); setPrior(null); setError(e?.message || 'Could not load the report.'); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  };

  // Run on every control change so the tab always shows what the filters say.
  const dimsKey = JSON.stringify(dimsSent);
  useEffect(() => { run(); }, [report, from, to, asof, effectiveEntity, dimsKey, activeCompare]); // eslint-disable-line react-hooks/exhaustive-deps

  const entityName = (code) => {
    if (!code) return 'All entities';
    const e = entities.find((x) => x.code === code);
    return e?.name ? `${e.name} (${code})` : code;
  };

  const grouped = useMemo(() => {
    const q = entityFilter.trim().toLowerCase();
    const list = q ? entities.filter((e) => e.code.toLowerCase().includes(q) || (e.name || '').toLowerCase().includes(q)) : entities;
    const roots = list.filter((e) => !e.parent_code || !entities.some((p) => p.code === e.parent_code));
    const kids = (code) => list.filter((e) => e.parent_code === code);
    const out = [];
    roots.forEach((r) => { out.push({ ...r, depth: 0 }); kids(r.code).forEach((k) => out.push({ ...k, depth: 1 })); });
    // Children whose parent was filtered out still need to appear.
    list.forEach((e) => { if (!out.some((o) => o.code === e.code)) out.push({ ...e, depth: 1 }); });
    return out;
  }, [entities, entityFilter]);

  const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, boxShadow: 'var(--shadow-sm)' };
  const input = { padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: '0.8rem', fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-primary)' };
  const pill = (active) => ({
    padding: '6px 12px', borderRadius: 999, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
    border: `1px solid ${active ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`,
    background: active ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)',
    color: active ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)',
  });
  const presetLabel = PRESETS.find((p) => p.key === preset)?.label || 'Custom';
  const rangeText = `${formatDate(from)} - ${formatDate(to)}`;
  // One control, one line: "Year to Date · 01/01/2026 - 09/23/2026" (Priyanka, Sep 23).
  const periodLabel = def.period === 'asof' ? `As of ${formatDate(asof)}` : `${presetLabel} · ${rangeText}`;
  const priorLabel = !priorRange ? '' : priorRange.asof ? `As of ${formatDate(priorRange.asof)}` : `${formatDate(priorRange.from)} - ${formatDate(priorRange.to)}`;
  const currentLabel = def.period === 'asof' ? `As of ${formatDate(asof)}` : preset === 'ytd' ? 'YTD Actual' : rangeText;
  const comparing = !!prior && activeCompare !== 'none';
  const dimsText = DIM_KINDS.filter((k) => dims[k.key].length).map((k) => (dims[k.key].length === 1 ? `${k.label} ${dims[k.key][0]}` : `${dims[k.key].length} ${k.label.toLowerCase()}${k.key === 'locations' ? '' : 's'}`));

  // The comparison figure for one account / total, looked up in the prior statement.
  const priorAmounts = useMemo(() => {
    const m = new Map();
    if (!prior) return m;
    (prior.sections || []).forEach((s) => (s.accounts || []).forEach((a) => m.set(a.account_no || a.title, a.amount)));
    return m;
  }, [prior]);
  const priorSectionTotal = (key) => (prior?.sections || []).find((s) => s.key === key)?.total ?? 0;
  const priorTotal = (name) => prior?.totals?.[name] ?? 0;

  const exportCsv = () => {
    if (!data) return;
    const rows = [];
    const stamp = def.period === 'asof' ? asof : `${from}_${to}`;
    const cmp = (cur, prev) => (comparing ? [prev, Math.round((cur - prev) * 100) / 100, pct(cur, prev)] : []);
    const cmpHead = comparing ? [priorLabel, '$ Variance', '% Variance'] : [];
    if (data.report === 'pnl') {
      rows.push(['Section', 'Account', 'Title', currentLabel, ...cmpHead]);
      data.sections.forEach((s) => {
        s.accounts.forEach((a) => rows.push([s.label, a.account_no, a.title, a.amount, ...cmp(a.amount, priorAmounts.get(a.account_no || a.title) ?? 0)]));
        rows.push([`Total ${s.label}`, '', '', s.total, ...cmp(s.total, priorSectionTotal(s.key))]);
      });
      rows.push(['Gross Profit', '', '', data.totals.gross_profit, ...cmp(data.totals.gross_profit, priorTotal('gross_profit'))]);
      rows.push(['Operating Income', '', '', data.totals.operating_income, ...cmp(data.totals.operating_income, priorTotal('operating_income'))]);
      rows.push(['Net Income', '', '', data.totals.net_income, ...cmp(data.totals.net_income, priorTotal('net_income'))]);
    } else if (data.report === 'balance-sheet') {
      rows.push(['Section', 'Account', 'Title', currentLabel, ...cmpHead]);
      data.sections.forEach((s) => {
        s.accounts.forEach((a) => rows.push([s.label, a.account_no, a.title, a.amount, ...cmp(a.amount, priorAmounts.get(a.account_no || a.title) ?? 0)]));
        rows.push([`Total ${s.label}`, '', '', s.total, ...cmp(s.total, priorSectionTotal(s.key))]);
      });
      rows.push(['Total Liabilities and Equity', '', '', data.totals.liabilities_and_equity, ...cmp(data.totals.liabilities_and_equity, priorTotal('liabilities_and_equity'))]);
    } else if (data.report === 'cash-position') {
      rows.push(['Account', 'Title', 'Balance', 'Last Activity']);
      data.accounts.forEach((a) => rows.push([a.gl_code, a.account_name, a.balance, a.last_activity ? formatDate(a.last_activity) : '']));
      rows.push(['Total Cash', '', data.total, '']);
    } else {
      rows.push(['Account', 'Title', 'Type', 'Opening', 'Debit', 'Credit', 'Closing']);
      data.rows.forEach((r) => rows.push([r.account_no, r.title, r.type, r.opening, r.debit, r.credit, r.closing]));
      rows.push(['Total', '', '', data.totals.opening, data.totals.debit, data.totals.credit, data.totals.closing]);
    }
    if (dimsText.length) rows.push([], ['Filters', dimsText.join('; ')]);
    downloadCsv(`${def.label.replace(/[^A-Za-z]+/g, '-')}_${effectiveEntity || (dims.locations.length ? 'entities' : 'all-entities')}_${stamp}.csv`, rows);
  };

  const cmpHeader = comparing ? (
    <>
      <th style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{priorLabel}</th>
      <th style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>$ Variance</th>
      <th style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>% Variance</th>
    </>
  ) : null;

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      {/* Controls */}
      <div style={{ ...card, display: 'grid', gap: 12 }}>
        <div style={{ position: 'relative' }}>
          <Search size={16} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--text-muted)' }} />
          <input type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="Search the ledger"
            placeholder="Search everything - vendor, customer, invoice number, amount, memo..."
            style={{ ...input, width: '100%', padding: '9px 36px 9px 36px', fontSize: '0.9rem', boxSizing: 'border-box' }} />
          {searchText && (
            <button type="button" onClick={() => setSearchText('')} aria-label="Clear search"
              style={{ position: 'absolute', right: 10, top: 9, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 2 }}>
              <X size={16} />
            </button>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <div className="scroll-tabs" style={{ display: 'flex', gap: 6 }}>
            {REPORTS.map((r) => (
              <button key={r.key} type="button" style={pill(report === r.key)} onClick={() => { setReport(r.key); closeSearch(); }}>{r.label}</button>
            ))}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button type="button" className="secondary-btn" onClick={run} disabled={loading} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}>
              <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
            </button>
            <button type="button" className="primary-btn" onClick={exportCsv} disabled={!data} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}>
              <Download size={14} /> Export CSV
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          {def.period === 'range' ? (
            <>
              <select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Period" style={{ ...input, fontWeight: 600, maxWidth: 340 }}>
                {PRESETS.map((p) => {
                  const r = p.key === 'custom' ? null : presetRange(p.key).map(iso);
                  return <option key={p.key} value={p.key}>{r ? `${p.label} · ${formatDate(r[0])} - ${formatDate(r[1])}` : 'Custom dates...'}</option>;
                })}
              </select>
              {preset === 'custom' && (
                <>
                  <input type="date" value={from} max={to} onChange={(e) => setRange([e.target.value, to])} style={input} aria-label="From" />
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>to</span>
                  <input type="date" value={to} min={from} onChange={(e) => setRange([from, e.target.value])} style={input} aria-label="To" />
                </>
              )}
            </>
          ) : (
            <>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>As of</span>
              <input type="date" value={asof} onChange={(e) => setAsof(e.target.value)} style={input} aria-label="As of" />
            </>
          )}
          {canCompare && (
            <select value={activeCompare} onChange={(e) => setCompare(e.target.value)} aria-label="Compare" style={{ ...input, color: activeCompare !== 'none' ? 'var(--wk-brand, #2b45e1)' : undefined, fontWeight: activeCompare !== 'none' ? 600 : undefined }}>
              {compareOptions.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            <Building2 size={14} style={{ color: 'var(--text-muted)' }} />
            <div style={{ position: 'relative' }}>
              <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--text-muted)' }} />
              <input type="text" value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)} placeholder="Find entity" style={{ ...input, paddingLeft: 24, width: 140 }} disabled={dims.locations.length > 0} />
            </div>
            <select value={effectiveEntity} onChange={(e) => setEntity(e.target.value)} style={{ ...input, maxWidth: 320 }} disabled={dims.locations.length > 0}
              title={dims.locations.length ? 'Several entities are picked in the Entities filter below.' : undefined}>
              {dims.locations.length ? <option value="">{dims.locations.length} entities (see filter)</option> : <option value="">All entities (consolidated)</option>}
              {grouped.map((e) => (
                <option key={e.code} value={e.code}>{`${e.depth ? '    ' : ''}${e.name || 'Unnamed'} (${e.code})`}</option>
              ))}
            </select>
          </div>
        </div>
        {canDims && <DimensionBar dims={dims} onChange={setDims} entities={entities} />}
      </div>

      {searching && (
        <LedgerSearch term={term.length >= 2 ? term : ''} entity={effectiveEntity} entityName={dims.locations.length ? `${dims.locations.length} entities` : entityName(effectiveEntity)}
          dims={dimsSent} drill={drill} onClearDrill={() => setDrill(null)} onClose={closeSearch} />
      )}

      {!searching && error && <div style={{ ...card, borderColor: 'var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', fontSize: '0.9rem' }}>{error}</div>}
      {!searching && loading && !data && <SkeletonBlocks count={4} />}

      {!searching && data && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div>
              <h3 style={{ fontSize: '1rem', margin: 0 }}>{def.label}</h3>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {data.org} · {dims.locations.length ? `${dims.locations.length} entities` : entityName(effectiveEntity)} · {periodLabel}{comparing ? ` · vs ${priorLabel}` : ''} · accrual{loading ? ' · refreshing' : ''}
              </div>
              {dimsText.length > 0 && <div style={{ fontSize: '0.78rem', color: 'var(--wk-brand, #2b45e1)', marginTop: 2 }}>Filtered by {dimsText.join(' · ')}</div>}
            </div>
            {data.report !== 'trial-balance' && data.report !== 'cash-position' && (
              <button type="button" className="secondary-btn" style={{ fontSize: '0.75rem', padding: '4px 10px' }} onClick={() => setShowAccounts((v) => !v)}>
                {showAccounts ? 'Hide Accounts' : 'Show Accounts'}
              </button>
            )}
          </div>

          <div className="req-table-wrapper">
            {data.report === 'cash-position' ? (
              <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <thead>
                  <tr><th>Account</th><th>Title</th><th style={{ textAlign: 'right' }}>Balance</th><th>Last Activity</th></tr>
                </thead>
                <tbody>
                  {data.accounts.map((a) => (
                    <tr key={a.gl_code}>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{a.gl_code}</td>
                      <td>{a.account_name}</td>
                      <td style={{ textAlign: 'right', color: a.balance < 0 ? 'var(--bad-fg, #dc2626)' : undefined }}><DrillAmount onClick={() => drillInto(a.gl_code, a.account_name)}>{money(a.balance)}</DrillAmount></td>
                      <td style={{ color: 'var(--text-secondary)' }}>{a.last_activity ? formatDate(a.last_activity) : '-'}</td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 800, borderTop: '2px solid var(--border-color)', fontSize: '1.02rem' }}>
                    <td colSpan={2}>Total Cash as of {formatDate(asof)}</td>
                    <td style={{ textAlign: 'right', color: data.total >= 0 ? 'var(--ok-fg, #15803d)' : 'var(--bad-fg, #dc2626)' }}>{money(data.total)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            ) : data.report === 'trial-balance' ? (
              <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <thead>
                  <tr><th>Account</th><th>Title</th><th style={{ textAlign: 'right' }}>Opening</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th><th style={{ textAlign: 'right' }}>Closing</th></tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.account_no}>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{r.account_no}</td>
                      <td>{r.title}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.opening)}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.debit)}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.credit)}</td>
                      <td style={{ textAlign: 'right' }}><DrillAmount onClick={() => drillInto(r.account_no, r.title)}>{money(r.closing)}</DrillAmount></td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 800, borderTop: '2px solid var(--border-color)' }}>
                    <td colSpan={2}>Total</td>
                    <td style={{ textAlign: 'right' }}>{money(data.totals.opening)}</td>
                    <td style={{ textAlign: 'right' }}>{money(data.totals.debit)}</td>
                    <td style={{ textAlign: 'right' }}>{money(data.totals.credit)}</td>
                    <td style={{ textAlign: 'right' }}>{money(data.totals.closing)}</td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{currentLabel}</th>
                    {cmpHeader}
                  </tr>
                </thead>
                <tbody>
                  {data.sections.map((s) => (
                    <SectionRows key={s.key} section={s} open={showAccounts} onDrill={drillInto}
                      compare={comparing ? { amounts: priorAmounts, total: priorSectionTotal(s.key) } : null} />
                  ))}
                  {data.report === 'pnl' ? (
                    <>
                      <TotalRow label="Gross Profit" value={data.totals.gross_profit} prior={comparing ? priorTotal('gross_profit') : null} style={{ fontWeight: 700, borderTop: '2px solid var(--border-color)' }} />
                      <TotalRow label="Operating Income" value={data.totals.operating_income} prior={comparing ? priorTotal('operating_income') : null} style={{ fontWeight: 700 }} />
                      <TotalRow label="Net Income" value={data.totals.net_income} prior={comparing ? priorTotal('net_income') : null} style={{ fontWeight: 800, fontSize: '1.02rem' }} tone />
                    </>
                  ) : (
                    <>
                      <TotalRow label="Total Liabilities and Equity" value={data.totals.liabilities_and_equity} prior={comparing ? priorTotal('liabilities_and_equity') : null} style={{ fontWeight: 800, borderTop: '2px solid var(--border-color)' }} />
                      {Math.abs(data.totals.difference) >= 0.01 && (
                        <tr style={{ color: 'var(--bad-fg, #dc2626)' }}><td>Out of balance by</td><td style={{ textAlign: 'right' }}>{money(data.totals.difference)}</td>{comparing && <td colSpan={3} />}</tr>
                      )}
                    </>
                  )}
                </tbody>
              </table>
            )}
          </div>
          <div style={{ marginTop: 10, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            Generated {formatDate(data.generated_at)} from the Nexus Accounting ledger. Figures refresh every 5 minutes.
          </div>
        </div>
      )}
    </div>
  );
}

// An account's amount, clickable: opens the ledger lines that add up to it.
function DrillAmount({ onClick, children }) {
  return (
    <button type="button" onClick={onClick} title="See the lines behind this amount"
      style={{ border: 'none', background: 'none', padding: 0, margin: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--border-color)', textUnderlineOffset: 3 }}>
      {children}
    </button>
  );
}

// The three comparison cells: prior figure, $ variance, % variance.
function CompareCells({ value, prior }) {
  if (prior == null) return null;
  const diff = value - prior;
  const color = diff < 0 ? 'var(--bad-fg, #dc2626)' : diff > 0 ? 'var(--ok-fg, #15803d)' : undefined;
  return (
    <>
      <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{money(prior)}</td>
      <td style={{ textAlign: 'right', color }}>{Math.abs(diff) < 0.005 ? '-' : money(diff)}</td>
      <td style={{ textAlign: 'right', color }}>{pct(value, prior) || '-'}</td>
    </>
  );
}

function TotalRow({ label, value, prior, style, tone }) {
  return (
    <tr style={style}>
      <td>{label}</td>
      <td style={{ textAlign: 'right', color: tone ? (value >= 0 ? 'var(--ok-fg, #15803d)' : 'var(--bad-fg, #dc2626)') : undefined }}>{money(value)}</td>
      <CompareCells value={value} prior={prior} />
    </tr>
  );
}

function SectionRows({ section, open, onDrill, compare }) {
  if (!section.accounts.length && !section.total) return null;
  return (
    <>
      <tr style={{ fontWeight: 700, background: 'var(--bg-secondary)' }}>
        <td>{section.label}</td>
        <td style={{ textAlign: 'right' }}>{money(section.total)}</td>
        {compare && <CompareCells value={section.total} prior={compare.total} />}
      </tr>
      {open && section.accounts.map((a, i) => (
        <tr key={`${a.account_no}-${i}`}>
          <td style={{ paddingLeft: 24, color: 'var(--text-secondary)' }}>
            {a.account_no && <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', marginRight: 8 }}>{a.account_no}</span>}{a.title}
          </td>
          <td style={{ textAlign: 'right' }}>
            {a.account_no && onDrill ? <DrillAmount onClick={() => onDrill(a.account_no, a.title)}>{money(a.amount)}</DrillAmount> : money(a.amount)}
          </td>
          {compare && <CompareCells value={a.amount} prior={compare.amounts.get(a.account_no || a.title) ?? 0} />}
        </tr>
      ))}
    </>
  );
}

// The dimension filter row: one chip per active dimension (click to edit,
// x to clear) and "Add Filter" to pick another. Values load when a picker
// opens - vendors alone are hundreds of codes.
function DimensionBar({ dims, onChange, entities }) {
  const [open, setOpen] = useState(null);      // the DIM_KINDS entry being edited
  const [menu, setMenu] = useState(false);
  const active = DIM_KINDS.filter((k) => dims[k.key].length);
  const inactive = DIM_KINDS.filter((k) => !dims[k.key].length);
  const chip = (on) => ({
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, fontSize: '0.78rem', cursor: 'pointer', fontFamily: 'inherit',
    border: `1px solid ${on ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, background: on ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)', color: on ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)',
  });
  const set = (key, codes) => onChange({ ...dims, [key]: codes });
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, position: 'relative' }}>
      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginRight: 2 }}>Filters</span>
      {active.map((k) => (
        <span key={k.key} style={chip(true)}>
          <button type="button" onClick={() => setOpen(k)} style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' }}>
            {k.label}: {dims[k.key].length === 1 ? dims[k.key][0] : `${dims[k.key].length} selected`}
          </button>
          <button type="button" onClick={() => set(k.key, [])} aria-label={`Clear ${k.label} filter`} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'inherit', display: 'inline-flex' }}><X size={12} /></button>
        </span>
      ))}
      {inactive.length > 0 && (
        <span style={{ position: 'relative' }}>
          <button type="button" style={chip(false)} onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu}>
            <Plus size={12} /> Add Filter <ChevronDown size={12} />
          </button>
          {menu && (
            <div role="menu" style={{ position: 'absolute', top: '110%', left: 0, zIndex: 20, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))', padding: 6, minWidth: 170 }}>
              {inactive.map((k) => (
                <button key={k.key} type="button" role="menuitem" onClick={() => { setMenu(false); setOpen(k); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none', padding: '7px 10px', borderRadius: 6, font: 'inherit', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
                  {k.label}
                </button>
              ))}
            </div>
          )}
        </span>
      )}
      {active.length > 1 && (
        <button type="button" onClick={() => onChange(EMPTY_DIMS)} style={{ border: 'none', background: 'none', font: 'inherit', fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer', textDecoration: 'underline' }}>Clear all</button>
      )}
      {open && <DimPicker def={open} value={dims[open.key]} entities={entities} onChange={(codes) => set(open.key, codes)} onClose={() => setOpen(null)} />}
    </div>
  );
}

// A searchable multi-select for one dimension. Entities come from the
// locations list already loaded; other kinds are fetched on first open.
function DimPicker({ def, value, entities, onChange, onClose }) {
  const [values, setValues] = useState(def.kind === 'location' ? entities.map((e) => ({ code: e.code, name: e.name || '', parent_code: e.parent_code })) : null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const box = useRef(null);
  useEffect(() => {
    if (def.kind === 'location') return undefined;
    let alive = true;
    api.getAccountingDimensionValues(def.kind)
      .then((d) => { if (alive) setValues(d?.values || []); })
      .catch((e) => { if (alive) { setValues([]); setError(e?.message || 'Could not load the list.'); } });
    return () => { alive = false; };
  }, [def.kind]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [onClose]);
  const chosen = new Set(value);
  const toggle = (code) => {
    const next = new Set(chosen);
    if (next.has(code)) next.delete(code); else next.add(code);
    onChange([...next]);
  };
  const shown = useMemo(() => {
    const list = values || [];
    const s = q.trim().toLowerCase();
    const filtered = s ? list.filter((v) => v.code.toLowerCase().includes(s) || (v.name || '').toLowerCase().includes(s)) : list;
    // Chosen first, then by name.
    return [...filtered].sort((a, b) => (chosen.has(b.code) - chosen.has(a.code)) || (a.name || a.code).localeCompare(b.name || b.code, 'en-US', { numeric: true })).slice(0, 400);
  }, [values, q, value]); // eslint-disable-line react-hooks/exhaustive-deps
  const input = { padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: '0.8rem', fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' };
  return (
    <div ref={box} role="dialog" aria-label={`${def.label} filter`} style={{ position: 'absolute', top: '110%', left: 0, zIndex: 30, width: 340, maxWidth: '92vw', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))', padding: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong style={{ fontSize: '0.82rem' }}>{def.label}{value.length ? ` · ${value.length} selected` : ''}</strong>
        <div style={{ display: 'flex', gap: 8 }}>
          {value.length > 0 && <button type="button" onClick={() => onChange([])} style={{ border: 'none', background: 'none', font: 'inherit', fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer', textDecoration: 'underline' }}>Clear</button>}
          <button type="button" className="primary-btn" onClick={onClose} style={{ fontSize: '0.75rem', padding: '3px 10px' }}>Done</button>
        </div>
      </div>
      <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${def.label.toLowerCase()} by name or code`} style={input} autoFocus />
      <div style={{ maxHeight: 260, overflowY: 'auto', marginTop: 8, display: 'grid', gap: 2 }}>
        {error && <div style={{ fontSize: '0.78rem', color: 'var(--bad-fg, #dc2626)', padding: 6 }}>{error}</div>}
        {!values && !error && <SkeletonBlocks count={3} />}
        {values && !shown.length && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: 6 }}>{values.length ? 'No match.' : `No ${def.label.toLowerCase()} on the ledger yet.`}</div>}
        {shown.map((v) => {
          const on = chosen.has(v.code);
          return (
            <button key={v.code} type="button" onClick={() => toggle(v.code)} aria-pressed={on}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', border: 'none', background: on ? 'var(--wk-brand-tint, #e8ecfd)' : 'none', padding: '6px 8px', borderRadius: 6, font: 'inherit', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
              <span style={{ width: 14, display: 'inline-flex', color: 'var(--wk-brand, #2b45e1)' }}>{on ? <Check size={14} /> : null}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: v.parent_code && def.kind === 'location' ? 12 : 0 }}>{v.name || v.code}</span>
              <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: 'var(--text-muted)' }}>{v.name ? v.code : (v.lines ? `${v.lines.toLocaleString('en-US')} lines` : '')}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
