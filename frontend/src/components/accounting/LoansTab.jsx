import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FileSpreadsheet, Pencil, RefreshCw, X } from 'lucide-react';
import { api } from '../../api';
import Amount, { AmountInput, Figure, formatAmount } from './Amount';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import { control } from './reportControls';
import { downloadBlob, downloadCsv } from './reportModel';
import { POLL_MS, ScanProgress, entitiesScannedText, useLedgerScan } from './LedgerScan';

// Accounting -> Loans & Financing (Neil and Charmi, 10/02: "Nothing has been
// done on Loans & Financing for me to review"). The loans table was empty on
// production, so the Data > Loans grid and every loan widget opened blank.
//
//   Set Up From the Ledger   the balance sheet of every entity you may read,
//                            as of the month shown; one proposed loan per
//                            liability account whose title says loan,
//                            mortgage, note payable, line of credit,
//                            financing, or names a lender. Tick + Create
//                            writes the same fin_loans rows Data > Loans
//                            keeps, balance read from the ledger. Re-running
//                            proposes only what is missing.
//   Review                   per loan, ledger-driven for the month: balance
//                            now, a month ago, a year ago; principal paid
//                            (the decrease), interest paid (the entity's
//                            Interest expense accounts), debt service; the
//                            property's trailing-12 NOI; DSCR against the
//                            covenant minimum (1.35 unless typed), red when
//                            under it. Rate, maturity and monthly P&I show
//                            when typed - here or in Data > Loans, one row.
//   Totals                   by lender and by entity; a strip of the loans
//                            maturing in the next 24 months.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const icon = { border: 'none', background: 'none', padding: 5, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const KIND = { external: 'External', intercompany: 'Intercompany', given: 'Loan Given' };
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const shiftMonth = (m, by) => { const i = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + by; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`; };
const monthLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const dscrText = (v) => (v == null ? '-' : `${v.toFixed(2)}x`);
const rateText = (r) => (r.ratePct == null ? '' : `${Number(r.ratePct).toFixed(2)}%${r.rateType ? ` ${r.rateType === 'variable' ? 'variable' : 'fixed'}` : ''}`);
/** Not configured on this environment: the accounting service is not connected (503 from the API). */
export const notAvailable = (e) => e?.status === 503 || /not configured|not available/i.test(e?.message || '');

function Chip({ tone = 'muted', children, title }) {
  const tones = {
    ok: { fg: 'var(--ok-fg, #15803d)', bg: 'rgba(21,128,61,0.10)' }, bad: { fg: 'var(--bad-fg, #dc2626)', bg: 'rgba(220,38,38,0.10)' },
    wait: { fg: '#92400e', bg: 'rgba(180,83,9,0.13)' }, brand: { fg: 'var(--wk-brand, #2b45e1)', bg: 'var(--wk-brand-tint, #e8ecfd)' },
    muted: { fg: 'var(--text-secondary)', bg: 'var(--bg-secondary)' },
  }[tone];
  return <span title={title} style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, color: tones.fg, background: tones.bg, whiteSpace: 'nowrap' }}>{children}</span>;
}

export default function LoansTab({ canEdit = false }) {
  const [month, setMonth] = useState(thisMonth);
  const [review, setReview] = useState(null);
  const [error, setError] = useState(null);     // Error | null
  const [loading, setLoading] = useState(false);
  const [setup, setSetup] = useState(false);
  const [editing, setEditing] = useState(null);
  const seq = useRef(0);

  const load = useCallback((m) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    return api.getLoanReview(m)
      .then((d) => { if (mine === seq.current) setReview(d); })
      .catch((e) => { if (mine === seq.current) { setReview((r) => r || { loans: [], byLender: [], byEntity: [], maturities: [], summary: {} }); setError(e); } })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, []);
  useEffect(() => { load(month); }, [month, load]);

  const loans = review?.loans || [];
  const sum = review?.summary || {};
  const unavailable = error && notAvailable(error);

  const exportCsv = () => {
    const head = ['Lender', 'Loan #', 'Kind', 'Entity', 'GL Account', 'Balance', 'Month Ago', 'Year Ago', 'Principal Paid', 'Interest Paid', 'Debt Service', 'NOI (T12)', 'Debt Service (T12)', 'DSCR', 'Covenant Min', 'Rate', 'Maturity', 'Monthly P&I'];
    const rows = loans.map((r) => [r.lender, r.loanNo, KIND[r.kind] || r.kind, r.entityName, r.glAccount, r.balance, r.balanceMonthAgo ?? '', r.balanceYearAgo ?? '', r.principalPaid ?? '', r.interestPaid, r.debtService, r.noiT12, r.debtServiceT12, r.dscr ?? '', r.covenantMin, rateText(r), r.maturity ? formatDate(r.maturity) : '', r.monthlyPi ?? '']);
    rows.push(['Total', '', '', '', '', sum.balance || 0, '', '', '', '', '', '', sum.debtServiceT12 || 0, '', '', '', '', '']);
    downloadCsv(`Loans-and-Financing_${month}.csv`, [head, ...rows]);
  };
  const exportExcel = async () => {
    const { buildStatementWorkbook } = await import('./reportExcel');
    const columns = [
      { key: 'entity', label: 'Entity', type: 'text' }, { key: 'kind', label: 'Kind', type: 'text' }, { key: 'gl', label: 'GL Account', type: 'text' },
      { key: 'balance', label: 'Balance', type: 'amount' }, { key: 'm1', label: 'Month Ago', type: 'amount' }, { key: 'm12', label: 'Year Ago', type: 'amount' },
      { key: 'principal', label: 'Principal Paid', type: 'amount' }, { key: 'interest', label: 'Interest Paid', type: 'amount' }, { key: 'ds', label: 'Debt Service', type: 'amount' },
      { key: 'noi', label: 'NOI (T12)', type: 'amount' }, { key: 'ds12', label: 'Debt Service (T12)', type: 'amount' },
      { key: 'dscr', label: 'DSCR', type: 'text' }, { key: 'cov', label: 'Covenant Min', type: 'text' }, { key: 'rate', label: 'Rate', type: 'text' }, { key: 'maturity', label: 'Maturity', type: 'date' }, { key: 'pi', label: 'Monthly P&I', type: 'amount' },
    ];
    const rows = [{ kind: 'section', label: 'Loans', section: 'loans', values: [] }, ...loans.map((r) => ({
      kind: 'account', code: r.loanNo || r.glAccount, title: r.lender || '(no lender)', section: 'loans',
      values: [r.entityName, KIND[r.kind] || r.kind, r.glAccount, r.balance, r.balanceMonthAgo || 0, r.balanceYearAgo || 0, r.principalPaid || 0, r.interestPaid, r.debtService, r.noiT12, r.debtServiceT12, dscrText(r.dscr), `${r.covenantMin.toFixed(2)}x`, rateText(r), r.maturity ? formatDate(r.maturity) : '', r.monthlyPi || 0],
    }))];
    const result = { config: { report: 'balance-sheet', asof: review.asOf, entities: [], book: 'accrual', preset: 'custom' }, def: { key: 'loans', label: 'Loans & Financing' }, org: '', columns, rows };
    const bytes = await buildStatementWorkbook({ title: `Loans & Financing - ${monthLabel(month)}`, result });
    downloadBlob(`Loans-and-Financing_${month}.xlsx`, new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  };

  return (
    <AsyncSection loading={review === null} skeleton={<SkeletonBlocks count={3} />}>
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <button type="button" style={icon} aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))}><ChevronLeft size={16} /></button>
            <strong style={{ fontSize: '0.86rem', minWidth: 72, textAlign: 'center' }}>{monthLabel(month)}</strong>
            <button type="button" style={icon} aria-label="Next month" disabled={month >= thisMonth()} onClick={() => setMonth((m) => shiftMonth(m, 1))}><ChevronRight size={16} /></button>
          </div>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Balances as of {review?.asOf ? formatDate(review.asOf) : 'the month end'}; trailing twelve months from {review?.trailingFrom ? formatDate(review.trailingFrom) : ''}.</span>
          {(review?.notes || []).length > 0 && <div style={{ fontSize: '0.78rem', color: '#92400e', background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.3)', borderRadius: 8, padding: '6px 10px' }}>{review.notes.join(' · ')} - open again to retry.</div>}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums' }}>
            <span>Loans <strong>{sum.loans || 0}</strong></span>
            <span>Balance <strong><Amount value={sum.balance} /></strong></span>
            <span>Debt Service (T12) <strong><Amount value={sum.debtServiceT12} /></strong></span>
            <span>Below Covenant <strong style={{ color: sum.belowCovenant ? 'var(--bad-fg, #dc2626)' : undefined }}>{sum.belowCovenant || 0}</strong></span>
            <button type="button" className="secondary-btn" onClick={exportCsv} disabled={!loans.length} style={{ fontSize: '0.76rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={13} /> Export CSV</button>
            <button type="button" className="secondary-btn" onClick={exportExcel} disabled={!loans.length} style={{ fontSize: '0.76rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><FileSpreadsheet size={13} /> Export Excel</button>
            {canEdit && !unavailable && (
              <button type="button" className="primary-btn" onClick={() => setSetup(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' }}>
                <RefreshCw size={14} /> Set Up From the Ledger
              </button>
            )}
          </div>
        </div>

        {error && (unavailable ? (
          <div style={{ ...card, padding: 18, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Loans & Financing is not available here.</strong> The accounting service is not connected on this environment, so there is no ledger to read loans from.
          </div>
        ) : <div style={bad}>{error.message || 'Could not read the loans.'}</div>)}

        {!unavailable && !loans.length && !loading && (
          <div style={{ ...card, padding: 18, fontSize: '0.86rem', color: 'var(--text-secondary)', display: 'grid', gap: 6, maxWidth: 760 }}>
            <strong style={{ color: 'var(--text-primary)' }}>No loans set up for the entities you may read.</strong>
            <span>Set Up From the Ledger reads each entity's balance sheet as of {monthLabel(month)} and proposes a loan for every liability account whose title says {(review?.lookedFor || []).join(', ')}. Accounts payable, credit cards, payroll, accrued, deferred and deposit balances are left out unless the title says loan.</span>
            <span>{canEdit ? 'Or add one by hand under Accounting > Data > Loans (loan number, lender, entity, GL account).' : 'An editor on Accounting can set them up here or under Accounting > Data > Loans.'}</span>
          </div>
        )}

        {loans.length > 0 && (
          <div style={{ ...card, padding: 0, overflow: 'hidden', opacity: loading ? 0.6 : 1 }}>
            <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
              <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <thead>
                  <tr>
                    <th>Lender / Loan</th><th>Entity</th><th style={num}>Balance</th><th style={num}>Month Ago</th><th style={num}>Year Ago</th>
                    <th style={num}>Principal Paid</th><th style={num}>Interest Paid</th><th style={num}>Debt Service</th><th style={num}>NOI (T12)</th><th style={num}>Debt Service (T12)</th>
                    <th style={num}>DSCR</th><th>Rate</th><th>Maturity</th><th style={num}>Monthly P&I</th>{canEdit && <th style={{ width: 36 }} />}
                  </tr>
                </thead>
                <tbody>
                  {loans.map((r) => (
                    <tr key={r.id} style={r.belowCovenant ? { background: 'rgba(220,38,38,0.05)' } : undefined}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.lender || '(no lender)'} {r.kind !== 'external' && <Chip tone="muted">{KIND[r.kind] || r.kind}</Chip>}</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>#{r.loanNo || '-'} · GL {r.glAccount || '-'} · {r.balanceSource === 'ledger' ? 'Ledger' : 'Kept by hand'}{r.sharedWith ? ` · interest shared with ${r.sharedWith} more on this entity` : ''}</div>
                      </td>
                      <td>{r.entityName}</td>
                      <td style={num}><Amount value={r.balance} />{r.debitBalance && <> <Chip tone="wait" title="This liability account carries a debit balance on the ledger: shown as negative owed, not flipped">Debit Balance</Chip></>}</td>
                      <td style={num}>{r.balanceMonthAgo == null ? <span style={{ color: 'var(--text-muted)' }}>-</span> : <Amount value={r.balanceMonthAgo} />}</td>
                      <td style={num}>{r.balanceYearAgo == null ? <span style={{ color: 'var(--text-muted)' }}>-</span> : <Amount value={r.balanceYearAgo} />}</td>
                      <td style={num} title="Owed a month ago less owed now; a negative is a draw and counts as no payment in the debt service">{r.principalPaid == null ? <span style={{ color: 'var(--text-muted)' }}>-</span> : <Amount value={r.principalPaid} zero="dash" />}</td>
                      <td style={num} title="The entity's Interest expense accounts for the month"><Amount value={r.interestPaid} zero="dash" /></td>
                      <td style={num}><Amount value={r.debtService} zero="dash" /></td>
                      <td style={num} title={`Income ${formatAmount(r.incomeT12)} less operating expenses ${formatAmount(r.operatingExpensesT12)} (interest, depreciation and amortization left out)`}><Amount value={r.noiT12} zero="dash" /></td>
                      <td style={num}><Amount value={r.debtServiceT12} zero="dash" /></td>
                      <td style={num}>
                        {r.dscr == null ? <Chip tone="muted" title="Nothing was serviced in the trailing twelve months">No Service</Chip>
                          : <Chip tone={r.belowCovenant ? 'bad' : 'ok'} title={`NOI ${formatAmount(r.noiT12)} over the entity's debt service ${formatAmount(r.entityDebtServiceT12)}; minimum ${r.covenantMin.toFixed(2)}x${r.covenantTyped ? '' : ' (default)'}`}>{dscrText(r.dscr)} / {r.covenantMin.toFixed(2)}x</Chip>}
                      </td>
                      <td>{rateText(r) || <span style={{ color: 'var(--text-muted)' }}>-</span>}</td>
                      <td>{r.maturity ? formatDate(r.maturity) : <span style={{ color: 'var(--text-muted)' }}>-</span>}</td>
                      <td style={num}>{r.monthlyPi == null ? <span style={{ color: 'var(--text-muted)' }}>-</span> : <Amount value={r.monthlyPi} />}</td>
                      {canEdit && <td><button type="button" className="icon-btn" aria-label={`Edit ${r.lender || r.loanNo}`} onClick={() => setEditing(r)} style={{ padding: 4, color: 'var(--text-muted)' }}><Pencil size={13} /></button></td>}
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 700 }}>
                    <td>Total</td><td /><td style={num}><Amount value={sum.balance} /></td><td /><td />
                    <td style={num}><Amount value={loans.reduce((s, r) => s + (r.principalPaid || 0), 0)} zero="dash" /></td>
                    <td style={num}><Amount value={loans.reduce((s, r) => s + r.interestPaid, 0)} zero="dash" /></td>
                    <td style={num}><Amount value={loans.reduce((s, r) => s + r.debtService, 0)} zero="dash" /></td>
                    <td /><td style={num}><Amount value={sum.debtServiceT12} zero="dash" /></td><td colSpan={canEdit ? 5 : 4} />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {loans.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 10 }}>
            <Totals title="By Lender" rows={review.byLender} />
            <Totals title="By Entity" rows={review.byEntity} />
          </div>
        )}

        {loans.length > 0 && <Maturities month={month} rows={review.maturities || []} />}
      </div>
      {setup && <SetupDialog month={month} onClose={() => setSetup(false)} onCreated={() => { setSetup(false); load(month); }} />}
      {editing && <EditDialog loan={editing} month={month} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(month); }} />}
    </AsyncSection>
  );
}

function Totals({ title, rows }) {
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', fontSize: '0.8rem', fontWeight: 700, borderBottom: '1px solid var(--border-color)' }}>{title}</div>
      <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
        <thead><tr><th>{title === 'By Lender' ? 'Lender' : 'Entity'}</th><th style={num}>Loans</th><th style={num}>Balance</th><th style={num}>Debt Service (T12)</th><th style={num}>NOI (T12)</th><th style={num}>DSCR</th></tr></thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.label}>
              <td>{g.label || '(no lender)'}</td><td style={num}>{g.loans}</td><td style={num}><Amount value={g.balance} /></td><td style={num}><Amount value={g.debtServiceT12} zero="dash" /></td>
              <td style={num}><Amount value={g.noiT12} zero="dash" /></td><td style={num}><Figure text={dscrText(g.dscr)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Maturities({ month, rows }) {
  const strip = Array.from({ length: 24 }, (_x, i) => shiftMonth(month, i));
  const by = new Map(rows.map((r) => [r.month, r]));
  return (
    <div style={{ ...card, padding: '8px 12px', display: 'grid', gap: 6 }}>
      <div style={{ fontSize: '0.8rem', fontWeight: 700 }}>Maturities - Next 24 Months</div>
      {!rows.length ? <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>No loan matures in the next 24 months{rows.length === 0 ? ' (maturity dates are typed here or in Data > Loans)' : ''}.</div> : (
        <div className="scroll-tabs" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
          {strip.map((m) => {
            const cell = by.get(m);
            return (
              <div key={m} title={cell ? cell.loans.map((l) => `${l.lender} #${l.loanNo} (${l.entityName}) ${formatAmount(l.balance)}`).join('\n') : ''}
                style={{ minWidth: 86, flex: '0 0 auto', border: `1px solid ${cell ? '#b45309' : 'var(--border-color)'}`, borderRadius: 8, padding: '4px 8px', background: cell ? 'rgba(180,83,9,0.10)' : 'var(--bg-secondary)', fontSize: '0.7rem' }}>
                <div style={{ fontWeight: 700 }}>{monthLabel(m)}</div>
                <div style={{ fontVariantNumeric: 'tabular-nums' }}>{cell ? <><Amount value={cell.balance} /><div style={{ color: 'var(--text-muted)' }}>{cell.loans.map((l) => l.lender || l.loanNo).join(', ')}</div></> : <span style={{ color: 'var(--text-muted)' }}>-</span>}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Set Up From the Ledger: the proposals, ticked and created. The scan is a
// background job on the API (Oct 2: 145 s live): polled until the table.
export function SetupDialog({ month, onClose, onCreated, pollMs = POLL_MS }) {
  const scan = useLedgerScan(() => api.getLoanProposals(month), [month], pollMs);
  const { data, progress, retry } = scan;
  const [error, setError] = useState('');
  const [unticked, setUnticked] = useState(() => new Set());   // every new row starts ticked; this holds what was unticked
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const scanError = scan.error ? (scan.error.message || 'Could not read the ledger.') : '';
  const rows = data?.proposals || [];
  const fresh = rows.filter((p) => p.status === 'new');
  const ticked = { has: (k) => !unticked.has(k) };
  const toggle = (k) => setUnticked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const create = () => {
    const items = fresh.filter((p) => ticked.has(`${p.entityCode}|${p.glAccount}`)).map((p) => ({ entityCode: p.entityCode, glAccount: p.glAccount }));
    if (!items.length) return;
    setBusy(true);
    setError('');
    api.createLoansFromLedger({ month, items })
      .then((r) => { setDone(r); setBusy(false); })
      .catch((e) => { setError(e?.message || 'Could not create the loans.'); setBusy(false); });
  };
  const count = fresh.filter((p) => ticked.has(`${p.entityCode}|${p.glAccount}`)).length;
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label="Set up loans from the ledger" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 980 }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>Set Up From the Ledger</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>Liability accounts that look like loans on the balance sheet as of {data?.asOf ? formatDate(data.asOf) : monthLabel(month)}. Nothing is typed: the balance is read from the ledger every month.</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12, maxHeight: '72vh', overflowY: 'auto' }}>
          {error && <div style={bad}>{error}</div>}
          {scanError && (
            <div style={{ ...bad, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ flex: 1 }}>{scanError}</span>
              <button type="button" className="secondary-btn" onClick={retry} style={{ fontSize: '0.76rem' }}>Try Again</button>
            </div>
          )}
          {(data?.notes || []).length > 0 && <div style={{ fontSize: '0.78rem', color: '#92400e', background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.3)', borderRadius: 8, padding: '6px 10px' }}>{data.notes.join(' · ')} - open again to retry.</div>}
          {data && !done && <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{entitiesScannedText(data)} · {data.liabilityAccounts ?? 0} liability {data.liabilityAccounts === 1 ? 'account' : 'accounts'}</div>}
          {progress ? <ScanProgress progress={progress} /> : scanError ? null : data === null ? <SkeletonBlocks count={2} /> : done ? (
            <div style={{ fontSize: '0.86rem', display: 'grid', gap: 6 }}>
              <strong>{done.created.length} {done.created.length === 1 ? 'loan' : 'loans'} set up{done.skipped.length ? `, ${done.skipped.length} skipped` : ''}.</strong>
              {done.created.map((p) => <div key={`${p.entityCode}|${p.glAccount}`}>{p.lender || p.title} - {p.entityName}, GL {p.glAccount}, <Amount value={p.balance} /></div>)}
              {done.skipped.map((p) => <div key={`${p.entityCode}|${p.glAccount}`} style={{ color: 'var(--text-muted)' }}>{p.entityCode} GL {p.glAccount}: {p.why}</div>)}
            </div>
          ) : !rows.length ? (
            <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', display: 'grid', gap: 6 }}>
              <strong style={{ color: 'var(--text-primary)' }}>No loan-like liability accounts found.</strong>
              <span>Looked at {data.liabilityAccounts ?? 0} liability {data.liabilityAccounts === 1 ? 'account' : 'accounts'} across {data.entitiesScanned ?? 0} {data.entitiesScanned === 1 ? 'entity' : 'entities'} for a title that says {(data.lookedFor || []).join(', ')}.</span>
              <span>If a loan sits on an account named differently, add it under Accounting &gt; Data &gt; Loans with its GL account and Balance from set to Ledger.</span>
            </div>
          ) : (
            <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
              <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <thead><tr><th style={{ width: 30 }} /><th>Entity</th><th>GL Account</th><th>Title</th><th style={num}>Balance</th><th>Lender</th><th>Kind</th><th>Status</th></tr></thead>
                <tbody>
                  {rows.map((p) => {
                    const k = `${p.entityCode}|${p.glAccount}`;
                    return (
                      <tr key={k} style={p.status === 'set_up' ? { color: 'var(--text-muted)' } : undefined}>
                        <td>{p.status === 'new' ? <input type="checkbox" checked={ticked.has(k)} onChange={() => toggle(k)} aria-label={`Create ${p.title} on ${p.entityName}`} /> : null}</td>
                        <td>{p.entityName}</td><td>{p.glAccount}</td><td>{p.title}</td>
                        <td style={num}><Amount value={p.balance} />{p.debitBalance && <> <Chip tone="wait" title="This liability account carries a debit balance on the ledger: it is shown as negative owed, not flipped">Debit Balance</Chip></>}</td>
                        <td>{p.lender || <span style={{ color: 'var(--text-muted)' }}>unknown - type it after</span>}</td>
                        <td><Chip tone={p.kind === 'intercompany' ? 'muted' : 'brand'}>{KIND[p.kind] || p.kind}</Chip></td>
                        <td>{p.status === 'set_up' ? <Chip tone="ok">Set Up</Chip> : <Chip tone="wait">New</Chip>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 24px 16px' }}>
          <button type="button" className="secondary-btn" onClick={done ? onCreated : onClose}>{done ? 'Done' : 'Cancel'}</button>
          {!done && rows.length > 0 && <button type="button" className="primary-btn" disabled={busy || !count} onClick={create}>{busy ? 'Creating...' : `Create ${count} ${count === 1 ? 'Loan' : 'Loans'}`}</button>}
        </div>
      </div>
    </div>
  );
}

// The fields the ledger cannot say, saved to the same fin_loans row.
function EditDialog({ loan, month, onClose, onSaved }) {
  const [d, setD] = useState({ lender: loan.lender || '', ratePct: loan.ratePct ?? '', rateType: loan.rateType || 'fixed', maturity: loan.maturity || '', monthlyPi: loan.monthlyPi ?? null, covenantMin: loan.covenantTyped ? loan.covenantMin : '', notes: loan.notes || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const save = (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    api.updateLoan(loan.id, month, { lender: d.lender, ratePct: d.ratePct === '' ? 0 : Number(d.ratePct), rateType: d.rateType, maturity: d.maturity || '', monthlyPi: d.monthlyPi == null ? 0 : Number(d.monthlyPi), covenantMin: d.covenantMin === '' ? 0 : Number(d.covenantMin), notes: d.notes })
      .then(onSaved).catch((err) => { setError(err?.message || 'Could not save.'); setBusy(false); });
  };
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 };
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <form className="modal-content" role="dialog" aria-modal="true" aria-label="Change loan" onClick={(e) => e.stopPropagation()} onSubmit={save} style={{ maxWidth: 640 }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>Change Loan</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>{loan.entityName} · GL {loan.glAccount} · balance <Amount value={loan.balance} /> from the ledger. The same row as Accounting &gt; Data &gt; Loans.</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12 }}>
          {error && <div style={bad}>{error}</div>}
          <div style={grid}>
            <div><label style={label} htmlFor="loan-lender">Lender</label><input id="loan-lender" type="text" value={d.lender} onChange={(e) => set({ lender: e.target.value })} style={{ ...control, width: '100%' }} /></div>
            <div><label style={label} htmlFor="loan-rate">Rate %</label><input id="loan-rate" type="number" step="0.01" min="0" value={d.ratePct} onChange={(e) => set({ ratePct: e.target.value })} style={{ ...control, width: '100%' }} /></div>
            <div><label style={label} htmlFor="loan-rate-type">Fixed or Variable</label><select id="loan-rate-type" value={d.rateType} onChange={(e) => set({ rateType: e.target.value })} style={{ ...control, width: '100%' }}><option value="fixed">Fixed</option><option value="variable">Variable</option></select></div>
            <div><label style={label} htmlFor="loan-maturity">Maturity</label><input id="loan-maturity" type="date" value={d.maturity} onChange={(e) => set({ maturity: e.target.value })} style={{ ...control, width: '100%' }} /></div>
            <div><label style={label} htmlFor="loan-pi">Monthly P&I</label><AmountInput id="loan-pi" value={d.monthlyPi} onChange={(v) => set({ monthlyPi: v })} style={{ ...control, width: '100%' }} /></div>
            <div><label style={label} htmlFor="loan-cov">Covenant Minimum (DSCR)</label><input id="loan-cov" type="number" step="0.01" min="0" value={d.covenantMin} onChange={(e) => set({ covenantMin: e.target.value })} placeholder="1.35" style={{ ...control, width: '100%' }} /></div>
          </div>
          <div><label style={label} htmlFor="loan-notes">Notes</label><input id="loan-notes" type="text" value={d.notes} onChange={(e) => set({ notes: e.target.value })} style={{ ...control, width: '100%' }} /></div>
        </div>
        <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 24px 16px' }}>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-btn" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

export const _test = { shiftMonth, monthLabel, dscrText };
