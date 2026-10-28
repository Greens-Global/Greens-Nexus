import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render-smoke for the ledger lines (Neil and Charmi, Sep 25): the grid works
// like an Intacct list - a filter box under every column that the server
// applies to the whole result, columns the reader shows, hides and resizes
// for themselves (Doc No off until asked for), and the journal entry opening
// with every dimension as a column.

const line = {
  line_id: 'l1', entry_id: 'e1', entry_no: 'IA-1293173', entry_date: '2026-08-19', description: 'Amazon Marketplace Pay - Mop stainless steel',
  doc: 'INV-77', journal: 'CCJ', gl_code: '71100', account_name: 'General', location: '12000', location_name: 'Greens Global, Inc.',
  department: '9500', department_name: 'Personal', vendor_id: 'V00225', vendor_name: 'American Express', customer_id: '', customer_name: '',
  employee_id: '', employee_name: '', memo: 'Amazon Marketplace Pay', project_id: 'C-10', project_name: 'Valley Center', item_id: '', item_name: '',
  debit: 22.46, credit: 0,
};

vi.mock('../../api', () => ({
  api: {
    searchAccountingLedger: vi.fn(async () => ({ rows: [line], total: 1, debit: 22.46, credit: 0, facets: {} })),
    getAccountingEntry: vi.fn(async () => ({
      entry: { id: 'e1', entry_no: 'IA-1293173', entry_date: '2026-08-19', narration: '', posted_at: '2026-08-20' },
      lines: [{ id: 'l1', gl_code: '71100', account_name: 'General', description: '', location: '10001', location_name: 'Rajesh and D', department: '9500', department_name: 'Personal', book_tag: 'both', intacct_record_no: '9', debit: 22.46, credit: 0 }],
      intacct: [{ record_no: '9', batch_no: '77', journal: 'CCJ', memo: 'Amazon Marketplace Pay', vendor_id: 'V00225', vendor_name: 'American Express', class_id: 'C-10', class_name: 'Valley Center', item_id: 'IT-1', item_name: 'Supplies' }],
      totals: { debit: 22.46, credit: 0 }, path: '/finance/ledgers/entry/e1',
    })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (prefs) => ({ prefs })),
  },
}));

import LedgerSearch from './LedgerSearch';
import { api } from '../../api';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => { localStorage.clear(); resetAccountingPrefs(); vi.clearAllMocks(); });

// The first header row only: the filter row under it holds the amount operators.
const headers = () => within(document.querySelector('.acct-lines thead tr')).getAllByRole('columnheader').map((h) => h.textContent).filter(Boolean);


// The standard table view's panels load on first use (10/23 item 01): fetched
// once up front, so a busy run never waits on them inside a test.
beforeAll(async () => { await import('./tableView/panels'); }, 30000);
describe('LedgerSearch grid', () => {
  it('shows the columns of the Intacct General Ledger, and the person chooses their own', async () => {
    render(<LedgerSearch term="amazon" entities={['12000']} entityName="Greens Global, Inc. (12000)" onClose={() => {}} onClearDrill={() => {}} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    // Call of 10/27 with Charmi, item 17 (14:48): Doc, then Location (Entity), Vendor,
    // Customer, Item, Employee, Department as Intacct lays them out. A typed search
    // has no running Balance - that is a drill-down's.
    expect(headers()).toEqual(['Date', 'Entry', 'Doc No', 'Account', 'Description', 'Entity', 'Vendor', 'Customer', 'Item', 'Employee', 'Department', 'Journal', 'Debit', 'Credit']);
    expect(screen.getByText('08/19/2026')).toBeTruthy();
    expect(screen.getByText('INV-77')).toBeTruthy();
    expect(screen.getByText('Personal')).toBeTruthy();
    expect(api.searchAccountingLedger.mock.calls[0][0]).toMatchObject({ q: 'amazon', location: '12000' });

    // 10/23 meeting, item 01: the standard view's column chooser.
    fireEvent.click(screen.getByRole('button', { name: 'Show or Hide Columns' }));
    fireEvent.click(await screen.findByLabelText('Doc No'));
    fireEvent.click(screen.getByLabelText('Project-Job'));
    expect(headers()).not.toContain('Doc No');
    expect(screen.getByText('Valley Center')).toBeTruthy();
    expect(screen.getByText('Unsaved')).toBeTruthy();
    // The layout is the person's own and is saved for them (their view of the lines).
    await waitFor(() => expect(api.saveAccountingPrefs).toHaveBeenCalled(), { timeout: 2000 });
    expect(api.saveAccountingPrefs.mock.calls.at(-1)[0].tableViews['ledger-lines'].draft.vis).toEqual({ doc: false, project: true });
  });

  it('a drill-down carries a running Balance, oldest first, and a line opens its transaction on the right (item 17)', async () => {
    // The ledger hands them back newest first; the balance still runs from the oldest.
    const fuel = [
      { ...line, line_id: 'f3', entry_id: 'e3', entry_no: 'GJ-2521', entry_date: '2026-01-26', description: 'Fuel for company vehicle', debit: 80.07 },
      { ...line, line_id: 'f2', entry_id: 'e2', entry_no: 'GJ-2268', entry_date: '2026-01-12', description: 'Fuel for vehicle', debit: 62 },
      { ...line, line_id: 'f1', entry_id: 'e1', entry_no: 'GJ-2202', entry_date: '2026-01-05', description: 'Pala Vista Gas', debit: 20 },
    ];
    api.searchAccountingLedger.mockResolvedValue({ rows: fuel, total: 3, debit: 162.07, credit: 0, facets: {} });
    render(<LedgerSearch term="" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}}
      drill={{ account: '63203', accountName: 'Fuel', from: '2026-01-01', to: '2026-12-31', book: 'accrual', party: { kind: 'employee', code: 'E-0084', name: 'Valinda Cranfill' } }} />);
    await screen.findByText('Pala Vista Gas');
    expect(headers().at(-1)).toBe('Balance');
    const balanceOf = (text) => screen.getByText(text).closest('tr').querySelector('td:nth-last-child(2)').textContent;
    expect(balanceOf('Pala Vista Gas')).toBe('20.00');
    expect(balanceOf('Fuel for vehicle')).toBe('82.00');
    expect(balanceOf('Fuel for company vehicle')).toBe('162.07');
    // Listed oldest first, as Intacct lists them, so the balance grows down the page.
    expect([...document.querySelectorAll('.acct-lines tbody tr.acct-line-opens')].map((tr) => tr.children[4].textContent)).toEqual(['Pala Vista Gas', 'Fuel for vehicle', 'Fuel for company vehicle']);
    // The totals row ends on the closing figure, under Balance.
    expect(document.querySelector('.acct-grand td:nth-last-child(2)').textContent).toBe('162.07');

    // A click anywhere on the line (not only its entry number) opens the
    // transaction beside the lines, with Open Full - Intacct's head over its entries.
    fireEvent.click(screen.getByText('Pala Vista Gas'));
    const panel = await screen.findByTestId('acct-side-panel');
    expect(screen.getByText('Pala Vista Gas').closest('tr').className).toContain('is-open');
    await within(panel).findByTestId('entry-facts');
    expect(within(panel).getByRole('button', { name: /Open Full/ })).toBeTruthy();
    const facts = within(panel).getByTestId('entry-facts').textContent;
    expect(facts).toContain('Total22.46');
    expect(facts).toContain('PayeeV00225 American Express');
    expect(api.getAccountingEntry).toHaveBeenCalledWith('e1');
    // The lines behind stay on screen and clickable: another line swaps the panel.
    fireEvent.click(screen.getByText('Fuel for vehicle'));
    await waitFor(() => expect(api.getAccountingEntry).toHaveBeenLastCalledWith('e2'));
    expect(screen.getAllByTestId('acct-side-panel')).toHaveLength(1);
    api.searchAccountingLedger.mockImplementation(async () => ({ rows: [line], total: 1, debit: 22.46, credit: 0, facets: {} }));
  });

  it('keeps a layout chosen before views existed as the built-in default', async () => {
    localStorage.setItem('nexus-accounting-prefs', JSON.stringify({ lines: { visible: { doc: true, vendor: false }, widths: { description: 420 } } }));
    resetAccountingPrefs();
    render(<LedgerSearch term="amazon" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    expect(headers()).toContain('Doc No');
    expect(headers()).not.toContain('Vendor');
    expect(screen.queryByText('Unsaved')).toBeNull();
  });

  it('sends what is typed under a column to the server, stacked', async () => {
    render(<LedgerSearch term="amazon" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    fireEvent.change(screen.getByLabelText('Filter Description'), { target: { value: '%mop' } });
    fireEvent.change(screen.getByLabelText('Filter Date'), { target: { value: '08/19/2026' } });
    fireEvent.change(screen.getByLabelText('Filter Debit'), { target: { value: '.46' } });
    await waitFor(() => expect(JSON.parse(api.searchAccountingLedger.mock.calls.at(-1)[0].cols || '{}')).toEqual({ date: '08/19/2026', description: '%mop', debit: '.46' }), { timeout: 2000 });
    expect(screen.getByText('Description contains %mop')).toBeTruthy();
    fireEvent.click(screen.getByText('Clear Column Filters'));
    await waitFor(() => expect(api.searchAccountingLedger.mock.calls.at(-1)[0].cols).toBeUndefined(), { timeout: 2000 });
  });

  it('the boxes are the shared row; Memo, Project-Job and Item, which the ledger cannot narrow, are checked on every line and the export follows (chat triage 10/27)', async () => {
    const other = { ...line, line_id: 'l2', entry_no: 'IA-2', description: 'Roof repair', memo: 'Roofing supplies', project_id: 'C-11', project_name: 'Escondido', debit: 600 };
    api.searchAccountingLedger.mockResolvedValue({ rows: [line, other], total: 2, debit: 622.46, credit: 0, facets: {} });
    let exporter = null;
    render(<LedgerSearch term="amazon" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}} onExport={(x) => { exporter = x; }} />);
    await screen.findByText('Roof repair');
    // Every column shown has its box, the Ask column an empty cell, all inside the pinned head.
    const head = document.querySelector('.acct-lines thead');
    expect(head.querySelector('.acct-filter-row').children).toHaveLength(head.querySelector('tr').children.length);
    expect(screen.getByLabelText('Filter Date').getAttribute('placeholder')).toBe('MM/DD/YYYY');
    fireEvent.click(screen.getByRole('button', { name: 'Show or Hide Columns' }));
    fireEvent.click(await screen.findByLabelText('Memo'));
    fireEvent.click(screen.getByLabelText('Project-Job'));
    const calls = api.searchAccountingLedger.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Filter Memo'), { target: { value: 'roofing' } });
    expect(screen.queryByText('Amazon Marketplace Pay - Mop stainless steel')).toBeNull();
    expect(screen.getByText('Roof repair')).toBeTruthy();
    expect(screen.getByTestId('ledger-lines-count').textContent).toBe('1 of 2 lines');
    expect(screen.getByText('Debits').textContent).toContain('600.00');
    expect(screen.getByText('Memo contains roofing')).toBeTruthy();
    // Memo is not a server filter: nothing new goes to the ledger for it.
    await new Promise((r) => { setTimeout(r, 400); });
    expect(api.searchAccountingLedger.mock.calls.slice(calls).every(([p]) => !p.cols)).toBe(true);
    // A server box stacks on it (Description), still sent to the ledger.
    fireEvent.change(screen.getByLabelText('Filter Description'), { target: { value: 'roof' } });
    await waitFor(() => expect(JSON.parse(api.searchAccountingLedger.mock.calls.at(-1)[0].cols || '{}')).toEqual({ description: 'roof' }), { timeout: 2000 });
    await waitFor(() => expect(exporter).toBeTruthy());
    const table = await exporter.build();
    const desc = table.columns.findIndex((c) => c.label === 'Description');
    expect(table.rows.map((r) => r[desc])).toEqual(['Roof repair']);
    expect(table.totals[table.columns.findIndex((c) => c.label === 'Debit')]).toBe(600);
    // The chip's x lifts the Memo box; both lines are back.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Memo contains roofing' }));
    expect(screen.getByText('Amazon Marketplace Pay - Mop stainless steel')).toBeTruthy();
  });

  it('sends several entities as a set, and a drill-down into its book', async () => {
    render(<LedgerSearch term="" entities={['15000', '56000']} entityName="2 entities" onClose={() => {}} onClearDrill={() => {}}
      drill={{ account: '71100', accountName: 'General', from: '2026-08-01', to: '2026-08-31', book: 'cash' }} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    expect(api.searchAccountingLedger.mock.calls.at(-1)[0]).toMatchObject({ locations: '15000,56000', account: '71100', from: '2026-08-01', to: '2026-08-31', book: 'cash' });
    expect(api.searchAccountingLedger.mock.calls.at(-1)[0].location).toBeUndefined();
  });

  it('keeps a drill-down from a user-defined book in that book (Charmi, 10/15)', async () => {
    render(<LedgerSearch term="" entities={['15000']} entityName="Greens Escondido" onClose={() => {}} onClearDrill={() => {}}
      drill={{ account: '71100', accountName: 'General', from: '2026-08-01', to: '2026-08-31', book: 'fmv' }} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    expect(api.searchAccountingLedger.mock.calls.at(-1)[0]).toMatchObject({ account: '71100', book: 'fmv' });
    const book = screen.getByLabelText('Book');
    expect(book.value).toBe('fmv');
    expect([...book.options].map((o) => o.textContent)).toEqual(['All Books', 'Accrual Book', 'Cash Book', 'FMV Book']);
  });

  it('a drill-down from a vendor or a department column stays on that vendor or department', async () => {
    const { unmount } = render(<LedgerSearch term="" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}}
      drill={{ account: '62101', accountName: 'Repairs', from: '2026-01-01', to: '2026-09-28', book: 'accrual', party: { kind: 'vendor', code: 'V00412', name: 'Home Depot' } }} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    expect(api.searchAccountingLedger.mock.calls.at(-1)[0]).toMatchObject({ account: '62101', party_kind: 'vendor', party: 'V00412' });
    expect(screen.getByText('Vendor: V00412 Home Depot')).toBeTruthy();
    unmount();
    render(<LedgerSearch term="" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}}
      drill={{ account: '62101', accountName: 'Repairs', from: '2026-01-01', to: '2026-09-28', book: 'accrual', department: '9100' }} />);
    await waitFor(() => expect(JSON.parse(api.searchAccountingLedger.mock.calls.at(-1)[0].cols || '{}')).toEqual({ department: '9100' }), { timeout: 2000 });
  });

  it('has no Narrow by row: a heading value list filters EVERY line of the search and the totals follow (10/23, item 01)', async () => {
    // 150 lines: the ledger hands back 100 a page; customers alternate.
    const all = Array.from({ length: 150 }, (_v, i) => ({
      ...line, line_id: `x${i}`, entry_no: `IA-${1000 + i}`, description: `Sales Invoice ${i}`, vendor_id: '', vendor_name: '',
      customer_id: i % 3 === 0 ? 'C00127' : 'C00142', customer_name: i % 3 === 0 ? 'Greens Austin' : 'Greens Sachse', debit: 0, credit: 100,
    }));
    api.searchAccountingLedger.mockImplementation(async (p) => ({ rows: all.slice(p.offset || 0, (p.offset || 0) + (p.limit || 100)), total: 150, debit: 0, credit: 15000, facets: {} }));
    render(<LedgerSearch term="" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}}
      drill={{ account: '40005', accountName: 'Property Management Fee', from: '2026-01-01', to: '2026-10-23', book: 'accrual' }} />);
    await screen.findByText('Sales Invoice 0');
    expect(screen.queryByText('Narrow by')).toBeNull();
    expect(screen.queryByLabelText('Customers')).toBeNull();
    // Opening a heading's list reads every line, so the list is complete.
    fireEvent.click(screen.getByRole('button', { name: 'Filter Customer by value' }));
    const list = await screen.findByRole('dialog', { name: 'Customer values' });
    await waitFor(() => expect(api.searchAccountingLedger.mock.calls.some(([p]) => p.limit === 1000)).toBe(true));
    await waitFor(() => expect(within(list).getByRole('checkbox', { name: /Greens Austin/ }).closest('label').textContent).toContain('50'));
    fireEvent.click(within(list).getByRole('checkbox', { name: /Greens Sachse/ }));
    // 50 of the 150 lines, and the credits of those 50 only.
    await waitFor(() => expect(screen.getByTestId('ledger-lines-count').textContent).toBe('50 of 150 lines'));
    expect(screen.getByText('Credits').textContent).toContain('5,000.00');
    expect(screen.getByRole('button', { name: 'Filters (1 on)' })).toBeTruthy();
    // The totals line at the bottom says the same.
    expect(document.querySelector('.acct-grand').textContent).toContain('Totals - 50 lines');
  });

  it('a rule from Filters, a sort and the export: exactly the lines and columns the view leaves', async () => {
    const big = { ...line, line_id: 'l2', entry_no: 'IA-2', description: 'Roof repair', debit: 600, credit: 0 };
    const cr = { ...line, line_id: 'l3', entry_no: 'IA-3', description: 'Refund', debit: 0, credit: 150 };
    api.searchAccountingLedger.mockResolvedValue({ rows: [line, big, cr], total: 3, debit: 622.46, credit: 150, facets: {} });
    let exporter = null;
    render(<LedgerSearch term="repairs" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}} onExport={(x) => { exporter = x; }} />);
    await screen.findByText('Roof repair');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const panel = await screen.findByRole('dialog', { name: 'Filters' });
    fireEvent.click(within(panel).getByRole('button', { name: /Add Filter/ }));
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Rule 1 field' }), { target: { value: 'debit' } });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Rule 1 condition' }), { target: { value: 'gt' } });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Rule 1 value' }), { target: { value: '10' } });
    expect(screen.queryByText('Refund')).toBeNull();
    expect(screen.getByTestId('ledger-lines-count').textContent).toBe('2 of 3 lines');
    fireEvent.click(screen.getByRole('button', { name: /^Debit - column menu/ }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Debit column' })).getByRole('menuitemradio', { name: /Sort Descending/ }));
    const firstRow = document.querySelector('.acct-lines tbody tr');
    expect(firstRow.textContent).toContain('Roof repair');
    // Hide Entity; the export follows: two lines, biggest first, no Entity column.
    fireEvent.click(screen.getByRole('button', { name: /^Entity - column menu/ }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Entity column' })).getByRole('menuitem', { name: /Hide Column/ }));
    await waitFor(() => expect(exporter).toBeTruthy());
    const table = await exporter.build();
    expect(table.columns.map((c) => c.label)).not.toContain('Entity');
    expect(table.rows.map((r) => r[table.columns.findIndex((c) => c.label === 'Description')])).toEqual(['Roof repair', 'Amazon Marketplace Pay - Mop stainless steel']);
    expect(table.totals[table.columns.findIndex((c) => c.label === 'Debit')]).toBe(622.46);
  });

  it('scrolls inside its own box with the headings pinned, the page staying put (Viral, 10/22, item 18)', async () => {
    const { unmount } = render(<LedgerSearch term="" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}}
      drill={{ account: '11261', accountName: 'Gr FLP- CNB - 6766', from: '2026-01-01', to: '2026-10-22', book: 'accrual' }} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    const box = screen.getByTestId('ledger-lines-box');
    // The box sized to the window (style.css acct-scroll-box), never "no limit".
    expect(box.className).toContain('acct-scroll-box');
    expect(box.style.maxHeight).toBe('');
    // UI test 10/23: the box ends inside the window, measured from where it starts.
    const tall = window.innerHeight;
    // What the page still shows under the box (the notes under the lines) is left room for.
    const under = tall - 8 - parseInt(box.style.getPropertyValue('--acct-lines-h'), 10);
    expect(under).toBeGreaterThanOrEqual(0);
    window.innerHeight = 500;
    fireEvent(window, new Event('resize'));
    expect(box.style.getPropertyValue('--acct-lines-h')).toBe(`${492 - under}px`);
    // ...and so is the card's bottom padding.
    const card = box.parentElement;
    const pad = card.style.paddingBottom;
    const had = parseFloat(getComputedStyle(card).paddingBottom) || 0;
    card.style.paddingBottom = `${had + 30}px`;
    fireEvent(window, new Event('resize'));
    expect(box.style.getPropertyValue('--acct-lines-h')).toBe(`${462 - under}px`);
    card.style.paddingBottom = pad;
    window.innerHeight = 200;
    fireEvent(window, new Event('resize'));
    expect(box.style.getPropertyValue('--acct-lines-h')).toBe('300px');
    window.innerHeight = tall;
    // The headings and the filter boxes pin as one block at the top of the box.
    expect(box.querySelector('table').className).toContain('acct-sticky-head');
    expect(box.querySelector('thead .acct-filter-row')).toBeTruthy();
    unmount();
    // Full screen keeps its own taller scroller.
    render(<LedgerSearch term="amazon" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}} full />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    expect(screen.getByTestId('ledger-lines-box').className).not.toContain('acct-scroll-box');
  });

  it('a total drills with no account into every line of the period, and the Journals filter follows the lines', async () => {
    api.searchAccountingLedger.mockResolvedValue({ rows: [{ ...line, journal: 'APJ' }], total: 1, debit: 22.46, credit: 0, facets: {} });
    render(<LedgerSearch term="" entities={['15000']} entityName="Greens Escondido (15000)" onClose={() => {}} onClearDrill={() => {}}
      dims={{ journals: ['APJ', 'ARJ'] }} drill={{ account: '', accountName: 'Net Income', from: '2026-09-01', to: '2026-09-30', book: 'accrual' }} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    const sent = api.searchAccountingLedger.mock.calls.at(-1)[0];
    expect(sent).toMatchObject({ location: '15000', from: '2026-09-01', to: '2026-09-30', book: 'accrual', journals: 'APJ,ARJ' });
    expect(sent.account).toBeUndefined();
    expect(screen.getByRole('heading', { name: 'Net Income - every line' })).toBeTruthy();
    expect(screen.getByText('Journals: APJ, ARJ')).toBeTruthy();
  });

  it('a drill keeps every report filter - vendor, customer, department, journals - and shows each as a chip (Oct 7)', async () => {
    const hit = { ...line, customer_id: 'C1', customer_name: 'Tenant One' };
    api.searchAccountingLedger.mockResolvedValue({ rows: [hit], total: 1, debit: 22.46, credit: 0, facets: {} });
    const { unmount } = render(<LedgerSearch term="" entities={['12000']} entityName="Greens Global, Inc. (12000)" onClose={() => {}} onClearDrill={() => {}}
      dims={{ departments: ['9500'], vendor: ['V00225'], customer: ['C1', 'C2'], employee: [], project: [], item: [], journals: ['CCJ'] }}
      dimNames={{ vendor: { V00225: 'American Express' } }}
      drill={{ account: '71100', accountName: 'General', from: '2026-08-01', to: '2026-08-31', book: 'accrual' }} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    const sent = api.searchAccountingLedger.mock.calls.at(-1)[0];
    expect(sent).toMatchObject({ location: '12000', account: '71100', from: '2026-08-01', to: '2026-08-31', book: 'accrual',
      vendor: 'V00225', customer: 'C1,C2', departments: '9500', journals: 'CCJ' });
    // Two kinds of party: neither is the search's single party.
    expect(sent.party_kind).toBeUndefined();
    expect(screen.getByText('Vendor: American Express (V00225)')).toBeTruthy();
    expect(screen.getByText('Customers: C1, C2')).toBeTruthy();
    expect(screen.getByText('Department: 9500')).toBeTruthy();
    expect(screen.getByText('Journal: CCJ')).toBeTruthy();
    expect(screen.queryByText(/not applied/)).toBeNull();
    // A chip's x lifts that filter from the lines only.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Customers: C1, C2' }));
    await waitFor(() => expect(api.searchAccountingLedger.mock.calls.at(-1)[0].customer).toBeUndefined());
    expect(api.searchAccountingLedger.mock.calls.at(-1)[0]).toMatchObject({ vendor: 'V00225', party_kind: 'vendor', party: 'V00225' });
    unmount();

    // A drill from another tab (requestReportDrill) brings its own filters.
    render(<LedgerSearch term="" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}}
      drill={{ account: '40100', accountName: 'Rent', from: '2026-01-01', to: '2026-01-31', book: 'accrual', dims: { customer: ['C1'], departments: ['9500'] } }} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    expect(api.searchAccountingLedger.mock.calls.at(-1)[0]).toMatchObject({ account: '40100', customer: 'C1', departments: '9500', party_kind: 'customer', party: 'C1' });
    expect(screen.getByText('Customer: C1')).toBeTruthy();
  });

  it('leaves out lines the ledger did not narrow by the report filters, and says so', async () => {
    api.searchAccountingLedger.mockResolvedValue({ rows: [line, { ...line, line_id: 'l2', description: 'Someone else', vendor_id: 'V99999', vendor_name: 'Other' }], total: 2, debit: 40, credit: 0, facets: {} });
    render(<LedgerSearch term="" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}}
      dims={{ vendor: ['V00225', 'V00412'] }} drill={{ account: '71100', accountName: 'General', from: '2026-08-01', to: '2026-08-31', book: 'accrual' }} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    expect(screen.queryByText('Someone else')).toBeNull();
    expect(screen.getByRole('note').textContent).toMatch(/did not narrow these lines/);
  });

  it('filters Debit and Credit with the Reports operators (=, >, <, >=, <=, Between)', async () => {
    const big = { ...line, line_id: 'l2', entry_no: 'IA-2', description: 'Roof repair', debit: 600, credit: 0 };
    const cr = { ...line, line_id: 'l3', entry_no: 'IA-3', description: 'Refund', debit: 0, credit: 150 };
    api.searchAccountingLedger.mockResolvedValue({ rows: [line, big, cr], total: 3, debit: 622.46, credit: 150, facets: {} });
    render(<LedgerSearch term="repairs" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}} />);
    await screen.findByText('Roof repair');
    const before = api.searchAccountingLedger.mock.calls.length;
    expect([...screen.getByLabelText('Operator for Debit').options].map((o) => o.textContent)).toEqual(['=', '>', '<', '>=', '<=', 'Between']);
    fireEvent.change(screen.getByLabelText('Operator for Debit'), { target: { value: '>' } });
    fireEvent.change(screen.getByLabelText('Filter Debit'), { target: { value: '100' } });
    expect(screen.queryByText('Amazon Marketplace Pay - Mop stainless steel')).toBeNull();
    expect(screen.queryByText('Refund')).toBeNull();
    expect(screen.getByText('Roof repair')).toBeTruthy();
    expect(screen.getByText('Debit > 100')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/Debit > 100 is checked on the lines loaded here: 1 of 3 pass/);
    // A comparison is not sent to the server as text - it goes as an operator.
    await new Promise((r) => setTimeout(r, 450));
    expect(api.searchAccountingLedger.mock.calls.slice(before).every((c) => !c[0].cols)).toBe(true);
    expect(api.searchAccountingLedger.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({ debit_op: 'gt', debit_v: 100 }));

    // Between on Credit, with Debit cleared.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Debit > 100' }));
    fireEvent.change(screen.getByLabelText('Operator for Credit'), { target: { value: 'between' } });
    fireEvent.change(screen.getByLabelText('Filter Credit'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Filter Credit up to'), { target: { value: '200' } });
    expect(screen.getByText('Refund')).toBeTruthy();
    expect(screen.queryByText('Roof repair')).toBeNull();
    expect(screen.getByText('Credit between 100 and 200')).toBeTruthy();

    // "=" stays the server's match over the whole result.
    fireEvent.change(screen.getByLabelText('Operator for Credit'), { target: { value: '=' } });
    await waitFor(() => expect(JSON.parse(api.searchAccountingLedger.mock.calls.at(-1)[0].cols || '{}')).toEqual({ credit: '100' }), { timeout: 2000 });
  });

  it('a ledger that applied the operator leaves the lines and the totals to it', async () => {
    const big = { ...line, line_id: 'l2', entry_no: 'IA-2', description: 'Roof repair', debit: 600, credit: 0 };
    api.searchAccountingLedger.mockImplementation(async (p) => (p.credit_op
      ? { rows: [big], total: 1, debit: 600, credit: 0, cols: { credit_cmp: 'between:100:200' }, facets: {} }
      : { rows: [line, big], total: 2, debit: 622.46, credit: 0, facets: {} }));
    render(<LedgerSearch term="repairs" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}} />);
    await screen.findByText('Roof repair');
    fireEvent.change(screen.getByLabelText('Operator for Credit'), { target: { value: 'between' } });
    fireEvent.change(screen.getByLabelText('Filter Credit'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Filter Credit up to'), { target: { value: '200' } });
    await waitFor(() => expect(api.searchAccountingLedger.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({ credit_op: 'between', credit_v: 100, credit_v2: 200 })), { timeout: 2000 });
    // The server's answer stands: no line is dropped here and no page-only note.
    await screen.findByText('Roof repair');
    expect(screen.queryByRole('note')).toBeNull();
    // An open-ended Between is a plain >=.
    fireEvent.change(screen.getByLabelText('Filter Credit up to'), { target: { value: '' } });
    await waitFor(() => expect(api.searchAccountingLedger.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({ credit_op: 'gte', credit_v: 100 })), { timeout: 2000 });
  });

  it('opens the journal entry with every dimension as a column', async () => {
    render(<LedgerSearch term="amazon" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'IA-1293173' }));
    const dialog = await screen.findByRole('dialog', { name: /Journal entry/ });
    await within(dialog).findByText('Supplies');
    expect(within(dialog).getAllByRole('columnheader').map((h) => h.textContent))
      .toEqual(['Account', 'Debit', 'Credit', 'Department', 'Location', 'Memo', 'Vendor', 'Project-Job', 'Item', 'Employee', 'Customer', '']);
    const row = within(dialog).getByText('Supplies').closest('tr');
    expect([...row.cells].map((c) => c.textContent)).toEqual(['71100General', '22.46', '', 'Personal', 'Rajesh and D', 'Amazon Marketplace Pay', 'V00225 American Express', 'Valley Center', 'Supplies', '', '', '']);   // the last cell: Ask My Accountant (Oct 15)
  });

  it('opens the entry the dashboard tile handed over on top of the lines, once', async () => {
    const onEntryClosed = vi.fn();
    render(<LedgerSearch term="amazon" entities={[]} initialEntry={{ id: 'e1', no: 'IA-1293173' }} onEntryClosed={onEntryClosed} onClose={() => {}} onClearDrill={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    expect(api.getAccountingEntry).toHaveBeenCalledWith('e1');
    // The dialog opens on a loading skeleton and fills in once the entry
    // arrives - wait for it, as the test above does (a slow CI runner still
    // had the skeleton up when this read it synchronously; PR #513).
    expect(await within(dialog).findByText('Supplies')).toBeTruthy();
    // The lines are still behind it.
    expect(await screen.findByText('Amazon Marketplace Pay - Mop stainless steel')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onEntryClosed).toHaveBeenCalledTimes(1);
  });
});
