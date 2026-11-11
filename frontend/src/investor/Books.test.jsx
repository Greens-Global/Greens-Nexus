import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Investor Relations live from Intacct (Neil, 11/11/2026): the deal and
// investor panels render the books' figures, say why when the server answers
// {allowed: false}, and never show a figure then.
const calls = vi.hoisted(() => ({ getIrFundBooks: vi.fn(), getIrInvestorBooks: vi.fn() }));
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => (...a) => (calls[k] ? calls[k](...a) : Promise.resolve({})) }) }));
vi.mock('../components/accounting/LinesPanel', () => ({ default: () => null }));

const { DealBooks, InvestorBooks } = await import('./Books');

const DEAL = {
  allowed: true, linked: true, entity: '67000', entityName: 'Greens Austin, LLC.', asOf: '2026-11-11', book: 'accrual',
  partnerCapital: 714377,
  property: { assets: 1000000, liabilities: 350000, bookEquity: 650000, cash: 100000, revenueYtd: 80000, netIncomeYtd: 50000, cashAccounts: ['11101'], revenueAccounts: ['40001'], pnlAccounts: [] },
  members: [
    { investorId: '', name: 'Jitendra Jain', accounts: ['30031', '31019'], ec: 51477, contributed: 594876, distributed: 0, balance: 646353, share: 0.9048 },
    { investorId: 'i1', name: 'Neil Kadakia', accounts: ['30016', '31010', '32013'], ec: -40207, contributed: 138231, distributed: 30000, balance: 68024, share: 0.0952, nexus: { called: 100000, distributed: 30000 } },
  ],
};

beforeEach(() => { Object.values(calls).forEach((f) => f.mockReset()); });

describe('Live from Intacct', () => {
  it('shows a deal\'s figures and members, with a Nexus gap flagged', async () => {
    calls.getIrFundBooks.mockResolvedValue(DEAL);
    render(<DealBooks fundId="f1" />);
    expect(await screen.findByText('Jitendra Jain')).toBeTruthy();
    expect(screen.getByText('$714,377')).toBeTruthy();
    expect(screen.getByText('$646,353')).toBeTruthy();
    expect(screen.getByText(/Nexus capital calls show \$100,000 paid in/)).toBeTruthy();
    expect(screen.getByText('Add 1 Profile')).toBeTruthy();
    expect(screen.getByText(/as of 11\/11\/2026/)).toBeTruthy();
  });

  it('says why and shows no figure without Accounting access', async () => {
    calls.getIrFundBooks.mockResolvedValue({ allowed: false, reason: 'Live figures come from Intacct and need Accounting access.' });
    render(<DealBooks fundId="f1" />);
    expect(await screen.findByText(/need Accounting access/)).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it('lists an investor\'s positions with a total', async () => {
    calls.getIrInvestorBooks.mockResolvedValue({
      allowed: true, accounts: ['30016', '31010', '32013'], asOf: '2026-11-11', total: 68024,
      positions: [{ entity: '67000', name: 'Greens Austin, LLC.', accounts: ['30016', '31010', '32013'], ec: -40207, contributed: 138231, distributed: 30000, balance: 68024, fundId: 'f1', fundName: 'Greens Austin' }],
    });
    render(<InvestorBooks investorId="i1" />);
    expect(await screen.findByText('Greens Austin, LLC.')).toBeTruthy();
    expect(screen.getAllByText('$68,024').length).toBe(2);
  });
});
