import { formatDate } from '../../lib/datetime';
import { bucketLabel, fetchBuckets, iso, monthKeys, parse, sortKeys } from './reportModel';

// Accounting -> Reports -> Spend by Vendor (Charmi, 10/27 triage item 17:
// "There should be an ability to pull a report be vendor name"). One heading
// per vendor - its number and name - with what it was paid for underneath:
// every cost of sales and expense account the vendor's lines posted to, by
// period, and a Total. Every account amount opens the lines behind it (that
// vendor, that account, that period); the Vendors button and Filters narrow
// the vendors by name or number. Read only, from the ledger synced into
// Nexus Accounting - nothing here writes anywhere.
//
// The accounting app sums by ONE dimension per read, so a run of periods is
// one vendor read per period (at most SPEND_MAX_COLUMNS of them, a few at a
// time). Loaded on first use (reportModel runReport).

/** The income statement sections that count as spend: cost of sales and expenses. */
export const SPEND_SECTIONS = ['cogs', 'expense', 'other_expense'];
/** Most period columns one run reads (one ledger read each). */
export const SPEND_MAX_COLUMNS = 24;
const AT_ONCE = 4;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const endOfMonth = (y, m) => new Date(y, m + 1, 0);

/**
 * The period columns of [from, to] for a layout, latest first like every
 * period column on Reports: [{ key, from, to, label }]. `total` is one column.
 * Each window is cut to [from, to] (a Year-to-Date's year ends today).
 */
export function spendPeriods(from, to, mode) {
  if (mode !== 'month' && mode !== 'quarter' && mode !== 'year') return [{ key: 'cur', from, to, label: `${formatDate(from)} - ${formatDate(to)}` }];
  const span = mode === 'month' ? 1 : mode === 'quarter' ? 3 : 12;
  const starts = [...new Set(monthKeys(from, to).map((k) => {
    const d = parse(k);
    const m = mode === 'month' ? d.getMonth() : mode === 'quarter' ? Math.floor(d.getMonth() / 3) * 3 : 0;
    return iso(new Date(d.getFullYear(), m, 1));
  }))];
  return sortKeys(mode, starts).map((key) => {
    const d = parse(key);
    const end = iso(endOfMonth(d.getFullYear(), d.getMonth() + span - 1));
    return { key, from: key < from ? from : key, to: end > to ? to : end, label: bucketLabel(mode, key) };
  });
}

/**
 * The report from one vendor read per period (`reads[i]` = the buckets
 * answer for `periods[i]`: { rows: [{ account_no, title, section, bucket,
 * debit, credit }], labels: { code: name } }). `picked`: vendor codes the
 * filter holds (a stray bucket outside them never adds in).
 * Returns { columns, rows, summary, notes, labelHead, startFolded }.
 */
export function spendLayout(reads, periods, { book = 'accrual', picked = [] } = {}) {
  const n = periods.length;
  const keep = picked.length ? new Set(picked) : null;
  const labels = {};
  const vendors = new Map();   // code ('' = no vendor) -> { code, accounts: Map }
  reads.forEach((d, i) => {
    Object.assign(labels, d?.labels || {});
    (d?.rows || []).forEach((r) => {
      if (!SPEND_SECTIONS.includes(r.section)) return;
      const code = r.bucket || '';
      if (keep && code && !keep.has(code)) return;
      const amount = round2((Number(r.debit) || 0) - (Number(r.credit) || 0));
      if (!amount) return;
      const v = vendors.get(code) || { code, accounts: new Map() };
      const key = r.account_no || `~${r.title}`;
      const a = v.accounts.get(key) || { code: r.account_no || '', title: r.title || '', values: new Array(n).fill(0) };
      a.values[i] = round2(a.values[i] + amount);
      v.accounts.set(key, a);
      vendors.set(code, v);
    });
  });
  const many = n > 1;
  const sum = (list) => list.reduce((s, x) => s + x, 0);
  const across = (v) => (many ? [...v, round2(sum(v))] : v);
  const columns = periods.map((p) => ({ key: p.key, label: p.label, type: 'amount' }));
  if (many) columns.push({ key: 'total', label: 'Total', type: 'amount', emphasis: true });
  const windows = [...periods, ...(many ? [{ from: periods[periods.length - 1].from, to: periods[0].to }] : [])];
  const nameOf = (code) => (labels[code] && labels[code] !== code ? labels[code] : '');
  const vendorLabel = (code) => (code ? [code, nameOf(code)].filter(Boolean).join(' ') : 'No Vendor');

  const list = [...vendors.values()].map((v) => {
    const accounts = [...v.accounts.values()].sort((x, y) => x.code.localeCompare(y.code, 'en-US', { numeric: true }));
    const totals = new Array(n).fill(0).map((_z, i) => round2(sum(accounts.map((a) => a.values[i]))));
    return { ...v, accounts, totals, total: round2(sum(totals)) };
  });
  // The largest spend first; lines with no vendor last.
  list.sort((a, b) => (!a.code ? 1 : !b.code ? -1 : b.total - a.total || vendorLabel(a.code).localeCompare(vendorLabel(b.code), 'en-US', { numeric: true })));

  const rows = [];
  list.forEach((v) => {
    const group = `v:${v.code || '~none'}`;
    const label = vendorLabel(v.code);
    const party = v.code ? { kind: 'vendor', code: v.code, name: nameOf(v.code) || v.code } : null;
    rows.push({ kind: 'group', group, label, count: v.accounts.length, values: columns.map(() => ''), totals: across(v.totals), noDrill: true });
    v.accounts.forEach((a) => rows.push({
      kind: 'account', group, code: a.code, title: a.title, match: label, values: across(a.values),
      // That vendor's lines on that account in that column's window. Lines
      // with no vendor cannot be narrowed to, so they do not drill.
      ...(party ? { drills: windows.map((w) => ({ from: w.from, to: w.to, book, party })) } : { noDrill: true }),
    }));
    rows.push({ kind: 'subtotal', group, label: `Total ${label}`, values: across(v.totals), noDrill: true });
  });
  const grand = new Array(n).fill(0).map((_z, i) => round2(sum(list.map((v) => v.totals[i]))));
  if (list.length) rows.push({ kind: 'grand', label: 'Total Spend', values: across(grand), noDrill: true });
  const named = list.filter((v) => v.code);
  const none = list.find((v) => !v.code);
  const summary = [
    { label: 'Vendors', value: named.length.toLocaleString('en-US') },
    { label: 'Total Spend', amount: round2(sum(grand)) },
    ...(named[0] ? [{ label: 'Largest', value: vendorLabel(named[0].code) }] : []),
    ...(none ? [{ label: 'No Vendor', amount: none.total }] : []),
  ];
  return {
    columns, rows, summary, labelHead: 'Vendor / Account', startFolded: true,
    notes: ['Spend is what posted to cost of sales and expense accounts, by the vendor on each line; lines with no vendor (payroll, journal entries) are under No Vendor. Click a vendor to see its accounts, and any amount for the lines behind it.'],
  };
}

/** Read and lay out Spend by Vendor for one config (see runReport). */
export async function vendorSpend(api, config, book) {
  const mode = ['month', 'quarter', 'year'].includes(config.cols) ? config.cols : 'total';
  const periods = spendPeriods(config.from, config.to, mode);
  if (periods.length > SPEND_MAX_COLUMNS) {
    throw new Error(`That is ${periods.length} columns - pick By Quarter or By Year, or a shorter period (up to ${SPEND_MAX_COLUMNS}).`);
  }
  const reads = new Array(periods.length);
  for (let i = 0; i < periods.length; i += AT_ONCE) {
    const batch = periods.slice(i, i + AT_ONCE);
    const got = await Promise.all(batch.map((p) => fetchBuckets(api, config, { from: p.from, to: p.to }, 'vendor', book)));
    got.forEach((d, j) => { reads[i + j] = d; });
  }
  const org = reads.find((d) => d?.org)?.org || '';
  const generatedAt = reads.find((d) => d?.generated_at)?.generated_at || '';
  return { org, generatedAt, mode: periods.length > 1 ? 'buckets' : 'single', pickable: [], ...spendLayout(reads, periods, { book, picked: config.dims?.vendor || [] }) };
}
