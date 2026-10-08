import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Reports on a phone (Neil, Oct 1): the search box first and full width, the
// report picker, and one Filters button that folds every other control away
// until it is tapped. The desktop row is covered in ReportsTab.test.jsx.

vi.mock('../../lib/useIsMobile', () => ({ useIsMobile: () => true }));

const pnl = {
  org: 'Greens Global', generated_at: '2026-09-25',
  sections: [{ key: 'revenue', label: 'Revenue', total: 1500, accounts: [{ account_no: '41000', title: 'Rental Income', amount: 1500 }] }],
  totals: { gross_profit: 1500, operating_income: 1500, net_income: 1500 },
};

vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '32000', name: 'Greens Capital', parent_code: null }] })),
    getAccountingPnl: vi.fn(async () => pnl),
    getAccountingBalanceSheet: vi.fn(async () => ({ sections: [], totals: {} })),
    getAccountingCashPosition: vi.fn(async () => ({ accounts: [], total: 0 })),
    getAccountingTrialBalance: vi.fn(async () => ({ rows: [], totals: {} })),
    getAccountingBuckets: vi.fn(async () => ({ org: 'Greens Global', generated_at: '2026-09-25', labels: {}, rows: [] })),
    getAccountingDimensionValues: vi.fn(async () => ({ values: [] })),
    searchAccountingLedger: vi.fn(async () => ({ rows: [], total: 0, facets: {} })),
    getAccountingSavedReports: vi.fn(async () => []),
    saveAccountingReport: vi.fn(async (body) => ({ id: 'r1', ...body, mine: true })),
    updateAccountingSavedReport: vi.fn(async (id, body) => ({ id, ...body })),
    deleteAccountingSavedReport: vi.fn(async () => ({})),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (prefs) => ({ prefs })),
    getRolesDirectory: vi.fn(async () => []),
    getPeopleDirectory: vi.fn(async () => []),
  },
}));
vi.mock('./LedgerSearch', () => ({ default: ({ term }) => <div data-testid="ledger-search">{`search:${term}`}</div> }));

import ReportsTab from './ReportsTab';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => { localStorage.clear(); resetAccountingPrefs(); vi.clearAllMocks(); window.scrollTo = vi.fn(); });

describe('ReportsTab on a phone', () => {
  it('shows the search and the report picker; the other controls wait behind Filters', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    const search = screen.getByLabelText('Search the ledger');
    expect(search.parentElement.style.flex).toBe('1 1 100%');
    expect(screen.getByLabelText('Report')).toBeTruthy();
    const filters = screen.getByRole('button', { name: /^Filters/ });
    expect(filters.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Book')).toBeNull();
    expect(screen.queryByRole('button', { name: /Fill the screen/ })).toBeNull();

    fireEvent.click(filters);
    expect(filters.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Book')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Fill the screen/ })).toBeTruthy();
    // A filter in force is counted on the button.
    fireEvent.change(screen.getByLabelText('Book'), { target: { value: 'cash' } });
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toBeTruthy();
  });
});
