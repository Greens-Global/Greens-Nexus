import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render-smoke for Accounting -> Loans & Financing -> Loan Planning (Charmi,
// item 25, Oct 15): the mortgage calculator, the DSCR check against the
// entity's NOI and existing loans, the schedule by payment / by year, saving
// a planned loan, comparing two, and a viewer who cannot save.

const loans = [{ id: 'FL1', lender: 'F&M Bank', entityCode: '15000', entityName: 'Greens Escondido, LLC.', balance: 500000, ratePct: 5, monthlyPi: 2684.11, noiT12: 264000, isActive: true }];
const ENTITIES = [{ code: '15000', name: 'Greens Escondido, LLC.' }, { code: '12000', name: 'Greens Global, Inc.' }];
const plan = (over = {}) => ({
  id: 'P1', entityCode: '15000', name: 'Chase 10/30', by: 'charmi@greensglobal.com', at: '2026-10-15T10:00:00Z',
  params: { loanAmount: 1000000, ratePct: 6, amortYears: 30, termYears: 10, frequency: 'monthly', lender: 'Chase', closeDate: '2026-12-15', dscrTarget: 1.25 }, ...over,
});

vi.mock('../../api', () => ({
  api: {
    getPlannedLoans: vi.fn(async () => ({ planned: [] })),
    createPlannedLoan: vi.fn(async (body) => ({ planned: { id: 'NEW', ...body, by: 'me', at: '' } })),
    updatePlannedLoan: vi.fn(async (id, body) => ({ planned: { id, ...body, by: 'me', at: '' } })),
    deletePlannedLoan: vi.fn(async () => ({ ok: true })),
    getLoanStressSettings: vi.fn(async () => ({ entities: {}, excluded: [] })),
    getLoanEntityNoi: vi.fn(async () => ({ entities: { 12000: { noi: 90000, annualized: 95000 } } })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({ ok: true })),
  },
}));

import LoanPlanning from './LoanPlanning';
import { api } from '../../api';

beforeEach(() => { vi.clearAllMocks(); });

const typeAmount = (labelText, value) => {
  const el = screen.getByLabelText(labelText);
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
};

describe('LoanPlanning', () => {
  it('works out $1,000,000 at 6% over 30 years and checks it against the entity', async () => {
    render(<LoanPlanning loans={loans} entities={ENTITIES} picked={['15000']} canEdit to="2026-09-30" />);
    expect(await screen.findByText(/No planned loans yet/)).toBeInTheDocument();
    typeAmount('Loan Amount', '1,000,000');
    fireEvent.change(screen.getByLabelText('Interest Rate %'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('Term (Years)'), { target: { value: '30' } });
    const tile = screen.getByText('Monthly Payment (P&I)').parentElement;
    expect(within(tile).getByText('5,995.51')).toBeInTheDocument();
    expect(screen.getByText('Balloon at Maturity').parentElement).toHaveTextContent('None');
    // The entity's T12 NOI from the Loans review against its F&M loan plus this one.
    const check = screen.getByText(/DSCR Check - Greens Escondido/).closest('div').parentElement;
    expect(within(check).getByText('264,000.00')).toBeInTheDocument();
    expect(within(check).getByText(/Max Loan at 1.25x/)).toBeInTheDocument();
    expect(screen.getByText('Amortization Schedule')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'By Year' }));
    expect(screen.getByRole('columnheader', { name: 'Year-End Balance' })).toBeInTheDocument();
  });

  it('shows a balloon when the term is shorter, and saves the plan', async () => {
    render(<LoanPlanning loans={loans} entities={ENTITIES} picked={['15000']} canEdit to="2026-09-30" />);
    await screen.findByText(/No planned loans yet/);
    typeAmount('Loan Amount', '1m');
    fireEvent.change(screen.getByLabelText('Interest Rate %'), { target: { value: '6' } });
    expect(screen.getByText('Balloon at Maturity').parentElement).toHaveTextContent('836,8');
    fireEvent.click(screen.getByRole('button', { name: /Save Planned Loan/ }));
    expect(await screen.findByText('Name the planned loan to save it.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chase 10/30' } });
    fireEvent.change(screen.getByLabelText('Lender'), { target: { value: 'Chase' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Planned Loan/ }));
    await waitFor(() => expect(api.createPlannedLoan).toHaveBeenCalled());
    const body = api.createPlannedLoan.mock.calls[0][0];
    expect(body).toMatchObject({ name: 'Chase 10/30', entityCode: '15000' });
    expect(body.params).toMatchObject({ loanAmount: 1000000, ratePct: '6', amortYears: 30, termYears: 10, lender: 'Chase', frequency: 'monthly' });
    expect(await screen.findByText('Saved Chase 10/30.')).toBeInTheDocument();
    expect(screen.getByText('Planned Loan - Chase 10/30')).toBeInTheDocument();
  });

  it('compares two planned loans side by side and reads NOI for an entity without loans', async () => {
    api.getPlannedLoans.mockResolvedValueOnce({ planned: [plan(), plan({ id: 'P2', name: 'Golden 25', entityCode: '12000', params: { loanAmount: 400000, ratePct: 7, amortYears: 25, frequency: 'monthly' } })] });
    render(<LoanPlanning loans={loans} entities={ENTITIES} to="2026-09-30" />);
    expect(await screen.findByText('Chase 10/30')).toBeInTheDocument();
    await waitFor(() => expect(api.getLoanEntityNoi).toHaveBeenCalledWith({ entities: ['12000'], from: '2025-10-01', to: '2026-09-30' }));
    fireEvent.click(screen.getByLabelText('Compare Chase 10/30'));
    fireEvent.click(screen.getByLabelText('Compare Golden 25'));
    expect(screen.getByText('Compare Planned Loans')).toBeInTheDocument();
    expect(screen.getByText('Max Loan at Target')).toBeInTheDocument();
    // Opening one loads it into the calculator.
    fireEvent.click(screen.getByLabelText('Compare Golden 25').closest('tr'));
    expect(screen.getByText('Planned Loan - Golden 25')).toBeInTheDocument();
    // A viewer opens and compares, never saves or removes.
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
    expect(screen.queryByLabelText('Remove Chase 10/30')).toBeNull();
  });
});
