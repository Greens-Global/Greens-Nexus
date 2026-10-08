// Accounting > Budget -> an import file for Intacct (Charmi, item 43, 10/02:
// "once the data from budgeted is added, it should create an import file for
// Intacct. Intacct then sucks in the updated data"). One row per budget x
// account x entity x period, the period named exactly as an Intacct reporting
// period ("Month Ended January 2026").
//
// PROVISIONAL: the column set follows the Intacct budget import as we know it
// (budget ID, GL account no., location ID, period name, amount); department
// is left out because the Nexus budget is kept per entity only. Match it to
// Charmi's own Intacct template before the first real import.

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const INTACCT_BUDGET_HEADER = ['Budget ID', 'Account No.', 'Location ID', 'Period Name', 'Amount'];
/** The Intacct reporting period of a month (0-11) of a year. */
export const intacctPeriodName = (year, month) => `Month Ended ${MONTH_NAMES[month]} ${year}`;

/**
 * Check the budget, then lay it out for Intacct.
 *   rows: [{ accountNo, title, months: [12 numbers] }] as the Budget tab holds them
 * Returns { problems: [text], lines: [[...]] } - lines (header first) only
 * when there are no problems. A month at zero is left out; a budget with
 * nothing in it is a problem, not an empty file.
 */
export function intacctBudgetFile({ budgetId, location, year, rows, dirty = false }) {
  const problems = [];
  const id = String(budgetId || '').trim();
  if (!id) problems.push('Give the Intacct budget ID the file loads into (Intacct > General Ledger > Budgets).');
  else if (!/^[A-Za-z0-9 _.-]{1,40}$/.test(id)) problems.push('The budget ID can hold letters, numbers, spaces, dots, dashes and underscores (40 at most).');
  if (!String(location || '').trim()) problems.push('Pick the entity the budget is for.');
  if (!Number.isInteger(Number(year))) problems.push('Pick the year.');
  if (dirty) problems.push('Save the budget first - the file is made from what is saved.');
  const out = [];
  (rows || []).forEach((r) => {
    const acct = String(r.accountNo || '').trim();
    const months = Array.isArray(r.months) ? r.months : [];
    if (!months.some((v) => Number(v))) return;
    if (!acct || !/^[A-Za-z0-9._-]{1,24}$/.test(acct)) { problems.push(`"${r.title || 'An account'}" has no usable account number.`); return; }
    if (months.length !== 12) { problems.push(`${acct} does not have twelve months.`); return; }
    months.forEach((v, m) => {
      const n = Number(v);
      if (!Number.isFinite(n)) { problems.push(`${acct} ${MONTH_NAMES[m]}: "${v}" is not an amount.`); return; }
      if (!n) return;
      out.push([id, acct, String(location).trim(), intacctPeriodName(Number(year), m), (Math.round(n * 100) / 100).toFixed(2)]);
    });
  });
  if (!out.length && !problems.length) problems.push('Nothing to export - every month of every account is zero.');
  return problems.length ? { problems, lines: [] } : { problems: [], lines: [INTACCT_BUDGET_HEADER, ...out] };
}
