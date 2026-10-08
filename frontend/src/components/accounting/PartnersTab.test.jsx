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
  },
}));
vi.mock('../../ui/dialog', () => ({ dialog: { alert: vi.fn(async () => true), confirm: vi.fn(async () => true), prompt: vi.fn(async () => 'Please') } }));

import PartnersTab, { diffPartner } from './PartnersTab';
import { api } from '../../api';

beforeEach(() => {
  vi.clearAllMocks();
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
});
