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

// Oct 22: the lease dates are the Nexus date picker (MM/DD/YYYY whatever the
// browser's language). Its calendar has its own tests; here it is a plain
// input carrying the picker's title, so the form's flow can be driven.
vi.mock('../../tasks/components', () => ({
  DateField: ({ value, onChange, title }) => <input aria-label={title} value={value || ''} onChange={(e) => onChange(e.target.value)} />,
}));

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
  withFreshReads: vi.fn((fn) => fn()),
}));

import LeasingTab, { leaseTermLabel, parseLeaseTerm, fitRollHeight } from './LeasingTab';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.resolve(__dirname, '../../style.css'), 'utf8');
import { api, withFreshReads } from '../../api';
import { resetAccountingPrefs } from './prefs';
import { dialog as appDialog } from '../../ui/dialog';

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
    // Oct 14 (Priyanka): the Tenant Name is a searchable dropdown of the Intacct customers.
    fireEvent.change(within(dialog).getByLabelText('Tenant Name'), { target: { value: 'azadeh' } });
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

  it('shows only active leases until Customize > Show Inactive Leases, and the text filter finds them', async () => {
    // Oct 14 (Urmi): ended, expired and vacant leases and inactive payers are
    // hidden by default, behind ONE switch.
    const vacant = { lease: lease({ id: 'L5', propertyName: 'Suite 500, Escondido', tenantName: '', customerId: '', status: 'vacant' }), months: months([]), balanceToDate: 0, monthsBehind: 0, owed: 0, lateFees: 0, expired: false, customerActive: true };
    api.getLeasingRentRollFor.mockResolvedValue({ ...full, rows: [...full.rows, vacant] });
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    expect(screen.queryByText('Suite 300, Escondido')).toBeNull();
    expect(screen.queryByText('Suite 400, Escondido')).toBeNull();
    expect(screen.queryByText('Suite 500, Escondido')).toBeNull();
    expect(screen.getByText(/3 inactive leases hidden/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    expect(screen.queryByLabelText(/Show Expired/)).toBeNull();
    const toggle = screen.getByLabelText(/Show Inactive Leases/);
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    const inactive = (await screen.findByText('Suite 400, Escondido')).closest('tr');
    expect(within(inactive).getByText('Inactive')).toBeTruthy();
    const expired = screen.getByText('Suite 300, Escondido').closest('tr');
    expect(within(expired).getByText('Expired')).toBeTruthy();
    expect(screen.getByText('Suite 500, Escondido')).toBeTruthy();
    // Off again: the text filter still finds the ended lease, marked.
    fireEvent.click(screen.getByLabelText(/Show Inactive Leases/));
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
    // 10/23 meeting, item 13: the rent roll is read again past the server's cache, without an error.
    await waitFor(() => expect(withFreshReads).toHaveBeenCalledTimes(1));
    expect(api.getLeasingRentRollFor).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Could not sync with the ledger/)).toBeNull();
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

  it('has one + Add menu: New Lease, New CAM Charge, New Interest or Loan Payment - no Set Up From the Ledger', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    expect(screen.queryByRole('button', { name: /^New Lease/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const menu = screen.getByRole('menu', { name: 'Add an income source' });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(3);
    expect(within(menu).getByRole('menuitem', { name: /New Lease/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /New CAM Charge/ })).toBeTruthy();
    // Oct 14 (Charmi): "Set up ledger option needs to be taken out from MRI".
    expect(within(menu).queryByRole('menuitem', { name: /Set Up From the Ledger/ })).toBeNull();
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

  it('counts money posted outside the lease dates as received, with no separate Outside the Lease figure', async () => {
    // Oct 14 (Charmi: "why do we even need that"): no chip, no header figure, no legend entry.
    const typedLate = { lease: lease({ id: 'L8', propertyName: 'Nicole Miller Suite', leaseStart: '2026-10-02' }),
      months: months([cell('01', 'outside', 2275, { expected: 0, balance: 0 }), cell('02', 'outside', 2275, { expected: 0, balance: 0 })]), balanceToDate: 0, monthsBehind: 0, owed: 0, lateFees: 0,
      outsideLease: { months: ['2026-01', '2026-02'], received: 4550 } };
    api.getLeasingRentRollFor.mockResolvedValue({ ...roll, rows: [typedLate] });
    api.getAccountingBucketsFor.mockResolvedValue({ rows: [] });
    render(<LeasingTab canEdit />);
    const row = (await screen.findByText('Nicole Miller Suite')).closest('tr');
    expect(within(row).queryByText('Posted Outside Lease')).toBeNull();
    expect(screen.queryByText(/Outside the Lease/)).toBeNull();
    expect(within(row).getByRole('button', { name: /Jan 2026: Received/ }).textContent).toBe('2,275');
    const grand = screen.getByText(/Received - 1 source/).closest('tr');
    expect(within(grand).getByText('4,550.00')).toBeTruthy();
  });

  it('shows a dash, not 0, in a month the lease is not in force', async () => {
    // Oct 14 (Urmi): before the lease starts (and after it ends) a dash.
    const later = { lease: lease({ id: 'L6', propertyName: 'Starts in March', leaseStart: '2026-03-01' }),
      months: [{ month: '2026-01', inForce: false }, cell('02', 'outside', 0, { expected: 0, balance: 0, note: 'Keys handed over' }), ...months([cell('03', 'paid', 3200), cell('04', 'paid', 3200)]).slice(0, 10)].map((c, i) => ({ ...c, month: `2026-${String(i + 1).padStart(2, '0')}` })),
      balanceToDate: 0, monthsBehind: 0, owed: 0, lateFees: 0 };
    api.getLeasingRentRollFor.mockResolvedValue({ ...roll, rows: [later] });
    api.getAccountingBucketsFor.mockResolvedValue({ rows: [] });
    render(<LeasingTab canEdit />);
    const row = (await screen.findByText('Starts in March')).closest('tr');
    expect(within(row).getByRole('button', { name: /Feb 2026: Not in Force/ }).textContent).toBe('-*');
    expect(within(row).getByRole('button', { name: /Mar 2026: Paid/ }).textContent).toBe('3,200');
    // The month notes come up into the Notes column (Urmi, 10/14).
    expect(within(row).getByText('Feb: Keys handed over')).toBeTruthy();
  });

  it('pulls the notes written on single months into the Notes column', async () => {
    render(<LeasingTab canEdit />);
    const row = (await screen.findByText('910 SECR - Ste 100, San Clemente')).closest('tr');
    expect(within(row).getByText('Mar: AC repair taken off the rent')).toBeTruthy();
    expect(within(row).getByRole('button', { name: /Add a note on 910 SECR/ }).getAttribute('title')).toContain('Mar: AC repair taken off the rent');
  });

  it('asks Keep Editing or Discard Edits when a changed month is clicked off or Escaped', async () => {
    // Oct 14 (Neil): "if you click off of it it doesn't ask ... it just closes it".
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    fireEvent.click(screen.getByRole('button', { name: /910 SECR.*Apr 2026: Late/ }));
    let dialog = screen.getByRole('dialog', { name: /Apr 2026/ });
    // Nothing changed: clicking off closes.
    fireEvent.click(dialog.parentElement);
    expect(screen.queryByRole('dialog', { name: /Apr 2026/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /910 SECR.*Apr 2026: Late/ }));
    dialog = screen.getByRole('dialog', { name: /Apr 2026/ });
    fireEvent.change(within(dialog).getByLabelText('Note'), { target: { value: 'Half paid in cash' } });
    fireEvent.click(dialog.parentElement);
    const ask = screen.getByRole('alertdialog', { name: 'Unsaved changes' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep Editing' }));
    expect(within(dialog).getByLabelText('Note').value).toBe('Half paid in cash');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard Edits' }));
    expect(screen.queryByRole('dialog', { name: /Apr 2026/ })).toBeNull();
    expect(api.setLeasingMonth).not.toHaveBeenCalled();
  });

  it('asks before a changed lease is closed', async () => {
    render(<LeasingTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: '910 SECR - Ste 100, San Clemente' }));
    const dialog = screen.getByRole('dialog', { name: 'Change lease' });
    fireEvent.change(within(dialog).getByLabelText('Region'), { target: { value: 'San Diego' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard Edits' }));
    expect(screen.queryByRole('dialog', { name: 'Change lease' })).toBeNull();
  });

  it('picks the tenant from the Intacct customers, code left of the name, and keeps a typed name', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /New Lease/ }));
    const dialog = screen.getByRole('dialog', { name: 'New lease' });
    const box = within(dialog).getByLabelText('Tenant Name');
    fireEvent.focus(box);
    const options = within(await within(dialog).findByRole('listbox', { name: 'Customers' })).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0].textContent.startsWith('C00272')).toBe(true);
    fireEvent.change(box, { target: { value: 'Brand New Tenant LLC' } });
    expect(within(dialog).getByText(/No Intacct customer matches/)).toBeTruthy();
    expect(box.value).toBe('Brand New Tenant LLC');
  });

  it('has CAM as a type', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByText('910 SECR - Ste 100, San Clemente');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /New CAM Charge/ }));
    const dialog = screen.getByRole('dialog', { name: 'New CAM charge' });
    expect(within(dialog).getByLabelText('Type').value).toBe('cam');
    expect(within(within(dialog).getByLabelText('Type')).getByRole('option', { name: 'CAM' })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Property or Space'), { target: { value: '910 SECR - CAM' } });
    fireEvent.change(within(dialog).getByLabelText('Tenant Name'), { target: { value: 'Overstie Management' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createLeasingLease).toHaveBeenCalled());
    expect(api.createLeasingLease.mock.calls[0][0]).toMatchObject({ incomeType: 'cam', incomeAccounts: ['41101'] });
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
    expect(screen.getByLabelText(/Show Inactive Leases/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Rows per Page' })).getByRole('button', { name: 'Other' }));
    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '1' } });
    await screen.findByText(/Page 1 of 2/);
    expect(screen.queryByText('47385 RCR, Temecula')).toBeNull();
    expect(screen.getByText(/Received - 2 sources/)).toBeTruthy();       // the total row counts both
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('47385 RCR, Temecula')).toBeTruthy();
  });

  it('pins the Received total to the bottom of a box that ends on the screen (Viral, 10/22)', async () => {
    render(<LeasingTab canEdit />);
    const label = (await screen.findByText(/Received - 2 sources/)).closest('td');
    // The pinning lives in style.css (.acct-roll .acct-grand), not an inline
    // style that would leave the label under the month totals.
    expect(label.className).toBe('acct-roll-label');
    expect(label.style.position).toBe('');
    expect(label.closest('table').className).toContain('acct-roll');
    expect(label.closest('.acct-lines-wrap').style.maxHeight).toBeTruthy();
    expect(css).toMatch(/\.acct-lines\.acct-roll tbody tr\.acct-grand td \{ position: sticky; bottom: 0; z-index: 3; background: var\(--bg-secondary\); \}/);
    expect(css).toMatch(/\.acct-lines\.acct-roll tbody tr\.acct-grand td\.acct-roll-label \{ left: 0; z-index: 4; \}/);
  });

  it('fits the Income Roll box to what is left of the screen, 74% at most, 320px at least', () => {
    expect(fitRollHeight(330, 768)).toBe(426);         // 1366x768: ends 12px above the bottom
    expect(fitRollHeight(200, 1440)).toBe(1066);       // a tall screen keeps the 74% cap
    expect(fitRollHeight(600, 700)).toBe(320);         // a short one still shows rows
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

  it("a lease's Total and Balance open its ledger lines in Reports", async () => {
    // Oct 14 (Charmi: "In MRI, we should be able to drill down").
    const y = new Date().getFullYear();
    const seen = [];
    const onDrill = (e) => seen.push(e.detail);
    window.addEventListener('nexus:accounting-drill', onDrill);
    try {
      render(<LeasingTab canEdit />);
      fireEvent.click(await screen.findByRole('button', { name: 'Ledger lines behind the total of 910 SECR - Ste 100, San Clemente' }));
      expect(seen[0]).toMatchObject({ account: '41101', party: { kind: 'customer', code: 'C00498' }, from: `${y}-01-01`, to: `${y}-12-31`, entity: '15000' });
      fireEvent.click(screen.getByRole('button', { name: 'Ledger lines behind the balance of 910 SECR - Ste 100, San Clemente' }));
      expect(seen[1]).toMatchObject({ party: { kind: 'customer', code: 'C00498' } });
    } finally {
      window.removeEventListener('nexus:accounting-drill', onDrill);
    }
  });

  // Oct 15 (Charmi + Neil): Lease Term is a pick, never free text.
  const withLeases = async (first, second, run) => {
    const custom = { ...roll, rows: [{ ...roll.rows[0], lease: lease(first) }, { ...roll.rows[1], lease: lease({ id: 'L2', propertyName: '47385 RCR, Temecula', tenantName: 'Santos Blancas Jr.', customerId: 'C00497', email: '', ...second }) }] };
    api.getLeasingRentRollFor.mockImplementation(async () => custom);
    try { await run(); } finally { api.getLeasingRentRollFor.mockImplementation(async () => roll); }
  };

  it('Lease Term is a dropdown: Annual, Month to Month, Custom - in that order', async () => {
    render(<LeasingTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: '910 SECR - Ste 100, San Clemente' }));
    const dialog = screen.getByRole('dialog', { name: 'Change lease' });
    const select = within(dialog).getByLabelText('Lease Term');
    expect(select.tagName).toBe('SELECT');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Annual', 'Month to Month', 'Custom']);
    // The old free text "Annual" reads as Annual.
    expect(select.value).toBe('annual');
    expect(within(dialog).queryByLabelText('Lease Term in Months')).toBeNull();
  });

  it('Custom asks for the months and saves them as a whole number', async () => {
    render(<LeasingTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: '910 SECR - Ste 100, San Clemente' }));
    const dialog = screen.getByRole('dialog', { name: 'Change lease' });
    fireEvent.change(within(dialog).getByLabelText('Lease Term'), { target: { value: 'custom' } });
    const months = within(dialog).getByLabelText('Lease Term in Months');
    // Nothing yet: Save waits for the months.
    expect(within(dialog).getByRole('button', { name: 'Save' }).disabled).toBe(true);
    fireEvent.change(months, { target: { value: '18' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateLeasingLease).toHaveBeenCalled());
    const [, body] = api.updateLeasingLease.mock.calls[0];
    expect(body.termType).toBe('custom');
    expect(body.termMonths).toBe(18);
    expect(Number.isInteger(body.termMonths)).toBe(true);
    // The old text is kept, never lost.
    expect(body.leaseTerms).toBe('Annual');
  });

  it('Month to Month saves no months', async () => {
    render(<LeasingTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: '910 SECR - Ste 100, San Clemente' }));
    const dialog = screen.getByRole('dialog', { name: 'Change lease' });
    fireEvent.change(within(dialog).getByLabelText('Lease Term'), { target: { value: 'month_to_month' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateLeasingLease).toHaveBeenCalled());
    expect(api.updateLeasingLease.mock.calls[0][1]).toMatchObject({ termType: 'month_to_month', termMonths: null });
  });

  it('reads old free-text terms best-effort', () => {
    expect(parseLeaseTerm('Annual')).toEqual({ termType: 'annual', termMonths: 12 });
    expect(parseLeaseTerm('12 months')).toEqual({ termType: 'annual', termMonths: 12 });
    expect(parseLeaseTerm('1 Year')).toEqual({ termType: 'annual', termMonths: 12 });
    expect(parseLeaseTerm('Month to month')).toEqual({ termType: 'month_to_month', termMonths: null });
    expect(parseLeaseTerm('Month-to-Month')).toEqual({ termType: 'month_to_month', termMonths: null });
    expect(parseLeaseTerm('MTM')).toEqual({ termType: 'month_to_month', termMonths: null });
    expect(parseLeaseTerm('18 months')).toEqual({ termType: 'custom', termMonths: 18 });
    expect(parseLeaseTerm('2 years')).toEqual({ termType: 'custom', termMonths: 24 });
    expect(parseLeaseTerm('Until the building sells')).toBeNull();
    expect(parseLeaseTerm('')).toBeNull();
    expect(leaseTermLabel({ termType: 'custom', termMonths: 18 })).toBe('Custom - 18 Months');
    expect(leaseTermLabel({ termType: 'month_to_month' })).toBe('Month to Month');
    expect(leaseTermLabel({ leaseTerms: 'Annual' })).toBe('Annual');
    expect(leaseTermLabel({ leaseTerms: 'Until the building sells' })).toBe('Until the building sells');
  });

  it('shows the term in the grid, and keeps text it cannot read with a prompt to pick a term', async () => {
    await withLeases({ termType: 'custom', termMonths: 18, leaseTerms: '' }, { leaseTerms: 'Until the building sells', termType: '', termMonths: null, termLegacy: 'Until the building sells' }, async () => {
      render(<LeasingTab canEdit />);
      await screen.findByText('910 SECR - Ste 100, San Clemente');
      fireEvent.click(screen.getByRole('button', { name: 'Payers' }));
      const row = screen.getByText('910 SECR - Ste 100, San Clemente').closest('tr');
      expect(within(row).getByText('Term: Custom - 18 Months')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Change 47385 RCR, Temecula' }));
      const dialog = screen.getByRole('dialog', { name: 'Change lease' });
      expect(within(dialog).getByLabelText('Lease Term').value).toBe('');
      expect(within(dialog).getByText('Saved as "Until the building sells" - pick a term.')).toBeTruthy();
    });
  });

  it('the rent changes are a table with Effective Date, Rent, CAM, Other and Note over the inputs', async () => {
    render(<LeasingTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: '910 SECR - Ste 100, San Clemente' }));
    const dialog = screen.getByRole('dialog', { name: 'Change lease' });
    const table = within(dialog).getByRole('table', { name: 'Rent Changes' });
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads.slice(0, 5)).toEqual(['Effective Date', 'Rent', 'CAM', 'Other', 'Note']);
    // Oct 22 (Charmi: "still not very clear" - the labels stacked on the left):
    // a header cell is a table cell, never a block.
    within(table).getAllByRole('columnheader').forEach((h) => expect(h.style.display).not.toBe('block'));
    // The header row is above the inputs, one label per input column.
    const [headRow, firstRow] = within(table).getAllByRole('row');
    expect(headRow.closest('thead')).toBeTruthy();
    const cells = within(firstRow).getAllByRole('cell');
    expect(within(cells[0]).getByLabelText('Rent 1 starts')).toBeTruthy();
    expect(within(cells[1]).getByLabelText('Rent of rent 1').value).toBe('3000');
    expect(within(cells[2]).getByLabelText('CAM of rent 1').value).toBe('200');
    expect(within(cells[3]).getByLabelText('Other of rent 1')).toBeTruthy();
    expect(within(cells[4]).getByLabelText('Note of rent 1')).toBeTruthy();
    expect(within(cells[5]).getByRole('button', { name: 'Remove rent 1' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /Add Rent Change/ }));
    expect(within(table).getAllByRole('row')).toHaveLength(3);
  });

  // Oct 15 (Charmi): the Intacct customer record fills the lease form.
  const withContacts = () => api.getLeasingCustomers.mockImplementationOnce(async () => ({ customers: [
    { code: 'C00272', name: 'Dr. Azadeh Sham', phone: '(760) 555-0110', email: 'azadeh@example.com', address: '12 Palm Ave, Escondido, CA 92025' },
    { code: 'C00498', name: 'Overstie Management', phone: '(949) 400-2788', email: '', address: '' },
  ] }));

  it('picking the tenant fills only the empty contact fields from Intacct, and says so', async () => {
    withContacts();
    render(<LeasingTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: '910 SECR - Ste 100, San Clemente' }));
    const dialog = screen.getByRole('dialog', { name: 'Change lease' });
    fireEvent.change(within(dialog).getByLabelText('Tenant Name'), { target: { value: 'azadeh' } });
    fireEvent.click(await within(dialog).findByRole('option', { name: /Dr. Azadeh Sham/ }));
    // Typed already: kept.
    expect(within(dialog).getByLabelText('Phone').value).toBe('949-400-2788');
    expect(within(dialog).getByLabelText('Email').value).toBe('tenant@example.com');
    // Empty: filled from Intacct, with the hint under it.
    const address = within(dialog).getByLabelText('Mailing Address');
    expect(address.value).toBe('12 Palm Ave, Escondido, CA 92025');
    expect(within(address.parentElement).getByText('Filled from Intacct')).toBeTruthy();
    expect(within(within(dialog).getByLabelText('Phone').parentElement).queryByText('Filled from Intacct')).toBeNull();
    expect(within(dialog).getByLabelText('Intacct Customer Code').value).toBe('C00272');
    // Edited: the hint goes.
    fireEvent.change(address, { target: { value: 'PO Box 9, Escondido' } });
    expect(within(address.parentElement).queryByText('Filled from Intacct')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateLeasingLease).toHaveBeenCalled());
    expect(api.updateLeasingLease.mock.calls[0][1]).toMatchObject({ customerId: 'C00272', tenantName: 'Dr. Azadeh Sham', phone: '949-400-2788', email: 'tenant@example.com', mailingAddress: 'PO Box 9, Escondido' });
  });

  it('picking another customer replaces only what the last pick filled', async () => {
    withContacts();
    render(<LeasingTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: '910 SECR - Ste 100, San Clemente' }));
    const dialog = screen.getByRole('dialog', { name: 'Change lease' });
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText('Tenant Name'), { target: { value: 'azadeh' } });
    fireEvent.click(await within(dialog).findByRole('option', { name: /Dr. Azadeh Sham/ }));
    expect(within(dialog).getByLabelText('Email').value).toBe('azadeh@example.com');
    fireEvent.change(within(dialog).getByLabelText('Tenant Name'), { target: { value: 'overstie' } });
    fireEvent.click(await within(dialog).findByRole('option', { name: /Overstie Management/ }));
    // Overstie has no email or address in Intacct: what the last pick filled is cleared, nothing typed is touched.
    expect(within(dialog).getByLabelText('Email').value).toBe('');
    expect(within(dialog).getByLabelText('Mailing Address').value).toBe('');
    expect(within(dialog).getByLabelText('Phone').value).toBe('949-400-2788');
    expect(within(dialog).getByLabelText('Intacct Customer Code').value).toBe('C00498');
  });
});

// Accounting call 10/23, items 03 and 04: a lease opens in a panel on the
// right with the list still there, its fields in Tenant Info, Lease Info and
// Comments, Save pinned at the bottom.
describe('LeasingTab - side panel (10/23)', () => {
  it('opens the lease on the right in three titled groups, with Open Full and a close', async () => {
    render(<LeasingTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: '910 SECR - Ste 100, San Clemente' }));
    const panel = screen.getByRole('dialog', { name: 'Change lease' });
    expect(panel.getAttribute('aria-modal')).toBe('false');
    expect(panel.className).toContain('acct-side-panel');
    const groups = within(panel).getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(groups).toEqual(['Tenant Info', 'Lease Info', 'Comments']);
    const tenant = within(panel).getByRole('region', { name: 'Tenant Info' });
    for (const f of ['Tenant Name', 'Intacct Customer Code', 'Primary Contact', 'Phone', 'Email', 'Mailing Address', 'Tenant Is']) expect(within(tenant).getByLabelText(f)).toBeTruthy();
    const leaseInfo = within(panel).getByRole('region', { name: 'Lease Info' });
    for (const f of ['Type', 'Property or Space', 'Region', 'Status', 'Lease Term', 'Frequency', 'Security Deposit', 'Late Fee', 'Rent Due on Day', 'Rental Income Accounts']) expect(within(leaseInfo).getByLabelText(f)).toBeTruthy();
    expect(within(within(panel).getByRole('region', { name: 'Comments' })).getByLabelText('Notes')).toBeTruthy();
    // The list is still on screen behind it.
    expect(screen.getByRole('button', { name: '47385 RCR, Temecula' })).toBeTruthy();
    // Open Full widens it and is kept; Side Panel brings it back.
    fireEvent.click(within(panel).getByRole('button', { name: /Open Full/ }));
    expect(panel.className).toContain('is-full');
    fireEvent.click(within(panel).getByRole('button', { name: /Side Panel/ }));
    expect(panel.className).not.toContain('is-full');
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Change lease' })).toBeNull();
  });

  it('saves from the pinned Save as before', async () => {
    render(<LeasingTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: '910 SECR - Ste 100, San Clemente' }));
    const panel = screen.getByRole('dialog', { name: 'Change lease' });
    fireEvent.change(within(panel).getByLabelText('Notes'), { target: { value: 'Pays by check' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateLeasingLease).toHaveBeenCalled());
    expect(api.updateLeasingLease.mock.calls[0][0]).toBe('L1');
    expect(api.updateLeasingLease.mock.calls[0][1].notes).toBe('Pays by check');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Change lease' })).toBeNull());
  });

  it('clicking another lease swaps the panel; unsaved edits are asked about first', async () => {
    const ask = vi.spyOn(appDialog, 'confirm').mockResolvedValue(false);
    render(<LeasingTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: '910 SECR - Ste 100, San Clemente' }));
    // Unchanged: straight to the next lease.
    fireEvent.click(screen.getByRole('button', { name: '47385 RCR, Temecula' }));
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: 'Change lease' })).getByLabelText('Property or Space').value).toBe('47385 RCR, Temecula'));
    expect(ask).not.toHaveBeenCalled();
    // Changed: asked, and Keep Editing keeps it.
    fireEvent.change(within(screen.getByRole('dialog', { name: 'Change lease' })).getByLabelText('Region'), { target: { value: 'San Diego' } });
    fireEvent.click(screen.getByRole('button', { name: '910 SECR - Ste 100, San Clemente' }));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(within(screen.getByRole('dialog', { name: 'Change lease' })).getByLabelText('Region').value).toBe('San Diego');
    // Discard: the other lease opens.
    ask.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: '910 SECR - Ste 100, San Clemente' }));
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: 'Change lease' })).getByLabelText('Property or Space').value).toBe('910 SECR - Ste 100, San Clemente'));
    ask.mockRestore();
  });
});
