// Import Hub payroll (Neil, 10/15: "Payroll export to QB is not there" -
// "HR export and import into QB, as well as the export from QB to Intacct").
// Pure functions behind the two payroll cards in ImportHub.jsx:
//
//  1. Payroll Hours to QuickBooks - hours (Nexus time sheets, or an uploaded
//     hours file) as a QuickBooks Desktop time import (IIF TIMEACT rows, the
//     same layout as /timeclock/export.iif) and as Intacct's statistical
//     hours journal (STAT, the "OSM Payroll Hours Template" layout).
//  2. QuickBooks Payroll to Intacct - a QuickBooks Desktop or QuickBooks
//     Online Payroll Summary (the wide report: one column block per employee)
//     or a long payroll detail export, turned into the Intacct payroll journal
//     (PYRJ, the "OSM Payroll" layout): one balanced entry per employee, plus
//     the STAT hours. QuickBooks Online (Priyanka, 10/22) heads the Amount
//     column with the pay period ("Oct 10 - 23, 26"), names its items Hourly /
//     Overtime and saves an empty "Export Tips" sheet first.
//
// Ported from the stand-alone Import Hub (src/lib/payroll.server.ts): the
// two Intacct column orders, the default payroll item -> GL rules (earnings
// debit expense, employee taxes and deductions credit liabilities, employer
// taxes debit expense AND credit a liability, net pay balances the entry to
// Payroll Liability 23700), the P.REG / P.OHR / P.SHR / P.VHR hour buckets
// and the hours-file item classifier. Everything runs in the browser.

import { parseAmount, parseDate, readSheetFile, usDate } from './statementImport';

/** Intacct GL journal entry import, the full 28-column sheet ("OSM Payroll.csv",
 * backend intacct_gl.py). Its first 15 columns are the statement converter's. */
export const INTACCT_PAYROLL_COLUMNS = [
  'DONOTIMPORT', 'JOURNAL', 'DATE', 'REVERSEDATE', 'DESCRIPTION', 'REFERENCE_NO', 'LINE_NO', 'ACCT_NO', 'LOCATION_ID', 'DEPT_ID', 'DOCUMENT', 'MEMO',
  'DEBIT', 'CREDIT', 'SOURCEENTITY', 'CURRENCY', 'EXCH_RATE_DATE', 'EXCH_RATE_TYPE_ID', 'EXCHANGE_RATE', 'STATE', 'ALLOCATION_ID', 'BILLABLE',
  'RPESENTRY', 'GLENTRY_CUSTOMERID', 'GLENTRY_VENDORID', 'GLENTRY_ITEMID', 'GLENTRY_CLASSID', 'GLENTRY_EMPLOYEEID',
];

/** Intacct statistical journal import ("OSM Payroll Hours Template.csv") -
 * column names copied exactly, the padded INCREASE / DECREASE included. */
export const INTACCT_HOURS_COLUMNS = [
  'DONOTIMPORT', 'DESCRIPTION', 'JOURNAL', 'DATE', 'REVERSEDATE', 'REFERENCE_NO', 'LINE_NO', 'ACCT_NO', 'LOCATION_ID', 'DEPT_ID', 'DOCUMENT', 'MEMO',
  '  INCREASE  ', '  DECREASE  ', 'STATE', 'ALLOCATION_ID', 'GLENTRY_RPESENTRY', 'GLENTRY_CUSTOMERID', 'GLENTRY_VENDORID', 'GLENTRY_ITEMID', 'GLENTRY_CLASSID',
  'GLENTRY_EMPLOYEEID',
];

export const HOUR_BUCKETS = [
  { key: 'P.REG', label: 'Regular Hours' },
  { key: 'P.OHR', label: 'Overtime Hours' },
  { key: 'P.SHR', label: 'Sick Hours' },
  { key: 'P.VHR', label: 'Vacation Hours' },
];

/** How a payroll item posts. */
export const ITEM_KINDS = [
  { key: 'earning', label: 'Earning (Debit Expense)' },
  { key: 'withholding', label: 'Withholding / Deduction (Credit)' },
  { key: 'employer', label: 'Employer Tax / Benefit (Debit and Credit)' },
  { key: 'ignore', label: 'Ignore' },
];

// The stand-alone Import Hub's default rules (defaultEarningRules) with the
// company defaults it seeded (payroll_company_setting), which are also the
// accounts on the OSM payroll file Charmi shared.
export const DEFAULT_PAYROLL_MAPPING = [
  { item: 'Hourly Wages', kind: 'earning', debit: '61905', credit: '', memo: 'Hourly', hours: 'P.REG' },
  { item: 'Overtime Wages', kind: 'earning', debit: '61909', credit: '', memo: 'Overtime', hours: 'P.OHR' },
  // QuickBooks Online's names for the same pay (10/23): same accounts and memos as Desktop.
  { item: 'Hourly', kind: 'earning', debit: '61905', credit: '', memo: 'Hourly', hours: 'P.REG' },
  { item: 'Overtime', kind: 'earning', debit: '61909', credit: '', memo: 'Overtime', hours: 'P.OHR' },
  { item: 'Double Time Wages', kind: 'earning', debit: '61909', credit: '', memo: 'Double Time', hours: 'P.OHR' },
  { item: 'Bonus', kind: 'earning', debit: '61908', credit: '', memo: 'Bonus', hours: '' },
  { item: 'Sick', kind: 'earning', debit: '61906', credit: '', memo: 'Sick', hours: 'P.SHR' },
  { item: 'Sick Hourly', kind: 'earning', debit: '61906', credit: '', memo: 'Sick', hours: 'P.SHR' },
  { item: 'Sick Salary', kind: 'earning', debit: '61906', credit: '', memo: 'Sick', hours: 'P.SHR' },
  { item: 'Vacation', kind: 'earning', debit: '61907', credit: '', memo: 'Vacation', hours: 'P.VHR' },
  { item: 'Vacation Hourly', kind: 'earning', debit: '61907', credit: '', memo: 'Vacation', hours: 'P.VHR' },
  { item: 'Vacation Salary', kind: 'earning', debit: '61907', credit: '', memo: 'Vacation', hours: 'P.VHR' },
  { item: 'Holiday', kind: 'earning', debit: '61905', credit: '', memo: 'Holiday', hours: '' },
  { item: 'Holiday Hourly', kind: 'earning', debit: '61905', credit: '', memo: 'Holiday', hours: '' },
  { item: 'Salary', kind: 'earning', debit: '61910', credit: '', memo: 'Salary', hours: 'P.REG' },
  { item: 'Officers Salary', kind: 'earning', debit: '61904', credit: '', memo: 'Officers Salary', hours: 'P.REG' },
  { item: 'Salary Officers', kind: 'earning', debit: '61904', credit: '', memo: 'Officers Salary', hours: 'P.REG' },
  { item: 'Federal Withholding', kind: 'withholding', debit: '', credit: '23801', memo: 'Federal Withholding', hours: '' },
  { item: 'Medicare Employee', kind: 'withholding', debit: '', credit: '23804', memo: 'Medicare Employee', hours: '' },
  { item: 'Medicare Employee Addl Tax', kind: 'withholding', debit: '', credit: '23804', memo: 'Medicare Employee Addl Tax', hours: '' },
  { item: 'Social Security Employee', kind: 'withholding', debit: '', credit: '23807', memo: 'Social Security Employee', hours: '' },
  { item: 'CA - Withholding', kind: 'withholding', debit: '', credit: '23811', memo: 'CA - Withholding', hours: '' },
  { item: 'CA - Disability Employee', kind: 'withholding', debit: '', credit: '23806', memo: 'CA - Disability Employee', hours: '' },
  { item: '401(k) Contribution', kind: 'withholding', debit: '', credit: '23101', memo: '401(k) Contribution', hours: '' },
  { item: 'Health Insurance', kind: 'withholding', debit: '', credit: '61903', memo: 'Health Insurance', hours: '' },
  { item: 'Health Insurance (taxable)', kind: 'withholding', debit: '', credit: '61903', memo: 'Health Insurance', hours: '' },
  { item: 'Wage Garnishment', kind: 'withholding', debit: '', credit: '61903', memo: 'Wage Garnishment', hours: '' },
  { item: 'Cash Advance', kind: 'withholding', debit: '', credit: '63306', memo: 'Cash Advance', hours: '' },
  { item: 'Construction - (COGS)', kind: 'withholding', debit: '', credit: '50301', memo: 'Construction COGS', hours: '' },
  { item: 'Fuel', kind: 'withholding', debit: '', credit: '63203', memo: 'Fuel', hours: '' },
  { item: 'Federal Unemployment', kind: 'employer', debit: '62101', credit: '23802', memo: 'Federal Unemployment', hours: '' },
  { item: 'Medicare Company', kind: 'employer', debit: '62102', credit: '23805', memo: 'Medicare Company', hours: '' },
  { item: 'Social Security Company', kind: 'employer', debit: '62104', credit: '23808', memo: 'Social Security Company', hours: '' },
  { item: 'CA - Unemployment Company', kind: 'employer', debit: '62105', credit: '23803', memo: 'CA - Unemployment Company', hours: '' },
  { item: 'CA - Federal Unemployment', kind: 'employer', debit: '62105', credit: '23803', memo: 'CA - Federal Unemployment', hours: '' },
  { item: 'CA - Employment Training Tax', kind: 'employer', debit: '62106', credit: '23810', memo: 'CA - Employment Training Tax', hours: '' },
  { item: 'Health Insurance (company contribution)', kind: 'employer', debit: '61903', credit: '23700', memo: 'Health Insurance (company contribution)', hours: '' },
  // QuickBooks Online lists the qualified overtime premium under employer
  // taxes for W-2 reporting only - no money moves, so nothing posts.
  { item: 'Qualified OT Tracking', kind: 'ignore', debit: '', credit: '', memo: 'Qualified OT Tracking', hours: '' },
];

// Default rows added after browsers had saved their own mapping: a saved
// mapping gets them once (savePayrollPrefs then records every default as seen).
const ADDED_DEFAULTS = ['Hourly', 'Overtime', 'Qualified OT Tracking'];

// qbCreateTime (10/27 call item 02): the IIF header's COMPANYCREATETIME, from her QuickBooks Timer Lists export.
export const DEFAULT_PAYROLL_SETTINGS = { journal: 'PYRJ', hoursJournal: 'STAT', location: '', department: '', netPayAccount: '23700', payDate: '', periodStart: '', periodEnd: '', prefix: '', qbCreateTime: '' };

const key = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// Section headings and subtotals on a QuickBooks Payroll Summary: never
// posted, never "unmapped". Net Pay is read separately as the cross-check.
const STRUCTURE = /^(total\b.*|gross pay|adjusted gross pay|net pay|employee wages, taxes and adjustments|employee taxes( and adjustments)?|taxes withheld|deductions from (gross|net) pay|adjustments to net pay|additions to net pay|employer taxes and contributions|hours|rate|amount|employee|payroll item)$/i;

/** "Pat Lee (E-0100)" -> "E-0100"; no code -> ''. */
export function codeFromName(name) {
  const s = String(name || '');
  const m = s.match(/\(\s*([A-Za-z]{0,4}-?\d{2,6})\s*\)\s*$/) || s.match(/\b(E-\d{3,6})\b/i);
  return m ? m[1].toUpperCase() : '';
}

const num = (v) => {
  const n = parseAmount(v);
  return n === null ? null : n;
};
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * A QuickBooks payroll report (rows of strings) -> { format, employees, items,
 * company, period }. Two shapes:
 *   - Payroll Summary (wide): a row naming each employee with a TOTAL column,
 *     under it Hours / Rate / Amount sub-headers, then one row per payroll
 *     item with the label to the left of the first employee block.
 *   - A long export: one row per employee per item, with Employee, Payroll
 *     Item, Hours (optional) and Amount columns.
 * employees: [{ name, code, items: [{ item, hours, amount }], netPay }].
 */
export function parseQbPayroll(rows) {
  const clean = (rows || []).map((r) => (r || []).map((c) => String(c ?? '').trim()));
  // The file's own line (or the sheet's row) for row i - blank rows are dropped
  // before parsing, so a reason names the line the person sees (10/27 item 03).
  const lineOf = (i) => (Array.isArray(rows?.lines) && rows.lines[i] ? rows.lines[i] : i + 1);
  const sheet = rows?.sheet || '';
  const wide = parseWide(clean, lineOf);
  if (wide?.employees.length) return { ...wide, sheet };
  const long = parseLong(clean, lineOf);
  if (long?.employees.length) return { ...long, sheet };
  const problem = wide?.problem || long?.problem || '';
  return { format: 'unknown', employees: [], items: [], company: '', period: '', source: '', sheet, problem, unreadable: [], missing: wide ? wide.missing : missingLongColumns(clean) };
}

const READABLE = /\.(csv|txt|xlsx|xls)$/i;

/** Every sheet's rows (a CSV is one sheet), blank rows dropped; each list keeps
 * `lines` (the 1-based line / row number of each kept row) and its `sheet` name.
 * A file that cannot be opened throws an Error saying so in plain words. */
export async function readPayrollSheets(file) {
  const name = file?.name || 'that file';
  if (!READABLE.test(name)) {
    throw new Error(`${name} is not a spreadsheet. Nexus reads the QuickBooks payroll report saved as Excel (.xlsx or .xls) or CSV - in QuickBooks open the Payroll Summary and use Excel > Create New Worksheet, or Export > CSV.`);
  }
  let sheets;
  try {
    if (/\.(xlsx|xls)$/i.test(name)) {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
      sheets = wb.SheetNames.map((n) => {
        const ws = wb.Sheets[n];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true }).map((r) => r.map((c) => String(c ?? '').trim()));
        rows.sheet = n;
        // The sheet's used range may start below row 1; line numbers count from the sheet's top.
        rows.first = ws?.['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s.r : 0;
        return rows;
      });
    } else {
      sheets = [await readSheetFile(file)];
    }
  } catch (e) {
    throw new Error(`Could not open ${name}: ${e?.message || 'the file is damaged or locked'}. Save it again from QuickBooks as Excel (.xlsx) or CSV and upload that copy.`, { cause: e });
  }
  return sheets.map((rows) => {
    const kept = [];
    kept.lines = [];
    kept.sheet = rows.sheet || '';
    rows.forEach((r, i) => { if (r.some((c) => c !== '')) { kept.push(r); kept.lines.push((rows.first || 0) + i + 1); } });
    return kept;
  });
}

/** A cell that holds something but is not an amount (a lone dash is QuickBooks' blank). */
const unreadableCell = (v) => {
  const s = String(v ?? '').trim();
  return s !== '' && !/^[-–—]$/.test(s) && parseAmount(s) === null;
};

/**
 * What would make the Intacct file wrong even though the report was read, in
 * plain words with the line and column (10/27 call item 03: "never a silent
 * failure"): amounts that could not be read, and people with no payroll
 * items under them. Any of these stops the download.
 */
export function payrollReportProblems(report) {
  const out = [];
  const bad = report?.unreadable || [];
  if (bad.length) {
    const shown = bad.slice(0, 5).map((u) => `line ${u.line}, ${u.item}${u.employee ? ` for ${u.employee}` : ''} ("${u.value}")`);
    out.push(`Could not read ${bad.length === 1 ? 'an amount' : `${bad.length} amounts`} in the report: ${shown.join('; ')}${bad.length > 5 ? `; and ${bad.length - 5} more` : ''}. Fix ${bad.length === 1 ? 'it' : 'them'} in the file and upload it again.`);
  }
  const empty = (report?.employees || []).filter((e) => !e.items.length);
  if (empty.length && empty.length === (report?.employees || []).length) {
    out.push(`Found ${empty.length === 1 ? '1 employee' : `${empty.length} employees`}${report.nameLine ? ` on line ${report.nameLine}` : ''} but no payroll item amounts under them - check the Amount column under each name.`);
  } else if (empty.length) {
    out.push(`No payroll items were read for ${empty.map((e) => e.name).join(', ')} - check their Amount column in the report.`);
  }
  return out;
}

/** The first sheet that reads as a payroll report; otherwise the first non-empty sheet's result, with its `missing` columns. */
export function parsePayrollSheets(sheets) {
  let first = null;
  for (const rows of sheets || []) {
    if (!rows.length) continue;
    const report = parseQbPayroll(rows);
    if (report.employees.length) return report;
    // A sheet whose columns were found explains more than one that has none.
    if (!first || (!first.problem && report.problem)) first = report;
  }
  return first || parseQbPayroll([]);
}

/** The message for a file with no employees, naming the column(s) it lacks - or, when the columns
 * were found, the line where reading stopped. */
export function payrollFileProblem(report) {
  if (report?.problem) return report.problem;
  const missing = report?.missing?.length ? report.missing : LONG_LABELS.map((l) => l[1]);
  const list = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}` : missing[0];
  return `No ${list} column${missing.length > 1 ? 's' : ''} found. Upload the QuickBooks Payroll Summary from QuickBooks Desktop or Online (employees across the top, an Amount column under each) or a payroll detail export with Employee, Payroll Item and Amount columns.`;
}

function parseWide(rows, lineOf = (i) => i + 1) {
  let nameRow = -1;
  for (let r = 0; r < Math.min(rows.length, 15); r += 1) {
    if (rows[r].some((c) => c.toUpperCase() === 'TOTAL')) { nameRow = r; break; }
  }
  if (nameRow < 0) return null;
  const unreadable = [];
  const names = rows[nameRow];
  const starts = [];
  names.forEach((c, i) => { if (c) starts.push(i); });
  const sub = (rows[nameRow + 1] || []).map((c) => c.toLowerCase());
  const subRow = sub.some((c) => /^(hours?|rate|amount)$/.test(c));
  const blocks = [];
  starts.forEach((col, n) => {
    const end = n + 1 < starts.length ? starts[n + 1] : Math.max(sub.length, col + 6);
    const find = (re) => { for (let i = col; i < end; i += 1) if (re.test(sub[i] || '')) return i; return -1; };
    const hasSub = subRow && sub.slice(col, end).some(Boolean);
    const block = {
      col,
      name: names[col],
      hours: hasSub ? find(/^hours?$|^hrs$|^qty$/) : col,
      amount: hasSub ? find(/^amount$|^amt$/) : col + 4,
    };
    if (block.amount < 0 && !hasSub) block.amount = col + 4;
    // QuickBooks Online heads the amount with the pay period: the block's last
    // sub-header that is not Hours or Rate.
    if (block.amount < 0 && hasSub) {
      for (let i = end - 1; i >= col; i -= 1) {
        if (sub[i] && !/^(hours?|hrs|qty|rate)$/.test(sub[i])) { block.amount = i; block.periodHead = rows[nameRow + 1][i]; break; }
      }
    }
    blocks.push(block);
  });
  const people = blocks.filter((b) => b.name.toUpperCase() !== 'TOTAL' && b.amount >= 0);
  if (!people.length) {
    const named = blocks.filter((b) => b.name.toUpperCase() !== 'TOTAL').length;
    return { format: 'unknown', employees: [], items: [], company: '', period: '', source: '', missing: ['Amount'],
      problem: named
        ? `Found ${named === 1 ? 'an employee name' : `${named} employee names`} and TOTAL on line ${lineOf(nameRow)}, but no Amount column under them - line ${lineOf(nameRow + 1)} should read Hours, Rate and Amount (QuickBooks Online puts the pay period where Amount goes).`
        : `Found TOTAL on line ${lineOf(nameRow)} but no employee names beside it. Upload the Payroll Summary with the employees across the top.` };
  }
  const periodHead = people.find((b) => b.periodHead)?.periodHead || '';
  const firstCol = Math.min(...blocks.map((b) => b.col));
  const employees = people.map((b) => ({ name: b.name, code: codeFromName(b.name), items: [], netPay: null }));
  const items = [];
  for (let r = nameRow + (subRow ? 2 : 1); r < rows.length; r += 1) {
    const row = rows[r];
    let label = '';
    for (let c = Math.min(firstCol, row.length) - 1; c >= 0; c -= 1) if (row[c]) { label = row[c]; break; }
    if (!label) continue;
    if (/^net pay$/i.test(label)) {
      people.forEach((b, i) => { employees[i].netPay = num(row[b.amount]); });
      continue;
    }
    if (STRUCTURE.test(label)) continue;
    let any = false;
    people.forEach((b, i) => {
      const amount = num(row[b.amount]);
      if (amount === null && unreadableCell(row[b.amount])) unreadable.push({ line: lineOf(r), item: label, employee: b.name, value: row[b.amount] });
      const hours = b.hours >= 0 && b.hours !== b.amount ? num(row[b.hours]) : null;
      if (amount === null && hours === null) return;
      any = true;
      employees[i].items.push({ item: label, hours: hours ?? 0, amount: amount ?? 0 });
    });
    if (any && !items.includes(label)) items.push(label);
  }
  return {
    format: 'summary',
    employees,
    items,
    company: nameRow > 0 ? rows[0].find(Boolean) || '' : '',
    period: findPeriod(rows.slice(0, nameRow)) || periodHead,
    source: periodHead ? 'online' : 'desktop',
    missing: [],
    unreadable,
    nameLine: lineOf(nameRow),
  };
}

function findPeriod(rows) {
  for (const r of rows) for (const c of r) if (/\d{4}/.test(c) && /(through|to|-|–)/i.test(c) && !/^\d+(\.\d+)?$/.test(c)) return c;
  return '';
}

const LONG = {
  name: ['employee', 'employee name', 'name', 'source name', 'payee'],
  item: ['payroll item', 'item', 'pay item', 'earning', 'earnings code', 'description', 'type'],
  hours: ['hours', 'qty', 'quantity', 'hrs'],
  amount: ['amount', 'amt', 'total', 'current'],
};
const normHead = (h) => String(h || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const LONG_LABELS = [['name', 'Employee'], ['item', 'Payroll Item'], ['amount', 'Amount']];

/** The detail export's required columns absent from its likeliest header row (the one naming the most of them). */
function missingLongColumns(rows) {
  let best = [];
  for (let r = 0; r < Math.min(rows.length, 30); r += 1) {
    const cells = rows[r].map(normHead);
    const found = LONG_LABELS.filter(([k]) => LONG[k].some((n) => cells.includes(n)));
    if (found.length > best.length) best = found;
  }
  return LONG_LABELS.filter((l) => !best.includes(l)).map((l) => l[1]);
}

function guessHeader(rows, need, spec) {
  for (let r = 0; r < Math.min(rows.length, 30); r += 1) {
    const cells = rows[r].map(normHead);
    const idx = {};
    for (const [k, names] of Object.entries(spec)) {
      idx[k] = -1;
      for (const n of names) { const i = cells.indexOf(n); if (i >= 0 && !Object.values(idx).includes(i)) { idx[k] = i; break; } }
    }
    if (need.every((k) => idx[k] >= 0)) return { header: r, idx };
  }
  return null;
}

function parseLong(rows, lineOf = (i) => i + 1) {
  const g = guessHeader(rows, ['name', 'item', 'amount'], LONG);
  if (!g) return null;
  const { idx } = g;
  const byName = new Map();
  const items = [];
  const unreadable = [];
  for (let r = g.header + 1; r < rows.length; r += 1) {
    const row = rows[r];
    const name = row[idx.name] || '';
    const item = row[idx.item] || '';
    if (!name || !item || /^total\b/i.test(name)) continue;
    const amount = num(row[idx.amount]);
    if (amount === null && unreadableCell(row[idx.amount])) unreadable.push({ line: lineOf(r), item, employee: name, value: row[idx.amount] });
    const hours = idx.hours >= 0 ? num(row[idx.hours]) : null;
    if (amount === null && hours === null) continue;
    if (!byName.has(name)) byName.set(name, { name, code: codeFromName(name), items: [], netPay: null });
    const emp = byName.get(name);
    if (/^net pay$/i.test(item)) { emp.netPay = round2((emp.netPay || 0) + (amount || 0)); continue; }
    if (STRUCTURE.test(item)) continue;
    const prev = emp.items.find((x) => key(x.item) === key(item));
    if (prev) { prev.amount = round2(prev.amount + (amount || 0)); prev.hours = round2(prev.hours + (hours || 0)); }
    else emp.items.push({ item, hours: hours || 0, amount: amount || 0 });
    if (!items.includes(item)) items.push(item);
  }
  if (!byName.size) {
    return { format: 'unknown', employees: [], items: [], missing: [],
      problem: unreadable.length
        ? `Found the Employee, Payroll Item and Amount columns on line ${lineOf(g.header)}, but no amount under them could be read - line ${unreadable[0].line} has "${unreadable[0].value}".`
        : `Found the Employee, Payroll Item and Amount columns on line ${lineOf(g.header)}, but no line under it has all three filled in.` };
  }
  return { format: 'detail', employees: [...byName.values()], items, company: '', period: '', source: '', missing: [], unreadable, nameLine: lineOf(g.header) };
}

/** The mapping row for a payroll item (case and spacing ignored), or null. */
export function ruleFor(mapping, item) {
  const k = key(item);
  return (mapping || []).find((m) => key(m.item) === k) || null;
}

/** Report items with an amount and no mapping row (they would be lost - the download waits until they are mapped or ignored). */
export function unmappedItems(employees, mapping) {
  const out = new Map();
  for (const e of employees || []) {
    for (const it of e.items) {
      if (ruleFor(mapping, it.item) || (!it.amount && !it.hours)) continue;
      out.set(it.item, round2((out.get(it.item) || 0) + it.amount));
    }
  }
  return [...out.entries()].map(([item, amount]) => ({ item, amount }));
}

const isoToUs = (iso) => usDate(parseDate(iso));

/** One employee's lookup in the editable employee map (by name), falling back to the code in the name. */
export function employeeInfo(employeeMap, name, fallback = {}) {
  const m = (employeeMap || {})[key(name)] || {};
  return {
    code: m.code ?? fallback.code ?? codeFromName(name),
    vendor: m.vendor ?? fallback.vendor ?? '',
    dept: m.dept ?? fallback.dept ?? '',
  };
}

/**
 * QuickBooks payroll -> Intacct payroll journal entries, one per employee.
 * Earnings debit their expense account (a negative amount - a reversal -
 * credits it). Withholdings and deductions credit their account (QuickBooks
 * prints them negative; the size is what posts). Employer taxes and
 * contributions debit the expense AND credit the liability. The entry closes
 * on the net pay account for whatever is left (normally a credit: the net pay
 * owed). Lines with no account are kept and reported in `missing`.
 */
export function buildPayrollEntries(employees, mapping, settings, employeeMap = {}) {
  const s = { ...DEFAULT_PAYROLL_SETTINGS, ...(settings || {}) };
  const date = isoToUs(s.payDate);
  const entries = [];
  const missing = [];
  for (const emp of employees || []) {
    const info = employeeInfo(employeeMap, emp.name, { code: emp.code, dept: emp.dept, vendor: emp.vendor });
    const dept = info.dept || s.department || '';
    const lines = [];
    const add = (acct, memo, debit, credit, item) => {
      const amt = round2(debit || credit);
      if (!amt) return;
      if (!acct) missing.push({ employee: emp.name, item });
      lines.push({ acct, memo, debit: debit ? round2(debit) : 0, credit: credit ? round2(credit) : 0, dept, vendor: info.vendor, employeeId: info.code });
    };
    let debits = 0;
    let credits = 0;
    for (const it of emp.items) {
      const rule = ruleFor(mapping, it.item);
      if (!rule || rule.kind === 'ignore') continue;
      const amount = round2(Number(it.amount) || 0);
      if (!amount) continue;
      const memo = rule.memo || it.item;
      const abs = Math.abs(amount);
      if (rule.kind === 'earning') {
        if (amount > 0) { add(rule.debit, memo, abs, 0, it.item); debits += abs; } else { add(rule.debit, memo, 0, abs, it.item); credits += abs; }
      } else if (rule.kind === 'withholding') {
        add(rule.credit, memo, 0, abs, it.item); credits += abs;
      } else if (rule.kind === 'employer') {
        add(rule.debit, memo, abs, 0, it.item);
        add(rule.credit, memo, 0, abs, it.item);
      }
    }
    if (!lines.length) continue;
    const net = round2(debits - credits);
    if (net) add(s.netPayAccount, 'Payroll Liability (Net Pay)', net < 0 ? -net : 0, net > 0 ? net : 0, 'Net Pay');
    const who = info.code || emp.name;
    entries.push({
      employee: emp.name,
      code: info.code,
      journal: s.journal,
      date,
      description: `${s.prefix ? `${s.prefix} ` : ''}Payroll ${date || ''} - ${who}`.replace(/\s+/g, ' ').trim().slice(0, 80),
      reference: '',
      netPay: net,
      reportNetPay: emp.netPay,
      lines: lines.map((l, i) => ({ ...l, lineNo: i + 1 })),
    });
  }
  return { entries, missing };
}

/** Debits vs credits, overall and per entry; `unbalanced` lists entries off by a cent or more. */
export function checkBalance(entries) {
  let debit = 0;
  let credit = 0;
  const unbalanced = [];
  for (const e of entries || []) {
    const d = round2(e.lines.reduce((t, l) => t + (Number(l.debit) || 0), 0));
    const c = round2(e.lines.reduce((t, l) => t + (Number(l.credit) || 0), 0));
    debit += d;
    credit += c;
    if (Math.abs(d - c) >= 0.005) unbalanced.push({ employee: e.employee, debit: d, credit: c });
  }
  debit = round2(debit);
  credit = round2(credit);
  return { debit, credit, balanced: unbalanced.length === 0 && Math.abs(debit - credit) < 0.005, unbalanced };
}

/** Entries whose net pay differs from the report's Net Pay row (a payroll item that is mapped to the wrong side, or ignored). */
export function netPayMismatches(entries) {
  return (entries || []).filter((e) => e.reportNetPay !== null && e.reportNetPay !== undefined && Math.abs(Math.abs(e.reportNetPay) - e.netPay) >= 0.005)
    .map((e) => ({ employee: e.employee, report: Math.abs(e.reportNetPay), built: e.netPay }));
}

const money = (n) => (n ? Number(n).toFixed(2) : '');
const hrs = (n) => String(round2(n));

/** Payroll entries -> rows of the 28-column Intacct GL import, header first;
 * the entry's journal, date and description sit on its first line only. */
export function payrollRows(entries, { location = '' } = {}) {
  const C = INTACCT_PAYROLL_COLUMNS;
  const at = (name) => C.indexOf(name);
  const rows = [C.slice()];
  for (const e of entries || []) {
    e.lines.forEach((l, i) => {
      const row = new Array(C.length).fill('');
      if (i === 0) {
        row[at('JOURNAL')] = e.journal || '';
        row[at('DATE')] = e.date || '';
        row[at('DESCRIPTION')] = e.description || '';
        row[at('REFERENCE_NO')] = e.reference || '';
      }
      row[at('LINE_NO')] = String(l.lineNo || i + 1);
      row[at('ACCT_NO')] = l.acct || '';
      row[at('LOCATION_ID')] = location;
      row[at('DEPT_ID')] = l.dept || '';
      row[at('MEMO')] = (l.memo || '').slice(0, 1000);
      row[at('DEBIT')] = money(l.debit);
      row[at('CREDIT')] = money(l.credit);
      row[at('SOURCEENTITY')] = location;
      row[at('GLENTRY_VENDORID')] = l.vendor || '';
      row[at('GLENTRY_EMPLOYEEID')] = l.employeeId || '';
      rows.push(row);
    });
  }
  return rows;
}

/** Hours by Intacct bucket per employee, from the payroll items' Hours bucket in the mapping. */
export function hoursFromPayroll(employees, mapping) {
  return (employees || []).map((emp) => {
    const buckets = { 'P.REG': 0, 'P.OHR': 0, 'P.SHR': 0, 'P.VHR': 0 };
    for (const it of emp.items) {
      const rule = ruleFor(mapping, it.item);
      if (rule?.hours && rule.kind !== 'ignore' && buckets[rule.hours] !== undefined) buckets[rule.hours] = round2(buckets[rule.hours] + (Number(it.hours) || 0));
    }
    return { name: emp.name, code: emp.code, buckets };
  });
}

/** Nexus time-sheet hours (GET /timeclock/export-hours rows) -> the Intacct buckets.
 * Double time is overtime to Intacct; personal leave is paid time off (P.VHR). */
export function hoursFromNexus(rows) {
  return (rows || []).map((r) => {
    const h = r.hours || {};
    return {
      name: r.name, code: r.employeeCode || '', dept: r.department || '', approved: !!r.approved, finalized: r.finalized === true,
      buckets: {
        'P.REG': round2(h.regular || 0),
        'P.OHR': round2((h.overtime || 0) + (h.doubleTime || 0)),
        'P.SHR': round2(h.sick || 0),
        // Paid holiday hours ride with vacation, as classifyHoursItem files them.
        'P.VHR': round2((h.vacation || 0) + (h.personal || 0) + (h.holiday || 0)),
      },
    };
  });
}

/**
 * Hours -> rows of the Intacct statistical journal import (the OSM Payroll
 * Hours Template): ONE entry for the pay period, a line per employee per
 * bucket with hours (zero buckets are left out), the memo naming the pay
 * period, STATE Posted, the vendor and employee ids as dimensions.
 */
export function hoursRows(people, settings, employeeMap = {}) {
  const s = { ...DEFAULT_PAYROLL_SETTINGS, ...(settings || {}) };
  const C = INTACCT_HOURS_COLUMNS;
  const at = (name) => C.indexOf(name);
  const rows = [C.slice()];
  const start = isoToUs(s.periodStart);
  const end = isoToUs(s.periodEnd);
  const memo = start && end ? `Pay Period ${start} - ${end}` : 'Pay Period';
  let n = 0;
  for (const p of people || []) {
    const info = employeeInfo(employeeMap, p.name, { code: p.code, dept: p.dept });
    for (const b of HOUR_BUCKETS) {
      const h = round2(p.buckets?.[b.key] || 0);
      if (!h) continue;
      n += 1;
      const row = new Array(C.length).fill('');
      if (n === 1) {
        row[at('DESCRIPTION')] = `${s.prefix ? `${s.prefix} - ` : ''}Hours - ${memo}`.slice(0, 80);
        row[at('JOURNAL')] = s.hoursJournal || 'STAT';
        row[at('DATE')] = isoToUs(s.payDate) || end;
        row[at('REFERENCE_NO')] = `${s.prefix ? `${s.prefix} - ` : ''}HRs ${end}`.slice(0, 20);
      }
      row[at('LINE_NO')] = String(n);
      row[at('ACCT_NO')] = b.key;
      row[at('LOCATION_ID')] = s.location || '';
      row[at('DEPT_ID')] = info.dept || s.department || '';
      row[at('MEMO')] = memo;
      row[at('  INCREASE  ')] = h > 0 ? hrs(h) : '';
      row[at('  DECREASE  ')] = h < 0 ? hrs(-h) : '';
      row[at('STATE')] = 'Posted';
      row[at('GLENTRY_VENDORID')] = info.vendor || '';
      row[at('GLENTRY_EMPLOYEEID')] = info.code || '';
      rows.push(row);
    }
  }
  return rows;
}

// ── Hours file (QuickBooks "Time by Name", or any timekeeping export) ──────

/** A payroll / service item name -> regular | overtime | doubleTime | sick | vacation (the stand-alone hub's rules, plus double time). */
export function classifyHoursItem(item) {
  const s = String(item || '').toLowerCase();
  if (/double|\bdt\b/.test(s)) return 'doubleTime';
  if (/overtime|\bot\b/.test(s)) return 'overtime';
  if (/sick/.test(s)) return 'sick';
  if (/vacation|pto|holiday|personal/.test(s)) return 'vacation';
  return 'regular';
}

const HOURS_SPEC = {
  name: ['employee', 'employee name', 'name', 'worker'],
  date: ['date', 'work date', 'day', 'txn date', 'transaction date'],
  item: ['payroll item', 'service item', 'pay code', 'earning', 'earning code', 'item', 'type', 'code'],
  hours: ['hours', 'duration', 'qty', 'quantity', 'total hours', 'hrs'],
  job: ['customer job', 'customer', 'job', 'location', 'work site'],
};

/** Long-form hours rows (one row per employee, per day or per item) -> { entries, skipped }. */
export function parseHoursFile(rows) {
  const clean = (rows || []).map((r) => (r || []).map((c) => String(c ?? '').trim()));
  const g = guessHeader(clean, ['name', 'hours'], HOURS_SPEC);
  if (!g) return { entries: [], skipped: 0, found: false };
  const { idx } = g;
  const entries = [];
  let skipped = 0;
  for (const row of clean.slice(g.header + 1)) {
    const name = row[idx.name] || '';
    const hours = num(row[idx.hours]);
    if (!name || /^total\b/i.test(name) || hours === null || !hours) { if (row.some(Boolean)) skipped += 1; continue; }
    entries.push({
      name,
      date: idx.date >= 0 ? parseDate(row[idx.date]) : null,
      item: idx.item >= 0 ? row[idx.item] || '' : '',
      job: idx.job >= 0 ? row[idx.job] || '' : '',
      hours: round2(hours),
    });
  }
  return { entries, skipped, found: true };
}

/** Hours-file entries -> per-employee totals by class and by Intacct bucket. */
export function totalsFromHoursFile(entries) {
  const by = new Map();
  for (const e of entries || []) {
    if (!by.has(e.name)) by.set(e.name, { name: e.name, code: codeFromName(e.name), hours: { regular: 0, overtime: 0, doubleTime: 0, sick: 0, vacation: 0, personal: 0 } });
    const t = by.get(e.name);
    const k = classifyHoursItem(e.item);
    t.hours[k] = round2(t.hours[k] + e.hours);
  }
  return [...by.values()].map((t) => ({ ...hoursFromNexus([{ name: t.name, employeeCode: t.code, hours: t.hours, approved: true }])[0], hours: t.hours }));
}

const PITEM = { regular: 'Regular Pay', overtime: 'Overtime Pay', doubleTime: 'Double-time Pay', sick: 'Sick Pay', vacation: 'Vacation Pay' };
const iifClean = (s) => String(s || '').replace(/[\t\r\n]+/g, ' ').trim();
const iifDate = (p) => (p ? `${p.m}/${p.d}/${p.y}` : '');

/**
 * Hours-file entries -> QuickBooks Desktop IIF time import, the same header
 * and TIMEACT columns as Nexus's /timeclock/export.iif: one row per entry,
 * the payroll item named Regular / Overtime / Double-time / Sick / Vacation
 * Pay, a row with a job billable. An entry without a date takes `fallbackDate`
 * (ISO, the period end).
 */
export function buildIif(entries, { fallbackDate = '', company = 'Greens Global' } = {}) {
  const fb = parseDate(fallbackDate);
  const lines = [
    '!TIMERHDR\tVER\tREL\tCOMPANYNAME\tIMPORTEDBEFORE\tFROMTIMER\tCOMPANYCREATETIME',
    `TIMERHDR\t8\t0\t${iifClean(company)}\tN\tY\t0`,
    '!TIMEACT\tDATE\tJOB\tEMP\tITEM\tPITEM\tDURATION\tPROJ\tNOTE\tXFERTOPAYROLL\tBILLINGSTATUS',
  ];
  for (const e of entries || []) {
    const job = iifClean(e.job);
    lines.push(`TIMEACT\t${iifDate(e.date || fb)}\t${job}\t${iifClean(e.name)}\t\t${PITEM[classifyHoursItem(e.item)]}\t${e.hours.toFixed(2)}\t\t\tY\t${job ? 1 : 0}`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ── Nexus pay periods ──────────────────────────────────────────────────────
// 14 days, Sunday to Saturday, stepping from the server's own Sunday anchor
// (timeclock._PAYPERIOD_ANCHOR, 2024-01-14 - SwipeClock's period series), so
// the Payroll Hours card defaults to a period HR actually finalizes. "The
// last 14 days ending last Saturday" was a week off every other week and
// matched no finalized time sheet at all (10/27 call item 02).
const PERIOD_ANCHOR = Date.UTC(2024, 0, 14);
const DAY_MS = 86400000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The `count` most recent CLOSED pay periods before the one holding `todayIso` (YYYY-MM-DD), newest first. */
export function payPeriods(todayIso, count = 6) {
  const [y, m, d] = String(todayIso || '').split('-').map(Number);
  if (!y || !m || !d) return [];
  const idx = Math.floor((Date.UTC(y, m - 1, d) - PERIOD_ANCHOR) / (14 * DAY_MS));
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    const s = PERIOD_ANCHOR + (idx - i) * 14 * DAY_MS;
    out.push({ start: isoDay(s), end: isoDay(s + 13 * DAY_MS) });
  }
  return out;
}

/** "Amando Lucero, Edgar Carrillo and 3 more" - up to `max` names, then a count. */
export function nameList(names, max = 6) {
  const list = (names || []).filter(Boolean);
  if (list.length <= max) return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : (list[0] || '');
  return `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
}

// ── Remembered per browser ─────────────────────────────────────────────────

const STORE = 'nexus.importhub.payroll.v1';

/** The saved mapping, settings and employee map (defaults when nothing is saved or storage is blocked). */
export function loadPayrollPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
    let mapping = Array.isArray(saved.mapping) && saved.mapping.length ? saved.mapping : DEFAULT_PAYROLL_MAPPING.map((m) => ({ ...m }));
    const seen = new Set(Array.isArray(saved.seen) ? saved.seen : DEFAULT_PAYROLL_MAPPING.map((m) => key(m.item)).filter((k) => !ADDED_DEFAULTS.some((a) => key(a) === k)));
    const fresh = DEFAULT_PAYROLL_MAPPING.filter((m) => !seen.has(key(m.item)) && !ruleFor(mapping, m.item));
    if (fresh.length) mapping = [...mapping, ...fresh.map((m) => ({ ...m }))];
    return {
      mapping,
      settings: { ...DEFAULT_PAYROLL_SETTINGS, ...(saved.settings || {}), payDate: '', periodStart: '', periodEnd: '' },
      employees: saved.employees && typeof saved.employees === 'object' ? saved.employees : {},
    };
  } catch {
    return { mapping: DEFAULT_PAYROLL_MAPPING.map((m) => ({ ...m })), settings: { ...DEFAULT_PAYROLL_SETTINGS }, employees: {} };
  }
}

export function savePayrollPrefs(prefs) {
  try {
    const settings = { ...(prefs.settings || {}) };
    delete settings.payDate;
    delete settings.periodStart;
    delete settings.periodEnd;
    localStorage.setItem(STORE, JSON.stringify({ mapping: prefs.mapping, settings, employees: prefs.employees, seen: DEFAULT_PAYROLL_MAPPING.map((m) => key(m.item)) }));
  } catch { /* a per-browser convenience only */ }
}

export const employeeKey = key;
