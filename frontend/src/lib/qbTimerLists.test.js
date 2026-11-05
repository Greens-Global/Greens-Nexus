import { describe, it, expect } from 'vitest';
import { parseTimerLists, guessPayItems } from './qbTimerLists';

// Charmi, 11/06/2026: QuickBooks refused Regular Pay / Overtime Pay /
// Vacation Pay. Her Timer Lists export carries the real names.
const FILE = [
  '!TIMERHDR\tVER\tREL\tCOMPANYNAME\tIMPORTEDBEFORE\tFROMTIMER\tCOMPANYCREATETIME',
  'TIMERHDR\t8\t0\tOversite Management, Inc.\tN\tN\t1465508185',
  '!HDR\tPROD\tVER',
  'HDR\tQuickBooks\tVersion 34',
  '!EMP\tNAME\tREFNUM',
  'EMP\tPat Test\t1',
  '!PAYITEM\tNAME\tREFNUM\tHIDDEN',
  'PAYITEM\tHourly Rate\t1\tN',
  'PAYITEM\t"Overtime (x1.5) hourly"\t2\tN',
  'PAYITEM\tDouble-time hourly\t3\tN',
  'PAYITEM\tSick Hourly\t4\tN',
  'PAYITEM\tVacation Hourly\t5\tN',
  'PAYITEM\tSalary\t6\tN',
  'PAYITEM\tOld Bonus\t7\tY',
].join('\r\n');

describe('parseTimerLists', () => {
  it('reads the header and the live payroll items', () => {
    const got = parseTimerLists(FILE);
    expect(got.companyName).toBe('Oversite Management, Inc.');
    expect(got.createTime).toBe('1465508185');
    expect(got.payrollItems).toEqual(['Double-time hourly', 'Hourly Rate', 'Overtime (x1.5) hourly', 'Salary', 'Sick Hourly', 'Vacation Hourly']);
  });

  it('returns nothing for a file that is not an IIF', () => {
    const got = parseTimerLists('hello\nworld');
    expect(got.payrollItems).toEqual([]);
    expect(got.createTime).toBe('');
  });
});

describe('guessPayItems', () => {
  it('matches each pay class to the one item that fits', () => {
    expect(guessPayItems(parseTimerLists(FILE).payrollItems)).toEqual({
      regular: 'Hourly Rate', overtime: 'Overtime (x1.5) hourly', doubleTime: 'Double-time hourly',
      sick: 'Sick Hourly', vacation: 'Vacation Hourly',
    });
  });

  it('guesses nothing between two candidates', () => {
    expect(guessPayItems(['Hourly Rate', 'Hourly Wage']).regular).toBeUndefined();
    expect(guessPayItems(['Overtime (x2) hourly']).overtime).toBeUndefined();
    expect(guessPayItems(['Overtime (x2) hourly']).doubleTime).toBe('Overtime (x2) hourly');
  });
});
