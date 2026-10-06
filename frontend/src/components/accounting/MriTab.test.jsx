import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Render-smoke for Accounting -> MRI (Oct 6): Leasing opens first; Interest
// and Loan Payments reads the income accounts by month, with a Total column
// and the Export menu.

vi.mock('../../api', () => ({
  api: {
    getLeasingRentRollFor: vi.fn(async () => ({ year: 2026, asOf: '2026-10-06', rows: [], totals: [], summary: {}, linked: [] })),
    getAccountingLocations: vi.fn(async () => ({ entities: [] })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
    getAccountingBuckets: vi.fn(async () => ({ rows: [
      { account_no: '42500', title: 'Interest Income', section: 'other_income', bucket: '2026-01-01', debit: 0, credit: 120.5 },
      { account_no: '42500', title: 'Interest Income', section: 'other_income', bucket: '2026-02-01', debit: 0, credit: 130 },
      { account_no: '41101', title: 'Rental Income', section: 'revenue', bucket: '2026-01-01', debit: 0, credit: 3000 },
    ] })),
  },
}));

import MriTab from './MriTab';

beforeEach(() => { vi.clearAllMocks(); });

describe('MriTab', () => {
  it('opens on Leasing and shows interest income by month with a total', async () => {
    render(<MriTab canEdit />);
    expect(await screen.findByText(/No leases yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Interest and Loan Payments' }));
    const row = (await screen.findByText('Interest Income')).closest('tr');
    expect(within(row).getByText('250.50')).toBeTruthy();
    expect(screen.queryByText('Rental Income')).toBeNull();      // rent is Leasing's
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    expect(screen.getByRole('menuitem', { name: /Excel/ })).toBeTruthy();
  });
});
