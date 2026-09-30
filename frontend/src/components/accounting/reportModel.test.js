import { describe, it, expect, vi } from 'vitest';
import {
  MAX_DIM_COLUMNS, activeColumns, balanceAsOf, columnModes, csvRows, defaultConfig, isHistorical, presetRange, iso, resolveConfig, runReport, stepAsOf, stepRange, withAdjustments,
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

  it('leaves the accounts with nothing in them off unless asked to show them', async () => {
    const shown = async (showZero) => (await runReport(fakeApi({ pnl: full }), resolveConfig({ ...defaultConfig(NOW), showZero }, NOW))).rows.filter((x) => x.kind === 'account').map((x) => x.code);
    expect(await shown(true)).toContain('41100');
    expect(await shown(false)).not.toContain('41100');
    // A view memorized with the old flag still hides them.
    expect(resolveConfig({ suppressZero: true }, NOW).showZero).toBe(false);
    expect(resolveConfig({ suppressZero: true }, NOW).suppressZero).toBeUndefined();
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

  // What each account did, month by month, since the books began.
  const history = [
    line('11000', 'Operating Cash', 'asset', '2025-11-01', 5000, 0), line('11000', 'Operating Cash', 'asset', '2026-01-01', 0, 400),
    line('11000', 'Operating Cash', 'asset', '2026-02-01', 800, 300), line('11000', 'Operating Cash', 'asset', '2026-05-01', 400, 0),
    line('11000', 'Operating Cash', 'asset', '2026-09-01', 0, 200),
    line('12000', 'Deposit Paid', 'asset', '2026-01-01', 400, 0), line('12000', 'Deposit Paid', 'asset', '2026-05-01', 0, 400),   // back to nothing in May
    line('21000', 'Accounts Payable', 'liability', '2026-03-01', 0, 250),
    line('31000', 'Members Capital', 'equity', '2025-11-01', 0, 4000),
    line('39000', 'Retained Earnings', 'equity', '2025-12-01', 0, 100),
    line('41000', 'Rental Income', 'revenue', '2025-11-01', 0, 1000), line('41000', 'Rental Income', 'revenue', '2026-02-01', 0, 500),
    line('41000', 'Rental Income', 'revenue', '2026-09-01', 0, 50),
    line('61000', 'Repairs', 'expense', '2025-12-01', 100, 0), line('61000', 'Repairs', 'expense', '2026-03-01', 250, 0),
    line('61000', 'Repairs', 'expense', '2026-09-01', 250, 0),
  ];

  it('a balance sheet on a date, worked out from the months: it balances, and carries the earnings the way the ledger does', () => {
    const at = (asof) => Object.fromEntries(balanceAsOf(history, asof).map((s) => [s.key, s.accounts.map((a) => [a.account_no || a.title, a.amount])]));
    // 12/31/2025: the year's profit (1,000 - 100) is this year's earnings; nothing from before.
    expect(at('2025-12-31')).toEqual({
      asset: [['11000', 5000]], liability: [],
      equity: [['31000', 4000], ['39000', 100], ['Current year earnings (2025)', 900]],
    });
    // 03/31/2026: 2025's profit has moved onto Retained Earnings; 2026 earned 500 and spent 250.
    expect(at('2026-03-31')).toEqual({
      asset: [['11000', 5100], ['12000', 400]], liability: [['21000', 250]],
      equity: [['31000', 4000], ['39000', 1000], ['Current year earnings (2026)', 250]],
    });
    // 06/30/2026: the deposit is back to nothing and leaves the statement.
    expect(at('2026-06-30').asset).toEqual([['11000', 5500]]);
    ['2025-11-30', '2025-12-31', '2026-01-31', '2026-03-31', '2026-06-30', '2026-09-28'].forEach((d) => {
      const sum = (key) => balanceAsOf(history, d).find((s) => s.key === key).accounts.reduce((t, a) => t + a.amount, 0);
      expect([d, sum('asset')]).toEqual([d, sum('liability') + sum('equity')]);
    });
  });

  it('a ledger with no Retained Earnings account gets a line for the earlier years', () => {
    const rows = history.filter((r) => r.account_no !== '39000');
    expect(balanceAsOf(rows, '2026-03-31').find((s) => s.key === 'equity').accounts.map((a) => [a.title, a.amount]))
      .toEqual([['Members Capital', 4000], ['Retained earnings (prior years)', 900], ['Current year earnings (2026)', 250]]);
  });

  // The accounting service, answering from the same history: everything up to
  // a date as one total per account, or the months of a range.
  const ledger = ({ from, to, by }) => {
    const inRange = history.filter((r) => (!from || r.bucket >= `${from.slice(0, 7)}-01`) && r.bucket <= to);
    if (by === 'month') return { org: 'Greens Global', generated_at: '2026-09-28', labels: {}, rows: inRange };
    const sums = new Map();
    inRange.forEach((r) => {
      const cur = sums.get(r.account_no) || { ...r, bucket: '', debit: 0, credit: 0 };
      sums.set(r.account_no, { ...cur, debit: cur.debit + r.debit, credit: cur.credit + r.credit });
    });
    return { org: 'Greens Global', generated_at: '2026-09-28', labels: {}, rows: [...sums.values()] };
  };

  it('a balance sheet over the last quarter-ends is two reads: where it stood, and the months since', async () => {
    const api = fakeApi({ buckets: ledger });
    const r = await runReport(api, resolveConfig({ report: 'balance-sheet', cols: 'quarter', entities: ['15000'], dims: { vendor: ['V1'] } }, NOW));
    expect(api.getAccountingBalanceSheet).not.toHaveBeenCalled();
    // The oldest date is 12/31/2025: everything to the end of 2024, then 2025 and 2026 by month.
    expect(api.getAccountingBuckets.mock.calls.map(([q]) => [q.from, q.to, q.by])).toEqual([[undefined, '2024-12-31', 'total'], ['2025-01-01', '2026-09-28', 'month']]);
    // The entity and the filters of the report go with both.
    api.getAccountingBuckets.mock.calls.forEach(([q]) => {
      expect([q.location, q.book, q.dims.vendor, q.dims.locations]).toEqual(['15000', 'accrual', ['V1'], undefined]);
    });
    expect(r.columns.map((c) => c.label)).toEqual(['09/28/2026', '06/30/2026', '03/31/2026', '12/31/2025']);
    expect(r.columns[1].drill).toEqual({ from: '', to: '2026-06-30', book: 'accrual' });
    // Dates are not added together.
    expect(r.columns.some((c) => c.key === 'total')).toBe(false);
    const row = (code) => r.rows.find((x) => x.code === code || x.title === code || x.label === code).values;
    expect(row('11000')).toEqual([5300, 5500, 5100, 5000]);
    expect(row('12000')).toEqual([0, 0, 400, 0]);
    expect(row('39000')).toEqual([1000, 1000, 1000, 100]);
    expect(row('Current year earnings (2026)')).toEqual([50, 250, 250, 0]);
    expect(row('Current year earnings (2025)')).toEqual([0, 0, 0, 900]);
    expect(row('Assets')).toEqual(row('Total Liabilities and Equity'));
    expect(r.rows.some((x) => x.kind === 'warn')).toBe(false);
  });

  it('twelve month-ends are still two reads, and what stood before the first of them is carried in', async () => {
    const api = fakeApi({ buckets: ledger });
    // As of 03/31/2027 the twelve month-ends start at 04/30/2026: 2025 arrives as the opening balance.
    const r = await runReport(api, resolveConfig({ report: 'balance-sheet', cols: 'month', asof: '2027-03-31', asofToday: false }, NOW));
    expect(api.getAccountingBuckets.mock.calls.map(([q]) => [q.from, q.to, q.by])).toEqual([[undefined, '2025-12-31', 'total'], ['2026-01-01', '2027-03-31', 'month']]);
    expect(r.columns).toHaveLength(12);
    expect(r.columns.map((c) => c.label).slice(0, 3)).toEqual(['03/31/2027', '02/28/2027', '01/31/2027']);
    const row = (code) => r.rows.find((x) => x.code === code || x.title === code || x.label === code).values;
    // 2026 closed with 50 earned; in 2027 that sits on Retained Earnings with the 900 of 2025.
    expect(row('39000').slice(0, 4)).toEqual([1050, 1050, 1050, 1000]);
    expect(row('Current year earnings (2026)').slice(2, 5)).toEqual([0, 50, 50]);
    expect(row('11000').at(-1)).toBe(5100);      // 04/30/2026
    expect(row('Assets')).toEqual(row('Total Liabilities and Equity'));
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

describe('general ledger', () => {
  const tb = { org: 'Greens Global', generated_at: '2026-09-28', totals: { opening: 0, debit: 1300, credit: 1000, closing: 300 }, rows: [
    { account_no: '11341', title: 'Chase Checking', opening: 100, debit: 1300, credit: 0, closing: 1400 },
    { account_no: '41101', title: 'Rental Income', opening: 0, debit: 0, credit: 1000, closing: -1000 },
    { account_no: '61101', title: 'Repairs', opening: 0, debit: 0, credit: 0, closing: 0 },
  ] };
  const lines = {
    '11341': [{ line_id: 'a', entry_id: 'e2', entry_no: 'IA-2', entry_date: '2026-08-15', description: 'Rent August', location_name: 'Escondido', debit: 800, credit: 0 },
              { line_id: 'b', entry_id: 'e1', entry_no: 'IA-1', entry_date: '2026-07-15', description: 'Rent July', location_name: 'Escondido', debit: 500, credit: 0 }],
    '41101': [{ line_id: 'c', entry_id: 'e1', entry_no: 'IA-1', entry_date: '2026-07-15', description: 'Rent July', location_name: 'Escondido', debit: 0, credit: 1000 }],
  };
  const api = () => ({
    getAccountingTrialBalance: vi.fn(async () => tb),
    searchAccountingLedger: vi.fn(async ({ account }) => ({ rows: lines[account] || [], total: (lines[account] || []).length })),
  });

  it('lists each account with its opening balance, its lines oldest first with a running balance, and its closing', async () => {
    const a = api();
    const r = await runReport(a, resolveConfig({ ...defaultConfig(NOW), report: 'general-ledger', entities: ['15000'] }, NOW));
    expect(r.columns.map((c) => `${c.key}:${c.type}`)).toEqual(['entry:text', 'description:text', 'entity:text', 'debit:amount', 'credit:amount', 'balance:amount']);
    // The account with nothing in it is left off (zero balances hidden by default).
    expect(r.rows.filter((x) => x.kind === 'section').map((x) => x.label)).toEqual(['11341 Chase Checking', '41101 Rental Income']);
    const chase = r.rows.slice(0, 4);
    expect(chase.map((x) => [x.kind, x.label, ...x.values.slice(3)])).toEqual([
      ['section', '11341 Chase Checking', 1300, 0, 100],
      ['line', '07/15/2026', 500, 0, 600],
      ['line', '08/15/2026', 800, 0, 1400],
      ['subtotal', 'Closing balance', 1300, 0, 1400],
    ]);
    expect(chase[1].values.slice(0, 3)).toEqual(['IA-1', 'Rent July', 'Escondido']);
    expect(r.rows.at(-1)).toMatchObject({ kind: 'grand', values: ['', '', '', 1300, 1000, 300] });
    // The lines were asked for per account, within the entity and period, oldest first on screen.
    expect(a.searchAccountingLedger.mock.calls.map((c) => c[0].account)).toEqual(['11341', '41101']);
    expect(a.searchAccountingLedger.mock.calls[0][0]).toMatchObject({ location: '15000', from: '2026-01-01', to: '2026-09-28', book: 'accrual' });
    expect(r.pickable.map((p) => p.code)).toEqual(['11341', '41101', '61101']);
    expect(r.summary.map((f) => [f.label, f.value])).toEqual([['Debits', '1,300.00'], ['Credits', '1,000.00'], ['Lines', '3']]);
  });

  it('lists the accounts only when too many are open at once', async () => {
    const many = { ...tb, rows: Array.from({ length: 30 }, (_x, i) => ({ account_no: String(60000 + i), title: `Account ${i}`, opening: 0, debit: 10, credit: 0, closing: 10 })) };
    const a = { ...api(), getAccountingTrialBalance: vi.fn(async () => many) };
    const r = await runReport(a, resolveConfig({ ...defaultConfig(NOW), report: 'general-ledger' }, NOW));
    expect(a.searchAccountingLedger).not.toHaveBeenCalled();
    expect(r.rows.filter((x) => x.kind === 'section')).toHaveLength(30);
    expect(r.notes[0]).toMatch(/30 accounts have activity/);
    // Picking accounts opens them.
    const r2 = await runReport(api(), resolveConfig({ ...defaultConfig(NOW), report: 'general-ledger', accounts: ['41101'] }, NOW));
    expect(r2.rows.filter((x) => x.kind === 'section').map((x) => x.label)).toEqual(['41101 Rental Income']);
  });
});

describe('adjustments on a package statement', () => {
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
  it('moves the line, its section total and every subtotal, and prints the note', async () => {
    const r = await runReport(fakeApi({ pnl: full }), resolveConfig(defaultConfig(NOW), NOW));
    const adjusted = withAdjustments(r, [{ account: '61000', amount: -100000, note: 'Gate at Valley Center - capital, not repairs' }, { account: '41000', amount: 0, note: 'Includes September true-up' }]);
    expect(adjusted.columns.map((c) => `${c.key}:${c.type}`)).toEqual(['reported:amount', 'adjustment:variance', 'adjusted:amount', 'note:text']);
    const row = (label) => adjusted.rows.find((x) => x.label === label || x.code === label);
    expect(row('61000').values).toEqual([300, -100000, -99700, 'Gate at Valley Center - capital, not repairs']);
    expect(row('41000').values.slice(1)).toEqual([0, 1000, 'Includes September true-up']);
    expect(row('Operating Income').values.slice(0, 3)).toEqual([500, 100000, 100500]);
    expect(row('Net Income').values.slice(0, 3)).toEqual([400, 100000, 100400]);
    expect(adjusted.rows.find((x) => x.kind === 'section' && x.section === 'expense').values.slice(0, 3)).toEqual([300, -100000, -99700]);
    // The margin is recomputed from the adjusted net over the same income.
    expect(row('Net Profit Margin %').values[2]).toBeCloseTo(100400 / 1050, 4);
  });

  it('adds the notes only on a layout with more than one figure column', async () => {
    const r = await runReport(fakeApi({ pnl: full }), resolveConfig({ ...defaultConfig(NOW), cols: 'prior_year' }, NOW));
    const adjusted = withAdjustments(r, [{ account: '61000', amount: -5, note: 'Note' }]);
    expect(adjusted.columns.at(-1)).toMatchObject({ key: 'note', type: 'text' });
    expect(adjusted.columns).toHaveLength(r.columns.length + 1);
    expect(adjusted.rows.find((x) => x.code === '61000').values.at(-1)).toBe('Note');
    expect(withAdjustments(r, [])).toBe(r);
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
