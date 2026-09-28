import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render-smoke for Accounting -> Reports.
//   Sep 25 morning (Neil): code and name on one line, sections fold on click,
//   every amount drills, a drill requested from another tab opens its lines.
//   Sep 25 call (Neil, Charmi): every control is a dropdown on one row, there
//   is no Refresh and no chip row, the book is Accrual / Cash / both, the
//   custom dates are not capped by each other, the search shows it is
//   working, and Memorize keeps the view.

const pnl = {
  org: 'Greens Global',
  generated_at: '2026-09-25',
  sections: [
    { key: 'revenue', label: 'Revenue', total: 1500, accounts: [{ account_no: '41000', title: 'Rental Income', amount: 1000 }, { account_no: '41100', title: 'Parking Income', amount: 500 }] },
    { key: 'expense', label: 'Operating Expenses', total: 400, accounts: [{ account_no: '61000', title: 'Repairs', amount: 400 }] },
  ],
  totals: { gross_profit: 1500, operating_income: 1100, net_income: 1100 },
};
const cash = { ...pnl, sections: [{ ...pnl.sections[0], total: 1200, accounts: [{ account_no: '41000', title: 'Rental Income', amount: 1200 }] }, pnl.sections[1]] };

vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '32000', name: 'Greens Capital', parent_code: null }, { code: '15000', name: 'Greens Escondido', parent_code: null }] })),
    getAccountingPnl: vi.fn(async (from, to, location, dims, book) => (book === 'cash' ? cash : pnl)),
    getAccountingBalanceSheet: vi.fn(async () => ({ sections: [], totals: {} })),
    getAccountingCashPosition: vi.fn(async () => ({ accounts: [], total: 0 })),
    getAccountingTrialBalance: vi.fn(async () => ({ rows: [], totals: {} })),
    getAccountingDimensionValues: vi.fn(async () => ({ values: [{ code: 'C-1', name: 'Valley Center' }, { code: 'C-2', name: 'Old Program (H)' }] })),
    searchAccountingLedger: vi.fn(async () => ({ rows: [], total: 0, facets: {} })),
    getAccountingSavedReports: vi.fn(async () => []),
    saveAccountingReport: vi.fn(async (body) => ({ id: 'r1', ...body, mine: true })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (prefs) => ({ prefs })),
    getRolesDirectory: vi.fn(async () => []),
    getPeopleDirectory: vi.fn(async () => []),
  },
}));
vi.mock('./LedgerSearch', () => ({
  default: ({ drill, term, onBusy }) => {
    onBusy?.(false);
    return <div data-testid="ledger-search">{drill ? `drill:${drill.account}:${drill.to}:${drill.book}` : `search:${term}`}</div>;
  },
}));

import ReportsTab from './ReportsTab';
import { api } from '../../api';
import { requestReportDrill } from './drill';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => { localStorage.clear(); resetAccountingPrefs(); vi.clearAllMocks(); window.scrollTo = vi.fn(); });

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
    await waitFor(() => expect(screen.getByTestId('ledger-search').textContent).toBe('drill:11452:2026-08-31:accrual'));
  });
});

describe('ReportsTab controls', () => {
  it('is one row of dropdowns: report by name, no chips, no Refresh', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    const report = screen.getByLabelText('Report');
    expect(report.tagName).toBe('SELECT');
    expect([...report.options].map((o) => o.textContent)).toEqual(['Income Statement', 'Balance Sheet', 'Trial Balance', 'Cash Position']);
    expect(screen.queryByText('Profit & Loss')).toBeNull();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    expect(screen.queryByText(/add filter/i)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Income Statement' })).toBeTruthy();
  });

  it('reads the cash book, and both books side by side', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    const book = screen.getByLabelText('Book');
    expect([...book.options].map((o) => o.textContent)).toEqual(['Accrual', 'Cash', 'Accrual and Cash']);
    fireEvent.change(book, { target: { value: 'both' } });
    await screen.findByRole('columnheader', { name: 'Cash' });
    expect(screen.getByRole('columnheader', { name: 'Accrual' })).toBeTruthy();
    const row = screen.getByText('Rental Income').closest('tr');
    expect(within(row).getByText('1,000.00')).toBeTruthy();
    expect(within(row).getByText('1,200.00')).toBeTruthy();
    // Two books leave no room for a comparison.
    expect(screen.queryByLabelText('Compare')).toBeNull();
    // The cash amount drills into the cash book.
    fireEvent.click(within(row).getByText('1,200.00'));
    expect(screen.getByTestId('ledger-search').textContent).toMatch(/^drill:41000:.*:cash$/);
  });

  it('lets the custom dates move freely', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'custom' } });
    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    // A calendar capped at the other date could not move to a later month.
    expect(from.getAttribute('max')).toBeNull();
    expect(to.getAttribute('min')).toBeNull();
    fireEvent.change(from, { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-31' } });
    await waitFor(() => expect(api.getAccountingPnl).toHaveBeenLastCalledWith('2026-08-01', '2026-08-31', undefined, null, 'accrual'));
    // A start after the end takes the end with it.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-10' } });
    await waitFor(() => expect(api.getAccountingPnl).toHaveBeenLastCalledWith('2026-09-10', '2026-09-10', undefined, null, 'accrual'));
  });

  it('picks several entities from a searchable dropdown', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: 'Entities' }));
    fireEvent.change(screen.getByLabelText('Search entity by name or code'), { target: { value: 'escon' } });
    expect(screen.queryByRole('option', { name: /Greens Capital/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /Greens Escondido/ }));
    await waitFor(() => expect(api.getAccountingPnl.mock.calls.at(-1)[2]).toBe('15000'));
    fireEvent.change(screen.getByLabelText('Search entity by name or code'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('option', { name: /Greens Capital/ }));
    await waitFor(() => expect(api.getAccountingPnl.mock.calls.at(-1)[3]?.locations).toEqual(['15000', '32000']));
  });

  it('hides historical (H) classes in the dimension lists', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: 'Dimensions' }));
    fireEvent.click(screen.getByRole('button', { name: /Project-Job/ }));
    await screen.findByRole('option', { name: /Valley Center/ });
    expect(screen.queryByRole('option', { name: /Old Program/ })).toBeNull();
  });

  it('memorizes the view on screen', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.change(screen.getByLabelText('Book'), { target: { value: 'cash' } });
    fireEvent.click(screen.getByRole('button', { name: /Memorize/ }));
    const name = screen.getByLabelText('What would you like to name it?');
    fireEvent.change(name, { target: { value: 'GG Cash Income Statement' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveAccountingReport).toHaveBeenCalled());
    const body = api.saveAccountingReport.mock.calls[0][0];
    expect(body.name).toBe('GG Cash Income Statement');
    expect(body.shared).toBe(false);
    // The controls are kept, a named period by its name - never the figures.
    expect(body.config).toMatchObject({ report: 'pnl', preset: 'ytd', book: 'cash', compare: 'none', entities: [] });
    expect(body.config.from).toBeUndefined();
  });

  it('shows the search is working from the first keystroke', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.change(screen.getByLabelText('Search the ledger'), { target: { value: '500' } });
    expect(screen.getByLabelText('Searching')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('ledger-search').textContent).toBe('search:500'));
  });
});
