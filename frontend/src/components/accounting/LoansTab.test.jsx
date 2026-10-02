import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render-smoke for Accounting -> Loans & Financing (Neil and Charmi, 10/02):
// the review table per loan with DSCR against the covenant, the totals and
// the maturities strip; Set Up From the Ledger listing what the balance
// sheet proposes, with the ones already set up marked; the empty state that
// says what was looked for; and the "not available" state when the
// accounting service is not connected.

const loan = (over = {}) => ({
  id: 'FL1', loanNo: '6870', lender: 'F&M Bank', kind: 'external', entityCode: '15000', entityName: 'Greens Escondido, LLC.', glAccount: '27100', balanceSource: 'ledger',
  balance: 1250000, balanceMonthAgo: 1254200, balanceYearAgo: 1300000, principalPaid: 4200, interestPaid: 6250, debtService: 10450,
  principalPaidT12: 50000, interestPaidT12: 76000, debtServiceT12: 126000, entityDebtServiceT12: 126000, noiT12: 201600, incomeT12: 300000, operatingExpensesT12: 98400,
  dscr: 1.6, covenantMin: 1.35, covenantTyped: false, belowCovenant: false, ratePct: 6.1, rateType: 'fixed', maturity: '2027-06-30', monthlyPi: 10450, isActive: true, notes: '', sharedWith: 0, ...over,
});
const review = {
  month: '2026-09', asOf: '2026-09-30', monthAgo: '2026-08-31', yearAgo: '2025-09-30', trailingFrom: '2025-10-01', defaultCovenant: 1.35,
  loans: [
    loan({ id: 'FL2', loanNo: '9001', lender: 'Chase', entityCode: '56000', entityName: 'MCD Services, Inc.', glAccount: '27200', balance: 400000, balanceMonthAgo: 401000, balanceYearAgo: 412000, principalPaid: 1000, interestPaid: 2000, debtService: 3000, principalPaidT12: 12000, interestPaidT12: 24000, debtServiceT12: 36000, entityDebtServiceT12: 36000, noiT12: 36000, dscr: 1.0, belowCovenant: true, maturity: '2026-12-31' }),
    loan(),
  ],
  byLender: [{ lender: 'F&M Bank', label: 'F&M Bank', loans: 1, balance: 1250000, debtServiceT12: 126000, interestT12: 76000, noiT12: 201600, dscr: 1.6 }, { lender: 'Chase', label: 'Chase', loans: 1, balance: 400000, debtServiceT12: 36000, interestT12: 24000, noiT12: 36000, dscr: 1.0 }],
  byEntity: [{ entityCode: '15000', label: 'Greens Escondido, LLC.', loans: 1, balance: 1250000, debtServiceT12: 126000, interestT12: 76000, noiT12: 201600, dscr: 1.6 }, { entityCode: '56000', label: 'MCD Services, Inc.', loans: 1, balance: 400000, debtServiceT12: 36000, interestT12: 24000, noiT12: 36000, dscr: 1.0 }],
  maturities: [{ month: '2026-12', balance: 400000, loans: [{ id: 'FL2', lender: 'Chase', loanNo: '9001', entityName: 'MCD Services, Inc.', balance: 400000, maturity: '2026-12-31' }]}, { month: '2027-06', balance: 1250000, loans: [{ id: 'FL1', lender: 'F&M Bank', loanNo: '6870', entityName: 'Greens Escondido, LLC.', balance: 1250000, maturity: '2027-06-30' }] }],
  summary: { loans: 2, balance: 1650000, debtServiceT12: 162000, belowCovenant: 1, entities: 2 },
  lookedFor: ['Loan', 'Mortgage', 'Note Payable / Notes', 'Line of Credit / LOC / HELOC', 'Financing / Promissory / Borrowing', "a lender's name (F&M, Citi, Chase, BofA, Wells Fargo, SBA, PNC, US Bank, a bank or credit union)"],
};
const proposals = {
  month: '2026-09', asOf: '2026-09-30', entitiesScanned: 3, liabilityAccounts: 14, lookedFor: review.lookedFor, setUp: 1, missing: 2,
  proposals: [
    { entityCode: '15000', entityName: 'Greens Escondido, LLC.', glAccount: '27100', title: 'F&M Loan #6870', balance: 1250000, lender: 'F&M Bank', kind: 'external', balanceSource: 'ledger', status: 'set_up', loanId: 'FL1' },
    { entityCode: '12000', entityName: 'Greens Global, Inc.', glAccount: '27300', title: 'SBA EIDL Loan', balance: 150000, lender: 'SBA', kind: 'external', balanceSource: 'ledger', status: 'new', loanId: null },
    { entityCode: '12000', entityName: 'Greens Global, Inc.', glAccount: '27500', title: 'Loan from Greens Escondido, LLC.', balance: 80000, lender: 'Greens Escondido, LLC.', kind: 'intercompany', balanceSource: 'ledger', status: 'new', loanId: null },
  ],
};

vi.mock('../../api', () => ({
  api: {
    getLoanReview: vi.fn(async () => review),
    getLoanProposals: vi.fn(async () => proposals),
    createLoansFromLedger: vi.fn(async ({ items }) => ({ created: items.map((i) => ({ ...proposals.proposals.find((p) => p.glAccount === i.glAccount), loanNo: i.glAccount })), skipped: [] })),
    updateLoan: vi.fn(async () => ({ ok: true })),
  },
}));

import LoansTab from './LoansTab';
import { api } from '../../api';

beforeEach(() => { vi.clearAllMocks(); api.getLoanReview.mockImplementation(async () => review); });

describe('LoansTab', () => {
  it('reviews every loan for the month, DSCR against the covenant, sorted lowest first', async () => {
    render(<LoansTab canEdit />);
    // The lender appears in the review table and again under By Lender; the review row is first.
    const chase = (await screen.findAllByText('Chase'))[0].closest('tr');
    const fm = screen.getAllByText('F&M Bank')[0].closest('tr');
    // Chase (1.00x, below the 1.35 default) comes before F&M (1.60x).
    expect(chase.compareDocumentPosition(fm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(chase).getByText('1.00x / 1.35x')).toBeTruthy();
    expect(within(fm).getByText('1.60x / 1.35x')).toBeTruthy();
    expect(within(fm).getByText('1,250,000.00')).toBeTruthy();
    expect(within(fm).getByText('4,200.00')).toBeTruthy();       // principal paid
    expect(within(fm).getByText('6,250.00')).toBeTruthy();       // interest paid
    expect(within(fm).getByText('201,600.00')).toBeTruthy();     // NOI T12
    expect(within(fm).getByText('6.10% fixed')).toBeTruthy();
    expect(within(fm).getByText('06/30/2027')).toBeTruthy();     // US date
    expect(screen.getByText('By Lender')).toBeTruthy();
    expect(screen.getByText('By Entity')).toBeTruthy();
    expect(screen.getByText('Maturities - Next 24 Months')).toBeTruthy();
    expect(api.getLoanReview).toHaveBeenCalledTimes(1);
  });

  it('proposes loans from the ledger, marks the ones set up, and creates the ticked ones once', async () => {
    render(<LoansTab canEdit />);
    await screen.findAllByText('F&M Bank');
    fireEvent.click(screen.getByRole('button', { name: /Set Up From the Ledger/ }));
    const dialog = await screen.findByRole('dialog', { name: /Set up loans from the ledger/ });
    await within(dialog).findByText('SBA EIDL Loan');
    // The one already in fin_loans has no checkbox; the new ones are ticked.
    expect(within(dialog).getByText('Set Up')).toBeTruthy();
    expect(within(dialog).getAllByText('New')).toHaveLength(2);
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(dialog).getByText('Intercompany')).toBeTruthy();
    // Untick the intercompany one and create the rest.
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Loan from Greens Escondido/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create 1 Loan' }));
    await within(dialog).findByText('1 loan set up.');
    expect(api.createLoansFromLedger).toHaveBeenCalledWith({ month: expect.stringMatching(/^\d{4}-\d{2}$/), items: [{ entityCode: '12000', glAccount: '27300' }] });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(api.getLoanReview).toHaveBeenCalledTimes(2));
  });

  it('edits the typed fields through the same row', async () => {
    render(<LoansTab canEdit />);
    await screen.findAllByText('F&M Bank');
    fireEvent.click(screen.getByRole('button', { name: 'Edit F&M Bank' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change loan' });
    fireEvent.change(within(dialog).getByLabelText('Covenant Minimum (DSCR)'), { target: { value: '1.25' } });
    fireEvent.change(within(dialog).getByLabelText('Rate %'), { target: { value: '6.25' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateLoan).toHaveBeenCalled());
    const [id, month, body] = api.updateLoan.mock.calls[0];
    expect(id).toBe('FL1');
    expect(month).toMatch(/^\d{4}-\d{2}$/);
    expect(body).toMatchObject({ lender: 'F&M Bank', ratePct: 6.25, rateType: 'fixed', maturity: '2027-06-30', covenantMin: 1.25 });
  });

  it('says what it looked for when nothing is set up, and where to add one by hand', async () => {
    api.getLoanReview.mockImplementation(async () => ({ ...review, loans: [], byLender: [], byEntity: [], maturities: [], summary: { loans: 0, balance: 0, debtServiceT12: 0, belowCovenant: 0, entities: 0 } }));
    render(<LoansTab canEdit />);
    await screen.findByText('No loans set up for the entities you may read.');
    expect(screen.getByText(/whose title says Loan, Mortgage, Note Payable/)).toBeTruthy();
    expect(screen.getByText(/Accounting > Data > Loans/)).toBeTruthy();
  });

  it('says so when the accounting service is not connected, and hides Set Up', async () => {
    api.getLoanReview.mockImplementation(async () => { const e = new Error('Accounting service is not configured (ACCOUNTING_BASE_URL / ACCOUNTING_INTERNAL_KEY)'); e.status = 503; throw e; });
    render(<LoansTab canEdit />);
    await screen.findByText('Loans & Financing is not available here.');
    expect(screen.queryByRole('button', { name: /Set Up From the Ledger/ })).toBeNull();
  });
});
