// Budget math (Accounting > Budget, Oct 2). Pure functions so the grid and
// the Budget vs Actual view are testable without a screen.
//
// A budget row is { accountNo, title, months: [12 numbers] }. Actuals come
// from the ledger's by-month buckets (GET /accounting/reports/buckets,
// by=month): rows of { account_no, title, section, bucket: 'YYYY-MM-DD',
// debit, credit }, signed here the way the income statement reads them -
// revenue as credit minus debit, costs as debit minus credit.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const INCOME = new Set(['revenue', 'other_income']);
// The sections of the income statement, as the ledger names them.
export const PL_SECTIONS = ['revenue', 'cogs', 'expense', 'other_income', 'other_expense'];

export const signedActual = (r) => (INCOME.has(r.section) ? (r.credit || 0) - (r.debit || 0) : (r.debit || 0) - (r.credit || 0));

/** Bucket rows for one year -> { accountNo: { title, section, months: [12] } }. */
export function actualsByAccount(bucketRows, year) {
  const out = new Map();
  (bucketRows || []).forEach((r) => {
    if (!PL_SECTIONS.includes(r.section)) return;
    const b = String(r.bucket || '');
    if (b.slice(0, 4) !== String(year)) return;
    const m = Number(b.slice(5, 7)) - 1;
    if (!(m >= 0 && m < 12)) return;
    const cur = out.get(r.account_no) || { title: r.title || '', section: r.section, months: Array(12).fill(0) };
    cur.months[m] = round2(cur.months[m] + signedActual(r));
    out.set(r.account_no, cur);
  });
  return out;
}

/** The grid with each account's months replaced by the actuals (zero where nothing posted); accounts the grid lacks are added. */
export function copyActuals(rows, actuals) {
  const seen = new Set();
  const out = rows.map((r) => {
    seen.add(r.accountNo);
    const a = actuals.get(r.accountNo);
    return { ...r, months: a ? [...a.months] : Array(12).fill(0) };
  });
  [...actuals.entries()].filter(([code]) => !seen.has(code)).forEach(([code, a]) => out.push({ accountNo: code, title: a.title, months: [...a.months] }));
  return out;
}

export const rowTotal = (months) => round2((months || []).reduce((s, v) => s + (Number(v) || 0), 0));

/** Column totals across the grid, plus the grand total. */
export function gridTotals(rows) {
  const months = Array(12).fill(0);
  rows.forEach((r) => r.months.forEach((v, i) => { months[i] = round2(months[i] + (Number(v) || 0)); }));
  return { months, total: rowTotal(months) };
}

/**
 * Budget vs Actual per account, year to date through month `through`
 * (1-12): Actual, Budget, Variance $ (actual minus budget) and Variance %
 * (of budget; blank when the budget is zero). A row whose figures are all
 * zero is left out.
 */
export function budgetVsActual(rows, actuals, through) {
  const n = Math.max(1, Math.min(12, Number(through) || 12));
  const sum = (arr) => round2((arr || []).slice(0, n).reduce((s, v) => s + (Number(v) || 0), 0));
  const codes = new Set([...rows.map((r) => r.accountNo), ...actuals.keys()]);
  const out = [];
  [...codes].sort((a, b) => a.localeCompare(b, 'en-US', { numeric: true })).forEach((code) => {
    const r = rows.find((x) => x.accountNo === code);
    const a = actuals.get(code);
    const budget = sum(r?.months);
    const actual = sum(a?.months);
    if (!budget && !actual) return;
    const variance = round2(actual - budget);
    out.push({ accountNo: code, title: r?.title || a?.title || '', section: a?.section || '', actual, budget, variance,
      pct: budget ? round2((variance / Math.abs(budget)) * 100) : null });
  });
  const totals = out.reduce((t, r) => ({ actual: round2(t.actual + r.actual), budget: round2(t.budget + r.budget), variance: round2(t.variance + r.variance) }), { actual: 0, budget: 0, variance: 0 });
  return { rows: out, totals: { ...totals, pct: totals.budget ? round2((totals.variance / Math.abs(totals.budget)) * 100) : null }, through: n };
}

export const pctText = (v) => (v == null ? '' : v < 0 ? `(${Math.abs(v).toFixed(1)}%)` : `${v.toFixed(1)}%`);
