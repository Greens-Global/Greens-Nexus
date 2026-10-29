// Accounting > Reporting > Employee Compensation (Neil, 10/15; rebuilt from
// the Intacct ledger after the 10/27 call with Charmi, items 11-19): the pure
// side of the report - the lines of Intacct's Employee Compensation Report,
// Time Clock's hours beside them, the groupings, the accounts behind a figure
// (the drill-down) and one person's statement. The figures come added up from
// the backend (routers/accounting_compensation.py); here only rows are summed.
import { COMP_REQUEST_TIMEOUT_MS } from './assumptions';
import { formatDate } from '../../lib/datetime';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The line under the loading dots (CR-02: Jan-Sep showed empty rows with no word for minutes). */
export const buildingHint = (months) =>
  `Building ${plural(months, 'month', 'months')} of payroll cards for every employee. This can take up to a minute.`;

/** Why the report is empty: nothing on the ledger carries an employee in these months. */
export const emptyReason = () =>
  'No payroll on the ledger carries an employee in these months. A line counts here when it has the Employee set in Intacct.';

/** The words for a failed Time Clock read: our own timeout gets its own sentence, the server's 422 says what it says. */
export function loadErrorMessage(e, months) {
  if (e?.isNetworkError && e?.name === 'AbortError') {
    const minutes = Math.max(1, Math.round(COMP_REQUEST_TIMEOUT_MS / 60_000));
    return `Building ${plural(months, 'month', 'months')} took longer than ${plural(minutes, 'minute', 'minutes')}, so it was stopped. Pick fewer months and run it again.`;
  }
  return e?.message || 'Could not build the report.';
}

/** Minutes -> hours, two decimals (a number, for the table and the export). */
export const hoursOf = (min) => Math.round((Number(min) || 0) / 60 * 100) / 100;

/** Months from "YYYY-MM" to "YYYY-MM", both counted (0 when either is not a month). */
export function monthsBetween(from, to) {
  if (!/^\d{4}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}$/.test(to || '')) return 0;
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
}

/** The months of [from, to] that have started by `now` (Time Clock has no hours ahead): [from, to] or null. */
export function hoursRange([from, to], now = new Date()) {
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (from > cur) return null;
  return [from, to > cur ? cur : to];
}

export const VIEWS = [
  { key: 'people', label: 'By Employee' },
  { key: 'company', label: 'By Company' },
  { key: 'department', label: 'By Department' },
];

// Hours stay Time Clock's (item 11: "may stay from Time Clock, labeled as
// such"); no Personal Hours (item 15). Overtime includes double time, as on
// Intacct's report. Each a minutes field.
export const HOUR_COLUMNS = [
  { key: 'regMin', label: 'Regular Hours (Time Clock)', short: 'Regular' },
  { key: 'overtimeMin', label: 'Overtime Hours (Time Clock)', short: 'Overtime' },
  { key: 'sickMin', label: 'Sick Hours (Time Clock)', short: 'Sick' },
  { key: 'vacationMin', label: 'Vacation Hours (Time Clock)', short: 'Vacation' },
];

// Intacct's Employee Compensation Report, line by line (items 13 and 14).
// `parts` = what a total adds up; `optional` lines show only when not zero;
// `shown` = in the table before the person picks columns.
export const LINES = [
  { key: 'bonus', label: 'Bonus', shown: true },
  { key: 'payroll', label: 'Salaried / Hourly Payroll', shown: true },
  { key: 'totalPayroll', label: 'Total Payroll Expenses', parts: ['bonus', 'payroll'] },
  { key: 'k401', label: '401(k) Contribution (Company)' },
  { key: 'health', label: 'Health Insurance (Company)' },
  { key: 'totalBenefits', label: 'Total Benefits', parts: ['k401', 'health'], shown: true },
  { key: 'futa', label: 'FUTA' },
  { key: 'medicare', label: 'Medicare' },
  { key: 'socsec', label: 'Social Security' },
  { key: 'suta', label: 'SUTA' },
  { key: 'ett', label: 'CA Employment Training Tax' },
  { key: 'otherTaxes', label: 'Other Payroll Taxes', optional: true },
  { key: 'totalTaxes', label: 'Total Employer Payroll Taxes', parts: ['futa', 'medicare', 'socsec', 'suta', 'ett', 'otherTaxes'], shown: true },
  // Intacct keeps Other Benefits (every other expense line carrying the
  // employee, item 12) as its own group, outside Total Benefits.
  { key: 'otherBenefits', label: 'Other Benefits', byAccount: true, shown: true },
  { key: 'workersComp', label: "Workers' Comp", shown: true },
  { key: 'totalEmployer', label: 'Total Employer Expenses', parts: ['totalPayroll', 'totalBenefits', 'totalTaxes', 'otherBenefits', 'workersComp'], shown: true },
  { key: 'dedHealth', label: 'Health Insurance (Employee)' },
  { key: 'ded401k', label: '401(k) Contribution (Employee)' },
  { key: 'dedOther', label: 'Other Deductions', optional: true },
  { key: 'totalDeductions', label: 'Total Deductions from Gross Pay', parts: ['dedHealth', 'ded401k', 'dedOther'] },
  { key: 'fedWh', label: 'Federal Withholding' },
  { key: 'medicareWh', label: 'Medicare (Employee)' },
  { key: 'socsecWh', label: 'Social Security (Employee)' },
  { key: 'sdi', label: 'SDI' },
  { key: 'stateWh', label: 'State Withholding' },
  { key: 'totalWithheld', label: 'Total Employee Taxes Withheld', parts: ['fedWh', 'medicareWh', 'socsecWh', 'sdi', 'stateWh'] },
  { key: 'netPay', label: 'Employee Net Pay', parts: ['totalPayroll', 'totalDeductions', 'totalWithheld'], shown: true },
];
const LINE = Object.fromEntries(LINES.map((l) => [l.key, l]));
export const lineLabel = (key) => LINE[key]?.label || key;

/** The lines a figure is made of, down to the ledger's own (a total's parts, its parts' parts). */
export function leafLines(key) {
  const l = LINE[key];
  return l?.parts ? l.parts.flatMap(leafLines) : [key];
}

// One person's report, laid out as Intacct's Employee Compensation Report
// (10/27 call at 13:06 / 14:33 / 28:46): three sections, each made of groups
// that fold like Intacct's triangles and end in their own total row. `lines`
// are report lines, `hours` Time Clock minutes fields, `rates` the pay setup
// rate, `accounts` the line whose accounts are listed one by one.
export const STATEMENT = [
  {
    id: 'metrics', heading: 'Employee Metrics', groups: [
      { id: 'rates', heading: 'Rates', rates: true },
      { id: 'worked', heading: 'Hours Worked', hours: ['regMin', 'overtimeMin'], totalLabel: 'Total Hours Worked' },
      { id: 'accruals', heading: 'Accruals', hours: ['sickMin', 'vacationMin'], totalLabel: 'Total Accruals' },
    ],
  },
  {
    id: 'employer', heading: 'Employer Expenses', total: 'totalEmployer', groups: [
      { id: 'payroll', heading: 'Payroll Expenses', lines: ['bonus', 'payroll'], total: 'totalPayroll' },
      { id: 'benefits', heading: 'Benefits', lines: ['k401', 'health'], total: 'totalBenefits' },
      { id: 'taxes', heading: 'Employer Payroll Taxes', lines: ['futa', 'medicare', 'socsec', 'suta', 'ett', 'otherTaxes'], total: 'totalTaxes' },
      { id: 'other', heading: 'Other Benefits', accounts: 'otherBenefits', total: 'otherBenefits', totalLabel: 'Total Other Benefits' },
    ],
    lines: ['workersComp'],
  },
  {
    id: 'net', heading: 'Employee Net Pay', total: 'netPay', groups: [
      { id: 'gross', heading: 'Payroll Expenses', lines: ['bonus', 'payroll'], total: 'totalPayroll' },
      { id: 'deductions', heading: 'Deductions from Gross Pay', lines: ['dedHealth', 'ded401k', 'dedOther'], total: 'totalDeductions' },
      { id: 'withheld', heading: 'Employee Taxes Withheld', lines: ['fedWh', 'medicareWh', 'socsecWh', 'sdi', 'stateWh'], total: 'totalWithheld' },
    ],
  },
];

const HOUR_KEYS = HOUR_COLUMNS.map((c) => c.key);
const blankHours = () => Object.fromEntries(HOUR_KEYS.map((k) => [k, 0]));

/**
 * Time Clock's hours beside each person on the ledger, by employee ID (the
 * Nexus employee code is the Intacct employee ID - Valinda Cranfill is
 * E-0084 in both). `timeClockOnly` = names with hours but nothing on the
 * ledger, for a line under the table.
 */
export function withHours(people, hours) {
  const byId = new Map();
  (hours?.people || []).forEach((h) => { if (h.employeeId) byId.set(String(h.employeeId).toUpperCase(), h); });
  const used = new Set();
  const rows = (people || []).map((p) => {
    const h = byId.get(String(p.code || '').toUpperCase());
    if (!h) return { ...p, codes: [p.code], ...blankHours(), hoursIn: !!hours };
    used.add(String(h.employeeId).toUpperCase());
    return {
      ...p, codes: [p.code], hoursIn: true, payType: h.payType, rate: h.rate, rateChanged: !!h.rateChanged, currency: h.currency,
      regMin: Number(h.regMin) || 0, overtimeMin: (Number(h.otMin) || 0) + (Number(h.dtMin) || 0),
      sickMin: Number(h.sickMin) || 0, vacationMin: Number(h.vacationMin) || 0,
    };
  });
  const timeClockOnly = (hours?.people || []).filter((h) => !h.employeeId || !used.has(String(h.employeeId).toUpperCase()))
    .filter((h) => HOUR_KEYS.some((k) => (k === 'overtimeMin' ? (Number(h.otMin) || 0) + (Number(h.dtMin) || 0) : Number(h[k]) || 0)))
    .map((h) => h.name);
  return { rows, timeClockOnly };
}

function addAccounts(into, from) {
  Object.entries(from || {}).forEach(([line, accts]) => {
    const list = into[line] || (into[line] = []);
    (accts || []).forEach((a) => {
      const hit = list.find((x) => x.account === a.account && (x.side || '') === (a.side || ''));
      if (hit) hit.amount = r2(hit.amount + a.amount);
      else list.push({ ...a });
    });
  });
}

/** Several rows as one: every line, hour and account added up, the employee IDs gathered. Pure. */
export function combine(rows) {
  const out = { codes: [], cur: {}, prior: {}, accounts: { cur: {}, prior: {} }, workersComp: { cur: [], prior: [] }, ...blankHours(), hoursIn: true, people: 0 };
  (rows || []).forEach((r) => {
    out.codes.push(...(r.codes || [r.code]).filter(Boolean));
    out.people += r.people || 1;
    ['cur', 'prior'].forEach((p) => {
      Object.entries(r[p] || {}).forEach(([k, v]) => { out[p][k] = r2((out[p][k] || 0) + (Number(v) || 0)); });
      addAccounts(out.accounts[p], r.accounts?.[p]);
      out.workersComp[p].push(...(r.workersComp?.[p] || []).map((w) => ({ ...w, name: r.name || r.label })));
    });
    HOUR_KEYS.forEach((k) => { out[k] += Number(r[k]) || 0; });
    out.hoursIn = out.hoursIn && r.hoursIn !== false;
  });
  out.codes = [...new Set(out.codes)];
  return out;
}

/** The totals by company or by department: one row per group, each the combined people. */
export function groupRows(rows, by) {
  const keyOf = by === 'company'
    ? (r) => [r.company || '', r.companyName || 'No Company']
    : (r) => [r.department || '', r.department || 'No Department'];
  const groups = new Map();
  (rows || []).forEach((r) => {
    const [k, label] = keyOf(r);
    const g = groups.get(k) || { key: k, label, members: [] };
    g.members.push(r);
    groups.set(k, g);
  });
  return [...groups.values()]
    .map((g) => ({ ...combine(g.members), key: g.key, label: g.label, people: g.members.length }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * What one figure's drill-down reads: the employee IDs and the accounts
 * ("61903:c" = that account's credits only) behind `key` in `period` -
 * one `account` only when an Other Benefits account was clicked.
 */
export function drillSpec(subject, key, period, account = null) {
  const leaves = key === 'workersComp' ? leafLines('totalPayroll') : leafLines(key);
  const specs = [];
  leaves.forEach((leaf) => (subject?.accounts?.[period]?.[leaf] || []).forEach((a) => {
    if (account && a.account !== account) return;
    const spec = `${a.account}${a.side ? `:${a.side}` : ''}`;
    if (!specs.includes(spec)) specs.push(spec);
  }));
  return { employees: subject?.codes || (subject?.code ? [subject.code] : []), accounts: specs };
}

/** "Year Ending 12/31/2026" for a whole year (as Intacct heads its columns), else "01/01/2026 - 09/30/2026". */
export function periodLabel(from, to) {
  if (!from || !to) return '';
  if (from.slice(5) === '01-01' && to.slice(5) === '12-31' && from.slice(0, 4) === to.slice(0, 4)) return `Year Ending ${formatDate(to)}`;
  return `${formatDate(from)} - ${formatDate(to)}`;
}

const HOUR_SHORT = Object.fromEntries(HOUR_COLUMNS.map((c) => [c.key, c.short]));

/**
 * One person's (or group's) report as rows, Intacct's layout (STATEMENT).
 * Each row: { kind: 'section' | 'heading' | 'line' | 'account' | 'hours' |
 * 'rate' | 'total', section, group, level, key, label, prior, cur }. A
 * section or group heading carries its total too, shown on the heading while
 * it is folded (as Intacct shows "Other Benefits 1,087.16"). Hours are Time
 * Clock's and rates the pay setup's, for the period asked only (prior null).
 */
export function statementRows(subject) {
  const out = [];
  const val = (p, k) => Number(subject?.[p]?.[k]) || 0;
  const money = (k) => ({ key: k, prior: val('prior', k), cur: val('cur', k) });
  const hoursIn = subject?.hoursIn !== false;
  const hoursAt = (k) => (hoursIn ? hoursOf(subject?.[k]) : null);
  STATEMENT.forEach((s) => {
    out.push({ kind: 'section', section: s.id, group: null, level: 0, label: s.heading, ...(s.total ? money(s.total) : { key: null, prior: null, cur: null }) });
    s.groups.forEach((g) => {
      const at = { section: s.id, group: g.id };
      if (g.rates) {
        out.push({ kind: 'heading', ...at, level: 1, label: g.heading, key: null, prior: null, cur: null });
        const rate = Number(subject?.rate) || 0;
        out.push({ kind: 'rate', ...at, level: 2, key: 'hourly', label: 'Hourly', prior: null, cur: subject?.payType === 'hourly' ? rate : null });
        out.push({ kind: 'rate', ...at, level: 2, key: 'fixed', label: 'Fixed (per month)', prior: null, cur: subject?.payType === 'salary' ? rate : null });
        return;
      }
      if (g.hours) {
        const total = hoursIn ? r2(g.hours.reduce((n, k) => n + hoursOf(subject?.[k]), 0)) : null;
        out.push({ kind: 'heading', ...at, level: 1, label: g.heading, key: null, prior: null, cur: total, hours: true });
        g.hours.forEach((k) => out.push({ kind: 'hours', ...at, level: 2, key: k, label: HOUR_SHORT[k], prior: null, cur: hoursAt(k) }));
        out.push({ kind: 'total', ...at, level: 1, key: null, label: g.totalLabel, prior: null, cur: total, hours: true });
        return;
      }
      out.push({ kind: 'heading', ...at, level: 1, label: g.heading, ...money(g.total) });
      (g.lines || []).forEach((k) => {
        if (LINE[k].optional && !val('cur', k) && !val('prior', k)) return;
        out.push({ kind: 'line', ...at, level: 2, label: LINE[k].label, ...money(k) });
      });
      if (g.accounts) {
        const seen = new Map();
        ['prior', 'cur'].forEach((p) => (subject?.accounts?.[p]?.[g.accounts] || []).forEach((a) => {
          const row = seen.get(a.account) || { kind: 'account', ...at, level: 2, key: g.accounts, account: a.account, label: `${a.account} ${a.title || ''}`.trim(), prior: 0, cur: 0 };
          row[p] = r2(row[p] + a.amount);
          seen.set(a.account, row);
        }));
        out.push(...[...seen.values()].sort((a, b) => a.account.localeCompare(b.account)));
      }
      out.push({ kind: 'total', ...at, level: 1, label: g.totalLabel || LINE[g.total].label, ...money(g.total) });
    });
    (s.lines || []).forEach((k) => out.push({ kind: 'line', section: s.id, group: null, level: 1, label: LINE[k].label, ...money(k) }));
    if (s.total) out.push({ kind: 'total', section: s.id, group: null, level: 0, label: LINE[s.total].label, strong: true, ...money(s.total) });
  });
  return out;
}

/** The rows left on screen with some sections / groups folded (`folded` = a Set of their ids). */
export function visibleRows(rows, folded) {
  return (rows || []).filter((r) => {
    if (r.kind === 'section') return true;
    if (folded?.has(r.section)) return false;
    if (r.kind === 'heading') return true;
    return !(r.group && folded?.has(r.group));
  });
}

/** The statement as a linesExport table (Excel / PDF / CSV / Print) - every group open. */
export function statementTable(subject, { name = '', curLabel = '', priorLabel = '' } = {}) {
  const rows = statementRows(subject).map((r) => {
    const label = `${'  '.repeat(r.level)}${r.label}`;
    // A heading's figure is its total row's; on paper the total row says it.
    if (r.kind === 'section' || r.kind === 'heading') return [label, '', ''];
    return [label, r.prior ?? '', r.cur ?? ''];
  });
  return {
    title: `Employee Compensation Report - ${name}`,
    subtitle: 'From the Intacct ledger; hours and rates from Time Clock',
    period: curLabel.replace(/\//g, '-'),
    columns: [{ label: 'Line', num: false, width: 260 }, { label: priorLabel, num: true, width: 120 }, { label: curLabel, num: true, width: 120 }],
    rows,
    totals: null,
  };
}

export const payTypeLabel = (t) => (t === 'salary' ? 'Salary' : t === 'hourly' ? 'Hourly' : '');
export const rateLabel = (p) => (p.payType === 'salary' ? 'per month' : p.payType === 'hourly' ? 'per hour' : '');
