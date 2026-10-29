// Accounting > Reporting > Profitability (Charmi + Neil, 10/15): the pure
// side of the sheet - the columns, the cells, the account breakdown behind a
// figure and the export table. Every figure is computed by the backend
// (routers/accounting_profitability.py, which documents the account
// classification); this only lays it out.

import { formatDate } from '../../lib/datetime';

export const PROFIT_COLUMNS = [
  { key: 'revenue', label: 'Revenue', kind: 'amount', groups: ['revenue'] },
  { key: 'opex', label: 'Operating Expenses', kind: 'amount', groups: ['opex'] },
  { key: 'noi', label: 'NOI', kind: 'amount', groups: ['revenue', 'opex'], strong: true },
  { key: 'noiMargin', label: 'NOI Margin %', kind: 'pct' },
  { key: 'interest', label: 'Interest Expense', kind: 'amount', groups: ['interest'] },
  { key: 'da', label: 'Depreciation & Amortization', kind: 'amount', groups: ['da'] },
  { key: 'netIncome', label: 'Net Income', kind: 'amount', groups: ['revenue', 'opex', 'interest', 'da'], strong: true },
  { key: 'netMargin', label: 'Net Margin %', kind: 'pct' },
  { key: 'debtService', label: 'Debt Service', kind: 'amount' },
  { key: 'cashFlowAfterDebt', label: 'Cash Flow After Debt Service', kind: 'amount', strong: true },
];

// The figure the prior-year columns compare (the backend sends the change
// for these four).
export const COMPARE_ON = [
  { key: 'netIncome', label: 'Net Income' },
  { key: 'noi', label: 'NOI' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'cashFlowAfterDebt', label: 'Cash Flow After Debt Service' },
];

export const GROUP_LABEL = { revenue: 'Revenue', opex: 'Operating Expenses', interest: 'Interest Expense', da: 'Depreciation & Amortization' };
// A cost lowers NOI / Net Income: the breakdown of a net figure shows it negative.
const SIGN = { revenue: 1, opex: -1, interest: -1, da: -1 };

/** 12.34 -> "12.3%", -5 -> "(5.0%)", null -> "". */
export function pctText(v) {
  if (v == null || !Number.isFinite(Number(v))) return '';
  const n = Number(v);
  const s = `${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  return n < 0 ? `(${s})` : s;
}

const money = (v) => {
  const n = Math.round((Number(v) || 0) * 100) / 100;
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `(${s})` : s;
};

/** Whether a column's figure on a row can be opened into accounts. */
export const canDrill = (column) => Array.isArray(column.groups) && column.groups.length > 0;

/**
 * The accounts behind one figure of one row: [{ group, label, account,
 * title, amount, signed }] - `signed` is the account's effect on the figure
 * (costs negative under NOI / Net Income), so the lines add up to it.
 */
export function breakdown(row, column) {
  if (!row?.current?.accounts || !canDrill(column)) return [];
  const net = column.groups.length > 1;
  return column.groups.flatMap((g) => (row.current.accounts[g] || []).map((a) => ({
    group: g, label: GROUP_LABEL[g], account: a.account, title: a.title, amount: a.amount, signed: net ? a.amount * SIGN[g] : a.amount,
  })));
}

export const periodLine = (data) => (data ? `${formatDate(data.from)} - ${formatDate(data.to)}` : '');
export const priorLine = (data) => (data?.priorFrom ? `${formatDate(data.priorFrom)} - ${formatDate(data.priorTo)}` : '');

/** Rows in screen order with their depth (a sub-entity sits under its parent). */
export function orderedRows(data) {
  const rows = data?.rows || [];
  return rows.map((r) => ({ ...r, depth: r.parent ? 1 : 0 }));
}

function cellsOf(fig, prior, change, compareOn, withPrior) {
  const out = PROFIT_COLUMNS.map((c) => {
    const v = fig?.[c.key];
    if (c.kind === 'pct') return pctText(v);
    return v == null ? '' : Math.round(Number(v) * 100) / 100;
  });
  if (withPrior) {
    const p = prior?.[compareOn];
    const ch = change?.[compareOn] || {};
    out.push(p == null ? '' : Math.round(Number(p) * 100) / 100, ch.amount == null ? '' : ch.amount, pctText(ch.pct));
  }
  return out;
}

/**
 * The sheet as a linesExport table ({ title, subtitle, columns, rows, totals })
 * for PDF / Excel / CSV. When sub-entity rows are on the sheet the Totals line
 * is written as plain figures (the sheet's own totals, roots only) instead of
 * live sums, which would count a sub-entity twice.
 */
export function profitTable(data, { compareOn = 'netIncome', entityLabel = 'All Entities', bookLabel = 'Accrual' } = {}) {
  const withPrior = !!data?.totals?.prior;
  const cmp = COMPARE_ON.find((c) => c.key === compareOn) || COMPARE_ON[0];
  const columns = [
    { label: 'Entity', num: false, width: 220 },
    ...PROFIT_COLUMNS.map((c) => ({ label: c.label, num: c.kind === 'amount', width: c.kind === 'pct' ? 80 : 110 })),
    ...(withPrior ? [
      { label: `Prior Year ${cmp.label}`, num: true, width: 110 },
      { label: 'Change $', num: true, width: 100 },
      { label: 'Change %', num: false, width: 80 },
    ] : []),
  ];
  const rows = orderedRows(data).map((r) => [`${r.depth ? '    ' : ''}${r.name} (${r.code})`, ...cellsOf(r.current, r.prior, r.change, compareOn, withPrior)]);
  const totalCells = ['Total', ...cellsOf(data?.totals?.current, data?.totals?.prior, data?.totals?.change, compareOn, withPrior)];
  const nested = (data?.rows || []).some((r) => r.parent);
  const subtitle = [entityLabel, periodLine(data), withPrior ? `Prior year ${priorLine(data)}` : '', `Book: ${bookLabel}`].filter(Boolean).join('  ·  ');
  return {
    title: 'Profitability Sheet',
    subtitle,
    period: periodLine(data).replace(/\//g, '-'),
    columns,
    rows: nested ? [...rows, totalCells] : rows,
    totals: nested ? null : totalCells,
  };
}

/** A figure as the screen prints it ("-" for nothing). */
export function figureText(column, value) {
  if (column.kind === 'pct') return pctText(value) || '-';
  if (value == null) return '-';
  return money(value);
}
