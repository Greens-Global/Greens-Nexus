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
    getLeasingRentRollFor: vi.fn(async () => roll),
    getLeasingCustomers: vi.fn(async () => ({ customers: [{ code: 'C00272', name: 'Dr. Azadeh Sham' }, { code: 'C00498', name: 'Overstie Management' }] })),
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '15000', name: 'Greens Escondido' }] })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
    getLeasingCustomer: vi.fn(async (code) => ({ code, name: 'Overstie Management', phone: '(949) 400-2788', email: 'ap@overstie.example', address: '100 Main St, San Clemente, CA 92672', active: true, source: 'intacct', leases: [] })),
    setLeasingNote: vi.fn(async (id, note) => ({ text: note, by: 'charmi@greensglobal.com', byName: 'Charmi Desai', at: '2026-10-06T16:00:00Z' })),
    syncLeasingFromLedger: vi.fn(async () => ({ linked: [], created: [], notes: [] })),
    setLeasingMonth: vi.fn(async () => ({})),
    updateLeasingLease: vi.fn(async (id, body) => ({ id, ...body })),
    replaceLeasingTenant: vi.fn(async (id, body) => ({ id: 'L3', ...body })),
    createLeasingLease: vi.fn(async (body) => ({ id: 'L9', ...body })),
    getAccountingBucketsFor: vi.fn(async () => ({ rows: [] })),
    searchAccountingLedger: vi.fn(async () => ({ rows: [] })),
    getAccountingEntry: vi.fn(async () => ({ entry: { entry_no: 'JE-1042' }, lines: [], intacct: [] })),
  },
}));

import LeasingTab from './LeasingTab';
import { api } from '../../api';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => { vi.clearAllMocks(); try { localStorage.clear(); } catch { /* none */ } resetAccountingPrefs(); });

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
    expect(api.getLeasingRentRollFor).toHaveBeenCalledWith(new Date().getFullYear(), { entities: [] });
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
    fireEvent.click(screen.getByRole('button', { name: 'Payers' }));
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
    api.getLeasingRentRollFor.mockResolvedValueOnce({ ...roll, warning: 'Payments could not be read from the ledger (Accounting service returned 500). Expected rent is shown; received is not.' });
    render(<LeasingTab />);
    expect(await screen.findByText(/Payments could not be read from the ledger/)).toBeTruthy();
    expect(screen.getByText('910 SECR - Ste 100, San Clemente')).toBeTruthy();
  });
});

// Oct 6 (Charmi, MRI feedback of 10/04): filters, Total and Balance, Notes,
// the customer card, expired and inactive leases, the export menu, the sync.
describe('LeasingTab - the 10/04 feedback', () => {
  const prepaid = { ...roll.rows[1], months: months([cell('01', 'paid', 6400, { balance: -3200 }), cell('02', 'paid', 3200), cell('03', 'paid', 3200), cell('04', 'paid', 3200)]), balanceToDate: -3200 };
  const ended = { lease: lease({ id: 'L3', propertyName: 'Suite 300, Escondido', tenantName: 'Old Tenant LLC', customerId: 'C00100', status: 'ended', leaseEnd: '2026-02-28' }), months: months([cell('01', 'paid', 3200), cell('02', 'paid', 3200)]), balanceToDate: 0, monthsBehind: 0, owed: 0, lateFees: 0, expired: true, customerActive: true };
  const gone = { lease: lease({ id: 'L4', propertyName: 'Suite 400, Escondido', tenantName: 'Closed Co', customerId: 'C00101' }), months: months([cell('01', 'paid', 3200)]), balanceToDate: 0, monthsBehind: 0, owed: 0, lateFees: 0, expired: false, customerActive: false };
  const full = { ...roll, rows: [{ ...roll.rows[0], expired: false, customerActive: true, lease: lease({ teamNote: { text: 'Promised by the 15th', by: 'charmi@greensglobal.com', byName: 'Charmi Desai', at: '2026-10-01T16:00:00Z' } }) }, { ...prepaid, expired: false, customerActive: true }, ended, gone], linked: [] };
  beforeEach(() => { api.getLeasingRentRollFor.mockResolvedValue(full); });

  it('adds a Total column and a Balance, where a prepayment is a credit', async () => {
    render(<LeasingTab canEdit />);
    const row = (await screen.findByText('910 SECR - Ste 100, San Clemente')).closest('tr');
    expect(screen.getByRole('columnheader', { name: 'Total' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Balance' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Owed' })).toBeNull();
    expect(within(row).getByText('8,955.00')).toBeTruthy();       // 3,200 + 2,800 + 2,955 + 0 received
    expect(within(row).getByText('3,600.00')).toBeTruthy();       // the balance
    const paidAhead = screen.getByText('47385 RCR, Temecula').closest('tr');
    expect(within(paidAhead).getByText('16,000.00')).toBeTruthy();
    expect(within(paidAhead).getByText('(3,200.00)')).toBeTruthy();
    // The grand total row: received and the balance over the leases shown.
    const grand = screen.getByText(/Received - 2 sources/).closest('tr');
    expect(within(grand).getByText('24,955.00')).toBeTruthy();
    expect(within(grand).getByText('400.00')).toBeTruthy();
  });

  it('hides expired leases and inactive customers until Customize shows them, and the text filter finds them', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    expect(screen.queryByText('Suite 300, Escondido')).toBeNull();
    expect(screen.queryByText('Suite 400, Escondido')).toBeNull();
    expect(screen.getByText(/2 expired or inactive hidden/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    fireEvent.click(screen.getByLabelText(/Show Inactive/));
    const inactive = (await screen.findByText('Suite 400, Escondido')).closest('tr');
    expect(within(inactive).getByText('Inactive')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Show Expired/));
    const expired = (await screen.findByText('Suite 300, Escondido')).closest('tr');
    expect(within(expired).getByText('Expired')).toBeTruthy();
    // Off again: the text filter still finds the ended lease, marked.
    fireEvent.click(screen.getByLabelText(/Show Expired/));
    fireEvent.click(screen.getByLabelText(/Show Inactive/));
    await waitFor(() => expect(screen.queryByText('Suite 300, Escondido')).toBeNull());
    fireEvent.change(screen.getByLabelText('Filter by property, payer or account'), { target: { value: 'old tenant' } });
    expect(within(screen.getByText('Suite 300, Escondido').closest('tr')).getByText('Expired')).toBeTruthy();
  });

  it('narrows to the tenants picked, to the months picked, and asks for the entities picked', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    fireEvent.click(screen.getByRole('button', { name: 'Payer filter' }));
    fireEvent.click(screen.getByRole('option', { name: /Santos Blancas Jr\./ }));
    expect(screen.queryByText('910 SECR - Ste 100, San Clemente')).toBeNull();
    expect(screen.getByText('47385 RCR, Temecula')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Santos Blancas Jr\./ }));
    // Q1: January to March only.
    fireEvent.change(screen.getByLabelText('Months'), { target: { value: 'q1' } });
    expect(screen.getByRole('columnheader', { name: 'Mar' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Apr' })).toBeNull();
    const row = screen.getByText('910 SECR - Ste 100, San Clemente').closest('tr');
    expect(within(row).getByText('400.00')).toBeTruthy();       // the April late month is outside the period
    fireEvent.click(screen.getByRole('button', { name: 'Entities' }));
    fireEvent.click(await screen.findByRole('option', { name: /Greens Escondido/ }));
    await waitFor(() => expect(api.getLeasingRentRollFor).toHaveBeenLastCalledWith(new Date().getFullYear(), { entities: ['15000'] }));
  });

  it('keeps the team note in the row with who wrote it', async () => {
    render(<LeasingTab canEdit />);
    const row = (await screen.findByText('47385 RCR, Temecula')).closest('tr');
    expect(screen.getByText('Promised by the 15th')).toBeTruthy();
    expect(screen.getByText(/Charmi Desai, 10\/01\/2026/)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Add a note on 47385 RCR, Temecula' }));
    const box = within(row).getByLabelText('Note on 47385 RCR, Temecula');
    fireEvent.change(box, { target: { value: 'Paid January twice - credit' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(api.setLeasingNote).toHaveBeenCalledWith('L2', 'Paid January twice - credit'));
    expect(await within(row).findByText('Paid January twice - credit')).toBeTruthy();
  });

  it("opens the customer's card from the tenant's name", async () => {
    render(<LeasingTab canEdit />);
    const row = (await screen.findByText('910 SECR - Ste 100, San Clemente')).closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: 'Overstie Management, customer details' }));
    const card = await screen.findByRole('dialog', { name: 'Overstie Management details' });
    expect(await within(card).findByText('(949) 400-2788')).toBeTruthy();
    expect(within(card).getByText('Telephone Number')).toBeTruthy();
    expect(within(card).getByText('100 Main St, San Clemente, CA 92672')).toBeTruthy();
    expect(within(card).getByText('ap@overstie.example')).toBeTruthy();
    expect(api.getLeasingCustomer).toHaveBeenCalledWith('C00498');
  });

  it('exports what is on screen and syncs with the ledger', async () => {
    api.syncLeasingFromLedger.mockResolvedValueOnce({ linked: [{ leaseId: 'L1', propertyName: '910 SECR', tenantName: 'Overstie Management', customerId: 'C00498' }], created: [{ leaseId: 'L9', tenantName: 'New Tenant Inc.', entityName: 'Greens Escondido', customerId: 'C00999' }], notes: [] });
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    for (const name of [/Excel/, /CSV/, /PDF/, /Email/, /Save to Files/]) expect(screen.getByRole('menuitem', { name })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Sync Now/ }));
    expect(await screen.findByText(/Linked 1 lease to the Intacct customer by name/)).toBeTruthy();
    expect(screen.getByText(/Added 1 new tenant from the ledger: New Tenant Inc. at Greens Escondido/)).toBeTruthy();
  });
});

// Oct 7 (Charmi, MRI items 53-55): one list of every income source with a
// Type column and filter, one + Add menu, Row Density that works, the
// journal entries behind a month, and money posted outside the lease.
describe('LeasingTab - one list of every income source (10/07)', () => {
  const interestRows = [
    { account_no: '42500', title: 'Interest Income', section: 'other_income', bucket: '2026-01-01', debit: 0, credit: 120.5 },
    { account_no: '42500', title: 'Interest Income', section: 'other_income', bucket: '2026-02-01', debit: 0, credit: 130 },
    { account_no: '42600', title: 'Loan Income - Note Receivable', section: 'other_income', bucket: '2026-02-01', debit: 0, credit: 900 },
    { account_no: '41101', title: 'Rental Income', section: 'revenue', bucket: '2026-01-01', debit: 0, credit: 3000 },
  ];
  beforeEach(() => { api.getAccountingBucketsFor.mockResolvedValue({ rows: interestRows }); api.getLeasingRentRollFor.mockResolvedValue(roll); });

  it('lists leases and the interest and loan income accounts together, with a Type column and filter', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    expect(screen.getByRole('columnheader', { name: 'Type' })).toBeTruthy();
    const interest = screen.getByText('Interest Income').closest('tr');
    expect(within(interest).getByText('Interest')).toBeTruthy();
    expect(within(interest).getByText('250.50')).toBeTruthy();
    expect(within(screen.getByText('Loan Income - Note Receivable').closest('tr')).getByText('Loan Payment')).toBeTruthy();
    expect(screen.queryByText('Rental Income')).toBeNull();                       // rent is the leases'
    expect(within(screen.getByText('910 SECR - Ste 100, San Clemente').closest('tr')).getByText('Lease')).toBeTruthy();
    expect(screen.getByText(/Received - 4 sources/)).toBeTruthy();
    // No tabs any more: a Type filter instead.
    expect(screen.queryByRole('tab', { name: /Interest and Loan Payments/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Type filter' }));
    fireEvent.click(screen.getByRole('option', { name: /Interest/ }));
    expect(screen.queryByText('910 SECR - Ste 100, San Clemente')).toBeNull();
    expect(screen.getByText('Interest Income')).toBeTruthy();
    expect(screen.queryByText('Loan Income - Note Receivable')).toBeNull();
    expect(screen.getByRole('button', { name: 'Type filter' }).textContent).toContain('Interest');
  });

  it('does not count twice what a source kept here already reads from an income account', async () => {
    const note = { lease: lease({ id: 'L7', propertyName: 'Note - Oversite Inv2', incomeType: 'interest', incomeAccounts: ['42500'], customerId: 'C00700' }),
      months: months([cell('01', 'paid', 100, { expected: 100, balance: 0, byAccount: { 42500: 100 } })]), balanceToDate: 0, monthsBehind: 0, owed: 0, lateFees: 0 };
    api.getLeasingRentRollFor.mockResolvedValue({ ...roll, rows: [note] });
    render(<LeasingTab canEdit />);
    const row = (await screen.findByText('Interest Income')).closest('tr');
    expect(within(row).getByText('150.50')).toBeTruthy();       // 250.50 posted, 100 of it is the note's
    expect(within(screen.getByText('Note - Oversite Inv2').closest('tr')).getByText('Interest')).toBeTruthy();
  });

  it('has one + Add menu: New Lease, New Interest or Loan Payment, Set Up From the Ledger', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    expect(screen.queryByRole('button', { name: /^New Lease/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Set Up From the Ledger/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const menu = screen.getByRole('menu', { name: 'Add an income source' });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(3);
    expect(within(menu).getByRole('menuitem', { name: /New Lease/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /Set Up From the Ledger/ })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /New Interest or Loan Payment/ }));
    const dialog = screen.getByRole('dialog', { name: 'New interest or loan payment' });
    expect(within(dialog).getByLabelText('Type').value).toBe('interest');
    fireEvent.change(within(dialog).getByLabelText('Source'), { target: { value: 'Note - Oversite Inv2' } });
    fireEvent.change(within(dialog).getByLabelText('Payer Name'), { target: { value: 'Oversite Inv2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createLeasingLease).toHaveBeenCalled());
    expect(api.createLeasingLease.mock.calls[0][0]).toMatchObject({ incomeType: 'interest', propertyName: 'Note - Oversite Inv2', tenantName: 'Oversite Inv2' });
  });

  it('starts a new lease on the 1st of the month and moves the first rent with the lease start', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /New Lease/ }));
    const dialog = screen.getByRole('dialog', { name: 'New lease' });
    expect(within(dialog).getByLabelText('Lease Start').value.endsWith('-01')).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Lease Start'), { target: { value: '2026-01-01' } });
    expect(within(dialog).getByLabelText('Rent 1 starts').value).toBe('2026-01-01');
  });

  it('applies Row Density from Customize to the table itself', async () => {
    render(<LeasingTab canEdit />);
    const table = (await screen.findByText('910 SECR - Ste 100, San Clemente')).closest('table');
    expect(table.style.getPropertyValue('--acct-row-py')).toBe('5px');
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Condensed' }));
    await waitFor(() => expect(screen.getByText('910 SECR - Ste 100, San Clemente').closest('table').style.getPropertyValue('--acct-row-py')).toBe('2px'));
  });

  it('lists the journal entries behind a month, each opening the entry; Open Entry when there is one', async () => {
    api.searchAccountingLedger.mockResolvedValue({ rows: [{ entry_id: '11111111-2222-3333-4444-555555555555', entry_no: 'JE-1042', entry_date: '2026-02-03', description: 'Rent Feb - Overstie', debit: 0, credit: 2800 }] });
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    fireEvent.click(screen.getByRole('button', { name: /910 SECR.*Feb 2026: Short/ }));
    const dialog = screen.getByRole('dialog', { name: /910 SECR - Ste 100, San Clemente, Feb 2026/ });
    const link = await within(dialog).findByRole('button', { name: 'JE-1042' });
    expect(api.searchAccountingLedger).toHaveBeenCalledWith({ account: '41101', party_kind: 'customer', party: 'C00498', from: '2026-02-01', to: '2026-02-28', limit: 100 });
    expect(within(dialog).getByText('02/03/2026')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Open Entry/ })).toBeTruthy();
    fireEvent.click(link);
    await waitFor(() => expect(api.getAccountingEntry).toHaveBeenCalledWith('11111111-2222-3333-4444-555555555555'));
  });

  it('shows money posted outside the lease without counting it', async () => {
    const typedLate = { lease: lease({ id: 'L8', propertyName: 'Nicole Miller Suite', leaseStart: '2026-10-02' }),
      months: months([cell('01', 'outside', 2275, { expected: 0, balance: 0 }), cell('02', 'outside', 2275, { expected: 0, balance: 0 })]), balanceToDate: 0, monthsBehind: 0, owed: 0, lateFees: 0,
      outsideLease: { months: ['2026-01', '2026-02'], received: 4550 } };
    api.getLeasingRentRollFor.mockResolvedValue({ ...roll, rows: [typedLate] });
    api.getAccountingBucketsFor.mockResolvedValue({ rows: [] });
    render(<LeasingTab canEdit />);
    const row = (await screen.findByText('Nicole Miller Suite')).closest('tr');
    expect(within(row).getByText('Posted Outside Lease')).toBeTruthy();
    expect(within(row).getByRole('button', { name: /Jan 2026: Outside the Lease/ })).toBeTruthy();
    const grand = screen.getByText(/Received - 1 source/).closest('tr');
    expect(within(grand).queryByText('4,550.00')).toBeNull();     // shown in the cells, not counted
  });
});

// Oct 7 (items 9, 12, 21, 32, 33): the module's shared controls on MRI.
describe('LeasingTab shared controls', () => {
  beforeEach(() => {
    api.getLeasingRentRollFor.mockResolvedValue(roll);
    api.getAccountingBucketsFor.mockResolvedValue({ rows: [] });
    api.getAccountingLocations.mockResolvedValue({ entities: [{ code: '15000', name: 'Greens Escondido' }] });
  });

  it('Customize has Row Density and Rows per Page; the pager keeps the totals over every source', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    const btn = screen.getByRole('button', { name: /Customize/ });
    expect(btn.querySelector('.lucide-sliders-horizontal')).toBeTruthy();
    fireEvent.click(btn);
    expect(screen.getByRole('group', { name: 'Row Density' })).toBeTruthy();
    expect(screen.getByLabelText(/Show Expired/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Rows per Page' })).getByRole('button', { name: 'Other' }));
    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '1' } });
    await screen.findByText(/Page 1 of 2/);
    expect(screen.queryByText('47385 RCR, Temecula')).toBeNull();
    expect(screen.getByText(/Received - 2 sources/)).toBeTruthy();       // the total row counts both
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('47385 RCR, Temecula')).toBeTruthy();
  });

  it('has a resize handle on the Income Roll columns', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    for (const name of ['Property or Source', 'Type', 'Total', 'Balance', 'Notes']) {
      expect(screen.getByRole('separator', { name: `Resize the ${name} column` })).toBeTruthy();
    }
    expect(screen.getByRole('columnheader', { name: 'Property or Source' })).toBeTruthy();
  });

  it('the entity on a lease is the module picker, found by its number', async () => {
    api.getAccountingLocations.mockResolvedValue({ entities: [{ code: '15000', name: 'Greens Escondido' }, { code: '12000', name: 'Greens Global, Inc.' }, { code: '13000', name: '(H) Old Holdings' }] });
    render(<LeasingTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: '910 SECR - Ste 100, San Clemente' }));
    const dialog = screen.getByRole('dialog', { name: 'Change lease' });
    const pick = await within(dialog).findByRole('button', { name: 'Entity the Income Posts To' });
    await waitFor(() => expect(pick.textContent).toContain('Greens Escondido (15000)'));
    fireEvent.click(pick);
    expect(screen.queryByRole('option', { name: /Old Holdings/ })).toBeNull();     // historical hidden
    fireEvent.change(screen.getByPlaceholderText('Search entity by name or code'), { target: { value: '12000' } });
    fireEvent.click(screen.getByRole('option', { name: /Greens Global/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateLeasingLease).toHaveBeenCalled());
    expect(api.updateLeasingLease.mock.calls[0][1].entityCode).toBe('12000');
  });

  it('the Total of a ledger income account opens its lines in Reports', async () => {
    const y = new Date().getFullYear();
    api.getAccountingBucketsFor.mockResolvedValue({ rows: [{ account_no: '45100', title: 'Interest Income', section: 'other_income', bucket: `${y}-02-01`, credit: 125, debit: 0 }] });
    const seen = [];
    const onDrill = (e) => seen.push(e.detail);
    window.addEventListener('nexus:accounting-drill', onDrill);
    try {
      render(<LeasingTab canEdit />);
      fireEvent.click(await screen.findByRole('button', { name: /Ledger lines behind the total of 45100 Interest Income/ }));
      expect(seen[0]).toMatchObject({ account: '45100', from: `${y}-01-01`, to: `${y}-12-31`, entity: '' });
    } finally {
      window.removeEventListener('nexus:accounting-drill', onDrill);
    }
  });
});
