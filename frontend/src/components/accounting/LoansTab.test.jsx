import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render-smoke for Accounting -> Loans & Financing (Neil and Charmi, 10/02;
// Oct 6 feedback): the loans for the period with the filters on top
// (Entities, period, Internal / External, text), closed loans hidden until
// Customize > Show Closed Loans, the columns as asked (Lender, Loan #, Entity,
// Monthly Payment right after Entity, Original Principal with its "edited"
// mark; no Debit Balance chip, no Month Ago / Year Ago), the per-loan detail
// with the payments in the period and the payment history, + Add > From the
// Ledger (polling scan) and Manual, Change Loan, the Export menu, skeleton
// rows while loading, and the "not available" state.

vi.mock('../../egnyte/EgnyteFolderPick', () => ({ default: () => null }));

const loan = (over = {}) => ({
  id: 'FL1', loanNo: '6870', lender: 'F&M Bank', kind: 'external', internal: false, internalTyped: false, entityCode: '15000', entityName: 'Greens Escondido, LLC.', glAccount: '27100', glTitle: 'F&M Loan #6870',
  balanceSource: 'ledger', wiring: 'ok', closed: false, isActive: true, balance: 1252000, owed: 1252000, debitBalance: false,
  originalPrincipal: 1400000, originalPrincipalLedger: 1400000, originalPrincipalDate: '2020-01-15', originalPrincipalEdited: false,
  principalPaid: 4000, draws: 0, interestPaid: 6000, debtService: 10000, principalPaidT12: 48000, interestPaidT12: 72000, debtServiceT12: 120000,
  interestAccount: '71100', interestAccounts: [{ code: '71100', title: 'Interest - F&M 6870' }], interestSource: 'matched', interestSharedWith: 0, sharedWith: 0,
  entityDebtServiceT12: 120000, noiT12: 264000, incomeT12: 300000, operatingExpensesT12: 36000, dscr: 2.2, covenantMin: 1.35, covenantTyped: false, belowCovenant: false,
  ratePct: 6.1, rateType: 'fixed', maturity: '2027-06-30', monthlyPayment: 10000, monthlyPi: 10000, notes: '', docsPath: '/Shared/Loans/F&M', statementsPath: '', docsUrl: 'https://greensglobal.egnyte.com/app/index.do#storage/files/1/Shared/Loans/F&M', statementsUrl: null, ...over,
});
const review = {
  from: '2026-10-01', to: '2026-10-06', asOf: '2026-10-06', month: '2026-10', trailingFrom: '2025-10-07', defaultCovenant: 1.35,
  loans: [
    loan(),
    loan({ id: 'FL2', loanNo: '9001', lender: 'Chase', entityCode: '56000', entityName: 'MCD Services, Inc.', glAccount: '27200', balance: 400000, owed: 400000, principalPaid: 1000, interestPaid: 2000, debtService: 3000, dscr: 1.0, belowCovenant: true, maturity: '2026-12-31', monthlyPayment: 3000, originalPrincipal: 500000, originalPrincipalEdited: true, originalPrincipalLedger: null, docsUrl: null }),
    loan({ id: 'FL3', loanNo: 'IC-1', lender: 'Greens Global, Inc.', kind: 'intercompany', internal: true, entityCode: '15000', glAccount: '27500', balance: 20000, owed: 20000, principalPaid: 0, interestPaid: null, debtService: 0, dscr: null, monthlyPayment: null, originalPrincipal: 20000, docsUrl: null }),
    loan({ id: 'FL4', loanNo: 'OLD', lender: 'Old Wells Fargo', glAccount: '27900', balance: 0, owed: 0, closed: true, principalPaid: 0, interestPaid: 0, debtService: 0, docsUrl: null }),
    loan({ id: 'FL5', loanNo: 'G1', lender: 'Golden 1 Credit Union', glAccount: '26023', balance: 14500000, owed: -14500000, debitBalance: true, docsUrl: null }),
  ],
  byLender: [], byEntity: [], maturities: [],
  summary: { loans: 4, closed: 1, balance: 16172000, debtServiceT12: 0, belowCovenant: 1, entities: 2 },
  lookedFor: ['Loan', 'Mortgage', 'Note Payable / Notes'],
};
const history = (from) => ({
  loanId: 'FL1', entityCode: '15000', glAccount: '27100', from, to: '2026-10-06',
  principal: { account: '27100', total: from ? 1 : 2, debit: from ? 4000 : 4000, credit: from ? 0 : 1400000, truncated: false, lines: [
    { date: '2026-10-01', entryId: 'e-pmt', entryNo: 'GJ-1001', description: 'October payment', debit: 4000, credit: 0 },
    ...(from ? [] : [{ date: '2020-01-15', entryId: 'e-fund', entryNo: 'GJ-1', description: 'Loan funding', debit: 0, credit: 1400000 }]),
  ] },
  interest: [{ account: '71100', total: 1, debit: 6000, credit: 0, truncated: false, lines: [{ date: '2026-10-01', entryId: 'e-pmt', entryNo: 'GJ-1001', description: 'October payment', debit: 6000, credit: 0 }] }],
  notes: [],
});
const proposals = {
  asOf: '2026-10-06', entitiesScanned: 253, parentsSkipped: 64, historicalSkipped: 26, paidOff: 9, liabilityAccounts: 14, lookedFor: review.lookedFor, setUp: 1, missing: 3,
  proposals: [
    { entityCode: '15000', entityName: 'Greens Escondido, LLC.', glAccount: '27100', title: 'F&M Loan #6870', balance: 1252000, debitBalance: false, lender: 'F&M Bank', kind: 'external', status: 'set_up', loanId: 'FL1' },
    { entityCode: '12000', entityName: 'Greens Global, Inc.', glAccount: '27300', title: 'SBA EIDL Loan', balance: 150000, debitBalance: false, lender: 'SBA', kind: 'external', status: 'new', loanId: null },
    { entityCode: '15000', entityName: 'Greens Escondido, LLC.', glAccount: '27500', title: 'Due to Greens Global', balance: 20000, debitBalance: false, lender: 'Greens Global, Inc.', kind: 'intercompany', status: 'new', loanId: null },
    { entityCode: '15001', entityName: '(G) Greens Escondido, LLC.', glAccount: '26023', title: 'GE - Golden 1 Credit Union - 5860 - (Mortgage)', balance: 14500000, debitBalance: true, lender: 'Golden 1 Credit Union', kind: 'external', status: 'new', loanId: null },
  ],
};
const scanning = (done, total) => ({ scanning: true, done, total, startedAt: '2026-10-02T18:00:00Z' });
const ENTITIES = [{ code: '15000', name: 'Greens Escondido, LLC.' }, { code: '56000', name: 'MCD Services, Inc.' }, { code: '12000', name: 'Greens Global, Inc.' }, { code: 'H13000', name: '(H) Old Holdings LLC' }];

vi.mock('../../api', () => ({
  api: {
    getLoansReview: vi.fn(async () => review),
    getLoanProposalsAsOf: vi.fn(async () => proposals),
    createLoansFromLedger: vi.fn(async ({ items }) => ({ created: items.map((i) => ({ ...proposals.proposals.find((p) => p.glAccount === i.glAccount), loanNo: i.glAccount })), skipped: [] })),
    createManualLoan: vi.fn(async () => ({ ok: true, loanId: 'NEW' })),
    updateLoan: vi.fn(async () => ({ ok: true })),
    getLoanAccounts: vi.fn(async () => ({ principal: [{ code: '27100', title: 'F&M Loan #6870', section: 'liability', balance: 1252000 }], interest: [{ code: '71100', title: 'Interest - F&M 6870', interest: true }, { code: '71200', title: 'Interest Expense - Other', interest: true }] })),
    getLoanHistory: vi.fn(async (_id, { from }) => history(from)),
    getAccountingLocations: vi.fn(async () => ({ entities: ENTITIES, limited: false })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({ ok: true })),
    getAccountingEntry: vi.fn(async () => ({ entry: { entry_no: 'GJ-1001', date: '2026-10-01' }, lines: [], totals: { debit: 0, credit: 0 } })),
  },
}));

import LoansTab, { SetupDialog, _test } from './LoansTab';
import { resetAccountingPrefs } from './prefs';
import { api } from '../../api';

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountingPrefs();
  try { localStorage.clear(); } catch { /* private */ }
  api.getLoansReview.mockImplementation(async () => review);
  api.getLoanProposalsAsOf.mockImplementation(async () => proposals);
  api.getLoanHistory.mockImplementation(async (_id, { from }) => history(from));
});

const rowOf = async (text) => (await screen.findAllByText(text))[0].closest('tr');

describe('LoansTab', () => {
  it('lists the open loans with the columns asked for, closed ones hidden', async () => {
    render(<LoansTab canEdit />);
    const fm = await rowOf('F&M Bank');
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent).filter(Boolean);
    expect(heads.slice(0, 6)).toEqual(['Lender', 'Loan #', 'Entity', 'Monthly Payment', 'Original Principal', 'Balance']);
    expect(heads).not.toContain('Month Ago');
    expect(heads).not.toContain('Year Ago');
    expect(heads).not.toContain('Lender / Loan');
    expect(within(fm).getByText('6870')).toBeTruthy();
    expect(within(fm).getByText('1,252,000.00')).toBeTruthy();
    expect(within(fm).getByText('1,400,000.00')).toBeTruthy();   // original principal
    expect(within(fm).getByText('4,000.00')).toBeTruthy();       // principal paid
    expect(within(fm).getByText('6,000.00')).toBeTruthy();       // interest paid
    expect(within(fm).getByText('6.10% fixed')).toBeTruthy();
    expect(within(fm).getByText('06/30/2027')).toBeTruthy();     // US date
    expect(within(fm).queryByText(/GL 27100/)).toBeNull();       // no GL line under the name
    expect(within(fm).getByRole('link', { name: /Loan documents of F&M Bank/ }).getAttribute('href')).toContain('#storage/files/1/Shared/Loans');
    // The original principal typed over the ledger says so.
    const chase = await rowOf('Chase');
    expect(within(chase).getByText('edited')).toBeTruthy();
    // A debit balance is a positive figure with a hover note - no chip.
    const golden = await rowOf('Golden 1 Credit Union');
    expect(within(golden).getByText('14,500,000.00')).toBeTruthy();
    expect(screen.queryByText('Debit Balance')).toBeNull();
    // Closed loans are hidden until Customize > Show Closed Loans.
    expect(screen.queryByText('Old Wells Fargo')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    fireEvent.click(screen.getByLabelText(/Show Closed Loans/));
    expect((await screen.findAllByText('Old Wells Fargo')).length).toBeGreaterThan(0);
    expect(screen.getByText('By Lender')).toBeTruthy();
    expect(screen.getByText('Maturities - Next 24 Months')).toBeTruthy();
    expect(api.getLoansReview).toHaveBeenCalledTimes(1);
    expect(api.getLoansReview.mock.calls[0][0]).toMatchObject({ from: expect.stringMatching(/^\d{4}-\d{2}-01$/), to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), entities: [] });
  });

  it('filters by Internal / External and by text, and reads again for the entities picked', async () => {
    render(<LoansTab canEdit />);
    await rowOf('F&M Bank');
    fireEvent.change(screen.getByLabelText('Internal or External'), { target: { value: 'internal' } });
    expect(screen.queryByText('F&M Bank')).toBeNull();
    expect(screen.getAllByText('Greens Global, Inc.').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Internal or External'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Filter loans'), { target: { value: 'chase' } });
    expect(screen.queryAllByText('F&M Bank')).toHaveLength(0);
    expect(screen.getAllByText('Chase').length).toBeGreaterThan(0);
    // Entities: the Reports picker; the historical (H) entity is not offered.
    fireEvent.click(screen.getByRole('button', { name: 'Entities' }));
    const list = await screen.findByRole('listbox', { name: 'Entities' });
    expect(within(list).queryByText('(H) Old Holdings LLC')).toBeNull();
    fireEvent.click(within(list).getByText('MCD Services, Inc.'));
    await waitFor(() => expect(api.getLoansReview).toHaveBeenCalledTimes(2));
    expect(api.getLoansReview.mock.calls[1][0].entities).toEqual(['56000']);
  });

  it('opens a loan: the payments in the period, then the whole history, each entry opening', async () => {
    render(<LoansTab canEdit />);
    const fm = await rowOf('F&M Bank');
    fireEvent.click(fm);
    const detail = await screen.findByLabelText('Details of F&M Bank');
    await within(detail).findByText('October payment');
    expect(api.getLoanHistory).toHaveBeenCalledWith('FL1', expect.objectContaining({ from: expect.stringMatching(/-01$/), interest: '71100' }));
    const pay = within(detail).getByText('October payment').closest('tr');
    expect(within(pay).getByText('4,000.00')).toBeTruthy();
    expect(within(pay).getByText('6,000.00')).toBeTruthy();
    expect(within(pay).getByText('10,000.00')).toBeTruthy();
    // The payment history opens and closes.
    expect(within(detail).queryByText('Loan funding')).toBeNull();
    fireEvent.click(within(detail).getByRole('button', { name: /Payment History/ }));
    await within(detail).findByText('Loan funding');
    expect(api.getLoanHistory).toHaveBeenLastCalledWith('FL1', expect.objectContaining({ from: '' }));
    // The balance after each entry, back from today's balance.
    const funding = within(detail).getByText('Loan funding').closest('tr');
    expect(within(funding).getByText('1,400,000.00')).toBeTruthy();        // the draw
    expect(within(funding).getByText('1,256,000.00')).toBeTruthy();        // the balance after it: today's 1,252,000 plus the 4,000 paid since
    const october = within(detail).getAllByText('October payment').at(-1).closest('tr');
    expect(within(october).getByText('1,252,000.00')).toBeTruthy();
    fireEvent.click(within(detail).getByRole('button', { name: /Payment History/ }));
    expect(within(detail).queryByText('Loan funding')).toBeNull();
    // An entry number opens the entry.
    fireEvent.click(within(detail).getAllByRole('button', { name: 'GJ-1001' })[0]);
    await waitFor(() => expect(api.getAccountingEntry).toHaveBeenCalledWith('e-pmt'));
  });

  it('+ Add > From the Ledger proposes active-entity loans and creates the ticked ones once', async () => {
    render(<LoansTab canEdit />);
    await rowOf('F&M Bank');
    expect(screen.queryByRole('button', { name: /Set Up From the Ledger/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /From the Ledger/ }));
    const dialog = await screen.findByRole('dialog', { name: /Add loans from the ledger/ });
    await within(dialog).findByText('SBA EIDL Loan');
    expect(api.getLoanProposalsAsOf).toHaveBeenCalledWith({ asof: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), entities: [], historical: false });
    expect(within(dialog).getByText('Set Up')).toBeTruthy();
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(3);
    expect(within(dialog).getByText('Intercompany')).toBeTruthy();
    expect(within(dialog).getByText(/26 historical \(H\) entities not read/)).toBeTruthy();
    const golden = within(dialog).getByText(/Golden 1 Credit Union - 5860/).closest('tr');
    expect(within(golden).getByText('14,500,000.00')).toBeTruthy();
    expect(within(dialog).queryByText('Debit Balance')).toBeNull();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Due to Greens Global/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Golden 1/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create 1 Loan' }));
    await within(dialog).findByText('1 loan set up.');
    expect(api.createLoansFromLedger).toHaveBeenCalledWith(expect.objectContaining({ entities: '', historical: false, items: [{ entityCode: '12000', glAccount: '27300' }] }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(api.getLoansReview).toHaveBeenCalledTimes(2));
  });

  it('polls the scan every few seconds, showing the progress until the table', async () => {
    let n = 0;
    api.getLoanProposalsAsOf.mockImplementation(async () => { n += 1; return n === 1 ? scanning(0, 317) : n === 2 ? scanning(120, 317) : proposals; });
    render(<SetupDialog month="2026-09" pollMs={20} onClose={() => {}} onCreated={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: /Add loans from the ledger/ });
    await within(dialog).findByText('Reading the ledger... 0 of 317 entities');
    await within(dialog).findByText('Reading the ledger... 120 of 317 entities');
    await within(dialog).findByText('SBA EIDL Loan');
    expect(within(dialog).queryByRole('progressbar')).toBeNull();
    expect(api.getLoanProposalsAsOf).toHaveBeenCalledTimes(3);
    expect(api.getLoanProposalsAsOf).toHaveBeenCalledWith({ asof: '2026-09-30', entities: [], historical: false });
  });

  it('shows why a scan failed and starts it over on Try Again', async () => {
    let n = 0;
    api.getLoanProposalsAsOf.mockImplementation(async () => { n += 1; if (n === 1) { const e = new Error('Accounting service error: the ledger is closed for maintenance'); e.status = 424; throw e; } return proposals; });
    render(<SetupDialog month="2026-09" pollMs={20} onClose={() => {}} onCreated={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: /Add loans from the ledger/ });
    await within(dialog).findByText(/closed for maintenance/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try Again' }));
    await within(dialog).findByText('SBA EIDL Loan');
  });

  it('+ Add > Manual adds a loan that is not in Intacct', async () => {
    render(<LoansTab canEdit />);
    await rowOf('F&M Bank');
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Manual/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a Loan by Hand' });
    fireEvent.change(within(dialog).getByLabelText('Lender'), { target: { value: 'Rajesh Family Trust' } });
    fireEvent.change(within(dialog).getByLabelText('Entity'), { target: { value: '12000' } });
    fireEvent.change(within(dialog).getByLabelText('Loan #'), { target: { value: 'RFT-1' } });
    const bal = within(dialog).getByLabelText('Balance');
    fireEvent.change(bal, { target: { value: '250k' } });
    fireEvent.blur(bal);
    fireEvent.change(within(dialog).getByLabelText('Internal or External'), { target: { value: 'internal' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Loan' }));
    await waitFor(() => expect(api.createManualLoan).toHaveBeenCalled());
    expect(api.createManualLoan.mock.calls[0][0]).toMatchObject({ lender: 'Rajesh Family Trust', entityCode: '12000', loanNo: 'RFT-1', balance: 250000, internal: true });
    await waitFor(() => expect(api.getLoansReview).toHaveBeenCalledTimes(2));
  });

  it('Change Loan edits the name, number, wiring and terms of the same row', async () => {
    render(<LoansTab canEdit />);
    await rowOf('F&M Bank');
    fireEvent.click(screen.getByRole('button', { name: 'Edit F&M Bank' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change Loan' });
    await waitFor(() => expect(api.getLoanAccounts).toHaveBeenCalledWith('15000', expect.any(String)));
    await within(dialog).findByText(/71200 Interest Expense - Other/);
    fireEvent.change(within(dialog).getByLabelText('Loan Name (Lender)'), { target: { value: 'F&M Bank - Escondido' } });
    fireEvent.change(within(dialog).getByLabelText('Loan #'), { target: { value: '6870-A' } });
    fireEvent.change(within(dialog).getByLabelText('Interest Account'), { target: { value: '71200' } });
    fireEvent.change(within(dialog).getByLabelText('Rate %'), { target: { value: '6.25' } });
    fireEvent.change(within(dialog).getByLabelText('Covenant Minimum (DSCR)'), { target: { value: '1.25' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateLoan).toHaveBeenCalled());
    const [id, , body] = api.updateLoan.mock.calls[0];
    expect(id).toBe('FL1');
    expect(body).toMatchObject({ lender: 'F&M Bank - Escondido', loanNo: '6870-A', interestAccount: '71200', ratePct: 6.25, rateType: 'fixed', maturity: '2027-06-30', covenantMin: 1.25, monthlyPayment: 10000, originalPrincipal: null, docsPath: '/Shared/Loans/F&M' });
    expect(body).not.toHaveProperty('glAccount');      // the GL wiring is kept
    expect(body).not.toHaveProperty('internal');
  });

  it('shows skeleton rows while the ledger is read, and a failed read is not "no loans"', async () => {
    let fail;
    api.getLoansReview.mockImplementation(() => new Promise((_r, rej) => { fail = rej; }));
    const { container } = render(<LoansTab canEdit />);
    await waitFor(() => expect(container.querySelectorAll('.nx-skel').length).toBeGreaterThan(10));
    const e = new Error('Accounting service error: timeout');
    e.status = 424;
    fail(e);
    await screen.findByText(/timeout/);
    expect(screen.queryByText(/No loans set up/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
  });

  it('says what it looked for when nothing is set up', async () => {
    api.getLoansReview.mockImplementation(async () => ({ ...review, loans: [] }));
    render(<LoansTab canEdit />);
    await screen.findByText('No loans set up for the entities you may read.');
    expect(screen.getByText(/whose title says Loan, Mortgage, Note Payable/)).toBeTruthy();
  });

  it('says so when the accounting service is not connected, and hides + Add', async () => {
    api.getLoansReview.mockImplementation(async () => { const e = new Error('Accounting service is not configured (ACCOUNTING_BASE_URL / ACCOUNTING_INTERNAL_KEY)'); e.status = 503; throw e; });
    render(<LoansTab canEdit />);
    await screen.findByText('Loans & Financing is not available here.');
    expect(screen.queryByRole('button', { name: /Add/ })).toBeNull();
  });

  it('exports the loans shown as a table', () => {
    const t = _test.loansTable(_test.visibleLoans(review.loans), { from: '2026-10-01', to: '2026-10-06', entityLabel: 'All entities' });
    expect(t.rows).toHaveLength(4);
    expect(t.columns.map((c) => c.label).slice(0, 4)).toEqual(['Lender', 'Loan #', 'Entity', 'Monthly Payment']);
    expect(t.totals[5]).toBe(1252000 + 400000 + 20000 + 14500000);
    expect(t.subtitle).toContain('10/06/2026');
  });
});
