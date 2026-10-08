import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Accounting > Budget > Export Intacct Import File (Charmi, item 43): one
// row per account and month, Intacct's period names, checked before a file
// is made - the problems are listed instead.

const budget = { location: '13000', year: 2026, source: 'nexus', rows: [
  { accountNo: '41101', title: 'Rental Income', months: [1000, 1000.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { accountNo: '61101', title: 'Professional Fees', months: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
] };
vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '13000', name: 'Darshana R. Kadakia MD Inc.' }] })),
    getAccountingBudget: vi.fn(async () => budget),
    getAccountingBuckets: vi.fn(async () => ({ rows: [] })),
    getRolesDirectory: vi.fn(async () => []),
    getPeopleDirectory: vi.fn(async () => []),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
  },
}));
vi.mock('../../ui/dialog', () => ({ dialog: { alert: vi.fn(async () => true), confirm: vi.fn(async () => true) } }));
const downloads = [];
vi.mock('./reportModel', async (orig) => ({ ...(await orig()), downloadCsv: (name, rows) => downloads.push({ name, rows }) }));

import BudgetTab from './BudgetTab';
import { INTACCT_BUDGET_HEADER, intacctBudgetFile, intacctPeriodName } from './budgetExport';

beforeEach(() => { downloads.length = 0; localStorage.clear(); });

describe('the Intacct budget import file', () => {
  it('writes one row per account and month that has an amount, with Intacct period names', () => {
    const f = intacctBudgetFile({ budgetId: '2026 Operating', location: '13000', year: 2026, rows: budget.rows });
    expect(f.problems).toEqual([]);
    expect(f.lines).toEqual([
      INTACCT_BUDGET_HEADER,
      ['2026 Operating', '41101', '13000', 'Month Ended January 2026', '1000.00'],
      ['2026 Operating', '41101', '13000', 'Month Ended February 2026', '1000.50'],
    ]);
    expect(intacctPeriodName(2026, 11)).toBe('Month Ended December 2026');
  });

  it('lists the problems instead of writing a bad file', () => {
    const f = intacctBudgetFile({ budgetId: '', location: '', year: 2026, rows: [{ accountNo: '', title: 'Mystery', months: [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }], dirty: true });
    expect(f.lines).toEqual([]);
    expect(f.problems).toEqual([
      'Give the Intacct budget ID the file loads into (Intacct > General Ledger > Budgets).',
      'Pick the entity the budget is for.',
      'Save the budget first - the file is made from what is saved.',
      '"Mystery" has no usable account number.',
    ]);
    expect(intacctBudgetFile({ budgetId: 'B1', location: '13000', year: 2026, rows: [budget.rows[1]] }).problems).toEqual(['Nothing to export - every month of every account is zero.']);
  });

  it('is a button on the Budget tab: problems first, then the file', async () => {
    render(<BudgetTab canEdit />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: /Export Intacct Import File/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Download File' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Give the Intacct budget ID/)).toBeTruthy();
    expect(downloads).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Intacct Budget ID'), { target: { value: 'STD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download File' }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0].name).toMatch(/^Intacct Budget Import - 13000 - \d{4} - STD\.csv$/);
    expect(downloads[0].rows).toHaveLength(3);
    expect(screen.getByText(/2 rows written/)).toBeTruthy();
  });
});
