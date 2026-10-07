import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// A property's Financing section (Oct 7 accounting feedback): the open loans
// of its ledger entity, a plain message with no entity or no accounting
// access, and the entity set from the section itself.

vi.mock('../api', () => ({
  api: {
    getLoansByEntity: vi.fn(),
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '32000', name: 'Greens Storage Temecula LLC' }, { code: '15000', name: 'Greens Escondido' }] })),
  },
}));

import PropertyLoans from './PropertyLoans';
import { api } from '../api';

const LOANS = {
  entityCode: '32000', asOf: '2026-10-07', loans: [
    { id: 'l1', lender: 'Chase', loanNo: '7781', entityCode: '32000', entityName: 'Greens Storage Temecula LLC', balance: 4250000, ratePct: 6.125, rateType: 'Fixed', maturity: '2031-06-01', monthlyPayment: 28512.4, dscr: 1.42, covenantMin: 1.25, belowCovenant: false, docsUrl: 'https://greens.egnyte.com/navigate/folder/a', docsPath: '/Shared/Loans/Chase 7781', statementsUrl: 'https://greens.egnyte.com/navigate/folder/b', statementsPath: '/Shared/Loans/Chase 7781/Statements' },
    { id: 'l2', lender: 'Wells Fargo', loanNo: 'WF-22', entityCode: '32000', entityName: 'Greens Storage Temecula LLC', balance: 900000, ratePct: 7.5, rateType: 'Variable', maturity: '2027-01-31', monthlyPayment: 7100, dscr: 1.1, covenantMin: 1.2, belowCovenant: true, docsUrl: null, statementsUrl: null },
  ],
  totals: { loans: 2, balance: 5150000, monthlyPayment: 35612.4 }, notes: [],
};

beforeEach(() => { vi.clearAllMocks(); });

describe('PropertyLoans', () => {
  it('lists the loans of the property\'s ledger entity', async () => {
    let resolve;
    api.getLoansByEntity.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<PropertyLoans property={{ id: 'p1', name: 'Temecula', entityCode: '32000' }} onSaveEntityCode={() => {}} />);
    // A skeleton while the ledger is read, never a blank section.
    expect(screen.getByRole('status')).toBeTruthy();
    resolve(LOANS);
    await screen.findByText('Chase');
    expect(api.getLoansByEntity).toHaveBeenCalledWith('32000');
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Lender', 'Loan #', 'Balance', 'Rate', 'Maturity', 'Monthly Payment', 'DSCR', 'Documents']);
    const row = screen.getByText('Chase').closest('tr');
    expect([...row.cells].map((c) => c.textContent).slice(0, 7)).toEqual(['Chase', '7781', '$4,250,000.00', '6.125% Fixed', '06/01/2031', '$28,512.40', '1.42x']);
    expect(screen.getByRole('link', { name: 'Loan documents of Chase' }).getAttribute('href')).toBe('https://greens.egnyte.com/navigate/folder/a');
    expect(screen.getByRole('link', { name: 'Loan statements of Chase' })).toBeTruthy();
    expect(screen.getByText('Total - 2 loans')).toBeTruthy();
    expect(screen.getByText('$5,150,000.00')).toBeTruthy();
    expect(screen.getByText(/Ledger Entity: Greens Storage Temecula LLC \(32000\)/)).toBeTruthy();
  });

  it('says so when no ledger entity is set, and sets one from the section', async () => {
    const onSave = vi.fn();
    render(<PropertyLoans property={{ id: 'p1', name: 'Temecula' }} onSaveEntityCode={onSave} />);
    expect(screen.getByText(/No ledger entity is set for this property/)).toBeTruthy();
    expect(api.getLoansByEntity).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Set Ledger Entity' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ledger Entity' }));
    fireEvent.click(screen.getByRole('option', { name: /Greens Storage Temecula LLC/ }));
    expect(onSave).toHaveBeenCalledWith('32000');
  });

  it('shows a plain message without accounting access to the entity (403)', async () => {
    api.getLoansByEntity.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    render(<PropertyLoans property={{ id: 'p1', name: 'Temecula', entityCode: '32000' }} />);
    await screen.findByText(/You do not have accounting access to entity 32000/);
    expect(screen.queryByRole('table')).toBeNull();
    // Without an editor hook there is nothing to change.
    expect(screen.queryByRole('button', { name: /Entity/ })).toBeNull();
  });

  it('offers Try Again on any other failure, and says when there are no open loans', async () => {
    api.getLoansByEntity.mockRejectedValueOnce(Object.assign(new Error('Gateway timeout'), { status: 504 }));
    api.getLoansByEntity.mockResolvedValueOnce({ entityCode: '15000', loans: [], totals: { loans: 0 } });
    render(<PropertyLoans property={{ id: 'p2', name: 'Escondido', entityCode: '15000' }} />);
    await screen.findByText(/Could not read the loans for entity 15000 - Gateway timeout/);
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await waitFor(() => expect(screen.getByText('No open loans on the ledger for entity 15000.')).toBeTruthy());
  });
});
