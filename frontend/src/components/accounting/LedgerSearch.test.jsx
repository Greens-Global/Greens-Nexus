import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('LedgerSearch grid', () => {
  it('shows the working columns, keeps Doc No off until it is asked for', async () => {
    render(<LedgerSearch term="amazon" entities={['12000']} entityName="Greens Global, Inc. (12000)" onClose={() => {}} onClearDrill={() => {}} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    // Date, Entry, Account, Description, Entity, then Vendor and Customer as two columns (Charmi, 09/29 call).
    expect(headers()).toEqual(['Date', 'Entry', 'Account', 'Description', 'Entity', 'Vendor', 'Customer', 'Journal', 'Debit', 'Credit']);
    expect(screen.getByText('08/19/2026')).toBeTruthy();
    expect(api.searchAccountingLedger.mock.calls[0][0]).toMatchObject({ q: 'amazon', location: '12000' });

    fireEvent.click(screen.getByRole('button', { name: /Columns/ }));
    fireEvent.click(screen.getByLabelText('Doc No'));
    fireEvent.click(screen.getByLabelText('Project-Job'));
    expect(headers()).toContain('Doc No');
    expect(screen.getByText('INV-77')).toBeTruthy();
    expect(screen.getByText('Valley Center')).toBeTruthy();
    // The layout is the person's own and is saved for them.
    await waitFor(() => expect(api.saveAccountingPrefs).toHaveBeenCalled(), { timeout: 2000 });
    expect(api.saveAccountingPrefs.mock.calls.at(-1)[0].lines.visible).toEqual({ doc: true, project: true });
  });

  it('sends what is typed under a column to the server, stacked', async () => {
    render(<LedgerSearch term="amazon" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    fireEvent.change(screen.getByLabelText('Filter Description'), { target: { value: '%mop' } });
    fireEvent.change(screen.getByLabelText('Filter Date'), { target: { value: '08/19/2026' } });
    fireEvent.change(screen.getByLabelText('Filter Debit'), { target: { value: '.46' } });
    await waitFor(() => expect(JSON.parse(api.searchAccountingLedger.mock.calls.at(-1)[0].cols || '{}')).toEqual({ date: '08/19/2026', description: '%mop', debit: '.46' }), { timeout: 2000 });
    expect(screen.getByText('Description contains %mop')).toBeTruthy();
    fireEvent.click(screen.getByText('Clear column filters'));
    await waitFor(() => expect(api.searchAccountingLedger.mock.calls.at(-1)[0].cols).toBeUndefined(), { timeout: 2000 });
  });

  it('sends several entities as a set, and a drill-down into its book', async () => {
    render(<LedgerSearch term="" entities={['15000', '56000']} entityName="2 entities" onClose={() => {}} onClearDrill={() => {}}
      drill={{ account: '71100', accountName: 'General', from: '2026-08-01', to: '2026-08-31', book: 'cash' }} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    expect(api.searchAccountingLedger.mock.calls.at(-1)[0]).toMatchObject({ locations: '15000,56000', account: '71100', from: '2026-08-01', to: '2026-08-31', book: 'cash' });
    expect(api.searchAccountingLedger.mock.calls.at(-1)[0].location).toBeUndefined();
  });

  it('a drill-down from a vendor or a department column stays on that vendor or department', async () => {
    const { unmount } = render(<LedgerSearch term="" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}}
      drill={{ account: '62101', accountName: 'Repairs', from: '2026-01-01', to: '2026-09-28', book: 'accrual', party: { kind: 'vendor', code: 'V00412', name: 'Home Depot' } }} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    expect(api.searchAccountingLedger.mock.calls.at(-1)[0]).toMatchObject({ account: '62101', party_kind: 'vendor', party: 'V00412' });
    expect(screen.getByText('Vendor: Home Depot')).toBeTruthy();
    unmount();
    render(<LedgerSearch term="" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}}
      drill={{ account: '62101', accountName: 'Repairs', from: '2026-01-01', to: '2026-09-28', book: 'accrual', department: '9100' }} />);
    await waitFor(() => expect(JSON.parse(api.searchAccountingLedger.mock.calls.at(-1)[0].cols || '{}')).toEqual({ department: '9100' }), { timeout: 2000 });
  });

  it('narrows by vendor, customer, account or journal from a dropdown', async () => {
    api.searchAccountingLedger.mockResolvedValue({ rows: [line], total: 3, debit: 60, credit: 0, facets: {
      vendors: [{ code: 'V00225', name: 'American Express', lines: 2, net: 40 }, { code: 'V00412', name: 'Home Depot', lines: 1, net: 20 }],
      accounts: [{ code: '71100', name: 'General', lines: 3, net: 60 }],
    } });
    render(<LedgerSearch term="amazon" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    // One account behind every line is not a choice, so it is not offered.
    expect(screen.queryByLabelText('Accounts')).toBeNull();
    const vendors = screen.getByLabelText('Vendors');
    expect([...vendors.options].map((o) => o.textContent)).toEqual(['Vendors (2)', 'American Express - 2 lines, net 40.00', 'Home Depot - 1 lines, net 20.00']);
    fireEvent.change(vendors, { target: { value: 'V00412' } });
    await waitFor(() => expect(api.searchAccountingLedger.mock.calls.at(-1)[0]).toMatchObject({ party_kind: 'vendor', party: 'V00412' }));
    expect(screen.getByText('Vendor: Home Depot')).toBeTruthy();
  });

  it('scrolls with the page in a window and keeps its own scroller only in full screen (Charmi, 10/02)', async () => {
    const { unmount } = render(<LedgerSearch term="amazon" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}} />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    expect(document.querySelector('.acct-lines-wrap').style.maxHeight).toBe('none');
    unmount();
    render(<LedgerSearch term="amazon" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}} full />);
    await screen.findByText('Amazon Marketplace Pay - Mop stainless steel');
    expect(document.querySelector('.acct-lines-wrap').style.maxHeight).toBe('');
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
      .toEqual(['Account', 'Debit', 'Credit', 'Department', 'Location', 'Memo', 'Vendor', 'Project-Job', 'Item', 'Employee', 'Customer']);
    const row = within(dialog).getByText('Supplies').closest('tr');
    expect([...row.cells].map((c) => c.textContent)).toEqual(['71100General', '22.46', '', 'Personal', 'Rajesh and D', 'Amazon Marketplace Pay', 'American Express', 'Valley Center', 'Supplies', '', '']);
  });

  it('opens the entry the dashboard tile handed over on top of the lines, once', async () => {
    const onEntryClosed = vi.fn();
    render(<LedgerSearch term="amazon" entities={[]} initialEntry={{ id: 'e1', no: 'IA-1293173' }} onEntryClosed={onEntryClosed} onClose={() => {}} onClearDrill={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    expect(api.getAccountingEntry).toHaveBeenCalledWith('e1');
    expect(within(dialog).getByText('Supplies')).toBeTruthy();
    // The lines are still behind it.
    expect(await screen.findByText('Amazon Marketplace Pay - Mop stainless steel')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onEntryClosed).toHaveBeenCalledTimes(1);
  });
});
