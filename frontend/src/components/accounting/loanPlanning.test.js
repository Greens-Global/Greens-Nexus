import { describe, expect, it } from 'vitest';
import { existingDebt, maxLoanForDscr, mortgagePlan, planImpact, planLoanAmount, pmt, round2, stressPortfolio, t12From, yearlySchedule } from './loanMath';

// Loan Planning / Mortgage Calculator (Charmi, item 25, Oct 15): the
// arithmetic behind Accounting > Loans & Financing > Loan Planning.

const near = (a, b, tol = 5) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const base = { loanAmount: 1000000, ratePct: 6, amortYears: 30, startDate: '2026-11-15' };

describe('mortgagePlan', () => {
  it('pays $1,000,000 at 6% over 30 years at the textbook $5,995.51 a month', () => {
    const p = mortgagePlan(base);
    expect(p.errors).toEqual([]);
    expect(p.payment).toBe(5995.51);
    expect(p.monthlyPayment).toBe(5995.51);
    expect(p.annualDebtService).toBe(71946.12);
    expect(p.rows).toHaveLength(360);
    expect(p.rows[0]).toMatchObject({ n: 1, date: '2026-12-15', interest: 5000, principal: 995.51, balance: 999004.49 });
    expect(p.rows[359].balance).toBe(0);
    expect(p.balloon).toBe(0);
    expect(p.maturityDate).toBe('2056-11-15');
    near(p.totalInterest, 1158383.6);
    expect(p.totalPaid).toBe(round2(1000000 + p.totalInterest));
  });

  it('leaves a balloon when the term ends before the amortization', () => {
    const p = mortgagePlan({ ...base, termYears: 10 });
    expect(p.rows).toHaveLength(120);
    expect(p.payment).toBe(5995.51);
    near(p.balloon, 836857.25);
    expect(p.rows[119].balance).toBe(0);
    expect(p.maturityDate).toBe('2036-11-15');
  });

  it('charges interest only first, then amortizes over the full amortization', () => {
    const p = mortgagePlan({ ...base, ioMonths: 12 });
    expect(p.ioPayment).toBe(5000);
    expect(p.ioAnnualDebtService).toBe(60000);
    expect(p.rows.slice(0, 12).every((r) => r.principal === 0 && r.balance === 1000000)).toBe(true);
    expect(p.rows[12].payment).toBe(5995.51);
    expect(p.firstYearDebtService).toBe(60000);
    // A 30-year term with a 12-month IO start: the 30-year amortization is cut
    // short by a year, so the last 12 payments come due as a balloon.
    near(p.balloon, 69661);
    const full = mortgagePlan({ ...base, ioMonths: 12, termYears: 31 });
    expect(full.balloon).toBe(0);
    expect(full.rows).toHaveLength(372);
  });

  it('pays quarterly, semiannually or annually', () => {
    const q = mortgagePlan({ ...base, frequency: 'quarterly' });
    expect(q.payment).toBe(round2(pmt(1000000, 0.015, 120)));
    expect(q.annualDebtService).toBe(round2(q.payment * 4));
    expect(q.rows).toHaveLength(120);
    expect(q.rows[0].date).toBe('2027-02-15');
    expect(mortgagePlan({ ...base, frequency: 'annual' }).rows).toHaveLength(30);
  });

  it('sizes the loan from a purchase price and adds up the cash to close', () => {
    const p = mortgagePlan({ ...base, usePurchase: true, purchasePrice: 1250000, downPct: 20, pointsPct: 1, closingCosts: 15000 });
    expect(p.amount).toBe(1000000);
    expect(p.downPayment).toBe(250000);
    expect(p.ltvPct).toBe(80);
    expect(p.points).toBe(10000);
    expect(p.upfrontCosts).toBe(25000);
    expect(p.cashToClose).toBe(275000);
    expect(p.netProceeds).toBe(975000);
    expect(planLoanAmount({ usePurchase: true, purchasePrice: 500000, downPct: 100 })).toBe(0);
  });

  it('refuses what cannot be worked out', () => {
    expect(mortgagePlan({}).errors.length).toBeGreaterThan(0);
    expect(mortgagePlan({ ...base, ratePct: 60 }).errors).toContain('The rate must be between 0% and 50%.');
    expect(mortgagePlan({ ...base, termYears: 1, ioMonths: 24 }).errors).toContain('Interest-only months cannot exceed the term.');
    expect(mortgagePlan({ ...base, ratePct: 0, amortYears: 10 }).payment).toBe(round2(1000000 / 120));
  });

  it('works without a start date (payments numbered, not dated)', () => {
    const p = mortgagePlan({ ...base, startDate: '' });
    expect(p.rows[0].date).toBe('');
    expect(yearlySchedule(p.rows, 12)).toHaveLength(30);
  });
});

describe('yearlySchedule', () => {
  it('rolls the months up by calendar year', () => {
    const p = mortgagePlan(base);
    const years = yearlySchedule(p.rows);
    expect(years[0]).toMatchObject({ year: 2026, payments: 1 });
    expect(years[1]).toMatchObject({ year: 2027, payments: 12 });
    expect(years[years.length - 1].balance).toBe(0);
    near(years.reduce((s, y) => s + y.interest, 0), p.totalInterest, 0.05);
  });
});

describe('DSCR sizing', () => {
  it('finds the most the NOI supports at 1.25x', () => {
    // NOI that covers $5,995.51 a month 1.25 times supports the $1,000,000.
    near(maxLoanForDscr({ noi: 71946.12 * 1.25, dscr: 1.25, ratePct: 6, amortYears: 30 }), 1000000, 1);
    near(maxLoanForDscr({ noi: 71946.12 * 1.25, dscr: 1.25, ratePct: 6, amortYears: 30, existingDebtService: 71946.12 / 2 }), 500000, 1);
    expect(maxLoanForDscr({ noi: 50000, dscr: 1.25, ratePct: 6, amortYears: 30, existingDebtService: 60000 })).toBe(0);
    expect(maxLoanForDscr({ noi: 75000, dscr: 1.25, ratePct: 6, interestOnly: true })).toBe(1000000);
  });

  it('shows the planned loan on top of the entity\'s debt service', () => {
    const plan = mortgagePlan({ ...base, ioMonths: 12 });
    const i = planImpact({ plan, noi: 120000, existingDebtService: 30000, dscrTarget: 1.25, ratePct: 6, amortYears: 30 });
    expect(i.totalDebtService).toBe(101946.12);
    expect(i.dscrBefore).toBe(4);
    expect(i.dscrAfter).toBe(1.18);
    expect(i.dscrDuringIo).toBe(1.33);
    expect(i.pass).toBe(false);
    expect(i.cushion).toBe(round2(120000 - 1.25 * 101946.12));
    near(i.maxLoan, maxLoanForDscr({ noi: 120000, ratePct: 6, amortYears: 30, existingDebtService: 30000 }), 0);
    expect(i.maxLoan).toBeLessThan(1000000);
    expect(planImpact({ plan, noi: null }).pass).toBeNull();
  });

  it('takes the entity\'s debt service from the Stress Test math', () => {
    const loans = [
      { id: 'A', entityCode: '15000', entityName: 'Escondido', balance: 500000, ratePct: 5, monthlyPi: 2684.11, noiT12: 150000 },
      { id: 'B', entityCode: '15000', balance: 0, ratePct: 5 },                    // paid off
      { id: 'C', entityCode: '12000', balance: 900000, ratePct: 7 },               // another entity
    ];
    const e = stressPortfolio(loans.slice(0, 1), { shockBps: 0 }).entities[0];
    const debt = existingDebt(loans, '15000');
    expect(debt).toEqual({ debtService: e.baseDebtService, loans: 1 });
    expect(existingDebt(loans, '15000', new Set(['A']))).toEqual({ debtService: 0, loans: 0 });
    expect(existingDebt(loans, '')).toEqual({ debtService: 0, loans: 0 });
    const i = planImpact({ plan: mortgagePlan(base), noi: e.noi, existingDebtService: debt.debtService });
    expect(i.totalDebtService).toBe(round2(e.baseDebtService + 71946.12));
  });

  it('counts T12 from the twelve months ending on the period end', () => {
    expect(t12From('2026-09-30')).toBe('2025-10-01');
    expect(t12From('2026-10-15')).toBe('2025-10-16');
    expect(t12From('2024-02-29')).toBe('2023-03-01');
    expect(t12From('')).toBe('');
  });
});
