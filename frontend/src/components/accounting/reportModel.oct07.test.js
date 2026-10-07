import { describe, it, expect, vi } from 'vitest';
import {
  bookLabel, bookOptions, cashFlowFigures, defaultConfig, glGroupOf, glLineParams, hideInactive, lineMatchesDims, numberFilterHit, parseFigure,
  reportPages, resolveConfig, runReport, setUserBooks, withFluxNotes,
} from './reportModel';

// Accounting > Reports, Oct 7 batch (Charmi, Neil): the General Ledger's
// filters reach the lines (31), its counter (20), groups (22), pages (21),
// inactive accounts (34), Flux explanations (26a/b), operator filters (26d),
// the Statement of Cash Flows (26c), books (35) and Actual vs Budget (43).

const NOW = new Date(2026, 9, 6);   // 10/06/2026

const tb = {
  org: 'Greens Global', generated_at: '2026-10-06', totals: { closing: 0 },
  rows: [
    { account_no: '10100', title: 'Chase Operating', class: 'Bank', class_rank: 1, group: 'Bank', active: true, opening: 1000, debit: 0, credit: 300, closing: 700 },
    { account_no: '20100', title: 'Accounts Payable', class: 'Liabilities', class_rank: 4, group: 'Accounts Payable', active: true, opening: -500, debit: 300, credit: 0, closing: -200 },
    { account_no: '11757', title: 'OSM - OP - 1629', class: 'Bank', class_rank: 1, group: 'Bank', active: false, opening: 19.14, debit: 0, credit: 0, closing: 19.14 },
  ],
};
const line = (id, vendor, debit, credit, extra = {}) => ({ line_id: id, entry_id: `e-${id}`, entry_no: `IA-${id}`, entry_date: '2026-03-01', description: `Payment ${id}`, vendor_id: vendor, journal: 'APJ', debit, credit, ...extra });

describe('General Ledger lines follow the filters (item 31)', () => {
  it('sends the filters with every line search and narrows the lines itself when the service did not', async () => {
    const lines = {
      10100: [line(1, 'V05022', 0, 100), line(2, 'V00236', 0, 150), line(3, 'V05022', 0, 50)],
      20100: [line(4, 'V05022', 300, 0)],
    };
    const api = {
      getAccountingTrialBalance: vi.fn(async () => tb),
      // An accounting service that does NOT narrow the lines yet.
      searchAccountingLedger: vi.fn(async ({ account }) => ({ rows: lines[account] || [], total: (lines[account] || []).length })),
    };
    const r = await runReport(api, resolveConfig({ ...defaultConfig(NOW), report: 'general-ledger', entities: ['12000'], dims: { vendor: ['V05022'] } }, NOW));
    const params = api.searchAccountingLedger.mock.calls[0][0];
    expect(params).toMatchObject({ vendor: 'V05022', party_kind: 'vendor', party: 'V05022', location: '12000' });
    const listed = r.rows.filter((x) => x.kind === 'line').map((x) => x.values[0]);
    expect(listed).toEqual(['IA-1', 'IA-3', 'IA-4']);
    expect(r.summary).toEqual([{ label: 'Lines', value: '3' }]);
    expect(r.notes.join(' ')).toMatch(/narrowed to the filters here/);
    expect(r.notes.join(' ')).not.toMatch(/narrow the balances/);
  });

  it('trusts a service that narrowed the lines, and counts its totals', async () => {
    const api = {
      getAccountingTrialBalance: vi.fn(async () => tb),
      searchAccountingLedger: vi.fn(async ({ account }) => (account === '10100' ? { rows: [line(1, 'V05022', 0, 100)], total: 1200 } : { rows: [], total: 0 })),
    };
    const r = await runReport(api, resolveConfig({ ...defaultConfig(NOW), report: 'general-ledger', dims: { vendor: ['V05022'] } }, NOW));
    expect(r.summary[0].value).toBe('1,200');
    expect(r.notes.join(' ')).not.toMatch(/narrowed to the filters here/);
  });

  it('lists what loaded and says so in plain words when a search does not finish', async () => {
    const api = {
      getAccountingTrialBalance: vi.fn(async () => tb),
      searchAccountingLedger: vi.fn(async ({ account }) => {
        if (account === '20100') throw new Error('That covers too many ledger lines to finish in time.');
        return { rows: [line(1, 'V05022', 0, 100)], total: 1 };
      }),
    };
    const r = await runReport(api, resolveConfig({ ...defaultConfig(NOW), report: 'general-ledger' }, NOW));
    expect(r.rows.some((x) => x.kind === 'line')).toBe(true);
    expect(r.rows.find((x) => x.code === '20100' && x.failed)).toBeTruthy();
    expect(r.notes[0]).toMatch(/^Too many lines for one run - pick an entity or a shorter period\./);
    // Two accounts listed one line each; the third could not be counted.
    expect(r.summary[0].value).toBe('2+');
  });

  it('builds the search params and the line check', () => {
    expect(glLineParams({ vendor: ['V1', 'V2'], departments: ['9100'], journals: ['APJ'] })).toEqual({ vendor: 'V1,V2', departments: '9100', journals: 'APJ' });
    expect(glLineParams({ customer: ['C1'] })).toEqual({ customer: 'C1', party_kind: 'customer', party: 'C1' });
    expect(lineMatchesDims({ vendor_id: 'V1' }, { vendor: ['V1'] })).toBe(true);
    expect(lineMatchesDims({ vendor_id: null }, { vendor: ['V1'] })).toBe(false);
    expect(lineMatchesDims({}, { vendor: ['V1'] })).toBe(true);
    expect(lineMatchesDims({ journal: 'apj' }, { journals: ['APJ'] })).toBe(true);
  });
});

describe('General Ledger groups, counter and inactive accounts (items 20 / 22 / 34)', () => {
  const api = () => ({
    getAccountingTrialBalance: vi.fn(async () => tb),
    searchAccountingLedger: vi.fn(async ({ account }) => (account === '10100' ? { rows: [line(1, 'V1', 0, 300)], total: 1 } : account === '20100' ? { rows: [line(2, 'V1', 300, 0)], total: 1 } : { rows: [], total: 0 })),
  });
  it('puts accounts under their groups in the chart order, with a total per group', async () => {
    const r = await runReport(api(), resolveConfig({ ...defaultConfig(NOW), report: 'general-ledger' }, NOW));
    expect(r.rows.map((x) => `${x.kind}:${x.label || x.code}`)).toEqual([
      'group:Bank', 'section:10100 Chase Operating', 'line:03/01/2026', 'subtotal:Closing balance', 'account:11757', 'subtotal:Total Bank',
      'group:Accounts Payable', 'section:20100 Accounts Payable', 'line:03/01/2026', 'subtotal:Closing balance', 'subtotal:Total Accounts Payable',
      'grand:Total - 3 accounts',
    ]);
    // The account with no lines is a plain row (no fold arrow that opens nothing).
    expect(r.rows.find((x) => x.code === '11757').kind).toBe('account');
    expect(r.rows.find((x) => x.label === 'Total Bank').values.slice(3)).toEqual([0, 300, 719.14]);
    expect(r.rows[0].values.every((v) => v === '')).toBe(true);
    expect(r.rows[0].totals.slice(3)).toEqual([0, 300, 719.14]);
    expect(r.summary).toEqual([{ label: 'Lines', value: '2' }]);
    // Opening drills to everything before the period, Closing through its end.
    const head = r.rows[1];
    expect(head.drills[5]).toMatchObject({ from: '', to: '2025-12-31' });
    expect(r.rows[3].drills[5]).toMatchObject({ from: '', to: '2026-10-06' });
    expect(r.rows[2].entryId).toBe('e-1');
  });

  it('falls back to the statement section for a group', () => {
    expect(glGroupOf({ section: 'liability' })).toEqual({ key: 'Liabilities', label: 'Liabilities', rank: 4 });
    expect(glGroupOf({ class: 'Bank', group: 'Bank', class_rank: 1 })).toEqual({ key: 'Bank', label: 'Bank', rank: 1 });
    expect(glGroupOf({})).toBeNull();
  });

  it('hides inactive account rows only; totals keep them and a footnote counts them', async () => {
    const r = await runReport(api(), resolveConfig({ ...defaultConfig(NOW), report: 'general-ledger' }, NOW));
    expect(r.activeKnown).toBe(true);
    const h = hideInactive(r, false);
    expect(h.rows.some((x) => x.code === '11757')).toBe(false);
    expect(h.rows.find((x) => x.label === 'Total Bank').values[5]).toBe(719.14);
    expect(h.notes.at(-1)).toBe('1 inactive account hidden (Customize). Totals include it.');
    expect(hideInactive(r, true)).toBe(r);
  });

  it('pages without splitting a group from its accounts, and pins the grand total', async () => {
    const r = await runReport(api(), resolveConfig({ ...defaultConfig(NOW), report: 'general-ledger' }, NOW));
    const { pages, pinned, total } = reportPages(r.rows, 4);
    expect(total).toBe(11);
    expect(pinned.map((x) => x.kind)).toEqual(['grand']);
    // Page 1 starts with the Bank heading and keeps its first account whole.
    expect(pages[0].slice(0, 4).map((x) => x.kind)).toEqual(['group', 'section', 'line', 'subtotal']);
    // A page that starts inside a group repeats its heading.
    const cont = pages.find((p, i) => i > 0 && p[0].continued);
    expect(cont[0].label).toBe('Bank (continued)');
    pages.forEach((p) => {
      const g = p.findIndex((x) => x.kind === 'group');
      if (g >= 0) expect(p[g + 1]).toBeTruthy();
    });
    expect(reportPages(r.rows, 0).pages).toHaveLength(1);
  });

  it('splits an account with more lines than a page, its heading repeated', () => {
    const lines = Array.from({ length: 120 }, (_, i) => ({ kind: 'line', section: 'A', group: 'Bank', label: `L${i}` }));
    const rows = [
      { kind: 'group', group: 'Bank', label: 'Bank' },
      { kind: 'section', section: 'A', group: 'Bank', label: '10100 Checking' },
      ...lines,
      { kind: 'subtotal', section: 'A', group: 'Bank', label: 'Total 10100' },
      { kind: 'grand', label: 'Total' },
    ];
    const { pages, pinned, total } = reportPages(rows, 50);
    expect(total).toBe(123);
    expect(pinned.map((x) => x.kind)).toEqual(['grand']);
    expect(pages).toHaveLength(3);
    pages.forEach((p) => expect(p.filter((x) => !x.continued).length).toBeLessThanOrEqual(50));
    expect(pages.flat().filter((x) => !x.continued)).toHaveLength(123);
    expect(pages[1].slice(0, 2).map((x) => x.label)).toEqual(['Bank (continued)', '10100 Checking (continued)']);
    expect(pages[2].at(-1).label).toBe('Total 10100');
  });
});

describe('Flux explanations (item 26b)', () => {
  it('reads Explained once a flagged line has an explanation, and splits the count', () => {
    const result = {
      flux: { period: 'p' },
      summary: [{ label: 'Flagged', value: '2' }],
      rows: [
        { kind: 'account', code: '61000', flag: true, values: [1, 2, 3, '4%', 'Review', ''] },
        { kind: 'account', code: '62000', flag: true, values: [1, 2, 3, '4%', 'Review', ''] },
        { kind: 'account', code: '41000', flag: false, values: [1, 1, 0, '', '', ''] },
      ],
    };
    const r = withFluxNotes(result, { 61000: 'Roof repair.', 41000: 'Steady.' });
    expect(r.rows.map((x) => x.values[4])).toEqual(['Explained', 'Review', '']);
    expect(r.rows[0].explained).toBe(true);
    expect(r.rows[2].values[5]).toBe('Steady.');
    expect(r.summary[0].value).toBe('1 to review · 1 explained');
  });
});

describe('amount filters with an operator (item 26d)', () => {
  it('compares figures', () => {
    expect(parseFigure('(3,418.07)')).toBe(-3418.07);
    expect(parseFigure('19.8%')).toBe(19.8);
    expect(Number.isNaN(parseFigure('-'))).toBe(true);
    expect(numberFilterHit(1500, { op: '>', a: '1,000' })).toBe(true);
    expect(numberFilterHit(500, { op: '>', a: '1,000' })).toBe(false);
    expect(numberFilterHit(-3418.07, { op: '=', a: '3418.07' })).toBe(true);
    expect(numberFilterHit(3418.07, { op: '=', a: '-3418.07' })).toBe(false);
    expect(numberFilterHit(1000, { op: '<=', a: '1000' })).toBe(true);
    expect(numberFilterHit(250, { op: 'between', a: '100', b: '300' })).toBe(true);
    expect(numberFilterHit(350, { op: 'between', a: '300', b: '100' })).toBe(false);
    expect(numberFilterHit('(93.3%)', { op: '<', a: '-50' })).toBe(true);
    expect(numberFilterHit(5, { op: '>', a: '' })).toBe(true);
    expect(numberFilterHit('', { op: '>', a: '1' })).toBe(false);
  });
});

describe('Statement of Cash Flows (item 26c)', () => {
  const pnl = { sections: [
    { key: 'revenue', accounts: [{ account_no: '41000', title: 'Rental Income', amount: 10000 }] },
    { key: 'expense', accounts: [{ account_no: '61000', title: 'Repairs', amount: 2000 }, { account_no: '68000', title: 'Depreciation Expense', amount: 1000 }] },
  ] };
  const bs = (cash, ar, bldg, acc, ap, loan, capital) => ({ sections: [
    { key: 'asset', accounts: [{ account_no: '10100', title: 'Chase Operating', amount: cash }, { account_no: '12000', title: 'Accounts Receivable', amount: ar }, { account_no: '15000', title: 'Buildings', amount: bldg }, { account_no: '15900', title: 'Accumulated Depreciation - Buildings', amount: acc }] },
    { key: 'liability', accounts: [{ account_no: '20100', title: 'Accounts Payable', amount: ap }, { account_no: '25000', title: 'Mortgage Loan - Chase', amount: loan }] },
    { key: 'equity', accounts: [{ account_no: '30000', title: 'Members Capital', amount: capital }, { account_no: '', title: 'Current year earnings (2026)', amount: 0 }] },
  ] });

  it('runs from net income to the change in cash, and ties to Cash Position', () => {
    // NI 7,000; D&A 1,000; AR +500 (use); AP +300 (source); building +4,000
    // (investing); loan -1,000 (financing); capital +200 (financing).
    const f = cashFlowFigures({
      pnl,
      bsBegin: bs(5000, 1000, 50000, -10000, 2000, 30000, 20000),
      bsEnd: bs(8000, 1500, 54000, -11000, 2300, 29000, 20200),
      cashBegin: { accounts: [{ gl_code: '10100' }], total: 5000 },
      cashEnd: { accounts: [{ gl_code: '10100' }], total: 8000 },
    });
    expect(f.netIncome).toBe(7000);
    expect(f.operating.lines.map((l) => [l.title, l.amount])).toEqual([['Net Income', 7000], ['Depreciation Expense', 1000], ['Accounts Receivable', -500], ['Accounts Payable', 300]]);
    expect(f.operating.total).toBe(7800);
    expect(f.investing).toEqual({ lines: [{ code: '15000', title: 'Buildings', amount: -4000 }], total: -4000 });
    expect(f.financing.total).toBe(-800);
    expect([f.beginCash, f.netChange, f.endCash]).toEqual([5000, 3000, 8000]);
    expect(f.unexplained).toBe(0);
  });

  it('is a report: sections, net change, beginning and ending cash', async () => {
    const api = {
      getAccountingPnl: vi.fn(async () => pnl),
      getAccountingBalanceSheet: vi.fn(async (asof) => (asof < '2026-01-01' ? bs(5000, 1000, 50000, -10000, 2000, 30000, 20000) : bs(8000, 1500, 54000, -11000, 2300, 29000, 20200))),
      getAccountingCashPosition: vi.fn(async (asof) => (asof < '2026-01-01' ? { accounts: [{ gl_code: '10100' }], total: 5000 } : { accounts: [{ gl_code: '10100' }], total: 8000 })),
    };
    const r = await runReport(api, resolveConfig({ ...defaultConfig(NOW), report: 'cash-flow' }, NOW));
    expect(api.getAccountingBalanceSheet.mock.calls.map((c) => c[0])).toEqual(['2025-12-31', '2026-10-06']);
    expect(r.rows.filter((x) => x.kind === 'section').map((x) => [x.label, x.values[0]])).toEqual([
      ['Cash Flows From Operating Activities', 7800], ['Cash Flows From Investing Activities', -4000], ['Cash Flows From Financing Activities', -800],
    ]);
    expect(r.rows.at(-1)).toMatchObject({ kind: 'grand', values: [8000] });
    expect(r.rows.find((x) => x.label === 'Net Change in Cash').values).toEqual([3000]);
    expect(r.rows.some((x) => x.kind === 'warn')).toBe(false);
  });
});

describe('books (item 35)', () => {
  it('lists the books the accounting app offers and keeps a memorized one', () => {
    setUserBooks([{ key: 'fmv', label: 'Fair Market Journal' }, { key: 'cash', label: 'Cash' }]);
    expect(bookOptions().map((b) => b.key)).toEqual(['accrual', 'cash', 'fmv', 'both']);
    expect(bookLabel('fmv')).toBe('Fair Market Journal');
    expect(resolveConfig({ book: 'fmv' }, NOW).book).toBe('fmv');
    expect(resolveConfig({ book: 'nope' }, NOW).book).toBe('accrual');
    setUserBooks([]);
  });

  it('reads a user book through the generic report read', async () => {
    setUserBooks([{ key: 'fmv', label: 'Fair Market Journal' }]);
    const api = { readAccountingReport: vi.fn(async () => ({ sections: [] })), getAccountingPnl: vi.fn() };
    await runReport(api, resolveConfig({ ...defaultConfig(NOW), book: 'fmv' }, NOW));
    expect(api.readAccountingReport).toHaveBeenCalledWith('pnl', expect.objectContaining({ book: 'fmv' }));
    expect(api.getAccountingPnl).not.toHaveBeenCalled();
    setUserBooks([]);
  });
});

describe('Actual vs Budget (item 43)', () => {
  const pnl = { sections: [{ key: 'revenue', accounts: [{ account_no: '41000', title: 'Rental Income', amount: 1200 }] }] };
  it('uses the Intacct budget when the accounting app has one', async () => {
    const api = {
      getAccountingPnl: vi.fn(async () => pnl),
      getAccountingReportBudget: vi.fn(async () => ({ budget_id: 'STD', rows: [{ account_no: '41000', title: 'Rental Income', section: 'revenue', month: '2026-01-01', amount: 1000 }] })),
      getAccountingBudget: vi.fn(),
    };
    const r = await runReport(api, resolveConfig({ ...defaultConfig(NOW), cols: 'budget', entities: ['15000'] }, NOW));
    expect(r.columns.map((c) => c.label)).toEqual(['Actual', 'Budget', '$ Variance', '% Variance']);
    expect(r.rows.find((x) => x.code === '41000').values.slice(0, 3)).toEqual([1200, 1000, 200]);
    expect(r.notes[0]).toMatch(/Intacct budget STD/);
    expect(api.getAccountingBudget).not.toHaveBeenCalled();
  });

  it('falls back to the budget saved in Nexus, labeled so', async () => {
    const months = Array(12).fill(0);
    months[0] = 300;
    months[11] = 999;   // December is after the period (YTD through 10/06)
    const api = {
      getAccountingPnl: vi.fn(async () => pnl),
      getAccountingReportBudget: vi.fn(async () => ({ available: false, rows: [] })),
      getAccountingBudget: vi.fn(async () => ({ source: 'nexus', rows: [{ accountNo: '41000', title: 'Rental Income', section: 'revenue', months }] })),
    };
    const r = await runReport(api, resolveConfig({ ...defaultConfig(NOW), cols: 'budget', entities: ['15000'] }, NOW));
    expect(r.columns[1].label).toBe('Budget (Nexus)');
    expect(r.rows.find((x) => x.code === '41000').values[1]).toBe(300);
    expect(r.notes[0]).toMatch(/saved in Nexus/);
  });
});
