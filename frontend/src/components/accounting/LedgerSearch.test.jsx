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

const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent).filter(Boolean);

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
