import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseCsv, toCsv } from './statementImport';
import {
  DEFAULT_PAYROLL_MAPPING, INTACCT_HOURS_COLUMNS, INTACCT_PAYROLL_COLUMNS, buildIif, buildPayrollEntries, checkBalance, classifyHoursItem,
  codeFromName, hoursFromNexus, hoursFromPayroll, hoursRows, loadPayrollPrefs, nameList, netPayMismatches, parseHoursFile, parsePayrollSheets,
  parseQbPayroll, payPeriods, payrollFileProblem, payrollReportProblems, payrollRows, readPayrollSheets, savePayrollPrefs, totalsFromHoursFile, unmappedItems,
} from './payrollConvert';

// Import Hub payroll (Neil, 10/15). Fixtures are made up, shaped like the
// QuickBooks Desktop Payroll Summary and the OSM templates - no real people.

// A QuickBooks Payroll Summary saved as CSV: employee name row with TOTAL,
// Hours / Rate / Amount under each, item labels left of the first block.
const B5 = ['', '', '', '', ''];
const SUMMARY = [
  ['Sample Services LLC'],
  ['Payroll Summary'],
  ['January 4 through 17, 2026'],
  ['', '', '', '', 'Alex Rivera (E-0901)', ...B5, 'Sam Ortiz (E-0902)', ...B5, 'TOTAL'],
  ['', '', '', '', 'Hours', '', 'Rate', '', 'Amount', '', 'Hours', '', 'Rate', '', 'Amount', '', 'Hours', '', 'Rate', '', 'Amount'],
  ['Employee Wages, Taxes and Adjustments'],
  ['', 'Gross Pay'],
  ['', '', 'Hourly Wages', '', '80', '', '20.00', '', '1,600.00', '', '70', '', '18.00', '', '1,260.00', '', '150', '', '', '', '2,860.00'],
  ['', '', 'Overtime Wages', '', '2', '', '30.00', '', '60.00', '', '', '', '', '', '', '', '2', '', '', '', '60.00'],
  ['', '', 'Sick Hourly', '', '', '', '', '', '', '', '8', '', '18.00', '', '144.00', '', '8', '', '', '', '144.00'],
  ['', 'Total Gross Pay', '', '', '82', '', '', '', '1,660.00', '', '78', '', '', '', '1,404.00', '', '160', '', '', '', '3,064.00'],
  ['', 'Taxes Withheld'],
  ['', '', 'Federal Withholding', '', '', '', '', '', '-120.00', '', '', '', '', '', '-90.00', '', '', '', '', '', '-210.00'],
  ['', '', 'Social Security Employee', '', '', '', '', '', '-102.92', '', '', '', '', '', '-87.05', '', '', '', '', '', '-189.97'],
  ['', '', 'Medicare Employee', '', '', '', '', '', '-24.07', '', '', '', '', '', '-20.36', '', '', '', '', '', '-44.43'],
  ['', 'Deductions from Net Pay'],
  ['', '', '401(k) Contribution', '', '', '', '', '', '-50.00', '', '', '', '', '', '', '', '', '', '', '', '-50.00'],
  ['', 'Net Pay', '', '', '', '', '', '', '1,363.01', '', '', '', '', '', '1,206.59', '', '', '', '', '', '2,569.60'],
  ['', 'Employer Taxes and Contributions'],
  ['', '', 'Social Security Company', '', '', '', '', '', '102.92', '', '', '', '', '', '87.05', '', '', '', '', '', '189.97'],
  ['', '', 'Medicare Company', '', '', '', '', '', '24.07', '', '', '', '', '', '20.36', '', '', '', '', '', '44.43'],
  ['', '', 'Federal Unemployment', '', '', '', '', '', '9.96', '', '', '', '', '', '8.42', '', '', '', '', '', '18.38'],
];

const SETTINGS = { journal: 'PYRJ', hoursJournal: 'STAT', location: '57001', department: '8000', netPayAccount: '23700', payDate: '2026-01-23', periodStart: '2026-01-04', periodEnd: '2026-01-17', prefix: 'SSV' };

describe('QuickBooks payroll to Intacct', () => {
  it('reads the Payroll Summary: employees, codes, items, hours and the Net Pay row', () => {
    const p = parseQbPayroll(SUMMARY);
    expect(p.format).toBe('summary');
    expect(p.period).toBe('January 4 through 17, 2026');
    expect(p.employees.map((e) => [e.name, e.code])).toEqual([['Alex Rivera (E-0901)', 'E-0901'], ['Sam Ortiz (E-0902)', 'E-0902']]);
    const alex = p.employees[0];
    expect(alex.items.find((i) => i.item === 'Hourly Wages')).toEqual({ item: 'Hourly Wages', hours: 80, amount: 1600 });
    expect(alex.items.find((i) => i.item === 'Federal Withholding').amount).toBe(-120);
    expect(alex.items.some((i) => /total|net pay/i.test(i.item))).toBe(false);
    expect(alex.netPay).toBe(1363.01);
    expect(p.employees[1].items.map((i) => i.item)).not.toContain('401(k) Contribution');
  });

  it('builds one balanced entry per employee in the OSM payroll layout', () => {
    const p = parseQbPayroll(SUMMARY);
    const { entries, missing } = buildPayrollEntries(p.employees, DEFAULT_PAYROLL_MAPPING, SETTINGS, { 'alex rivera (e-0901)': { vendor: 'V09001', dept: '4100' } });
    expect(missing).toEqual([]);
    expect(entries).toHaveLength(2);
    const bal = checkBalance(entries);
    expect(bal.balanced).toBe(true);
    expect(bal.debit).toBe(bal.credit);
    expect(netPayMismatches(entries)).toEqual([]);
    const alex = entries[0];
    expect(alex.netPay).toBe(1363.01);
    const pick = (acct) => alex.lines.filter((l) => l.acct === acct).map((l) => [l.debit, l.credit]);
    expect(pick('61905')).toEqual([[1600, 0]]);
    expect(pick('23801')).toEqual([[0, 120]]);
    expect(pick('62104')).toEqual([[102.92, 0]]);   // employer tax: expense ...
    expect(pick('23808')).toEqual([[0, 102.92]]);   // ... and liability
    expect(pick('23700')).toEqual([[0, 1363.01]]);  // net pay closes the entry

    const rows = payrollRows(entries, { location: '57001' });
    expect(rows[0]).toEqual(INTACCT_PAYROLL_COLUMNS);
    expect(rows[0]).toHaveLength(28);
    const col = (n) => rows[0].indexOf(n);
    expect(rows[1][col('JOURNAL')]).toBe('PYRJ');
    expect(rows[1][col('DATE')]).toBe('01/23/2026');
    expect(rows[1][col('DESCRIPTION')]).toBe('SSV Payroll 01/23/2026 - E-0901');
    expect(rows[2][col('JOURNAL')]).toBe('');
    expect(rows[1][col('LOCATION_ID')]).toBe('57001');
    expect(rows[1][col('SOURCEENTITY')]).toBe('57001');
    expect(rows[1][col('DEPT_ID')]).toBe('4100');            // the employee map's department
    expect(rows[1][col('GLENTRY_VENDORID')]).toBe('V09001');
    expect(rows[1][col('GLENTRY_EMPLOYEEID')]).toBe('E-0901');
    const sam = rows.filter((r) => r[col('GLENTRY_EMPLOYEEID')] === 'E-0902');
    expect(sam[0][col('DEPT_ID')]).toBe('8000');             // the default department
    expect(sam[0][col('LINE_NO')]).toBe('1');
    expect(toCsv(rows).startsWith('DONOTIMPORT,JOURNAL,DATE,REVERSEDATE,DESCRIPTION')).toBe(true);
  });

  it('flags items with no mapping, missing accounts, and a net pay that does not tie out', () => {
    const extra = SUMMARY.concat([['', '', 'Tool Allowance', '', '', '', '', '', '25.00']]);
    const p = parseQbPayroll(extra);
    expect(unmappedItems(p.employees, DEFAULT_PAYROLL_MAPPING)).toEqual([{ item: 'Tool Allowance', amount: 25 }]);
    const mapping = DEFAULT_PAYROLL_MAPPING.map((m) => (m.item === 'Federal Withholding' ? { ...m, credit: '' } : m));
    const { missing } = buildPayrollEntries(p.employees, mapping, SETTINGS);
    expect(missing.map((m) => m.item)).toEqual(['Federal Withholding', 'Federal Withholding']);
    // Ignoring 401(k) leaves Alex's built net pay 50.00 off the report's.
    const ignore = DEFAULT_PAYROLL_MAPPING.map((m) => (m.item === '401(k) Contribution' ? { ...m, kind: 'ignore' } : m));
    const { entries } = buildPayrollEntries(p.employees, ignore, SETTINGS);
    expect(netPayMismatches(entries)).toEqual([{ employee: 'Alex Rivera (E-0901)', report: 1363.01, built: 1413.01 }]);
    expect(checkBalance([{ employee: 'X', lines: [{ debit: 10, credit: 0 }, { debit: 0, credit: 9.99 }] }])).toMatchObject({ balanced: false, unbalanced: [{ employee: 'X', debit: 10, credit: 9.99 }] });
  });

  it('reads a long payroll detail export too', () => {
    const rows = parseCsv('Employee,Payroll Item,Hours,Amount\nAlex Rivera,Hourly Wages,40,800.00\nAlex Rivera,Federal Withholding,,-60.00\nAlex Rivera,Hourly Wages,10,200.00\nAlex Rivera,Net Pay,,940.00\nTOTAL,,,\n');
    const p = parseQbPayroll(rows);
    expect(p.format).toBe('detail');
    expect(p.employees).toHaveLength(1);
    expect(p.employees[0].items).toEqual([{ item: 'Hourly Wages', hours: 50, amount: 1000 }, { item: 'Federal Withholding', hours: 0, amount: -60 }]);
    const { entries } = buildPayrollEntries(p.employees, DEFAULT_PAYROLL_MAPPING, SETTINGS);
    expect(checkBalance(entries).balanced).toBe(true);
    expect(netPayMismatches(entries)).toEqual([]);
  });

  it('writes the STAT hours in the OSM hours template layout', () => {
    const p = parseQbPayroll(SUMMARY);
    const people = hoursFromPayroll(p.employees, DEFAULT_PAYROLL_MAPPING);
    expect(people[0].buckets).toEqual({ 'P.REG': 80, 'P.OHR': 2, 'P.SHR': 0, 'P.VHR': 0 });
    const rows = hoursRows(people, SETTINGS);
    expect(rows[0]).toEqual(INTACCT_HOURS_COLUMNS);
    expect(rows[0][12]).toBe('  INCREASE  ');
    const col = (n) => rows[0].indexOf(n);
    // One entry for the period; zero buckets left out.
    expect(rows.slice(1).map((r) => [r[col('LINE_NO')], r[col('ACCT_NO')], r[col('  INCREASE  ')], r[col('GLENTRY_EMPLOYEEID')]])).toEqual([
      ['1', 'P.REG', '80', 'E-0901'], ['2', 'P.OHR', '2', 'E-0901'], ['3', 'P.REG', '70', 'E-0902'], ['4', 'P.SHR', '8', 'E-0902'],
    ]);
    expect(rows[1][col('JOURNAL')]).toBe('STAT');
    expect(rows[1][col('DATE')]).toBe('01/23/2026');
    expect(rows[1][col('DESCRIPTION')]).toBe('SSV - Hours - Pay Period 01/04/2026 - 01/17/2026');
    expect(rows[2][col('JOURNAL')]).toBe('');
    expect(rows[1][col('MEMO')]).toBe('Pay Period 01/04/2026 - 01/17/2026');
    expect(rows[1][col('STATE')]).toBe('Posted');
    expect(rows[1][col('LOCATION_ID')]).toBe('57001');
  });
});

// QuickBooks Online Payroll Summary (Priyanka, 10/22, OSM) - an anonymized
// copy of her export's layout: names from column E in 6-column blocks with a
// TOTAL block, Hours / Rate / pay-period sub-headers, labels in columns A-D by
// depth, the same sections and items. Made-up people and pay. `desktop` lays
// the same payroll out as the QuickBooks Desktop summary instead.
const QBO_PEOPLE = ['Robin Hale(E-0801)', 'Casey Lund (E-0802)', 'Jordan Pike'];
// [label, depth, per person [hours, rate, amount] (a number = amount only)]
const QBO_SECTIONS = [
  ['Employee Wages, Taxes and Adjustments', 0],
  ['Gross Pay', 2, null, 'Total Gross Pay'],
  ['Salary', 3, [0, [72, '', 2700], 0]],
  ['Hourly', 3, [[70, 25, 1750], 0, [40, 20, 800]]],
  ['Overtime', 3, [[2, 37.5, 75], 0, 0]],
  ['Sick', 3, [[8, 25, 200], 0, 0]],
  ['Vacation', 3, [0, [8, 37.5, 300], 0]],
  ['Bonus', 3, [100, 0, 0]],
  ['Deductions from Gross Pay', 2, null, 'Total Deductions from Gross Pay'],
  ['401(k) Contribution', 3, [-100, 0, 0]],
  ['Health Insurance', 3, [-150, -200, 0]],
  ['Taxes Withheld', 1, null, 'Total Taxes Withheld'],
  ['Federal Withholding', 2, [-90, -250, -40]],
  ['Medicare Employee', 2, [-30.81, -40.6, -11.6]],
  ['Social Security Employee', 2, [-131.75, -173.6, -49.6]],
  ['CA - Withholding', 2, [-25, -60, -8]],
  ['CA - Disability Employee', 2, [-20, -33.6, -9.6]],
  ['Medicare Employee Addl Tax', 2, [0, 0, 0]],
  ['NET'],
  ['Employer Taxes and Contributions', 0, null, 'Total Employer Taxes and Contributions'],
  ['Federal Unemployment', 1, [12.75, 0, 4.8]],
  ['Medicare Company', 1, [30.81, 40.6, 11.6]],
  ['Social Security Company', 1, [131.75, 173.6, 49.6]],
  ['CA - Federal Unemployment', 1, [3, 0, 0]],
  ['Qualified OT Tracking', 1, [25, 0, 0]],
  ['CA - Employment Training Tax', 1, [1, 0, 0]],
];
const DESKTOP_NAMES = { Hourly: 'Hourly Wages', Overtime: 'Overtime Wages' };
const fmt2 = (n) => (n === '' ? '' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function payrollSheet({ desktop = false } = {}) {
  const width = 4 + 6 * (QBO_PEOPLE.length + 1);
  const blank = () => new Array(width).fill('');
  const at = (p) => 4 + 6 * p;
  const rows = desktop ? [['Sample Services LLC'], ['Payroll Summary'], ['October 10 through 23, 2026']] : [];
  const names = blank();
  QBO_PEOPLE.forEach((n, p) => { names[at(p)] = n; });
  names[at(QBO_PEOPLE.length)] = 'TOTAL';
  const sub = blank();
  for (let p = 0; p <= QBO_PEOPLE.length; p += 1) Object.assign(sub, { [at(p)]: 'Hours', [at(p) + 2]: 'Rate', [at(p) + 4]: desktop ? 'Amount' : 'Oct 10 - 23, 26' });
  rows.push(names, sub);
  const net = QBO_PEOPLE.map(() => 0);
  const line = (label, depth, cells) => {
    const r = blank();
    r[desktop ? Math.min(depth, 2) : depth] = label;
    let h = 0;
    let a = 0;
    cells.forEach((c, p) => {
      const [hours, rate, amount] = Array.isArray(c) ? c : ['', '', c];
      Object.assign(r, { [at(p)]: hours === '' ? '' : String(hours), [at(p) + 2]: rate === '' ? '' : fmt2(rate), [at(p) + 4]: fmt2(amount) });
      h += Number(hours) || 0;
      a += amount;
    });
    Object.assign(r, { [at(QBO_PEOPLE.length)]: h ? String(h) : '', [at(QBO_PEOPLE.length) + 4]: fmt2(a) });
    return r;
  };
  let total = null;
  const closeSection = () => { if (total) rows.push(line(total.label, total.depth, total.sums)); total = null; };
  for (const [label, depth, cells, totalLabel] of QBO_SECTIONS) {
    if (label === 'NET') { closeSection(); rows.push(line('Net Pay', 0, net)); continue; }
    if (!cells) { closeSection(); rows.push(Object.assign(blank(), { [desktop ? Math.min(depth, 1) : depth]: label })); if (totalLabel) total = { label: totalLabel, depth, sums: QBO_PEOPLE.map(() => 0) }; continue; }
    if (desktop && label === 'Qualified OT Tracking') continue;   // not on a Desktop summary
    rows.push(line(DESKTOP_NAMES[label] && desktop ? DESKTOP_NAMES[label] : label, depth, cells));
    cells.forEach((c, p) => {
      const amount = Array.isArray(c) ? c[2] : c;
      if (total) total.sums[p] = round(total.sums[p] + amount);
      if (!label.match(/Company|Unemployment|Training|Qualified/)) net[p] = round(net[p] + amount);
    });
  }
  closeSection();
  return rows;
}
const round = (n) => Math.round(n * 100) / 100;

describe('QuickBooks Online payroll to Intacct', () => {
  const QBO = payrollSheet();
  const QSET = { ...SETTINGS, payDate: '2026-10-28', periodStart: '2026-10-10', periodEnd: '2026-10-23' };

  it('reads the Online summary: the pay period heads the Amount column, no company row', () => {
    const p = parseQbPayroll(QBO);
    expect(p).toMatchObject({ format: 'summary', source: 'online', period: 'Oct 10 - 23, 26', company: '', missing: [] });
    expect(p.employees.map((e) => [e.name, e.code])).toEqual([['Robin Hale(E-0801)', 'E-0801'], ['Casey Lund (E-0802)', 'E-0802'], ['Jordan Pike', '']]);
    expect(p.employees[0].items.find((i) => i.item === 'Hourly')).toEqual({ item: 'Hourly', hours: 70, amount: 1750 });
    expect(p.employees.map((e) => e.netPay)).toEqual([1577.44, 2242.2, 681.2]);
    expect(unmappedItems(p.employees, DEFAULT_PAYROLL_MAPPING)).toEqual([]);
    expect(parseQbPayroll(payrollSheet({ desktop: true })).source).toBe('desktop');
  });

  it('skips the empty Export Tips sheet QuickBooks Online saves first', () => {
    expect(parsePayrollSheets([[], QBO]).employees).toHaveLength(3);
    expect(parsePayrollSheets([[['QuickBooks Desktop Export Tips']], QBO]).employees).toHaveLength(3);
  });

  it('writes the same PYRJ lines, GL accounts and STAT hours as the Desktop summary of the same payroll', () => {
    const online = parseQbPayroll(QBO);
    const desktop = parseQbPayroll(payrollSheet({ desktop: true }));
    const qbo = buildPayrollEntries(online.employees, DEFAULT_PAYROLL_MAPPING, QSET);
    const qbd = buildPayrollEntries(desktop.employees, DEFAULT_PAYROLL_MAPPING, QSET);
    expect(qbo.missing).toEqual([]);
    expect(checkBalance(qbo.entries).balanced).toBe(true);
    expect(netPayMismatches(qbo.entries)).toEqual([]);
    expect(payrollRows(qbo.entries, { location: '57001' })).toEqual(payrollRows(qbd.entries, { location: '57001' }));
    const pick = (acct) => qbo.entries[0].lines.filter((l) => l.acct === acct).map((l) => [l.memo, l.debit, l.credit]);
    expect(pick('61905')).toEqual([['Hourly', 1750, 0]]);
    expect(pick('61909')).toEqual([['Overtime', 75, 0]]);
    expect(pick('61903')).toEqual([['Health Insurance', 0, 150]]);
    expect(pick('23700')).toEqual([['Payroll Liability (Net Pay)', 0, 1577.44]]);
    // Qualified OT Tracking is reporting only: nothing posts for it.
    expect(qbo.entries[0].lines.some((l) => /Qualified/.test(l.memo))).toBe(false);
    const hours = (r) => hoursRows(hoursFromPayroll(r.employees, DEFAULT_PAYROLL_MAPPING), QSET);
    expect(hours(online)).toEqual(hours(desktop));
    expect(hoursFromPayroll(online.employees, DEFAULT_PAYROLL_MAPPING)[0].buckets).toEqual({ 'P.REG': 70, 'P.OHR': 2, 'P.SHR': 8, 'P.VHR': 0 });
  });

  it('names the missing column when a file still cannot be read', () => {
    const noAmount = QBO.map((r, i) => (i === 1 ? r.map((c) => (/Oct/.test(c) ? '' : c)) : r));
    const p = parseQbPayroll(noAmount);
    expect(p.employees).toEqual([]);
    expect(p.missing).toEqual(['Amount']);
    // 10/27 item 03: the names were found, so it says where and what is missing under them.
    expect(payrollFileProblem(p)).toBe('Found 3 employee names and TOTAL on line 1, but no Amount column under them - line 2 should read Hours, Rate and Amount (QuickBooks Online puts the pay period where Amount goes).');
    const detail = parseQbPayroll(parseCsv('Employee,Hours\nPat Lee,8\n'));
    expect(detail.missing).toEqual(['Payroll Item', 'Amount']);
    expect(payrollFileProblem(detail)).toMatch(/^No Payroll Item and Amount columns found\./);
    expect(payrollFileProblem(parsePayrollSheets([[]]))).toMatch(/^No Employee, Payroll Item and Amount columns found\./);
  });

  it('reads every sheet of an Excel file', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'QuickBooks Desktop Export Tips');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(QBO), 'Sheet1');
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const sheets = await readPayrollSheets({ name: 'OSM Payroll .xlsx', arrayBuffer: async () => bytes });
    expect(sheets).toHaveLength(2);
    expect(sheets[0]).toHaveLength(0);
    expect(sheets[1].sheet).toBe('Sheet1');
    expect(parsePayrollSheets(sheets).employees).toHaveLength(3);
  });

  it('keeps the file line numbers past blank rows and names amounts it cannot read (10/27 item 03)', async () => {
    const wb = XLSX.utils.book_new();
    // Two blank lines on top and one under the headings; Robin's Hourly amount (1,750.00) typed as "n/a".
    const withGap = [[], [], ...QBO.slice(0, 2), [], ...QBO.slice(2)].map((r) => r.map((c) => (c === '1,750.00' ? 'n/a' : c)));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(withGap), 'Sheet1');
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const sheets = await readPayrollSheets({ name: 'payroll.xlsx', arrayBuffer: async () => bytes });
    expect(sheets[0].lines.slice(0, 3)).toEqual([3, 4, 6]);
    const report = parsePayrollSheets(sheets);
    const hourlyLine = QBO.findIndex((r) => r.includes('Hourly')) + 4;
    expect(report.unreadable).toEqual([{ line: hourlyLine, item: 'Hourly', employee: 'Robin Hale(E-0801)', value: 'n/a' }]);
    expect(payrollReportProblems(report)[0]).toBe(`Could not read an amount in the report: line ${hourlyLine}, Hourly for Robin Hale(E-0801) ("n/a"). Fix it in the file and upload it again.`);
    // A clean report has nothing to say.
    expect(payrollReportProblems(parseQbPayroll(QBO))).toEqual([]);
  });

  it('opens only spreadsheets and says why a file cannot be opened', async () => {
    await expect(readPayrollSheets({ name: 'Payroll.pdf' })).rejects.toThrow(/^Payroll\.pdf is not a spreadsheet\./);
    await expect(readPayrollSheets({ name: 'Payroll.xlsx', arrayBuffer: async () => { throw new Error('locked'); } }))
      .rejects.toThrow('Could not open Payroll.xlsx: locked. Save it again from QuickBooks as Excel (.xlsx) or CSV and upload that copy.');
  });

  it('adds the Online items to a mapping saved before them, once', () => {
    const old = DEFAULT_PAYROLL_MAPPING.filter((m) => !['Hourly', 'Overtime', 'Qualified OT Tracking'].includes(m.item)).map((m) => (m.item === 'Bonus' ? { ...m, debit: '99999' } : m));
    localStorage.setItem('nexus.importhub.payroll.v1', JSON.stringify({ mapping: old, settings: {}, employees: {} }));
    const loaded = loadPayrollPrefs();
    expect(loaded.mapping.find((m) => m.item === 'Bonus').debit).toBe('99999');      // their edits kept
    expect(loaded.mapping.slice(-3).map((m) => m.item)).toEqual(['Hourly', 'Overtime', 'Qualified OT Tracking']);
    savePayrollPrefs({ ...loaded, mapping: loaded.mapping.filter((m) => m.item !== 'Hourly') });
    expect(loadPayrollPrefs().mapping.some((m) => m.item === 'Hourly')).toBe(false); // removed on purpose stays removed
    localStorage.clear();
  });
});

describe('payroll hours to QuickBooks', () => {
  it('maps Nexus time-sheet hours to the Intacct buckets', () => {
    const [p] = hoursFromNexus([{ name: 'Pat Lane', employeeCode: 'GG-7', department: 'Ops', approved: true, hours: { regular: 72, overtime: 3, doubleTime: 1, sick: 4, vacation: 2, personal: 1 } }]);
    expect(p.buckets).toEqual({ 'P.REG': 72, 'P.OHR': 4, 'P.SHR': 4, 'P.VHR': 3 });
    const rows = hoursRows([p], { ...SETTINGS, prefix: '' });
    expect(rows[1][rows[0].indexOf('DEPT_ID')]).toBe('Ops');
    expect(rows[1][rows[0].indexOf('GLENTRY_EMPLOYEEID')]).toBe('GG-7');
  });

  it('reads an hours file and writes the QuickBooks IIF time import', () => {
    const rows = parseCsv('Employee,Date,Payroll Item,Customer:Job,Hours\nPat Lane,01/05/2026,Regular,Rental A,8\nPat Lane,01/05/2026,Overtime,,1.5\nKim Doe,,Sick,,4\nTotal,,,,13.5\n');
    const { entries, skipped } = parseHoursFile(rows);
    expect(entries).toHaveLength(3);
    expect(skipped).toBe(1);
    const iif = buildIif(entries, { fallbackDate: '2026-01-17' }).split('\r\n');
    expect(iif[0]).toBe('!TIMERHDR\tVER\tREL\tCOMPANYNAME\tIMPORTEDBEFORE\tFROMTIMER\tCOMPANYCREATETIME');
    expect(iif[2]).toBe('!TIMEACT\tDATE\tJOB\tEMP\tITEM\tPITEM\tDURATION\tPROJ\tNOTE\tXFERTOPAYROLL\tBILLINGSTATUS');
    expect(iif[3]).toBe('TIMEACT\t1/5/2026\tRental A\tPat Lane\t\tRegular Pay\t8.00\t\t\tY\t1');
    expect(iif[4]).toBe('TIMEACT\t1/5/2026\t\tPat Lane\t\tOvertime Pay\t1.50\t\t\tY\t0');
    expect(iif[5]).toBe('TIMEACT\t1/17/2026\t\tKim Doe\t\tSick Pay\t4.00\t\t\tY\t0');
    const totals = totalsFromHoursFile(entries);
    expect(totals.find((t) => t.name === 'Pat Lane').buckets).toEqual({ 'P.REG': 8, 'P.OHR': 1.5, 'P.SHR': 0, 'P.VHR': 0 });
  });

  it('lists the closed Nexus pay periods on the server calendar (10/27 item 02)', () => {
    // 10/28/2026: 10/18-10/31 is still open, so the last closed one is 10/04-10/17.
    expect(payPeriods('2026-10-28', 3)).toEqual([
      { start: '2026-10-04', end: '2026-10-17' }, { start: '2026-09-20', end: '2026-10-03' }, { start: '2026-09-06', end: '2026-09-19' }]);
    // The Saturday a period ends still belongs to it.
    expect(payPeriods('2026-10-17', 1)).toEqual([{ start: '2026-09-20', end: '2026-10-03' }]);
    expect(payPeriods('2026-10-18', 1)).toEqual([{ start: '2026-10-04', end: '2026-10-17' }]);
    expect(payPeriods('', 2)).toEqual([]);
    expect(nameList(['A', 'B'])).toBe('A and B');
    expect(nameList(['A', 'B', 'C', 'D'], 2)).toBe('A, B and 2 more');
  });

  it('classifies payroll items and reads codes from names', () => {
    expect(['Regular Pay', 'Overtime Pay', 'Double-time Pay', 'Sick Pay', 'PTO', 'Hourly'].map(classifyHoursItem))
      .toEqual(['regular', 'overtime', 'doubleTime', 'sick', 'vacation', 'regular']);
    expect(codeFromName('Dana Fox (E-0100)')).toBe('E-0100');
    expect(codeFromName('Dana Fox')).toBe('');
  });
});
