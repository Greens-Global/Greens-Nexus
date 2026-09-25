import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render-smoke for the dense statement table (Neil, Sep 25): code and name
// on one line, sections fold on click, every amount drills, and a drill
// requested from another tab (the Close tab's Current Balance) opens the
// ledger lines when the tab mounts.

const pnl = {
  org: 'Greens Global',
  generated_at: '2026-09-25',
  sections: [
    { key: 'revenue', label: 'Revenue', total: 1500, accounts: [{ account_no: '41000', title: 'Rental Income', amount: 1000 }, { account_no: '41100', title: 'Parking Income', amount: 500 }] },
    { key: 'expense', label: 'Operating Expenses', total: 400, accounts: [{ account_no: '61000', title: 'Repairs', amount: 400 }] },
  ],
  totals: { gross_profit: 1500, operating_income: 1100, net_income: 1100 },
};

vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '32000', name: 'Greens Capital', parent_code: null }] })),
    getAccountingPnl: vi.fn(async () => pnl),
    getAccountingBalanceSheet: vi.fn(async () => ({ sections: [], totals: {} })),
    getAccountingCashPosition: vi.fn(async () => ({ accounts: [], total: 0 })),
    getAccountingTrialBalance: vi.fn(async () => ({ rows: [], totals: {} })),
    getAccountingDimensionValues: vi.fn(async () => ({ values: [] })),
    searchAccountingLedger: vi.fn(async () => ({ lines: [], total: 0, facets: {} })),
  },
}));
vi.mock('./LedgerSearch', () => ({ default: ({ drill }) => <div data-testid="ledger-search">{drill ? `drill:${drill.account}:${drill.to}` : 'search'}</div> }));

import ReportsTab from './ReportsTab';
import { requestReportDrill } from './drill';

beforeEach(() => { localStorage.clear(); window.scrollTo = vi.fn(); });

describe('ReportsTab statement table', () => {
  it('puts the GL code and the name on one line, folds a section, drills from an amount', async () => {
    render(<ReportsTab />);
    const cell = await screen.findByText('Rental Income');
    const label = cell.closest('td');
    expect(label.className).toContain('acct-label');
    expect(within(label).getByText('41000').className).toContain('acct-code');
    // Compact by default, dense rows.
    expect(screen.getByRole('button', { name: 'Compact' }).getAttribute('aria-pressed')).toBe('true');

    // Fold Revenue: its accounts disappear, the total stays, the count shows.
    fireEvent.click(screen.getByRole('button', { name: 'Fold Revenue' }));
    expect(screen.queryByText('Rental Income')).toBeNull();
    expect(screen.queryByText('Parking Income')).toBeNull();
    expect(screen.getAllByText('1,500.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Expand All')).toBeTruthy();
    fireEvent.click(screen.getByText('Expand All'));
    expect(screen.getByText('Rental Income')).toBeTruthy();

    // Every account amount is a drill button.
    fireEvent.click(screen.getByText('400.00', { selector: 'button' }));
    expect(screen.getByTestId('ledger-search').textContent).toContain('drill:61000');
  });

  it('opens the drill a widget on another tab asked for', async () => {
    requestReportDrill({ account: '11452', accountName: 'GC Chase Chkg', from: '', to: '2026-08-31', entity: '32000' });
    render(<ReportsTab />);
    await waitFor(() => expect(screen.getByTestId('ledger-search').textContent).toBe('drill:11452:2026-08-31'));
  });
});
