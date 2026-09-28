import { formatDate } from '../../lib/datetime';

// The logic behind Accounting -> Reports, free of React so the screen, the CSV
// export and the reporting-package PDF all read a statement the same way.
//
// A report is described by a CONFIG (what a memorized report stores): which
// statement, the period, the book, the entities, the dimension filters and
// the comparison. runReport(api, config) reads the ledger and returns one
// RESULT: columns plus flat rows (section, account, total), ready to draw.

export const REPORTS = [
  { key: 'pnl', label: 'Income Statement', period: 'range' },
  { key: 'balance-sheet', label: 'Balance Sheet', period: 'asof' },
  { key: 'trial-balance', label: 'Trial Balance', period: 'range' },
  { key: 'cash-position', label: 'Cash Position', period: 'asof' },
];
export const reportDef = (key) => REPORTS.find((r) => r.key === key) || REPORTS[0];

export const PRESETS = [
  { key: 'month', label: 'This Month' },
  { key: 'last-month', label: 'Last Month' },
  { key: 'quarter', label: 'This Quarter' },
  { key: 'last-quarter', label: 'Last Quarter' },
  { key: 'ytd', label: 'Year to Date' },
  { key: 'last-year', label: 'Last Year' },
  { key: 'custom', label: 'Custom' },
];

// What a statement can be compared against. A range compares to the same
// dates a year earlier or to the run of equal length just before it; a
// balance sheet compares to the same date a year earlier or to the previous
// month end.
export const COMPARE = {
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

// Accrual, cash, or the two side by side (Neil, Sep 25).
export const BOOKS = [
  { key: 'accrual', label: 'Accrual' },
  { key: 'cash', label: 'Cash' },
  { key: 'both', label: 'Accrual and Cash' },
];
export const bookLabel = (key) => BOOKS.find((b) => b.key === key)?.label || 'Accrual';

// The dimensions a report can be narrowed by, in the order Charmi listed
// them. Entities have their own picker; the rest list the codes that
// actually appear on the ledger.
export const DIM_KINDS = [
  { key: 'departments', kind: 'department', label: 'Department', plural: 'departments' },
  { key: 'vendor', kind: 'vendor', label: 'Vendor', plural: 'vendors' },
  { key: 'customer', kind: 'customer', label: 'Customer', plural: 'customers' },
  { key: 'employee', kind: 'employee', label: 'Employee', plural: 'employees' },
  { key: 'project', kind: 'project', label: 'Project-Job', plural: 'Project-Jobs' },
  { key: 'item', kind: 'item', label: 'Item', plural: 'items' },
];
export const EMPTY_DIMS = { departments: [], vendor: [], customer: [], employee: [], project: [], item: [] };
export const countDims = (d) => DIM_KINDS.reduce((n, k) => n + ((d?.[k.key] || []).length ? 1 : 0), 0);

// Historical classes carry "(H)" in their Intacct name (Charmi, Sep 25).
// They stay on the ledger and in every total; pickers leave them out unless
// one is already part of the selection.
export const isHistorical = (name) => /\(\s*H\s*\)/i.test(name || '');

export const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const parse = (s) => new Date(`${s}T00:00:00`);
export const money = (n) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
};
export const pct = (cur, prev) => {
  if (Math.abs(prev) < 0.005) return '';
  const p = ((cur - prev) / Math.abs(prev)) * 100;
  return `${p < 0 ? '(' : ''}${Math.abs(p).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%${p < 0 ? ')' : ''}`;
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function presetRange(key, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const q = Math.floor(m / 3) * 3;
  switch (key) {
    case 'month': return [new Date(y, m, 1), now];
    case 'last-month': return [new Date(y, m - 1, 1), new Date(y, m, 0)];
    case 'quarter': return [new Date(y, q, 1), now];
    case 'last-quarter': return [new Date(y, q - 3, 1), new Date(y, q, 0)];
    case 'last-year': return [new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)];
    default: return [new Date(y, 0, 1), now];
  }
}

const isMonthStart = (s) => s.slice(8, 10) === '01';
const isMonthEnd = (s) => { const d = parse(s); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() === d.getDate(); };
const endOfMonth = (y, m) => new Date(y, m + 1, 0);
// Same calendar dates a year back; a month end stays a month end (02/29 -> 02/28).
export function yearBack(s) {
  const d = parse(s);
  if (isMonthEnd(s)) return iso(endOfMonth(d.getFullYear() - 1, d.getMonth()));
  return iso(new Date(d.getFullYear() - 1, d.getMonth(), Math.min(d.getDate(), endOfMonth(d.getFullYear() - 1, d.getMonth()).getDate())));
}
// The run of months (or days) of the same length just before [from, to].
export function priorPeriod(from, to) {
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
export const priorMonthEnd = (s) => { const d = parse(s); return iso(endOfMonth(d.getFullYear(), d.getMonth() - 1)); };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function defaultConfig(now = new Date()) {
  const [f, t] = presetRange('ytd', now).map(iso);
  return { report: 'pnl', preset: 'ytd', from: f, to: t, asof: iso(now), asofToday: true, book: 'accrual', compare: 'none', entities: [], dims: { ...EMPTY_DIMS } };
}

// A config as it should run TODAY: a named period ("Year to Date") moves with
// the calendar, so a report memorized in September still ends today when it
// is opened in October; custom dates stay as they were saved.
export function resolveConfig(config, now = new Date()) {
  const base = defaultConfig(now);
  const c = { ...base, ...(config || {}) };
  c.report = reportDef(c.report).key;
  c.preset = PRESETS.some((p) => p.key === c.preset) ? c.preset : 'ytd';
  if (c.preset !== 'custom' || !ISO.test(c.from || '') || !ISO.test(c.to || '')) {
    if (c.preset === 'custom') c.preset = 'ytd';
    [c.from, c.to] = presetRange(c.preset, now).map(iso);
  }
  if (c.from > c.to) c.to = c.from;
  if (c.asofToday !== false || !ISO.test(c.asof || '')) { c.asof = iso(now); c.asofToday = c.asofToday !== false; }
  c.book = BOOKS.some((b) => b.key === c.book) ? c.book : 'accrual';
  c.entities = Array.isArray(c.entities) ? c.entities.filter((x) => typeof x === 'string' && x) : [];
  c.dims = { ...EMPTY_DIMS, ...Object.fromEntries(DIM_KINDS.map((k) => [k.key, Array.isArray(c.dims?.[k.key]) ? c.dims[k.key] : []])) };
  const def = reportDef(c.report);
  c.compare = COMPARE[def.period].some((x) => x.key === c.compare) ? c.compare : 'none';
  return c;
}

// What is compared, after the rules: only the income statement and the
// balance sheet compare, and two books side by side leave no room for it.
export function activeCompare(config) {
  const can = config.report === 'pnl' || config.report === 'balance-sheet';
  return can && config.book !== 'both' ? config.compare : 'none';
}
export const canPickBook = (config) => config.report !== 'cash-position';
export const canUseDims = (config) => config.report !== 'cash-position';

export function priorRangeOf(config) {
  const cmp = activeCompare(config);
  if (cmp === 'none') return null;
  if (reportDef(config.report).period === 'asof') return { asof: cmp === 'prior-year' ? yearBack(config.asof) : priorMonthEnd(config.asof) };
  if (cmp === 'prior-year') return { from: yearBack(config.from), to: yearBack(config.to) };
  const [from, to] = priorPeriod(config.from, config.to);
  return { from, to };
}

export const periodText = (config) => {
  const def = reportDef(config.report);
  if (def.period === 'asof') return `As of ${formatDate(config.asof)}`;
  const label = PRESETS.find((p) => p.key === config.preset)?.label || 'Custom';
  return `${label} · ${formatDate(config.from)} - ${formatDate(config.to)}`;
};
const rangeLabel = (r) => (r.asof ? `As of ${formatDate(r.asof)}` : `${formatDate(r.from)} - ${formatDate(r.to)}`);

export function entityText(config, entities = []) {
  if (!config.entities.length) return 'All entities';
  if (config.entities.length > 1) return `${config.entities.length} entities`;
  const e = entities.find((x) => x.code === config.entities[0]);
  return e?.name ? `${e.name} (${e.code})` : config.entities[0];
}
export function dimsText(config) {
  return DIM_KINDS.filter((k) => config.dims[k.key].length)
    .map((k) => (config.dims[k.key].length === 1 ? `${k.label} ${config.dims[k.key][0]}` : `${config.dims[k.key].length} ${k.plural}`));
}

// One entity travels as `location`; several travel in the dimension set.
function placeOf(config) {
  const dims = canUseDims(config) ? { ...config.dims } : { ...EMPTY_DIMS };
  let location;
  if (config.entities.length === 1) location = config.entities[0];
  else if (config.entities.length > 1) dims.locations = config.entities;
  const any = Object.values(dims).some((v) => Array.isArray(v) && v.length);
  return { location, dims: any ? dims : null };
}

function fetchStatement(api, config, range, book) {
  const { location, dims } = placeOf(config);
  if (config.report === 'pnl') return api.getAccountingPnl(range.from, range.to, location, dims, book);
  if (config.report === 'balance-sheet') return api.getAccountingBalanceSheet(range.asof, location, dims, book);
  if (config.report === 'cash-position') return api.getAccountingCashPosition(range.asof, location, config.entities.length > 1 ? config.entities : undefined);
  return api.getAccountingTrialBalance(range.from, range.to, location, dims, book);
}

const keyOf = (a) => a.account_no || a.title;

// Sections with the accounts of BOTH statements: an account that exists only
// in the comparison (or only in the cash book) still gets its row, so every
// column adds up to its own total.
function mergeSections(a, b) {
  const out = [];
  const keys = [...new Set([...(a?.sections || []).map((s) => s.key), ...(b?.sections || []).map((s) => s.key)])];
  keys.forEach((key) => {
    const sa = (a?.sections || []).find((s) => s.key === key);
    const sb = (b?.sections || []).find((s) => s.key === key);
    const accounts = new Map();
    (sa?.accounts || []).forEach((x) => accounts.set(keyOf(x), { code: x.account_no || '', title: x.title, a: x.amount, b: 0 }));
    (sb?.accounts || []).forEach((x) => {
      const cur = accounts.get(keyOf(x));
      if (cur) cur.b = x.amount;
      else accounts.set(keyOf(x), { code: x.account_no || '', title: x.title, a: 0, b: x.amount });
    });
    const list = [...accounts.values()].sort((x, y) => {
      // Accounts without a code (the earnings lines a balance sheet adds) keep their place at the end.
      if (!x.code || !y.code) return x.code ? -1 : y.code ? 1 : 0;
      return x.code.localeCompare(y.code, 'en-US', { numeric: true });
    });
    out.push({ key, label: (sa || sb).label, a: sa?.total || 0, b: sb?.total || 0, accounts: list });
  });
  return out;
}

const TOTALS = {
  pnl: [
    { key: 'gross_profit', label: 'Gross Profit', kind: 'subtotal' },
    { key: 'operating_income', label: 'Operating Income', kind: 'subtotal' },
    { key: 'net_income', label: 'Net Income', kind: 'grand', tone: true },
  ],
  'balance-sheet': [{ key: 'liabilities_and_equity', label: 'Total Liabilities and Equity', kind: 'grand' }],
};

/**
 * Read the ledger for one config. Returns
 *   { config, def, org, generatedAt, mode, columns, rows }
 * columns: [{ key, label, type: 'amount'|'variance'|'pct'|'date', drill? }]
 *   drill = { from, to, book } - the window an amount in that column opens.
 * rows: [{ kind: 'section'|'account'|'subtotal'|'grand'|'warn', label?, code?,
 *          title?, section?, count?, tone?, values: [...] }]
 *   values line up with columns; a variance is a number, a pct is text.
 */
export async function runReport(api, config) {
  const def = reportDef(config.report);
  const current = def.period === 'asof' ? { asof: config.asof } : { from: config.from, to: config.to };
  const prior = priorRangeOf(config);
  const both = canPickBook(config) && config.book === 'both';
  const book = both || config.book === 'both' ? 'accrual' : config.book;
  const [a, b] = await Promise.all([
    fetchStatement(api, config, current, book),
    both ? fetchStatement(api, config, current, 'cash') : prior ? fetchStatement(api, config, prior, book) : Promise.resolve(null),
  ]);
  const mode = both ? 'books' : prior ? 'compare' : 'single';
  const drillCur = { from: def.period === 'asof' ? '' : config.from, to: def.period === 'asof' ? config.asof : config.to, book };
  const drillOther = both ? { ...drillCur, book: 'cash' } : prior ? { from: prior.asof ? '' : prior.from, to: prior.asof || prior.to, book } : null;
  const curLabel = both ? 'Accrual' : def.period === 'asof' ? `As of ${formatDate(config.asof)}` : config.preset === 'ytd' ? 'YTD Actual' : `${formatDate(config.from)} - ${formatDate(config.to)}`;
  const otherLabel = both ? 'Cash' : prior ? rangeLabel(prior) : '';
  const base = { config, def, org: a?.org || '', generatedAt: a?.generated_at || '', mode, otherLabel };

  if (config.report === 'cash-position') {
    const rows = (a.accounts || []).map((x) => ({ kind: 'account', code: x.gl_code, title: x.account_name, values: [x.balance, x.last_activity ? formatDate(x.last_activity) : ''] }));
    rows.push({ kind: 'grand', label: `Total Cash as of ${formatDate(config.asof)}`, tone: true, values: [a.total, ''] });
    return { ...base, mode: 'single', columns: [{ key: 'balance', label: 'Balance', type: 'amount', drill: { ...drillCur, book: 'accrual' } }, { key: 'last', label: 'Last Activity', type: 'date' }], rows };
  }

  if (config.report === 'trial-balance') {
    const cash = new Map((b?.rows || []).map((r) => [r.account_no, r]));
    const codes = [...new Set([...(a.rows || []).map((r) => r.account_no), ...cash.keys()])].sort((x, y) => x.localeCompare(y, 'en-US', { numeric: true }));
    const byCode = new Map((a.rows || []).map((r) => [r.account_no, r]));
    const rows = codes.map((code) => {
      const r = byCode.get(code);
      const c = cash.get(code);
      return { kind: 'account', code, title: (r || c).title, values: [r?.opening || 0, r?.debit || 0, r?.credit || 0, r?.closing || 0, ...(both ? [c?.closing || 0] : [])] };
    });
    rows.push({ kind: 'grand', label: 'Total', values: [a.totals.opening, a.totals.debit, a.totals.credit, a.totals.closing, ...(both ? [b.totals.closing] : [])] });
    const columns = ['Opening', 'Debit', 'Credit', 'Closing'].map((label, i) => ({ key: label.toLowerCase(), label: both && i === 3 ? 'Closing (Accrual)' : label, type: 'amount', drill: drillCur }));
    if (both) columns.push({ key: 'cash-closing', label: 'Closing (Cash)', type: 'amount', drill: drillOther });
    return { ...base, columns, rows };
  }

  // Income statement and balance sheet: sections of accounts, then the totals.
  const columns = [{ key: 'cur', label: curLabel, type: 'amount', drill: drillCur }];
  if (mode !== 'single') columns.push({ key: 'other', label: otherLabel, type: 'amount', drill: drillOther });
  if (mode === 'compare') columns.push({ key: 'var', label: '$ Variance', type: 'variance' }, { key: 'pct', label: '% Variance', type: 'pct' });
  const vals = (x, y) => (mode === 'single' ? [x] : mode === 'books' ? [x, y] : [x, y, round2(x - y), pct(x, y)]);
  const rows = [];
  mergeSections(a, mode === 'single' ? null : b).forEach((s) => {
    if (!s.accounts.length && !s.a && !s.b) return;
    rows.push({ kind: 'section', section: s.key, label: s.label, count: s.accounts.length, values: vals(s.a, s.b) });
    s.accounts.forEach((x) => rows.push({ kind: 'account', section: s.key, code: x.code, title: x.title, values: vals(x.a, x.b) }));
  });
  (TOTALS[config.report] || []).forEach((t) => rows.push({ kind: t.kind, label: t.label, tone: t.tone, values: vals(a.totals?.[t.key] || 0, b?.totals?.[t.key] || 0) }));
  if (config.report === 'balance-sheet' && Math.abs(a.totals?.difference || 0) >= 0.01) {
    rows.push({ kind: 'warn', label: 'Out of balance by', values: vals(a.totals.difference, b?.totals?.difference || 0) });
  }
  return { ...base, columns, rows };
}

// The table as it is shown, for the CSV: one header row, then every row.
export function csvRows(result, entities = []) {
  const { config, def, columns } = result;
  const out = [[def.label], [entityText(config, entities)], [periodText(config)], [`Book: ${bookLabel(config.book)}`], [], ['Section', 'Account', 'Title', ...columns.map((c) => c.label)]];
  // A section's total follows its accounts, the way the statement reads.
  let open = null;
  const close = () => { if (open) { out.push([`Total ${open.label}`, '', '', ...open.values]); open = null; } };
  result.rows.forEach((r) => {
    if (r.kind === 'section') { close(); open = r; return; }
    if (r.kind === 'account') { out.push([open ? open.label : '', r.code, r.title, ...r.values]); return; }
    close();
    out.push([r.label, '', '', ...r.values]);
  });
  close();
  const filters = dimsText(config);
  if (filters.length) out.push([], ['Filters', filters.join('; ')]);
  return out;
}

export function csvFileName(result) {
  const { config, def } = result;
  const stamp = def.period === 'asof' ? config.asof : `${config.from}_${config.to}`;
  const who = config.entities.length === 1 ? config.entities[0] : config.entities.length ? 'entities' : 'all-entities';
  return `${def.label.replace(/[^A-Za-z]+/g, '-')}_${who}_${config.book}_${stamp}.csv`;
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function downloadCsv(name, rows) {
  const text = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  downloadBlob(name, new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
}

export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
