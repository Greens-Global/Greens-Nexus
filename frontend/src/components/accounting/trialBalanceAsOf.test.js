import { describe, it, expect, vi } from 'vitest';
import { defaultConfig, periodOf, periodText, resolveConfig, runReport, trialBalanceLines } from './reportModel';

// Oct 22 (Neil's spec, item 06): the Trial Balance is "accounts x debit/
// credit/balance as of a date, using the same entity/book filters as Balance
// Sheet". One memorized as a range before then still opens as that range.
const NOW = new Date(2026, 9, 22); // 10/22/2026

// Sums per account through a date, as the bucket read answers (debits and credits).
const THROUGH = [
  { section: 'asset', account_no: '11341', title: 'Chase Checking', debit: 5000, credit: 1000, bucket: '' },
  { section: 'liability', account_no: '20100', title: 'Accounts Payable', debit: 200, credit: 700, bucket: '' },
  { section: 'equity', account_no: '30100', title: 'Owner Capital', debit: 0, credit: 1800, bucket: '' },
  { section: 'equity', account_no: '32000', title: 'Retained Earnings', debit: 0, credit: 0, bucket: '' },
  // 2,500 of rent in all, 1,000 of it last year; 800 of repairs, 300 last year.
  { section: 'revenue', account_no: '41101', title: 'Rental Income', debit: 0, credit: 2500, bucket: '' },
  { section: 'expense', account_no: '61101', title: 'Repairs', debit: 800, credit: 0, bucket: '' },
];
const BEFORE = [
  { section: 'asset', account_no: '11341', title: 'Chase Checking', debit: 2000, credit: 300, bucket: '' },
  { section: 'revenue', account_no: '41101', title: 'Rental Income', debit: 0, credit: 1000, bucket: '' },
  { section: 'expense', account_no: '61101', title: 'Repairs', debit: 300, credit: 0, bucket: '' },
];

const fakeApi = () => ({
  getAccountingBuckets: vi.fn(async ({ to }) => ({ org: 'Greens Global', generated_at: '2026-10-22', rows: to === '2026-09-30' ? THROUGH : BEFORE })),
  getAccountingTrialBalance: vi.fn(async () => ({
    org: 'Greens Global', generated_at: '2026-10-22',
    rows: [{ account_no: '11341', title: 'Chase Checking', opening: 100, debit: 1300, credit: 0, closing: 1400 }],
    totals: { opening: 100, debit: 1300, credit: 0, closing: 1400 },
  })),
});

describe('Trial Balance as of a date', () => {
  it('opens as of a date from the menu, the Report box or a fresh config', () => {
    const fresh = resolveConfig({ ...defaultConfig(NOW), report: 'trial-balance' }, NOW);
    expect([fresh.tbPeriod, periodOf(fresh), periodText(fresh)]).toEqual(['asof', 'asof', 'As of 10/22/2026']);
    // Picked from another report in the Report box (the config already carries tbPeriod).
    const picked = resolveConfig({ ...resolveConfig(defaultConfig(NOW), NOW), report: 'trial-balance' }, NOW);
    expect(periodOf(picked)).toBe('asof');
  });

  it('balance sheet accounts carry everything through the date, income and expense this year only, the years before on Retained Earnings', () => {
    const lines = trialBalanceLines(THROUGH, BEFORE, '2026-09-30');
    const by = Object.fromEntries(lines.map((l) => [l.code, l.balance]));
    expect(by).toEqual({ 11341: 4000, 20100: -500, 30100: -1800, 32000: -700, 41101: -1500, 61101: 500 });
    // A balanced ledger adds up to nothing.
    expect(lines.reduce((s, l) => s + l.balance, 0)).toBeCloseTo(0, 2);
  });

  it('adds a Retained earnings line when the chart has no such account', () => {
    const lines = trialBalanceLines(THROUGH.filter((r) => r.account_no !== '32000'), BEFORE, '2026-09-30');
    expect(lines.at(-1)).toEqual({ code: '', title: 'Retained Earnings (Prior Years)', pl: false, balance: -700 });
  });

  it('lists Debit, Credit and Balance per account, with the Balance Sheet entity and book filters', async () => {
    const api = fakeApi();
    const config = resolveConfig({ ...defaultConfig(NOW), report: 'trial-balance', asof: '2026-09-30', asofToday: false, entities: ['12000'], book: 'cash' }, NOW);
    const r = await runReport(api, config);
    expect(api.getAccountingTrialBalance).not.toHaveBeenCalled();
    const calls = api.getAccountingBuckets.mock.calls.map(([p]) => [p.from, p.to, p.by, p.book, p.location]);
    expect(calls).toEqual([[undefined, '2026-09-30', 'total', 'cash', '12000'], [undefined, '2025-12-31', 'total', 'cash', '12000']]);
    expect(r.def.period).toBe('asof');
    expect(r.columns.map((c) => c.label)).toEqual(['Debit', 'Credit', 'Balance']);
    const row = (code) => r.rows.find((x) => x.code === code);
    expect(row('11341').values).toEqual([4000, 0, 4000]);
    expect(row('41101').values).toEqual([0, 1500, -1500]);
    // The Total: debits equal credits.
    expect(r.rows.at(-1)).toMatchObject({ kind: 'grand', label: 'Total', values: [4500, 4500, 0] });
    // Balances drill through the date; an income account opens this year's lines.
    expect(r.columns[2].drill).toEqual({ from: '', to: '2026-09-30', book: 'cash' });
    expect(row('41101').drills[2]).toEqual({ from: '2026-01-01', to: '2026-09-30', book: 'cash' });
  });

  it('lays the cash balance beside the accrual one when both books are asked for', async () => {
    const api = fakeApi();
    const r = await runReport(api, resolveConfig({ ...defaultConfig(NOW), report: 'trial-balance', asof: '2026-09-30', asofToday: false, book: 'both' }, NOW));
    expect(r.columns.map((c) => c.label)).toEqual(['Debit', 'Credit', 'Balance (Accrual)', 'Balance (Cash)']);
    expect(api.getAccountingBuckets.mock.calls.map(([p]) => p.book)).toEqual(['accrual', 'accrual', 'cash', 'cash']);
  });
});

describe('a Trial Balance memorized as a range (before 10/22)', () => {
  const saved = { report: 'trial-balance', preset: 'custom', from: '2026-07-01', to: '2026-09-30', book: 'accrual', cols: 'total', entities: [], dims: {} };

  it('still opens on its range', () => {
    const c = resolveConfig(saved, NOW);
    expect([c.tbPeriod, periodOf(c), c.from, c.to]).toEqual(['range', 'range', '2026-07-01', '2026-09-30']);
    expect(periodText(c)).toBe('Custom · 07/01/2026 - 09/30/2026');
    // Resolved again (every control change does), it stays a range.
    expect(periodOf(resolveConfig({ ...c, showZero: true }, NOW))).toBe('range');
  });

  it('shows what it showed: opening, debit, credit and closing for the range', async () => {
    const api = fakeApi();
    const r = await runReport(api, resolveConfig(saved, NOW));
    expect(api.getAccountingTrialBalance).toHaveBeenCalledWith('2026-07-01', '2026-09-30', undefined, null, 'accrual');
    expect(api.getAccountingBuckets).not.toHaveBeenCalled();
    expect(r.columns.map((c) => c.label)).toEqual(['Opening', 'Debit', 'Credit', 'Closing']);
    expect(r.rows[0].values).toEqual([100, 1300, 0, 1400]);
  });

  it('goes back to as of a date once another report is picked and Trial Balance picked again', () => {
    const other = resolveConfig({ ...resolveConfig(saved, NOW), report: 'balance-sheet' }, NOW);
    expect(periodOf(resolveConfig({ ...other, report: 'trial-balance' }, NOW))).toBe('asof');
  });
});
