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
];
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
];
const BS_COLUMNS = [
  ['total', 'Total Only'], ['entity', 'By Entity'], ['department', 'By Department'], ['month', 'Last 12 Month-Ends'],
  ['quarter', 'Last 4 Quarter-Ends'], ['prior_month', 'vs Prior Month-End'], ['prior_year', 'vs Same Date Last Year'], ['year_end', 'vs Last Year-End'],
];
const pair = (rows) => rows.map(([key, label]) => ({ key, label }));
export const columnModes = (report) => (report === 'pnl' ? pair(PNL_COLUMNS) : report === 'balance-sheet' ? pair(BS_COLUMNS) : pair([['total', 'Total Only']]));
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
export const bookLabel = (key) => BOOKS.find((b) => b.key === key)?.label || 'Accrual';

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
];
/** The kinds behind the Filters button: all of them since 09/30 (department used to have its own dropdown). */
export const POPOVER_DIMS = DIM_KINDS;
export const EMPTY_DIMS = { departments: [], vendor: [], customer: [], employee: [], project: [], item: [] };
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
  return { report: 'pnl', preset: 'ytd', from: f, to: t, asof: iso(now), asofToday: true, book: 'accrual', cols: 'total', entities: [], dims: { ...EMPTY_DIMS }, accounts: [], showZero: false };
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
  c.book = BOOKS.some((b) => b.key === c.book) ? c.book : 'accrual';
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
  c.cols = columnModes(c.report).some((m) => m.key === c.cols) ? c.cols : 'total';
  return c;
}

/** The layout in force: two books side by side leave no room for columns. */
export const activeColumns = (config) => (config.book === 'both' && canPickBook(config) ? 'total' : config.cols);
export const canPickBook = (config) => config.report !== 'cash-position';
export const canUseDims = (config) => config.report !== 'cash-position';
export const canPickAccounts = (config) => config.report === 'pnl' || config.report === 'balance-sheet' || config.report === 'general-ledger';

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
      out.push({ key: `${k.key}:${code}`, label: `${k.label}: ${name ? `${name} (${code})` : code}`, patch: { dims: { ...config.dims, [k.key]: config.dims[k.key].filter((c) => c !== code) } } });
    });
  });
  (config.accounts || []).forEach((code) => {
    out.push({ key: `account:${code}`, label: `Account: ${code}`, patch: { accounts: config.accounts.filter((c) => c !== code) } });
  });
  return out;
}
export function dimsText(config) {
  const out = DIM_KINDS.filter((k) => config.dims[k.key].length)
    .map((k) => (config.dims[k.key].length === 1 ? `${k.label} ${config.dims[k.key][0]}` : `${config.dims[k.key].length} ${k.plural}`));
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

function fetchStatement(api, config, range, book) {
  const { location, dims } = placeOf(config);
  if (config.report === 'pnl') return api.getAccountingPnl(range.from, range.to, location, dims, book);
  if (config.report === 'balance-sheet') return api.getAccountingBalanceSheet(range.asof, location, dims, book);
  if (config.report === 'cash-position') return api.getAccountingCashPosition(range.asof, location, config.entities.length > 1 ? config.entities : undefined);
  return api.getAccountingTrialBalance(range.from, range.to, location, dims, book);
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
  const { rows, folded } = foldBuckets(mode, data.rows || []);
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
  SECTIONS[report].forEach(([key, label]) => {
    const byAccount = new Map();
    cols.forEach((c, i) => {
      (c.sections.find((s) => s.key === key)?.accounts || []).forEach((a) => {
        const cur = byAccount.get(keyOf(a)) || { code: a.account_no || '', title: a.title, values: new Array(n).fill(0) };
        cur.values[i] = round2(cur.values[i] + (a.amount || 0));
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
    shown.forEach((a) => rows.push({ kind: 'account', section: key, code: a.code, title: a.title, values: across(a.values) }));
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
  return { columns, rows, summary, pickable };
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
      return { kind: 'account', code, title: (r || c).title, values: [r?.opening || 0, r?.debit || 0, r?.credit || 0, r?.closing || 0, ...(both ? [c?.closing || 0] : [])] };
    });
    if (!config.showZero) rows = rows.filter((r) => r.values.some((v) => Math.abs(v) >= 0.005));
    rows.push({ kind: 'grand', label: 'Total', values: [a.totals.opening, a.totals.debit, a.totals.credit, a.totals.closing, ...(both ? [b.totals.closing] : [])] });
    const columns = ['Opening', 'Debit', 'Credit', 'Closing'].map((label, i) => ({ key: label.toLowerCase(), label: both && i === 3 ? 'Closing (Accrual)' : label, type: 'amount', drill: drillCur }));
    if (both) columns.push({ key: 'cash-closing', label: 'Closing (Cash)', type: 'amount', drill: { ...drillCur, book: 'cash' } });
    return { ...base, org: a.org || '', generatedAt: a.generated_at || '', mode: both ? 'books' : 'single', columns, rows };
  }

  if (config.report === 'general-ledger') return { ...base, ...(await generalLedger(api, config, book, drillCur)) };

  const read = await readColumns(api, config, entities);
  return { ...base, org: read.cols[0]?.org || '', generatedAt: read.cols[0]?.generatedAt || '', mode: read.mode, otherLabel: read.otherLabel || '', ...layout(config, read) };
}

// ── The General Ledger ───────────────────────────────────────────────────────
// Every account's activity for the period, line by line (Charmi, call of
// 09/29: the one report missing from the list). Per account: the opening
// balance (from the trial balance), each posted line with a running balance,
// the closing balance. Lines come from the ledger search, one read per
// account, so the detail is listed for up to GL_MAX_ACCOUNTS accounts at a
// time - more than that, or nothing picked on a busy ledger, and the accounts
// are listed with their opening, activity and closing only, with a note to
// pick the ones to open. Entities narrow the lines; the other filters narrow
// the balances only (the line search does not know them), and the report
// says so.
const glSigned = (r) => round2((r.debit || 0) - (r.credit || 0));
async function generalLedger(api, config, book, drillCur) {
  const { location, dims } = placeOf(config);
  const tb = await api.getAccountingTrialBalance(config.from, config.to, location, dims, book);
  const wanted = config.accounts?.length ? new Set(config.accounts) : null;
  let accounts = (tb.rows || []).filter((r) => !wanted || wanted.has(r.account_no));
  if (!config.showZero) accounts = accounts.filter((r) => [r.opening, r.debit, r.credit, r.closing].some((v) => Math.abs(v || 0) >= 0.005));
  accounts.sort((a, b) => a.account_no.localeCompare(b.account_no, 'en-US', { numeric: true }));
  const pickable = (tb.rows || []).map((r) => ({ code: r.account_no, title: r.title, section: 'Accounts' }));
  const detail = accounts.length > 0 && accounts.length <= GL_MAX_ACCOUNTS;
  const place = config.entities.length === 1 ? { location: config.entities[0] } : config.entities.length ? { locations: config.entities.join(',') } : {};
  const lines = detail
    ? await Promise.all(accounts.map((a) => api.searchAccountingLedger({ account: a.account_no, from: config.from, to: config.to, book: book === 'cash' ? 'cash' : 'accrual', ...place, limit: GL_MAX_LINES, offset: 0 })))
    : [];
  const columns = [
    { key: 'entry', label: 'Entry', type: 'text' }, { key: 'description', label: 'Description', type: 'text' }, { key: 'entity', label: 'Entity', type: 'text' },
    { key: 'debit', label: 'Debit', type: 'amount' }, { key: 'credit', label: 'Credit', type: 'amount' }, { key: 'balance', label: 'Balance', type: 'amount' },
  ];
  const rows = [];
  let totalDebit = 0;
  let totalCredit = 0;
  let cut = 0;
  accounts.forEach((a, i) => {
    const key = a.account_no;
    const got = lines[i];
    // Lines come newest first from the search; a ledger reads oldest first.
    const list = [...(got?.rows || [])].sort((x, y) => (x.entry_date || '').localeCompare(y.entry_date || '') || (x.entry_no || '').localeCompare(y.entry_no || '', 'en-US', { numeric: true }));
    if (got && got.total > list.length) cut += got.total - list.length;
    rows.push({ kind: 'section', section: key, code: key, label: `${key} ${a.title}`, count: list.length, values: ['', detail ? 'Opening balance' : '', '', round2(a.debit), round2(a.credit), round2(a.opening)], drill: drillCur });
    let running = round2(a.opening || 0);
    list.forEach((l) => {
      running = round2(running + glSigned(l));
      rows.push({ kind: 'line', section: key, label: formatDate(l.entry_date), entryId: l.entry_id, values: [l.entry_no || '', l.description || l.memo || '', l.location_name || l.location || '', round2(l.debit), round2(l.credit), running] });
    });
    if (detail) rows.push({ kind: 'subtotal', section: key, label: 'Closing balance', values: ['', '', '', round2(a.debit), round2(a.credit), round2(a.closing)] });
    totalDebit = round2(totalDebit + (a.debit || 0));
    totalCredit = round2(totalCredit + (a.credit || 0));
  });
  rows.push({ kind: 'grand', label: `Total - ${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}`, values: ['', '', '', totalDebit, totalCredit, round2(tb.totals?.closing || 0)] });
  const notes = [];
  if (!detail && accounts.length) notes.push(`${accounts.length} accounts have activity - the lines are listed for up to ${GL_MAX_ACCOUNTS} accounts at a time. Pick the accounts to open under Accounts.`);
  if (cut) notes.push(`${cut.toLocaleString('en-US')} more lines were not listed (${GL_MAX_LINES.toLocaleString('en-US')} per account at most). Narrow the period for the whole run.`);
  if (dimsText({ ...config, accounts: [] }).length) notes.push('Department, vendor, customer, employee, Project-Job and item filters narrow the balances; the lines listed are the account\'s whole activity for the entities and period.');
  const summary = [
    { label: 'Debits', value: money(totalDebit), amount: totalDebit }, { label: 'Credits', value: money(totalCredit), amount: totalCredit },
    { label: 'Lines', value: rows.filter((r) => r.kind === 'line').length.toLocaleString('en-US') },
  ];
  return { org: tb.org || '', generatedAt: tb.generated_at || '', mode: 'ledger', columns, rows, summary, pickable, notes, glLabel: 'Date / Account' };
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
