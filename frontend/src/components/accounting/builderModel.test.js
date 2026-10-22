import { describe, it, expect, vi } from 'vitest';
import {
  BUILDER_KIND, BUILDER_VERSION, defaultBuilder, exportConfig, includedAccounts, isBuilderConfig, isPublished, layoutBuilder, resolveBuilder, runBuilder, storableBuilder,
} from './builderModel';
import { csvRows, resolveConfig } from './reportModel';

// Oct 23 (Neil, items 05 / 11): the Report Builder - GL accounts, dimensions,
// a period, and named row groups mapped to accounts (Charmi builds a
// Schedule C herself; no Schedule C lines live in code).

const NOW = new Date(2026, 9, 23);
const cols1 = [{ key: 'cur', label: '01/01/2026 - 10/23/2026' }];
const acct = (code, title, v, section = 'expense') => ({ code, title, section, values: Array.isArray(v) ? v : [v] });
const ACCOUNTS = [
  acct('40100', 'Rent Income', 9000, 'revenue'),
  acct('61000', 'Advertising', 1200),
  acct('61010', 'Online Ads', 300),
  acct('62000', 'Car and Truck', 450),
  acct('63000', 'Office Supplies', 0),
];

describe('layoutBuilder', () => {
  it('totals each row group with its accounts under it, lists the rest one by one, and adds a grand total', () => {
    const config = resolveBuilder({
      accounts: ['40100'],
      groups: [{ name: 'Line A', accounts: ['61000', '61010'] }, { name: 'Line B', accounts: ['62000'] }],
    }, NOW);
    const { columns, rows } = layoutBuilder(config, cols1, ACCOUNTS);
    expect(columns.map((c) => c.label)).toEqual(['01/01/2026 - 10/23/2026']);
    expect(rows.map((r) => [r.kind, r.label || r.code, r.values[0]])).toEqual([
      ['section', 'Line A', 1500],
      ['account', '61000', 1200],
      ['account', '61010', 300],
      ['section', 'Line B', 450],
      ['account', '62000', 450],
      ['group', 'Accounts Not in a Group', ''],
      ['account', '40100', 9000],
      ['grand', 'Grand Total', 10950],
    ]);
    // A grouped account is under its group; an ungrouped one under none.
    expect(rows[1].section).toBe('grp-0');
    expect(rows[6].section).toBeUndefined();
  });

  it('runs flat with no groups: every account with activity, zero ones hidden unless asked for', () => {
    const flat = layoutBuilder(resolveBuilder({}, NOW), cols1, ACCOUNTS);
    expect(flat.rows.filter((r) => r.kind === 'account').map((r) => r.code)).toEqual(['40100', '61000', '61010', '62000']);
    expect(flat.rows.some((r) => r.kind === 'group' || r.kind === 'section')).toBe(false);
    expect(flat.rows.at(-1).values).toEqual([10950]);
    const zeros = layoutBuilder(resolveBuilder({ showZero: true }, NOW), cols1, ACCOUNTS);
    expect(zeros.rows.filter((r) => r.kind === 'account').map((r) => r.code)).toContain('63000');
  });

  it('lists only the picked and grouped accounts once anything is picked, and keeps an empty group at zero', () => {
    const config = resolveBuilder({ groups: [{ name: 'Line A', accounts: ['61000'] }, { name: 'Line C', accounts: ['69999'] }] }, NOW);
    const { rows } = layoutBuilder(config, cols1, ACCOUNTS, { 69999: 'Unused Account' });
    expect(rows.map((r) => [r.kind, r.label || r.code, r.values[0]])).toEqual([
      ['section', 'Line A', 1200], ['account', '61000', 1200], ['section', 'Line C', 0], ['grand', 'Grand Total', 1200],
    ]);
  });

  it('adds a Total column beside two or more data columns', () => {
    const cols = [{ key: '2026-10-01', label: 'Oct 2026' }, { key: '2026-09-01', label: 'Sep 2026' }];
    const config = resolveBuilder({ cols: 'month', groups: [{ name: 'Line A', accounts: ['61000', '61010'] }] }, NOW);
    const { columns, rows } = layoutBuilder(config, cols, [acct('61000', 'Advertising', [100, 200]), acct('61010', 'Online Ads', [10, 0])]);
    expect(columns.map((c) => c.label)).toEqual(['Oct 2026', 'Sep 2026', 'Total']);
    expect(rows[0].values).toEqual([110, 200, 310]);
    expect(rows.at(-1).values).toEqual([110, 200, 310]);
  });
});

describe('builder configs', () => {
  it('round-trips a definition through save and open', () => {
    const made = resolveBuilder({
      period: 'range', preset: 'custom', from: '2026-01-01', to: '2026-06-30', book: 'cash', cols: 'quarter',
      entities: ['12000'], dims: { departments: ['D10'], vendor: ['V1'] }, accounts: ['40100'],
      groups: [{ name: 'Line A', accounts: ['61000', '61010'] }], showZero: true,
    }, NOW);
    const saved = JSON.parse(JSON.stringify(storableBuilder(made)));
    expect(saved).toMatchObject({ kind: BUILDER_KIND, version: BUILDER_VERSION, preset: 'custom', from: '2026-01-01', to: '2026-06-30', book: 'cash', cols: 'quarter', showZero: true });
    expect(saved.groups).toEqual([{ name: 'Line A', accounts: ['61000', '61010'] }]);
    expect(resolveBuilder(saved, NOW)).toEqual(made);
    expect(isBuilderConfig(saved)).toBe(true);
    expect(includedAccounts(made)).toEqual(['40100', '61000', '61010']);
  });

  it('keeps a named period moving with the calendar and puts an account in one group only', () => {
    const c = resolveBuilder({ preset: 'ytd', groups: [{ name: 'A', accounts: ['1', '2'] }, { name: 'B', accounts: ['2', '3'] }] }, NOW);
    expect([c.from, c.to]).toEqual(['2026-01-01', '2026-10-23']);
    expect(c.groups.map((g) => g.accounts)).toEqual([['1', '2'], ['3']]);
    expect(storableBuilder(c)).not.toHaveProperty('from');
    // As of a date has one column only.
    expect(resolveBuilder({ period: 'asof', cols: 'month' }, NOW).cols).toBe('total');
  });

  it('leaves the existing memorized statements alone', () => {
    const old = { report: 'pnl', preset: 'ytd', book: 'accrual', cols: 'month', entities: ['12000'], dims: { departments: ['D10'] } };
    expect(isBuilderConfig(old)).toBe(false);
    expect(isBuilderConfig(null)).toBe(false);
    const c = resolveConfig(old, NOW);
    expect([c.report, c.cols, c.entities]).toEqual(['pnl', 'month', ['12000']]);
    expect(defaultBuilder(NOW).kind).toBe('builder');
  });

  it('exports like a statement: title, entities, period and book line from a statement-shaped config', async () => {
    const api = { getAccountingBuckets: vi.fn(async () => ({ org: 'Greens Global', rows: [{ account_no: '61000', title: 'Advertising', section: 'expense', bucket: 'total', debit: 500, credit: 50 }] })) };
    const r = await runBuilder(api, resolveBuilder({ groups: [{ name: 'Line A', accounts: ['61000'] }] }, NOW), { name: 'My Report' });
    expect(r.def.label).toBe('My Report');
    const csv = csvRows(r, []);
    expect(csv[0][0]).toBe('My Report (Accrual Book)');
    expect(csv.some((line) => line[0] === 'Total Line A' && line.at(-1) === 450)).toBe(true);
    expect(exportConfig(r.builder).accounts).toEqual(['61000']);
  });
});

// CR-05 (Neil, 23 Oct): "Yes it needs comparison columns."
describe('comparison columns', () => {
  it('adds the prior figure, Variance $ and Variance % per comparison, against the Total', () => {
    const config = resolveBuilder({ cols: 'month', compare: ['prior_year', 'prior_period', 'nonsense'] }, NOW);
    expect(config.compare).toEqual(['prior_period', 'prior_year']);
    const cols = [{ key: 'm1', label: 'Sep 2026' }, { key: 'm2', label: 'Oct 2026' }];
    // values: 2 months, then prior period, then prior year
    const { columns, rows } = layoutBuilder(config, cols, [acct('61000', 'Advertising', [100, 200, 150, 400]), acct('61010', 'Online Ads', [0, 0, 50, 0])], {},
      [{ key: 'prior_period', label: 'Jul - Aug', short: 'Prior Period' }, { key: 'prior_year', label: 'Sep - Oct 2025', short: 'Prior Year' }]);
    expect(columns.map((c) => c.label)).toEqual(['Sep 2026', 'Oct 2026', 'Total', 'Jul - Aug', 'Variance $ vs Prior Period', 'Variance % vs Prior Period',
      'Sep - Oct 2025', 'Variance $ vs Prior Year', 'Variance % vs Prior Year']);
    expect(columns.filter((c) => c.compare).map((c) => c.key)).toEqual(['cmp-prior_period', 'cmp-prior_year']);
    expect(rows.find((r) => r.code === '61000').values).toEqual([100, 200, 300, 150, 150, '100.0%', 400, -100, '(25.0%)']);
    // An account with only a prior figure still shows; the prior total adds it in.
    expect(rows.find((r) => r.code === '61010').values).toEqual([0, 0, 0, 50, -50, '(100.0%)', 0, 0, '']);
    expect(rows.at(-1).values).toEqual([100, 200, 300, 200, 100, '50.0%', 400, -100, '(25.0%)']);
  });

  it('keeps a report saved before comparisons existed exactly as it was', () => {
    const old = { kind: 'builder', version: 1, preset: 'ytd', accounts: ['61000'] };
    const c = resolveBuilder(old, NOW);
    expect(c.compare).toEqual([]);
    expect(storableBuilder(c)).not.toHaveProperty('compare');
    expect(layoutBuilder(c, cols1, ACCOUNTS).columns.map((x) => x.label)).toEqual(['01/01/2026 - 10/23/2026']);
    expect(storableBuilder(resolveBuilder({ compare: ['prior_year'] }, NOW)).compare).toEqual(['prior_year']);
  });

  it('reads the prior period and the prior year, and as of a date the prior month-end and the date a year back', async () => {
    const api = { getAccountingBuckets: vi.fn(async () => ({ rows: [{ account_no: '61000', title: 'Advertising', section: 'expense', bucket: 'total', debit: 100, credit: 0 }] })) };
    const r = await runBuilder(api, resolveBuilder({ preset: 'custom', from: '2026-07-01', to: '2026-09-30', compare: ['prior_period', 'prior_year'] }, NOW));
    expect(api.getAccountingBuckets.mock.calls.map((c) => `${c[0].from}..${c[0].to}`).sort()).toEqual(['2025-07-01..2025-09-30', '2026-04-01..2026-06-30', '2026-07-01..2026-09-30']);
    expect(r.rows.find((x) => x.code === '61000').values).toEqual([100, 100, 0, '0.0%', 100, 0, '0.0%']);
    api.getAccountingBuckets.mockClear();
    await runBuilder(api, resolveBuilder({ period: 'asof', asof: '2026-06-30', asofToday: false, compare: ['prior_period', 'prior_year'] }, NOW));
    expect([...new Set(api.getAccountingBuckets.mock.calls.map((c) => c[0].to))].sort()).toEqual(['2024-12-31', '2025-06-30', '2025-12-31', '2026-05-31', '2026-06-30']);
  });

  it('marks a report published once Publish was used, or shared before Publish existed', () => {
    expect(isPublished({ config: { kind: 'builder', published: true }, shared: false })).toBe(true);
    expect(isPublished({ config: { kind: 'builder' }, shared: true })).toBe(true);
    expect(isPublished({ config: { kind: 'builder' }, shared: false })).toBe(false);
  });
});

describe('runBuilder', () => {
  it('reads the buckets with the entity and dimension filters, by month, in normal balance', async () => {
    const api = {
      getAccountingBuckets: vi.fn(async () => ({
        org: 'Greens Global', generated_at: '2026-10-23T10:00:00Z', labels: {},
        rows: [
          { account_no: '40100', title: 'Rent Income', section: 'revenue', bucket: '2026-09-01', debit: 0, credit: 1000 },
          { account_no: '40100', title: 'Rent Income', section: 'revenue', bucket: '2026-10-01', debit: 100, credit: 1100 },
          { account_no: '61000', title: 'Advertising', section: 'expense', bucket: '2026-10-01', debit: 250, credit: 0 },
        ],
      })),
    };
    const config = resolveBuilder({ preset: 'custom', from: '2026-09-01', to: '2026-10-31', cols: 'month', entities: ['12000'], dims: { departments: ['D10'] } }, NOW);
    const r = await runBuilder(api, config);
    const call = api.getAccountingBuckets.mock.calls[0][0];
    expect(call).toMatchObject({ from: '2026-09-01', to: '2026-10-31', by: 'month', book: 'accrual', location: '12000' });
    expect(call.dims.departments).toEqual(['D10']);
    expect(r.columns.map((c) => c.label)).toEqual(['Oct 2026', 'Sep 2026', 'Total']);
    const rent = r.rows.find((x) => x.code === '40100');
    expect(rent.values).toEqual([1000, 1000, 2000]);
    expect(r.rows.at(-1).values).toEqual([1250, 1000, 2250]);
  });

  it('as of a date: balance sheet accounts to the date, income and expense for the year', async () => {
    const api = {
      getAccountingBuckets: vi.fn(async ({ to }) => (to === '2026-06-30'
        ? { rows: [
          { account_no: '11000', title: 'Checking', section: 'asset', bucket: 'total', debit: 5000, credit: 1000 },
          { account_no: '61000', title: 'Advertising', section: 'expense', bucket: 'total', debit: 900, credit: 0 },
        ] }
        : { rows: [{ account_no: '61000', title: 'Advertising', section: 'expense', bucket: 'total', debit: 600, credit: 0 }] })),
    };
    const r = await runBuilder(api, resolveBuilder({ period: 'asof', asof: '2026-06-30', asofToday: false }, NOW));
    expect(api.getAccountingBuckets.mock.calls.map((c) => c[0].to).sort()).toEqual(['2025-12-31', '2026-06-30']);
    expect(r.columns.map((c) => c.label)).toEqual(['As of 06/30/2026']);
    expect(r.rows.find((x) => x.code === '11000').values).toEqual([4000]);
    expect(r.rows.find((x) => x.code === '61000').values).toEqual([300]);
  });
});
