import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render-smoke for Accounting -> Reports.
//   Sep 25 morning (Neil): code and name on one line, sections fold on click,
//   every amount drills, a drill requested from another tab opens its lines.
//   Sep 25 call (Neil, Charmi): every control is a dropdown on one row, there
//   is no Refresh and no chip row, the book is Accrual / Cash / both, the
//   custom dates are not capped by each other, the search shows it is
//   working, and Memorize keeps the view.
//   Sep 29 (Visesh): the row has the accounting app's filters - the period
//   stepper, Columns, accounts, Customize, full screen - and the figures line
//   sits above the statement.
//   Sep 30 (call of 09/29): Dimensions is Filters with Department inside,
//   entities read in number order without the historical ones, the filters in
//   force are chips with an X, zero balances hide until Show is ticked, and
//   Export is one menu (Excel, CSV, PDF).

const pnl = {
  org: 'Greens Global',
  generated_at: '2026-09-25',
  sections: [
    { key: 'revenue', label: 'Revenue', total: 1500, accounts: [{ account_no: '41000', title: 'Rental Income', amount: 1000 }, { account_no: '41100', title: 'Parking Income', amount: 500 }] },
    { key: 'expense', label: 'Operating Expenses', total: 400, accounts: [{ account_no: '61000', title: 'Repairs', amount: 400 }] },
  ],
  totals: { gross_profit: 1500, operating_income: 1100, net_income: 1100 },
};
const cash = { ...pnl, sections: [{ ...pnl.sections[0], total: 1200, accounts: [{ account_no: '41000', title: 'Rental Income', amount: 1200 }] }, pnl.sections[1]] };

vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [
      { code: '32000', name: 'Greens Capital', parent_code: null }, { code: '15000', name: 'Greens Escondido', parent_code: null },
      { code: 'H15001', name: '(H) Old Escondido', parent_code: '15000' }, { code: '15020', name: 'Escondido North', parent_code: '15000' },
    ] })),
    getAccountingPnl: vi.fn(async (from, to, location, dims, book) => (book === 'cash' ? cash : pnl)),
    getAccountingBalanceSheet: vi.fn(async () => ({ sections: [], totals: {} })),
    getAccountingCashPosition: vi.fn(async () => ({ accounts: [], total: 0 })),
    getAccountingTrialBalance: vi.fn(async () => ({ rows: [], totals: {} })),
    getAccountingBuckets: vi.fn(async ({ by }) => (by === 'employee'
      ? {
        org: 'Greens Global', generated_at: '2026-09-25', labels: { E1: 'Amy Bolanos', E2: 'Ashley Vizcarra', E3: 'Someone Else' },
        rows: [
          { account_no: '61000', title: 'Repairs', section: 'expense', bucket: 'E1', debit: 100, credit: 0 },
          { account_no: '61000', title: 'Repairs', section: 'expense', bucket: 'E2', debit: 250, credit: 0 },
          { account_no: '61000', title: 'Repairs', section: 'expense', bucket: 'E3', debit: 999, credit: 0 },
        ],
      }
      : {
        org: 'Greens Global', generated_at: '2026-09-25', labels: {},
        rows: [
          { account_no: '41000', title: 'Rental Income', section: 'revenue', bucket: '2026-08-01', debit: 0, credit: 600 },
          { account_no: '41000', title: 'Rental Income', section: 'revenue', bucket: '2026-09-01', debit: 0, credit: 400 },
          { account_no: '61000', title: 'Repairs', section: 'expense', bucket: '2026-09-01', debit: 250, credit: 0 },
        ],
      })),
    getAccountingDimensionValues: vi.fn(async (kind) => (kind === 'department'
      ? { values: [{ code: '9100', name: 'Property Management' }, { code: '9500', name: 'Old Division (H)' }] }
      : kind === 'employee'
        ? { values: [{ code: 'E1', name: 'Amy Bolanos' }, { code: 'E2', name: 'Ashley Vizcarra' }] }
        : { values: [{ code: 'C-1', name: 'Valley Center' }, { code: 'C-2', name: 'Old Program (H)' }] })),
    getAccountingJournals: vi.fn(async () => ({ available: true, journals: [
      { symbol: 'GJ', title: 'General Journal', kind: 'general' }, { symbol: 'APJ', title: 'Accounts Payable', kind: 'ap' },
      { symbol: 'ARJ', title: 'Accounts Receivable', kind: 'ar' }, { symbol: 'STAT', title: 'Units', kind: 'statistical' },
    ] })),
    getAccountingFluxNotes: vi.fn(async () => ({ notes: [{ accountNo: '41100', note: 'New tenant in suite B.' }] })),
    saveAccountingFluxNote: vi.fn(async (body) => ({ accountNo: body.accountNo, note: body.note, by: 'me', at: '2026-10-02' })),
    egnyteFolder: vi.fn(async (path) => ({ path, folders: [{ name: '2026', path: `${path}/2026` }, { name: 'Lenders', path: `${path}/Lenders` }], files: [] })),
    egnyteCreateFolder: vi.fn(async (path) => ({ path })),
    egnyteUpload: vi.fn(async (folder, file) => ({ path: `${folder}/${file.name}`, webUrl: 'https://greens.egnyte.com/navigate/file/abc' })),
    searchAccountingLedger: vi.fn(async () => ({ rows: [], total: 0, facets: {} })),
    getAccountingSavedReports: vi.fn(async () => []),
    saveAccountingReport: vi.fn(async (body) => ({ id: 'r1', ...body, mine: true })),
    updateAccountingSavedReport: vi.fn(async (id, body) => ({ id, ...body })),
    shareAccountingReport: vi.fn(async (body) => ({ report: { id: 'r7', name: body.name }, recipient: body.recipient })),
    emailAccountingReport: vi.fn(async () => ({ ok: true, to: ['lender@bank.com'], from: 'me@greensglobal.com' })),
    deleteAccountingSavedReport: vi.fn(async () => ({})),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (prefs) => ({ prefs })),
    getRolesDirectory: vi.fn(async () => []),
    getPeopleDirectory: vi.fn(async () => [{ email: 'urmi.gor@greensglobal.com', name: 'Urmi Gor' }]),
  },
}));
const LINES_TABLE = {
  title: 'Ledger Lines - 61000 Repairs', period: '01-01-2026 - 08-31-2026', subtitle: 'All entities',
  columns: [{ label: 'Date', width: 96 }, { label: 'Debit', num: true, width: 118 }], rows: [['08/19/2026', 22.46]], totals: ['Totals - 1 lines', 22.46],
};
vi.mock('./LedgerSearch', async () => {
  const { useEffect } = await import('react');
  function LedgerSearchMock({ drill, term, onBusy, onExport, initialEntry }) {
    onBusy?.(false);
    // The real grid hands the report's Export menu a builder for its lines.
    useEffect(() => { onExport?.({ build: async () => LINES_TABLE, lines: 1, name: 'Ledger Lines - 61000 Repairs', title: 'Ledger Lines - 61000 Repairs' }); return () => onExport?.(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <div data-testid="ledger-search" data-from={drill?.from} data-drill-dims={JSON.stringify(drill?.dims || null)} data-party={drill?.party?.code || ''} data-entry={initialEntry?.id || ''}>{drill ? `drill:${drill.account}:${drill.to}:${drill.book}` : `search:${term}`}</div>;
  }
  return { default: LedgerSearchMock };
});
// Save to Files browses with the Files screen's own browser; here, a stand-in that picks Lenders.
vi.mock('../../egnyte/EgnyteFolderPick', () => ({
  default: ({ startPath, showTree, onPick }) => (
    <div role="dialog" aria-label="Files Picker" data-start={startPath} data-tree={String(!!showTree)}>
      <button type="button" onClick={() => onPick('/Shared/Accounting/Reports/Lenders')}>Use This Folder</button>
    </div>
  ),
}));

import ReportsTab from './ReportsTab';
import { api } from '../../api';
import { requestReportDrill, requestLedgerSearch } from './drill';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => { localStorage.clear(); resetAccountingPrefs(); vi.clearAllMocks(); window.scrollTo = vi.fn(); });

describe('ReportsTab statement table', () => {
  it('puts the GL code and the name on one line, folds a section, drills from an amount', async () => {
    render(<ReportsTab />);
    const cell = await screen.findByText('Rental Income');
    const label = cell.closest('td');
    expect(label.className).toContain('acct-label');
    expect(within(label).getByText('41000').className).toContain('acct-code');
    // Compact by default, dense rows; the choice sits behind Customize.
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    expect(screen.getByRole('button', { name: 'Compact' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));

    // Fold Revenue: its accounts disappear, the total stays, the count shows.
    fireEvent.click(screen.getByRole('button', { name: 'Fold Revenue' }));
    expect(screen.queryByText('Rental Income')).toBeNull();
    expect(screen.queryByText('Parking Income')).toBeNull();
    expect(screen.getAllByText('1,500.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Expand All')).toBeTruthy();
    fireEvent.click(screen.getByText('Expand All'));
    expect(screen.getByText('Rental Income')).toBeTruthy();

    // Every account amount is a drill button.
    fireEvent.click(within(screen.getByText('Repairs').closest('tr')).getByRole('button', { name: '400.00' }));
    expect(screen.getByTestId('ledger-search').textContent).toContain('drill:61000');
  });

  it('narrows the statement with the contains boxes under the headings (Charmi, 10/02)', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.change(screen.getByLabelText('Filter Account'), { target: { value: 'repa' } });
    expect(screen.getByText('Repairs')).toBeTruthy();
    expect(screen.queryByText('Rental Income')).toBeNull();
    expect(screen.getByText(/Filtered to 1 row\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear column filters' }));
    expect(screen.getByText('Rental Income')).toBeTruthy();
  });

  it('drills from every figure - a section total, Net Income - into the period with no account (Charmi, 10/02)', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    // The Revenue heading's total opens every line of the period.
    fireEvent.click(within(screen.getByRole('button', { name: 'Fold Revenue' }).closest('tr')).getByRole('button', { name: '1,500.00' }));
    expect(screen.getByTestId('ledger-search').textContent).toMatch(/^drill::/);
  });

  it('opens the drill a widget on another tab asked for', async () => {
    requestReportDrill({ account: '11452', accountName: 'GC Chase Chkg', from: '', to: '2026-08-31', entity: '32000' });
    render(<ReportsTab />);
    await waitFor(() => expect(screen.getByTestId('ledger-search').textContent).toBe('drill:11452:2026-08-31:accrual'));
  });

  it('opens the search the dashboard\'s Find a Transaction tile handed over, with the tapped entry on top', async () => {
    // Parked before Reports mounts (the tile lives on the dashboard).
    requestLedgerSearch({ q: 'sunbelt 2840', entryId: 'e1', entryNo: 'IA-1293173' });
    render(<ReportsTab />);
    await waitFor(() => expect(screen.getByTestId('ledger-search').textContent).toBe('search:sunbelt 2840'));
    expect(screen.getByTestId('ledger-search').dataset.entry).toBe('e1');
    expect(screen.getByLabelText('Search the ledger').value).toBe('sunbelt 2840');
    // Already on screen: the event alone carries the next one, words only.
    requestLedgerSearch({ q: 'amazon' });
    await waitFor(() => expect(screen.getByTestId('ledger-search').textContent).toBe('search:amazon'));
    expect(screen.getByTestId('ledger-search').dataset.entry).toBe('');
  });
});

describe('Cross-tab drill with filters (Oct 7)', () => {
  it('carries a party and the report filters from another tab into the lines', async () => {
    requestReportDrill({ accountName: 'Rent', from: '2026-01-01', to: '2026-01-31', entity: '32000', party: { kind: 'customer', code: 'C1', name: 'Tenant One' }, dims: { departments: ['9500'], journals: ['ARJ'] } });
    render(<ReportsTab />);
    await waitFor(() => expect(screen.getByTestId('ledger-search').dataset.party).toBe('C1'));
    expect(JSON.parse(screen.getByTestId('ledger-search').dataset.drillDims)).toEqual({ departments: ['9500'], journals: ['ARJ'] });
  });
});

describe('ReportsTab controls', () => {
  it('is one row of dropdowns: report by name, no chips, no Refresh', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    const report = screen.getByLabelText('Report');
    expect(report.tagName).toBe('SELECT');
    expect([...report.options].map((o) => o.textContent)).toEqual(['Income Statement', 'Balance Sheet', 'Trial Balance', 'General Ledger', 'Cash Position', 'Flux Analysis', 'Statement of Cash Flows']);
    expect(screen.queryByText('Profit & Loss')).toBeNull();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    expect(screen.queryByText(/add filter/i)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Income Statement' })).toBeTruthy();
  });

  it('reads the cash book, and both books side by side', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    const book = screen.getByLabelText('Book');
    expect([...book.options].map((o) => o.textContent)).toEqual(['Accrual', 'Cash', 'Accrual and Cash']);
    fireEvent.change(book, { target: { value: 'both' } });
    await screen.findByRole('columnheader', { name: 'Cash' });
    expect(screen.getByRole('columnheader', { name: 'Accrual' })).toBeTruthy();
    const row = screen.getByText('Rental Income').closest('tr');
    expect(within(row).getByText('1,000.00')).toBeTruthy();
    expect(within(row).getByText('1,200.00')).toBeTruthy();
    // Two books leave no room for more columns.
    expect(screen.queryByLabelText('Columns')).toBeNull();
    // The cash amount drills into the cash book.
    fireEvent.click(within(row).getByText('1,200.00'));
    expect(screen.getByTestId('ledger-search').textContent).toMatch(/^drill:41000:.*:cash$/);
  });

  it('lets the custom dates move freely', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'custom' } });
    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    // A calendar capped at the other date could not move to a later month.
    expect(from.getAttribute('max')).toBeNull();
    expect(to.getAttribute('min')).toBeNull();
    fireEvent.change(from, { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-31' } });
    await waitFor(() => expect(api.getAccountingPnl).toHaveBeenLastCalledWith('2026-08-01', '2026-08-31', undefined, null, 'accrual'));
    // A start after the end takes the end with it.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-10' } });
    await waitFor(() => expect(api.getAccountingPnl).toHaveBeenLastCalledWith('2026-09-10', '2026-09-10', undefined, null, 'accrual'));
  });

  it('picks several entities from a searchable dropdown', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: 'Entities' }));
    fireEvent.change(screen.getByLabelText('Search entity by name or code'), { target: { value: 'escon' } });
    expect(screen.queryByRole('option', { name: /Greens Capital/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /Greens Escondido/ }));
    await waitFor(() => expect(api.getAccountingPnl.mock.calls.at(-1)[2]).toBe('15000'));
    fireEvent.change(screen.getByLabelText('Search entity by name or code'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('option', { name: /Greens Capital/ }));
    await waitFor(() => expect(api.getAccountingPnl.mock.calls.at(-1)[3]?.locations).toEqual(['15000', '32000']));
  });

  it('lists entities in number order, without the historical ones unless Customize shows them', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: 'Entities' }));
    const names = () => within(screen.getByRole('listbox', { name: 'Entities' })).getAllByRole('option').map((o) => o.textContent);
    expect(names()).toEqual(['15000Greens Escondido', '15020Escondido North', '32000Greens Capital']);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    fireEvent.click(screen.getByLabelText(/Show historical entities/i));
    fireEvent.click(screen.getByRole('button', { name: 'Entities' }));
    expect(names()).toEqual(['15000Greens Escondido', '15020Escondido North', 'H15001(H) Old Escondido', '32000Greens Capital']);
  });

  it('shows the filters in force as chips that come off in one click', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: 'Entities' }));
    fireEvent.click(screen.getByRole('option', { name: /Greens Escondido/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    const chips = await screen.findByLabelText('Active filters');
    expect(chips.textContent).toContain('Entity: Greens Escondido (15000)');
    fireEvent.click(within(chips).getByRole('button', { name: 'Remove Entity: Greens Escondido (15000)' }));
    await waitFor(() => expect(screen.queryByLabelText('Active filters')).toBeNull());
    await waitFor(() => expect(api.getAccountingPnl.mock.calls.at(-1)[2]).toBeUndefined());
  });

  it('splits one picked entity into its sub-entities By Entity', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: 'Entities' }));
    fireEvent.click(screen.getByRole('option', { name: /Greens Escondido/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.change(screen.getByLabelText('Columns'), { target: { value: 'entity' } });
    await waitFor(() => expect(api.getAccountingBuckets.mock.calls.at(-1)[0]).toMatchObject({ by: 'entity', dims: { locations: ['15000', '15020'] } }));
  });

  it('hides historical (H) classes in the filter lists', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: /Project-Job/ }));
    await screen.findByRole('option', { name: /Valley Center/ });
    expect(screen.queryByRole('option', { name: /Old Program/ })).toBeNull();
  });

  it('memorizes the view on screen', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.change(screen.getByLabelText('Book'), { target: { value: 'cash' } });
    fireEvent.click(screen.getByRole('button', { name: /Memorize/ }));
    const name = screen.getByLabelText('What would you like to name it?');
    fireEvent.change(name, { target: { value: 'GG Cash Income Statement' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveAccountingReport).toHaveBeenCalled());
    const body = api.saveAccountingReport.mock.calls[0][0];
    expect(body.name).toBe('GG Cash Income Statement');
    expect(body.shared).toBe(false);
    // The controls are kept, a named period by its name - never the figures.
    expect(body.config).toMatchObject({ report: 'pnl', preset: 'ytd', book: 'cash', cols: 'total', entities: [] });
    expect(body.config.from).toBeUndefined();
  });

  it('has the periods of the accounting app, and arrows that step through them', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    const period = screen.getByLabelText('Period');
    expect([...period.options].map((o) => o.textContent.split(' · ')[0])).toEqual([
      'This Month', 'Last Month', 'Month-to-Date', 'This Quarter', 'Last Quarter', 'Quarter-to-Date', 'This Year', 'Year-to-Date', 'Last Year', 'Trailing 12 Months', 'Custom Dates',
    ]);
    const year = new Date().getFullYear();
    fireEvent.change(period, { target: { value: 'last-year' } });
    await waitFor(() => expect(api.getAccountingPnl.mock.calls.at(-1).slice(0, 2)).toEqual([`${year - 1}-01-01`, `${year - 1}-12-31`]));
    fireEvent.click(screen.getByRole('button', { name: 'Previous period' }));
    await waitFor(() => expect(api.getAccountingPnl.mock.calls.at(-1).slice(0, 2)).toEqual([`${year - 2}-01-01`, `${year - 2}-12-31`]));
    // The stepped period shows as dates that can be edited.
    expect(screen.getByLabelText('From').value).toBe(`${year - 2}-01-01`);
  });

  it('lays the statement out by month, each amount drilling into its month', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    const columns = screen.getByLabelText('Columns');
    expect([...columns.options].map((o) => o.textContent).slice(0, 6)).toEqual(['Total Only', 'By Month', 'By Quarter', 'By Year', 'By Entity', 'By Department']);
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-25' } });
    fireEvent.change(columns, { target: { value: 'month' } });
    await screen.findByRole('columnheader', { name: 'Sep 2026' });
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Account', 'Sep 2026', 'Aug 2026', 'Total']);
    expect(api.getAccountingBuckets.mock.calls.at(-1)[0]).toMatchObject({ from: '2026-08-01', to: '2026-09-25', by: 'month', book: 'accrual' });
    const row = screen.getByText('Rental Income').closest('tr');
    expect([...row.querySelectorAll('td.acct-num')].map((c) => c.textContent)).toEqual(['400.00', '600.00', '1,000.00']);
    fireEvent.click(within(row).getByText('600.00'));
    const lines = screen.getByTestId('ledger-search');
    expect(lines.textContent).toBe('drill:41000:2026-08-31:accrual');
    expect(lines.getAttribute('data-from')).toBe('2026-08-01');
  });

  it('offers the balance sheet its own column layouts', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'balance-sheet' } });
    await waitFor(() => expect([...screen.getByLabelText('Columns').options].map((o) => o.textContent)).toEqual([
      'Total Only', 'By Entity', 'By Department', 'Last 12 Month-Ends', 'Last 4 Quarter-Ends', 'vs Prior Month-End', 'vs Same Date Last Year', 'vs Last Year-End',
    ]));
    expect(screen.getByRole('button', { name: 'Previous month-end' })).toBeTruthy();
    // A trial balance has one layout, so the dropdown is not shown.
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'trial-balance' } });
    await waitFor(() => expect(screen.queryByLabelText('Columns')).toBeNull());
  });

  it('filters by department from Filters and by account from its own dropdown', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: /^Department/ }));
    await screen.findByRole('option', { name: /Property Management/ });
    expect(screen.queryByRole('option', { name: /Old Division/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /Property Management/ }));
    await waitFor(() => expect(api.getAccountingPnl.mock.calls.at(-1)[3]?.departments).toEqual(['9100']));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    fireEvent.click(screen.getByRole('button', { name: 'Accounts' }));
    // Every account of the statement, under its section.
    expect(within(screen.getByRole('listbox', { name: 'Accounts' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['Rental Income41000', 'Parking Income41100', 'Repairs61000']);
    fireEvent.click(screen.getByRole('option', { name: /Repairs/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('Rental Income')).toBeNull());
    expect(screen.getByText('Repairs')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accounts' }).textContent).toContain('Account 61000');
  });

  it('shows the figures above the statement, shows zero balances on request, fills the screen', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    expect(screen.getByLabelText('Summary').textContent).toBe('Revenue 1,500.00Expenses 400.00Net Income 1,100.00Net Margin 73.3%');
    expect(screen.getByText('Net Profit Margin %').closest('tr').textContent).toContain('73.3%');
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    fireEvent.click(screen.getByLabelText(/Show zero balances/i));
    fireEvent.click(screen.getByRole('button', { name: /Memorize/ }));
    fireEvent.change(screen.getByLabelText('What would you like to name it?'), { target: { value: 'With Zeros' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveAccountingReport).toHaveBeenCalled());
    expect(api.saveAccountingReport.mock.calls[0][0].config.showZero).toBe(true);
    // One Export menu holds the three formats.
    fireEvent.click(screen.getByRole('button', { name: /^Export/ }));
    expect(within(screen.getByRole('menu', { name: 'Export' })).getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'ExcelTotals in bold, columns fitted, live formulas', 'CSVPlain values, one row per line', 'PDFLaid out like a page of a package',
      'Email...From your own mailbox, statement attached', 'Save to Files...Into a folder in Files, named as you like', 'Share With a Teammate...Memorized for the team, with a bell notice',
    ]);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Fill the screen' }));
    expect(screen.getByRole('button', { name: 'Back to window size' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('offers to save the changes to a memorized report, and manages them on their own screen', async () => {
    const memorized = { id: 'r9', name: 'GG Cash', mine: true, shared: false, owner: 'me', updatedAt: '2026-09-29', config: { report: 'pnl', preset: 'ytd', book: 'cash', cols: 'total', entities: [], dims: {} } };
    api.getAccountingSavedReports.mockResolvedValue([memorized]);
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: /Saved Reports/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /GG Cash/ }));
    await waitFor(() => expect(screen.getByLabelText('Book').value).toBe('cash'));
    expect(screen.queryByText(/Do you want to save your changes/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Book'), { target: { value: 'accrual' } });
    await screen.findByText(/Do you want to save your changes/);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.updateAccountingSavedReport).toHaveBeenCalledWith('r9', { config: expect.objectContaining({ book: 'accrual' }) }));
    await waitFor(() => expect(screen.queryByText(/Do you want to save your changes/)).toBeNull());
    // The management screen: every saved report, renamed in place.
    fireEvent.click(screen.getByRole('button', { name: /Saved Reports/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage Saved Reports...' }));
    const dialog = await screen.findByRole('dialog', { name: 'Saved Reports' });
    expect(within(dialog).getAllByRole('row')).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename GG Cash' }));
    fireEvent.change(within(dialog).getByLabelText('New name'), { target: { value: 'GG Cash Income' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(api.updateAccountingSavedReport).toHaveBeenCalledWith('r9', { name: 'GG Cash Income' }));
  });

  it('shares the view on screen with a teammate from the Export menu', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: /^Export/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Share With a Teammate/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Share With a Teammate' });
    const who = within(dialog).getByLabelText('Share With');
    await waitFor(() => expect(who.options.length).toBe(2));
    fireEvent.change(who, { target: { value: 'urmi.gor@greensglobal.com' } });
    fireEvent.change(within(dialog).getByLabelText('Saved As'), { target: { value: 'September P&L' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(api.shareAccountingReport).toHaveBeenCalled());
    expect(api.shareAccountingReport.mock.calls[0][0]).toMatchObject({ recipient: 'urmi.gor@greensglobal.com', name: 'September P&L', config: { report: 'pnl' } });
    await screen.findByText(/Shared "September P&L"/);
  });

  it('shows the search is working from the first keystroke', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.change(screen.getByLabelText('Search the ledger'), { target: { value: '500' } });
    expect(screen.getByLabelText('Searching')).toBeTruthy();
    // A short word waits a little longer for the rest of it before the ledger is asked.
    expect(screen.queryByTestId('ledger-search')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('ledger-search').textContent).toBe('search:500'), { timeout: 2500 });
  });

  // ── 10/02 batch (Charmi, Neil) ─────────────────────────────────────────────
  it('reads Entities, Filters, then Accounts last on the toolbar (R3)', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    const order = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    const at = (name) => order.indexOf(name);
    expect(at('Entities')).toBeGreaterThan(-1);
    expect(at('Entities')).toBeLessThan(at('Filters'));
    expect(at('Filters')).toBeLessThan(at('Accounts'));
  });

  it('turns two picked employees into one column each plus a Total, and says so on Columns (R1)', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: /^Employee/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Amy Bolanos/ }));
    // One pick stays combined.
    expect(screen.getByLabelText('Columns').value).toBe('total');
    fireEvent.click(screen.getByRole('option', { name: /Ashley Vizcarra/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    const columns = screen.getByLabelText('Columns');
    expect(columns.value).toBe('employee');
    expect(columns.selectedOptions[0].textContent).toBe('By Employee (2 picked)');
    await screen.findByRole('columnheader', { name: 'Amy Bolanos' });
    expect(api.getAccountingBuckets.mock.calls.at(-1)[0]).toMatchObject({ by: 'employee', dims: { employee: ['E1', 'E2'] } });
    // A column per PICKED employee; a stray third bucket never adds into the Total.
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Account', 'Amy Bolanos', 'Ashley Vizcarra', 'Total']);
    const row = screen.getByText('Repairs').closest('tr');
    expect([...row.querySelectorAll('td.acct-num')].map((c) => c.textContent)).toEqual(['100.00', '250.00', '350.00']);
    // "Total Only" picked on purpose still combines them.
    fireEvent.change(columns, { target: { value: 'total' } });
    await waitFor(() => expect(api.getAccountingPnl.mock.calls.at(-1)[3]?.employee).toEqual(['E1', 'E2']));
    expect(screen.getByLabelText('Columns').value).toBe('total');
  });

  it('keeps historical (H) accounts off the Accounts list until Customize shows them, and never prints "hidden" (R4)', async () => {
    api.getAccountingPnl.mockResolvedValue({ ...pnl, sections: [{ ...pnl.sections[0], accounts: [...pnl.sections[0].accounts, { account_no: '49000', title: 'Old Income (H)', amount: 5 }] }, pnl.sections[1]] });
    render(<ReportsTab />);
    await screen.findByText('Old Income (H)');
    fireEvent.click(screen.getByRole('button', { name: 'Accounts' }));
    const names = () => within(screen.getByRole('listbox', { name: 'Accounts' })).getAllByRole('option').map((o) => o.textContent);
    expect(names()).toEqual(['Rental Income41000', 'Parking Income41100', 'Repairs61000']);
    expect(within(screen.getByRole('listbox', { name: 'Accounts' })).queryByText(/hidden/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    fireEvent.click(screen.getByLabelText(/Show historical accounts/i));
    fireEvent.click(screen.getByRole('button', { name: 'Accounts' }));
    expect(names()).toEqual(['Rental Income41000', 'Parking Income41100', 'Old Income (H)49000', 'Repairs61000']);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    // The Filters lists follow the same switch.
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: /Project-Job/ }));
    await screen.findByRole('option', { name: /Old Program/ });
    expect(within(screen.getByRole('dialog', { name: 'Filters' })).queryByText(/hidden/i)).toBeNull();
  });

  it('says where the file goes in Files, renames it, and browses with the Files browser (R2; Charmi 10/02)', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: /^Export/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Save to Files/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Save to Files' });
    const d = new Date();
    const today = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`;
    const line = within(dialog).getByLabelText('Where the file will be saved');
    expect(line.textContent).toBe(`Will be saved as /Shared/Accounting/Reports/Income Statement - All entities - 01-01-${d.getFullYear()} to ${today}.pdf`);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Excel' }));
    expect(line.textContent).toMatch(/\.xlsx$/);
    // Browse opens the Files browser, tree and all, at the folder in the box; picking fills the box.
    fireEvent.click(within(dialog).getByRole('button', { name: /Browse/ }));
    const picker = screen.getByRole('dialog', { name: 'Files Picker' });
    expect(picker.dataset.start).toBe('/Shared/Accounting/Reports');
    expect(picker.dataset.tree).toBe('true');
    fireEvent.click(within(picker).getByRole('button', { name: 'Use This Folder' }));
    expect(screen.queryByRole('dialog', { name: 'Files Picker' })).toBeNull();
    expect(within(dialog).getByLabelText('Folder').value).toBe('/Shared/Accounting/Reports/Lenders');
    expect(line.textContent).toMatch(/^Will be saved as \/Shared\/Accounting\/Reports\/Lenders\/Income Statement/);
    // Rename: the name box sets the file's name; the extension follows the format.
    fireEvent.change(within(dialog).getByLabelText('File Name'), { target: { value: 'September Lender Pack' } });
    expect(line.textContent).toBe('Will be saved as /Shared/Accounting/Reports/Lenders/September Lender Pack.xlsx');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save to Files' }));
    await waitFor(() => expect(api.egnyteUpload).toHaveBeenCalled());
    const [folder, file] = api.egnyteUpload.mock.calls.at(-1);
    expect(folder).toBe('/Shared/Accounting/Reports/Lenders');
    expect(file.name).toBe('September Lender Pack.xlsx');
  });

  it('exports a drill-down from the one Export menu at the top, every format (Charmi, 10/02)', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.click(within(screen.getByText('Repairs').closest('tr')).getByRole('button', { name: '400.00' }));
    await screen.findByTestId('ledger-search');
    const exportBtn = screen.getByRole('button', { name: /^Export/ });
    await waitFor(() => expect(exportBtn.disabled).toBe(false));
    fireEvent.click(exportBtn);
    const items = screen.getAllByRole('menuitem').map((m) => m.textContent);
    expect(items.some((t) => /^Excel/.test(t))).toBe(true);
    expect(items.some((t) => /^CSV/.test(t))).toBe(true);
    expect(items.some((t) => /^PDF/.test(t))).toBe(true);
    expect(items.some((t) => /Save to Files/.test(t))).toBe(true);
    expect(items.some((t) => /Share With a Teammate/.test(t))).toBe(false);
    fireEvent.click(screen.getByRole('menuitem', { name: /Save to Files/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Save to Files' });
    expect(within(dialog).getByLabelText('File Name').value).toBe('Ledger Lines - 61000 Repairs');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'CSV' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save to Files' }));
    await waitFor(() => expect(api.egnyteUpload).toHaveBeenCalled());
    const file = api.egnyteUpload.mock.calls.at(-1)[1];
    expect(file.name).toBe('Ledger Lines - 61000 Repairs.csv');
    const text = await new Promise((done) => { const fr = new FileReader(); fr.onload = () => done(fr.result); fr.readAsText(file); });
    expect(text).toContain('08/19/2026,22.46');
  });

  it('offers Journals under Filters, grouped by kind, and says Not available yet when the accounting app has none (R7)', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: /^Journals/ }));
    await screen.findByRole('option', { name: /Accounts Payable/ });
    const list = screen.getByRole('dialog', { name: 'Filters' });
    expect(within(list).getByText('Payables (AP)')).toBeTruthy();
    expect(within(list).getByText('Statistical')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Accounts Payable/ }));
    await waitFor(() => expect(api.getAccountingPnl.mock.calls.at(-1)[3]?.journals).toEqual(['APJ']));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect((await screen.findByLabelText('Active filters')).textContent).toContain('Journal: Accounts Payable (APJ)');
  });

  it('hides Journals until the accounting app lists them (R7; item 35, 10/07)', async () => {
    api.getAccountingJournals.mockResolvedValue({ available: false, journals: [] });
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Journals/ })).toBeNull());
    // Everything else still works.
    fireEvent.click(screen.getByRole('button', { name: /^Department/ }));
    await screen.findByRole('option', { name: /Property Management/ });
  });

  it('runs a Flux Analysis: this period against the prior one, flags over the thresholds, keeps an explanation (R8)', async () => {
    const year = new Date().getFullYear();
    const prior = { ...pnl, sections: [
      { key: 'revenue', label: 'Revenue', accounts: [{ account_no: '41000', title: 'Rental Income', amount: 1000 }, { account_no: '41100', title: 'Parking Income', amount: 500 }] },
      { key: 'expense', label: 'Operating Expenses', accounts: [{ account_no: '61000', title: 'Repairs', amount: 6000 }] },
    ] };
    api.getAccountingPnl.mockImplementation(async (from) => (from < `${year}-01-01` ? prior : pnl));
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'flux' } });
    await screen.findByRole('columnheader', { name: 'Variance $' });
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent).slice(3)).toEqual(['Variance $', 'Variance %', 'Flag', 'Explanation']);
    const repairs = screen.getByText('Repairs').closest('tr');
    expect(repairs.className).toContain('acct-flag');
    expect([...repairs.querySelectorAll('td.acct-num')].map((c) => c.textContent)).toEqual(['400.00', '6,000.00', '(5,600.00)', '(93.3%)']);
    expect(within(repairs).getByText('Review')).toBeTruthy();
    // Rental Income moved by nothing: no flag.
    expect(screen.getByText('Rental Income').closest('tr').className).not.toContain('acct-flag');
    expect(screen.getByLabelText('Summary').textContent).toContain('Flagged 1 to review · 0 explained');
    // The kept explanation shows; a new one is written in the cell itself (item 26a), no dialog.
    await screen.findByText('New tenant in suite B.');
    fireEvent.click(within(repairs).getByRole('button', { name: /Add explanation for 61000/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const box = within(screen.getByText('Repairs').closest('tr')).getByLabelText('Explanation for 61000 Repairs');
    fireEvent.change(box, { target: { value: 'Roof repair last year, one-time.' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(api.saveAccountingFluxNote).toHaveBeenCalled());
    expect(api.saveAccountingFluxNote.mock.calls[0][0]).toMatchObject({ entity: 'all', accountNo: '61000', note: 'Roof repair last year, one-time.' });
    expect(api.saveAccountingFluxNote.mock.calls[0][0].period).toMatch(/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/);
    await screen.findByText('Roof repair last year, one-time.');
    // Explained = answered (item 26b): the flag reads Explained, still a flagged line.
    const done = screen.getByText('Repairs').closest('tr');
    expect(within(done).getByText('Explained')).toBeTruthy();
    expect(within(done).queryByText('Review')).toBeNull();
    expect(done.className).toContain('acct-flag');
    expect(screen.getByLabelText('Summary').textContent).toContain('Flagged 0 to review · 1 explained');
    // Esc leaves an edit without saving; the trash asks Remove / Keep in place.
    fireEvent.click(within(done).getByRole('button', { name: /Edit explanation for 61000/ }));
    const again = within(screen.getByText('Repairs').closest('tr')).getByLabelText('Explanation for 61000 Repairs');
    fireEvent.change(again, { target: { value: 'Changed my mind' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(api.saveAccountingFluxNote).toHaveBeenCalledTimes(1);
    fireEvent.click(within(screen.getByText('Repairs').closest('tr')).getByRole('button', { name: /Remove explanation for 61000/ }));
    fireEvent.click(within(screen.getByText('Repairs').closest('tr')).getByRole('button', { name: 'Keep' }));
    expect(api.saveAccountingFluxNote).toHaveBeenCalledTimes(1);
    fireEvent.click(within(screen.getByText('Repairs').closest('tr')).getByRole('button', { name: /Remove explanation for 61000/ }));
    fireEvent.click(within(screen.getByText('Repairs').closest('tr')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.saveAccountingFluxNote).toHaveBeenCalledTimes(2));
    expect(api.saveAccountingFluxNote.mock.calls[1][0]).toMatchObject({ accountNo: '61000', note: '' });
    await waitFor(() => expect(within(screen.getByText('Repairs').closest('tr')).getByText('Review')).toBeTruthy());
    // Customize carries the thresholds; a looser one takes the flag off.
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    fireEvent.change(screen.getByLabelText('Flux variance amount threshold'), { target: { value: '6000' } });
    await waitFor(() => expect(screen.getByText('Repairs').closest('tr').className).not.toContain('acct-flag'));
  });

  it('asks the ledger once when two controls change one after the other', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    const before = api.getAccountingPnl.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'last-year' } });
    fireEvent.change(screen.getByLabelText('Book'), { target: { value: 'cash' } });
    await waitFor(() => expect(api.getAccountingPnl.mock.calls.length).toBeGreaterThan(before), { timeout: 2500 });
    await new Promise((r) => setTimeout(r, 400));
    expect(api.getAccountingPnl.mock.calls.length).toBe(before + 1);
    expect(api.getAccountingPnl.mock.calls.at(-1)[4]).toBe('cash');
  });
});
