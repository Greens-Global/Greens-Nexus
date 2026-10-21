import { describe, it, expect, vi, beforeEach } from 'vitest';
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
}));
vi.mock('../../ui/dialog', () => ({ dialog: { alert: vi.fn(async () => true), confirm: vi.fn(async () => true), prompt: vi.fn(async () => 'Please') } }));

import PartnersTab, { diffPartner, isInactive } from './PartnersTab';
import { api } from '../../api';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountingPrefs();
  try { localStorage.clear(); } catch { /* private mode */ }
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
  globalThis.URL.revokeObjectURL = vi.fn();
});

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
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Phone'), { target: { value: '760-555-0199' } });
    fireEvent.change(within(dialog).getByLabelText('City'), { target: { value: 'San Marcos' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send for Approval' }));
    await waitFor(() => expect(api.createAccountingPartnerChange).toHaveBeenCalled());
    expect(api.createAccountingPartnerChange.mock.calls[0][0]).toEqual({
      kind: 'vendor', partnerId: 'V00012', partnerName: 'Acme Plumbing', note: 'Please',
      changes: { phone: { from: '760-555-0100', to: '760-555-0199' }, 'address.city': { from: 'Escondido', to: 'San Marcos' } },
    });
    expect(diffPartner(vendors[0], vendors[0])).toEqual({});
  });

  it('lets a manager approve a pending request and export the approved ones', async () => {
    render(<PartnersTab canApprove />);
    await screen.findByText('Acme Plumbing');
    fireEvent.click(screen.getByRole('button', { name: /Requests/ }));
    expect(await screen.findByText('760-555-0199')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.decideAccountingPartnerChange).toHaveBeenCalledWith('c1', 'approve', 'Please'));
    fireEvent.click(screen.getByRole('button', { name: /Export Approved CSV/ }));
    await waitFor(() => expect(api.exportAccountingPartnerChanges).toHaveBeenCalledWith('approved', 'vendor'));
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
    expect(within(panel).getByText('Net 30')).toBeTruthy();
    const activity = await within(panel).findByRole('region', { name: 'Ledger Activity' });
    expect(within(activity).getByText('41')).toBeTruthy();
    expect(within(activity).getByText('Invoice 1182 - pipe')).toBeTruthy();
    expect(within(activity).getByText('09/30/2026')).toBeTruthy();
    const history = within(panel).getByRole('region', { name: 'Change History' });
    expect(within(history).getByText('760-555-0199')).toBeTruthy();
    expect(within(history).getByText('Pending Approval')).toBeTruthy();
    // The row's own buttons keep their jobs - Edit does not open the record.
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Acme Plumbing' }));
    expect(api.getAccountingPartnerRecord).toHaveBeenCalledTimes(1);
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
