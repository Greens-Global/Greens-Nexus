import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LoanTermOffers from './LoanTermOffers';
import { offerBody, offersFor, offerWords } from './loanTermModel';

// Terms From Asset Management (Neil, 11/19/2026): a term typed on the property is offered for
// the loan that lacks it, and filled only when an editor says so.
const LOANS = [
  { id: 'L1', lender: 'Harbor Bank', loanNo: '6870', entityName: 'Harbor Heritage, LLC.', ratePct: null, maturity: null, closed: false },
  { id: 'L2', lender: 'Canyon Credit Union', loanNo: '', entityName: 'Harbor Family LP', ratePct: 5.5, maturity: null, closed: false },
  { id: 'L3', lender: 'Old Note', loanNo: '', ratePct: null, maturity: null, closed: true },
  { id: 'L4', lender: 'Full Loan', loanNo: '', ratePct: 4, maturity: '2030-01-01', closed: false },
];
const SUGGESTED = [
  { loanId: 'L1', propertyId: 'p1', propertyName: 'Oak Street', why: 'number', maturity: '2031-06-01', ratePct: 6.25, rateType: 'fixed' },
  { loanId: 'L2', propertyId: 'p2', propertyName: 'Canyon Store', why: 'lender', maturity: '2029-03-15', ratePct: 7 },
  { loanId: 'L3', propertyId: 'p3', propertyName: 'Closed Lot', why: 'only', maturity: '2028-01-01' },
  { loanId: 'L4', propertyId: 'p4', propertyName: 'Full Lot', why: 'lender', maturity: '2033-01-01', ratePct: 9 },
  { loanId: 'gone', propertyId: 'p5', propertyName: 'Elsewhere', why: 'lender', maturity: '2033-01-01' },
];

describe('offersFor', () => {
  it('keeps only the terms a loan on screen still lacks', () => {
    const offers = offersFor(SUGGESTED, LOANS);
    expect(offers.map((o) => o.loanId)).toEqual(['L1', 'L2']);
    expect(offerBody(offers[0])).toEqual({ maturity: '2031-06-01', ratePct: 6.25, rateType: 'fixed' });
    // The loan already has a rate: only the maturity is offered, the typed 7% is not.
    expect(offerBody(offers[1])).toEqual({ maturity: '2029-03-15' });
    expect(offerWords(offers[0])).toBe('Maturity 06/01/2031 - Rate 6.25% fixed');
    expect(offerWords(offers[1])).toBe('Maturity 03/15/2029');
  });
  it('offers nothing with nothing to go on', () => {
    expect(offersFor(null, LOANS)).toEqual([]);
    expect(offersFor(SUGGESTED, [])).toEqual([]);
  });
});

describe('LoanTermOffers', () => {
  it('lists each offer with where it came from and fills only what stays ticked', () => {
    const onApply = vi.fn();
    render(<LoanTermOffers offers={offersFor(SUGGESTED, LOANS)} onApply={onApply} onClose={vi.fn()} />);
    expect(screen.getByText('Maturity 06/01/2031 - Rate 6.25% fixed')).toBeTruthy();
    expect(screen.getByText('Typed on Oak Street - the loan number matches.')).toBeTruthy();
    expect(screen.getByText('Typed on Canyon Store - the lender matches.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fill 2 Loans' })).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Fill Canyon Credit Union' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fill 1 Loan' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0].map((o) => o.loanId)).toEqual(['L1']);
  });
  it('cannot fill with nothing ticked, and holds still while filling', () => {
    const { rerender } = render(<LoanTermOffers offers={offersFor(SUGGESTED.slice(0, 1), LOANS)} onApply={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Fill Harbor Bank' }));
    expect(screen.getByRole('button', { name: 'Fill Loans' }).disabled).toBe(true);
    expect(screen.getByText('Tick a loan to fill its terms.')).toBeTruthy();
    rerender(<LoanTermOffers offers={offersFor(SUGGESTED.slice(0, 1), LOANS)} onApply={vi.fn()} onClose={vi.fn()} busy />);
    expect(screen.getByRole('button', { name: 'Filling...' }).disabled).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Fill Harbor Bank' }).disabled).toBe(true);
  });
});
