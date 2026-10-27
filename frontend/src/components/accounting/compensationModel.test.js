import { describe, it, expect } from 'vitest';
import {
  buildingHint, combine, drillSpec, emptyReason, groupRows, HOUR_COLUMNS, hoursOf, hoursRange, leafLines, LINES, loadErrorMessage, monthsBetween,
  periodLabel, statementRows, statementTable, withHours,
} from './compensationModel';

// Employee Compensation, rebuilt from the ledger after the 10/27 call with
// Charmi (items 11-19): Intacct's report lines, Time Clock hours beside them,
// the groupings, the accounts behind a figure, one person's statement.

// Valinda Cranfill's 2026 as the backend sends it (Intacct's figures).
const valinda = {
  code: 'E-0084', name: 'Valinda Cranfill', email: 'valinda@x.com', company: 'c1', companyName: 'Oversite Management, Inc', department: 'Operations', title: 'Area Manager III',
  cur: { bonus: 850, payroll: 52123.06, totalPayroll: 52973.06, k401: 2520.31, health: 3249.75, otherBenefits: 1087.16, totalBenefits: 6857.22, futa: 42, medicare: 665.4, socsec: 2845.15, suta: 217, ett: 7, otherTaxes: 0, totalTaxes: 3776.55, workersComp: 1854.06, totalEmployer: 65460.89, dedHealth: -5854.22, ded401k: 0, dedOther: 0, totalDeductions: -5854.22, fedWh: -2693, medicareWh: -665.4, socsecWh: -2845.15, sdi: -596.57, stateWh: -563.02, totalWithheld: -7363.14, netPay: 39755.7 },
  prior: { bonus: 3500, payroll: 57176.84, totalPayroll: 60676.84, otherBenefits: 27004.72, totalBenefits: 27004.72, totalEmployer: 87681.56, netPay: 60676.84 },
  accounts: {
    cur: {
      bonus: [{ account: '61908', title: 'Bonus', side: '', amount: 850 }],
      payroll: [{ account: '61910', title: 'Salary', side: '', amount: 52123.06 }],
      health: [{ account: '61903', title: 'Health Insurance', side: 'd', amount: 3249.75 }],
      dedHealth: [{ account: '61903', title: 'Health Insurance', side: 'c', amount: -5854.22 }],
      otherBenefits: [{ account: '63203', title: 'Fuel', side: '', amount: 20 }, { account: '63410', title: 'Cell Phone', side: '', amount: 1067.16 }],
    },
    prior: { otherBenefits: [{ account: '63203', title: 'Fuel', side: '', amount: 27004.72 }] },
  },
  workersComp: { cur: [{ year: 2026, ratePct: 3.5, rateYear: 2026, gross: 52973.06, amount: 1854.06 }], prior: [] },
  hasRate: true, inPeople: true,
};
const pat = { code: 'GG-001', name: 'Pat Hourly', companyName: 'Greens Global', company: 'c2', department: 'Maintenance', cur: { payroll: 1000, totalPayroll: 1000, netPay: 1000 }, prior: {},
  accounts: { cur: { payroll: [{ account: '61905', title: 'Hourly', side: '', amount: 1000 }] }, prior: {} }, workersComp: { cur: [], prior: [] } };

describe('compensationModel', () => {
  it('counts months, turns minutes into hours, and reads Time Clock only for months that have started', () => {
    expect(monthsBetween('2025-11', '2026-02')).toBe(4);
    expect(monthsBetween('2026-03', '2026-02')).toBe(0);
    expect(hoursOf(90)).toBe(1.5);
    const oct = new Date(2026, 9, 28);
    expect(hoursRange(['2026-01', '2026-12'], oct)).toEqual(['2026-01', '2026-10']);
    expect(hoursRange(['2025-01', '2025-12'], oct)).toEqual(['2025-01', '2025-12']);
    expect(hoursRange(['2026-11', '2026-12'], oct)).toBeNull();
  });

  it('has no Personal Hours and labels the hours as Time Clock\'s (items 11 and 15)', () => {
    expect(HOUR_COLUMNS.map((c) => c.label)).toEqual(['Regular Hours (Time Clock)', 'Overtime Hours (Time Clock)', 'Sick Hours (Time Clock)', 'Vacation Hours (Time Clock)']);
    expect(JSON.stringify(LINES)).not.toMatch(/personal/i);
  });

  it('lays out Intacct\'s report lines, the totals made of their parts', () => {
    expect(LINES.map((l) => l.label)).toEqual(expect.arrayContaining(['Bonus', 'Salaried / Hourly Payroll', 'Total Payroll Expenses', '401(k) Contribution (Company)', 'Health Insurance (Company)',
      'Other Benefits', 'Total Benefits', 'FUTA', 'Medicare', 'Social Security', 'SUTA', 'CA Employment Training Tax', "Workers' Comp", 'Total Employer Expenses',
      'Health Insurance (Employee)', 'Federal Withholding', 'Medicare (Employee)', 'Social Security (Employee)', 'SDI', 'State Withholding', 'Employee Net Pay']));
    expect(leafLines('totalPayroll')).toEqual(['bonus', 'payroll']);
    expect(leafLines('netPay')).toEqual(['bonus', 'payroll', 'dedHealth', 'ded401k', 'dedOther', 'fedWh', 'medicareWh', 'socsecWh', 'sdi', 'stateWh']);
  });

  it('puts Time Clock hours beside each person by employee ID, and names Time Clock people missing from the ledger', () => {
    const hours = { people: [
      { employeeId: 'e-0084', name: 'Valinda Cranfill', regMin: 6000, otMin: 60, dtMin: 30, sickMin: 480, vacationMin: 0, payType: 'salary', rate: 5133.33 },
      { employeeId: 'GG-777', name: 'Only Punches', regMin: 600 },
      { employeeId: 'GG-778', name: 'No Hours', regMin: 0 },
    ] };
    const { rows, timeClockOnly } = withHours([valinda, pat], hours);
    expect(rows[0]).toMatchObject({ regMin: 6000, overtimeMin: 90, sickMin: 480, payType: 'salary', rate: 5133.33, codes: ['E-0084'], hoursIn: true });
    expect(rows[1]).toMatchObject({ regMin: 0, codes: ['GG-001'], hoursIn: true });
    expect(timeClockOnly).toEqual(['Only Punches']);
    expect(withHours([valinda], null).rows[0].hoursIn).toBe(false);
  });

  it('adds rows up into one, accounts merged, and groups by company or department', () => {
    const both = combine([valinda, pat]);
    expect(both.codes).toEqual(['E-0084', 'GG-001']);
    expect(both.cur.totalPayroll).toBe(53973.06);
    expect(both.people).toBe(2);
    const groups = groupRows([valinda, pat], 'company');
    expect(groups.map((g) => [g.label, g.people, g.cur.totalPayroll])).toEqual([['Greens Global', 1, 1000], ['Oversite Management, Inc', 1, 52973.06]]);
    expect(groupRows([{ ...pat, department: '' }], 'department')[0].label).toBe('No Department');
  });

  it('finds the accounts behind a figure: totals through their parts, the health split by side, one Other Benefits account', () => {
    expect(drillSpec(valinda, 'bonus', 'cur')).toEqual({ employees: ['E-0084'], accounts: ['61908'] });
    expect(drillSpec(valinda, 'totalPayroll', 'cur').accounts).toEqual(['61908', '61910']);
    expect(drillSpec(valinda, 'health', 'cur').accounts).toEqual(['61903:d']);
    expect(drillSpec(valinda, 'dedHealth', 'cur').accounts).toEqual(['61903:c']);
    expect(drillSpec(valinda, 'otherBenefits', 'cur', '63203').accounts).toEqual(['63203']);
    // Workers' comp is worked out on the gross wages: its lines are theirs.
    expect(drillSpec(valinda, 'workersComp', 'cur').accounts).toEqual(['61908', '61910']);
    expect(drillSpec(combine([valinda, pat]), 'payroll', 'cur')).toEqual({ employees: ['E-0084', 'GG-001'], accounts: ['61910', '61905'] });
  });

  it('heads the columns like Intacct', () => {
    expect(periodLabel('2026-01-01', '2026-12-31')).toBe('Year Ending 12/31/2026');
    expect(periodLabel('2026-01-01', '2026-09-30')).toBe('01/01/2026 - 09/30/2026');
  });

  it('builds one person\'s statement in Intacct\'s order, Other Benefits by account, optional lines only when used', () => {
    const rows = statementRows({ ...withHours([valinda], { people: [{ employeeId: 'E-0084', regMin: 6000 }] }).rows[0] });
    const labels = rows.map((r) => r.label);
    expect(labels.slice(0, 5)).toEqual(['Hours (from Time Clock)', 'Regular', 'Overtime', 'Sick', 'Vacation']);
    expect(rows.find((r) => r.label === 'Regular').cur).toBe(100);
    const at = (l) => labels.indexOf(l);
    expect(at('Payroll Expenses')).toBeLessThan(at('Bonus'));
    expect(at('Total Payroll Expenses')).toBeLessThan(at('Benefits'));
    expect(at('Other Benefits')).toBeLessThan(at('63203 Fuel'));
    expect(at('63410 Cell Phone')).toBeLessThan(at('Total Benefits'));
    expect(at("Workers' Comp")).toBeLessThan(at('Total Employer Expenses'));
    expect(at('Employee Taxes Withheld')).toBeLessThan(at('Employee Net Pay'));
    expect(labels).not.toContain('Other Payroll Taxes');
    expect(rows.find((r) => r.label === 'Salaried / Hourly Payroll')).toMatchObject({ prior: 57176.84, cur: 52123.06 });
    expect(rows.find((r) => r.label === '63203 Fuel')).toMatchObject({ kind: 'account', account: '63203', prior: 27004.72, cur: 20 });
    expect(rows.find((r) => r.label === 'Employee Net Pay')).toMatchObject({ kind: 'total', strong: true, cur: 39755.7 });
    const t = statementTable(valinda, { name: 'Valinda Cranfill (E-0084)', curLabel: 'Year Ending 12/31/2026', priorLabel: 'Year Ending 12/31/2025' });
    expect(t.columns.map((c) => c.label)).toEqual(['Line', 'Year Ending 12/31/2025', 'Year Ending 12/31/2026']);
    expect(t.rows.find((r) => r[0].trim() === 'Bonus')).toEqual(['  Bonus', 3500, 850]);
    expect(t.title).toBe('Employee Compensation Report - Valinda Cranfill (E-0084)');
  });

  it('says why a report is empty and what a failed Time Clock read means', () => {
    expect(emptyReason()).toMatch(/carries an employee/);
    expect(buildingHint(9)).toBe('Building 9 months of payroll cards for every employee. This can take up to a minute.');
    expect(loadErrorMessage({ isNetworkError: true, name: 'AbortError' }, 9)).toMatch(/took longer than 3 minutes/);
    expect(loadErrorMessage({ message: 'Too many' }, 9)).toBe('Too many');
  });
});
