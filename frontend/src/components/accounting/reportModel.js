import { formatDate } from '../../lib/datetime';

// The logic behind Accounting -> Reports, free of React so the screen, the CSV
// export and the reporting-package PDF all read a statement the same way.
//
// A report is described by a CONFIG (what a memorized report stores): which
// statement, the period, the columns, the book, the entities, the dimension
// filters, the accounts. runReport(api, config) reads the ledger and returns
// one RESULT: columns plus flat rows (section, account, total), ready to draw.
//
// Sep 29 (Visesh, from the 09/25 call): the controls are the ones the
// accounting app's Reports page has - the period stepper with its named
// periods, Columns (Total Only, By Month, By Quarter, By Entity, By Vendor ...
// vs Prior Year), entities, departments, the other dimensions, accounts - so a
// statement set up in one place can be set up the same way in the other.

export const REPORTS = [
  { key: 'pnl', label: 'Income Statement', period: 'range' },
  { key: 'balance-sheet', label: 'Balance Sheet', period: 'asof' },
  { key: 'trial-balance', label: 'Trial Balance', period: 'range' },
  { key: 'general-ledger', label: 'General Ledger', period: 'range' },
  { key: 'cash-position', label: 'Cash Position', period: 'asof' },
  // Flux Analysis (Neil, 10/02 - the first cut of MRE, pending the talk with
  // Charmi): this period against the one before it, per income statement
  // account, with the variance over a threshold flagged and an explanation
  // kept per account and period (accounting_flux_notes).
  { key: 'flux', label: 'Flux Analysis', period: 'range' },
  // Statement of Cash Flows (Charmi's Friday list, item 26c, 10/07): the
  // indirect method, v1 - net income, the non-cash add-backs, the working
  // capital moves between two balance sheets, investing and financing; the
  // ending cash ties to Cash Position. Mapping by account type and title.
  { key: 'cash-flow', label: 'Statement of Cash Flows', period: 'range' },
];
/** The flag thresholds a Flux Analysis starts with: both must be passed for a line to be flagged. */
export const FLUX_DEFAULTS = { fluxPct: 10, fluxAmount: 5000 };
/** The General Ledger lists lines for at most this many accounts at once; more than that, it lists the accounts only. */
export const GL_MAX_ACCOUNTS = 25;
const GL_MAX_LINES = 1000;
export const reportDef = (key) => REPORTS.find((r) => r.key === key) || REPORTS[0];

// The named periods, as the accounting app lists them. "This Month" is the
// whole month; "Month-to-Date" stops today.
export const PRESETS = [
  { key: 'this-month', label: 'This Month' },
  { key: 'last-month', label: 'Last Month' },
  { key: 'mtd', label: 'Month-to-Date' },
  { key: 'this-quarter', label: 'This Quarter' },
  { key: 'last-quarter', label: 'Last Quarter' },
  { key: 'qtd', label: 'Quarter-to-Date' },
  { key: 'this-year', label: 'This Year' },
  { key: 'ytd', label: 'Year-to-Date' },
  { key: 'last-year', label: 'Last Year' },
  { key: 't12m', label: 'Trailing 12 Months' },
  { key: 'custom', label: 'Custom' },
];
const LEGACY_PRESET = { month: 'mtd', quarter: 'qtd' };
export const presetLabel = (key) => PRESETS.find((p) => p.key === key)?.label || 'Custom';

// Column layouts. An income statement splits its range; a balance sheet is a
// date, so its period columns are a run of month-ends or quarter-ends.
const PNL_COLUMNS = [
  ['total', 'Total Only'], ['month', 'By Month'], ['quarter', 'By Quarter'], ['year', 'By Year'], ['entity', 'By Entity'],
  ['department', 'By Department'], ['vendor', 'By Vendor'], ['customer', 'By Customer'], ['employee', 'By Employee'],
  ['project', 'By Project-Job'], ['item', 'By Item'], ['prior_period', 'vs Prior Period'], ['prior_year', 'vs Prior Year'],
  // Item 43 (Charmi, 10/02): Actual, Budget, Variance $ and Variance % - the
  // Intacct budget, or the budget saved in Nexus (labeled so) until there is one.
  ['budget', 'Actual vs Budget'],
];
const BS_COLUMNS = [
  ['total', 'Total Only'], ['entity', 'By Entity'], ['department', 'By Department'], ['month', 'Last 12 Month-Ends'],
  ['quarter', 'Last 4 Quarter-Ends'], ['prior_month', 'vs Prior Month-End'], ['prior_year', 'vs Same Date Last Year'], ['year_end', 'vs Last Year-End'],
];
const FLUX_COLUMNS = [['prior_period', 'vs Prior Period'], ['prior_year', 'vs Prior Year']];
const pair = (rows) => rows.map(([key, label]) => ({ key, label }));
// Which filter a column layout splits by, for "(2 picked)" on its label.
const MODE_PICKS = { department: 'departments', vendor: 'vendor', customer: 'customer', employee: 'employee', project: 'project', item: 'item' };
/**
 * The column layouts a report offers. With `config`, a layout whose filter
 * holds two or more picks says so - "By Employee (2 picked)" (Charmi, 10/02:
 * two employees picked must be two columns, not one combined figure).
 */
export function columnModes(report, config = null) {
  const base = report === 'pnl' ? pair(PNL_COLUMNS) : report === 'balance-sheet' ? pair(BS_COLUMNS) : report === 'flux' ? pair(FLUX_COLUMNS) : pair([['total', 'Total Only']]);
  if (!config) return base;
  return base.map((m) => {
    const n = m.key === 'entity' ? (config.entities || []).length : (config.dims?.[MODE_PICKS[m.key]] || []).length;
    return n >= 2 ? { ...m, label: `${m.label} (${n} picked)` } : m;
  });
}
/**
 * The layout to switch to when a filter has just grown to two or more picks
 * while the statement is Total Only: one column per picked value. Null when
 * nothing should change ("Total Only" picked on purpose afterwards stays).
 */
export function columnsForPicks(config, dims) {
  if (activeColumns(config) !== 'total') return null;
  const modes = columnModes(config.report);
  const grown = Object.entries(MODE_PICKS).find(([mode, key]) => modes.some((m) => m.key === mode) && (dims?.[key] || []).length >= 2 && (config.dims?.[key] || []).length < 2);
  return grown ? grown[0] : null;
}
const LEGACY_COMPARE = { 'prior-year': 'prior_year', 'prior-period': 'prior_period', 'prior-month': 'prior_month' };
const COMPARE_MODES = ['prior_period', 'prior_year', 'prior_month', 'year_end'];
const DIM_MODES = ['vendor', 'customer', 'employee', 'project', 'item'];
const PERIOD_MODES = ['month', 'quarter', 'year'];
export const isCompare = (m) => COMPARE_MODES.includes(m);
/** A dimension column per code could be thousands of columns; the largest stay, the rest fold into "Other". */
export const MAX_DIM_COLUMNS = 50;

// Accrual, cash, or the two side by side (Neil, Sep 25).
export const BOOKS = [
  { key: 'accrual', label: 'Accrual' },
  { key: 'cash', label: 'Cash' },
  { key: 'both', label: 'Accrual and Cash' },
];
// Oct 7 (Charmi, item 35): Intacct's user-defined books ("Fair Market
// Journal", "KJECA - Greens Global") - accrual plus their own journals - as
// the accounting app lists them (GET /accounting/books). Until it does, the
// selector keeps Accrual / Cash / both. A memorized report keeps its book key.
const BOOK_KEY = /^[a-z0-9_-]{1,24}$/;
let userBooks = [];
/** A user-defined book key (fmv, kje ...): not accrual, cash or the two side by side. */
export const isUserBook = (b) => typeof b === 'string' && BOOK_KEY.test(b) && !BOOKS.some((x) => x.key === b);
/** The books the accounting app lists ([{ key, label }]); standard ones are left to BOOKS. */
export function setUserBooks(list) {
  userBooks = (Array.isArray(list) ? list : []).filter((b) => b && isUserBook(String(b.key || '').toLowerCase()))
    .map((b) => ({ key: String(b.key).toLowerCase(), label: String(b.label || b.key).trim() || String(b.key).toUpperCase() }));
}
/** The Book selector's options: Accrual, Cash, the user books, then Accrual and Cash. */
export const bookOptions = () => [BOOKS[0], BOOKS[1], ...userBooks, BOOKS[2]];
export const bookLabel = (key) => BOOKS.find((b) => b.key === key)?.label || userBooks.find((b) => b.key === key)?.label || (isUserBook(key) ? key.toUpperCase() : 'Accrual');

// The dimensions a report can be narrowed by, in the order Charmi listed
// them. Entities have their own dropdown; every other dimension, department
// included, sits behind "Filters" (Charmi, 09/29 call). All list the codes
// that actually appear on the ledger.
export const DIM_KINDS = [
  { key: 'departments', kind: 'department', label: 'Department', plural: 'departments' },
  { key: 'vendor', kind: 'vendor', label: 'Vendor', plural: 'vendors' },
  { key: 'customer', kind: 'customer', label: 'Customer', plural: 'customers' },
  { key: 'employee', kind: 'employee', label: 'Employee', plural: 'employees' },
  { key: 'project', kind: 'project', label: 'Project-Job', plural: 'Project-Jobs' },
  { key: 'item', kind: 'item', label: 'Item', plural: 'items' },
  // Journals (Neil, 10/02): AP, AR, payroll, user defined and statistical
  // journals, by symbol. Listed by the accounting app (GET /accounting/
  // journals); a statistical journal never adds into money totals.
  { key: 'journals', kind: 'journal', label: 'Journals', one: 'Journal', plural: 'journals' },
];
/** The kinds behind the Filters button: all of them since 09/30 (department used to have its own dropdown). */
export const POPOVER_DIMS = DIM_KINDS;
export const EMPTY_DIMS = { departments: [], vendor: [], customer: [], employee: [], project: [], item: [], journals: [] };
/** How the journal kinds read as headings in the Journals list, in the order they are listed. */
export const JOURNAL_KINDS = { general: 'General', ap: 'Payables (AP)', ar: 'Receivables (AR)', payroll: 'Payroll', user: 'User Defined', statistical: 'Statistical' };
export const countDims = (d) => POPOVER_DIMS.reduce((n, k) => n + ((d?.[k.key] || []).length ? 1 : 0), 0);

// Historical classes carry "(H)" in their Intacct name (Charmi, Sep 25).
// They stay on the ledger and in every total; pickers leave them out unless
// one is already part of the selection.
export const isHistorical = (name) => /\(\s*H\s*\)/i.test(name || '');
/** A historical entity: "(H)" in its name or an H before its number (H12001). Off by default since 09/30; Customize shows them. */
export const isHistoricalEntity = (e) => isHistorical(e?.name) || /^H\d/i.test(e?.code || '');

export const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const parse = (s) => new Date(`${s}T00:00:00`);
export const money = (n) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
};
export const pct = (cur, prev) => {
  if (Math.abs(prev) < 0.005) return '';
  return share(((cur - prev) / Math.abs(prev)));
};
/** 0.198 -> "19.8%", negative in parentheses, not-a-number -> "". */
export function share(v) {
  if (!Number.isFinite(v)) return '';
  const p = v * 100;
  return `${p < 0 ? '(' : ''}${Math.abs(p).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%${p < 0 ? ')' : ''}`;
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const endOfMonth = (y, m) => new Date(y, m + 1, 0);
const isMonthStart = (s) => s.slice(8, 10) === '01';
const isMonthEnd = (s) => { const d = parse(s); return endOfMonth(d.getFullYear(), d.getMonth()).getDate() === d.getDate(); };

export function presetRange(key, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const q = Math.floor(m / 3) * 3;
  const today = new Date(y, m, now.getDate());
  switch (LEGACY_PRESET[key] || key) {
    case 'this-month': return [new Date(y, m, 1), endOfMonth(y, m)];
    case 'mtd': return [new Date(y, m, 1), today];
    case 'last-month': return [new Date(y, m - 1, 1), new Date(y, m, 0)];
    case 'this-quarter': return [new Date(y, q, 1), new Date(y, q + 3, 0)];
    case 'qtd': return [new Date(y, q, 1), today];
    case 'last-quarter': return [new Date(y, q - 3, 1), new Date(y, q, 0)];
    case 'this-year': return [new Date(y, 0, 1), new Date(y, 11, 31)];
    case 'last-year': return [new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)];
    case 't12m': return [new Date(y - 1, m, now.getDate() + 1), today];
    default: return [new Date(y, 0, 1), today];
  }
}

// The arrows of the period stepper: the period before or after the one on
// screen. A month steps by a month, a quarter by a quarter, a year by a year;
// anything else slides by its own length. The answer is always a custom range.
export function stepRange(preset, from, to, dir) {
  const f = parse(from);
  const t = parse(to);
  const kind = LEGACY_PRESET[preset] || preset;
  if (['this-month', 'last-month', 'mtd'].includes(kind)) return [iso(new Date(f.getFullYear(), f.getMonth() + dir, 1)), iso(endOfMonth(f.getFullYear(), f.getMonth() + dir))];
  if (['this-quarter', 'last-quarter', 'qtd'].includes(kind)) {
    const q = Math.floor(f.getMonth() / 3) * 3 + dir * 3;
    return [iso(new Date(f.getFullYear(), q, 1)), iso(new Date(f.getFullYear(), q + 3, 0))];
  }
  if (['this-year', 'last-year', 'ytd'].includes(kind)) return [iso(new Date(f.getFullYear() + dir, 0, 1)), iso(new Date(f.getFullYear() + dir, 11, 31))];
  if (kind === 't12m') return [iso(new Date(f.getFullYear() + dir, f.getMonth(), f.getDate())), iso(new Date(t.getFullYear() + dir, t.getMonth(), t.getDate()))];
  if (isMonthStart(from) && isMonthEnd(to)) {
    const months = (t.getFullYear() - f.getFullYear()) * 12 + (t.getMonth() - f.getMonth()) + 1;
    return [iso(new Date(f.getFullYear(), f.getMonth() + dir * months, 1)), iso(endOfMonth(t.getFullYear(), t.getMonth() + dir * months))];
  }
  const days = Math.max(1, Math.round((t - f) / 86_400_000) + 1);
  return [iso(new Date(f.getTime() + dir * days * 86_400_000)), iso(new Date(t.getTime() + dir * days * 86_400_000))];
}

// The arrows beside an as-of date: the month-end before, the month-end after.
export function stepAsOf(asof, dir) {
  const d = parse(asof);
  if (dir < 0) return iso(endOfMonth(d.getFullYear(), d.getMonth() - 1));
  return iso(endOfMonth(d.getFullYear(), d.getMonth() + (isMonthEnd(asof) ? 1 : 0)));
}

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
const lastYearEnd = (s) => `${Number(s.slice(0, 4)) - 1}-12-31`;
const dayBefore = (s) => { const d = parse(s); d.setDate(d.getDate() - 1); return iso(d); };
const earlier = (a, b) => (a < b ? a : b);

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function defaultConfig(now = new Date()) {
  const [f, t] = presetRange('ytd', now).map(iso);
  return { report: 'pnl', preset: 'ytd', from: f, to: t, asof: iso(now), asofToday: true, book: 'accrual', cols: 'total', entities: [], dims: { ...EMPTY_DIMS }, accounts: [], showZero: false, ...FLUX_DEFAULTS };
}

// A config as it should run TODAY: a named period ("Year-to-Date") moves with
// the calendar, so a report memorized in September still ends today when it
// is opened in October; custom dates stay as they were saved.
export function resolveConfig(config, now = new Date()) {
  const base = defaultConfig(now);
  const c = { ...base, ...(config || {}) };
  c.report = reportDef(c.report).key;
  c.preset = LEGACY_PRESET[c.preset] || c.preset;
  c.preset = PRESETS.some((p) => p.key === c.preset) ? c.preset : 'ytd';
  if (c.preset !== 'custom' || !ISO.test(c.from || '') || !ISO.test(c.to || '')) {
    if (c.preset === 'custom') c.preset = 'ytd';
    [c.from, c.to] = presetRange(c.preset, now).map(iso);
  }
  if (c.from > c.to) c.to = c.from;
  if (c.asofToday !== false || !ISO.test(c.asof || '')) { c.asof = iso(now); c.asofToday = c.asofToday !== false; }
  c.book = BOOKS.some((b) => b.key === c.book) || userBooks.some((b) => b.key === c.book) ? c.book : 'accrual';
  c.entities = Array.isArray(c.entities) ? c.entities.filter((x) => typeof x === 'string' && x) : [];
  c.accounts = Array.isArray(c.accounts) ? c.accounts.filter((x) => typeof x === 'string' && x) : [];
  // Zero balances are hidden unless asked for (Charmi, 09/29 call: "the
  // option should read Show"). A view memorized before then kept the
  // opposite flag; either way the accounts with nothing in them stay off
  // until Show is ticked.
  c.showZero = !!c.showZero;
  delete c.suppressZero;
  c.dims = { ...EMPTY_DIMS, ...Object.fromEntries(DIM_KINDS.map((k) => [k.key, Array.isArray(c.dims?.[k.key]) ? c.dims[k.key] : []])) };
  // A view memorized before Columns existed kept its comparison under `compare`.
  if (!config?.cols && LEGACY_COMPARE[c.compare]) c.cols = LEGACY_COMPARE[c.compare];
  delete c.compare;
  const modes = columnModes(c.report);
  c.cols = modes.some((m) => m.key === c.cols) ? c.cols : modes[0].key;
  // Flux thresholds: a number each, never below zero.
  c.fluxPct = Number.isFinite(Number(c.fluxPct)) && Number(c.fluxPct) >= 0 ? Number(c.fluxPct) : FLUX_DEFAULTS.fluxPct;
  c.fluxAmount = Number.isFinite(Number(c.fluxAmount)) && Number(c.fluxAmount) >= 0 ? Number(c.fluxAmount) : FLUX_DEFAULTS.fluxAmount;
  return c;
}

/** The layout in force: two books side by side leave no room for columns. */
export const activeColumns = (config) => (config.book === 'both' && canPickBook(config) ? 'total' : config.cols);
// The Statement of Cash Flows ties to Cash Position, which reads the accrual
// book for whole entities - so neither a book nor the dimension filters apply.
export const canPickBook = (config) => config.report !== 'cash-position' && config.report !== 'cash-flow';
export const canUseDims = (config) => config.report !== 'cash-position' && config.report !== 'cash-flow';
export const canPickAccounts = (config) => ['pnl', 'balance-sheet', 'general-ledger', 'flux'].includes(config.report);

export const periodText = (config) => {
  const def = reportDef(config.report);
  if (def.period === 'asof') return `As of ${formatDate(config.asof)}`;
  return `${presetLabel(config.preset)} · ${formatDate(config.from)} - ${formatDate(config.to)}`;
};

export function entityText(config, entities = []) {
  if (!config.entities.length) return 'All entities';
  if (config.entities.length > 1) return `${config.entities.length} entities`;
  const e = entities.find((x) => x.code === config.entities[0]);
  return e?.name ? `${e.name} (${e.code})` : config.entities[0];
}
/**
 * Every filter in force, one entry each, for the chips under the report title
 * (Charmi, 09/29 call: the active filters must be visible and come off in one
 * click). `names`: { department: {code: name}, vendor: {...}, ... } when known.
 * Each chip carries the config patch that removes it.
 */
export function filterChips(config, entities = [], names = {}) {
  const out = [];
  config.entities.forEach((code) => {
    const e = entities.find((x) => x.code === code);
    out.push({ key: `entity:${code}`, label: `Entity: ${e?.name ? `${e.name} (${code})` : code}`, patch: { entities: config.entities.filter((c) => c !== code) } });
  });
  DIM_KINDS.forEach((k) => {
    (config.dims[k.key] || []).forEach((code) => {
      const name = names[k.kind]?.[code];
      out.push({ key: `${k.key}:${code}`, label: `${k.one || k.label}: ${name ? `${name} (${code})` : code}`, patch: { dims: { ...config.dims, [k.key]: config.dims[k.key].filter((c) => c !== code) } } });
    });
  });
  (config.accounts || []).forEach((code) => {
    out.push({ key: `account:${code}`, label: `Account: ${code}`, patch: { accounts: config.accounts.filter((c) => c !== code) } });
  });
  return out;
}
export function dimsText(config) {
  const out = DIM_KINDS.filter((k) => (config.dims[k.key] || []).length)
    .map((k) => (config.dims[k.key].length === 1 ? `${k.one || k.label} ${config.dims[k.key][0]}` : `${config.dims[k.key].length} ${k.plural}`));
  if (config.accounts?.length) out.push(`${config.accounts.length} ${config.accounts.length === 1 ? 'account' : 'accounts'}`);
  return out;
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

// A user-defined book (fmv, kje ...) goes through the generic report read,
// which passes `book` as it is; accrual and cash keep their own calls.
const flatDims = (dims) => Object.fromEntries(Object.entries(dims || {}).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => [k, v.join(',')]));
const viaUserBook = (api, book) => isUserBook(book) && typeof api.readAccountingReport === 'function';
function readTrialBalance(api, from, to, location, dims, book) {
  if (viaUserBook(api, book)) return api.readAccountingReport('trial-balance', { from, to, location, ...flatDims(dims), book });
  return api.getAccountingTrialBalance(from, to, location, dims, book);
}
function fetchStatement(api, config, range, book) {
  const { location, dims } = placeOf(config);
  if (config.report === 'cash-position') return api.getAccountingCashPosition(range.asof, location, config.entities.length > 1 ? config.entities : undefined);
  if (viaUserBook(api, book)) {
    if (config.report === 'pnl') return api.readAccountingReport('pnl', { from: range.from, to: range.to, location, ...flatDims(dims), book });
    if (config.report === 'balance-sheet') return api.readAccountingReport('balance-sheet', { asof: range.asof, location, ...flatDims(dims), book });
  }
  if (config.report === 'pnl') return api.getAccountingPnl(range.from, range.to, location, dims, book);
  if (config.report === 'balance-sheet') return api.getAccountingBalanceSheet(range.asof, location, dims, book);
  return readTrialBalance(api, range.from, range.to, location, dims, book);
}
function fetchBuckets(api, config, range, by, book, entities = []) {
  // One entity picked and split By Entity: its sub-entities are the columns
  // (the entity itself keeps a column for what is posted straight to it).
  // Several entities picked: one column each (the accounting service puts
  // every line under the nearest picked entity above it, 09/30).
  let cfg = config;
  if (by === 'entity' && config.entities.length === 1) {
    const kids = entities.filter((e) => e.parent_code === config.entities[0] && !isHistoricalEntity(e)).map((e) => e.code);
    if (kids.length) cfg = { ...config, entities: [config.entities[0], ...kids] };
  }
  const { location, dims } = placeOf(cfg);
  if (viaUserBook(api, book)) return api.readAccountingReport('buckets', { from: range.from, to: range.to, by, location, ...flatDims(dims), book });
  return api.getAccountingBuckets({ from: range.from, to: range.to, by, book, location, dims });
}

// ── What a statement is made of ──────────────────────────────────────────────
const SECTIONS = {
  pnl: [['revenue', 'Revenue'], ['cogs', 'Cost of Sales'], ['expense', 'Operating Expenses'], ['other_income', 'Other Income'], ['other_expense', 'Other Expenses']],
  'balance-sheet': [['asset', 'Assets'], ['liability', 'Liabilities'], ['equity', 'Equity']],
};
const PL_KEYS = SECTIONS.pnl.map(([k]) => k);
const CREDIT_SIDE = new Set(['revenue', 'other_income', 'liability', 'equity']);
const signed = (section, debit, credit) => (CREDIT_SIDE.has(section) ? credit - debit : debit - credit);
const keyOf = (a) => a.account_no || `~${a.title}`;

const monthLabel = (key) => parse(key).toLocaleString('en-US', { month: 'short', year: 'numeric' });
const NONE = { entity: 'No Entity', department: 'No Department', vendor: 'No Vendor', customer: 'No Customer', employee: 'No Employee', project: 'No Project-Job', item: 'No Item' };
function bucketLabel(mode, key, labels) {
  if (mode === 'month') return monthLabel(key);
  if (mode === 'quarter') { const d = parse(key); return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`; }
  if (mode === 'year') return key.slice(0, 4);
  return key ? labels?.[key] || key : NONE[mode];
}
// Period columns run latest-first, so this month is the first column (Urmi,
// Sep 17); the rest read alphabetically with "No Vendor" last.
function sortKeys(mode, keys, labels) {
  if (PERIOD_MODES.includes(mode)) return [...keys].sort().reverse();
  return [...keys].sort((a, b) => (!a ? 1 : !b ? -1 : bucketLabel(mode, a, labels).localeCompare(bucketLabel(mode, b, labels), 'en-US', { numeric: true })));
}
// The window an amount in one bucket column opens.
function bucketDrill(mode, key, range, book, labels) {
  const base = { from: range.from || '', to: range.to, book };
  if (PERIOD_MODES.includes(mode)) {
    const d = parse(key);
    const span = mode === 'month' ? 1 : mode === 'quarter' ? 3 : 12;
    const end = iso(endOfMonth(d.getFullYear(), d.getMonth() + span - 1));
    return { ...base, from: range.from && range.from > key ? range.from : key, to: end < range.to ? end : range.to };
  }
  // A column the line search cannot narrow to (no code, a Project-Job, an item)
  // does not drill: the whole account's lines would pass for that column's.
  if (!key) return null;
  if (mode === 'entity') return { ...base, entity: key };
  if (mode === 'department') return { ...base, department: key };
  if (['vendor', 'customer', 'employee'].includes(mode)) return { ...base, party: { kind: mode, code: key, name: labels?.[key] || key } };
  return null;
}

// Bucket rows ([{account_no, title, section, bucket, debit, credit}]) as one
// statement per column key.
function statementsByBucket(rows, sectionKeys) {
  const out = new Map();
  rows.forEach((r) => {
    if (!sectionKeys.includes(r.section)) return;
    const st = out.get(r.bucket) || new Map();
    const sec = st.get(r.section) || [];
    sec.push({ account_no: r.account_no, title: r.title, amount: round2(signed(r.section, r.debit, r.credit)) });
    st.set(r.section, sec);
    out.set(r.bucket, st);
  });
  return out;
}
const asSections = (report, bySection) => SECTIONS[report].map(([key, label]) => ({ key, label, accounts: bySection?.get(key) || [] }));

// A dimension column per code can be thousands of columns. Keep the largest
// by activity and fold the rest into one "Other" bucket.
function foldBuckets(mode, rows) {
  const keys = [...new Set(rows.map((r) => r.bucket))];
  if (!DIM_MODES.includes(mode) || keys.length <= MAX_DIM_COLUMNS) return { rows, folded: 0 };
  const size = new Map();
  rows.forEach((r) => size.set(r.bucket, (size.get(r.bucket) || 0) + Math.abs(r.debit - r.credit)));
  const keep = new Set([...size.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DIM_COLUMNS).map(([k]) => k));
  return { rows: rows.map((r) => (keep.has(r.bucket) ? r : { ...r, bucket: OTHER })), folded: keys.length - keep.size };
}
const OTHER = '\u0000other';

// Net of the income statement accounts in a set of bucket rows, per bucket:
// what a balance sheet carries into equity as earnings.
function earningsByBucket(rows) {
  const out = new Map();
  rows.forEach((r) => {
    if (!PL_KEYS.includes(r.section)) return;
    const v = r.section === 'revenue' || r.section === 'other_income' ? r.credit - r.debit : -(r.debit - r.credit);
    out.set(r.bucket, round2((out.get(r.bucket) || 0) + v));
  });
  return out;
}

// A balance sheet as of a date, from month-by-month activity since the books
// began (bucket = the month's first day). The same statement the accounting
// service builds for one date: balances are everything up to the date, the
// profit of the years before sits on Retained Earnings, this year's is its
// own line, and an account with nothing on that date is left out.
export function balanceAsOf(rows, asof) {
  const upTo = asof.slice(0, 7);
  const thisYear = `${asof.slice(0, 4)}-01`;
  const accounts = new Map();
  let all = 0;
  let prior = 0;
  rows.forEach((r) => {
    const month = (r.bucket || '').slice(0, 7);
    if (!month || month > upTo) return;
    if (PL_KEYS.includes(r.section)) {
      const v = r.section === 'revenue' || r.section === 'other_income' ? r.credit - r.debit : -(r.debit - r.credit);
      all += v;
      if (month < thisYear) prior += v;
      return;
    }
    if (!SECTIONS['balance-sheet'].some(([k]) => k === r.section)) return;
    const cur = accounts.get(r.account_no) || { section: r.section, account_no: r.account_no, title: r.title, amount: 0 };
    cur.amount += signed(r.section, r.debit, r.credit);
    accounts.set(r.account_no, cur);
  });
  const was = round2(prior);
  const list = (key) => [...accounts.values()].filter((a) => a.section === key)
    .map((a) => ({ account_no: a.account_no, title: a.title, amount: round2(a.amount) }));
  const retained = [...accounts.values()].find((a) => a.section === 'equity' && /retained\s+earnings/i.test(a.title));
  let equity = list('equity').map((a) => (retained && a.account_no === retained.account_no ? { ...a, amount: round2(a.amount + was) } : a));
  equity = equity.filter((a) => a.amount !== 0 || (retained && a.account_no === retained.account_no && round2(retained.amount) !== 0));
  if (!retained) equity.push({ account_no: '', title: 'Retained earnings (prior years)', amount: was });
  equity.push({ account_no: '', title: `Current year earnings (${asof.slice(0, 4)})`, amount: round2(round2(all) - was) });
  const nonZero = (a) => a.amount !== 0;
  return [
    { key: 'asset', label: 'Assets', accounts: list('asset').filter(nonZero) },
    { key: 'liability', label: 'Liabilities', accounts: list('liability').filter(nonZero) },
    { key: 'equity', label: 'Equity', accounts: equity },
  ];
}

// ── The budget beside the actuals (item 43) ──────────────────────────────────
// The Intacct budget, as the accounting app pulls it, for the period and the
// entities on the report (GET /accounting/reports/budget); until the app has
// one, the budget saved in Nexus for the one picked entity, labeled
// "Budget (Nexus)". A month counts in full when the period covers part of it.
async function readBudget(api, config) {
  const bySection = new Map();
  const add = (section, code, title, amount) => {
    if (!PL_KEYS.includes(section) || !Number.isFinite(Number(amount))) return;
    const list = bySection.get(section) || [];
    const at = list.find((a) => a.account_no === code);
    if (at) at.amount = round2(at.amount + Number(amount));
    else list.push({ account_no: code || '', title: title || code || '', amount: round2(amount) });
    bySection.set(section, list);
  };
  const partial = !isMonthStart(config.from) || !isMonthEnd(config.to) ? ' Months the period covers in part count in full.' : '';
  const location = config.entities.length === 1 ? config.entities[0] : undefined;
  try {
    if (typeof api.getAccountingReportBudget === 'function') {
      const d = await api.getAccountingReportBudget({ from: config.from, to: config.to, location, locations: config.entities.length > 1 ? config.entities : undefined });
      if (d && d.available !== false && (d.rows || []).length) {
        d.rows.forEach((r) => add(r.section, r.account_no, r.title, r.amount));
        return { label: 'Budget', sections: asSections('pnl', bySection), note: `Budget: ${d.budget_id ? `Intacct budget ${d.budget_id}` : 'the Intacct budget'}.${partial}` };
      }
    }
  } catch { /* no Intacct budget yet: the one saved in Nexus below */ }
  if (!location) {
    return { label: 'Budget (Nexus)', sections: asSections('pnl', null), note: 'No Intacct budget for this selection yet, and a budget saved in Nexus is kept per entity - pick one entity to compare with it.' };
  }
  let any = false;
  for (let y = Number(config.from.slice(0, 4)); y <= Number(config.to.slice(0, 4)); y += 1) {
    const d = await api.getAccountingBudget(location, y).catch(() => null);
    if (!d || d.source === 'none') continue;
    (d.rows || []).forEach((r) => (r.months || []).forEach((v, m) => {
      const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const end = iso(endOfMonth(y, m));
      if (start > config.to || end < config.from || !Number(v)) return;
      any = true;
      add(r.section, r.accountNo, r.title, v);
    }));
  }
  return { label: 'Budget (Nexus)', sections: asSections('pnl', bySection), note: any ? `Budget: saved in Nexus - no Intacct budget yet.${partial}` : 'No budget is saved for this entity and period yet (Accounting > Budget).' };
}

// ── Reading the ledger ───────────────────────────────────────────────────────
async function readColumns(api, config, entities = []) {
  const { report } = config;
  const both = config.book === 'both';
  const book = both ? 'accrual' : config.book;
  const mode = activeColumns(config);
  const isBs = report === 'balance-sheet';
  const range = isBs ? { asof: config.asof } : { from: config.from, to: config.to };
  const drillOf = (r, b = book) => ({ from: r.asof ? '' : r.from, to: r.asof || r.to, book: b });
  const rangeText = (r) => (r.asof ? `As of ${formatDate(r.asof)}` : `${formatDate(r.from)} - ${formatDate(r.to)}`);
  const one = async (r, label, b = book, key = label) => {
    const s = await fetchStatement(api, config, r, b);
    return { key, label, drill: drillOf(r, b), sections: s.sections || [], org: s.org, generatedAt: s.generated_at };
  };

  if (both) {
    const cols = await Promise.all([one(range, 'Accrual', 'accrual'), one(range, 'Cash', 'cash')]);
    return { cols, derived: null, mode: 'books' };
  }
  if (mode === 'budget' && !isBs) {
    const [actual, budget] = await Promise.all([one(range, 'Actual', book, 'cur'), readBudget(api, config)]);
    return { cols: [actual, { key: 'budget', label: budget.label, drill: null, sections: budget.sections }], derived: 'compare', mode: 'compare', otherLabel: budget.label, budgetNote: budget.note };
  }
  if (isCompare(mode)) {
    let prior;
    if (isBs) prior = { asof: mode === 'prior_year' ? yearBack(config.asof) : mode === 'year_end' ? lastYearEnd(config.asof) : priorMonthEnd(config.asof) };
    else if (mode === 'prior_year') prior = { from: yearBack(config.from), to: yearBack(config.to) };
    else { const [from, to] = priorPeriod(config.from, config.to); prior = { from, to }; }
    const current = isBs ? rangeText(range) : config.preset === 'ytd' ? 'YTD Actual' : rangeText(range);
    const cols = await Promise.all([one(range, current, book, 'cur'), one(prior, rangeText(prior), book, 'other')]);
    return { cols, derived: 'compare', mode: 'compare', otherLabel: rangeText(prior) };
  }
  if (mode === 'total') {
    const label = isBs ? rangeText(range) : config.preset === 'ytd' ? 'YTD Actual' : rangeText(range);
    return { cols: [await one(range, label, book, 'cur')], derived: null, mode: 'single' };
  }
  if (isBs && PERIOD_MODES.includes(mode)) {
    // A run of month-ends or quarter-ends, the latest first.
    const d = parse(config.asof);
    const dates = [];
    if (mode === 'month') for (let i = 0; i < 12; i += 1) dates.push(earlier(iso(endOfMonth(d.getFullYear(), d.getMonth() - i)), config.asof));
    else { const q = Math.floor(d.getMonth() / 3); for (let i = 0; i < 4; i += 1) dates.push(earlier(iso(endOfMonth(d.getFullYear(), q * 3 + 2 - i * 3)), config.asof)); }
    // TWO reads for every date (Sep 29): where each account stood at the end
    // of the year before the oldest date, and what it did month by month
    // since; the balance on each date is added up here. It used to be a
    // balance sheet per date, all asked for at once - twelve month-ends were
    // 24 reads of the ledger at the same moment, the slowest of them 8.8
    // seconds on production, and with a dimension filter they would not have
    // finished at all. (Every month since the books began, in one read, was
    // no better: 7.6 seconds, nearly all of it carrying months nobody sees.)
    const firstYear = Number(dates[dates.length - 1].slice(0, 4));
    const opening = `${firstYear - 1}-12-31`;
    const [before, since] = await Promise.all([
      fetchBuckets(api, config, { from: undefined, to: opening }, 'total', book),
      fetchBuckets(api, config, { from: `${firstYear}-01-01`, to: config.asof }, 'month', book),
    ]);
    // The opening balances count as one month, the last of that earlier year.
    const rows = [...(before.rows || []).map((r) => ({ ...r, bucket: `${firstYear - 1}-12-01` })), ...(since.rows || [])];
    const cols = dates.map((asof) => ({
      key: asof, label: formatDate(asof), drill: drillOf({ asof }, book), sections: balanceAsOf(rows, asof), org: since.org, generatedAt: since.generated_at,
    }));
    return { cols, derived: null, mode: 'series' };
  }

  // One column per bucket, read in one call (two for a balance sheet, whose
  // equity carries the earnings of the years before and of this year).
  const bucketRange = isBs ? { from: undefined, to: config.asof } : range;
  const fyStart = `${config.asof.slice(0, 4)}-01-01`;
  const [data, before] = await Promise.all([
    fetchBuckets(api, config, bucketRange, mode, book, entities),
    isBs ? fetchBuckets(api, config, { from: undefined, to: dayBefore(fyStart) }, mode, book, entities) : Promise.resolve(null),
  ]);
  // A column per PICKED value (Charmi, 10/02): with two employees picked and
  // By Employee, only those two are columns. The accounting app already
  // narrows to the picked set; this keeps a stray bucket from adding into
  // the Total should it ever send one.
  const pickedKey = MODE_PICKS[mode];
  const picked = DIM_MODES.includes(mode) && (config.dims?.[pickedKey] || []).length ? new Set(config.dims[pickedKey]) : null;
  const { rows, folded } = foldBuckets(mode, (data.rows || []).filter((r) => !picked || picked.has(r.bucket)));
  const labels = data.labels || {};
  const statements = statementsByBucket(rows, SECTIONS[report].map(([k]) => k));
  let keys = [...new Set(rows.filter((r) => (isBs ? true : PL_KEYS.includes(r.section))).map((r) => r.bucket))];
  if (isBs) {
    const total = earningsByBucket(rows);
    const prior = earningsByBucket(foldBuckets(mode, before?.rows || []).rows);
    const retained = (rows.find((r) => r.section === 'equity' && /retained\s+earnings/i.test(r.title)) || null);
    keys.forEach((k) => {
      const st = statements.get(k) || new Map();
      const equity = [...(st.get('equity') || [])];
      const was = prior.get(k) || 0;
      if (retained) {
        const at = equity.findIndex((a) => a.account_no === retained.account_no);
        if (at >= 0) equity[at] = { ...equity[at], amount: round2(equity[at].amount + was) };
        else if (was) equity.push({ account_no: retained.account_no, title: retained.title, amount: was });
      } else {
        equity.push({ account_no: '', title: 'Retained earnings (prior years)', amount: was });
      }
      equity.push({ account_no: '', title: `Current year earnings (${fyStart.slice(0, 4)})`, amount: round2((total.get(k) || 0) - was) });
      st.set('equity', equity);
      statements.set(k, st);
    });
  }
  keys = sortKeys(mode, keys.filter((k) => k !== OTHER), labels);
  if (folded) keys.push(OTHER);
  const cols = keys.map((k) => ({
    key: k || '~none', label: k === OTHER ? `Other (${folded} more)` : bucketLabel(mode, k, labels),
    drill: k === OTHER ? null : bucketDrill(mode, k, bucketRange, book, labels), sections: asSections(report, statements.get(k)), org: data.org, generatedAt: data.generated_at,
  }));
  if (!cols.length) cols.push({ key: 'cur', label: rangeText(range), drill: drillOf(range), sections: asSections(report, null), org: data.org, generatedAt: data.generated_at });
  return { cols, derived: cols.length > 1 ? 'total' : null, mode: 'buckets', totalDrill: drillOf(range) };
}

// ── Laying the statement out ─────────────────────────────────────────────────
function layout(config, read) {
  const { report } = config;
  const { cols, derived } = read;
  const n = cols.length;
  const sum = (list, at) => round2(list.reduce((s, x) => s + (x.values[at] || 0), 0));
  // A row's figures across every column on screen, from its figures in the data columns.
  const across = (v) => {
    if (derived === 'compare') return [v[0], v[1], round2(v[0] - v[1]), pct(v[0], v[1])];
    if (derived === 'total') return [...v, round2(v.reduce((s, x) => s + x, 0))];
    return v;
  };
  const columns = cols.map((c) => ({ key: c.key, label: c.label, type: 'amount', drill: c.drill }));
  if (derived === 'compare') columns.push({ key: 'var', label: '$ Variance', type: 'variance' }, { key: 'pct', label: '% Variance', type: 'pct' });
  if (derived === 'total') columns.push({ key: 'total', label: 'Total', type: 'amount', drill: read.totalDrill, emphasis: true });

  const wanted = config.accounts?.length ? new Set(config.accounts) : null;
  const pickable = [];
  const totals = {};
  const rows = [];
  let activeKnown = false;
  SECTIONS[report].forEach(([key, label]) => {
    const byAccount = new Map();
    cols.forEach((c, i) => {
      (c.sections.find((s) => s.key === key)?.accounts || []).forEach((a) => {
        const cur = byAccount.get(keyOf(a)) || { code: a.account_no || '', title: a.title, values: new Array(n).fill(0) };
        cur.values[i] = round2(cur.values[i] + (a.amount || 0));
        if (a.active === false) cur.inactive = true;
        if ('active' in a) activeKnown = true;
        byAccount.set(keyOf(a), cur);
      });
    });
    let accounts = [...byAccount.values()].sort((x, y) => {
      // The lines without a code (the earnings a balance sheet carries) keep their place at the end.
      if (!x.code || !y.code) return x.code ? -1 : y.code ? 1 : 0;
      return x.code.localeCompare(y.code, 'en-US', { numeric: true });
    });
    accounts.forEach((a) => { if (a.code) pickable.push({ code: a.code, title: a.title, section: label }); });
    if (wanted) accounts = accounts.filter((a) => !a.code || wanted.has(a.code));
    totals[key] = cols.map((_c, i) => sum(accounts, i));
    // An account stays when ANY column has something in it: in a comparison or
    // a run of months, one active month keeps the line (CAM Charges with
    // activity in March only, Charmi, 09/29).
    const shown = config.showZero ? accounts : accounts.filter((a) => a.values.some((v) => Math.abs(v) >= 0.005));
    if (!shown.length && totals[key].every((v) => Math.abs(v) < 0.005)) return;
    rows.push({ kind: 'section', section: key, label, count: shown.length, values: across(totals[key]) });
    shown.forEach((a) => rows.push({ kind: 'account', section: key, code: a.code, title: a.title, values: across(a.values), ...(a.inactive ? { inactive: true } : {}) }));
  });
  const zero = new Array(n).fill(0);
  const t = (k) => totals[k] || zero;
  const vec = (fn) => cols.map((_c, i) => round2(fn(i)));
  let summary = [];
  if (report === 'pnl' && rows.length) {
    const income = vec((i) => t('revenue')[i] + t('other_income')[i]);
    const cost = vec((i) => t('cogs')[i] + t('expense')[i] + t('other_expense')[i]);
    const gross = vec((i) => t('revenue')[i] - t('cogs')[i]);
    const operating = vec((i) => gross[i] - t('expense')[i]);
    const net = vec((i) => operating[i] + t('other_income')[i] - t('other_expense')[i]);
    rows.push({ kind: 'subtotal', label: 'Gross Profit', values: across(gross) });
    rows.push({ kind: 'subtotal', label: 'Operating Income', values: across(operating) });
    rows.push({ kind: 'grand', label: 'Net Income', tone: true, values: across(net) });
    // The margin is a share, never a sum: each column from its own net and income.
    const marginOf = (nv, iv) => (Math.abs(iv) < 0.005 ? Number.NaN : nv / iv);
    const margin = cols.map((_c, i) => marginOf(net[i], income[i]));
    const total = (v) => round2(v.reduce((s, x) => s + x, 0));
    const marginAcross = derived === 'compare' ? [margin[0], margin[1], Number.NaN, Number.NaN] : derived === 'total' ? [...margin, marginOf(total(net), total(income))] : margin;
    rows.push({ kind: 'margin', label: 'Net Profit Margin %', values: marginAcross });
    const at = derived === 'total' ? n : 0;
    summary = [
      { label: 'Revenue', value: money(across(income)[at]), amount: across(income)[at], tone: 'good' },
      { label: 'Expenses', value: money(across(cost)[at]), amount: across(cost)[at], tone: 'bad' },
      { label: 'Net Income', value: money(across(net)[at]), amount: across(net)[at], tone: across(net)[at] >= 0 ? 'good' : 'bad' },
      { label: 'Net Margin', value: share(marginAcross[at]) || '-', tone: (marginAcross[at] || 0) >= 0 ? 'good' : 'bad' },
    ];
    if (derived === 'compare') summary.push({ label: 'Net Change', value: [money(net[0] - net[1]), pct(net[0], net[1])].filter(Boolean).join(' · '), tone: net[0] - net[1] >= 0 ? 'good' : 'bad' });
  }
  if (report === 'balance-sheet' && rows.length) {
    const le = vec((i) => t('liability')[i] + t('equity')[i]);
    const off = vec((i) => t('asset')[i] - le[i]);
    rows.push({ kind: 'grand', label: 'Total Liabilities and Equity', values: across(le) });
    // Picking accounts takes lines out of the statement, so it cannot balance; say nothing then.
    if (!wanted && off.some((v) => Math.abs(v) >= 0.01)) rows.push({ kind: 'warn', label: 'Out of balance by', values: across(off) });
    const at = derived === 'total' ? n : 0;
    summary = [
      { label: 'Assets', value: money(across(t('asset'))[at]), amount: across(t('asset'))[at] },
      { label: 'Liabilities', value: money(across(t('liability'))[at]), amount: across(t('liability'))[at] },
      { label: 'Equity', value: money(across(t('equity'))[at]), amount: across(t('equity'))[at] },
    ];
  }
  return { columns, rows, summary, pickable, activeKnown };
}

/**
 * Read the ledger for one config (`entities` = the entity list, for splitting
 * one picked entity into its sub-entities). Returns
 *   { config, def, org, generatedAt, mode, otherLabel, columns, rows, summary, pickable }
 * columns: [{ key, label, type: 'amount'|'variance'|'pct'|'date', drill?, emphasis? }]
 *   drill = { from, to, book, entity?, department?, party? } - what an amount in that column opens.
 * rows: [{ kind: 'section'|'account'|'subtotal'|'grand'|'margin'|'warn', label?,
 *          code?, title?, section?, count?, tone?, values: [...] }]
 *   values line up with columns; a variance is a number, a pct is text, a
 *   margin row holds shares (0.198 = 19.8%).
 * summary: the figures above the statement. pickable: every account the
 *   statement could show, for the Accounts picker.
 */
export async function runReport(api, config, entities = []) {
  const def = reportDef(config.report);
  const both = canPickBook(config) && config.book === 'both';
  const book = both ? 'accrual' : config.book;
  const base = { config, def, org: '', generatedAt: '', mode: 'single', otherLabel: '', summary: [], pickable: [] };
  const drillCur = { from: def.period === 'asof' ? '' : config.from, to: def.period === 'asof' ? config.asof : config.to, book };

  if (config.report === 'cash-position') {
    const a = await fetchStatement(api, config, { asof: config.asof }, 'accrual');
    const rows = (a.accounts || []).map((x) => ({ kind: 'account', code: x.gl_code, title: x.account_name, values: [x.balance, x.last_activity ? formatDate(x.last_activity) : ''] }));
    rows.push({ kind: 'grand', label: `Total Cash as of ${formatDate(config.asof)}`, tone: true, values: [a.total, ''] });
    return { ...base, org: a.org || '', generatedAt: a.generated_at || '', columns: [{ key: 'balance', label: 'Balance', type: 'amount', drill: { ...drillCur, book: 'accrual' } }, { key: 'last', label: 'Last Activity', type: 'date' }], rows };
  }

  if (config.report === 'trial-balance') {
    const range = { from: config.from, to: config.to };
    const [a, b] = await Promise.all([fetchStatement(api, config, range, book), both ? fetchStatement(api, config, range, 'cash') : Promise.resolve(null)]);
    const cash = new Map((b?.rows || []).map((r) => [r.account_no, r]));
    const codes = [...new Set([...(a.rows || []).map((r) => r.account_no), ...cash.keys()])].sort((x, y) => x.localeCompare(y, 'en-US', { numeric: true }));
    const byCode = new Map((a.rows || []).map((r) => [r.account_no, r]));
    let rows = codes.map((code) => {
      const r = byCode.get(code);
      const c = cash.get(code);
      return { kind: 'account', code, title: (r || c).title, values: [r?.opening || 0, r?.debit || 0, r?.credit || 0, r?.closing || 0, ...(both ? [c?.closing || 0] : [])], ...((r || c).active === false ? { inactive: true } : {}) };
    });
    if (!config.showZero) rows = rows.filter((r) => r.values.some((v) => Math.abs(v) >= 0.005));
    rows.push({ kind: 'grand', label: 'Total', values: [a.totals.opening, a.totals.debit, a.totals.credit, a.totals.closing, ...(both ? [b.totals.closing] : [])] });
    // Item 33: the Opening figure opens every line up to the day before the
    // period, the Closing figure every line through its end, the movement the period's.
    const opening = { ...drillCur, from: '', to: dayBefore(config.from) };
    const closing = { ...drillCur, from: '' };
    const columns = ['Opening', 'Debit', 'Credit', 'Closing'].map((label, i) => ({ key: label.toLowerCase(), label: both && i === 3 ? 'Closing (Accrual)' : label, type: 'amount', drill: i === 0 ? opening : i === 3 ? closing : drillCur }));
    if (both) columns.push({ key: 'cash-closing', label: 'Closing (Cash)', type: 'amount', drill: { ...closing, book: 'cash' } });
    const activeKnown = (a.rows || []).some((r) => 'active' in r);
    return { ...base, org: a.org || '', generatedAt: a.generated_at || '', mode: both ? 'books' : 'single', columns, rows, activeKnown };
  }

  if (config.report === 'general-ledger') return { ...base, ...(await generalLedger(api, config, book, drillCur)) };
  if (config.report === 'cash-flow') return { ...base, ...(await cashFlowReport(api, config)) };
  if (config.report === 'flux') return { ...base, ...(await fluxAnalysis(api, config, book)) };

  const read = await readColumns(api, config, entities);
  return { ...base, org: read.cols[0]?.org || '', generatedAt: read.cols[0]?.generatedAt || '', mode: read.mode, otherLabel: read.otherLabel || '', ...layout(config, read), ...(read.budgetNote ? { notes: [read.budgetNote] } : {}) };
}

// ── The General Ledger ───────────────────────────────────────────────────────
// Every account's activity for the period, line by line (Charmi, call of
// 09/29: the one report missing from the list). Per account: the opening
// balance (from the trial balance), each posted line with a running balance,
// the closing balance. Lines come from the ledger search, one read per
// account, so the detail is listed for up to GL_MAX_ACCOUNTS accounts at a
// time - more than that, or nothing picked on a busy ledger, and the accounts
// are listed with their opening, activity and closing only, with a note to
// pick the ones to open.
//
// Oct 7 (Charmi, items 20 / 22 / 31 / 33 / 34):
// - The report's filters narrow the LINES, not only the balances: the vendor,
//   customer, employee, department, Project-Job, item and journal picks go
//   into every line search (one vendor or customer also as the search's own
//   party). Wunderlin Engineering on 12000 listed 1,763 payments to other
//   payees, and on All entities the run timed out. Should the accounting
//   service not narrow them yet, the lines read are narrowed here.
// - Accounts sit under their Intacct groups (Bank, Credit Card, then the
//   account categories in the chart's order, from the payload's `group`;
//   failing that the statement section), each group folding with a subtotal.
// - The line counter is always there: the searches' own counts, never 0
//   while there are lines.
// - A search that does not finish leaves its account listed with the
//   balances and says so in plain words, instead of an empty page.
// - Opening and Closing balances drill into the lines behind them; an entry
//   number opens the journal entry.
const glSigned = (r) => round2((r.debit || 0) - (r.credit || 0));
const GL_CLASS_RANK = { Bank: 1, 'Credit Card': 2, Assets: 3, Liabilities: 4, Equity: 5, Income: 6, Expenses: 7, Other: 8 };
const SECTION_CLASS = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', revenue: 'Income', other_income: 'Income', cogs: 'Expenses', expense: 'Expenses', other_expense: 'Expenses' };
/**
 * The group an account sits under on the General Ledger: { key, label, rank }
 * from the account row's `group` (category, or Bank / Credit Card) and
 * `class` / `class_rank`; failing those, the statement section. Null when
 * the row says nothing about it.
 */
export function glGroupOf(r) {
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const cls = text(r?.class) || (r?.bank_kind === 'card' ? 'Credit Card' : r?.bank_kind === 'checking' || r?.bank_kind === 'savings' ? 'Bank' : SECTION_CLASS[text(r?.section).toLowerCase()] || '');
  const label = text(r?.group) || cls;
  if (!label) return null;
  const rank = r?.class_rank != null && Number.isFinite(Number(r.class_rank)) ? Number(r.class_rank) : GL_CLASS_RANK[cls] || 9;
  return { key: label, label, rank };
}

// The report's filters as line-search params (contract of 10/07: the same
// names the report reads take, comma-separated codes).
const LINE_DIMS = ['departments', 'vendor', 'customer', 'employee', 'project', 'item', 'journals'];
const PARTY_KINDS = ['vendor', 'customer', 'employee'];
/** The line-search params for the report's filters: each kind as a code list, and one vendor / customer / employee as the search's party too. */
export function glLineParams(dims) {
  const out = {};
  if (!dims) return out;
  LINE_DIMS.forEach((k) => { if (Array.isArray(dims[k]) && dims[k].length) out[k] = dims[k].join(','); });
  const parties = PARTY_KINDS.filter((k) => dims[k]?.length);
  if (parties.length === 1 && dims[parties[0]].length === 1) { out.party_kind = parties[0]; out.party = dims[parties[0]][0]; }
  return out;
}
// Where a line carries each kind. Departments are left out of the check made
// here: a picked department includes the ones under it, which a line cannot tell.
const LINE_FIELD = { vendor: 'vendor_id', customer: 'customer_id', employee: 'employee_id', project: 'project_id', item: 'item_id', journals: 'journal' };
/**
 * Whether one ledger line passes the report's filters (the check made here
 * when the accounting service did not narrow the lines). A line that does not
 * carry a field at all cannot be judged and passes; one that carries it empty
 * does not.
 */
export function lineMatchesDims(line, dims) {
  return Object.entries(LINE_FIELD).every(([k, field]) => {
    const want = dims?.[k];
    if (!Array.isArray(want) || !want.length) return true;
    if (!line || !(field in line)) return true;
    const v = String(line[field] ?? '').trim();
    if (!v) return false;
    return k === 'journals' ? want.some((w) => String(w).toUpperCase() === v.toUpperCase()) : want.includes(v);
  });
}
const hasLineDims = (dims) => Object.keys(LINE_FIELD).some((k) => dims?.[k]?.length);

// At most `limit` reads at once: 25 line searches side by side over every
// entity is what tipped the ledger over its time limit.
async function settleAll(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      try { out[i] = { ok: true, value: await fn(items[i], i) }; } catch (e) { out[i] = { ok: false, error: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const TOO_BIG = 'Too many lines for one run - pick an entity or a shorter period.';

async function generalLedger(api, config, book, drillCur) {
  const { location, dims } = placeOf(config);
  const tb = await readTrialBalance(api, config.from, config.to, location, dims, book);
  const wanted = config.accounts?.length ? new Set(config.accounts) : null;
  let accounts = (tb.rows || []).filter((r) => !wanted || wanted.has(r.account_no));
  if (!config.showZero) accounts = accounts.filter((r) => [r.opening, r.debit, r.credit, r.closing].some((v) => Math.abs(v || 0) >= 0.005));
  const grouped = accounts.some((a) => glGroupOf(a));
  const rankOf = (a) => glGroupOf(a)?.rank ?? 99;
  accounts.sort((a, b) => (grouped ? rankOf(a) - rankOf(b) || (glGroupOf(a)?.key || '').localeCompare(glGroupOf(b)?.key || '') : 0) || a.account_no.localeCompare(b.account_no, 'en-US', { numeric: true }));
  const pickable = (tb.rows || []).map((r) => ({ code: r.account_no, title: r.title, section: 'Accounts' }));
  const activeKnown = (tb.rows || []).some((r) => 'active' in r);
  const detail = accounts.length > 0 && accounts.length <= GL_MAX_ACCOUNTS;
  const place = config.entities.length === 1 ? { location: config.entities[0] } : config.entities.length ? { locations: config.entities.join(',') } : {};
  const lineDims = canUseDims(config) ? config.dims : null;
  const filters = glLineParams(lineDims);
  const searchBook = isUserBook(book) ? book : book === 'cash' ? 'cash' : 'accrual';
  const ask = (extra) => api.searchAccountingLedger({ from: config.from, to: config.to, book: searchBook, ...place, ...filters, ...extra });
  const reads = detail ? await settleAll(accounts, 4, (a) => ask({ account: a.account_no, limit: GL_MAX_LINES, offset: 0 })) : [];

  // An account heading's or a total's figure opens the lines behind it (Charmi, 10/02); a line is already a line.
  const columns = [
    { key: 'entry', label: 'Entry', type: 'text' }, { key: 'description', label: 'Description', type: 'text' }, { key: 'entity', label: 'Entity', type: 'text' },
    { key: 'debit', label: 'Debit', type: 'amount', drill: drillCur }, { key: 'credit', label: 'Credit', type: 'amount', drill: drillCur }, { key: 'balance', label: 'Balance', type: 'amount', drill: drillCur },
  ];
  // The balance column of an Opening row opens every line before the period; of a Closing row, every line through its end.
  const openingDrill = { 5: { ...drillCur, from: '', to: dayBefore(config.from) } };
  const closingDrill = { 5: { ...drillCur, from: '' } };
  const rows = [];
  let totalDebit = 0;
  let totalCredit = 0;
  let cut = 0;
  let narrowedHere = false;
  let failed = 0;
  let lineCount = 0;
  let countPartial = false;
  const blocks = accounts.map((a, i) => {
    const key = a.account_no;
    const read = reads[i];
    const group = grouped ? glGroupOf(a) || { key: 'Other', label: 'Other', rank: 99 } : null;
    const inactive = a.active === false ? { inactive: true } : {};
    const g = group ? { group: group.key } : {};
    totalDebit = round2(totalDebit + (a.debit || 0));
    totalCredit = round2(totalCredit + (a.credit || 0));
    const plain = { kind: 'account', code: key, title: a.title, ...g, ...inactive, values: ['', '', '', round2(a.debit), round2(a.credit), round2(a.closing)], drills: closingDrill };
    if (!detail) return { a, group, rows: [plain] };
    if (read && !read.ok) {
      failed += 1;
      countPartial = true;
      return { a, group, rows: [{ ...plain, failed: true }] };
    }
    const got = read?.value;
    let list = [...(got?.rows || [])];
    let total = Number(got?.total ?? list.length) || 0;
    // The accounting service narrows the lines by the filters (10/07); one that
    // does not yet hands back lines of other payees - narrowed here then.
    if (hasLineDims(lineDims) && list.some((l) => !lineMatchesDims(l, lineDims))) {
      narrowedHere = true;
      const kept = list.filter((l) => lineMatchesDims(l, lineDims));
      if (total > list.length) countPartial = true;
      total = kept.length;
      list = kept;
    } else if (total > list.length) cut += total - list.length;
    lineCount += total;
    // Lines come newest first from the search; a ledger reads oldest first.
    list.sort((x, y) => (x.entry_date || '').localeCompare(y.entry_date || '') || (x.entry_no || '').localeCompare(y.entry_no || '', 'en-US', { numeric: true }));
    // Oct 2 (Charmi): with no lines listed an account is a plain banded row -
    // not a heading with a fold arrow that opens nothing - and its balance is
    // the closing one. With lines, the heading folds them.
    if (!list.length) return { a, group, rows: [plain] };
    const out = [{ kind: 'section', section: key, code: key, title: a.title, ...g, ...inactive, label: `${key} ${a.title}`, count: list.length, values: ['', 'Opening balance', '', round2(a.debit), round2(a.credit), round2(a.opening)], drill: drillCur, drills: openingDrill }];
    let running = round2(a.opening || 0);
    list.forEach((l) => {
      running = round2(running + glSigned(l));
      out.push({ kind: 'line', section: key, ...g, label: formatDate(l.entry_date), entryId: l.entry_id, entryNo: l.entry_no || '', values: [l.entry_no || '', l.description || l.memo || '', l.location_name || l.location || '', round2(l.debit), round2(l.credit), running] });
    });
    out.push({ kind: 'subtotal', section: key, code: key, title: a.title, ...g, label: 'Closing balance', values: ['', '', '', round2(a.debit), round2(a.credit), round2(a.closing)], drills: closingDrill });
    return { a, group, rows: out };
  });
  // Group heading -> its accounts -> "Total <group>".
  let at = 0;
  while (at < blocks.length) {
    const group = blocks[at].group;
    let end = at;
    while (end < blocks.length && (blocks[end].group?.key || null) === (group?.key || null)) end += 1;
    const mine = blocks.slice(at, end);
    if (group) {
      const sum = (f) => round2(mine.reduce((s, b) => s + (Number(b.a[f]) || 0), 0));
      const values = ['', '', '', sum('debit'), sum('credit'), sum('closing')];
      // The heading carries no figures (exports print them once, on the
      // Total row); folded, the screen shows the totals on the heading.
      rows.push({ kind: 'group', group: group.key, label: group.label, count: mine.length, values: ['', '', '', '', '', ''], totals: values, noDrill: true });
      mine.forEach((b) => rows.push(...b.rows));
      rows.push({ kind: 'subtotal', group: group.key, label: `Total ${group.label}`, values, noDrill: true });
    } else mine.forEach((b) => rows.push(...b.rows));
    at = end;
  }
  rows.push({ kind: 'grand', label: `Total - ${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}`, values: ['', '', '', totalDebit, totalCredit, round2(tb.totals?.closing || 0)] });

  // The line counter (Charmi, 10/02 and 10/06: "line counter needs to be
  // there"): every posted line behind the report, listed or not.
  if (!detail && accounts.length) {
    const probe = async (extra) => {
      const c = await ask({ ...extra, limit: hasLineDims(lineDims) ? 25 : 1, offset: 0 });
      // A count the service did not narrow by the filters would overstate it.
      if (hasLineDims(lineDims) && (c?.rows || []).some((l) => !lineMatchesDims(l, lineDims))) return null;
      return Number(c?.total) || 0;
    };
    if (!wanted) {
      try { lineCount = await probe({}); } catch { lineCount = null; }
    } else {
      // More accounts picked than the listing opens: one count per account.
      const counts = await settleAll(accounts, 4, (a) => probe({ account: a.account_no }));
      lineCount = 0;
      counts.forEach((c) => { if (c.ok && c.value != null) lineCount += c.value; else countPartial = true; });
      if (counts.every((c) => !c.ok || c.value == null)) lineCount = null;
    }
    // Activity on the balances and no lines counted cannot both be right.
    if (lineCount === 0 && accounts.some((a) => Math.abs(a.debit || 0) >= 0.005 || Math.abs(a.credit || 0) >= 0.005)) lineCount = null;
  }
  const notes = [];
  if (failed) notes.push(`${TOO_BIG} ${failed} of ${accounts.length} accounts could not list their lines in time; they show their balances only.`);
  if (!detail && accounts.length) notes.push(`${accounts.length} accounts have activity - the lines are listed for up to ${GL_MAX_ACCOUNTS} accounts at a time. Pick the accounts to open under Accounts.`);
  if (cut) notes.push(`${cut.toLocaleString('en-US')} more lines were not listed (${GL_MAX_LINES.toLocaleString('en-US')} per account at most). Narrow the period for the whole run.`);
  if (narrowedHere) notes.push(`The lines were narrowed to the filters here, from the first ${GL_MAX_LINES.toLocaleString('en-US')} lines of each account the accounting service sent.`);
  // Oct 2 (Charmi): no Debits / Credits up top (the Total row has them).
  const counted = lineCount == null ? 'Not counted' : `${lineCount.toLocaleString('en-US')}${countPartial ? '+' : ''}`;
  if (lineCount == null) notes.push('The accounting service cannot count the lines for these filters yet; pick up to 25 accounts to list and count them.');
  const summary = [{ label: 'Lines', value: counted }];
  return { org: tb.org || '', generatedAt: tb.generated_at || '', mode: 'ledger', columns, rows, summary, pickable, notes, glLabel: 'Account', activeKnown, grouped };
}

// ── Flux Analysis ────────────────────────────────────────────────────────────
// This period against the one before it (or the same period last year), per
// income statement account: the two figures, Variance $ and Variance %, a
// flag when BOTH thresholds are passed (10% and $5,000 to start - the usual
// audit rule; one alone flags every small account or every big one), and an
// Explanation kept per account and period. Statement sections and subtotals
// read as on the income statement, so the net income flux is on the page too.
const FLUX_NOTE_AT = 5;   // the Explanation column's index in a flux row's values
/**
 * The variance lines of a flux: `cur` and `prior` are pnl `sections`
 * ([{ key, accounts: [{ account_no, title, amount }] }]). Returns
 * [{ code, title, section, cur, prior, variance, pct, flag }], variance =
 * cur - prior, pct = variance / |prior| (NaN when prior is 0), flag when
 * |variance| >= amount AND (|pct| >= pct% or prior is 0 and amount passed).
 */
export function fluxRows(cur, prior, { fluxPct = FLUX_DEFAULTS.fluxPct, fluxAmount = FLUX_DEFAULTS.fluxAmount } = {}) {
  const byAccount = new Map();
  const take = (sections, side) => (sections || []).forEach((s) => (s.accounts || []).forEach((a) => {
    const row = byAccount.get(keyOf(a)) || { code: a.account_no || '', title: a.title, section: s.key, cur: 0, prior: 0 };
    row[side] = round2(row[side] + (a.amount || 0));
    if (a.active === false) row.inactive = true;
    byAccount.set(keyOf(a), row);
  }));
  take(cur, 'cur');
  take(prior, 'prior');
  const out = [...byAccount.values()].map((r) => {
    const variance = round2(r.cur - r.prior);
    const pct = Math.abs(r.prior) < 0.005 ? Number.NaN : variance / Math.abs(r.prior);
    const overAmount = Math.abs(variance) >= fluxAmount - 0.005;
    const overPct = Number.isNaN(pct) ? Math.abs(variance) >= 0.005 : Math.abs(pct) * 100 >= fluxPct - 0.0005;
    return { ...r, variance, pct, flag: overAmount && overPct };
  });
  return out.sort((x, y) => x.code.localeCompare(y.code, 'en-US', { numeric: true }));
}
async function fluxAnalysis(api, config, book) {
  const range = { from: config.from, to: config.to };
  const prior = activeColumns(config) === 'prior_year' ? { from: yearBack(config.from), to: yearBack(config.to) } : (([from, to]) => ({ from, to }))(priorPeriod(config.from, config.to));
  const [a, b] = await Promise.all([fetchStatement(api, { ...config, report: 'pnl' }, range, book), fetchStatement(api, { ...config, report: 'pnl' }, prior, book)]);
  const rangeText = (r) => `${formatDate(r.from)} - ${formatDate(r.to)}`;
  const drillOf = (r) => ({ from: r.from, to: r.to, book });
  const columns = [
    { key: 'cur', label: rangeText(range), type: 'amount', drill: drillOf(range) },
    { key: 'prior', label: rangeText(prior), type: 'amount', drill: drillOf(prior) },
    { key: 'var', label: 'Variance $', type: 'variance' }, { key: 'pct', label: 'Variance %', type: 'pct' },
    { key: 'flag', label: 'Flag', type: 'text' }, { key: 'note', label: 'Explanation', type: 'text' },
  ];
  const lines = fluxRows(a.sections, b.sections, config);
  const wanted = config.accounts?.length ? new Set(config.accounts) : null;
  const rows = [];
  const pickable = [];
  const totals = {};
  const vals = (c, p) => [c, p, round2(c - p), pct(c, p), '', ''];
  SECTIONS.pnl.forEach(([key, label]) => {
    let accounts = lines.filter((r) => r.section === key);
    accounts.forEach((r) => { if (r.code) pickable.push({ code: r.code, title: r.title, section: label }); });
    if (wanted) accounts = accounts.filter((r) => !r.code || wanted.has(r.code));
    totals[key] = [round2(accounts.reduce((s, r) => s + r.cur, 0)), round2(accounts.reduce((s, r) => s + r.prior, 0))];
    const shown = config.showZero ? accounts : accounts.filter((r) => Math.abs(r.cur) >= 0.005 || Math.abs(r.prior) >= 0.005);
    if (!shown.length && totals[key].every((v) => Math.abs(v) < 0.005)) return;
    rows.push({ kind: 'section', section: key, label, count: shown.length, values: vals(...totals[key]) });
    shown.forEach((r) => rows.push({ kind: 'account', section: key, code: r.code, title: r.title, flag: r.flag, values: [r.cur, r.prior, r.variance, share(r.pct), r.flag ? 'Review' : '', ''], ...(r.inactive ? { inactive: true } : {}) }));
  });
  const t = (k) => totals[k] || [0, 0];
  const at = (i) => {
    const gross = t('revenue')[i] - t('cogs')[i];
    const operating = gross - t('expense')[i];
    return { gross: round2(gross), operating: round2(operating), net: round2(operating + t('other_income')[i] - t('other_expense')[i]) };
  };
  const [c, p] = [at(0), at(1)];
  if (rows.length) {
    rows.push({ kind: 'subtotal', label: 'Gross Profit', values: vals(c.gross, p.gross) });
    rows.push({ kind: 'subtotal', label: 'Operating Income', values: vals(c.operating, p.operating) });
    rows.push({ kind: 'grand', label: 'Net Income', tone: true, values: vals(c.net, p.net) });
  }
  const flagged = rows.filter((r) => r.kind === 'account' && r.flag).length;
  const summary = [
    { label: 'Net Income', value: money(c.net), amount: c.net, tone: c.net >= 0 ? 'good' : 'bad' },
    { label: 'Prior', value: money(p.net), amount: p.net },
    { label: 'Change', value: [money(c.net - p.net), pct(c.net, p.net)].filter(Boolean).join(' · '), tone: c.net - p.net >= 0 ? 'good' : 'bad' },
    { label: 'Flagged', value: String(flagged) },
  ];
  const notes = [`A line is flagged when its variance passes both ${config.fluxPct}% and ${money(config.fluxAmount)} (Customize changes the thresholds). Write why an account moved in its Explanation cell (the pencil edits it, the trash removes it); a flagged line with an explanation reads Explained. Notes are kept for this entity set and period.`];
  return { org: a.org || '', generatedAt: a.generated_at || '', mode: 'compare', otherLabel: rangeText(prior), columns, rows, summary, pickable, notes, flux: { period: `${config.from}_${config.to}` } };
}
const FLUX_FLAG_AT = 4;    // the Flag column's index
/**
 * The flux result with the kept explanations filled in: `notes` = { accountNo: text }.
 * A flagged line with an explanation reads "Explained" instead of "Review"
 * (Charmi's Friday list, item 26b) and stays a flagged line; the Flagged
 * figure up top reads "N to review · M explained".
 */
export function withFluxNotes(result, notes) {
  if (!result?.flux) return result;
  let review = 0;
  let explained = 0;
  const rows = result.rows.map((r) => {
    if (r.kind !== 'account' || !r.code) return r;
    const note = notes?.[r.code] || '';
    if (r.flag) { if (note) explained += 1; else review += 1; }
    return { ...r, explained: !!(r.flag && note), values: r.values.map((v, i) => (i === FLUX_NOTE_AT ? note : i === FLUX_FLAG_AT ? (r.flag ? (note ? 'Explained' : 'Review') : '') : v)) };
  });
  const summary = (result.summary || []).map((f) => (f.label === 'Flagged' ? { ...f, value: `${review.toLocaleString('en-US')} to review · ${explained.toLocaleString('en-US')} explained` } : f));
  return { ...result, rows, summary };
}

// ── Statement of Cash Flows (item 26c) ───────────────────────────────────────
// The indirect method, v1 (Charmi's Friday list; method and layout to be
// confirmed with her against an Intacct sample): net income; plus the
// depreciation and amortization expense (expense accounts by title); plus or
// minus each working capital account's move between the balance sheet the
// day before the period and the one at its end; investing = fixed assets and
// investments; financing = loans and notes, and equity other than earnings.
// Cash is what Cash Position lists, so the ending cash ties to it. Whatever
// the balance sheet moves do not explain is shown on its own line rather
// than tucked into a total.
const RE_DA = /depreciation|amortization/i;
const RE_ACCUMULATED = /accumulated\s+(depreciation|amortization)/i;
const RE_LONG_TERM = /\b(land|building|buildings|improvements?|equipment|furniture|fixtures|vehicles?|machinery|construction in progress|cip|fixed assets?|investments?|investment in|property|leasehold)\b/i;
const RE_FINANCING = /\b(loans?|notes? payable|mortgages?|line of credit|loc|debt|bonds?|financing)\b/i;
const RE_CASH = /\b(cash|checking|savings|money market|petty)\b/i;
const RE_EARNINGS = /retained\s+earnings|current\s+year\s+earnings|net\s+income/i;
/**
 * The figures of a cash flow statement. `pnl` = the period's income
 * statement ({ sections }), `bsBegin` / `bsEnd` = balance sheets ({ sections })
 * the day before the period and at its end, `cashBegin` / `cashEnd` = Cash
 * Position answers ({ accounts: [{ gl_code }], total }) or null.
 * Returns { netIncome, operating, investing, financing: { lines, total },
 *   beginCash, endCash, netChange, unexplained }.
 */
export function cashFlowFigures({ pnl, bsBegin, bsEnd, cashBegin = null, cashEnd = null }) {
  const sectionSum = (keys) => round2((pnl?.sections || []).filter((s) => keys.includes(s.key)).reduce((t, s) => t + (s.accounts || []).reduce((u, a) => u + (Number(a.amount) || 0), 0), 0));
  const netIncome = round2(sectionSum(['revenue', 'other_income']) - sectionSum(['cogs', 'expense', 'other_expense']));
  const da = [];
  (pnl?.sections || []).filter((s) => ['cogs', 'expense', 'other_expense'].includes(s.key)).forEach((s) => (s.accounts || []).forEach((a) => {
    if (RE_DA.test(a.title || '') && Math.abs(Number(a.amount) || 0) >= 0.005) da.push({ code: a.account_no || '', title: a.title, amount: round2(a.amount) });
  }));
  const daTotal = round2(da.reduce((t, l) => t + l.amount, 0));
  const balances = (bs) => {
    const m = new Map();
    (bs?.sections || []).forEach((s) => (s.accounts || []).forEach((a) => {
      if (!a.account_no || !['asset', 'liability', 'equity'].includes(s.key)) return;
      const cur = m.get(a.account_no) || { code: a.account_no, title: a.title, section: s.key, category: a.category || a.group || '', bank_kind: a.bank_kind || null, amount: 0 };
      cur.amount = round2(cur.amount + (Number(a.amount) || 0));
      m.set(a.account_no, cur);
    }));
    return m;
  };
  const b0 = balances(bsBegin);
  const b1 = balances(bsEnd);
  const cashCodes = new Set([...(cashBegin?.accounts || []), ...(cashEnd?.accounts || [])].map((a) => a.gl_code).filter(Boolean));
  const fromPosition = cashBegin || cashEnd;
  const isCash = (a) => a.section === 'asset' && (fromPosition ? cashCodes.has(a.code) : RE_CASH.test(a.title || '') || a.bank_kind);
  const operating = [{ code: '', title: 'Net Income', amount: netIncome, computed: true }, ...da];
  const investing = [];
  const financing = [];
  let accumulated = 0;
  let hasAccumulated = false;
  let cashFromBs0 = 0;
  let cashFromBs1 = 0;
  [...new Set([...b0.keys(), ...b1.keys()])].sort((x, y) => x.localeCompare(y, 'en-US', { numeric: true })).forEach((code) => {
    const a = b1.get(code) || b0.get(code);
    const begin = b0.get(code)?.amount || 0;
    const end = b1.get(code)?.amount || 0;
    const delta = round2(end - begin);
    if (isCash(a)) { cashFromBs0 += begin; cashFromBs1 += end; return; }
    if (Math.abs(delta) < 0.005) return;
    const text = `${a.title || ''} ${a.category || ''}`;
    if (a.section === 'asset') {
      if (RE_ACCUMULATED.test(a.title || '')) { hasAccumulated = true; accumulated = round2(accumulated + delta); return; }
      (RE_LONG_TERM.test(text) ? investing : operating).push({ code, title: a.title, amount: round2(-delta) });
    } else if (a.section === 'liability') {
      (RE_FINANCING.test(text) ? financing : operating).push({ code, title: a.title, amount: delta });
    } else if (!RE_EARNINGS.test(a.title || '')) {
      financing.push({ code, title: a.title, amount: delta });
    }
  });
  // An accumulated depreciation account that grew by more (or less) than the
  // expense - a disposal, a reclass - is shown as its own non-cash line.
  if (hasAccumulated) {
    const other = round2(-accumulated - daTotal);
    if (Math.abs(other) >= 0.005) operating.push({ code: '', title: 'Other Changes in Accumulated Depreciation', amount: other, computed: true });
  }
  const total = (lines) => round2(lines.reduce((t, l) => t + l.amount, 0));
  const beginCash = round2(cashBegin ? Number(cashBegin.total) || 0 : cashFromBs0);
  const endCash = round2(cashEnd ? Number(cashEnd.total) || 0 : cashFromBs1);
  const netChange = round2(endCash - beginCash);
  const flows = round2(total(operating) + total(investing) + total(financing));
  return {
    netIncome, operating: { lines: operating, total: total(operating) }, investing: { lines: investing, total: total(investing) }, financing: { lines: financing, total: total(financing) },
    beginCash, endCash, netChange, unexplained: round2(netChange - flows),
  };
}
async function cashFlowReport(api, config) {
  const book = 'accrual';
  const begin = dayBefore(config.from);
  const cfg = { ...config, dims: { ...EMPTY_DIMS } };
  const [pnl, bsBegin, bsEnd, cashBegin, cashEnd] = await Promise.all([
    fetchStatement(api, { ...cfg, report: 'pnl' }, { from: config.from, to: config.to }, book),
    fetchStatement(api, { ...cfg, report: 'balance-sheet' }, { asof: begin }, book),
    fetchStatement(api, { ...cfg, report: 'balance-sheet' }, { asof: config.to }, book),
    fetchStatement(api, { ...cfg, report: 'cash-position' }, { asof: begin }, book).catch(() => null),
    fetchStatement(api, { ...cfg, report: 'cash-position' }, { asof: config.to }, book).catch(() => null),
  ]);
  const f = cashFlowFigures({ pnl, bsBegin, bsEnd, cashBegin, cashEnd });
  const drill = { from: config.from, to: config.to, book };
  const columns = [{ key: 'amount', label: `${formatDate(config.from)} - ${formatDate(config.to)}`, type: 'amount', drill }];
  const rows = [];
  [['operating', 'Cash Flows From Operating Activities', f.operating], ['investing', 'Cash Flows From Investing Activities', f.investing], ['financing', 'Cash Flows From Financing Activities', f.financing]].forEach(([key, label, part]) => {
    rows.push({ kind: 'section', section: key, label, count: part.lines.length, values: [part.total] });
    part.lines.forEach((l) => rows.push({ kind: 'account', section: key, code: l.code, title: l.title, values: [l.amount], ...(l.computed || !l.code ? { noDrill: true } : {}) }));
  });
  if (Math.abs(f.unexplained) >= 0.005) rows.push({ kind: 'warn', label: 'Not Explained by the Balance Sheet', values: [f.unexplained], noDrill: true });
  rows.push({ kind: 'subtotal', label: 'Net Change in Cash', values: [f.netChange], noDrill: true });
  rows.push({ kind: 'subtotal', label: `Cash at Beginning of Period (${formatDate(begin)})`, values: [f.beginCash], noDrill: true });
  rows.push({ kind: 'grand', label: `Cash at End of Period (${formatDate(config.to)})`, tone: true, values: [f.endCash], noDrill: true });
  const summary = [
    { label: 'Net Income', value: money(f.netIncome), amount: f.netIncome, tone: f.netIncome >= 0 ? 'good' : 'bad' },
    { label: 'Operating', value: money(f.operating.total), amount: f.operating.total },
    { label: 'Investing', value: money(f.investing.total), amount: f.investing.total },
    { label: 'Financing', value: money(f.financing.total), amount: f.financing.total },
    { label: 'Ending Cash', value: money(f.endCash), amount: f.endCash },
  ];
  const notes = [`Indirect method. The ending cash ties to Cash Position as of ${formatDate(config.to)}${cashEnd ? '' : ' (Cash Position could not be read - cash is the cash and bank accounts on the balance sheet)'}. Accounts are sorted into operating, investing and financing by type and title (v1).`];
  if (Math.abs(f.unexplained) >= 0.005) notes.push('Not Explained by the Balance Sheet: cash moved by more (or less) than the balance sheet accounts did - an entity or book difference to look into.');
  return { org: pnl?.org || '', generatedAt: pnl?.generated_at || '', mode: 'single', columns, rows, summary, notes, cashFlow: f };
}

// ── Inactive accounts (item 34) ──────────────────────────────────────────────
/**
 * The result without the rows of accounts Intacct marks inactive, unless
 * Customize shows them (Charmi; Neil's rule: hide only the ROW - every total
 * still includes them). A footnote counts what was hidden.
 */
export function hideInactive(result, show = false) {
  if (!result || show) return result;
  const hidden = new Set(result.rows.filter((r) => r.inactive && r.code).map((r) => r.code));
  if (!hidden.size) return result;
  const rows = result.rows.filter((r) => !(r.code && hidden.has(r.code) && ['account', 'section', 'subtotal'].includes(r.kind)) && !(r.kind === 'line' && hidden.has(r.section)));
  const n = hidden.size;
  return { ...result, rows, hiddenInactive: n, notes: [...(result.notes || []), `${n} inactive ${n === 1 ? 'account' : 'accounts'} hidden (Customize). Totals include ${n === 1 ? 'it' : 'them'}.`] };
}

// ── Pages (item 21) ──────────────────────────────────────────────────────────
const BODY_KINDS = new Set(['section', 'account', 'line', 'group']);
/**
 * A report's rows as pages of about `pageSize` rows (0 = one page). Never
 * splits a heading from what follows it: a General Ledger account comes whole
 * (heading, lines, closing), a group heading stays with its first account,
 * and a page that starts inside a group repeats its heading, "(continued)".
 * The trailing totals (Net Income, the grand total) are `pinned`: shown under
 * every page, always over ALL rows. Returns { pages: [[rows]], pinned, total }.
 */
export function reportPages(rows, pageSize) {
  let end = rows.length;
  while (end > 0 && !BODY_KINDS.has(rows[end - 1].kind) && !rows[end - 1].section && !rows[end - 1].group) end -= 1;
  const body = rows.slice(0, end);
  const pinned = rows.slice(end);
  const size = Math.floor(Number(pageSize) || 0);
  if (size <= 0 || body.length <= size) return { pages: [body], pinned, total: body.length };
  const units = [];
  let cur = null;
  let pending = [];
  const flush = () => { if (cur) units.push(cur); cur = null; };
  body.forEach((r) => {
    if (r.kind === 'group' || r.kind === 'section') { flush(); pending.push(r); return; }
    const joins = r.kind === 'line' || ((r.section || r.group) && r.kind !== 'account');
    if (joins && (cur || pending.length)) {
      if (!cur) { cur = [...pending, r]; pending = []; } else cur.push(r);
      return;
    }
    flush();
    cur = [...pending, r];
    pending = [];
  });
  flush();
  if (pending.length) units.push(pending);
  const headers = new Map(body.filter((r) => r.kind === 'group').map((r) => [r.group, r]));
  const pages = [];
  let page = [];
  let count = 0;
  const cont = (r) => ({ ...r, continued: true, label: `${r.label} (continued)` });
  units.forEach((u) => {
    // A unit bigger than a page (a General Ledger account with hundreds of
    // lines - Priyanka, 10/07: "the pagination options are not working") is
    // split across pages, its account heading repeated as "(continued)".
    const head = u.find((r) => r.kind === 'section') || null;
    let rest = u;
    while (rest.length) {
      if (count && (count + rest.length > size) && (rest.length <= size || count >= size)) { pages.push(page); page = []; count = 0; }
      if (!page.length) {
        const g = rest[0].group;
        if (g && rest[0].kind !== 'group' && headers.has(g)) page.push(cont(headers.get(g)));
        if (head && rest !== u && rest[0] !== head) page.push(cont(head));
      }
      const room = Math.max(1, size - count);
      const take = rest.slice(0, room);
      page.push(...take);
      count += take.length;
      rest = rest.slice(room);
      if (rest.length) { pages.push(page); page = []; count = 0; }
    }
  });
  if (page.length) pages.push(page);
  return { pages, pinned, total: body.length };
}

// ── Column filters with operators (item 26d) ─────────────────────────────────
export const NUM_OPS = [
  { key: '=', label: '=' }, { key: '>', label: '>' }, { key: '<', label: '<' },
  { key: '>=', label: '>=' }, { key: '<=', label: '<=' }, { key: 'between', label: 'Between' },
];
/** "(3,418.07)" / "-3418.07" / "19.8%" -> a number; NaN when there is none. */
export function parseFigure(text) {
  const t = String(text ?? '').trim();
  if (!t || t === '-') return Number.NaN;
  const neg = /^\(.*\)$/.test(t) || t.startsWith('-');
  const n = Number(t.replace(/[()$%,\s-]/g, ''));
  return Number.isFinite(n) && /\d/.test(t) ? (neg ? -n : n) : Number.NaN;
}
/**
 * Whether a figure passes an amount filter { op, a, b }. An empty value
 * passes everything. "=" with a plain number matches either sign (the
 * statement prints a negative in parentheses); a signed one matches exactly.
 */
export function numberFilterHit(value, f) {
  if (!f) return true;
  const a = parseFigure(f.a);
  const b = parseFigure(f.b);
  const op = f.op || '=';
  if (op === 'between' ? Number.isNaN(a) && Number.isNaN(b) : Number.isNaN(a)) return true;
  const v = typeof value === 'number' ? value : parseFigure(value);
  if (!Number.isFinite(v)) return false;
  const r = (x) => Math.round(x * 100) / 100;
  const x = r(v);
  switch (op) {
    case '>': return x > r(a);
    case '<': return x < r(a);
    case '>=': return x >= r(a) - 0.001;
    case '<=': return x <= r(a) + 0.001;
    case 'between': {
      const lo = Number.isNaN(a) ? -Infinity : Number.isNaN(b) ? r(a) : Math.min(r(a), r(b));
      const hi = Number.isNaN(b) ? Infinity : Number.isNaN(a) ? r(b) : Math.max(r(a), r(b));
      return x >= lo - 0.001 && x <= hi + 0.001;
    }
    default: {
      const signed = /^\s*(-|\()/.test(String(f.a));
      return signed ? Math.abs(x - r(a)) < 0.005 : Math.abs(Math.abs(x) - Math.abs(r(a))) < 0.005;
    }
  }
}

// ── Adjustments on a statement (packages) ────────────────────────────────────
// Add-backs and comments per line before a package goes out (Neil, call of
// 09/29: a $100,000 gate booked as Repairs and Maintenance). `adjustments`:
// [{ account, amount, note }], amount in the statement's own sign (a negative
// amount on an expense takes it out). On a Total Only income statement or
// balance sheet the columns become As Reported, Adjustment, Adjusted and
// Note, with every section total and subtotal moved by what its accounts
// moved. Any other layout gets the Note column only.
export function withAdjustments(result, adjustments) {
  const list = (adjustments || []).filter((a) => a && a.account && (Number(a.amount) || (a.note || '').trim()));
  if (!list.length || !result) return result;
  const byCode = new Map(list.map((a) => [a.account, { amount: round2(a.amount), note: (a.note || '').trim() }]));
  const noteOf = (r) => (r.kind === 'account' ? byCode.get(r.code)?.note || '' : '');
  const amountCols = result.columns.filter((c) => c.type === 'amount');
  const canAmount = amountCols.length === 1 && result.mode === 'single' && ['pnl', 'balance-sheet'].includes(result.config.report) && list.some((a) => Number(a.amount));
  if (!canAmount) {
    return { ...result, adjusted: true, columns: [...result.columns, { key: 'note', label: 'Note', type: 'text' }], rows: result.rows.map((r) => ({ ...r, values: [...r.values, noteOf(r)] })) };
  }
  const at = result.columns.indexOf(amountCols[0]);
  const delta = {};   // section key -> what its accounts moved
  const rows = result.rows.map((r) => {
    if (r.kind !== 'account') return r;
    const d = byCode.get(r.code)?.amount || 0;
    if (r.section) delta[r.section] = round2((delta[r.section] || 0) + d);
    return { ...r, delta: d };
  });
  const d = (k) => delta[k] || 0;
  const sectionOf = (label) => rows.find((r) => r.kind === 'section' && r.section === label);
  const base = (label) => rows.find((r) => r.label === label)?.values[at] || 0;
  const subtotal = {
    'Gross Profit': d('revenue') - d('cogs'),
    'Operating Income': d('revenue') - d('cogs') - d('expense'),
    'Net Income': d('revenue') - d('cogs') - d('expense') + d('other_income') - d('other_expense'),
    'Total Liabilities and Equity': d('liability') + d('equity'),
    'Out of balance by': d('asset') - d('liability') - d('equity'),
  };
  const income = () => (sectionOf('revenue')?.values[at] || 0) + (sectionOf('other_income')?.values[at] || 0) + d('revenue') + d('other_income');
  const out = rows.map((r) => {
    const reported = r.values[at];
    let move = 0;
    if (r.kind === 'account') move = r.delta || 0;
    else if (r.kind === 'section') move = d(r.section);
    else if (r.kind === 'margin') {
      const net = base('Net Income') + subtotal['Net Income'];
      const inc = income();
      const margin = Math.abs(inc) < 0.005 ? Number.NaN : net / inc;
      return { ...r, values: [reported, Number.NaN, margin, ''] };
    } else move = subtotal[r.label] || 0;
    return { ...r, values: [reported, round2(move), round2((reported || 0) + move), noteOf(r)] };
  });
  const columns = [
    { key: 'reported', label: 'As Reported', type: 'amount', drill: amountCols[0].drill },
    { key: 'adjustment', label: 'Adjustment', type: 'variance' },
    { key: 'adjusted', label: 'Adjusted', type: 'amount', emphasis: true },
    { key: 'note', label: 'Note', type: 'text' },
  ];
  return { ...result, adjusted: true, columns, rows: out, summary: [] };
}

/** What one cell shows. `raw` keeps numbers as numbers (for a spreadsheet). */
export function cellText(row, column, value, raw = false) {
  if (column.type === 'text') return value == null ? '' : String(value);
  if (column.type === 'date' || column.type === 'pct') return value || '';
  // A heading with no figure in this column (a General Ledger group heading).
  if (value === '' || value == null) return '';
  if (row.kind === 'margin') return raw ? (Number.isFinite(value) ? Math.round(value * 1000) / 10 : '') : share(value);
  if (column.type === 'variance') return raw ? value : Math.abs(value) < 0.005 ? '-' : money(value);
  return raw ? value : money(value);
}

// The table as it is shown, for the CSV: one header row, then every row.
export function csvRows(result, entities = []) {
  const { config, def, columns } = result;
  const out = [[def.label], [entityText(config, entities)], [periodText(config)], [`Book: ${bookLabel(config.book)}`], [], ['Section', 'Account', 'Title', ...columns.map((c) => c.label)]];
  const cells = (r) => columns.map((c, i) => cellText(r, c, r.values[i], true));
  // A section's total follows its accounts, the way the statement reads.
  let open = null;
  const close = () => { if (open) { out.push([`Total ${open.label}`, '', '', ...cells(open)]); open = null; } };
  result.rows.forEach((r) => {
    if (r.kind === 'section') { close(); open = r; return; }
    if (r.kind === 'account') { out.push([open ? open.label : '', r.code, r.title, ...cells(r)]); return; }
    if (r.kind === 'group') { close(); out.push([r.label]); return; }
    close();
    out.push([r.label, '', '', ...cells(r)]);
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
  const cols = activeColumns(config) === 'total' ? '' : `_${activeColumns(config)}`;
  return `${def.label.replace(/[^A-Za-z]+/g, '-')}_${who}_${config.book}${cols}_${stamp}.csv`;
}

/**
 * The statement's name as a file someone else will find (Charmi, 10/02: "I am
 * not sure where will this be stored?"): "Income Statement - Darshana R.
 * Kadakia MD Inc. (13000) - 01-01-2026 to 12-31-2026.pdf". `format`: pdf,
 * excel (.xlsx) or csv.
 */
export function reportFileName(result, entities = [], format = 'pdf') {
  const { config, def } = result;
  const d = (s) => formatDate(s).replace(/\//g, '-');
  const when = def.period === 'asof' ? `as of ${d(config.asof)}` : `${d(config.from)} to ${d(config.to)}`;
  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const ext = format === 'excel' ? 'xlsx' : format === 'csv' ? 'csv' : 'pdf';
  return `${safe(def.label)} - ${safe(entityText(config, entities))} - ${when}.${ext}`;
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function downloadCsv(name, rows) {
  const text = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  downloadBlob(name, new Blob([String.fromCharCode(0xfeff) + text], { type: 'text/csv;charset=utf-8' }));
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
