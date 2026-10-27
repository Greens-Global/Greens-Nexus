import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Accounting > Reporting > Profitability (Oct 15): renders the sheet, opens a
// figure into its accounts, and an account drills into Reports.

const fig = (o) => ({ revenue: 1050, opex: 300, noi: 750, noiMargin: 71.43, interest: 100, da: 150, netIncome: 500, netMargin: 47.62, debtService: 180, cashFlowAfterDebt: 570, ...o });
const sheet = {
  from: '2026-01-01', to: '2026-12-31', priorFrom: '2025-01-01', priorTo: '2025-12-31', book: 'accrual', months: 12, expand: false, notes: [],
  rows: [{
    code: '15000', name: 'Sunset Plaza', parent: null,
    current: { ...fig(), accounts: { revenue: [{ account: '40100', title: 'Rental Income', amount: 1050 }], opex: [{ account: '60100', title: 'Repairs', amount: 300 }], interest: [], da: [] } },
    prior: fig({ netIncome: 600 }), change: { netIncome: { amount: -100, pct: -16.67 }, noi: { amount: 0, pct: 0 }, revenue: { amount: 0, pct: 0 }, cashFlowAfterDebt: { amount: 0, pct: 0 } },
  }],
  totals: { current: fig(), prior: fig({ netIncome: 600 }), change: { netIncome: { amount: -100, pct: -16.67 } } },
};

vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '15000', name: 'Sunset Plaza' }] })),
    getProfitability: vi.fn(async () => sheet),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
    searchAccountingLedger: vi.fn(async () => ({ rows: [{ line_id: 'l1', entry_id: 'e1', entry_no: 'AR-7', entry_date: '2026-03-01', gl_code: '40100', account_name: 'Rental Income', description: 'March rent', debit: 0, credit: 1050 }], total: 1 })),
  },
}));
vi.mock('./drill', () => ({ requestReportDrill: vi.fn() }));

import ProfitabilityReport from './ProfitabilityReport';
import { api } from '../../api';
import { requestReportDrill } from './drill';

beforeEach(() => { vi.clearAllMocks(); });

describe('ProfitabilityReport', () => {
  it('renders the sheet with the prior-year comparison', async () => {
    render(<ProfitabilityReport />);
    expect(await screen.findByText('Sunset Plaza')).toBeTruthy();
    expect(screen.getByText('Profitability Sheet')).toBeTruthy();
    expect(screen.getByText('Prior Year Net Income')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /^Cash Flow After Debt Service/ })).toBeTruthy();
    expect(screen.getAllByText('(16.7%)').length).toBeGreaterThan(0);
    expect(api.getProfitability).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-01-01$/), expect.stringMatching(/^\d{4}-12-31$/), { locations: [], book: 'accrual', expand: false });
  });

  it('opens NOI into its accounts and an account into the ledger', async () => {
    render(<ProfitabilityReport />);
    fireEvent.click(await screen.findByRole('button', { name: 'NOI for Sunset Plaza' }));
    const panel = screen.getByRole('region', { name: 'Accounts Behind the Figure' });
    expect(within(panel).getByText('Repairs')).toBeTruthy();
    expect(within(panel).getByText('(300.00)')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: '40100' }));
    expect(requestReportDrill).toHaveBeenCalledWith({ account: '40100', accountName: 'Rental Income', from: '2026-01-01', to: '2026-12-31', entity: '15000', book: 'accrual' });
  });

  // Call of 10/27 with Charmi, item 17: an account amount opens its lines on the right; the columns resize.
  it('an account amount opens its ledger lines in the side panel, and every column resizes', async () => {
    render(<ProfitabilityReport />);
    await screen.findByText('Sunset Plaza');
    for (const c of ['Entity', 'Revenue', 'NOI', 'Debt Service', 'Prior Year', 'Change %']) expect(screen.getByRole('separator', { name: `Resize the ${c} column` })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revenue for Sunset Plaza' }));
    const region = screen.getByRole('region', { name: 'Accounts Behind the Figure' });
    fireEvent.click(within(region).getByRole('button', { name: 'Lines behind 40100 Rental Income' }));
    const panel = await screen.findByRole('dialog', { name: '40100 Rental Income, Sunset Plaza' });
    expect(await within(panel).findByRole('button', { name: 'AR-7' })).toBeTruthy();
    expect(api.searchAccountingLedger).toHaveBeenCalledWith({ account: '40100', location: '15000', from: '2026-01-01', to: '2026-12-31', book: 'accrual', offset: 0, limit: 500 });
    fireEvent.click(within(panel).getByRole('button', { name: /Open in Reports/ }));
    expect(requestReportDrill).toHaveBeenCalledWith({ account: '40100', accountName: 'Rental Income', from: '2026-01-01', to: '2026-12-31', entity: '15000', book: 'accrual' });
  });

  it('asks again with sub-entities', async () => {
    render(<ProfitabilityReport />);
    await screen.findByText('Sunset Plaza');
    fireEvent.click(screen.getByLabelText('Show Sub-Entities'));
    expect(api.getProfitability).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), { locations: [], book: 'accrual', expand: true });
  });

  it('says what went wrong', async () => {
    api.getProfitability.mockRejectedValueOnce(new Error('Accounting service: down'));
    render(<ProfitabilityReport />);
    expect(await screen.findByText('Accounting service: down')).toBeTruthy();
  });
});
