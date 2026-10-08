import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Render-smoke for Accounting -> MRI. Oct 7 (Charmi, item 54): no Leasing /
// Interest and Loan Payments tabs - ONE list with a Type column and filter;
// the interest income accounts read by month from the ledger sit beside the
// leases, with the Export menu.

vi.mock('../../api', () => ({
  api: {
    getLeasingRentRollFor: vi.fn(async () => ({ year: 2026, asOf: '2026-10-06', rows: [], totals: [], summary: {}, linked: [] })),
    getAccountingLocations: vi.fn(async () => ({ entities: [] })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
    getAccountingBucketsFor: vi.fn(async () => ({ rows: [
      { account_no: '42500', title: 'Interest Income', section: 'other_income', bucket: '2026-01-01', debit: 0, credit: 120.5 },
      { account_no: '42500', title: 'Interest Income', section: 'other_income', bucket: '2026-02-01', debit: 0, credit: 130 },
      { account_no: '41101', title: 'Rental Income', section: 'revenue', bucket: '2026-01-01', debit: 0, credit: 3000 },
    ] })),
  },
}));

import MriTab from './MriTab';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => { vi.clearAllMocks(); try { localStorage.clear(); } catch { /* none */ } resetAccountingPrefs(); });

describe('MriTab', () => {
  it('is one list: interest income by month beside the leases, a Type filter, no tabs', async () => {
    render(<MriTab canEdit />);
    const row = (await screen.findByText('Interest Income')).closest('tr');
    expect(within(row).getByText('250.50')).toBeTruthy();
    expect(within(row).getByText('Interest')).toBeTruthy();
    expect(screen.queryByText('Rental Income')).toBeNull();      // rent is the leases'
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('button', { name: 'Type filter' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    expect(screen.getByRole('menuitem', { name: /Excel/ })).toBeTruthy();
  });
});
