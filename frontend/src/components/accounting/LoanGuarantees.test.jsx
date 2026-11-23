import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import LoanGuarantees from './LoanGuarantees';
import { guaranteeExposure, guarantorGroups, hasGuaranteeRecord } from './loanGuarantee';

// Accounting > Loans: Guarantees (Neil, 11/21/2026) - one line per guarantor
// across the open loans shown, with what they stand behind.

const loan = (over) => ({ id: 'L', lender: 'F&M Bank', loanNo: '6870', entityName: 'Greens Escondido, LLC.', balance: 1000000, closed: false, recourse: '', guarantors: [], ...over });
const FM = loan({ id: 'FL1', recourse: 'limited', guarantors: [
  { name: 'Asha Greene', kind: 'limited', amount: 350000, burnOff: '' },
  { name: 'Greene Family Trust', kind: 'carve_out', amount: null, burnOff: '' },
] });
const CHASE = loan({ id: 'FL2', lender: 'Chase', loanNo: '9001', entityName: 'MCD Services, Inc.', balance: 400000, recourse: 'full', guarantors: [
  { name: 'asha  greene', kind: 'full', amount: null, burnOff: '' },
] });
const SBA = loan({ id: 'FL3', lender: 'SBA', loanNo: 'E-1', balance: 150000 });                       // nothing recorded
const NONREC = loan({ id: 'FL4', lender: 'Golden 1', loanNo: 'G1', balance: 9000000, recourse: 'non_recourse' });
const OLD = loan({ id: 'FL5', lender: 'Old Wells', loanNo: 'OLD', balance: 0, closed: true, guarantors: [{ name: 'Someone Else', kind: 'full' }] });

describe('what a guarantor stands behind', () => {
  it('is the balance when full, the limit when limited, nothing for carve-outs', () => {
    expect(guaranteeExposure({ kind: 'full' }, FM)).toBe(1000000);
    expect(guaranteeExposure({ kind: 'limited', amount: 350000 }, FM)).toBe(350000);
    expect(guaranteeExposure({ kind: 'limited', amount: 5000000 }, FM)).toBe(1000000);     // never more than is owed
    expect(guaranteeExposure({ kind: 'carve_out' }, FM)).toBe(0);
    expect(guaranteeExposure({ kind: 'full' }, loan({ balance: 500, debitBalance: true }))).toBe(0);
  });

  it('adds one guarantor\'s loans up, whatever the case of the name, largest first', () => {
    const groups = guarantorGroups([FM, CHASE, SBA]);
    expect(groups.map((g) => [g.name, g.exposure, g.lines.length])).toEqual([['Asha Greene', 750000, 2], ['Greene Family Trust', 0, 1]]);
    // Two guarantees by one name on one loan never pass that loan's balance.
    const twice = loan({ balance: 100000, guarantors: [{ name: 'Asha Greene', kind: 'full' }, { name: 'Asha Greene', kind: 'limited', amount: 60000 }] });
    expect(guarantorGroups([twice])[0].exposure).toBe(100000);
  });

  it('counts a loan as recorded once it has a recourse or a guarantor', () => {
    expect([FM, CHASE, SBA, NONREC].map(hasGuaranteeRecord)).toEqual([true, true, false, true]);
  });
});

describe('the Guarantees section', () => {
  it('lists each guarantor with their loans and exposure, and says what is still unrecorded', () => {
    render(<LoanGuarantees rows={[FM, CHASE, SBA, NONREC, OLD]} />);
    const g = within(screen.getByRole('region', { name: 'Guarantees' }));
    const rows = g.getAllByRole('listitem').map((r) => r.textContent);
    expect(rows).toEqual([
      'Asha GreeneF&M Bank #6870 (Greens Escondido, LLC.) - Limited to $350,000.00; Chase #9001 (MCD Services, Inc.) - Full750,000.00',
      'Greene Family TrustF&M Bank #6870 (Greens Escondido, LLC.) - Carve-Outs Only-',
    ]);
    // A closed loan's guarantor is not in it; the closed loan is not counted either.
    expect(g.queryByText('Someone Else')).toBeNull();
    expect(g.getByText('1 of 4 open loans has no guarantee recorded yet - add it under Change Loan.')).toBeTruthy();
  });

  it('shows nothing until an open loan has a guarantee record', () => {
    const { container } = render(<LoanGuarantees rows={[SBA, OLD]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the count line alone when the only records are non-recourse loans', () => {
    render(<LoanGuarantees rows={[NONREC, SBA]} />);
    const g = within(screen.getByRole('region', { name: 'Guarantees' }));
    expect(g.queryAllByRole('listitem')).toEqual([]);
    expect(g.getByText('No guarantor is recorded on the open loans shown.')).toBeTruthy();
    expect(g.getByText('1 of 2 open loans has no guarantee recorded yet - add it under Change Loan.')).toBeTruthy();
  });
});
