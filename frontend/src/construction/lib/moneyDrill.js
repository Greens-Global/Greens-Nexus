// The drill-downs behind a job's posted figures (Neil, 11/03/2026, plan
// phase 4; the house rule: every amount opens its ledger lines and on to the
// source transaction). Built with the Accounting reports' own lineQuery, so a
// job's lines are read exactly like a report's - the job's Project-Job as
// `project`, its entity as `location`, from the start of the books to the
// day the figure was read. Loaded with the Money tab only (reportModel is
// big), never on the Overview.
import { lineQuery } from '../../components/accounting/reportModel';

const dimsFor = (link, row, by) => ({
  project: [link.project],
  ...(by === 'item' && row?.code ? { item: [row.code] } : {}),
});

/**
 * The ledger searches behind one Actual row (a cost code: one per account
 * under it; a GL account: that account), or behind the total (every cost
 * account, no cost code filter) - the same accounts, period, entity and
 * Project-Job the figure was added up from.
 */
export function actualQueries(m, row = null) {
  const link = m?.link || {};
  const by = m?.actual?.by || 'account';
  // The same book the totals were added up from (the accrual book).
  const drill = { to: m?.asOf, entity: link.entity, book: m?.book || 'accrual' };
  if (row) {
    return row.accounts.map((a) => lineQuery({ account: a.account_no, drill, dims: dimsFor(link, row, by) }));
  }
  const accounts = [...new Set((m?.actual?.rows || []).flatMap((r) => r.accounts.map((a) => a.account_no)))];
  return accounts.map((account) => lineQuery({ account, drill, dims: { project: [link.project] } }));
}

/** "No Cost Code" adds up the lines with no item: its panel keeps only those. */
export const keepFor = (m, row) => (m?.actual?.by === 'item' && row && !row.code ? (l) => !l.item_id : null);

/** Open in Reports for a row of one account - the same lines on the General Ledger. */
export function actualReport(m, row) {
  if (!row || row.accounts.length !== 1) return null;
  const link = m?.link || {};
  const a = row.accounts[0];
  return { account: a.account_no, accountName: a.title, from: '', to: m?.asOf, book: m?.book || 'accrual', entity: link.entity, dims: dimsFor(link, row, m?.actual?.by) };
}
