import { describe, expect, it } from 'vitest';
import {
  addMonths, annualDebtService, buildSchedule, days360, actualDays, expectedBalanceAt, findHeaderRow, guessColumns,
  impliedRemainingMonths, normalizeLoan, parseDateCell, parseNumber, pmt, rowsFromMatrix, scheduleTotals, solveRate, stressLoan, stressPortfolio,
} from './loanMath';

describe('dates', () => {
  it('adds months keeping the anchor day, clamped to short months', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonths('bad', 1)).toBe('');
  });
  it('counts days 30/360 and actual', () => {
    expect(days360('2026-01-01', '2026-02-01')).toBe(30);
    expect(days360('2026-01-31', '2026-02-28')).toBe(28);
    expect(days360('2026-01-01', '2027-01-01')).toBe(360);
    expect(actualDays('2026-01-01', '2026-02-01')).toBe(31);
    expect(actualDays('2026-02-01', '2026-03-01')).toBe(28);
  });
});

describe('payments', () => {
  it('sizes the level payment', () => {
    // $1,000,000 at 6% over 30 years: the textbook $5,995.51.
    expect(pmt(1000000, 0.06 / 12, 360)).toBeCloseTo(5995.51, 2);
    expect(pmt(1200, 0, 12)).toBe(100);
  });
  it('solves the months left from the monthly payment', () => {
    expect(impliedRemainingMonths(1000000, 6, 5995.51)).toBe(360);
    expect(impliedRemainingMonths(1000000, 6, 5000)).toBeNull();   // under the interest: never pays off
    expect(impliedRemainingMonths(1200, 0, 100)).toBe(12);
    expect(impliedRemainingMonths(0, 6, 100)).toBeNull();
  });
});

describe('buildSchedule', () => {
  const base = { principal: 1000000, ratePct: 6, termMonths: 360, amortMonths: 360, firstPaymentDate: '2026-11-01' };

  it('amortizes fully over the term, 30/360', () => {
    const s = buildSchedule(base);
    expect(s.errors).toEqual([]);
    expect(s.rows).toHaveLength(360);
    expect(s.payment).toBe(5995.51);
    expect(s.rows[0]).toEqual({ n: 1, date: '2026-11-01', payment: 5995.51, interest: 5000, principal: 995.51, balloon: 0, balance: 999004.49 });
    const last = s.rows[359];
    expect(last.date).toBe('2056-10-01');
    expect(last.balance).toBe(0);
    expect(last.balloon).toBe(0);
    expect(Math.abs(last.payment - 5995.51)).toBeLessThan(10);     // the last payment absorbs 360 months of rounding to cents
    const t = scheduleTotals(s.rows);
    expect(t.principal).toBeCloseTo(1000000, 2);
    expect(s.totalPaid).toBeCloseTo(t.payment, 2);
  });

  it('leaves a balloon when the amortization outruns the term', () => {
    const s = buildSchedule({ ...base, termMonths: 120, amortMonths: 360 });
    expect(s.rows).toHaveLength(120);
    const last = s.rows[119];
    expect(last.balance).toBe(0);
    // A 10/30 at 6%: about 83.7% of the loan is still owed at year 10.
    expect(last.balloon).toBeGreaterThan(830000);
    expect(last.balloon).toBeLessThan(840000);
    expect(s.balloon).toBe(last.balloon);
    expect(scheduleTotals(s.rows).principal + last.balloon).toBeCloseTo(1000000, 2);
  });

  it('runs interest only first, then amortizes over the amortization from there', () => {
    const s = buildSchedule({ ...base, termMonths: 120, amortMonths: 360, ioMonths: 24 });
    expect(s.rows[0]).toMatchObject({ payment: 5000, interest: 5000, principal: 0, balance: 1000000 });
    expect(s.rows[23].balance).toBe(1000000);
    expect(s.rows[24].payment).toBe(5995.51);
    expect(s.ioPayment).toBe(5000);
  });

  it('charges actual days over 365 with a level payment', () => {
    const s = buildSchedule({ ...base, dayCount: 'actual/365', firstPaymentDate: '2026-02-01', termMonths: 120 });
    // January has 31 days: 1,000,000 * 6% * 31 / 365.
    expect(s.rows[0].interest).toBe(5095.89);
    // February 28 days.
    expect(s.rows[1].interest).toBeCloseTo((1000000 - s.rows[0].principal) * 0.06 * 28 / 365, 2);
    const thirty = buildSchedule({ ...base, firstPaymentDate: '2026-02-01', termMonths: 120 });
    expect(s.balloon).toBeGreaterThan(thirty.balloon);        // 365/360 more interest leaves more owed
  });

  it('counts the stub from the funding date', () => {
    const s = buildSchedule({ ...base, startDate: '2026-10-16' });
    expect(s.rows[0].interest).toBe(2500);   // 15 days 30/360
  });

  it('handles a zero rate', () => {
    const s = buildSchedule({ principal: 1200, ratePct: 0, termMonths: 12, firstPaymentDate: '2026-01-15' });
    expect(s.rows.every((r) => r.payment === 100 && r.interest === 0)).toBe(true);
    expect(s.rows[11].balance).toBe(0);
  });

  it('refuses bad input', () => {
    expect(buildSchedule({}).errors.length).toBeGreaterThan(0);
    expect(buildSchedule({ ...base, ioMonths: 400 }).errors).toContain('Interest-only months cannot exceed the term.');
    expect(buildSchedule({ ...base, amortMonths: 60, termMonths: 120 }).errors.length).toBe(1);
    expect(buildSchedule({ ...base, startDate: '2026-12-01' }).errors).toContain('The first payment must come after the funding date.');
  });
});

describe('expectedBalanceAt', () => {
  const rows = [
    { n: 1, date: '2026-10-01', payment: 1000, interest: 500, principal: 500, balloon: 0, balance: 100000 },
    { n: 2, date: '2026-11-01', payment: 1000, interest: 400, principal: 600, balloon: 0, balance: 99400 },
  ];
  it('is the balance after the last payment in or before the month', () => {
    expect(expectedBalanceAt(rows, '2026-09')).toEqual({ balance: 100500, asOf: null, n: 0 });
    expect(expectedBalanceAt(rows, '2026-10').balance).toBe(100000);
    expect(expectedBalanceAt(rows, '2030-01')).toEqual({ balance: 99400, asOf: '2026-11-01', n: 2 });
    expect(expectedBalanceAt([], '2026-10')).toBeNull();
  });
});

describe("the bank's file", () => {
  it('reads amounts the way banks print them', () => {
    expect(parseNumber('$1,234.50')).toBe(1234.5);
    expect(parseNumber('(1,234.50)')).toBe(-1234.5);
    expect(parseNumber('1,234.50-')).toBe(-1234.5);
    expect(parseNumber('-')).toBe(0);
    expect(parseNumber(42)).toBe(42);
    expect(parseNumber('Payment')).toBeNull();
    expect(parseNumber('')).toBeNull();
  });
  it('reads dates as US, ISO, Excel serials and words', () => {
    expect(parseDateCell('11/01/2026')).toBe('2026-11-01');
    expect(parseDateCell('1/5/27')).toBe('2027-01-05');
    expect(parseDateCell('2026-11-01')).toBe('2026-11-01');
    expect(parseDateCell(46327)).toBe('2026-11-01');
    expect(parseDateCell('Nov 1, 2026')).toBe('2026-11-01');
    expect(parseDateCell(1500)).toBe('');
    expect(parseDateCell('13/40/2026')).toBe('');
    expect(parseDateCell('Totals')).toBe('');
  });
  it('finds the header row and guesses the columns', () => {
    const matrix = [
      ['First Bank - Loan 6870'], [],
      ['Pmt #', 'Payment Date', 'Payment Amount', 'Interest', 'Principal', 'Principal Balance'],
      [1, '11/01/2026', '5,995.51', '5,000.00', '995.51', '999,004.49'],
      [2, 46357, 5995.51, 4995.02, 1000.49, 998004.00],
      ['Totals', '', '11,991.02', '', '', ''],
    ];
    const h = findHeaderRow(matrix);
    expect(h).toBe(2);
    const map = guessColumns(matrix[h]);
    expect(map).toMatchObject({ date: 1, payment: 2, interest: 3, principal: 4, balance: 5, balloon: -1 });
    const { rows, skipped } = rowsFromMatrix(matrix, h, map);
    expect(skipped).toBe(1);   // the Totals line
    expect(rows).toEqual([
      { n: 1, date: '2026-11-01', payment: 5995.51, interest: 5000, principal: 995.51, balloon: 0, balance: 999004.49 },
      { n: 2, date: '2026-12-01', payment: 5995.51, interest: 4995.02, principal: 1000.49, balloon: 0, balance: 998004 },
    ]);
  });
  it('fills a missing principal from the payment less the interest', () => {
    const { rows } = rowsFromMatrix([['Date', 'Payment', 'Interest', 'Balance'], ['11/01/2026', 1000, 400, 50000]], 0, { date: 0, payment: 1, interest: 2, balance: 3, principal: -1 });
    expect(rows[0].principal).toBe(600);
  });
});

describe('stress', () => {
  it('prices annual debt service amortizing or interest only', () => {
    expect(annualDebtService({ balance: 1000000, ratePct: 6, amortMonths: 360 })).toBeCloseTo(71946.06, 1);
    expect(annualDebtService({ balance: 1000000, ratePct: 6, interestOnly: true })).toBe(60000);
  });

  it('solves a rate by bisection', () => {
    const ds = (r) => 1000000 * r / 100;
    expect(solveRate(ds, 70000)).toBeCloseTo(7, 2);
    expect(solveRate(ds, -1)).toBeNull();
    expect(solveRate(ds, 10000000)).toBe('above');
  });

  it('shocks a floating loan', () => {
    const s = stressLoan({ balance: 1000000, ratePct: 6, shockBps: 200, noi: 120000, covenant: 1.35, rateType: 'floating', interestOnly: true });
    expect(s.stressedRate).toBe(8);
    expect(s.baseDebtService).toBe(60000);
    expect(s.debtService).toBe(80000);
    expect(s.dscrBase).toBe(2);
    expect(s.dscr).toBe(1.5);
    expect(s.pass).toBe(true);
    expect(s.cushion).toBe(12000);                 // 120,000 - 1.35 x 80,000
    expect(s.cushionPct).toBe(10);
    // DSCR = 1.35 when debt service = 88,888.89: 8.889% interest only.
    expect(s.breakEvenRate).toBeCloseTo(8.889, 2);
    expect(s.headroomBps).toBe(289);
  });

  it('holds a fixed loan until maturity, and shows the refinance', () => {
    const s = stressLoan({ balance: 1000000, ratePct: 6, shockBps: 300, noi: 90000, covenant: 1.35, rateType: 'fixed', interestOnly: true });
    expect(s.debtService).toBe(60000);
    expect(s.pass).toBe(true);
    expect(s.refinanceDebtService).toBe(90000);
    expect(s.dscrAtRefinance).toBe(1);
    expect(s.passAtRefinance).toBe(false);
  });

  it('fails when even the current rate breaks the covenant', () => {
    const s = stressLoan({ balance: 1000000, ratePct: 6, shockBps: 100, noi: 50000, covenant: 1.35, interestOnly: true });
    expect(s.pass).toBe(false);
    expect(s.cushion).toBeLessThan(0);
    expect(s.breakEvenRate).toBeCloseTo(3.704, 2);
    expect(s.headroomBps).toBeLessThan(0);
  });

  it('reads both loan shapes', () => {
    expect(normalizeLoan({ id: 'A', rate: 5.5, covenant: 1.25, entity: 'X', rateType: 'variable' })).toMatchObject({ ratePct: 5.5, covenant: 1.25, entityCode: 'X', rateType: 'floating' });
    expect(normalizeLoan({ id: 'B', ratePct: null, covenantMin: 0, entityCode: '15000' })).toMatchObject({ ratePct: null, covenant: 1.35, entityCode: '15000', rateType: 'fixed' });
  });

  it('stresses a portfolio entity by entity', () => {
    const loans = [
      { id: 'A', entityCode: '15000', entityName: 'Escondido', balance: 1000000, ratePct: 6, rateType: 'variable', noiT12: 150000, covenantMin: 1.35, monthlyPi: 5995.51 },
      { id: 'B', entityCode: '15000', entityName: 'Escondido', balance: 500000, ratePct: 5, rateType: 'fixed', noiT12: 150000, covenantMin: 1.25 },
      { id: 'C', entityCode: '12000', entityName: 'Global', balance: 200000, ratePct: 7, rateType: 'variable', noiT12: 100000 },
    ];
    const p = stressPortfolio(loans, { shockBps: 200 });
    expect(p.totals.entities).toBe(2);
    const esc = p.entities.find((e) => e.entityCode === '15000');
    expect(esc.noi).toBe(150000);                  // one NOI per entity, not per loan
    expect(esc.covenant).toBe(1.35);               // the strictest covenant of its loans
    expect(esc.loans[0].amortMonths).toBe(360);    // from the monthly P&I
    const fixedB = esc.loans.find((l) => l.id === 'B');
    expect(fixedB.debtService).toBe(fixedB.baseDebtService);
    expect(esc.debtService).toBeGreaterThan(esc.baseDebtService);
    expect(esc.pass).toBe(esc.dscr >= 1.35);
    // Failing entities sort first.
    if (p.totals.failing) expect(p.entities[0].pass).toBe(false);
    const typed = stressPortfolio(loans, { shockBps: 200, entityNoi: { 15000: 1000 } });
    expect(typed.entities.find((e) => e.entityCode === '15000').pass).toBe(false);
  });
});
