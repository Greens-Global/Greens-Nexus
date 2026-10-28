import { describe, it, expect, vi } from 'vitest';
import { REPORTS, REPORT_VIEWS, columnModes, csvFileName, csvRows, reportDef, reportTitle, resolveConfig, viewConfig } from './reportModel';
import { standardEntries } from './reportCatalog';
import { filterOptions } from './reportControls';
import { spendLayout, spendPeriods, vendorSpend, SPEND_MAX_COLUMNS } from './vendorSpend';
import { lineFor, mapsOf, scheduleC, scheduleCLayout, suggestLine } from './scheduleC';

// Reports Center, 10/27 chat triage: Income Statement by Customer / Job /
// Department (item 16), Spend by Vendor and the vendor search (item 17),
// Schedule C (Draft) with its line mapping (item 18).

describe('Income Statement by Customer, Job and Department (item 16)', () => {
  it('opens the Income Statement split one column per customer, Project-Job or department', () => {
    const now = new Date(2026, 9, 27);
    expect(viewConfig('pnl-customer', now)).toMatchObject({ report: 'pnl', cols: 'customer', preset: 'ytd', from: '2026-01-01', to: '2026-10-27' });
    expect(viewConfig('pnl-job', now)).toMatchObject({ report: 'pnl', cols: 'project' });
    expect(viewConfig('pnl-department', now)).toMatchObject({ report: 'pnl', cols: 'department' });
    // Each is a layout the Income Statement already offers (columns plus a Total).
    ['customer', 'project', 'department'].forEach((m) => expect(columnModes('pnl').some((x) => x.key === m)).toBe(true));
  });

  it('is titled Income Statement by ..., never Profit & Loss', () => {
    expect(reportTitle(resolveConfig({ report: 'pnl', cols: 'customer' }))).toBe('Income Statement by Customer (Accrual Book)');
    expect(reportTitle(resolveConfig({ report: 'pnl', cols: 'project', book: 'cash' }))).toBe('Income Statement by Job (Cash Book)');
    expect(reportTitle(resolveConfig({ report: 'pnl', cols: 'department' }))).toBe('Income Statement by Department (Accrual Book)');
    expect(reportTitle(resolveConfig({ report: 'pnl', cols: 'month' }))).toBe('Income Statement (Accrual Book)');
    // A memorized report keeps its own name.
    expect(reportTitle(resolveConfig({ report: 'pnl', cols: 'customer' }), 'Tenants YTD')).toBe('Tenants YTD (Accrual Book)');
    // The exports hand in the plain report name; it must not hide "by Customer".
    expect(reportTitle(resolveConfig({ report: 'pnl', cols: 'customer' }), 'Income Statement')).toBe('Income Statement by Customer (Accrual Book)');
    expect(reportTitle(resolveConfig({ report: 'pnl', cols: 'month' }), 'Income Statement')).toBe('Income Statement (Accrual Book)');
    const labels = [...REPORTS.map((r) => r.label), ...Object.keys(REPORT_VIEWS)].join(' ');
    expect(labels).not.toMatch(/Profit\s*(&|and)\s*Loss|P&L/i);
  });

  it('carries the full screen title into the CSV first line and file name, columns unchanged', () => {
    const columns = [{ key: 'C1', label: 'C1 Acme' }, { key: 'total', label: 'Total' }];
    const rows = [{ kind: 'section', label: 'Revenue', values: [100, 100] }, { kind: 'account', code: '41000', title: 'Rent', values: [100, 100] }];
    [['customer', 'Income Statement by Customer'], ['project', 'Income Statement by Job'], ['department', 'Income Statement by Department']].forEach(([cols, title]) => {
      const config = resolveConfig({ report: 'pnl', cols, preset: 'custom', from: '2026-01-01', to: '2026-10-27' });
      const result = { config, def: reportDef('pnl'), columns, rows };
      const out = csvRows(result);
      expect(out[0]).toEqual([`${title} (Accrual Book)`]);
      expect(out[5]).toEqual(['Section', 'Account', 'Title', 'C1 Acme', 'Total']);
      expect(csvFileName(result)).toMatch(new RegExp(`^${title.replace(/ /g, '-')}_all-entities_accrual_${cols}_2026-01-01_2026-10-27\\.csv$`));
      expect(out.flat().join(' ')).not.toMatch(/Profit\s*(&|and)\s*Loss|P&L/i);
    });
  });

  it('lists in the Report Center under their own names, with what each does', () => {
    const groups = [{ key: 'grp-financial', label: 'Financial', items: [{ key: 'grp-pnl', label: 'Income Statement', items: [
      { key: 'rpt-pnl-t12', label: 'T12' }, { key: 'rpt-pnl-customer', label: 'Income Statement by Customer' }, { key: 'rpt-pnl-job', label: 'Income Statement by Job' },
    ] }, { key: 'rpt-vendor-spend', label: 'Spend by Vendor' }] }, { key: 'grp-tax', label: 'Tax', items: [{ key: 'rpt-schedule-c', label: 'Schedule C (Draft)' }] }];
    const rows = standardEntries(groups);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by['rpt-pnl-t12'].label).toBe('Income Statement, T12');
    expect(by['rpt-pnl-customer'].label).toBe('Income Statement by Customer');
    expect(by['rpt-pnl-job'].about).toMatch(/Project dimension/);
    expect(by['rpt-vendor-spend'].about).toMatch(/vendor/i);
    expect(by['rpt-schedule-c'].about).toMatch(/Schedule E, Form 4562 .* 1040, 1120, 1120-S and 1065 returns come later/);
    expect(rows.map((r) => `${r.label} ${r.about || ''}`).join(' ')).not.toMatch(/Profit\s*(&|and)\s*Loss|P&L/i);
  });
});

describe('Vendor search by name (item 17)', () => {
  const vendors = [{ code: 'V00045', name: 'Aarav Desai' }, { code: 'V01200', name: 'The Home Depot, Inc.' }, { code: 'V00236', name: 'Amerigas' }];
  it('finds a vendor by its name, words in any order, punctuation aside - or by number', () => {
    expect(filterOptions(vendors, 'home depot').map((v) => v.code)).toEqual(['V01200']);
    expect(filterOptions(vendors, 'depot home').map((v) => v.code)).toEqual(['V01200']);
    expect(filterOptions(vendors, 'Home Depot Inc').map((v) => v.code)).toEqual(['V01200']);
    expect(filterOptions(vendors, 'desai').map((v) => v.code)).toEqual(['V00045']);
    expect(filterOptions(vendors, 'v002').map((v) => v.code)).toEqual(['V00236']);
    expect(filterOptions(vendors, 'depot amerigas')).toEqual([]);
  });
});

describe('Spend by Vendor (item 17)', () => {
  it('is a report of its own with period columns', () => {
    expect(REPORTS.find((r) => r.key === 'vendor-spend')).toMatchObject({ label: 'Spend by Vendor', period: 'range' });
    expect(columnModes('vendor-spend').map((m) => m.key)).toEqual(['total', 'month', 'quarter', 'year']);
    expect(resolveConfig({ report: 'vendor-spend', cols: 'customer' }).cols).toBe('total');
  });

  it('cuts the period into columns, latest first, each inside the range', () => {
    expect(spendPeriods('2026-01-01', '2026-03-15', 'month').map((p) => [p.from, p.to])).toEqual([
      ['2026-03-01', '2026-03-15'], ['2026-02-01', '2026-02-28'], ['2026-01-01', '2026-01-31'],
    ]);
    expect(spendPeriods('2026-02-10', '2026-10-27', 'quarter').map((p) => [p.label, p.from, p.to])).toEqual([
      ['Q4 2026', '2026-10-01', '2026-10-27'], ['Q3 2026', '2026-07-01', '2026-09-30'], ['Q2 2026', '2026-04-01', '2026-06-30'], ['Q1 2026', '2026-02-10', '2026-03-31'],
    ]);
    expect(spendPeriods('2026-01-01', '2026-10-27', 'total')).toEqual([{ key: 'cur', from: '2026-01-01', to: '2026-10-27', label: '01/01/2026 - 10/27/2026' }]);
  });

  const periods = [{ key: '2026-02-01', from: '2026-02-01', to: '2026-02-28', label: 'Feb 2026' }, { key: '2026-01-01', from: '2026-01-01', to: '2026-01-31', label: 'Jan 2026' }];
  const reads = [
    { labels: { V1: 'Acme Power', V2: 'Bolt Supply' }, rows: [
      { account_no: '62100', title: 'Utilities', section: 'expense', bucket: 'V1', debit: 300, credit: 0 },
      { account_no: '20100', title: 'Accounts Payable', section: 'liability', bucket: 'V1', debit: 0, credit: 300 },
      { account_no: '62200', title: 'Supplies', section: 'expense', bucket: 'V2', debit: 50, credit: 10 },
      { account_no: '66000', title: 'Payroll', section: 'expense', bucket: '', debit: 900, credit: 0 },
    ] },
    { labels: {}, rows: [{ account_no: '62100', title: 'Utilities', section: 'expense', bucket: 'V1', debit: 200, credit: 0 }, { account_no: '41000', title: 'Rent', section: 'revenue', bucket: 'V2', debit: 0, credit: 999 }] },
  ];

  it('one heading per vendor (number and name), its expense accounts under it, a Total column and Total Spend', () => {
    const r = spendLayout(reads, periods, { book: 'accrual' });
    expect(r.columns.map((c) => c.label)).toEqual(['Feb 2026', 'Jan 2026', 'Total']);
    expect(r.labelHead).toBe('Vendor / Account');
    expect(r.startFolded).toBe(true);
    const groups = r.rows.filter((x) => x.kind === 'group');
    // Largest spend first, No Vendor last; balance sheet and revenue lines are not spend.
    expect(groups.map((g) => [g.label, g.totals])).toEqual([['V1 Acme Power', [300, 200, 500]], ['V2 Bolt Supply', [40, 0, 40]], ['No Vendor', [900, 0, 900]]]);
    expect(r.rows.find((x) => x.kind === 'grand')).toMatchObject({ label: 'Total Spend', values: [1240, 200, 1440] });
    expect(r.summary.find((s) => s.label === 'Vendors').value).toBe('2');
    expect(r.summary.find((s) => s.label === 'Total Spend').amount).toBe(1440);
  });

  it('an account amount opens that vendor\'s lines on that account for that column; No Vendor does not drill', () => {
    const r = spendLayout(reads, periods, { book: 'cash' });
    const util = r.rows.find((x) => x.kind === 'account' && x.code === '62100');
    expect(util.match).toBe('V1 Acme Power');
    expect(util.drills[1]).toEqual({ from: '2026-01-01', to: '2026-01-31', book: 'cash', party: { kind: 'vendor', code: 'V1', name: 'Acme Power' } });
    expect(util.drills[2]).toMatchObject({ from: '2026-01-01', to: '2026-02-28' });
    const payroll = r.rows.find((x) => x.kind === 'account' && x.code === '66000');
    expect(payroll.noDrill).toBe(true);
    expect(payroll.drills).toBeUndefined();
  });

  it('keeps only the vendors picked, and reads the ledger once per column, by vendor', async () => {
    const r = spendLayout(reads, periods, { picked: ['V2'] });
    expect(r.rows.filter((x) => x.kind === 'group').map((g) => g.label)).toEqual(['V2 Bolt Supply', 'No Vendor']);
    const api = { getAccountingBuckets: vi.fn(async () => ({ rows: [], org: 'Greens' })) };
    const config = resolveConfig({ report: 'vendor-spend', preset: 'custom', from: '2026-01-01', to: '2026-03-31', cols: 'month', entities: ['15000'] });
    const out = await vendorSpend(api, config, 'accrual');
    expect(api.getAccountingBuckets).toHaveBeenCalledTimes(3);
    expect(api.getAccountingBuckets.mock.calls.every(([q]) => q.by === 'vendor' && q.location === '15000')).toBe(true);
    expect(out.org).toBe('Greens');
    const long = resolveConfig({ report: 'vendor-spend', preset: 'custom', from: '2020-01-01', to: '2026-03-31', cols: 'month' });
    await expect(vendorSpend(api, long, 'accrual')).rejects.toThrow(`up to ${SPEND_MAX_COLUMNS}`);
  });
});

describe('Schedule C (Draft) (item 18)', () => {
  it('suggests a line from the account name and section', () => {
    expect(suggestLine({ title: 'Rental Income', section: 'revenue' })).toBe('1');
    expect(suggestLine({ title: 'Sales Returns and Allowances', section: 'revenue' })).toBe('2');
    expect(suggestLine({ title: 'Interest Income', section: 'other_income' })).toBe('6');
    expect(suggestLine({ title: 'Materials', section: 'cogs' })).toBe('4');
    expect(suggestLine({ title: 'Advertising & Marketing', section: 'expense' })).toBe('8');
    expect(suggestLine({ title: 'Health Insurance', section: 'expense' })).toBe('14');
    expect(suggestLine({ title: 'General Liability Insurance', section: 'expense' })).toBe('15');
    expect(suggestLine({ title: 'Mortgage Interest', section: 'other_expense' })).toBe('16a');
    expect(suggestLine({ title: 'Payroll Taxes', section: 'expense' })).toBe('23');
    expect(suggestLine({ title: 'Salaries and Wages', section: 'expense' })).toBe('26');
    expect(suggestLine({ title: 'Equipment Rental', section: 'expense' })).toBe('20a');
    expect(suggestLine({ title: 'Office Rent', section: 'expense' })).toBe('20b');
    expect(suggestLine({ title: 'Repairs & Maintenance', section: 'expense' })).toBe('21');
    expect(suggestLine({ title: 'PG&E Electric', section: 'expense' })).toBe('25');
    expect(suggestLine({ title: 'Depreciation Expense', section: 'expense' })).toBe('13');
    expect(suggestLine({ title: 'Miscellaneous', section: 'expense' })).toBe('');
    expect(suggestLine({ title: 'Federal Income Tax', section: 'other_expense' })).toBe('');
    expect(suggestLine({ title: 'Cash', section: 'asset' })).toBe('');
  });

  it('an entity\'s own line beats the every-entity line, which beats the suggestion', () => {
    const maps = mapsOf([{ accountNo: '61000', line: '21', entity: '' }, { accountNo: '61000', line: '22', entity: '15000' }, { accountNo: '62000', line: '18', entity: '' }, { accountNo: '63000', line: '9', entity: '99999' }], '15000');
    expect(lineFor({ code: '61000', title: 'Repairs', section: 'expense' }, maps)).toEqual({ line: '22', source: 'entity' });
    expect(lineFor({ code: '62000', title: 'Repairs', section: 'expense' }, maps)).toEqual({ line: '18', source: 'all' });
    expect(lineFor({ code: '63000', title: 'Repairs', section: 'expense' }, maps)).toEqual({ line: '21', source: 'suggested' });
    expect(lineFor({ code: '64000', title: 'Misc', section: 'expense' }, maps)).toEqual({ line: '', source: '' });
  });

  const sections = [
    { key: 'revenue', accounts: [{ account_no: '41000', title: 'Rental Income', amount: 10000 }, { account_no: '41900', title: 'Refunds', amount: -500 }] },
    { key: 'cogs', accounts: [{ account_no: '51000', title: 'Materials', amount: 2000 }] },
    { key: 'expense', accounts: [{ account_no: '61000', title: 'Advertising', amount: 300 }, { account_no: '62000', title: 'Utilities', amount: 700 }, { account_no: '69000', title: 'Miscellaneous', amount: 50 }, { account_no: '69500', title: 'Owner Draws', amount: 1000 }, { account_no: '69900', title: 'Zero', amount: 0 }] },
    { key: 'other_income', accounts: [{ account_no: '81000', title: 'Interest Income', amount: 100 }] },
  ];

  it('fills the form lines and works out lines 3, 5, 7, 28, 29 and 31', () => {
    const maps = mapsOf([{ accountNo: '69500', line: 'skip', entity: '' }]);
    const r = scheduleCLayout(sections, maps, { drill: { from: '2026-01-01', to: '2026-12-31', book: 'accrual' }, label: 'Tax Year 2026' });
    expect(r.lineTotals).toMatchObject({ 1: 10000, 2: 500, 3: 9500, 4: 2000, 5: 7500, 6: 100, 7: 7600, 8: 300, 25: 700, 28: 1000, 29: 6600, 30: 0, 31: 6600 });
    expect(r.columns).toEqual([{ key: 'amount', label: 'Tax Year 2026', type: 'amount', drill: { from: '2026-01-01', to: '2026-12-31', book: 'accrual' } }]);
    const labels = r.rows.map((x) => x.label).filter(Boolean);
    expect(labels).toContain('Line 1 - Gross receipts or sales');
    expect(labels).toContain('Line 27b - Other expenses');
    expect(r.rows.find((x) => x.kind === 'grand')).toMatchObject({ label: 'Line 31 - Net profit or (loss)', values: [6600] });
    // Unmapped accounts are listed for review and add into no line; "skip" is its own list.
    expect(r.rows.find((x) => x.kind === 'group' && x.label.startsWith('Not Mapped'))).toMatchObject({ count: 1, totals: [50] });
    expect(r.rows.find((x) => x.kind === 'group' && x.label === 'Not on Schedule C')).toMatchObject({ count: 1, totals: [1000] });
    expect(r.summary.find((s) => s.label === 'Not Mapped').value).toBe('1');
    expect(r.mapRows.map((m) => m.code)).not.toContain('69900');
    expect(r.mapRows.find((m) => m.code === '41900')).toMatchObject({ line: '2', source: 'suggested', suggested: '2' });
    // A form line account drills into its own lines (the column's window); lines 3 / 5 / 7 / 28 / 29 / 31 do not.
    const adv = r.rows.find((x) => x.kind === 'account' && x.code === '61000');
    expect(adv).toMatchObject({ group: 'L8', values: [300] });
    expect(adv.noDrill).toBeUndefined();
    expect(r.rows.filter((x) => /^Line (3|5|7|28|29|31) /.test(x.label || '')).every((x) => x.noDrill)).toBe(true);
    expect(r.notes.join(' ')).toMatch(/Schedule E, Form 4562/);
  });

  it('reads the income statement and the mapping for the entity picked - and writes nothing', async () => {
    const api = {
      getAccountingPnl: vi.fn(async () => ({ sections, org: 'Greens' })),
      getAccountingTaxLines: vi.fn(async () => ({ lines: [{ accountNo: '69000', line: '27b', entity: '15000' }] })),
      saveAccountingTaxLines: vi.fn(),
    };
    const config = resolveConfig({ report: 'schedule-c', preset: 'custom', from: '2026-01-01', to: '2026-12-31', entities: ['15000'] });
    const r = await scheduleC(api, config, 'accrual');
    expect(api.getAccountingPnl).toHaveBeenCalledWith('2026-01-01', '2026-12-31', '15000', null, 'accrual');
    expect(api.getAccountingTaxLines).toHaveBeenCalledWith('schedule_c', '15000');
    expect(api.saveAccountingTaxLines).not.toHaveBeenCalled();
    expect(r.mapEntity).toBe('15000');
    expect(r.columns[0].label).toBe('Tax Year 2026');
    expect(r.lineTotals['27b']).toBe(50);
    const all = await scheduleC(api, resolveConfig({ ...config, entities: ['15000', '12000'] }), 'accrual');
    expect(all.mapEntity).toBe('');
    expect(api.getAccountingTaxLines).toHaveBeenLastCalledWith('schedule_c', '');
  });
});

// Call of 10/27 with Charmi, item 17: the ledger search behind one amount.
describe('lineQuery (10/27 call, item 17)', () => {
  it('takes the column window, the report entities and filters', async () => {
    const { lineQuery } = await import('./reportModel');
    expect(lineQuery({ account: '63203', drill: { from: '2026-01-01', to: '2026-12-31', book: 'accrual' }, entities: ['12000', '12019'], dims: { employee: ['E-0084'] } }))
      .toEqual({ account: '63203', from: '2026-01-01', to: '2026-12-31', book: 'accrual', locations: '12000,12019', employee: 'E-0084', party_kind: 'employee', party: 'E-0084' });
    // A column of one entity, department or party narrows to it.
    expect(lineQuery({ account: '61000', drill: { from: '2026-01-01', to: '2026-03-31', book: 'cash', entity: '15000' }, entities: ['12000'] })).toMatchObject({ location: '15000', book: 'cash' });
    expect(lineQuery({ account: '61000', drill: { from: '', to: '2026-03-31', department: '9100' } })).toMatchObject({ departments: '9100', from: undefined });
    expect(lineQuery({ account: '61000', drill: { to: '2026-03-31', party: { kind: 'vendor', code: 'V1' } } })).toMatchObject({ party_kind: 'vendor', party: 'V1' });
    // As of a date: a balance sheet account from the start, an income or expense account from January 1.
    const asof = { from: '', to: '2026-09-30', book: 'accrual', asof: true };
    expect(lineQuery({ account: '11000', drill: asof }).from).toBeUndefined();
    expect(lineQuery({ account: '61000', drill: asof, pl: true }).from).toBe('2026-01-01');
    // Both books side by side is no single book: the search reads them all.
    expect(lineQuery({ account: '61000', drill: { to: '2026-03-31', book: 'both' } }).book).toBeUndefined();
  });
});
