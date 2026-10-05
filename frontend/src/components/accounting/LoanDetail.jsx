import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, FolderOpen } from 'lucide-react';
import { api } from '../../api';
import Amount, { formatAmount } from './Amount';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';

// Accounting -> Loans & Financing, one loan opened under its row (Charmi and
// Neil, 10/03-10/04):
//   - "click a loan to see the details of payments": the ledger lines on the
//     loan's principal account and its interest account in the period shown,
//     one row per entry (principal, interest, draw), every entry number opens
//     the whole entry (EntryDetail, the Reports drill-down's window);
//   - "the entire payment history of the loan" in a section that opens and
//     closes, read from the first line on the account to the period's end,
//     with the balance after each entry;
//   - how the loan is wired: the principal account, the interest account
//     (wired by hand, matched by title, or shared), the original principal,
//     the trailing-12 NOI and debt service behind the DSCR, and the Egnyte
//     folders.
// Amortization schedules and stress tests plug in at the bottom (`extras`).

const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const muted = { color: 'var(--text-muted)' };
const head = { fontSize: '0.74rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' };
export const INTEREST_SOURCE = {
  wired: 'wired on this loan',
  matched: 'matched by the account titles',
  shared: 'the entity\'s interest accounts no loan matched, shared by balance',
  none: 'no interest account found',
};

/** The lines of the principal and interest accounts as one row per entry, newest first.
 *  `owedAtEnd` (optional): the balance owed at the window's end, for the balance after each entry. */
export function paymentRows(history, { given = false, owedAtEnd = null } = {}) {
  const by = new Map();
  const key = (l) => l.entryId || l.entryNo || `${l.date}|${l.description}`;
  const take = (l) => {
    const k = key(l);
    if (!by.has(k)) by.set(k, { key: k, date: l.date, entryId: l.entryId, entryNo: l.entryNo, description: l.description || l.memo || '', principal: 0, draw: 0, interest: 0, lines: 0 });
    const r = by.get(k);
    r.lines += 1;
    if (!r.description && (l.description || l.memo)) r.description = l.description || l.memo;
    if (l.date > r.date) r.date = l.date;
    return r;
  };
  (history?.principal?.lines || []).forEach((l) => {
    const r = take(l);
    r.principal += given ? l.credit : l.debit;
    r.draw += given ? l.debit : l.credit;
  });
  (history?.interest || []).forEach((acct) => (acct.lines || []).forEach((l) => {
    const r = take(l);
    r.interest += given ? l.credit - l.debit : l.debit - l.credit;
  }));
  const rows = [...by.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : String(b.entryNo).localeCompare(String(a.entryNo), 'en-US', { numeric: true })));
  if (owedAtEnd != null && !history?.principal?.truncated) {
    let owed = owedAtEnd;
    rows.forEach((r) => { r.balanceAfter = Math.round(owed * 100) / 100; owed += r.principal - r.draw; });
  }
  return rows;
}

function PaymentsTable({ rows, showBalance, onOpenEntry, empty }) {
  if (!rows.length) return <div style={{ fontSize: '0.8rem', ...muted, padding: '6px 0' }}>{empty}</div>;
  const total = rows.reduce((t, r) => ({ principal: t.principal + r.principal, interest: t.interest + r.interest, draw: t.draw + r.draw }), { principal: 0, interest: 0, draw: 0 });
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border-color)', borderRadius: 8 }}>
      <table className="acct-lines" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', '--acct-row-py': '5px' }}>
        <thead>
          <tr style={{ background: 'var(--bg-secondary)' }}>
            {['Date', 'Entry', 'Description', 'Principal Paid', 'Interest Paid', 'Total Payment', 'Draws', ...(showBalance ? ['Balance After'] : [])].map((h, i) => (
              <th key={h} style={{ padding: '6px 10px', textAlign: i >= 3 ? 'right' : 'left', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{formatDate(r.date)}</td>
              <td>{r.entryId ? <button type="button" className="acct-drill" onClick={() => onOpenEntry(r)} title="Open the whole entry">{r.entryNo || 'Entry'}</button> : (r.entryNo || '-')}</td>
              <td style={{ maxWidth: 320 }} title={r.description}>{r.description || <span style={muted}>-</span>}</td>
              <td style={num}><Amount value={r.principal} zero="dash" /></td>
              <td style={num}><Amount value={r.interest} zero="dash" /></td>
              <td style={num}><Amount value={r.principal + r.interest} zero="dash" /></td>
              <td style={num}><Amount value={r.draw} zero="dash" /></td>
              {showBalance && <td style={num}><Amount value={Math.abs(r.balanceAfter ?? 0)} /></td>}
            </tr>
          ))}
          <tr className="acct-grand">
            <td colSpan={3}>Total ({rows.length} {rows.length === 1 ? 'entry' : 'entries'})</td>
            <td style={num}><Amount value={total.principal} zero="dash" /></td>
            <td style={num}><Amount value={total.interest} zero="dash" /></td>
            <td style={num}><Amount value={total.principal + total.interest} zero="dash" /></td>
            <td style={num}><Amount value={total.draw} zero="dash" /></td>
            {showBalance && <td />}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function useHistory(loan, from, to, enabled) {
  const [state, setState] = useState({ key: null, data: null, error: '' });
  const key = JSON.stringify([loan.id, from || '', to, loan.interestAccount || '', enabled]);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    api.getLoanHistory(loan.id, { from, to, interest: loan.interestAccount || '' })
      .then((d) => { if (alive) setState({ key, data: d, error: '' }); })
      .catch((e) => { if (alive) setState({ key, data: null, error: e?.message || 'Could not read the ledger lines.' }); });
    return () => { alive = false; };
  }, [key, enabled, loan.id, from, to, loan.interestAccount]);
  return state.key === key ? state : { data: null, error: '' };
}

export default function LoanDetail({ loan, from, to, onOpenEntry, extras = null }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const ledger = loan.wiring === 'ok' || !!loan.interestAccount;
  const given = loan.kind === 'given';
  const period = useHistory(loan, from, to, ledger);
  const all = useHistory(loan, '', to, ledger && historyOpen);
  const periodRows = useMemo(() => paymentRows(period.data, { given }), [period.data, given]);
  const allRows = useMemo(() => paymentRows(all.data, { given, owedAtEnd: loan.wiring === 'ok' ? loan.owed : null }), [all.data, given, loan.wiring, loan.owed]);
  const interestText = loan.interestAccounts?.length
    ? loan.interestAccounts.map((a) => `GL ${a.code}${a.title ? ` ${a.title}` : ''}`).join(', ')
    : 'None';

  const fact = (label, value, title) => (
    <div title={title} style={{ minWidth: 150 }}>
      <div style={{ fontSize: '0.7rem', ...muted }}>{label}</div>
      <div style={{ fontSize: '0.82rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
  return (
    <div style={{ display: 'grid', gap: 12, padding: '12px 14px 14px', background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-color)' }} aria-label={`Details of ${loan.lender || loan.loanNo}`}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 24px' }}>
        {fact('Principal Account', loan.glAccount ? `GL ${loan.glAccount}${loan.glTitle ? ` ${loan.glTitle}` : ''}` : 'None - kept by hand', loan.wiring === 'missing' ? 'This account has no lines in this entity on the ledger - check the wiring under Change Loan.' : undefined)}
        {fact('Interest Account', interestText, INTEREST_SOURCE[loan.interestSource] ? `From ${INTEREST_SOURCE[loan.interestSource]}.` : undefined)}
        {fact('Original Principal', loan.originalPrincipal == null ? '-' : `${formatAmount(loan.originalPrincipal)}${loan.originalPrincipalEdited ? ' (edited)' : loan.originalPrincipalDate ? ` on ${formatDate(loan.originalPrincipalDate)}` : ''}`)}
        {fact('Draws in Period', loan.draws == null ? '-' : formatAmount(loan.draws), 'Credits to the principal account in the period: new money borrowed, not payments.')}
        {fact('NOI (T12)', formatAmount(loan.noiT12), `Income ${formatAmount(loan.incomeT12)} less operating expenses ${formatAmount(loan.operatingExpensesT12)}; interest, depreciation and amortization left out.`)}
        {fact('Debt Service (T12)', loan.debtServiceT12 == null ? '-' : formatAmount(loan.debtServiceT12), `This loan's principal and interest over the twelve months; the entity's whole debt service is ${formatAmount(loan.entityDebtServiceT12)}.`)}
        <div style={{ minWidth: 150 }}>
          <div style={{ fontSize: '0.7rem', ...muted }}>Egnyte</div>
          <div style={{ display: 'flex', gap: 10, fontSize: '0.8rem' }}>
            {loan.docsUrl ? <a href={loan.docsUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><FolderOpen size={13} /> Loan Documents</a> : <span style={muted}>No documents folder</span>}
            {loan.statementsUrl ? <a href={loan.statementsUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><FileText size={13} /> Loan Statements</a> : <span style={muted}>No statements folder</span>}
          </div>
        </div>
      </div>

      {!ledger ? (
        <div style={{ fontSize: '0.8rem', ...muted }}>This loan is kept by hand (not in Intacct), so there are no ledger lines to show. Wire its principal and interest accounts under Change Loan to read them.</div>
      ) : (
        <>
          <section style={{ display: 'grid', gap: 6 }}>
            <div style={head}>Payments {from ? `${formatDate(from)} - ${formatDate(to)}` : `to ${formatDate(to)}`}</div>
            {period.error ? <div style={{ fontSize: '0.8rem', color: 'var(--bad-fg, #dc2626)' }}>{period.error}</div>
              : !period.data ? <SkeletonBlocks count={1} height={60} borderRadius={8} />
                : <PaymentsTable rows={periodRows} onOpenEntry={onOpenEntry} empty="No lines on the principal or interest account in this period." />}
            {(period.data?.notes || []).length > 0 && <div style={{ fontSize: '0.74rem', color: '#92400e' }}>{period.data.notes.join(' · ')}</div>}
          </section>
          <section style={{ display: 'grid', gap: 6 }}>
            <button type="button" onClick={() => setHistoryOpen((v) => !v)} aria-expanded={historyOpen}
              style={{ ...head, border: 'none', background: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, justifySelf: 'start' }}>
              {historyOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Payment History
            </button>
            {historyOpen && (all.error ? <div style={{ fontSize: '0.8rem', color: 'var(--bad-fg, #dc2626)' }}>{all.error}</div>
              : !all.data ? <SkeletonBlocks count={1} height={80} borderRadius={8} />
                : (
                  <>
                    <PaymentsTable rows={allRows} showBalance={loan.wiring === 'ok' && !all.data.principal?.truncated} onOpenEntry={onOpenEntry} empty="No lines on the principal or interest account yet." />
                    {all.data.principal?.truncated && <div style={{ fontSize: '0.74rem', ...muted }}>The newest {all.data.principal.lines.length} of {all.data.principal.total} lines are shown.</div>}
                  </>
                ))}
          </section>
        </>
      )}
      {/* Plug-in area: amortization schedule and stress test (LoanAmortization.jsx, LoanStress.jsx). */}
      {extras}
    </div>
  );
}
