import { describe, it, expect } from 'vitest';
import { breakdown, canDrill, figureText, orderedRows, pctText, PROFIT_COLUMNS, profitTable } from './profitabilityModel';

// Profitability (Oct 15): the cells, the accounts behind a figure, and the
// export table (live totals, except when sub-entity rows would be counted twice).

const col = (key) => PROFIT_COLUMNS.find((c) => c.key === key);
const fig = (o) => ({ revenue: 1050, opex: 300, noi: 750, noiMargin: 71.43, interest: 100, da: 150, netIncome: 500, netMargin: 47.62, debtService: 180, cashFlowAfterDebt: 570, ...o });
const row = {
  code: '15000', name: 'Sunset Plaza', parent: null,
  current: { ...fig(), accounts: {
    revenue: [{ account: '40100', title: 'Rental Income', amount: 1000 }, { account: '48000', title: 'Late Fees', amount: 50 }],
    opex: [{ account: '60100', title: 'Repairs', amount: 300 }],
    interest: [{ account: '62000', title: 'Mortgage Interest', amount: 100 }],
    da: [{ account: '68000', title: 'Depreciation', amount: 150 }],
  } },
  prior: fig({ netIncome: 600 }),
  change: { netIncome: { amount: -100, pct: -16.67 } },
};
const data = { from: '2026-01-01', to: '2026-12-31', priorFrom: '2025-01-01', priorTo: '2025-12-31', rows: [row],
  totals: { current: fig(), prior: fig({ netIncome: 600 }), change: { netIncome: { amount: -100, pct: -16.67 } } } };

describe('profitabilityModel', () => {
  it('prints percents with parentheses for a negative', () => {
    expect(pctText(12.345)).toBe('12.3%');
    expect(pctText(-5)).toBe('(5.0%)');
    expect(pctText(null)).toBe('');
    expect(figureText(col('noiMargin'), null)).toBe('-');
    expect(figureText(col('netIncome'), -1234.5)).toBe('(1,234.50)');
  });

  it('opens a figure into the accounts that add up to it', () => {
    expect(canDrill(col('noiMargin'))).toBe(false);
    expect(canDrill(col('debtService'))).toBe(false);
    const noi = breakdown(row, col('noi'));
    expect(noi.map((l) => [l.account, l.signed])).toEqual([['40100', 1000], ['48000', 50], ['60100', -300]]);
    expect(noi.reduce((t, l) => t + l.signed, 0)).toBe(750);
    const net = breakdown(row, col('netIncome'));
    expect(net.reduce((t, l) => t + l.signed, 0)).toBe(500);
    expect(breakdown(row, col('opex'))[0].signed).toBe(300);
  });

  it('builds the export with the prior-year comparison and live totals', () => {
    const t = profitTable(data, { compareOn: 'netIncome', entityLabel: 'All entities' });
    expect(t.title).toBe('Profitability Sheet');
    expect(t.columns.map((c) => c.label).slice(-3)).toEqual(['Prior Year Net Income', 'Change $', 'Change %']);
    expect(t.rows[0][0]).toBe('Sunset Plaza (15000)');
    expect(t.rows[0].slice(-3)).toEqual([600, -100, '(16.7%)']);
    expect(t.totals[0]).toBe('Total');
    expect(t.subtitle).toContain('01/01/2026 - 12/31/2026');
  });

  it('writes plain totals when sub-entities are on the sheet', () => {
    const nested = { ...data, rows: [row, { ...row, code: '15000-1', name: 'Retail', parent: '15000' }] };
    expect(orderedRows(nested).map((r) => r.depth)).toEqual([0, 1]);
    const t = profitTable(nested);
    expect(t.totals).toBeNull();
    expect(t.rows).toHaveLength(3);
    expect(t.rows[2][0]).toBe('Total');
    expect(t.rows[1][0]).toBe('    Retail (15000-1)');
  });
});
