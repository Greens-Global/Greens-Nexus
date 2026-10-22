import { describe, it, expect } from 'vitest';
import { REPORT_VIEWS, resolveConfig, viewConfig } from './reportModel';

// Oct 22 (Neil and Charmi): the Reports menu's quick views open with the
// period and columns already set, "so she doesn't have to refilter".
const now = new Date(2026, 9, 22); // 10/22/2026
const open = (key) => resolveConfig({ ...viewConfig(key, now) }, now);

describe('report quick views', () => {
  it('T12 is the last twelve complete months, one column each', () => {
    const c = open('pnl-t12');
    expect([c.report, c.preset, c.from, c.to, c.cols]).toEqual(['pnl', 'custom', '2025-10-01', '2026-09-30', 'month']);
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
