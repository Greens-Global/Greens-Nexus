import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render-smoke for Accounting -> Leasing (Neil and Charmi, Sep 25): the rent
// roll month by month, who is behind and how to reach them, a deduction with
// its note, a lease with its rent changes, and a new tenant taking a space
// without the old one being overwritten.

const lease = (over = {}) => ({
  id: 'L1', propertyName: '910 SECR - Ste 100, San Clemente', region: 'Orange County', tenancy: 'external', landlord: 'Greens Global, Inc.', entityCode: '15000',
  incomeAccounts: ['41101'], customerId: 'C00498', tenantName: 'Overstie Management', contactName: 'Sahil Desai', phone: '949-400-2788', email: 'tenant@example.com',
  mailingAddress: '', leaseStart: '2026-01-01', leaseEnd: '', securityDeposit: 5500, leaseTerms: 'Annual', lateFee: 100, dueDay: 1, graceDays: 5, status: 'active', notes: '', replacesId: '',
  rates: [{ id: 'r1', startDate: '2026-01-01', rent: 3000, cam: 200, other: 0, note: '' }], ...over,
});
const cell = (month, status, received, extra = {}) => ({ month: `2026-${month}`, inForce: true, expected: 3200, received, balance: 3200 - received, status, adjustment: 0, note: '', lateFee: ['short', 'unpaid', 'late'].includes(status) ? 100 : 0, ...extra });
const months = (list) => list.concat(Array.from({ length: 12 - list.length }, (_, i) => cell(String(list.length + i + 1).padStart(2, '0'), 'upcoming', 0)));
const roll = {
  year: 2026, asOf: '2026-04-20',
  rows: [
    { lease: lease(), months: months([cell('01', 'paid', 3200), cell('02', 'short', 2800), cell('03', 'paid', 2955, { expected: 2955, balance: 0, adjustment: 245, note: 'AC repair taken off the rent' }), cell('04', 'late', 0)]), balanceToDate: 3600, monthsBehind: 2, owed: 3600, lateFees: 200 },
    { lease: lease({ id: 'L2', propertyName: '47385 RCR, Temecula', tenantName: 'Santos Blancas Jr.', customerId: 'C00497', email: '' }), months: months([cell('01', 'paid', 3200), cell('02', 'paid', 3200), cell('03', 'paid', 3200), cell('04', 'paid', 3200)]), balanceToDate: 0, monthsBehind: 0, owed: 0, lateFees: 0 },
  ],
  totals: Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, expected: i < 4 ? 6400 : 0, received: [6400, 6000, 6155, 3200][i] || 0 })),
  summary: { leases: 2, behind: 1, owed: 3600, expectedToDate: 25355, receivedToDate: 21755 },
};

vi.mock('../../api', () => ({
  api: {
    getLeasingRentRoll: vi.fn(async () => roll),
    getLeasingCustomers: vi.fn(async () => ({ customers: [{ code: 'C00272', name: 'Dr. Azadeh Sham' }, { code: 'C00498', name: 'Overstie Management' }] })),
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '15000', name: 'Greens Escondido' }] })),
    setLeasingMonth: vi.fn(async () => ({})),
    updateLeasingLease: vi.fn(async (id, body) => ({ id, ...body })),
    replaceLeasingTenant: vi.fn(async (id, body) => ({ id: 'L3', ...body })),
    createLeasingLease: vi.fn(async (body) => ({ id: 'L9', ...body })),
  },
}));

import LeasingTab from './LeasingTab';
import { api } from '../../api';

beforeEach(() => { vi.clearAllMocks(); });

describe('LeasingTab', () => {
  it('shows every month of every lease and what is owed', async () => {
    render(<LeasingTab canEdit />);
    const row = (await screen.findByText('910 SECR - Ste 100, San Clemente')).closest('tr');
    expect(within(row).getByText('Overstie Management')).toBeTruthy();
    expect(within(row).getByText('3,600.00')).toBeTruthy();
    // A short month says what came in; the note is marked.
    expect(within(row).getByRole('button', { name: /Feb 2026: Short, received 2,800.00 of 3,200.00/ }).textContent).toBe('2,800');
    expect(within(row).getByRole('button', { name: /Mar 2026: Paid/ }).textContent).toBe('2,955*');
    expect(within(row).getByRole('button', { name: /Apr 2026: Late/ })).toBeTruthy();
    expect(screen.getByText('Outstanding (1)')).toBeTruthy();
    expect(api.getLeasingRentRoll).toHaveBeenCalledWith(new Date().getFullYear());
  });

  it('lists who is behind, with a letter ready to send from their own email', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    fireEvent.click(screen.getByRole('button', { name: /Outstanding/ }));
    const row = screen.getByText('Overstie Management').closest('tr');
    expect(within(row).getByText('2 - Feb, Apr')).toBeTruthy();
    expect(within(row).getByText('Sahil Desai · 949-400-2788')).toBeTruthy();
    const href = decodeURIComponent(within(row).getByRole('link', { name: /Write to Tenant/ }).getAttribute('href'));
    expect(href.startsWith('mailto:tenant@example.com?subject=Rent outstanding - 910 SECR')).toBe(true);
    expect(href).toContain('Feb 2026: 400.00 of 3,200.00');
    expect(href).toContain('Total outstanding: 3,600.00');
    // The tenant who is paid up is not on this list.
    expect(screen.queryByText('Santos Blancas Jr.')).toBeNull();
  });

  it('records a deduction and its note for one month', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    fireEvent.click(screen.getByRole('button', { name: /910 SECR.*Apr 2026: Late/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/account 41101 for customer C00498/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Agreed Deduction'), { target: { value: '250' } });
    fireEvent.change(within(dialog).getByLabelText('Note'), { target: { value: 'Plumbing repair' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setLeasingMonth).toHaveBeenCalledWith('L1', '2026-04', { adjustment: 250, note: 'Plumbing repair' }));
  });

  it('adds a rent change to a lease', async () => {
    render(<LeasingTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: '910 SECR - Ste 100, San Clemente' }));
    const dialog = screen.getByRole('dialog', { name: 'Change lease' });
    fireEvent.click(within(dialog).getByRole('button', { name: /Add Rent Change/ }));
    fireEvent.change(within(dialog).getByLabelText('Rent 2 starts'), { target: { value: '2027-01-01' } });
    fireEvent.change(within(dialog).getByLabelText('Rent of rent 2'), { target: { value: '3300' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateLeasingLease).toHaveBeenCalled());
    const [id, body] = api.updateLeasingLease.mock.calls[0];
    expect(id).toBe('L1');
    expect(body.rates).toEqual([{ startDate: '2026-01-01', rent: 3000, cam: 200, other: 0, note: '' }, { startDate: '2027-01-01', rent: 3300, cam: 200, other: 0, note: '' }]);
    expect(body.incomeAccounts).toEqual(['41101']);
  });

  it('puts a new tenant in a space without overwriting the old one', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    fireEvent.click(screen.getByRole('button', { name: 'Tenants' }));
    fireEvent.click(screen.getByRole('button', { name: 'New tenant at 910 SECR - Ste 100, San Clemente' }));
    const dialog = screen.getByRole('dialog', { name: 'New tenant in this space' });
    // The space comes along; the tenant does not.
    expect(within(dialog).getByLabelText('Property or Space').value).toBe('910 SECR - Ste 100, San Clemente');
    expect(within(dialog).getByLabelText('Tenant Name').value).toBe('');
    fireEvent.change(within(dialog).getByLabelText('Tenant - find the Intacct customer'), { target: { value: 'azadeh' } });
    fireEvent.click(await within(dialog).findByRole('option', { name: /Dr. Azadeh Sham/ }));
    expect(within(dialog).getByLabelText('Intacct Customer Code').value).toBe('C00272');
    fireEvent.change(within(dialog).getByLabelText('Last Day of Overstie Management'), { target: { value: '2026-06-30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.replaceLeasingTenant).toHaveBeenCalled());
    const [id, body] = api.replaceLeasingTenant.mock.calls[0];
    expect(id).toBe('L1');
    expect(body).toMatchObject({ tenantName: 'Dr. Azadeh Sham', customerId: 'C00272', movedOut: '2026-06-30', entityCode: '15000' });
  });

  it('is read-only for a viewer', async () => {
    render(<LeasingTab />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    expect(screen.queryByRole('button', { name: /New Lease/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /910 SECR.*Feb 2026: Short/ }));
    expect(within(screen.getByRole('dialog')).queryByLabelText('Agreed Deduction')).toBeNull();
  });

  it('says so when the ledger could not be read', async () => {
    api.getLeasingRentRoll.mockResolvedValueOnce({ ...roll, warning: 'Payments could not be read from the ledger (Accounting service returned 500). Expected rent is shown; received is not.' });
    render(<LeasingTab />);
    expect(await screen.findByText(/Payments could not be read from the ledger/)).toBeTruthy();
    expect(screen.getByText('910 SECR - Ste 100, San Clemente')).toBeTruthy();
  });
});
