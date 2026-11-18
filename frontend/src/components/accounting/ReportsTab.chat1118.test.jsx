import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Accounting > Reports, Teams chat of 11/05/2026 (Priyanka): the vendors on
// Spend by Vendor sort, not only the accounts under each; and every report
// heading carries the funnel value list MRE, MRI and AMA have.

const PNL = {
  org: 'Greens Global', generated_at: '2026-11-18',
  sections: [
    { key: 'revenue', accounts: [{ account_no: '41000', title: 'Rental Income', amount: 1500 }] },
    { key: 'expense', accounts: [{ account_no: '61000', title: 'Advertising', amount: 400 }, { account_no: '69000', title: 'Miscellaneous', amount: 25 }] },
  ],
};
const VENDOR_ROWS = {
  labels: { V00001: 'Alpha Supply', V00009: 'Zeta Builders' },
  rows: [
    { account_no: '62100', title: 'Engineering Fees', section: 'expense', bucket: 'V00001', debit: 100, credit: 0 },
    { account_no: '62100', title: 'Engineering Fees', section: 'expense', bucket: 'V00009', debit: 900, credit: 0 },
  ],
};

vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '15000', name: 'Greens Escondido', parent_code: null }] })),
    getAccountingPnl: vi.fn(async () => PNL),
    getAccountingBalanceSheet: vi.fn(async () => ({ sections: [] })),
    getAccountingBuckets: vi.fn(async ({ by }) => (by === 'vendor' ? VENDOR_ROWS : { rows: [] })),
    getAccountingDimensionValues: vi.fn(async () => ({ values: [] })),
    getAccountingJournals: vi.fn(async () => ({ available: true, journals: [] })),
    getAccountingBooks: vi.fn(async () => ({ available: false })),
    searchAccountingLedger: vi.fn(async () => ({ rows: [], total: 0 })),
    getAccountingSavedReports: vi.fn(async () => []),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (prefs) => ({ prefs })),
    getRolesDirectory: vi.fn(async () => []),
    getPeopleDirectory: vi.fn(async () => []),
  },
}));

import ReportsTab from './ReportsTab';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); resetAccountingPrefs(); vi.clearAllMocks(); window.scrollTo = vi.fn(); });

const groupOrder = () => screen.getAllByRole('button', { name: /^Open V0000/ }).map((b) => b.getAttribute('aria-label'));

describe('Reports, chat of 11/05/2026', () => {
  it('Spend by Vendor sorts the vendors themselves, by name and by total', async () => {
    render(<ReportsTab report="vendor-spend" />);
    await screen.findByRole('button', { name: 'Open V00001 Alpha Supply' });
    const nameHead = screen.getByRole('button', { name: 'Vendor / Account' });
    fireEvent.click(nameHead);
    expect(groupOrder()).toEqual(['Open V00001 Alpha Supply', 'Open V00009 Zeta Builders']);
    fireEvent.click(nameHead);
    expect(groupOrder()).toEqual(['Open V00009 Zeta Builders', 'Open V00001 Alpha Supply']);
    // By the amount column: smallest vendor first, then largest first.
    const total = screen.getAllByTitle(/^Sort by /).find((b) => b.getAttribute('title') !== 'Sort by Vendor / Account');
    fireEvent.click(total);
    expect(groupOrder()).toEqual(['Open V00001 Alpha Supply', 'Open V00009 Zeta Builders']);
    fireEvent.click(total);
    expect(groupOrder()).toEqual(['Open V00009 Zeta Builders', 'Open V00001 Alpha Supply']);
  });

  it('every heading has the funnel value list, and a pick narrows the lines', async () => {
    render(<ReportsTab report="pnl" />);
    expect(await screen.findByText('Advertising')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Filter Account by value' }));
    const panel = await screen.findByRole('dialog', { name: 'Account values' });
    fireEvent.click(within(panel).getByLabelText('(Select All)'));
    fireEvent.click(within(panel).getByLabelText(/^61000 Advertising/));
    await waitFor(() => expect(screen.queryByText('Miscellaneous')).toBeNull());
    expect(screen.getAllByText('Advertising').length).toBeGreaterThan(0);
    expect(screen.queryByText('Rental Income')).toBeNull();
    expect(screen.getByRole('button', { name: 'Filter Account by value (on)' })).toBeTruthy();
    // The funnel is on the amount headings too.
    expect(screen.getAllByRole('button', { name: /^Filter .+ by value/ }).length).toBeGreaterThan(1);
  });
});
