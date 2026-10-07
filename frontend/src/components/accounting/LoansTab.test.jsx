import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Render-smoke for Accounting -> Loans & Financing (Neil and Charmi, 10/02;
// Oct 6 feedback): the loans for the period with the filters on top
// (Entities, period, Internal / External, text), closed loans hidden until
// Customize > Show Closed Loans, the columns as asked (Lender, Loan #, Entity,
// Monthly Payment right after Entity, Original Principal with its "edited"
// mark; no Debit Balance chip, no Month Ago / Year Ago), the per-loan detail
// with the payments in the period and the payment history, + Add > From the
// Ledger (polling scan) and Manual, Change Loan, the Export menu, skeleton
// rows while loading, and the "not available" state.

// The Files picker: one button that picks a fixed folder.
vi.mock('../../egnyte/EgnyteFolderPick', () => ({
  default: ({ title, onPick }) => <button type="button" onClick={() => onPick('/Shared/Loans/F&M/Statements')}>{`Pick in ${title}`}</button>,
}));

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
    deleteLoan: vi.fn(async () => ({ ok: true, dismissed: true })),
    getLoanStressSettings: vi.fn(async () => ({ entities: {}, excluded: [] })),
    saveLoanStressEntity: vi.fn(async (code, body) => ({ entity: { entityCode: code, ...body } })),
    setLoanStressExcluded: vi.fn(async () => ({ ok: true })),
    getLoanEntityNoi: vi.fn(async () => ({ entities: { 15000: { noi: 200000, annualized: 266000 } } })),
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
    // A term loan has no Draws (Oct 7: only for a Line of Credit).
    expect(within(detail).queryByRole('columnheader', { name: 'Draws' })).toBeNull();
    expect(within(detail).queryByText('Draws in Period')).toBeNull();
    expect(within(funding).queryByText('1,400,000.00')).toBeNull();
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
    const table = within(dialog).getByRole('table');
    expect(within(table).getByText('Set Up')).toBeTruthy();
    expect(within(table).getAllByRole('checkbox', { name: /^Create / })).toHaveLength(3);
    expect(within(table).getAllByText('Intercompany').length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/26 historical \(H\) entities not read/)).toBeTruthy();
    const golden = within(dialog).getByText(/Golden 1 Credit Union - 5860/).closest('tr');
    expect(within(golden).getByText('14,500,000.00')).toBeTruthy();
    expect(within(dialog).queryByText('Debit Balance')).toBeNull();
    // Only External loans start ticked (Oct 7): the intercompany one does not.
    expect(within(dialog).getByRole('checkbox', { name: /Due to Greens Global/ }).checked).toBe(false);
    expect(within(dialog).getByRole('button', { name: 'Create 2 Loans' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Golden 1/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create 1 Loan' }));
    await within(dialog).findByText('1 loan set up.');
    expect(api.createLoansFromLedger).toHaveBeenCalledWith(expect.objectContaining({ entities: '', historical: false, items: [{ entityCode: '12000', glAccount: '27300' }] }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(api.getLoansReview).toHaveBeenCalledTimes(2));
  });

  it('+ Add > From the Ledger: select all on the rows shown, quick filters, search, live count', async () => {
    render(<SetupDialog month="2026-09" pollMs={20} onClose={() => {}} onCreated={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: /Add loans from the ledger/ });
    await within(dialog).findByText('SBA EIDL Loan');
    const headerBox = () => within(dialog).getByRole('checkbox', { name: /Select (all|none) of the loans shown|Select all the loans shown/ });
    // Two of the three new rows ticked: the header is part-ticked. The default
    // ticks land a render after the rows show, so wait for them (slow CI).
    await waitFor(() => expect(headerBox().indeterminate).toBe(true));
    const header = headerBox();
    fireEvent.click(header);                                  // all
    expect(within(dialog).getByRole('button', { name: 'Create 3 Loans' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Select none of the loans shown' }));
    const none = within(dialog).getByRole('button', { name: 'Create 0 Loans' });
    expect(none.disabled).toBe(true);
    // Kind: Intercompany, then the header ticks only what is shown.
    fireEvent.click(within(within(dialog).getByRole('group', { name: 'Kind' })).getByRole('button', { name: 'Intercompany' }));
    expect(within(dialog).queryByText('SBA EIDL Loan')).toBeNull();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Select all the loans shown' }));
    expect(within(dialog).getByRole('button', { name: 'Create 1 Loan' })).toBeTruthy();
    fireEvent.click(within(within(dialog).getByRole('group', { name: 'Kind' })).getByRole('button', { name: 'All' }));
    // Search.
    fireEvent.change(within(dialog).getByLabelText('Search the proposed loans'), { target: { value: 'golden' } });
    expect(within(dialog).queryByText('SBA EIDL Loan')).toBeNull();
    expect(within(dialog).getByText(/Golden 1 Credit Union - 5860/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Search the proposed loans'), { target: { value: '' } });
    // Status: Set Up shows the loan already there, nothing to tick.
    fireEvent.click(within(within(dialog).getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Set Up' }));
    expect(within(dialog).getByText('F&M Loan #6870')).toBeTruthy();
    expect(within(dialog).getByRole('checkbox', { name: 'Select all the loans shown' }).disabled).toBe(true);
  });

  it('+ Add > From the Ledger: a removed loan is offered again only under Show Removed', async () => {
    api.getLoanProposalsAsOf.mockImplementation(async () => ({ ...proposals, removed: 1, proposals: [...proposals.proposals, { entityCode: '15000', entityName: 'Greens Escondido, LLC.', glAccount: '27027', title: 'Calle Boveda Loan 27027', balance: 5000, lender: 'Calle Boveda', kind: 'external', status: 'dismissed', loanId: null, removedBy: 'charmi@greensglobal.com' }] }));
    render(<SetupDialog month="2026-09" pollMs={20} onClose={() => {}} onCreated={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: /Add loans from the ledger/ });
    await within(dialog).findByText('SBA EIDL Loan');
    expect(within(dialog).queryByText('Calle Boveda Loan 27027')).toBeNull();
    fireEvent.click(within(dialog).getByLabelText(/Show Removed/));
    expect(within(dialog).getByText('Calle Boveda Loan 27027')).toBeTruthy();
    expect(within(dialog).getByRole('checkbox', { name: /Calle Boveda/ }).checked).toBe(false);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Calle Boveda/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Golden 1/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /SBA EIDL/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create 1 Loan' }));
    await waitFor(() => expect(api.createLoansFromLedger).toHaveBeenCalled());
    expect(api.createLoansFromLedger.mock.calls[0][0].items).toEqual([{ entityCode: '15000', glAccount: '27027' }]);
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
    // The module's entity picker: found by its number, code on the left, (H) hidden.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Entity' }));
    expect(screen.queryByRole('option', { name: /Old Holdings/ })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Search entity by name or code'), { target: { value: '12000' } });
    const opt = screen.getByRole('option', { name: /Greens Global, Inc\./ });
    expect(opt.textContent.indexOf('12000')).toBeLessThan(opt.textContent.indexOf('Greens Global'));
    fireEvent.click(opt);
    expect(within(dialog).getByRole('button', { name: 'Entity' }).textContent).toContain('Greens Global, Inc. (12000)');
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

  // Charmi 10/07: "Browse" by "No statements folder" in the open loan - the
  // folder is picked in Egnyte and saved right there, no dialog.
  it('an open loan wires a missing Egnyte folder with Browse, in place', async () => {
    render(<LoansTab canEdit />);
    fireEvent.click(await rowOf('F&M Bank'));
    const detail = await screen.findByLabelText('Details of F&M Bank');
    expect(within(detail).queryByRole('button', { name: 'Documents Folder - Browse Egnyte' })).toBeNull();   // already wired
    fireEvent.click(within(detail).getByRole('button', { name: 'Statements Folder - Browse Egnyte' }));
    fireEvent.click(await screen.findByRole('button', { name: /Pick in Statements Folder/ }));
    await waitFor(() => expect(api.updateLoan).toHaveBeenCalledWith('FL1', '', { statementsPath: '/Shared/Loans/F&M/Statements' }));
    await waitFor(() => expect(api.getLoansReview).toHaveBeenCalledTimes(2));
  });

  it('a viewer sees no Browse in an open loan', async () => {
    render(<LoansTab />);
    fireEvent.click(await rowOf('F&M Bank'));
    const detail = await screen.findByLabelText('Details of F&M Bank');
    expect(within(detail).getByText(/No statements folder/)).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: /Browse Egnyte/ })).toBeNull();
  });

  // Item 47 (BLOCKER, Charmi 23:21): the pencil opened Change Loan and it closed by itself.
  it('the pencil opens Change Loan and it stays open: a double-click, a drag out of a field, fields editable, Save', async () => {
    const user = userEvent.setup();
    render(<LoansTab canEdit />);
    await rowOf('F&M Bank');
    await user.dblClick(screen.getByRole('button', { name: 'Edit F&M Bank' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change Loan' });
    const backdrop = dialog.parentElement;
    expect(backdrop.className).toContain('modal-overlay');
    // The second click of a double-click lands on the backdrop that just appeared.
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop, { detail: 2 });
    expect(screen.getByRole('dialog', { name: 'Change Loan' })).toBeTruthy();
    // Selecting a field's text and letting go outside the window: the press was in the field.
    const rate = within(dialog).getByLabelText('Rate %');
    fireEvent.mouseDown(rate);
    fireEvent.click(backdrop);
    expect(screen.getByRole('dialog', { name: 'Change Loan' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 450));
    expect(screen.getByRole('dialog', { name: 'Change Loan' })).toBeTruthy();
    // Fields editable.
    await user.clear(rate);
    await user.type(rate, '7.25');
    await user.clear(within(dialog).getByLabelText('Maturity'));
    fireEvent.change(within(dialog).getByLabelText('Maturity'), { target: { value: '2030-01-31' } });
    const pay = within(dialog).getByLabelText('Monthly Payment');
    await user.clear(pay);
    await user.type(pay, '12,500');
    fireEvent.blur(pay);
    fireEvent.change(within(dialog).getByLabelText('Loan Type'), { target: { value: 'line_of_credit' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateLoan).toHaveBeenCalled());
    const [id, , body] = api.updateLoan.mock.calls[0];
    expect(id).toBe('FL1');
    expect(body).toMatchObject({ ratePct: 7.25, maturity: '2030-01-31', monthlyPayment: 12500, loanType: 'line_of_credit' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Change Loan' })).toBeNull());
  });

  it('a deliberate click on the backdrop still closes Change Loan', async () => {
    render(<LoansTab canEdit />);
    await rowOf('F&M Bank');
    fireEvent.click(screen.getByRole('button', { name: 'Edit F&M Bank' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change Loan' });
    await new Promise((r) => setTimeout(r, 450));
    fireEvent.mouseDown(dialog.parentElement);
    fireEvent.click(dialog.parentElement, { detail: 1 });
    expect(screen.queryByRole('dialog', { name: 'Change Loan' })).toBeNull();
  });

  it('removes a loan after Remove / Keep in place', async () => {
    render(<LoansTab canEdit />);
    const fm = await rowOf('F&M Bank');
    fireEvent.click(within(fm).getByRole('button', { name: 'Remove F&M Bank' }));
    expect(within(fm).getByText('Remove?')).toBeTruthy();
    fireEvent.click(within(fm).getByRole('button', { name: 'Keep' }));
    expect(api.deleteLoan).not.toHaveBeenCalled();
    fireEvent.click(within(fm).getByRole('button', { name: 'Remove F&M Bank' }));
    fireEvent.click(within(fm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.deleteLoan).toHaveBeenCalledWith('FL1'));
    await screen.findByText(/Removed F&M Bank \(Greens Escondido, LLC\.\)\. \+ Add > From the Ledger will not offer it again/);
    await waitFor(() => expect(api.getLoansReview).toHaveBeenCalledTimes(2));
  });

  it('shows Draws only for a Line of Credit', async () => {
    api.getLoansReview.mockImplementation(async () => ({ ...review, loans: [loan({ lineOfCredit: true, loanType: 'line_of_credit', draws: 25000 })] }));
    render(<LoansTab canEdit />);
    const fm = await rowOf('F&M Bank');
    expect(within(fm).getByText('Line of Credit')).toBeTruthy();
    fireEvent.click(fm);
    const detail = await screen.findByLabelText('Details of F&M Bank');
    expect(within(detail).getByText('Draws in Period')).toBeTruthy();
    await within(detail).findByText('October payment');
    expect(within(detail).getByRole('columnheader', { name: 'Draws' })).toBeTruthy();
  });

  it('says so when nothing was posted in the period, and opens on the last closed month', async () => {
    api.getLoansReview.mockImplementation(async () => ({ ...review, loans: review.loans.map((l) => ({ ...l, principalPaid: 0, interestPaid: null, debtService: 0 })) }));
    render(<LoansTab canEdit />);
    await rowOf('F&M Bank');
    const { from, to } = api.getLoansReview.mock.calls[0][0];
    const now = new Date();
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    expect(to).toBe(`${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`);
    expect(from).toBe(`${to.slice(0, 8)}01`);
    expect(screen.getByText(/No payments posted 10\/01\/2026 - 10\/06\/2026 on the loans shown/)).toBeTruthy();
  });

  it('Stress Test is its own tab: addback saved per entity, a loan left out and restored, pencil to Change Loan', async () => {
    render(<LoansTab canEdit />);
    await rowOf('F&M Bank');
    fireEvent.click(screen.getByRole('tab', { name: 'Stress Test' }));
    await waitFor(() => expect(api.getLoanStressSettings).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();                    // not a pop-up
    expect(screen.getByRole('columnheader', { name: 'Addback' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Adjusted NOI' })).toBeTruthy();
    const add = screen.getByLabelText('Addback of Greens Escondido, LLC.');
    fireEvent.change(add, { target: { value: '25k' } });
    fireEvent.blur(add);
    await waitFor(() => expect(api.saveLoanStressEntity).toHaveBeenCalledWith('15000', { addback: 25000 }));
    const note = screen.getByLabelText('Addback note of Greens Escondido, LLC.');
    fireEvent.change(note, { target: { value: 'Depreciation' } });
    fireEvent.blur(note);
    await waitFor(() => expect(api.saveLoanStressEntity).toHaveBeenCalledWith('15000', { addbackNote: 'Depreciation' }));
    // NOI basis per entity.
    fireEvent.change(screen.getByLabelText('NOI basis of Greens Escondido, LLC.'), { target: { value: 'ytd' } });
    await waitFor(() => expect(api.getLoanEntityNoi).toHaveBeenCalledWith(expect.objectContaining({ entities: ['15000'] })));
    // Filters: Below Covenant Only leaves MCD (DSCR 1.0x).
    fireEvent.click(screen.getByLabelText('Below Covenant Only'));
    // Trash leaves the loan out of the run; Show Excluded restores it.
    fireEvent.click(screen.getByLabelText('Below Covenant Only'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave Chase out of the stress test' }));
    await waitFor(() => expect(api.setLoanStressExcluded).toHaveBeenCalledWith('FL2', true));
    fireEvent.click(screen.getByLabelText(/Show Excluded/));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.setLoanStressExcluded).toHaveBeenCalledWith('FL2', false));
    // The pencil opens Change Loan for that loan.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Chase' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change Loan' });
    expect(within(dialog).getByLabelText('Loan Name (Lender)').value).toBe('Chase');
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

// Oct 7 (items 9, 21, 32, 33): the module's shared controls on Loans.
describe('LoansTab shared controls', () => {
  it('has the standard Customize: Row Density, Rows per Page, Show Historical Entities and Show Closed Loans', async () => {
    render(<LoansTab canEdit />);
    await rowOf('F&M Bank');
    const btn = screen.getByRole('button', { name: /Customize/ });
    expect(btn.querySelector('.lucide-sliders-horizontal')).toBeTruthy();
    expect(btn.querySelector('.lucide-settings-2')).toBeNull();
    fireEvent.click(btn);
    const panel = screen.getByRole('dialog', { name: 'Customize' });
    expect(within(panel).getByRole('group', { name: 'Row Density' })).toBeTruthy();
    expect(within(panel).getByRole('group', { name: 'Rows per Page' })).toBeTruthy();
    expect(within(panel).getByLabelText(/Show Historical Entities/)).toBeTruthy();
    expect(within(panel).getByLabelText(/Show Closed Loans/)).toBeTruthy();
  });

  it('pages the loans from Customize > Rows per Page; totals and exports cover every loan', async () => {
    const { container } = render(<LoansTab canEdit />);
    await rowOf('F&M Bank');
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Rows per Page' })).getByRole('button', { name: 'Other' }));
    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '2' } });
    await screen.findByText(/Page 1 of 2/);
    expect(container.querySelectorAll('tbody.loan')).toHaveLength(2);
    // The footer totals all four open loans, not the page.
    expect(within(container.querySelector('tfoot')).getByText('16,172,000.00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText(/Page 2 of 2/);
    expect(container.querySelectorAll('tbody.loan')).toHaveLength(2);
    // The export table is built from every loan shown by the filters.
    expect(_test.loansTable(_test.visibleLoans(review.loans), { from: '2026-10-01', to: '2026-10-06', entityLabel: 'All entities' }).rows).toHaveLength(4);
  });

  it('has a resize handle on every column, and + Add is the shared menu', async () => {
    render(<LoansTab canEdit />);
    await rowOf('F&M Bank');
    for (const name of ['Lender', 'Loan #', 'Entity', 'Balance', 'Principal Paid', 'Interest Paid', 'Egnyte']) {
      expect(screen.getByRole('separator', { name: `Resize the ${name} column` })).toBeTruthy();
    }
    expect(screen.getAllByRole('columnheader', { name: 'Balance' }).length).toBeGreaterThan(0);
    const add = screen.getByRole('button', { name: /Add/ });
    expect(add.querySelector('.lucide-chevron-down')).toBeTruthy();       // AddMenu's button
    fireEvent.click(add);
    const menu = screen.getByRole('menu', { name: 'Add a loan' });
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      expect.stringContaining('From the Ledger'), expect.stringContaining('Manual'),
    ]);
  });

  it('Balance and Principal Paid open the ledger lines behind them in Reports', async () => {
    const seen = [];
    const onNav = (e) => seen.push(['nav', e.detail]);
    const onDrill = (e) => seen.push(['drill', e.detail]);
    window.addEventListener('nexus:navigate', onNav);
    window.addEventListener('nexus:accounting-drill', onDrill);
    try {
      render(<LoansTab canEdit />);
      await rowOf('F&M Bank');
      fireEvent.click(screen.getByRole('button', { name: 'Ledger lines behind the balance of F&M Bank' }));
      expect(seen[0]).toEqual(['nav', { view: 'accounting', sub: 'reports' }]);
      expect(seen[1][1]).toMatchObject({ account: '27100', entity: '15000', from: '' });
      fireEvent.click(screen.getByRole('button', { name: 'Ledger lines behind the principal paid on F&M Bank' }));
      expect(seen[3][1]).toMatchObject({ account: '27100', entity: '15000', from: expect.stringMatching(/^\d{4}-\d{2}-01$/) });
      fireEvent.click(screen.getByRole('button', { name: 'Ledger lines behind the interest paid on F&M Bank' }));
      expect(seen[5][1]).toMatchObject({ account: '71100', entity: '15000' });
    } finally {
      window.removeEventListener('nexus:navigate', onNav);
      window.removeEventListener('nexus:accounting-drill', onDrill);
    }
  });

  it('the Stress Test has the entity picker, the standard Customize, a pager and resizable columns', async () => {
    render(<LoansTab canEdit />);
    await rowOf('F&M Bank');
    fireEvent.click(screen.getByRole('tab', { name: 'Stress Test' }));
    await waitFor(() => expect(api.getLoanStressSettings).toHaveBeenCalled());
    expect(screen.getByRole('separator', { name: 'Resize the Adjusted NOI column' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Entity' }));
    fireEvent.change(screen.getByPlaceholderText('Search entity by name or code'), { target: { value: '56000' } });
    fireEvent.click(screen.getByRole('option', { name: /MCD Services/ }));
    await waitFor(() => expect(screen.queryByRole('cell', { name: 'Greens Escondido, LLC.' })).toBeNull());
    expect(screen.getByRole('cell', { name: 'MCD Services, Inc.' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    expect(screen.getByRole('group', { name: 'Rows per Page' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Row Density' })).toBeTruthy();
  });
});
