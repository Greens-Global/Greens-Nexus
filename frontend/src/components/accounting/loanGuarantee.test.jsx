import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Accounting > Loans: the guarantee record on a loan (Neil, 11/21/2026) -
// recourse and the guarantors, typed under Change Loan and read on the loan's
// sheet. The words, what Change Loan sends, and both screens.

vi.mock('../../api', () => ({
  api: {
    getLoanAccounts: vi.fn(async () => ({ principal: [], interest: [] })),
    getLoanVendors: vi.fn(async () => ({ vendors: [] })),
    getLoanHistory: vi.fn(async () => ({ principal: { lines: [], total: 0 }, interest: [], notes: [] })),
    egnyteStatus: vi.fn(async () => ({ connected: false })),
    updateLoan: vi.fn(async () => ({ ok: true })),
  },
}));
vi.mock('../../egnyte/EgnyteFolderPick', () => ({ default: () => null }));

import { api } from '../../api';
import { EditLoanDialog, editBody, editStart } from './LoanDialogs';
import LoanSheet from './LoanSheet';
import { blankGuarantor, cleanGuarantors, guaranteeWords, guarantorsError, recourseLabel } from './loanGuarantee';

const LOAN = {
  id: 'FL1', loanNo: '6870', lender: 'F&M Bank', kind: 'external', internal: false, entityCode: '15000', entityName: 'Greens Escondido, LLC.', glAccount: '27100', glTitle: 'F&M Loan #6870',
  wiring: 'ok', closed: false, isActive: true, balance: 1252000, originalPrincipal: 1400000, originalPrincipalEdited: false, principalPaid: 4000, interestPaid: 6000, debtService: 10000,
  interestAccount: '71100', interestAccounts: [{ code: '71100', title: 'Interest' }], interestSource: 'matched', dscr: 2.2, covenantMin: 1.35, covenantTyped: false, belowCovenant: false,
  ratePct: 6.1, rateType: 'fixed', maturity: '2027-06-30', monthlyPayment: 10000, notes: '', docsPath: '', statementsPath: '', loanType: 'term', loanTypeGuessed: true,
  recourse: '', guarantors: [],
};
const ASHA = { name: 'Asha Greene', kind: 'limited', amount: 350000, burnOff: 'Falls away once DSCR holds 1.35x for four quarters' };
const TRUST = { name: 'Greene Family Trust', kind: 'carve_out', amount: null, burnOff: '' };

beforeEach(() => { vi.clearAllMocks(); });

describe('the guarantee words', () => {
  it('names recourse and each kind of guarantee', () => {
    expect(['full', 'limited', 'non_recourse', '', 'sideways'].map(recourseLabel)).toEqual(['Full Recourse', 'Limited Recourse', 'Non-Recourse', '', '']);
    expect(guaranteeWords(ASHA)).toBe('Limited to $350,000.00');
    expect(guaranteeWords(TRUST)).toBe('Carve-Outs Only');
    expect(guaranteeWords({ name: 'A', kind: 'full' })).toBe('Full');
    expect(guaranteeWords({ name: 'A', kind: 'limited', amount: null })).toBe('Limited');
  });

  it('sends the rows in the server\'s shape and drops an untouched row', () => {
    expect(cleanGuarantors([blankGuarantor(), { name: '  Asha   Greene ', kind: 'full', amount: 9, burnOff: ' none ' }, { ...ASHA, amount: '350000' }]))
      .toEqual([{ name: 'Asha Greene', kind: 'full', amount: null, burnOff: 'none' }, { ...ASHA, amount: 350000 }]);
    expect(guarantorsError([blankGuarantor(), ASHA, TRUST])).toBe('');
    expect(guarantorsError([{ name: '', kind: 'full', amount: null, burnOff: 'Year five' }])).toBe('Each guarantor needs a name.');
    expect(guarantorsError([{ name: 'Asha', kind: 'limited', amount: null, burnOff: '' }])).toBe('Asha: a limited guarantee needs its amount.');
  });

  it('Change Loan sends the guarantee only when it changed', () => {
    const start = editStart({ ...LOAN, recourse: 'limited', guarantors: [ASHA] });
    expect(start.recourse).toBe('limited');
    expect(start.guarantors).toEqual([ASHA]);
    expect(editBody(LOAN, start, start)).toEqual({});
    // A blank row added and left alone is not a change.
    expect(editBody(LOAN, start, { ...start, guarantors: [...start.guarantors, blankGuarantor()] })).toEqual({});
    expect(editBody(LOAN, start, { ...start, recourse: 'non_recourse' })).toEqual({ recourse: 'non_recourse' });
    expect(editBody(LOAN, start, { ...start, guarantors: [ASHA, TRUST] })).toEqual({ guarantors: [ASHA, TRUST] });
    expect(editBody(LOAN, start, { ...start, recourse: '', guarantors: [] })).toEqual({ recourse: '', guarantors: [] });
  });
});

describe('Change Loan > Guarantee', () => {
  it('adds a guarantor with a limit and saves only the guarantee', async () => {
    const onSaved = vi.fn();
    render(<EditLoanDialog loan={LOAN} to="2026-10-06" onClose={() => {}} onSaved={onSaved} />);
    expect(screen.getByText('Who guaranteed the loan, for how much, and when the guarantee falls away.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Recourse'), { target: { value: 'limited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Guarantor' }));
    const row = within(screen.getByRole('group', { name: 'Guarantor 1' }));
    // An amount is asked only for a limited guarantee.
    expect(row.queryByLabelText('Limited To')).toBeNull();
    fireEvent.change(row.getByLabelText('Guarantor'), { target: { value: 'Asha Greene' } });
    fireEvent.change(row.getByLabelText('Guarantee'), { target: { value: 'limited' } });
    // Without the amount the save is stopped, in words, and nothing is sent.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe('Asha Greene: a limited guarantee needs its amount.');
    expect(api.updateLoan).not.toHaveBeenCalled();
    const amount = row.getByLabelText('Limited To');
    fireEvent.change(amount, { target: { value: '350k' } });
    fireEvent.blur(amount);
    fireEvent.change(row.getByLabelText('Burn-Off'), { target: { value: 'Falls away at year five' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.updateLoan).toHaveBeenCalledWith('FL1', '', { recourse: 'limited', guarantors: [{ name: 'Asha Greene', kind: 'limited', amount: 350000, burnOff: 'Falls away at year five' }] });
  });

  it('opens on the guarantors already kept and removes one', async () => {
    const onSaved = vi.fn();
    render(<EditLoanDialog loan={{ ...LOAN, recourse: 'non_recourse', guarantors: [ASHA, TRUST] }} to="2026-10-06" onClose={() => {}} onSaved={onSaved} />);
    expect(screen.getByLabelText('Recourse').value).toBe('non_recourse');
    expect(within(screen.getByRole('group', { name: 'Guarantor 2' })).getByLabelText('Guarantor').value).toBe('Greene Family Trust');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Guarantor 1' }));
    expect(screen.queryByRole('group', { name: 'Guarantor 2' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.updateLoan).toHaveBeenCalledWith('FL1', '', { guarantors: [TRUST] });
  });
});

describe('the loan sheet > Guarantee', () => {
  const sheet = (loan, canEdit = true) => render(
    <LoanSheet loan={loan} from="2026-10-01" to="2026-10-06" canEdit={canEdit} term={(_f, shown) => shown} dscrText={() => '2.20x'} rateText={() => '6.1% Fixed'}
      onEdit={() => {}} onPlan={() => {}} onClose={() => {}} />);

  it('says recourse and each guarantor, with the burn-off under it', () => {
    sheet({ ...LOAN, recourse: 'limited', guarantors: [ASHA, TRUST] });
    const g = within(screen.getByRole('region', { name: 'Guarantee' }));
    expect(g.getByText('Limited Recourse')).toBeTruthy();
    expect(g.getByText('Asha Greene').parentElement.textContent).toBe('Asha GreeneLimited to $350,000.00Falls away once DSCR holds 1.35x for four quarters');
    expect(g.getByText('Greene Family Trust').parentElement.textContent).toBe('Greene Family TrustCarve-Outs Only');
  });

  it('says nothing is recorded yet, and points an editor to Change Loan', () => {
    const { unmount } = sheet(LOAN);
    expect(within(screen.getByRole('region', { name: 'Guarantee' })).getByText('None recorded - add them under Change Loan')).toBeTruthy();
    unmount();
    sheet(LOAN, false);
    expect(within(screen.getByRole('region', { name: 'Guarantee' })).queryByText(/Change Loan/)).toBeNull();
  });
});

// 11/21/2026: the minimum the DSCR is judged against, on the sheet.
describe('the loan sheet > Covenant Minimum', () => {
  const sheet = (loan, canEdit = true) => render(
    <LoanSheet loan={loan} from="2026-10-01" to="2026-10-06" canEdit={canEdit} dscrText={() => '2.20x'} rateText={() => '6.1% Fixed'}
      term={(field, shown) => (canEdit ? <button type="button" data-term={field}>{shown}</button> : shown)}
      onEdit={() => {}} onPlan={() => {}} onClose={() => {}} />);
  const line = () => screen.getByText('Covenant Minimum').parentElement;

  it('says the default applies when none is typed, and lets an editor add one', () => {
    const { unmount } = sheet(LOAN);
    expect(line().textContent).toBe('Covenant Minimum-None typed - the default 1.35x applies');
    expect(line().querySelector('[data-term="covenantMin"]')).toBeTruthy();
    unmount();
    sheet(LOAN, false);
    expect(line().textContent).toBe('Covenant MinimumNone typed - the default 1.35x applies');
  });

  it('shows the typed minimum as a term an editor can change', () => {
    sheet({ ...LOAN, covenantMin: 1.25, covenantTyped: true });
    expect(line().textContent).toBe('Covenant Minimum1.25x');
    expect(line().querySelector('[data-term="covenantMin"]').textContent).toBe('1.25x');
  });
});
