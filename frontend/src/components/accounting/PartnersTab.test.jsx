import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Accounting -> Vendors & Customers (Oct 2): the records from the accounting
// app, an edit that becomes a change request, the Awaiting Intacct badge, a
// manager's approve / decline, the export, and the not-available state.

const vendors = [
  { id: 'V00012', kind: 'vendor', name: 'Acme Plumbing', displayName: 'Acme Plumbing', taxId: '1234', email: 'ap@acme.com', phone: '760-555-0100', address: { line1: '1 Main St', line2: '', city: 'Escondido', state: 'CA', zip: '92025', country: 'US' }, terms: 'Net 30', status: 'active', entity: '15000', updatedAt: '', awaitingIntacct: false, pendingChange: false, intacctValues: {} },
  { id: 'V00013', kind: 'vendor', name: 'Bay Electric', displayName: 'Bay Electric', taxId: '', email: 'new@bay.com', phone: '', address: { line1: '', line2: '', city: '', state: '', zip: '', country: '' }, terms: '', status: 'active', entity: '', updatedAt: '', awaitingIntacct: true, pendingChange: false, intacctValues: { email: 'old@bay.com' } },
];
const changes = [
  { id: 'c1', kind: 'vendor', partnerId: 'V00012', partnerName: 'Acme Plumbing', changes: { phone: { from: '760-555-0100', to: '760-555-0199' } }, status: 'pending', requestedBy: 'a@greensglobal.com', requestedByName: 'Amy Bolanos', requestedAt: '2026-10-01T10:00:00Z', decidedBy: '', decidedByName: '', decidedAt: '', note: '' },
];

vi.mock('../../api', () => ({
  api: {
    getAccountingPartners: vi.fn(async () => ({ kind: 'vendor', partners: vendors })),
    getAccountingPartnerChanges: vi.fn(async () => ({ changes })),
    createAccountingPartnerChange: vi.fn(async (body) => ({ id: 'c2', ...body, status: 'pending' })),
    decideAccountingPartnerChange: vi.fn(async (id, decision) => ({ id, status: decision === 'approve' ? 'approved' : 'declined' })),
    exportAccountingPartnerChanges: vi.fn(async () => ({ blob: new Blob(['x']), filename: 'partner-changes-approved.csv' })),
    getAccountingPartnerRecord: vi.fn(async () => ({ kind: 'vendor', source: 'intacct', record: vendors[0], history: changes,
      activity: { total: 41, debit: 5200.5, credit: 1200, entities: [{ code: '15000', name: 'Greens Escondido', lines: 41, net: 4000.5 }], accounts: [],
        lines: [{ lineId: 'L1', entryNo: 'AP-9', date: '2026-09-30', entity: '15000', account: '61000', accountName: 'Repairs', memo: 'Invoice 1182 - pipe', debit: 400, credit: 0 }] },
      activityError: '' })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
  },
  withFreshReads: vi.fn((fn) => fn()),
}));
vi.mock('../../ui/dialog', () => ({ dialog: { alert: vi.fn(async () => true), confirm: vi.fn(async () => true), prompt: vi.fn(async () => 'Please') } }));

import PartnersTab, { diffPartner, isInactive, partnersTable } from './PartnersTab';
import { dialog as appDialog } from '../../ui/dialog';
import { api, withFreshReads } from '../../api';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountingPrefs();
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* private mode */ }
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
  globalThis.URL.revokeObjectURL = vi.fn();
});


// The standard table view's panels load on first use (10/23 item 01): fetched
// once up front, so a busy run never waits on them inside a test.
beforeAll(async () => { await import('./tableView/panels'); }, 30000);
describe('PartnersTab', () => {
  it('lists the records with the Awaiting Intacct badge', async () => {
    render(<PartnersTab />);
    expect(await screen.findByText('Acme Plumbing')).toBeTruthy();
    const row = screen.getByText('Bay Electric').closest('tr');
    expect(within(row).getByText('Awaiting Intacct')).toBeTruthy();
    expect(within(row).getByText('new@bay.com')).toBeTruthy();
    expect(api.getAccountingPartners).toHaveBeenCalledWith('vendor', '');
  });

  it('turns an edit into a change request with only the fields that differ', async () => {
    render(<PartnersTab />);
    await screen.findByText('Acme Plumbing');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Acme Plumbing' }));
    const dialog = screen.getByRole('dialog', { name: 'Vendor V00012' });
    fireEvent.change(await within(dialog).findByLabelText('Phone'), { target: { value: '760-555-0199' } });
    fireEvent.change(within(dialog).getByLabelText('City'), { target: { value: 'San Marcos' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send for Approval' }));
    await waitFor(() => expect(api.createAccountingPartnerChange).toHaveBeenCalled());
    expect(api.createAccountingPartnerChange.mock.calls[0][0]).toEqual({
      kind: 'vendor', partnerId: 'V00012', partnerName: 'Acme Plumbing', note: 'Please',
      changes: { phone: { from: '760-555-0100', to: '760-555-0199' }, 'address.city': { from: 'Escondido', to: 'San Marcos' } },
    });
    expect(diffPartner(vendors[0], vendors[0])).toEqual({});
    // The panel closes, the list stays, and the screen says where it went.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Vendor V00012' })).toBeNull());
    expect(screen.getByText(/Sent for approval: Acme Plumbing/)).toBeTruthy();
    expect(screen.getByText('Bay Electric')).toBeTruthy();
  });

  it('lets a manager approve a pending request and export the approved ones', async () => {
    render(<PartnersTab canApprove />);
    await screen.findByText('Acme Plumbing');
    fireEvent.click(screen.getByRole('button', { name: /Requests/ }));
    expect(await screen.findByText('760-555-0199')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.decideAccountingPartnerChange).toHaveBeenCalledWith('c1', 'approve', 'Please'));
    fireEvent.click(screen.getByRole('button', { name: /Export Approved CSV/ }));
    // Item 15 (10/27): on Vendors it is Intacct's vendor import file.
    await waitFor(() => expect(api.exportAccountingPartnerChanges).toHaveBeenCalledWith('approved', 'vendor', 'intacct'));
  });

  it('says how fresh the Intacct copy is and shows a value changed in Intacct after approval (item 15)', async () => {
    const changed = { ...vendors[0], email: 'accounts@acme.com', intacctChanged: { email: { intacct: 'accounts@acme.com', approved: 'billing@acme.com', approvedAt: '2026-10-26T18:12:00Z' } } };
    api.getAccountingPartners.mockResolvedValueOnce({ kind: 'vendor', source: 'intacct', intacctAsOf: '2026-10-27T16:30:02Z', partners: [changed, vendors[1]] });
    api.getAccountingPartnerRecord.mockResolvedValueOnce({ kind: 'vendor', source: 'intacct', record: changed, history: [], activity: null, activityError: '' });
    render(<PartnersTab />);
    const row = (await screen.findByText('Acme Plumbing')).closest('tr');
    expect(within(row).getByText('Changed In Intacct')).toBeTruthy();
    expect(within(row).getByText('accounts@acme.com')).toBeTruthy();
    expect(screen.getByTestId('intacct-as-of').textContent).toMatch(/^Intacct data as of 10\/27\/2026/);
    fireEvent.click(row);
    const dialog = await screen.findByRole('dialog', { name: 'Vendor V00012' });
    const note = await within(dialog).findByRole('note');
    expect(note.textContent).toContain('Email - Intacct has accounts@acme.com (Nexus approved billing@acme.com on 10/26/2026)');
  });

  it('lists requests closed by Intacct under their own status (item 15)', async () => {
    api.getAccountingPartnerChanges.mockResolvedValue({ intacctAsOf: '2026-10-27T16:30:02Z', changes: [
      { ...changes[0], id: 'c9', status: 'intacct_changed', decidedByName: 'Charmi Desai', decidedAt: '2026-10-26T18:13:00Z', intacctSeenAt: '2026-10-27T16:31:00Z',
        intacctCheck: { phone: { state: 'changed', intacct: '760-555-0111' } } },
    ] });
    render(<PartnersTab canApprove />);
    await screen.findByText('Acme Plumbing');
    fireEvent.click(screen.getByRole('button', { name: /Requests/ }));
    const row = (await screen.findByText('Amy Bolanos')).closest('tr');
    expect(within(row).getByText('Changed In Intacct')).toBeTruthy();
    expect(within(row).getByText(/Seen in Intacct 10\/27\/2026/)).toBeTruthy();
    expect(within(row).getByText('Phone: Intacct has 760-555-0111')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'In Intacct' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' }), 'only a pending request is decided').toBeNull();
    api.getAccountingPartnerChanges.mockImplementation(async () => ({ changes }));
  });

  it('hides the decision buttons from someone who cannot approve', async () => {
    render(<PartnersTab />);
    await screen.findByText('Acme Plumbing');
    fireEvent.click(screen.getByRole('button', { name: /Requests/ }));
    await screen.findByText('760-555-0199');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
  });

  it('says so when the accounting app has not shipped the records yet', async () => {
    api.getAccountingPartners.mockRejectedValueOnce(Object.assign(new Error('Not available yet'), { status: 501 }));
    render(<PartnersTab />);
    expect(await screen.findByText(/Not available yet - the accounting app needs its update/)).toBeTruthy();
  });

  it('lists the ledger vendors read-only, number first, and opens their lines (Oct 14)', async () => {
    api.getAccountingPartners.mockResolvedValueOnce({ kind: 'vendor', source: 'ledger', partners: [
      { id: 'V00412', kind: 'vendor', name: 'Home Depot', displayName: 'Home Depot', status: '', lines: 1240, address: {} },
    ] });
    const drills = [];
    const onDrill = (e) => drills.push(e.detail);
    window.addEventListener('nexus:accounting-drill', onDrill);
    try {
      render(<PartnersTab />);
      const row = (await screen.findByText('Home Depot')).closest('tr');
      const cells = within(row).getAllByRole('cell');
      expect(cells[0].textContent).toBe('V00412');
      expect(within(row).getByText('1,240')).toBeTruthy();
      expect(screen.getByRole('columnheader', { name: 'Vendor Number' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Edit Home Depot' })).toBeNull();
      fireEvent.click(within(row).getByRole('button', { name: 'Ledger lines of Home Depot' }));
      expect(drills[0].party).toEqual({ kind: 'vendor', code: 'V00412', name: 'Home Depot' });
    } finally {
      window.removeEventListener('nexus:accounting-drill', onDrill);
    }
  });

  // Oct 22 (Charmi, 10/16: "drill down into a vendor - still can't").
  it('opens a record from its row: fields, ledger activity and change history', async () => {
    render(<PartnersTab />);
    fireEvent.click((await screen.findByText('Acme Plumbing')).closest('tr'));
    const panel = await screen.findByRole('dialog', { name: 'Vendor V00012' });
    expect(api.getAccountingPartnerRecord).toHaveBeenCalledWith('vendor', 'V00012');
    expect(within(panel).getByText('Vendor V00012 - Acme Plumbing')).toBeTruthy();
    expect(await within(panel).findByDisplayValue('Net 30')).toBeTruthy();
    expect(within(panel).getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Basic Details', 'Contact', 'Address', 'Billing']);
    fireEvent.click(within(panel).getByRole('tab', { name: 'Ledger Lines' }));
    const activity = await within(panel).findByRole('region', { name: 'Ledger Activity' });
    expect(within(activity).getByText('41')).toBeTruthy();
    expect(within(activity).getByText('Invoice 1182 - pipe')).toBeTruthy();
    expect(within(activity).getByText('09/30/2026')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('tab', { name: 'Change History' }));
    const history = within(panel).getByRole('region', { name: 'Change History' });
    expect(within(history).getByText('760-555-0199')).toBeTruthy();
    expect(within(history).getByText('Pending Approval')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Edit opens the same panel, on Details.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Acme Plumbing' }));
    expect(within(await screen.findByRole('dialog', { name: 'Vendor V00012' })).getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true');
  });

  // Oct 22 (Charmi): Customize hides inactive records by default.
  it('hides inactive records until Customize > Show Inactive', async () => {
    api.getAccountingPartners.mockResolvedValue({ kind: 'vendor', partners: [...vendors, { ...vendors[1], id: 'V00099', name: 'Old Roofing', displayName: 'Old Roofing', status: 'inactive', awaitingIntacct: false }] });
    render(<PartnersTab />);
    await screen.findByText('Acme Plumbing');
    expect(screen.queryByText('Old Roofing')).toBeNull();
    expect(screen.getByText(/1 inactive vendor hidden/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    fireEvent.click(screen.getByLabelText(/Show Inactive/));
    expect(await screen.findByText('Old Roofing')).toBeTruthy();
    expect(screen.queryByText(/inactive vendor hidden/)).toBeNull();
    expect(isInactive({ status: 'Inactive' })).toBe(true);
    expect(isInactive({ status: 'active' })).toBe(false);
    expect(isInactive({})).toBe(false);
  });
});

// Accounting call 10/23, items 03, 06 and 07.
const many = (n) => Array.from({ length: n }, (_, i) => ({ ...vendors[0], id: `V${String(i + 1).padStart(5, '0')}`, name: `Vendor ${String(i + 1).padStart(3, '0')}`, displayName: `Vendor ${String(i + 1).padStart(3, '0')}` }));

describe('PartnersTab - the 10/23 call', () => {
  beforeEach(() => {
    api.getAccountingPartners.mockImplementation(async () => ({ kind: 'vendor', partners: vendors }));
    api.getAccountingPartnerRecord.mockImplementation(async (kind, id) => ({ kind, source: 'intacct', record: vendors.find((v) => v.id === id), history: [], activity: null, activityError: '' }));
  });
  it('pages through every record instead of stopping at 300, inside its own banded box', async () => {
    api.getAccountingPartners.mockResolvedValue({ kind: 'vendor', partners: many(350) });
    render(<PartnersTab />);
    await screen.findByText('Vendor 001');
    expect(screen.getByTestId('partners-box').className).toContain('acct-partners-box');
    expect(screen.getByTestId('partners-box').querySelector('table').className).toContain('acct-partners');
    expect(screen.getByText(/Page 1 of 4 · Rows 1-100 of 350/)).toBeTruthy();
    expect(screen.queryByText(/Showing the first/)).toBeNull();
    for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(screen.getByText(/Page 4 of 4 · Rows 301-350 of 350/)).toBeTruthy();
    expect(screen.getByText('Vendor 350')).toBeTruthy();
    expect(screen.queryByText('Vendor 001')).toBeNull();
  });

  it('keeps search as an icon that opens on a click or Ctrl+F', async () => {
    render(<PartnersTab />);
    await screen.findByText('Acme Plumbing');
    expect(screen.queryByRole('textbox', { name: 'Search vendors' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Search' }));
    const box = screen.getByRole('textbox', { name: 'Search vendors' });
    fireEvent.change(box, { target: { value: 'bay' } });
    expect(screen.queryByText('Acme Plumbing')).toBeNull();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Search vendors' })).toBeNull();
    expect(screen.getByText('Acme Plumbing')).toBeTruthy();
    const ctrlF = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ctrlF);
    expect(ctrlF.defaultPrevented).toBe(true);
    expect(await screen.findByRole('textbox', { name: 'Search vendors' })).toBeTruthy();
  });

  it('exports the list as filtered, every page, to Excel or CSV', async () => {
    render(<PartnersTab />);
    await screen.findByText('Acme Plumbing');
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /CSV/ }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    const file = URL.createObjectURL.mock.calls[0][0];
    expect(file.name).toMatch(/^Vendors - \d{2}-\d{2}-\d{4}\.csv$/);
    const t = partnersTable(vendors, { kind: 'vendor', fromLedger: false });
    expect(t.columns.map((c) => c.label)).toEqual(['Vendor Number', 'Name', 'Email', 'Phone', 'City', 'Terms', 'Status', 'Entity']);
    expect(t.rows[0]).toEqual(['V00012', 'Acme Plumbing', 'ap@acme.com', '760-555-0100', 'Escondido', 'Net 30', 'active', '15000']);
    expect(t.subtitle).toMatch(/^2 vendors · As of \d{2}\/\d{2}\/\d{4}$/);
  });

  it('has the standard table view: filters, a value list, the heading menu, and an export of exactly what shows (10/23, item 01)', async () => {
    render(<PartnersTab />);
    await screen.findByText('Acme Plumbing');
    expect(screen.getByRole('button', { name: 'View: Built-in Default' })).toBeTruthy();
    // Excel-style value list on City: Escondido only.
    fireEvent.click(screen.getByRole('button', { name: 'Filter City by value' }));
    const list = await screen.findByRole('dialog', { name: 'City values' });
    fireEvent.click(within(list).getByRole('checkbox', { name: /\(Blanks\)/ }));
    expect(screen.queryByText('Bay Electric')).toBeNull();
    expect(screen.getByRole('button', { name: 'Filters (1 on)' })).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Clear Filter' }));
    // Sort Name descending, hide Email; the export follows.
    fireEvent.click(screen.getByRole('button', { name: /^Name - column menu/ }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Name column' })).getByRole('menuitemradio', { name: /Sort Descending/ }));
    expect(screen.getAllByRole('row')[1].textContent).toContain('Bay Electric');
    fireEvent.click(screen.getByRole('button', { name: /^Email - column menu/ }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Email column' })).getByRole('menuitem', { name: /Hide Column/ }));
    expect(screen.queryByRole('columnheader', { name: 'Email' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /CSV/ }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    const file = URL.createObjectURL.mock.calls[0][0];
    const text = await new Promise((done) => { const fr = new FileReader(); fr.onload = () => done(fr.result); fr.readAsText(file); });
    const csv = text.replace(/^\s+/, '').split('\r\n');
    expect(csv[0]).toBe('Vendor Number,Name,Phone,City,Terms,Status,Entity');
    expect(csv[1]).toMatch(/^V00013,Bay Electric,/);
  });

  it('opens records on the right with the list still clickable; another row swaps it', async () => {
    render(<PartnersTab />);
    fireEvent.click((await screen.findByText('Acme Plumbing')).closest('tr'));
    const panel = await screen.findByRole('dialog', { name: 'Vendor V00012' });
    expect(panel.getAttribute('aria-modal')).toBe('false');
    expect(within(panel).getByRole('button', { name: /Open Full/ })).toBeTruthy();
    expect(screen.getByText('Acme Plumbing', { selector: 'strong' }).closest('tr').className).toBe('is-open');
    fireEvent.click(screen.getByText('Bay Electric', { selector: 'strong' }).closest('tr'));
    expect(await screen.findByRole('dialog', { name: 'Vendor V00013' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Vendor V00012' })).toBeNull();
  });

  it('asks before unsaved edits are dropped by Close', async () => {
    appDialog.confirm.mockResolvedValueOnce(false);
    render(<PartnersTab />);
    fireEvent.click((await screen.findByText('Acme Plumbing')).closest('tr'));
    const panel = await screen.findByRole('dialog', { name: 'Vendor V00012' });
    fireEvent.change(await within(panel).findByLabelText('Phone'), { target: { value: '1' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(appDialog.confirm).toHaveBeenCalled());
    expect(screen.getByRole('dialog', { name: 'Vendor V00012' })).toBeTruthy();
  });

  it('Back from the ledger lines returns to the same record, search and page', async () => {
    const list = many(250);
    api.getAccountingPartners.mockResolvedValue({ kind: 'vendor', partners: list });
    api.getAccountingPartnerRecord.mockImplementation(async (kind, id) => ({ kind, source: 'intacct', record: list.find((r) => r.id === id), history: [], activity: null, activityError: '' }));
    const drills = [];
    const onDrill = (e) => drills.push(e.detail);
    window.addEventListener('nexus:accounting-drill', onDrill);
    try {
      const first = render(<PartnersTab />);
      await screen.findByText('Vendor 001');
      fireEvent.click(screen.getByRole('button', { name: 'Open Search' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Search vendors' }), { target: { value: 'Vendor' } });
      fireEvent.click(screen.getByRole('button', { name: /Next/ }));
      fireEvent.click(screen.getByText('Vendor 150', { selector: 'strong' }).closest('tr'));
      const panel = await screen.findByRole('dialog', { name: 'Vendor V00150' });
      fireEvent.click(within(panel).getByRole('button', { name: /View All Ledger Lines/ }));
      expect(drills[0].party).toEqual({ kind: 'vendor', code: 'V00150', name: 'Vendor 150' });
      expect(drills[0].back).toEqual({ label: 'Back to Vendors', sub: 'partners' });
      first.unmount();
      // Back: the screen mounts again, as it was.
      render(<PartnersTab />);
      expect(await screen.findByRole('dialog', { name: 'Vendor V00150' })).toBeTruthy();
      expect(screen.getByRole('textbox', { name: 'Search vendors' }).value).toBe('Vendor');
      expect(screen.getByText(/Page 2 of 3/)).toBeTruthy();
      expect(screen.getByText('Vendor 150', { selector: 'strong' }).closest('tr').className).toBe('is-open');
    } finally {
      window.removeEventListener('nexus:accounting-drill', onDrill);
    }
  });

  // Fixes 10/24 (items 02 and 13): the shared control bar and the list's own Sync.
  it('Sync reads the list again, fresh, and keeps the open record, the search, the page and the scroll', async () => {
    const list = many(250);
    api.getAccountingPartners.mockResolvedValue({ kind: 'vendor', partners: list });
    api.getAccountingPartnerRecord.mockImplementation(async (kind, id) => ({ kind, source: 'intacct', record: list.find((r) => r.id === id), history: [], activity: null, activityError: '' }));
    const { container } = render(<PartnersTab />);
    await screen.findByText('Vendor 001');
    expect(container.querySelector('.acct-controlbar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Search' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search vendors' }), { target: { value: 'Vendor' } });
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    fireEvent.click(screen.getByText('Vendor 150', { selector: 'strong' }).closest('tr'));
    await screen.findByRole('dialog', { name: 'Vendor V00150' });
    screen.getByTestId('partners-box').scrollTop = 240;
    let release;
    api.getAccountingPartners.mockImplementationOnce(() => new Promise((r) => { release = () => r({ kind: 'vendor', partners: list.map((v) => (v.id === 'V00150' ? { ...v, displayName: 'Vendor 150 Renamed' } : v)) }); }));
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));
    expect(withFreshReads).toHaveBeenCalledTimes(1);
    expect(api.getAccountingPartners).toHaveBeenLastCalledWith('vendor', '');
    // While it reads, the rows and the open record stay.
    expect(screen.getByText('Vendor 150', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync' }).getAttribute('aria-busy')).toBe('true');
    release();
    expect(await screen.findByText('Vendor 150 Renamed', { selector: 'strong' })).toBeTruthy();
    expect(api.getAccountingPartnerChanges).toHaveBeenCalledTimes(1);    // only the list was read again
    expect(screen.getByRole('dialog', { name: 'Vendor V00150' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Search vendors' }).value).toBe('Vendor');
    expect(screen.getByText(/Page 2 of 3/)).toBeTruthy();
    expect(screen.getByTestId('partners-box').scrollTop).toBe(240);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sync' }).getAttribute('aria-busy')).toBeNull());
  });

  it('Requests has its own Sync too, reading only the requests again', async () => {
    render(<PartnersTab canApprove />);
    await screen.findByText('Acme Plumbing');
    fireEvent.click(screen.getByRole('button', { name: /^Requests/ }));
    await screen.findByText('Amy Bolanos');
    fireEvent.click(screen.getByRole('button', { name: 'Sync Requests' }));
    expect(withFreshReads).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.getAccountingPartnerChanges).toHaveBeenCalledTimes(2));
    expect(api.getAccountingPartners).toHaveBeenCalledTimes(1);
  });
});
