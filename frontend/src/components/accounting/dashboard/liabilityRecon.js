import { keyOfISO, monthsBetween } from '../../../accounting/dashboard/model/months';

// Mortgages, loans and lines of credit reconciled in Nexus (Charmi and Neil,
// 10/25-10/26, item 09). The reconciliation list's loan rows come from the
// shared model (recon.js, compiled from the accounting app) with no status of
// their own; this lays Nexus's saved months over them so the list, the KPI
// card and the attention strip read Last Reconciled, the statement balance
// and the status the same way they do for a bank account. Pure.
//
// `status` is GET /accounting/liability-recons: per loan id, this month's
// record (`month`, any state) and the latest reconciled month (`last`).
// Amounts there are what is OWED (positive); a row carries a liability as the
// negative ledger figure, so the statement is -owed and Difference is
// book - statement = statement owed - ledger owed.

export const loanIdOf = (key) => (typeof key === 'string' && key.startsWith('loan:') ? key.slice(5) : null);

const lagOf = (period, thru) => {
  if (!thru) return 99;
  const k = keyOfISO(thru);
  if (k >= period) return 0;
  return monthsBetween(k, period).length - 1;
};

export function applyLiabilityRecons(rows, { period, status = {}, loans = [] }) {
  const glOf = new Map(loans.map((l) => [String(l.id), String(l.gl_account || '').trim()]));
  return rows.map((r) => {
    const id = loanIdOf(r.key);
    if (!id) return r;
    // The loan's principal GL account: its ledger lines and balance drill-down.
    const base = { ...r, gl: r.gl || glOf.get(id) || '', liability: true };
    const st = status[id];
    if (!st || (!st.month && !st.last)) return base;
    const { month, last } = st;
    if (month?.status === 'reconciled') {
      return { ...base, thru: month.statementDate, lag: 0, stmt: -Number(month.statementBalance || 0), diff: 0, status: 'Reconciled', source: 'nexus', nexus: month, mark: null };
    }
    const thru = last?.statementDate || null;
    const lag = lagOf(period, thru);
    const out = { ...base, thru, lag, stmt: last ? -Number(last.statementBalance || 0) : base.stmt, diff: 0, source: last ? 'nexus' : base.source, nexus: last || null, draft: month || null, mark: null };
    // A statement typed for this month that does not agree with the ledger.
    if (month && month.difference != null && Math.abs(Number(month.difference)) >= 0.005) {
      return { ...out, stmt: -Number(month.statementBalance || 0), diff: Number(month.difference), status: 'Difference' };
    }
    return { ...out, status: lag === 1 ? 'In progress' : 'Behind' };
  });
}
