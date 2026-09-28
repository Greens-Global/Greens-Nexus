import { describe, it, expect, vi } from 'vitest';
import { activeCompare, csvRows, defaultConfig, isHistorical, presetRange, iso, resolveConfig, runReport } from './reportModel';

// The logic behind Accounting -> Reports (Neil and Charmi, Sep 25): what a
// memorized report means when it is opened later, how one or several entities
// travel to the ledger, and how two statements (a comparison, or the accrual
// and the cash book) become one table whose every column adds up.

const NOW = new Date(2026, 8, 28);   // 09/28/2026

const stmt = (accounts, totals = {}) => ({
  org: 'Greens Global', generated_at: '2026-09-28',
  sections: [{ key: 'revenue', label: 'Revenue', total: accounts.reduce((s, a) => s + a.amount, 0), accounts }],
  totals: { gross_profit: 0, operating_income: 0, net_income: accounts.reduce((s, a) => s + a.amount, 0), ...totals },
});

function fakeApi(answers = {}) {
  return {
    getAccountingPnl: vi.fn(async (from, to, location, dims, book) => (answers.pnl ? answers.pnl({ from, to, location, dims, book }) : stmt([]))),
    getAccountingBalanceSheet: vi.fn(async () => ({ sections: [], totals: { liabilities_and_equity: 0, difference: 0 } })),
    getAccountingTrialBalance: vi.fn(async (from, to, location, dims, book) => (answers.tb ? answers.tb({ book }) : { rows: [], totals: { opening: 0, debit: 0, credit: 0, closing: 0 } })),
    getAccountingCashPosition: vi.fn(async () => ({ accounts: [{ gl_code: '10100', account_name: 'Operating', balance: 12.5, last_activity: '2026-09-20' }], total: 12.5 })),
  };
}

describe('periods', () => {
  it('names the ranges the way the dropdown reads', () => {
    expect(presetRange('month', NOW).map(iso)).toEqual(['2026-09-01', '2026-09-28']);
    expect(presetRange('last-month', NOW).map(iso)).toEqual(['2026-08-01', '2026-08-31']);
    expect(presetRange('quarter', NOW).map(iso)).toEqual(['2026-07-01', '2026-09-28']);
    expect(presetRange('last-quarter', NOW).map(iso)).toEqual(['2026-04-01', '2026-06-30']);
    expect(presetRange('ytd', NOW).map(iso)).toEqual(['2026-01-01', '2026-09-28']);
    expect(presetRange('last-year', NOW).map(iso)).toEqual(['2025-01-01', '2025-12-31']);
  });

  it('a memorized named period moves with the calendar, custom dates stay', () => {
    const saved = { report: 'pnl', preset: 'ytd', from: '2026-01-01', to: '2026-09-25', book: 'cash', entities: ['15000'] };
    const later = resolveConfig(saved, new Date(2026, 9, 14));
    expect([later.from, later.to]).toEqual(['2026-01-01', '2026-10-14']);
    expect(later.book).toBe('cash');
    expect(later.entities).toEqual(['15000']);
    const custom = resolveConfig({ report: 'pnl', preset: 'custom', from: '2026-08-01', to: '2026-08-31' }, new Date(2026, 9, 14));
    expect([custom.preset, custom.from, custom.to]).toEqual(['custom', '2026-08-01', '2026-08-31']);
  });

  it('never keeps a range that ends before it starts, or a setting it does not know', () => {
    const c = resolveConfig({ report: 'nope', preset: 'custom', from: '2026-09-10', to: '2026-09-01', book: 'x', compare: 'y', entities: 'z', dims: { vendor: 'V1' } }, NOW);
    expect(c.report).toBe('pnl');
    expect(c.to).toBe('2026-09-10');
    expect([c.book, c.compare]).toEqual(['accrual', 'none']);
    expect(c.entities).toEqual([]);
    expect(c.dims.vendor).toEqual([]);
  });
});

describe('what is asked of the ledger', () => {
  it('sends one entity as the location and several as a set', async () => {
    const api = fakeApi();
    await runReport(api, resolveConfig({ ...defaultConfig(NOW), entities: ['15000'] }, NOW));
    expect(api.getAccountingPnl).toHaveBeenLastCalledWith('2026-01-01', '2026-09-28', '15000', null, 'accrual');
    await runReport(api, resolveConfig({ ...defaultConfig(NOW), entities: ['15000', '56000'], dims: { vendor: ['V1'] } }, NOW));
    const [, , location, dims] = api.getAccountingPnl.mock.calls.at(-1);
    expect(location).toBeUndefined();
    expect(dims.locations).toEqual(['15000', '56000']);
    expect(dims.vendor).toEqual(['V1']);
  });

  it('reads both books side by side and leaves the comparison out', async () => {
    const api = fakeApi({ pnl: ({ book }) => stmt(book === 'cash' ? [{ account_no: '41000', title: 'Rental Income', amount: 900 }, { account_no: '41900', title: 'Cash Only', amount: 50 }] : [{ account_no: '41000', title: 'Rental Income', amount: 1000 }]) });
    const cfg = resolveConfig({ ...defaultConfig(NOW), book: 'both', compare: 'prior-year' }, NOW);
    expect(activeCompare(cfg)).toBe('none');
    const r = await runReport(api, cfg);
    expect(r.mode).toBe('books');
    expect(r.columns.map((c) => c.label)).toEqual(['Accrual', 'Cash']);
    expect(r.columns.map((c) => c.drill.book)).toEqual(['accrual', 'cash']);
    const accounts = r.rows.filter((x) => x.kind === 'account').map((x) => [x.code, ...x.values]);
    // The account that exists only in the cash book still has its row.
    expect(accounts).toEqual([['41000', 1000, 900], ['41900', 0, 50]]);
  });

  it('keeps an account that only the comparison period has, so the column adds up', async () => {
    const api = fakeApi({ pnl: ({ from }) => stmt(from === '2026-01-01' ? [{ account_no: '41000', title: 'Rental Income', amount: 1000 }] : [{ account_no: '41000', title: 'Rental Income', amount: 700 }, { account_no: '40500', title: 'Closed Program', amount: 300 }]) });
    const r = await runReport(api, resolveConfig({ ...defaultConfig(NOW), compare: 'prior-year' }, NOW));
    expect(r.mode).toBe('compare');
    expect(api.getAccountingPnl.mock.calls.map((c) => c.slice(0, 2))).toEqual([['2026-01-01', '2026-09-28'], ['2025-01-01', '2025-09-28']]);
    const section = r.rows.find((x) => x.kind === 'section');
    const accounts = r.rows.filter((x) => x.kind === 'account');
    expect(accounts.map((a) => a.code)).toEqual(['40500', '41000']);
    expect(accounts.reduce((s, a) => s + a.values[1], 0)).toBe(section.values[1]);
    expect(accounts[0].values).toEqual([0, 300, -300, '(100.0%)']);
    // The comparison column drills into ITS window.
    expect(r.columns[1].drill).toEqual({ from: '2025-01-01', to: '2025-09-28', book: 'accrual' });
  });

  it('adds the cash closing balance to a trial balance when both books are asked for', async () => {
    const row = (closing) => ({ account_no: '10100', title: 'Operating', type: 'cash_bank', opening: 1, debit: 2, credit: 3, closing });
    const api = fakeApi({ tb: ({ book }) => ({ rows: [row(book === 'cash' ? 9 : 0)], totals: { opening: 1, debit: 2, credit: 3, closing: book === 'cash' ? 9 : 0 } }) });
    const r = await runReport(api, resolveConfig({ ...defaultConfig(NOW), report: 'trial-balance', book: 'both' }, NOW));
    expect(r.columns.map((c) => c.label)).toEqual(['Opening', 'Debit', 'Credit', 'Closing (Accrual)', 'Closing (Cash)']);
    expect(r.rows[0].values).toEqual([1, 2, 3, 0, 9]);
  });

  it('reads the cash position as of a date, several entities at once', async () => {
    const api = fakeApi();
    const r = await runReport(api, resolveConfig({ report: 'cash-position', entities: ['15000', '56000'], book: 'cash' }, NOW));
    expect(api.getAccountingCashPosition).toHaveBeenLastCalledWith('2026-09-28', undefined, ['15000', '56000']);
    expect(r.rows.at(-1).values[0]).toBe(12.5);
    expect(r.rows[0].values).toEqual([12.5, '09/20/2026']);
  });
});

describe('export', () => {
  it('writes each section total under its accounts', async () => {
    const api = fakeApi({ pnl: () => stmt([{ account_no: '41000', title: 'Rental Income', amount: 1000 }, { account_no: '41100', title: 'Parking', amount: 500 }]) });
    const r = await runReport(api, resolveConfig({ ...defaultConfig(NOW), entities: ['15000'] }, NOW));
    const rows = csvRows(r, [{ code: '15000', name: 'Greens Escondido, LLC.' }]);
    expect(rows.slice(0, 4)).toEqual([['Income Statement'], ['Greens Escondido, LLC. (15000)'], [`Year to Date ${String.fromCharCode(0xb7)} 01/01/2026 - 09/28/2026`], ['Book: Accrual']]);
    expect(rows[5]).toEqual(['Section', 'Account', 'Title', 'YTD Actual']);
    expect(rows.slice(6, 10)).toEqual([
      ['Revenue', '41000', 'Rental Income', 1000],
      ['Revenue', '41100', 'Parking', 500],
      ['Total Revenue', '', '', 1500],
      ['Gross Profit', '', '', 0],
    ]);
  });
});

describe('historical classes', () => {
  it('knows the (H) mark', () => {
    expect(isHistorical('Valley Center (H)')).toBe(true);
    expect(isHistorical('Old Program ( h )')).toBe(true);
    expect(isHistorical('Hotel Operations')).toBe(false);
    expect(isHistorical('')).toBe(false);
  });
});
