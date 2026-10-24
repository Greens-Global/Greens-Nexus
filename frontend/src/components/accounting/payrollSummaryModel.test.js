import { describe, it, expect } from 'vitest';
import { employeeFromDescription, pickEmployees, resolveNoEmployee, summarize, tableOf } from './payrollSummaryModel';

// Payroll Summary (CR-09): the PYRJ import laid out as QuickBooks' Payroll
// Summary - one employee's pay date as the import writes it (payrollConvert.js).

const r = (bucket, account_no, title, debit, credit) => ({ bucket, account_no, title, debit, credit });
// E-0185: Hourly 2,000 + Overtime 300; Fed WH 200, Medicare 33.35, SS 142.60;
// 401(k) 100 and Health 50 deducted; company FUTA 12, Medicare 33.35, SS 142.60,
// Health 75; net pay 1,774.05 to 23700 (plus the company's health 75).
const ROWS = [
  r('E-0185', '61905', 'Wages - Hourly', 2000, 0),
  r('E-0185', '61909', 'Wages - Overtime', 300, 0),
  r('E-0185', '23801', 'Federal Withholding Payable', 0, 200),
  r('E-0185', '23804', 'Medicare Payable - Employee', 0, 33.35),
  r('E-0185', '23807', 'Social Security Payable - Employee', 0, 142.6),
  r('E-0185', '23101', '401(k) Payable', 0, 100),
  r('E-0185', '61903', 'Health Insurance', 75, 50),
  r('E-0185', '62101', 'FUTA Expense', 12, 0),
  r('E-0185', '62102', 'Medicare Expense', 33.35, 0),
  r('E-0185', '62104', 'Social Security Expense', 142.6, 0),
  r('E-0185', '23802', 'FUTA Payable', 0, 12),
  r('E-0185', '23805', 'Medicare Payable - Company', 0, 33.35),
  r('E-0185', '23808', 'Social Security Payable - Company', 0, 142.6),
  r('E-0185', '23700', 'Payroll Liability', 0, 1849.05),
  r('E-0200', '61910', 'Wages - Salary', 4000, 0),
  r('E-0200', '23700', 'Payroll Liability', 0, 4000),
];

describe('payroll summary', () => {
  it('lays the import out like QuickBooks: gross, withheld, deductions, net pay, employer, total cost', () => {
    const s = summarize(ROWS, { 'E-0185': 'Bhole, Vinod', 'E-0200': 'Shah, Urmi' });
    expect(s.employees.map((e) => e.name)).toEqual(['Bhole, Vinod', 'Shah, Urmi']);
    const at = (key) => s.rows.find((x) => x.key === key);
    expect(at('gross-total').values).toEqual({ 'E-0185': 2300, 'E-0200': 4000 });
    expect(at('withheld-total').values['E-0185']).toBe(375.95);
    // 61903: the employee's 50 is a deduction, the company's 75 an employer contribution.
    expect(at('deductions-61903').values['E-0185']).toBe(50);
    expect(at('employer-61903').values['E-0185']).toBe(75);
    expect(at('deductions-total').values['E-0185']).toBe(150);
    expect(at('net-pay').values).toEqual({ 'E-0185': 1774.05, 'E-0200': 4000 });
    expect(at('employer-total').total).toBe(262.95);
    expect(at('cost').total).toBe(6562.95);
    expect(s.rows.map((x) => x.kind).filter((k) => k === 'section')).toHaveLength(4);
  });

  it('reconciles to PYRJ: balanced, and lists any account no row reads', () => {
    const s = summarize(ROWS);
    expect(s.check.balanced).toBe(true);
    // The liability side of the employer taxes and net pay is not a row - it is listed.
    expect(s.unmapped.map((u) => u.account).sort()).toEqual(['23700', '23802', '23805', '23808']);
    expect(s.check.reconciled).toBe(false);
    const mapped = summarize(ROWS, {}, [
      { key: 'gross', label: 'Gross Pay', side: 'debit', accounts: ['61905', '61909', '61910'] },
      { key: 'withheld', label: 'Taxes Withheld', side: 'credit', accounts: ['23801', '23804', '23807'] },
      { key: 'deductions', label: 'Deductions From Net Pay', side: 'credit', accounts: ['23101', '61903'] },
      { key: 'employer', label: 'Employer Taxes and Contributions', side: 'debit', accounts: ['62101', '62102', '62104', '61903'] },
      { key: 'liabilities', label: 'Liabilities', side: 'credit', accounts: ['23700', '23802', '23805', '23808'] },
    ]);
    expect(mapped.check.reconciled).toBe(true);
  });

  it('narrows to the employees picked and lays employees as columns or rows', () => {
    const s = pickEmployees(summarize(ROWS), ['E-0200']);
    expect(s.rows.find((x) => x.key === 'cost').total).toBe(4000);
    const cols = tableOf(s, 'columns');
    expect(cols.columns.map((c) => c.label)).toEqual(['Payroll Item', 'E-0200', 'Total']);
    const rows = tableOf(s, 'rows');
    expect(rows.columns[0].label).toBe('Employee');
    expect(rows.rows.at(-1).label).toBe('Total');
  });

  it('reads the employee from the import description when the line has none', () => {
    expect(employeeFromDescription('Payroll 09/30/2026 - E-0185')).toBe('E-0185');
    expect(employeeFromDescription('GG Payroll 09/30/2026 - Vinod Bhole')).toBe('Vinod Bhole');
    expect(employeeFromDescription('Rent for October')).toBe('');
    const rows = [r('', '61905', 'Wages', 500, 0), r('E-1', '61905', 'Wages', 10, 0)];
    const lines = [{ employee_id: '', description: 'Payroll 09/30/2026 - E-0185', gl_code: '61905', account_name: 'Wages', debit: 500, credit: 0 }];
    const got = resolveNoEmployee(rows, lines);
    expect(got.moved).toBe(1);
    expect(got.rows.map((x) => [x.bucket, x.debit])).toEqual([['E-1', 10], ['desc:E-0185', 500]]);
    expect(got.names['desc:E-0185']).toBe('E-0185 (from the description)');
  });
});
