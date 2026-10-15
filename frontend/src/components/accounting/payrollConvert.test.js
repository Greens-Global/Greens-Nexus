import { describe, it, expect } from 'vitest';
import { parseCsv, toCsv } from './statementImport';
import {
  DEFAULT_PAYROLL_MAPPING, INTACCT_HOURS_COLUMNS, INTACCT_PAYROLL_COLUMNS, buildIif, buildPayrollEntries, checkBalance, classifyHoursItem,
  codeFromName, hoursFromNexus, hoursFromPayroll, hoursRows, netPayMismatches, parseHoursFile, parseQbPayroll, payrollRows,
  totalsFromHoursFile, unmappedItems,
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

  it('classifies payroll items and reads codes from names', () => {
    expect(['Regular Pay', 'Overtime Pay', 'Double-time Pay', 'Sick Pay', 'PTO', 'Hourly'].map(classifyHoursItem))
      .toEqual(['regular', 'overtime', 'doubleTime', 'sick', 'vacation', 'regular']);
    expect(codeFromName('Dana Fox (E-0100)')).toBe('E-0100');
    expect(codeFromName('Dana Fox')).toBe('');
  });
});
