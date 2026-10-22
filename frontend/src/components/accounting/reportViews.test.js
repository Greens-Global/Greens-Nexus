import { describe, it, expect } from 'vitest';
import { REPORT_VIEWS, bookOptions, monthKeys, resolveConfig, runReport, viewConfig } from './reportModel';
import { TRIAL_BALANCE_DEFAULT_BOOK } from './assumptions';

// Oct 22 (Neil and Charmi): the Reports menu's quick views open with the
// period and columns already set, "so she doesn't have to refilter".
const now = new Date(2026, 9, 22); // 10/22/2026
const open = (key) => resolveConfig({ ...viewConfig(key, now) }, now);

describe('report quick views', () => {
  // CR-06 (Neil, 23 Oct): "T12 should mean the last 12 full months, meaning it should show 13" - 12 months and the Total.
  it('T12 is the last twelve complete months, one column each, as the Trailing 12 Months period', () => {
    const c = open('pnl-t12');
    expect([c.report, c.preset, c.from, c.to, c.cols]).toEqual(['pnl', 't12m', '2025-10-01', '2026-09-30', 'month']);
    // Memorized, it keeps moving: opened a month later it is Nov through Oct.
    const later = resolveConfig({ report: 'pnl', preset: 't12m', cols: 'month' }, new Date(2026, 10, 3));
    expect([later.from, later.to]).toEqual(['2025-11-01', '2026-10-31']);
  });

  it('gives T12 thirteen columns - every month, a quiet one too, and the Total', async () => {
    const rows = [
      { account_no: '41000', title: 'Rent', section: 'revenue', bucket: '2025-10-01', debit: 0, credit: 100 },
      { account_no: '41000', title: 'Rent', section: 'revenue', bucket: '2026-09-01', debit: 0, credit: 100 },
    ];
    const api = { getAccountingBuckets: async () => ({ rows, labels: {} }) };
    const r = await runReport(api, open('pnl-t12'));
    expect(r.columns).toHaveLength(13);
    expect(r.columns.at(-1).label).toBe('Total');
    expect(monthKeys('2025-10-01', '2026-09-30')).toHaveLength(12);
  });

  it('opens the Trial Balance on Accrual and offers Cash and both books (CR-06)', () => {
    const keys = bookOptions({ report: 'trial-balance' }).map((b) => b.key);
    expect(keys).toEqual(expect.arrayContaining(['accrual', 'cash', 'both']));
    expect(TRIAL_BALANCE_DEFAULT_BOOK).toBe('accrual');
    expect(resolveConfig({ report: 'trial-balance', book: 'cash' }, now).book).toBe('cash');
    expect(resolveConfig({ report: 'trial-balance', book: 'both' }, now).book).toBe('both');
  });

  it('YTD vs. Prior Year and This Month vs. Last Month set their comparison', () => {
    const ytd = open('pnl-ytd-py');
    expect([ytd.preset, ytd.from, ytd.to, ytd.cols]).toEqual(['ytd', '2026-01-01', '2026-10-22', 'prior_year']);
    const mom = open('pnl-mom');
    expect([mom.preset, mom.from, mom.to, mom.cols]).toEqual(['this-month', '2026-10-01', '2026-10-31', 'prior_period']);
  });

  it('Budget vs. Actual opens YTD or MTD', () => {
    const ytd = open('budget-ytd');
    expect([ytd.report, ytd.from, ytd.to]).toEqual(['budget', '2026-01-01', '2026-10-22']);
    const mtd = open('budget-mtd');
    expect([mtd.report, mtd.from, mtd.to]).toEqual(['budget', '2026-10-01', '2026-10-22']);
  });

  it('knows only its own views', () => {
    expect(viewConfig('nope', now)).toBeNull();
    expect(Object.keys(REPORT_VIEWS)).toEqual(['pnl-t12', 'pnl-ytd-py', 'pnl-mom', 'budget-ytd', 'budget-mtd']);
  });
});
