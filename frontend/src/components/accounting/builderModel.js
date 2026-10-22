import { formatDate } from '../../lib/datetime';
import {
  BOOKS, DIM_KINDS, EMPTY_DIMS, bucketLabel, fetchBuckets, isUserBook, iso, presetLabel, resolveConfig, sortKeys, trialBalanceLines,
} from './reportModel';

// Accounting -> Reports -> Report Builder (Neil, 10/22 call, item 05: "I want
// to select these GLs. I want to bring it all in. And then you get your
// custom report the way you need. Lets you select dimensions and GLs" - in
// place of Intacct's paid custom-report module). Item 11: the same builder
// takes named ROW GROUPS mapped to GL accounts, so Charmi builds a Schedule C
// herself - no Schedule C lines live in code.
//
// A builder report is a memorized report whose config says so: `kind:
// 'builder'`, `version: 1`. Every other memorized report (a statement's
// controls) has no `kind` and loads exactly as before. The config keeps the
// controls, never the figures:
//   { kind, version, period: 'range' | 'asof', preset, from?, to?, asof?, asofToday?,
//     book, cols, entities, dims, accounts: [code], groups: [{ name, accounts: [code] }], showZero? }
// `accounts` are listed one by one; a group's accounts are listed under it
// with its total. Nothing picked and no groups = every account with activity.
//
// The figures come from the same read the statements use (GET
// /accounting/reports/buckets: debits and credits per account, with the
// entity and dimension filters), so a person limited to certain entities
// reads only those here too - the backend narrows every read.

export const BUILDER_KIND = 'builder';
export const BUILDER_VERSION = 1;
export const isBuilderConfig = (c) => !!c && typeof c === 'object' && c.kind === BUILDER_KIND;

/** The column layouts offered. Each is one read of the buckets; as of a date is a single column. */
export const BUILDER_COLUMNS = [
  { key: 'total', label: 'Total Only' }, { key: 'month', label: 'By Month' }, { key: 'quarter', label: 'By Quarter' },
  { key: 'year', label: 'By Year' }, { key: 'entity', label: 'By Entity' }, { key: 'department', label: 'By Department' },
];
export const BUILDER_PERIODS = [{ key: 'range', label: 'For a Period' }, { key: 'asof', label: 'As of a Date' }];

// The statement sections the ledger tags accounts with, in words for the pickers.
export const SECTION_LABEL = {
  revenue: 'Revenue', cogs: 'Cost of Sales', expense: 'Operating Expenses', other_income: 'Other Income', other_expense: 'Other Expenses',
  asset: 'Assets', liability: 'Liabilities', equity: 'Equity',
};
const SECTION_ORDER = Object.keys(SECTION_LABEL);
// An account shows in its normal balance, the way the statements show it.
const CREDIT_SIDE = new Set(['revenue', 'other_income', 'liability', 'equity']);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const codes = (list) => [...new Set((Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];

export function defaultBuilder(now = new Date()) {
  return resolveBuilder({}, now);
}

/** A builder config as it should run today: a named period moves with the calendar, like a memorized statement. */
export function resolveBuilder(config, now = new Date()) {
  const c = config && typeof config === 'object' ? config : {};
  const period = c.period === 'asof' ? 'asof' : 'range';
  // The period, book, entities and dimension filters normalize the way a statement's do.
  const base = resolveConfig({
    report: period === 'asof' ? 'balance-sheet' : 'pnl',
    preset: c.preset, from: c.from, to: c.to, asof: c.asof, asofToday: c.asofToday, book: c.book, entities: c.entities, dims: c.dims,
  }, now);
  const seen = new Set();
  const groups = (Array.isArray(c.groups) ? c.groups : []).filter((g) => g && typeof g === 'object').map((g) => {
    // An account sits in one group only: the first that claims it.
    const accounts = codes(g.accounts).filter((a) => !seen.has(a));
    accounts.forEach((a) => seen.add(a));
    return { name: String(g.name || '').slice(0, 120), accounts };
  });
  return {
    kind: BUILDER_KIND, version: BUILDER_VERSION, period,
    preset: base.preset, from: base.from, to: base.to, asof: base.asof, asofToday: base.asofToday,
    book: base.book === 'both' ? 'accrual' : base.book,
    cols: period === 'range' && BUILDER_COLUMNS.some((m) => m.key === c.cols) ? c.cols : 'total',
    entities: base.entities, dims: base.dims,
    accounts: codes(c.accounts), groups, showZero: !!c.showZero,
  };
}

/** What a saved builder report keeps (the controls, never the figures). */
export function storableBuilder(c) {
  const r = resolveBuilder(c);
  return {
    kind: BUILDER_KIND, version: BUILDER_VERSION, period: r.period, preset: r.preset,
    ...(r.preset === 'custom' ? { from: r.from, to: r.to } : {}),
    ...(r.period === 'asof' && r.asofToday === false ? { asof: r.asof, asofToday: false } : {}),
    book: r.book, cols: r.cols, entities: r.entities, dims: r.dims, accounts: r.accounts,
    groups: r.groups.map((g) => ({ name: g.name, accounts: g.accounts })), ...(r.showZero ? { showZero: true } : {}),
  };
}

/** Every account the report lists: the picked ones and every group's. Empty = all of them. */
export function includedAccounts(config) {
  return [...new Set([...(config.accounts || []), ...(config.groups || []).flatMap((g) => g.accounts || [])])];
}

/**
 * A statement-shaped config for the export helpers (Excel, CSV, PDF read the
 * title, entity, period and book line from it).
 */
export function exportConfig(c) {
  const st = resolveConfig({ report: c.period === 'asof' ? 'balance-sheet' : 'pnl', preset: c.preset, from: c.from, to: c.to, asof: c.asof, asofToday: c.asofToday, book: c.book, entities: c.entities, dims: c.dims, cols: c.cols });
  return { ...st, accounts: includedAccounts(c) };
}

/**
 * Lay the report out (pure - the figures are already read).
 *   cols:     [{ key, label }] - the data columns
 *   accounts: [{ code, title, section, values: [one per data column] }] - normal-balance figures
 *   titles:   { code: title } for picked accounts with nothing in the period
 * Each group is a section row carrying its total, its accounts under it; the
 * accounts in no group follow (under "Accounts Not in a Group" when there are
 * groups); then the Grand Total. With two or more data columns a Total column follows.
 */
export function layoutBuilder(config, cols, accounts, titles = {}) {
  const n = cols.length;
  const columns = cols.map((c) => ({ key: c.key, label: c.label, type: 'amount' }));
  if (n > 1) columns.push({ key: 'total', label: 'Total', type: 'amount', emphasis: true });
  const across = (v) => (n > 1 ? [...v, round2(v.reduce((s, x) => s + x, 0))] : v);
  const zeros = () => new Array(n).fill(0);
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const lineOf = (code) => byCode.get(code) || { code, title: titles[code] || '', section: '', values: zeros() };
  const shows = (a) => config.showZero || a.values.some((v) => Math.abs(v) >= 0.005);
  const byNumber = (x, y) => x.code.localeCompare(y.code, 'en-US', { numeric: true });
  const grand = zeros();
  const addTo = (sum, values) => values.forEach((v, i) => { sum[i] = round2(sum[i] + v); });
  const rows = [];
  const grouped = new Set();

  (config.groups || []).forEach((g, gi) => {
    const key = `grp-${gi}`;
    const lines = (g.accounts || []).map(lineOf).sort(byNumber);
    lines.forEach((a) => grouped.add(a.code));
    const total = zeros();
    lines.forEach((a) => addTo(total, a.values));
    addTo(grand, total);
    const shown = lines.filter(shows);
    // A group is always listed, even at zero: it is a line of the report someone defined.
    rows.push({ kind: 'section', section: key, label: g.name || `Group ${gi + 1}`, count: shown.length, values: across(total) });
    shown.forEach((a) => rows.push({ kind: 'account', section: key, code: a.code, title: a.title, values: across(a.values) }));
  });

  const picked = includedAccounts(config);
  const rest = (picked.length ? picked.filter((c) => !grouped.has(c)).map(lineOf) : accounts.filter((a) => !grouped.has(a.code))).sort(byNumber);
  rest.forEach((a) => addTo(grand, a.values));
  const restShown = rest.filter(shows);
  if (restShown.length && rows.length) rows.push({ kind: 'group', group: 'ungrouped', label: 'Accounts Not in a Group', values: new Array(columns.length).fill('') });
  restShown.forEach((a) => rows.push({ kind: 'account', code: a.code, title: a.title, values: across(a.values) }));
  rows.push({ kind: 'grand', label: 'Grand Total', values: across(grand) });
  return { columns, rows };
}

/** One account's figure in its normal balance from a bucket row. */
const normal = (section, debit, credit) => round2(CREDIT_SIDE.has(section) ? (Number(credit) || 0) - (Number(debit) || 0) : (Number(debit) || 0) - (Number(credit) || 0));
const statementOf = (config) => ({ report: 'pnl', entities: config.entities, dims: config.dims });

/** The chart of accounts the pickers offer: every account posted to up to today, by section. */
export async function readChart(api, now = new Date()) {
  const d = await fetchBuckets(api, { report: 'pnl', entities: [], dims: { ...EMPTY_DIMS } }, { from: undefined, to: iso(now) }, 'total', 'accrual');
  const seen = new Map();
  (d?.rows || []).forEach((r) => { if (r.account_no && !seen.has(r.account_no)) seen.set(r.account_no, { code: r.account_no, title: r.title || '', sectionKey: r.section || '' }); });
  return [...seen.values()]
    .sort((x, y) => (SECTION_ORDER.indexOf(x.sectionKey) - SECTION_ORDER.indexOf(y.sectionKey)) || x.code.localeCompare(y.code, 'en-US', { numeric: true }))
    .map((a) => ({ code: a.code, title: a.title, section: SECTION_LABEL[a.sectionKey] || 'Other' }));
}

/**
 * Read the ledger for a builder config and lay it out. Returns a result the
 * export helpers take like a statement's: { config (statement-shaped), def,
 * org, generatedAt, columns, rows, summary, builder }.
 */
export async function runBuilder(api, config, { name = '', entities = [], chart = [] } = {}) {
  const c = resolveBuilder(config);
  const book = isUserBook(c.book) || BOOKS.some((b) => b.key === c.book) ? c.book : 'accrual';
  const titles = Object.fromEntries((chart || []).map((a) => [a.code, a.title]));
  let cols;
  let accounts;
  let org;
  let generatedAt;
  if (c.period === 'asof') {
    // Balance sheet accounts through the date; income and expense accounts for
    // the year to that date - the trial balance's rule (trialBalanceLines).
    const before = `${Number(c.asof.slice(0, 4)) - 1}-12-31`;
    const [through, prior] = await Promise.all([
      fetchBuckets(api, statementOf(c), { from: undefined, to: c.asof }, 'total', book),
      fetchBuckets(api, statementOf(c), { from: undefined, to: before }, 'total', book),
    ]);
    const sectionOf = new Map((through?.rows || []).map((r) => [r.account_no, r.section]));
    cols = [{ key: 'cur', label: `As of ${formatDate(c.asof)}` }];
    accounts = trialBalanceLines(through?.rows || [], prior?.rows || [], c.asof)
      .filter((l) => l.code)
      .map((l) => ({ code: l.code, title: l.title, section: sectionOf.get(l.code) || '', values: [round2(CREDIT_SIDE.has(sectionOf.get(l.code)) ? -l.balance : l.balance)] }));
    org = through?.org || '';
    generatedAt = through?.generated_at || '';
  } else {
    const d = await fetchBuckets(api, statementOf(c), { from: c.from, to: c.to }, c.cols, book, entities);
    const rows = d?.rows || [];
    const labels = d?.labels || {};
    const keys = c.cols === 'total' ? [rows[0]?.bucket ?? 'total'] : sortKeys(c.cols, [...new Set(rows.map((r) => r.bucket))], labels);
    cols = c.cols === 'total'
      ? [{ key: 'cur', label: `${formatDate(c.from)} - ${formatDate(c.to)}` }]
      : keys.map((k) => ({ key: k || '~none', label: bucketLabel(c.cols, k, labels) }));
    if (!cols.length) cols = [{ key: 'cur', label: `${formatDate(c.from)} - ${formatDate(c.to)}` }];
    const at = new Map(keys.map((k, i) => [k, i]));
    const byCode = new Map();
    rows.forEach((r) => {
      if (!r.account_no) return;
      const i = c.cols === 'total' ? 0 : at.get(r.bucket);
      if (i === undefined) return;
      const cur = byCode.get(r.account_no) || { code: r.account_no, title: r.title || '', section: r.section || '', values: new Array(cols.length).fill(0) };
      cur.values[i] = round2(cur.values[i] + normal(r.section, r.debit, r.credit));
      byCode.set(r.account_no, cur);
    });
    accounts = [...byCode.values()];
    org = d?.org || '';
    generatedAt = d?.generated_at || '';
  }
  accounts.forEach((a) => { if (!a.title && titles[a.code]) a.title = titles[a.code]; });
  const { columns, rows } = layoutBuilder(c, cols, accounts, titles);
  return {
    config: exportConfig(c), def: { key: 'builder', label: name || 'Custom Report', period: c.period },
    org, generatedAt: generatedAt || new Date().toISOString(), mode: 'single', otherLabel: '', columns, rows, summary: [], pickable: [], builder: c,
  };
}

/** One line of what a builder report is, for the Report Center and the header. */
export function builderSummary(config, entities = []) {
  const c = resolveBuilder(config);
  const period = c.period === 'asof'
    ? (c.asofToday === false ? `As of ${formatDate(c.asof)}` : 'As of today')
    : c.preset === 'custom' ? `${formatDate(c.from)} - ${formatDate(c.to)}` : presetLabel(c.preset);
  const ent = !c.entities.length ? 'All entities' : c.entities.length > 1 ? `${c.entities.length} entities`
    : (() => { const e = entities.find((x) => x.code === c.entities[0]); return e?.name ? `${e.name} (${e.code})` : c.entities[0]; })();
  const accts = includedAccounts(c).length;
  const filters = DIM_KINDS.reduce((s, k) => s + ((c.dims?.[k.key] || []).length ? 1 : 0), 0);
  return [
    period, ent,
    accts ? `${accts} ${accts === 1 ? 'account' : 'accounts'}` : 'Every account',
    c.groups.length ? `${c.groups.length} row ${c.groups.length === 1 ? 'group' : 'groups'}` : '',
    filters ? `${filters} ${filters === 1 ? 'filter' : 'filters'}` : '',
    c.cols !== 'total' ? BUILDER_COLUMNS.find((m) => m.key === c.cols)?.label : '',
  ].filter(Boolean).join(' · ');
}
