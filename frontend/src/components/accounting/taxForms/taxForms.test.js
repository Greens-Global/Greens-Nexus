import { describe, it, expect, vi } from 'vitest';
import { FORMS, TAX_REPORTS, layoutForm, lineChoices, lineText, mapsOf, mappableLines, rentalMode, suggestLine } from './engine';
import { runTaxReport } from './run';
import { REPORTS, TAX_REPORT_KEYS, resolveConfig } from '../reportModel';

// Accounting -> Reports -> Tax (Charmi, Teams 11/19/2026: "We need Sch C, Sch
// E, 1040, 1065, form 568, 1120"): every form's line list, its default
// mapping and its totals, from the one engine.

const DRILL = { from: '2025-01-01', to: '2025-12-31', book: 'accrual' };
const col = (sections, maps = {}, extra = {}) => ({ key: 'amount', label: 'Tax Year 2025', drill: DRILL, sections, maps, ...extra });
const one = (form, key, sections, maps) => layoutForm(FORMS[form], TAX_REPORTS[key].report, [col(sections, maps)]);
const labels = (r) => r.rows.map((x) => x.label || x.title).filter(Boolean);

// A storage company's year: mostly rent.
const RENTAL = [
  { key: 'revenue', accounts: [{ account_no: '41101', title: 'Rental Income', amount: 90000 }, { account_no: '40105', title: 'Late Fees', amount: 2000 }] },
  { key: 'expense', accounts: [
    { account_no: '61000', title: 'Property Management Fee', amount: 6000 },
    { account_no: '62000', title: 'Repairs & Maintenance', amount: 4000 },
    { account_no: '63000', title: 'Property Taxes', amount: 8000 },
    { account_no: '64000', title: 'Mortgage Interest', amount: 20000 },
    { account_no: '65000', title: 'Depreciation Expense', amount: 15000 },
    { account_no: '66000', title: 'PG&E Electric', amount: 1500 },
    { account_no: '69500', title: 'Owner Draws', amount: 500 },
  ] },
  { key: 'other_income', accounts: [{ account_no: '80100', title: 'Interest Income', amount: 300 }] },
];
// A trading company's year.
const TRADING = [
  { key: 'revenue', accounts: [{ account_no: '40000', title: 'Sales', amount: 1000000 }, { account_no: '40900', title: 'Sales Returns', amount: -20000 }] },
  { key: 'cogs', accounts: [{ account_no: '50000', title: 'Materials', amount: 400000 }] },
  { key: 'expense', accounts: [
    { account_no: '60000', title: 'Salaries and Wages', amount: 200000 },
    { account_no: '60100', title: 'Officer Salary', amount: 100000 },
    { account_no: '61000', title: 'Office Rent', amount: 60000 },
    { account_no: '62000', title: 'Advertising', amount: 10000 },
    { account_no: '63000', title: 'Charitable Contributions', amount: 5000 },
    { account_no: '64000', title: 'Miscellaneous', amount: 1000 },
  ] },
  { key: 'other_income', accounts: [{ account_no: '80100', title: 'Interest Income', amount: 2500 }, { account_no: '80200', title: 'Dividend Income', amount: 1500 }] },
  { key: 'other_expense', accounts: [{ account_no: '90000', title: 'Federal Income Tax', amount: 60000 }] },
];

describe('every form file', () => {
  it('has its reports on the Reports screen and only lines the API stores', () => {
    const keys = Object.keys(TAX_REPORTS);
    expect(new Set(keys)).toEqual(TAX_REPORT_KEYS);
    keys.forEach((k) => expect(REPORTS.some((r) => r.key === k)).toBe(true));
    expect(Object.keys(FORMS).sort()).toEqual(['ca_568', 'form_1040', 'form_1065', 'form_1120', 'schedule_c', 'schedule_e']);
    Object.values(FORMS).forEach((f) => {
      expect(f.taxYear).toBe(2025);
      expect(mappableLines(f)).toContain('skip');
      // Every suggested line can be stored.
      const sets = Object.entries(f.suggest || {}).filter(([k]) => k !== 'never').flatMap(([k, v]) => (k === 'rental' ? Object.values(v) : [v]));
      // ('' = a rule that deliberately suggests nothing: the account waits for review.)
      sets.flat().forEach(([, line]) => { if (line) expect(mappableLines(f)).toContain(line); });
    });
  });

  it('names lines the way the form does', () => {
    expect(lineText(FORMS.schedule_c, '16a')).toBe('Line 16a - Interest - mortgage (paid to banks, etc.)');
    expect(lineText(FORMS.form_1065, 'k5')).toBe('Schedule K Line 5 - Interest income');
    expect(lineText(FORMS.form_1065, 'l9b')).toBe('Schedule L Line 9b - Less accumulated depreciation');
    expect(lineText(FORMS.form_1065, 'r2')).toBe('Form 8825 Line 2 - Gross rents');
    expect(lineText(FORMS.ca_568, '22')).toBe('Schedule B Line 22 - Ordinary income (loss) from trade or business activities');
    expect(lineText(FORMS.form_1120, 'skip')).toBe('Not on Form 1120');
    expect(lineText(FORMS.form_1040, 'schedule_e')).toBe('Schedule E - a rental property');
    // Line Mapping offers only what the report shows: page 1 and K on the 1065, Schedule L on its own.
    const page = lineChoices(FORMS.form_1065, TAX_REPORTS['tax-1065'].report).flatMap((g) => g.lines.map((l) => l.line));
    const sched = lineChoices(FORMS.form_1065, TAX_REPORTS['tax-1065-l'].report).flatMap((g) => g.lines.map((l) => l.line));
    expect(page).toContain('k5');
    expect(page).not.toContain('l1');
    expect(sched).toEqual(expect.arrayContaining(['l1', 'l21']));
    expect(page).not.toContain('k1');    // worked out, never mapped
  });
});

describe('Schedule E', () => {
  it('suggests the rental lines and works out lines 20, 21 and 23-26, one column per property', () => {
    const f = FORMS.schedule_e;
    expect(suggestLine(f, { title: 'Property Management Fee', section: 'expense' })).toBe('11');
    expect(suggestLine(f, { title: 'Mortgage Interest', section: 'expense' })).toBe('12');
    expect(suggestLine(f, { title: 'Owner Draws', section: 'expense' })).toBe('');
    const loss = [{ key: 'revenue', accounts: [{ account_no: '41101', title: 'Rental Income', amount: 1000 }] }, { key: 'expense', accounts: [{ account_no: '62000', title: 'Repairs', amount: 3000 }] }];
    const r = layoutForm(f, TAX_REPORTS['schedule-e'].report, [col(RENTAL, {}, { key: 'a', label: 'A' }), col(loss, {}, { key: 'b', label: 'B' })], { total: true, totalDrill: DRILL });
    expect(r.columns.map((c) => c.label)).toEqual(['A', 'B', 'Total']);
    const line = (n) => r.rows.find((x) => (x.label || '').startsWith(`Line ${n} -`));
    // Property A: 92,000 rents (rent + late fees), 54,500 expenses; B: 1,000 less 3,000.
    expect(line('3').totals).toEqual([92000, 1000, 93000]);
    expect(line('20').values).toEqual([54500, 3000, 57500]);
    expect(line('21').values).toEqual([37500, -2000, 35500]);
    // 23-26 sit in the Total column only; 24 / 25 add the positive / negative line 21s.
    expect(line('23a').values).toEqual(['', '', 93000]);
    expect(line('24').values).toEqual(['', '', 37500]);
    expect(line('25').values).toEqual(['', '', -2000]);
    expect(line('26').values).toEqual(['', '', 35500]);
    // Interest income is not rent (it belongs on Schedule B) and owner draws are
    // not an expense: both wait for review, in the column and the total.
    expect(r.rows.find((x) => x.kind === 'account' && x.code === '80100')).toMatchObject({ group: 'L', title: 'Interest Income' });
    expect(r.rows.find((x) => x.kind === 'group' && x.label.startsWith('Not Mapped')).totals).toEqual([800, 0, 800]);
    // An entity's own column drill names the entity.
    expect(r.columns[2].drill).toEqual(DRILL);
  });
});

describe('Form 1065', () => {
  it('puts a rental partnership on Form 8825 and Schedule K line 2, portfolio income on K, and M-1 ties out', () => {
    const f = FORMS.form_1065;
    expect(rentalMode(f, RENTAL)).toBe(true);
    expect(rentalMode(f, TRADING)).toBe(false);
    const r = one('form_1065', 'tax-1065', RENTAL, mapsOf([{ accountNo: '69500', line: 'skip', entity: '' }]));
    const t = r.lineTotals;
    expect(t.r2).toBe(90000);                  // rent on Form 8825
    expect(t['1a']).toBe(2000);                // late fees on page 1
    expect(t.r16).toBe(54500);                 // every expense on 8825 for a rental partnership
    expect(t.r21).toBe(35500);
    expect(t.k2).toBe(35500);
    expect(t.k5).toBe(300);                    // interest income on Schedule K, not page 1
    expect(t['8']).toBe(2000);
    expect(t['23']).toBe(2000);
    expect(t.k1).toBe(2000);
    expect(t.ka1).toBe(37800);
    expect(t.m1).toBe(37300);                  // books: 92,300 less 55,000 (draws included)
    expect(t.mskip).toBe(500);
    expect(t.mchk).toBe(0);
  });

  it('lays a trading partnership on page 1', () => {
    const t = one('form_1065', 'tax-1065', TRADING, {}).lineTotals;
    expect(t['1a']).toBe(1000000);
    expect(t['1b']).toBe(20000);
    expect(t['1c']).toBe(980000);
    expect(t['3']).toBe(580000);
    expect(t['9']).toBe(300000);               // wages, officers included (a partnership has no officers line)
    expect(t['13']).toBe(60000);
    expect(t.k13a).toBe(5000);                 // contributions are separately stated
    expect(t.k5).toBe(2500);
    expect(t.k6a).toBe(1500);
    expect(t['21']).toBe(10000 + 1000);        // advertising and miscellaneous are other deductions
    expect(t['23']).toBe(580000 - 300000 - 60000 - 11000);
    // Federal income tax is not a partnership deduction: it waits for review, and M-1 says so.
    expect(t.munm).toBe(60000);
    expect(t.mchk).toBe(0);
  });

  it('Schedule L: the balance sheet on the form lines, beginning and end, earnings on capital so it balances', () => {
    const bs = (cash, building, accum, loan, capital, earnings) => [
      { key: 'asset', accounts: [{ account_no: '10100', title: 'Chase Checking', amount: cash }, { account_no: '15000', title: 'Building', amount: building }, { account_no: '15900', title: 'Accumulated Depreciation', amount: accum }] },
      { key: 'liability', accounts: [{ account_no: '25000', title: 'Mortgage Payable - BoW', amount: loan }] },
      { key: 'equity', accounts: [{ account_no: '30000', title: 'Partner Capital', amount: capital }, { account_no: '', title: 'Current Year Earnings (2025)', amount: earnings }] },
    ];
    const report = TAX_REPORTS['tax-1065-l'].report;
    const r = layoutForm(FORMS.form_1065, report, [col(bs(10000, 500000, -50000, 300000, 160000, 0), {}, { key: 'begin' }), col(bs(25000, 500000, -65000, 290000, 160000, 10000), {}, { key: 'end' })]);
    const row = (n) => r.rows.find((x) => (x.label || '').startsWith(`Schedule L Line ${n} -`));
    expect(row('1').totals).toEqual([10000, 25000]);
    expect(row('9b').totals).toEqual([-50000, -65000]);
    expect(row('19b').totals).toEqual([300000, 290000]);
    expect(row('21').totals).toEqual([160000, 170000]);
    expect(row('14').values).toEqual([460000, 460000]);
    expect(row('22').values).toEqual([460000, 460000]);
    expect(r.rows.find((x) => (x.label || '').startsWith('Line 14 less line 22')).values).toEqual([0, 0]);
    // The earnings line has no account number: it cannot be mapped and does not drill.
    const earnings = r.rows.find((x) => x.kind === 'account' && x.title.startsWith('Current Year Earnings'));
    expect(earnings.noDrill).toBe(true);
    expect(r.mapRows.some((m) => !m.code)).toBe(false);
  });
});

describe('Form 1120', () => {
  it('fills page 1 to line 28, keeps federal income tax off the return, and M-1 ties out', () => {
    const f = FORMS.form_1120;
    expect(suggestLine(f, { title: 'Officer Salary', section: 'expense' })).toBe('12');
    expect(suggestLine(f, { title: 'Federal Income Tax', section: 'other_expense' })).toBe('skip');
    const t = one('form_1120', 'tax-1120', TRADING, {}).lineTotals;
    expect(t['1c']).toBe(980000);
    expect(t['5']).toBe(2500);
    expect(t['4']).toBe(1500);
    expect(t['11']).toBe(980000 - 400000 + 4000);
    expect(t['12']).toBe(100000);
    expect(t['13']).toBe(200000);
    expect(t['16']).toBe(60000);
    expect(t['19']).toBe(5000);
    expect(t['22']).toBe(10000);
    expect(t['26']).toBe(1000);
    expect(t['27']).toBe(376000);
    expect(t['28']).toBe(584000 - 376000);
    expect(t.m1).toBe(584000 - 376000 - 60000);
    expect(t.mskip).toBe(60000);
    expect(t.mchk).toBe(0);
  });
});

describe('CA Form 568', () => {
  const fee = (income) => one('ca_568', 'tax-568', [{ key: 'revenue', accounts: [{ account_no: '40000', title: 'Sales', amount: income }] }], {}).lineTotals;
  it('works out the LLC fee from total income, the $800 annual tax, and Schedule B', () => {
    expect(fee(249999.99).s2).toBe(0);
    expect(fee(250000).s2).toBe(900);
    expect(fee(999999).s2).toBe(2500);
    expect(fee(1000000).s2).toBe(6000);
    expect(fee(5000000).s2).toBe(11790);
    expect(fee(10).s3).toBe(800);
    const t = one('ca_568', 'tax-568', TRADING, {}).lineTotals;
    // Total income for the fee: every income account, before cost of goods sold (returns net in).
    expect(t.s1).toBe(980000 + 2500 + 1500);
    expect(t.s2).toBe(2500);                   // 984,000 is under $1,000,000
    expect(t['22']).toBe(t['8'] - t['21']);
  });

  it('puts a rental LLC on the Rental Real Estate lines', () => {
    const t = one('ca_568', 'tax-568', RENTAL, {}).lineTotals;
    expect(t.rent).toBe(90000);
    expect(t.rentexp).toBe(54500);
    expect(t.rentnet).toBe(35500);
    expect(t.s1).toBe(92300);
  });
});

describe('Form 1040', () => {
  it('reads each entity on Schedule C or E from that form\'s own mapping, and lists the rest as the preparer\'s', async () => {
    const statements = { 15000: RENTAL, 12000: TRADING };
    const api = {
      getAccountingPnl: vi.fn(async (from, to, location) => ({ sections: statements[location], org: 'Greens' })),
      getAccountingTaxLines: vi.fn(async (form, entity) => ({ lines: form === 'form_1040' && entity === '12000' ? [{ accountNo: 'return', line: 'schedule_c', entity: '12000' }] : [] })),
    };
    const config = resolveConfig({ report: 'tax-1040', preset: 'custom', from: '2025-01-01', to: '2025-12-31', entities: ['15000', '12000'] });
    const r = await runTaxReport(api, config, 'accrual', [{ code: '15000', name: 'Greens Escondido' }, { code: '12000', name: 'Greens Global' }]);
    // 15000 is mostly rent: Schedule E line 41 = 92,000 less 54,500 (interest and
    // owner draws not mapped - left out). 12000 is set to Schedule C: line 7
    // 584,000 less wages 300,000, rent 60,000 and advertising 10,000 (the
    // contributions, miscellaneous and federal tax wait in its own mapping).
    expect(r.lineTotals[5]).toBe(37500);
    expect(r.lineTotals[3]).toBe(214000);
    expect(r.lineTotals[10]).toBe(r.lineTotals[3] + r.lineTotals[5]);
    expect(r.mapRows.map((m) => [m.saveEntity, m.line, m.source])).toEqual([['15000', 'schedule_e', 'suggested'], ['12000', 'schedule_c', 'entity']]);
    expect(labels(r).some((l) => /Wages, salaries, tips .* not from the books/.test(l))).toBe(true);
    expect(api.getAccountingTaxLines).toHaveBeenCalledWith('schedule_e', '15000');
    expect(api.getAccountingTaxLines).toHaveBeenCalledWith('schedule_c', '12000');
  });
});

describe('the report reads only through the proxy and the mapping', () => {
  it('Schedule E reads one statement per entity, the 1065 Schedule L two balance sheets', async () => {
    const api = {
      getAccountingPnl: vi.fn(async () => ({ sections: RENTAL })),
      getAccountingBalanceSheet: vi.fn(async () => ({ sections: [] })),
      getAccountingTaxLines: vi.fn(async () => ({ lines: [] })),
      saveAccountingTaxLines: vi.fn(),
    };
    const e = await runTaxReport(api, resolveConfig({ report: 'schedule-e', preset: 'custom', from: '2025-01-01', to: '2025-12-31', entities: ['15000', '16000'] }), 'accrual');
    expect(api.getAccountingPnl).toHaveBeenCalledTimes(2);
    expect(e.columns.map((c) => c.drill?.entity || 'total')).toEqual(['15000', '16000', 'total']);
    expect(e.mapEntity).toBe('');
    await runTaxReport(api, resolveConfig({ report: 'tax-1065-l', preset: 'custom', from: '2025-01-01', to: '2025-12-31', entities: ['15000'] }), 'accrual');
    expect(api.getAccountingBalanceSheet.mock.calls.map((c) => c[0])).toEqual(['2024-12-31', '2025-12-31']);
    expect(api.saveAccountingTaxLines).not.toHaveBeenCalled();
    await expect(runTaxReport(api, resolveConfig({ report: 'schedule-e', preset: 'custom', from: '2025-01-01', to: '2025-12-31', entities: Array.from({ length: 16 }, (_, i) => String(20000 + i)) }), 'accrual'))
      .rejects.toThrow(/at most 15 properties/);
  });
});
