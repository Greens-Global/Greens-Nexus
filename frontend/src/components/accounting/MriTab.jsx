import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../../api';
import Amount from './Amount';
import { SkeletonBlocks } from '../AsyncState';
import LeasingTab from './LeasingTab';

// Accounting -> MRI, Monthly Recurring Income (Neil, call of 09/29: "Leasing
// is a placeholder - it should be MRI, covering leases and the interest and
// loan payments coming in"; Visesh, 09/30: MRI is the tab, Leasing a section
// inside it). MRE, the expense side, is a separate, later screen.
//
//   Leasing                     the rent roll, who is behind, the tenants
//                               (LeasingTab, unchanged).
//   Interest and Loan Payments  what posted to the interest and loan income
//                               accounts month by month this year, straight
//                               from the ledger - one row per account, a
//                               column per month, totals below.

const SECTIONS = [{ key: 'leasing', label: 'Leasing' }, { key: 'interest', label: 'Interest and Loan Payments' }];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const money = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) < 0.005) return '-';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
};
const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const icon = { border: 'none', background: 'none', padding: 5, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' };
/** The income accounts MRI reads: interest and loan income, never the lease rent (that is Leasing's). */
export const isRecurringIncomeAccount = (r) => ['revenue', 'other_income'].includes(r.section) && /interest|loan|note receivable|mortgage income/i.test(r.title || '');

export default function MriTab({ canEdit = false, canDelete = false }) {
  const [section, setSection] = useState('leasing');
  const strip = { display: 'inline-flex', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' };
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div role="tablist" aria-label="MRI sections" style={strip}>
        {SECTIONS.map((s) => (
          <button key={s.key} type="button" role="tab" aria-selected={section === s.key} onClick={() => setSection(s.key)}
            style={{ border: 'none', borderRight: '1px solid var(--border-color)', background: section === s.key ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)', color: section === s.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', font: 'inherit', fontSize: '0.78rem', fontWeight: 600, padding: '6px 14px', cursor: 'pointer' }}>
            {s.label}
          </button>
        ))}
      </div>
      {section === 'leasing' && <LeasingTab canEdit={canEdit} canDelete={canDelete} />}
      {section === 'interest' && <InterestIncome />}
    </div>
  );
}

// Interest and loan payments received, by account and month, from the ledger.
export function InterestIncome() {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    api.getAccountingBuckets({ from: `${year}-01-01`, to: `${year}-12-31`, by: 'month', book: 'accrual' })
      .then((d) => { if (mine === seq.current) setData(d); })
      .catch((e) => { if (mine === seq.current) { setData({ rows: [] }); setError(e?.message || 'Could not read the ledger.'); } })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [year]);
  const rows = useMemo(() => {
    const by = new Map();
    (data?.rows || []).filter(isRecurringIncomeAccount).forEach((r) => {
      const cur = by.get(r.account_no) || { code: r.account_no, title: r.title, months: new Array(12).fill(0), total: 0 };
      const m = Number((r.bucket || '').slice(5, 7)) - 1;
      const v = Math.round(((r.credit || 0) - (r.debit || 0)) * 100) / 100;
      if (m >= 0 && m < 12) cur.months[m] = Math.round((cur.months[m] + v) * 100) / 100;
      cur.total = Math.round((cur.total + v) * 100) / 100;
      by.set(r.account_no, cur);
    });
    return [...by.values()].sort((a, b) => a.code.localeCompare(b.code, 'en-US', { numeric: true }));
  }, [data]);
  const totals = MONTHS.map((_m, i) => rows.reduce((s, r) => s + r.months[i], 0));
  const grand = rows.reduce((s, r) => s + r.total, 0);
  return (
    <div style={{ ...card, padding: 10, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <button type="button" style={icon} aria-label="Previous year" onClick={() => setYear((y) => y - 1)}><ChevronLeft size={16} /></button>
          <strong style={{ fontSize: '0.86rem', minWidth: 40, textAlign: 'center' }}>{year}</strong>
          <button type="button" style={icon} aria-label="Next year" disabled={year >= new Date().getFullYear() + 1} onClick={() => setYear((y) => y + 1)}><ChevronRight size={16} /></button>
        </div>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Interest and loan payments received, as posted to the income accounts, accrual book.</span>
        <span style={{ marginLeft: 'auto', fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums' }}>Received this year <strong><Amount value={grand} /></strong></span>
      </div>
      {error && <div style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' }}>{error}</div>}
      {loading && !data ? <SkeletonBlocks count={3} /> : !rows.length ? (
        <p style={{ margin: 0, padding: '18px 6px', fontSize: '0.86rem', color: 'var(--text-secondary)' }}>Nothing posted to an interest or loan income account in {year}.</p>
      ) : (
        <div className="acct-report-wrap" style={{ opacity: loading ? 0.6 : 1 }}>
          <table className="acct-report">
            <thead>
              <tr>
                <th className="acct-label acct-head">Account</th>
                {MONTHS.map((m) => <th key={m} className="acct-num">{m}</th>)}
                <th className="acct-num" style={{ fontWeight: 800 }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code}>
                  <td className="acct-label" title={`${r.code} ${r.title}`}><span className="acct-code">{r.code}</span>{r.title}</td>
                  {r.months.map((v, i) => <td key={i} className="acct-num">{money(v)}</td>)}
                  <td className="acct-num" style={{ fontWeight: 700 }}><Amount value={r.total} /></td>
                </tr>
              ))}
              <tr className="acct-grand">
                <td className="acct-label">Total Received</td>
                {totals.map((v, i) => <td key={i} className="acct-num">{money(v)}</td>)}
                <td className="acct-num"><Amount value={grand} /></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
