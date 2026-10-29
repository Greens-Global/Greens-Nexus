import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render-smoke for Reports > Payroll & People > Payroll Summary (CR-09).

vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '12000', name: 'Greens Global, Inc.' }] })),
    getAccountingBuckets: vi.fn(async () => ({ labels: { 'E-0185': 'Bhole, Vinod', 'E-0200': 'Shah, Urmi' }, rows: [
      { bucket: 'E-0185', account_no: '61905', title: 'Wages - Hourly', section: 'expense', debit: 2000, credit: 0 },
      { bucket: 'E-0185', account_no: '23801', title: 'Federal Withholding Payable', section: 'liability', debit: 0, credit: 200 },
      { bucket: 'E-0185', account_no: '23700', title: 'Payroll Liability', section: 'liability', debit: 0, credit: 1800 },
      { bucket: 'E-0200', account_no: '61910', title: 'Wages - Salary', section: 'expense', debit: 4000, credit: 0 },
      { bucket: 'E-0200', account_no: '23700', title: 'Payroll Liability', section: 'liability', debit: 0, credit: 4000 },
    ] })),
    searchAccountingLedger: vi.fn(async () => ({ rows: [], total: 0 })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (p) => ({ prefs: p })),
  },
}));

import PayrollSummary from './PayrollSummary';
import { resetAccountingPrefs } from './prefs';
import { api } from '../../api';

beforeEach(() => { vi.clearAllMocks(); resetAccountingPrefs(); });

describe('Payroll Summary', () => {
  it('reads PYRJ by employee in one read and draws a column per employee with a Total', async () => {
    render(<PayrollSummary />);
    const table = await screen.findByRole('table');
    const call = api.getAccountingBuckets.mock.calls[0][0];
    expect(call).toMatchObject({ by: 'employee' });
    expect(call.dims.journals).toEqual(['PYRJ']);
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Payroll Item', 'Bhole, Vinod', 'Shah, Urmi', 'Total']);
    const row = (label) => [...table.querySelectorAll('tbody tr')].find((tr) => tr.firstChild.textContent === label);
    expect(row('Total Gross Pay').textContent).toMatch(/2,000\.00.*4,000\.00.*6,000\.00/);
    expect(row('Net Pay').textContent).toMatch(/1,800\.00.*4,000\.00.*5,800\.00/);
    expect(row('Total Payroll Cost')).toBeTruthy();
    // The reconciliation names the account no row reads (the net pay liability).
    expect(within(screen.getByRole('status', { name: 'Reconciliation to the payroll journal' })).getByText(/23700 Payroll Liability/)).toBeTruthy();
    expect(api.searchAccountingLedger).not.toHaveBeenCalled();
  });

  it('picks employees and turns the layout on its side', async () => {
    render(<PayrollSummary />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Employees' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Shah, Urmi/ }));
    await waitFor(() => expect([...screen.getByRole('table').querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Payroll Item', 'Shah, Urmi', 'Total']));
    fireEvent.change(screen.getByRole('combobox', { name: 'Layout' }), { target: { value: 'rows' } });
    expect(screen.getByRole('table').querySelector('thead th').textContent).toBe('Employee');
  });

  it('finds an employee by any part of the name and Enter picks the top match', async () => {
    render(<PayrollSummary />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Employees' }));
    const find = screen.getByLabelText('Find an employee');
    fireEvent.change(find, { target: { value: 'urm' } });
    expect(screen.getAllByRole('checkbox').map((c) => c.closest('label').textContent.trim())).toEqual(['Shah, Urmi']);
    fireEvent.keyDown(find, { key: 'Enter' });
    await waitFor(() => expect([...screen.getByRole('table').querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Payroll Item', 'Shah, Urmi', 'Total']));
  });

  // Call of 10/27 with Charmi, item 17: every amount opens its lines; columns resize.
  it('an amount opens its PYRJ lines for that employee in the side panel, and the columns resize', async () => {
    api.searchAccountingLedger.mockImplementation(async () => ({ rows: [{ line_id: 'l1', entry_id: 'e1', entry_no: 'PYRJ-9', entry_date: '2026-10-10', gl_code: '61905', account_name: 'Wages - Hourly', employee_id: 'E-0185', employee_name: 'Bhole, Vinod', description: 'Payroll 10/10/2026 - E-0185', debit: 2000, credit: 0 }], total: 1 }));
    render(<PayrollSummary />);
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('separator', { name: 'Resize the Bhole, Vinod column' })).toBeTruthy();
    expect(within(table).getByRole('separator', { name: 'Resize the Payroll Item column' })).toBeTruthy();
    fireEvent.click(within(table).getByRole('button', { name: 'Lines behind 61905 Wages - Hourly - Bhole, Vinod' }));
    const panel = await screen.findByRole('dialog', { name: '61905 Wages - Hourly - Bhole, Vinod' });
    await waitFor(() => expect(api.searchAccountingLedger).toHaveBeenCalledWith(expect.objectContaining({ journal: 'PYRJ', account: '61905', party_kind: 'employee', party: 'E-0185', offset: 0 })));
    expect(await within(panel).findByRole('button', { name: 'PYRJ-9' })).toBeTruthy();
    // The Total of Gross Pay reads every gross account, no employee filter.
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    api.searchAccountingLedger.mockClear();
    const gross = [...table.querySelectorAll('tbody tr')].find((tr) => tr.firstChild.textContent === 'Total Gross Pay');
    fireEvent.click(within(gross).getByRole('button', { name: 'Lines behind Total Gross Pay - Total' }));
    await waitFor(() => expect(api.searchAccountingLedger).toHaveBeenCalled());
    const calls = api.searchAccountingLedger.mock.calls.map(([q]) => q);
    expect(calls.every((q) => q.journal === 'PYRJ' && !q.party)).toBe(true);
    expect(calls.map((q) => q.account)).toContain('61910');
  });
});
