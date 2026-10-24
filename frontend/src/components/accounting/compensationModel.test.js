import { describe, it, expect } from 'vitest';
import { buildingHint, compensationTable, currenciesOf, emptyReason, hoursOf, ledgerTable, loadErrorMessage, monthsBetween, viewRows } from './compensationModel';

// Employee Compensation (Oct 15): hours, the views and the export tables.

const person = (o) => ({ email: 'pat@x.com', name: 'Pat Hourly', employeeId: 'GG-001', companyName: 'Greens Global', department: 'Maintenance', title: 'Technician',
  payType: 'hourly', currency: 'USD', rate: 26, regMin: 9600, otMin: 240, dtMin: 60, sickMin: 960, vacationMin: 0, personalMin: 0, wages: 5000, ...o });
const total = (o) => ({ key: '', label: 'Total', currency: 'USD', people: 1, regMin: 9600, otMin: 240, dtMin: 60, sickMin: 960, vacationMin: 0, personalMin: 0, wages: 5000, ...o });
const one = { people: [person()], byCompany: [total({ label: 'Greens Global' })], byDepartment: [total({ label: 'Maintenance' })], totals: [total()] };

describe('compensationModel', () => {
  it('counts months and turns minutes into hours', () => {
    expect(monthsBetween('2025-11', '2026-02')).toBe(4);
    expect(monthsBetween('2026-03', '2026-02')).toBe(0);
    expect(monthsBetween('', '2026-02')).toBe(0);
    expect(hoursOf(90)).toBe(1.5);
    expect(hoursOf(null)).toBe(0);
  });

  it('picks the rows of a view', () => {
    expect(viewRows(one, 'people')).toHaveLength(1);
    expect(viewRows(one, 'company')[0].label).toBe('Greens Global');
    expect(viewRows(one, 'department')[0].label).toBe('Maintenance');
    expect(viewRows(null, 'people')).toEqual([]);
    expect(currenciesOf(one)).toEqual(['USD']);
  });

  it('exports people with a live Totals line in one currency', () => {
    const t = compensationTable(one, 'people', { period: '01/01/2026 - 09/30/2026' });
    expect(t.title).toBe('Compensation - By Employee');
    expect(t.columns.map((c) => c.label)).toContain('Gross Wages');
    expect(t.rows[0].slice(0, 8)).toEqual(['Pat Hourly', 'GG-001', 'Greens Global', 'Maintenance', 'Technician', 'Hourly', 'USD', 26]);
    expect(t.rows[0].slice(8, 11)).toEqual([160, 4, 1]);
    expect(t.totals[0]).toBe('Total');
    expect(t.period).toBe('01-01-2026 - 09-30-2026');
  });

  it('never adds two currencies together', () => {
    const two = { ...one, people: [person(), person({ email: 's@x.com', currency: 'INR', wages: 90000 })], totals: [total({ currency: 'INR', wages: 90000 }), total()] };
    const t = compensationTable(two, 'company');
    expect(t.totals).toBeNull();
    expect(t.rows.slice(-2).map((r) => r[0])).toEqual(['Total INR', 'Total USD']);
  });

  it('exports the ledger payroll expense, split Direct / Indirect (CR-02)', () => {
    const t = ledgerTable({ by: 'department', rows: [{ key: '9100', label: 'Maintenance', wages: 1000, taxes: 80, benefits: 0, direct: 700, indirect: 380, total: 1080 }],
      totals: { wages: 1000, taxes: 80, benefits: 0, direct: 700, indirect: 380, total: 1080 } });
    expect(t.columns.map((c) => c.label)).toEqual(['Department', 'Wages', 'Employer Taxes', 'Benefits', 'Direct', 'Indirect', 'Total']);
    expect(t.rows[0]).toEqual(['Maintenance', 1000, 80, 0, 700, 380, 1080]);
    expect(t.totals).toEqual(['Total', 1000, 80, 0, 700, 380, 1080]);
    // A ledger read from before the split exports zeros, not holes.
    expect(ledgerTable({ by: 'department', rows: [{ label: 'X', wages: 1, taxes: 0, benefits: 0, total: 1 }], totals: {} }).rows[0]).toEqual(['X', 1, 0, 0, 0, 0, 1]);
  });

  it('says why a report is empty, from the counts only', () => {
    expect(emptyReason({ coverage: { roster: 0, punches: 0, ratesSet: 0 } })).toMatch(/No one is on the payroll roster/);
    expect(emptyReason({ coverage: { roster: 5, punches: 0, ratesSet: 0 } })).toMatch(/no pay rate is set for any of the 5 people/);
    expect(emptyReason({ coverage: { roster: 1, punches: 0, ratesSet: 1 } })).toMatch(/1 person is on the roster/);
    expect(emptyReason({ coverage: { roster: 5, punches: 40, ratesSet: 5 } })).toMatch(/There are 40 punches .* zero hours and zero wages/);
    expect(emptyReason({})).toBe('No hours or wages on any payroll card in these months.');
  });

  it('words the loading hint and our own timeout', () => {
    expect(buildingHint(9)).toMatch(/^Building 9 months of payroll cards/);
    expect(buildingHint(1)).toMatch(/^Building 1 month of/);
    expect(loadErrorMessage({ isNetworkError: true, name: 'AbortError' }, 9)).toBe('Building 9 months took longer than 3 minutes, so it was stopped. Pick fewer months and run it again.');
    expect(loadErrorMessage(new Error('Pick fewer months and run it again.'), 9)).toBe('Pick fewer months and run it again.');
  });
});
