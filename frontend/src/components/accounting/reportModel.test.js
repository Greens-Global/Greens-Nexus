import { describe, it, expect, vi } from 'vitest';
import {
  MAX_DIM_COLUMNS, activeColumns, columnModes, csvRows, defaultConfig, isHistorical, presetRange, iso, resolveConfig, runReport, stepAsOf, stepRange,
} from './reportModel';

// The logic behind Accounting -> Reports (Neil and Charmi, Sep 25): what a
// memorized report means when it is opened later, how one or several entities
// travel to the ledger, and how several statements (a comparison, the accrual
// and the cash book, a column per month or per entity) become one table whose
// every column adds up.

const NOW = new Date(2026, 8, 28);   // 09/28/2026

const stmt = (accounts, key = 'revenue') => ({
  org: 'Greens Global', generated_at: '2026-09-28',
  sections: [{ key, label: key, total: accounts.reduce((s, a) => s + a.amount, 0), accounts }],
});

function fakeApi(answers = {}) {
  return {
    getAccountingPnl: vi.fn(async (from, to, location, dims, book) => (answers.pnl ? answers.pnl({ from, to, location, dims, book }) : stmt([]))),
    getAccountingBalanceSheet: vi.fn(async (asof, location, dims, book) => (answers.bs ? answers.bs({ asof, location, dims, book }) : { sections: [] })),
    getAccountingTrialBalance: vi.fn(async (from, to, location, dims, book) => (answers.tb ? answers.tb({ book }) : { rows: [], totals: { opening: 0, debit: 0, credit: 0, closing: 0 } })),
    getAccountingCashPosition: vi.fn(async () => ({ accounts: [{ gl_code: '10100', account_name: 'Operating', balance: 12.5, last_activity: '2026-09-20' }], total: 12.5 })),
    getAccountingBuckets: vi.fn(async (q) => (answers.buckets ? answers.buckets(q) : { rows: [], labels: {} })),
  };
}
const line = (account_no, title, section, bucket, debit, credit) => ({ account_no, title, section, bucket, debit, credit });

describe('periods', () => {
  it('names the ranges the way the accounting app does', () => {
    const r = (k) => presetRange(k, NOW).map(iso);
    expect(r('this-month')).toEqual(['2026-09-01', '2026-09-30']);
    expect(r('mtd')).toEqual(['2026-09-01', '2026-09-28']);
    expect(r('last-month')).toEqual(['2026-08-01', '2026-08-31']);
    expect(r('this-quarter')).toEqual(['2026-07-01', '2026-09-30']);
    expect(r('qtd')).toEqual(['2026-07-01', '2026-09-28']);
    expect(r('last-quarter')).toEqual(['2026-04-01', '2026-06-30']);
    expect(r('this-year')).toEqual(['2026-01-01', '2026-12-31']);
    expect(r('ytd')).toEqual(['2026-01-01', '2026-09-28']);
    expect(r('last-year')).toEqual(['2025-01-01', '2025-12-31']);
    expect(r('t12m')).toEqual(['2025-09-29', '2026-09-28']);
  });

  it('steps a month, a quarter or a year at a time', () => {
    expect(stepRange('this-month', '2026-09-01', '2026-09-30', -1)).toEqual(['2026-08-01', '2026-08-31']);
    expect(stepRange('mtd', '2026-09-01', '2026-09-28', -1)).toEqual(['2026-08-01', '2026-08-31']);
    expect(stepRange('this-quarter', '2026-07-01', '2026-09-30', 1)).toEqual(['2026-10-01', '2026-12-31']);
    expect(stepRange('this-year', '2026-01-01', '2026-12-31', -1)).toEqual(['2025-01-01', '2025-12-31']);
    // After a step the period is custom dates; whole months keep stepping as months.
    expect(stepRange('custom', '2026-01-01', '2026-01-31', 1)).toEqual(['2026-02-01', '2026-02-28']);
    expect(stepRange('custom', '2026-04-01', '2026-06-30', -1)).toEqual(['2026-01-01', '2026-03-31']);
    // Anything else slides by its own length.
    expect(stepRange('custom', '2026-09-10', '2026-09-16', 1)).toEqual(['2026-09-17', '2026-09-23']);
    // As of a date: month-end to month-end.
    expect(stepAsOf('2026-09-28', -1)).toBe('2026-08-31');
    expect(stepAsOf('2026-09-28', 1)).toBe('2026-09-30');
    expect(stepAsOf('2026-09-30', 1)).toBe('2026-10-31');
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
    const c = resolveConfig({ report: 'nope', preset: 'custom', from: '2026-09-10', to: '2026-09-01', book: 'x', cols: 'y', entities: 'z', dims: { vendor: 'V1' }, accounts: 'a' }, NOW);
    expect(c.report).toBe('pnl');
    expect(c.to).toBe('2026-09-10');
    expect([c.book, c.cols]).toEqual(['accrual', 'total']);
    expect(c.entities).toEqual([]);
    expect(c.accounts).toEqual([]);
    expect(c.dims.vendor).toEqual([]);
  });

  it('opens a report memorized before Columns existed the way it was saved', () => {
    // "This month" used to stop today, and a comparison was kept as `compare`.
    const old = resolveConfig({ report: 'pnl', preset: 'month', compare: 'prior-year', book: 'accrual' }, NOW);
    expect([old.preset, old.from, old.to, old.cols]).toEqual(['mtd', '2026-09-01', '2026-09-28', 'prior_year']);
    expect(old.compare).toBeUndefined();
    expect(resolveConfig({ report: 'balance-sheet', compare: 'prior-month' }, NOW).cols).toBe('prior_month');
    // A layout the statement does not have falls back to the total.
    expect(resolveConfig({ report: 'balance-sheet', cols: 'vendor' }, NOW).cols).toBe('total');
    expect(columnModes('pnl').map((m) => m.label)).toEqual(['Total Only', 'By Month', 'By Quarter', 'By Year', 'By Entity', 'By Department', 'By Vendor', 'By Customer', 'By Employee', 'By Project-Job', 'By Item', 'vs Prior Period', 'vs Prior Year']);
    expect(columnModes('trial-balance')).toHaveLength(1);
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

  it('reads both books side by side and leaves the columns out', async () => {
    const api = fakeApi({ pnl: ({ book }) => stmt(book === 'cash' ? [{ account_no: '41000', title: 'Rental Income', amount: 900 }, { account_no: '41900', title: 'Cash Only', amount: 50 }] : [{ account_no: '41000', title: 'Rental Income', amount: 1000 }]) });
    const cfg = resolveConfig({ ...defaultConfig(NOW), book: 'both', cols: 'month' }, NOW);
    expect(activeColumns(cfg)).toBe('total');
    const r = await runReport(api, cfg);
    expect(r.mode).toBe('books');
    expect(api.getAccountingBuckets).not.toHaveBeenCalled();
    expect(r.columns.map((c) => c.label)).toEqual(['Accrual', 'Cash']);
    expect(r.columns.map((c) => c.drill.book)).toEqual(['accrual', 'cash']);
    const accounts = r.rows.filter((x) => x.kind === 'account').map((x) => [x.code, ...x.values]);
    // The account that exists only in the cash book still has its row.
    expect(accounts).toEqual([['41000', 1000, 900], ['41900', 0, 50]]);
  });

  it('keeps an account that only the comparison period has, so the column adds up', async () => {
    const api = fakeApi({ pnl: ({ from }) => stmt(from === '2026-01-01' ? [{ account_no: '41000', title: 'Rental Income', amount: 1000 }] : [{ account_no: '41000', title: 'Rental Income', amount: 700 }, { account_no: '40500', title: 'Closed Program', amount: 300 }]) });
    const r = await runReport(api, resolveConfig({ ...defaultConfig(NOW), cols: 'prior_year' }, NOW));
    expect(r.mode).toBe('compare');
    expect(api.getAccountingPnl.mock.calls.map((c) => c.slice(0, 2))).toEqual([['2026-01-01', '2026-09-28'], ['2025-01-01', '2025-09-28']]);
    const section = r.rows.find((x) => x.kind === 'section');
    const accounts = r.rows.filter((x) => x.kind === 'account');
    expect(accounts.map((a) => a.code)).toEqual(['40500', '41000']);
    expect(accounts.reduce((s, a) => s + a.values[1], 0)).toBe(section.values[1]);
    expect(accounts[0].values).toEqual([0, 300, -300, '(100.0%)']);
    // The comparison column drills into ITS window.
    expect(r.columns[1].drill).toEqual({ from: '2025-01-01', to: '2025-09-28', book: 'accrual' });
    expect(r.summary.map((f) => f.label)).toEqual(['Revenue', 'Expenses', 'Net Income', 'Net Margin', 'Net Change']);
  });

  it('states a fall once: the amount and the percentage each in their own parentheses', async () => {
    const api = fakeApi({ pnl: ({ from }) => stmt([{ account_no: '41000', title: 'Rental Income', amount: from === '2026-01-01' ? 700 : 1000 }]) });
    const r = await runReport(api, resolveConfig({ ...defaultConfig(NOW), cols: 'prior_year' }, NOW));
    expect(r.summary.at(-1)).toMatchObject({ label: 'Net Change', value: `(300.00) ${String.fromCharCode(0xb7)} (30.0%)`, tone: 'bad' });
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

describe('the statement itself', () => {
  const full = () => ({
    org: 'Greens Global', generated_at: '2026-09-28',
    sections: [
      { key: 'revenue', accounts: [{ account_no: '41000', title: 'Rental Income', amount: 1000 }, { account_no: '41100', title: 'Parking', amount: 0 }] },
      { key: 'cogs', accounts: [{ account_no: '51000', title: 'Cost of Sales', amount: 200 }] },
      { key: 'expense', accounts: [{ account_no: '61000', title: 'Repairs', amount: 300 }] },
      { key: 'other_income', accounts: [{ account_no: '81000', title: 'Interest Income', amount: 50 }] },
      { key: 'other_expense', accounts: [{ account_no: '91000', title: 'Interest Expense', amount: 150 }] },
    ],
  });

  it('adds up its own totals, the margin and the figures line', async () => {
    const r = await runReport(fakeApi({ pnl: full }), resolveConfig(defaultConfig(NOW), NOW));
    const total = (label) => r.rows.find((x) => x.label === label).values[0];
    expect([total('Gross Profit'), total('Operating Income'), total('Net Income')]).toEqual([800, 500, 400]);
    // Net 400 over income 1,050.
    expect(total('Net Profit Margin %')).toBeCloseTo(0.38095, 4);
    expect(r.summary.map((f) => [f.label, f.value])).toEqual([['Revenue', '1,050.00'], ['Expenses', '650.00'], ['Net Income', '400.00'], ['Net Margin', '38.1%']]);
    expect(r.pickable.map((a) => a.code)).toEqual(['41000', '41100', '51000', '61000', '81000', '91000']);
  });

  it('shows only the accounts picked, and totals only those', async () => {
    const r = await runReport(fakeApi({ pnl: full }), resolveConfig({ ...defaultConfig(NOW), accounts: ['41000', '61000'] }, NOW));
    expect(r.rows.filter((x) => x.kind === 'account').map((x) => x.code)).toEqual(['41000', '61000']);
    expect(r.rows.find((x) => x.label === 'Net Income').values[0]).toBe(700);
    // Every account stays in the picker, so the pick can be widened again.
    expect(r.pickable).toHaveLength(6);
  });

  it('leaves the accounts with nothing in them off when asked to', async () => {
    const shown = async (suppressZero) => (await runReport(fakeApi({ pnl: full }), resolveConfig({ ...defaultConfig(NOW), suppressZero }, NOW))).rows.filter((x) => x.kind === 'account').map((x) => x.code);
    expect(await shown(false)).toContain('41100');
    expect(await shown(true)).not.toContain('41100');
  });
});

describe('columns', () => {
  const months = () => ({
    org: 'Greens Global', generated_at: '2026-09-28', labels: {},
    rows: [
      line('41000', 'Rental Income', 'revenue', '2026-07-01', 0, 1000), line('41000', 'Rental Income', 'revenue', '2026-08-01', 0, 2000),
      line('41000', 'Rental Income', 'revenue', '2026-09-01', 50, 450), line('61000', 'Repairs', 'expense', '2026-08-01', 300, 0),
      line('11000', 'Operating Cash', 'asset', '2026-08-01', 900, 0),   // not part of an income statement
    ],
  });

  it('by month: the latest month first, a total at the end, each column drilling into its own month', async () => {
    const api = fakeApi({ buckets: months });
    const r = await runReport(api, resolveConfig({ report: 'pnl', preset: 'custom', from: '2026-07-01', to: '2026-09-25', cols: 'month', entities: ['15000'] }, NOW));
    expect(api.getAccountingBuckets).toHaveBeenCalledWith({ from: '2026-07-01', to: '2026-09-25', by: 'month', book: 'accrual', location: '15000', dims: null });
    expect(r.columns.map((c) => c.label)).toEqual(['Sep 2026', 'Aug 2026', 'Jul 2026', 'Total']);
    expect(r.columns[0].drill).toEqual({ from: '2026-09-01', to: '2026-09-25', book: 'accrual' });
    expect(r.columns[1].drill).toEqual({ from: '2026-08-01', to: '2026-08-31', book: 'accrual' });
    expect(r.columns[3].drill).toEqual({ from: '2026-07-01', to: '2026-09-25', book: 'accrual' });
    const row = (code) => r.rows.find((x) => x.code === code).values;
    expect(row('41000')).toEqual([400, 2000, 1000, 3400]);
    expect(row('61000')).toEqual([0, 300, 0, 300]);
    expect(r.rows.some((x) => x.code === '11000')).toBe(false);
    expect(r.rows.find((x) => x.label === 'Net Income').values).toEqual([400, 1700, 1000, 3100]);
    // A margin is a share of its own column, never a sum of shares.
    const margin = r.rows.find((x) => x.kind === 'margin').values;
    expect(margin[1]).toBeCloseTo(0.85, 4);
    expect(margin[3]).toBeCloseTo(3100 / 3400, 4);
    // The figures line reads the Total column.
    expect(r.summary[0]).toMatchObject({ label: 'Revenue', value: '3,400.00' });
    const csv = csvRows(r, []);
    expect(csv[5]).toEqual(['Section', 'Account', 'Title', 'Sep 2026', 'Aug 2026', 'Jul 2026', 'Total']);
    expect(csv.find((x) => x[0] === 'Net Profit Margin %').slice(3)).toEqual([100, 85, 100, 91.2]);
  });

  it('by vendor: names on the columns, the one without a vendor last, each drilling into its vendor', async () => {
    const api = fakeApi({
      buckets: () => ({
        labels: { V2: 'Amazon', V1: 'Zeta Plumbing' },
        rows: [line('61000', 'Repairs', 'expense', 'V1', 100, 0), line('61000', 'Repairs', 'expense', 'V2', 40, 0), line('61000', 'Repairs', 'expense', '', 7, 0)],
      }),
    });
    const r = await runReport(api, resolveConfig({ ...defaultConfig(NOW), cols: 'vendor' }, NOW));
    expect(r.columns.map((c) => c.label)).toEqual(['Amazon', 'Zeta Plumbing', 'No Vendor', 'Total']);
    expect(r.columns[0].drill.party).toEqual({ kind: 'vendor', code: 'V2', name: 'Amazon' });
    // Lines without a vendor cannot be singled out by the line search.
    expect(r.columns[2].drill).toBeNull();
    expect(r.rows.find((x) => x.code === '61000').values).toEqual([40, 100, 7, 147]);
  });

  it('keeps the largest columns and folds the rest into Other, losing nothing', async () => {
    const rows = [];
    for (let i = 1; i <= MAX_DIM_COLUMNS + 10; i += 1) rows.push(line('61000', 'Repairs', 'expense', `V${i}`, i, 0));
    const r = await runReport(fakeApi({ buckets: () => ({ labels: {}, rows }) }), resolveConfig({ ...defaultConfig(NOW), cols: 'vendor' }, NOW));
    expect(r.columns).toHaveLength(MAX_DIM_COLUMNS + 2);
    expect(r.columns.at(-2).label).toBe('Other (10 more)');
    const values = r.rows.find((x) => x.code === '61000').values;
    expect(values.at(-2)).toBe(55);                            // V1 .. V10
    expect(values.at(-1)).toBe(((MAX_DIM_COLUMNS + 10) * (MAX_DIM_COLUMNS + 11)) / 2);
  });

  it('a balance sheet by entity carries each entity\'s earnings into its equity, so every column balances', async () => {
    const all = [
      line('11000', 'Operating Cash', 'asset', '15000', 1500, 0), line('31000', 'Retained Earnings', 'equity', '15000', 0, 500),
      line('41000', 'Rental Income', 'revenue', '15000', 0, 1000),
      line('11000', 'Operating Cash', 'asset', '56000', 300, 0), line('21000', 'Accounts Payable', 'liability', '56000', 0, 100),
      line('41000', 'Rental Income', 'revenue', '56000', 0, 200),
    ];
    const before = [line('41000', 'Rental Income', 'revenue', '15000', 0, 600)];
    const api = fakeApi({ buckets: ({ to }) => ({ labels: { 15000: 'Greens Escondido', 56000: 'MCD Services' }, rows: to === '2025-12-31' ? before : all }) });
    const r = await runReport(api, resolveConfig({ report: 'balance-sheet', cols: 'entity' }, NOW));
    expect(api.getAccountingBuckets.mock.calls.map(([q]) => [q.from, q.to, q.by])).toEqual([[undefined, '2026-09-28', 'entity'], [undefined, '2025-12-31', 'entity']]);
    expect(r.columns.map((c) => c.label)).toEqual(['Greens Escondido', 'MCD Services', 'Total']);
    expect(r.columns[0].drill).toEqual({ from: '', to: '2026-09-28', book: 'accrual', entity: '15000' });
    const row = (title) => r.rows.find((x) => x.title === title || x.label === title).values;
    // The closed years' profit sits on Retained Earnings, this year's on its own line.
    expect(row('Retained Earnings')).toEqual([1100, 0, 1100]);
    expect(row('Current year earnings (2026)')).toEqual([400, 200, 600]);
    expect(row('Assets')).toEqual([1500, 300, 1800]);
    expect(row('Total Liabilities and Equity')).toEqual([1500, 300, 1800]);
    expect(r.rows.some((x) => x.kind === 'warn')).toBe(false);
  });

  it('a balance sheet over the last month-ends asks for each date', async () => {
    const api = fakeApi({ bs: ({ asof }) => ({ org: 'Greens Global', sections: [{ key: 'asset', accounts: [{ account_no: '11000', title: 'Operating Cash', amount: Number(asof.slice(5, 7)) }] }] }) });
    const r = await runReport(api, resolveConfig({ report: 'balance-sheet', cols: 'quarter' }, NOW));
    expect(api.getAccountingBalanceSheet.mock.calls.map((c) => c[0])).toEqual(['2026-09-28', '2026-06-30', '2026-03-31', '2025-12-31']);
    expect(r.columns.map((c) => c.label)).toEqual(['09/28/2026', '06/30/2026', '03/31/2026', '12/31/2025']);
    // Dates are not added together.
    expect(r.columns.some((c) => c.key === 'total')).toBe(false);
    expect(r.rows.find((x) => x.code === '11000').values).toEqual([9, 6, 3, 12]);
  });

  it('compares a balance sheet with the last year-end', async () => {
    const api = fakeApi();
    await runReport(api, resolveConfig({ report: 'balance-sheet', cols: 'year_end' }, NOW));
    expect(api.getAccountingBalanceSheet.mock.calls.map((c) => c[0])).toEqual(['2026-09-28', '2025-12-31']);
  });
});

describe('export', () => {
  it('writes each section total under its accounts', async () => {
    const api = fakeApi({ pnl: () => stmt([{ account_no: '41000', title: 'Rental Income', amount: 1000 }, { account_no: '41100', title: 'Parking', amount: 500 }]) });
    const r = await runReport(api, resolveConfig({ ...defaultConfig(NOW), entities: ['15000'] }, NOW));
    const rows = csvRows(r, [{ code: '15000', name: 'Greens Escondido, LLC.' }]);
    expect(rows.slice(0, 4)).toEqual([['Income Statement'], ['Greens Escondido, LLC. (15000)'], [`Year-to-Date ${String.fromCharCode(0xb7)} 01/01/2026 - 09/28/2026`], ['Book: Accrual']]);
    expect(rows[5]).toEqual(['Section', 'Account', 'Title', 'YTD Actual']);
    expect(rows.slice(6, 10)).toEqual([
      ['Revenue', '41000', 'Rental Income', 1000],
      ['Revenue', '41100', 'Parking', 500],
      ['Total Revenue', '', '', 1500],
      ['Gross Profit', '', '', 1500],
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
