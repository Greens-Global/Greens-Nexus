import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// MRI -> Leasing -> Set Up From the Ledger (Neil and Charmi, 10/02): the
// proposals from rent postings (one per entity and customer), the ones
// already on an active lease marked, the ticked ones created the way New
// Lease is, the empty state that names the account titles looked for, and
// the "not available" state. Also: the button sits beside New Lease on the
// Leasing tab and the rent roll reloads after a create.

const proposals = {
  from: '2025-10-01', to: '2026-09-30', entitiesScanned: 3, parentsSkipped: 1, historicalSkipped: 2, entitiesWithRentAccounts: 2, lookedFor: ['Rent', 'Rental', 'Lease / Leasing', 'Tenant'],
  rentAccounts: [{ entityCode: '15000', entityName: 'Greens Escondido, LLC.', code: '41101', title: 'Rental Income' }],
  setUp: 1, missing: 1,
  proposals: [
    { entityCode: '15000', entityName: 'Greens Escondido, LLC.', customerId: 'C00498', tenantName: 'Overstie Management', incomeAccounts: ['41101'], accountTitles: ['Rental Income'], monthlyRent: 3200, firstMonth: '2026-01', lastMonth: '2026-09', postedMonths: 9, received12: 28800, monthly: [], status: 'set_up', leaseId: 'L1' },
    { entityCode: '15000', entityName: 'Greens Escondido, LLC.', customerId: 'C00497', tenantName: 'Santos Blancas Jr.', incomeAccounts: ['41101'], accountTitles: ['Rental Income'], monthlyRent: 2100, firstMonth: '2025-11', lastMonth: '2026-09', postedMonths: 11, received12: 23100, monthly: [], status: 'new', leaseId: null },
  ],
};

vi.mock('../../api', () => ({
  api: {
    getLeaseProposals: vi.fn(async () => proposals),
    createLeasesFromLedger: vi.fn(async ({ items }) => ({ created: items.map((i) => ({ ...proposals.proposals.find((p) => p.customerId === i.customerId), leaseId: 'L9' })), skipped: [] })),
    getLeasingRentRollFor: vi.fn(async () => ({ year: 2026, asOf: '2026-09-30', rows: [], totals: [], summary: { leases: 0, behind: 0, owed: 0, expectedToDate: 0, receivedToDate: 0 } })),
    getLeasingCustomers: vi.fn(async () => ({ customers: [] })),
    getAccountingLocations: vi.fn(async () => ({ entities: [] })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
    getLeasingCustomer: vi.fn(async (code) => ({ code, name: 'Overstie Management', phone: '(949) 400-2788', email: 'ap@overstie.example', address: '100 Main St, San Clemente, CA 92672', active: true, source: 'intacct', leases: [] })),
    setLeasingNote: vi.fn(async (id, note) => ({ text: note, by: 'charmi@greensglobal.com', byName: 'Charmi Desai', at: '2026-10-06T16:00:00Z' })),
    syncLeasingFromLedger: vi.fn(async () => ({ linked: [], created: [], notes: [] })),
  },
}));

import LeasingFromLedger from './LeasingFromLedger';
import LeasingTab from './LeasingTab';
import { api } from '../../api';

beforeEach(() => { vi.clearAllMocks(); api.getLeaseProposals.mockImplementation(async () => proposals); });

describe('LeasingFromLedger', () => {
  it('proposes one lease per customer with rent postings and creates the ticked ones', async () => {
    const onCreated = vi.fn();
    render(<LeasingFromLedger onClose={() => {}} onCreated={onCreated} />);
    const dialog = await screen.findByRole('dialog', { name: /Set up leases from the ledger/ });
    await within(dialog).findByText('Santos Blancas Jr.');
    const existing = within(dialog).getByText('Overstie Management').closest('tr');
    expect(within(existing).getByText('Set Up')).toBeTruthy();
    expect(within(existing).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).getByText('Entities scanned: 3 leaf entities (1 parent skipped - their figures roll up from the children); 2 historical (H) entities not read')).toBeTruthy();
    const fresh = within(dialog).getByText('Santos Blancas Jr.').closest('tr');
    expect(within(fresh).getByText('2,100.00')).toBeTruthy();
    expect(within(fresh).getByText('Nov 2025')).toBeTruthy();
    expect(within(fresh).getByRole('checkbox').checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create 1 Lease' }));
    await within(dialog).findByText('1 lease set up.');
    expect(api.createLeasesFromLedger).toHaveBeenCalledWith({ items: [{ entityCode: '15000', customerId: 'C00497' }] });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(onCreated).toHaveBeenCalled();
  });

  it('says which account titles it looked for when nothing posted', async () => {
    api.getLeaseProposals.mockImplementation(async () => ({ ...proposals, proposals: [], entitiesWithRentAccounts: 1 }));
    render(<LeasingFromLedger onClose={() => {}} onCreated={() => {}} />);
    await screen.findByText('No rent postings found.');
    expect(screen.getByText(/Rent, Rental, Lease \/ Leasing, Tenant in 3 active entities/)).toBeTruthy();
    expect(screen.getByText(/41101 Rental Income/)).toBeTruthy();
    expect(screen.getByText(/add the lease by hand with New Lease/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Create/ })).toBeNull();
  });

  it('polls the scan every few seconds, showing the progress until the table', async () => {
    let n = 0;
    const scanning = (done, total) => ({ scanning: true, done, total, startedAt: '2026-10-02T18:00:00Z' });
    api.getLeaseProposals.mockImplementation(async () => { n += 1; return n === 1 ? scanning(0, 253) : n === 2 ? scanning(120, 253) : proposals; });
    render(<LeasingFromLedger pollMs={20} onClose={() => {}} onCreated={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: /Set up leases from the ledger/ });
    await within(dialog).findByText('Reading the ledger... 0 of 253 entities');
    await within(dialog).findByText('Reading the ledger... 120 of 253 entities');
    expect(within(dialog).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('120');
    await within(dialog).findByText('Santos Blancas Jr.');
    expect(within(dialog).queryByRole('progressbar')).toBeNull();
    expect(api.getLeaseProposals).toHaveBeenCalledTimes(3);
  });

  it('shows why a scan failed and starts it over on Try Again', async () => {
    let n = 0;
    api.getLeaseProposals.mockImplementation(async () => { n += 1; if (n === 1) { const e = new Error('Accounting service error: the ledger is closed for maintenance'); e.status = 424; throw e; } return proposals; });
    render(<LeasingFromLedger pollMs={20} onClose={() => {}} onCreated={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: /Set up leases from the ledger/ });
    await within(dialog).findByText(/closed for maintenance/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try Again' }));
    await within(dialog).findByText('Santos Blancas Jr.');
  });

  it('says so when the accounting service is not connected', async () => {
    api.getLeaseProposals.mockImplementation(async () => { const e = new Error('Accounting service is not configured'); e.status = 503; throw e; });
    render(<LeasingFromLedger onClose={() => {}} onCreated={() => {}} />);
    await screen.findByText('Not available here.');
  });

  it('opens from the Leasing tab beside New Lease and reloads the rent roll after', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByRole('button', { name: /New Lease/ });
    fireEvent.click(screen.getByRole('button', { name: /Set Up From the Ledger/ }));
    const dialog = await screen.findByRole('dialog', { name: /Set up leases from the ledger/ });
    await within(dialog).findByText('Santos Blancas Jr.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create 1 Lease' }));
    await within(dialog).findByText('1 lease set up.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(api.getLeasingRentRollFor).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
