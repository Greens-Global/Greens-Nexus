import { describe, expect, it } from 'vitest';
import { applyLiabilityRecons, loanIdOf } from './liabilityRecon';

// Mortgages, loans and credit lines reconciled in Nexus (10/27, item 09) read
// on the reconciliation list like bank accounts.

const loanRow = { key: 'loan:L1', type: 'Mortgage', name: 'F&M Mortgage', ref: 'Isha Kadakia', entityCode: '34000', gl: '', thru: null, lag: 99, openItems: 0, diff: 0, mark: null, book: -412_345.67, stmt: -412_345.67, status: 'Behind', nc: false };
const bankRow = { key: 'gl:a@34000', type: 'Bank', name: 'INK - F&M - 5446', gl: '11336', thru: null, status: 'Behind', source: null };
const loans = [{ id: 'L1', gl_account: '25100' }];
const rec = (period, status, extra = {}) => ({ period, status, statementDate: `${period}-30`, statementBalance: 412_345.67, difference: 0, reconciledBy: 'Charmi Desai', ...extra });

describe('applyLiabilityRecons', () => {
  it('leaves bank rows alone and gives a loan its GL account', () => {
    const [bank, loan] = applyLiabilityRecons([bankRow, loanRow], { period: '2026-09', status: {}, loans });
    expect(bank).toBe(bankRow);
    expect(loan.gl).toBe('25100');
    expect(loan.liability).toBe(true);
    expect(loan.status).toBe('Behind');
    expect(loanIdOf('loan:L1')).toBe('L1');
    expect(loanIdOf('gl:a@1')).toBeNull();
  });

  it('reads Reconciled with the statement balance when this month is reconciled', () => {
    const [r] = applyLiabilityRecons([loanRow], { period: '2026-09', status: { L1: { month: rec('2026-09', 'reconciled'), last: rec('2026-09', 'reconciled') } }, loans });
    expect(r).toMatchObject({ status: 'Reconciled', thru: '2026-09-30', stmt: -412_345.67, diff: 0, source: 'nexus', lag: 0 });
    expect(r.nexus.reconciledBy).toBe('Charmi Desai');
  });

  it('reads In progress one month behind, Behind further back', () => {
    const one = applyLiabilityRecons([loanRow], { period: '2026-09', status: { L1: { month: null, last: rec('2026-08', 'reconciled', { statementDate: '2026-08-31', statementBalance: 413_000 }) } }, loans })[0];
    expect(one).toMatchObject({ status: 'In progress', thru: '2026-08-31', stmt: -413_000, source: 'nexus' });
    const far = applyLiabilityRecons([loanRow], { period: '2026-09', status: { L1: { month: null, last: rec('2026-05', 'reconciled', { statementDate: '2026-05-31' }) } }, loans })[0];
    expect(far.status).toBe('Behind');
  });

  it('shows a typed statement that does not agree as a Difference', () => {
    const [r] = applyLiabilityRecons([loanRow], { period: '2026-09', status: { L1: { month: rec('2026-09', 'open', { statementBalance: 412_445.67, difference: 100 }), last: null } }, loans });
    expect(r).toMatchObject({ status: 'Difference', diff: 100, stmt: -412_445.67, thru: null });
    // Saved at 0.00 but not marked yet: still not reconciled.
    const [z] = applyLiabilityRecons([loanRow], { period: '2026-09', status: { L1: { month: rec('2026-09', 'open'), last: null } }, loans });
    expect(z.status).toBe('Behind');
  });
});
