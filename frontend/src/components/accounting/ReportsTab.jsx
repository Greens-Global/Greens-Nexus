import { useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, Building2, Search } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';

// Accounting -> Reports. Pull any statement for any entity straight from the
// ledger without opening Nexus Accounting: Profit & Loss, Balance Sheet,
// Trial Balance, filtered by Intacct location (entity) and period. Read-only,
// served by the accounting app's internal API through the backend proxy (the
// Accounting grant is the gate). Export writes a CSV of the table shown.

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

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const money = (n) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
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
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showAccounts, setShowAccounts] = useState(true);

  const def = REPORTS.find((r) => r.key === report);

  useEffect(() => {
    api.getAccountingLocations().then((d) => setEntities(d?.entities || [])).catch(() => setEntities([]));
  }, []);

  useEffect(() => {
    if (preset !== 'custom') setRange(presetRange(preset).map(iso));
  }, [preset]);

  const run = () => {
    setLoading(true);
    setError('');
    const call = report === 'pnl'
      ? api.getAccountingPnl(from, to, entity || undefined)
      : report === 'balance-sheet'
        ? api.getAccountingBalanceSheet(asof, entity || undefined)
        : report === 'cash-position'
          ? api.getAccountingCashPosition(asof, entity || undefined)
          : api.getAccountingTrialBalance(from, to, entity || undefined);
    call.then((d) => setData({ report, ...d }))
      .catch((e) => { setData(null); setError(e?.message || 'Could not load the report.'); })
      .finally(() => setLoading(false));
  };

  // Run on every control change so the tab always shows what the filters say.
  useEffect(() => { run(); }, [report, from, to, asof, entity]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const periodLabel = def.period === 'asof' ? `As of ${formatDate(asof)}` : `${formatDate(from)} - ${formatDate(to)}`;

  const exportCsv = () => {
    if (!data) return;
    const rows = [];
    const stamp = def.period === 'asof' ? asof : `${from}_${to}`;
    if (data.report === 'pnl') {
      rows.push(['Section', 'Account', 'Title', 'Amount']);
      data.sections.forEach((s) => { s.accounts.forEach((a) => rows.push([s.label, a.account_no, a.title, a.amount])); rows.push([`Total ${s.label}`, '', '', s.total]); });
      rows.push(['Gross Profit', '', '', data.totals.gross_profit], ['Operating Income', '', '', data.totals.operating_income], ['Net Income', '', '', data.totals.net_income]);
    } else if (data.report === 'balance-sheet') {
      rows.push(['Section', 'Account', 'Title', 'Balance']);
      data.sections.forEach((s) => { s.accounts.forEach((a) => rows.push([s.label, a.account_no, a.title, a.amount])); rows.push([`Total ${s.label}`, '', '', s.total]); });
      rows.push(['Total Liabilities and Equity', '', '', data.totals.liabilities_and_equity]);
    } else if (data.report === 'cash-position') {
      rows.push(['Account', 'Title', 'Balance', 'Last Activity']);
      data.accounts.forEach((a) => rows.push([a.gl_code, a.account_name, a.balance, a.last_activity ? formatDate(a.last_activity) : '']));
      rows.push(['Total Cash', '', data.total, '']);
    } else {
      rows.push(['Account', 'Title', 'Type', 'Opening', 'Debit', 'Credit', 'Closing']);
      data.rows.forEach((r) => rows.push([r.account_no, r.title, r.type, r.opening, r.debit, r.credit, r.closing]));
      rows.push(['Total', '', '', data.totals.opening, data.totals.debit, data.totals.credit, data.totals.closing]);
    }
    downloadCsv(`${def.label.replace(/[^A-Za-z]+/g, '-')}_${entity || 'all-entities'}_${stamp}.csv`, rows);
  };

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      {/* Controls */}
      <div style={{ ...card, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <div className="scroll-tabs" style={{ display: 'flex', gap: 6 }}>
            {REPORTS.map((r) => (
              <button key={r.key} type="button" style={pill(report === r.key)} onClick={() => setReport(r.key)}>{r.label}</button>
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
              <div className="scroll-tabs" style={{ display: 'flex', gap: 6 }}>
                {PRESETS.map((p) => (
                  <button key={p.key} type="button" style={pill(preset === p.key)} onClick={() => setPreset(p.key)}>{p.label}</button>
                ))}
              </div>
              <input type="date" value={from} max={to} disabled={preset !== 'custom'} onChange={(e) => setRange([e.target.value, to])} style={input} />
              <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>to</span>
              <input type="date" value={to} min={from} disabled={preset !== 'custom'} onChange={(e) => setRange([from, e.target.value])} style={input} />
            </>
          ) : (
            <>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>As of</span>
              <input type="date" value={asof} onChange={(e) => setAsof(e.target.value)} style={input} />
            </>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            <Building2 size={14} style={{ color: 'var(--text-muted)' }} />
            <div style={{ position: 'relative' }}>
              <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--text-muted)' }} />
              <input type="text" value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)} placeholder="Find entity" style={{ ...input, paddingLeft: 24, width: 140 }} />
            </div>
            <select value={entity} onChange={(e) => setEntity(e.target.value)} style={{ ...input, maxWidth: 320 }}>
              <option value="">All entities (consolidated)</option>
              {grouped.map((e) => (
                <option key={e.code} value={e.code}>{`${e.depth ? '    ' : ''}${e.name || 'Unnamed'} (${e.code})`}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {error && <div style={{ ...card, borderColor: 'var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', fontSize: '0.9rem' }}>{error}</div>}
      {loading && !data && <SkeletonBlocks count={4} />}

      {data && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div>
              <h3 style={{ fontSize: '1rem', margin: 0 }}>{def.label}</h3>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {data.org} · {entityName(entity)} · {periodLabel} · accrual{loading ? ' · refreshing' : ''}
              </div>
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
                      <td style={{ textAlign: 'right', color: a.balance < 0 ? 'var(--bad-fg, #dc2626)' : undefined }}>{money(a.balance)}</td>
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
                      <td style={{ textAlign: 'right' }}>{money(r.closing)}</td>
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
                <tbody>
                  {data.sections.map((s) => (
                    <SectionRows key={s.key} section={s} open={showAccounts} />
                  ))}
                  {data.report === 'pnl' ? (
                    <>
                      <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border-color)' }}><td>Gross Profit</td><td style={{ textAlign: 'right' }}>{money(data.totals.gross_profit)}</td></tr>
                      <tr style={{ fontWeight: 700 }}><td>Operating Income</td><td style={{ textAlign: 'right' }}>{money(data.totals.operating_income)}</td></tr>
                      <tr style={{ fontWeight: 800, fontSize: '1.02rem' }}>
                        <td>Net Income</td>
                        <td style={{ textAlign: 'right', color: data.totals.net_income >= 0 ? 'var(--ok-fg, #15803d)' : 'var(--bad-fg, #dc2626)' }}>{money(data.totals.net_income)}</td>
                      </tr>
                    </>
                  ) : (
                    <>
                      <tr style={{ fontWeight: 800, borderTop: '2px solid var(--border-color)' }}><td>Total Liabilities and Equity</td><td style={{ textAlign: 'right' }}>{money(data.totals.liabilities_and_equity)}</td></tr>
                      {Math.abs(data.totals.difference) >= 0.01 && (
                        <tr style={{ color: 'var(--bad-fg, #dc2626)' }}><td>Out of balance by</td><td style={{ textAlign: 'right' }}>{money(data.totals.difference)}</td></tr>
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

function SectionRows({ section, open }) {
  if (!section.accounts.length && !section.total) return null;
  return (
    <>
      <tr style={{ fontWeight: 700, background: 'var(--bg-secondary)' }}>
        <td>{section.label}</td>
        <td style={{ textAlign: 'right' }}>{money(section.total)}</td>
      </tr>
      {open && section.accounts.map((a, i) => (
        <tr key={`${a.account_no}-${i}`}>
          <td style={{ paddingLeft: 24, color: 'var(--text-secondary)' }}>
            {a.account_no && <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', marginRight: 8 }}>{a.account_no}</span>}{a.title}
          </td>
          <td style={{ textAlign: 'right' }}>{money(a.amount)}</td>
        </tr>
      ))}
    </>
  );
}
