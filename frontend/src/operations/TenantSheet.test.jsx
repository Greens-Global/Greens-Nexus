import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Operations > Tenants - the tenant record (Neil, 11/17/2026). It is read
// live from Cubby when opened; when Cubby cannot be reached the stored copy
// is shown and the first line says so. Gate codes are shown plainly. Nothing
// on it can be edited - tenant details are changed in Cubby.

const api = { opsTenantRecord: vi.fn(), opsTenantLedger: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) }));

const { default: TenantSheet } = await import('./TenantSheet');

const LEASE = { leaseId: 'lease_1', facilityId: 'fac_a', facilityName: 'Temecula', unitId: 'u1', unitName: 'A12', unitSize: '10 x 20',
  moveIn: '2024-03-14', moveOut: '', rentCents: 18900, paidThrough: '2026-11-30', paid: true, autopay: true, balanceCents: 0, overlockNeeded: false,
  coverage: { type: 'TENANT_PROTECTION', premiumCents: 1200, amountCents: 500000 }, privatePolicy: null, scheduledMoveOut: null,
  vehicle: { type: 'RV', plate: '7ABC123', state: 'CA' },
  altContacts: [{ name: 'Lee Whitfield', phone: '(951) 555-0199', email: 'lee@example.com' }] };
const SECOND = { ...LEASE, leaseId: 'lease_2', unitId: 'u2', unitName: 'B4', unitSize: '5 x 10', rentCents: 7900, autopay: false, balanceCents: 15800,
  overlockNeeded: true, coverage: null, privatePolicy: { number: 'HO-4471', expires: '2026-09-30' }, scheduledMoveOut: { date: '2099-12-01', reason: 'MOVING' },
  vehicle: null, altContacts: [{ name: 'Lee Whitfield', phone: '951-555-0199', email: 'LEE@example.com' }] };
const TENANT = { customerId: 'cus_1', name: 'Dana Whitfield', firstName: 'Dana', lastName: 'Whitfield', companyName: 'Whitfield Landscaping', military: true,
  contact: { phone: '(951) 555-0142', email: 'dana@example.com', address: '41 Vine St', address2: 'Unit 3', city: 'Temecula', state: 'CA', zip: '92590', country: 'US' },
  commPrefs: { sms: { marketing: false, suppressed: true, suppressionReason: 'OPTED_OUT' }, email: { marketing: true, suppressed: false, suppressionReason: '' } },
  facilities: [{ facilityId: 'fac_a', facilityName: 'Temecula', gateCode: '4821#', gateCodeEnabled: true },
    { facilityId: 'fac_b', facilityName: 'Murrieta', gateCode: '', gateCodeEnabled: false }],
  leases: [LEASE, SECOND],
  payments: [{ paymentId: 'p2', date: '2026-11-01', amountCents: 18900, status: 'SUCCEEDED', method: 'CREDIT_CARD' },
    { paymentId: 'p1', date: '2026-10-01', amountCents: 18900, status: 'FAILED', method: 'ACH' }],
  live: { ok: true, asOf: '2026-11-17T14:15:00', error: '' }, storedAsOf: '2026-11-17T14:00:00' };
const STORED = { ...TENANT, live: { ok: false, asOf: '2026-11-17T14:15:00', error: 'timeout' } };
const LEDGER = { facilityId: 'fac_a', customerId: 'cus_1', leases: 2, entries: [
  { unit: 'A12', date: '2026-11-01', type: 'Charge', category: 'Rent', description: 'November rent', amount: 18900, paid: 18900, waived: false, accrues: '' },
  { unit: 'B4', date: '2026-11-01', type: 'Charge', category: 'Late Fee', description: 'Late fee', amount: 2000, paid: 0, waived: false, accrues: '' }] };

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.opsTenantLedger.mockResolvedValue(LEDGER);
});
const open = () => render(<TenantSheet customerId="cus_1" onClose={() => {}} />);

describe('Operations > Tenants > the tenant record', () => {
  it('reads the tenant when it opens and says it is live', async () => {
    api.opsTenantRecord.mockResolvedValue(TENANT);
    open();
    expect((await screen.findByTestId('ops-tenant-live')).textContent).toBe('Live from Cubby at 2:15 PM');
    expect(api.opsTenantRecord).toHaveBeenCalledWith('cus_1');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Dana Whitfield')).toBeTruthy();
    expect(within(dialog).getByText('Whitfield Landscaping')).toBeTruthy();
    expect(screen.getByRole('link', { name: '(951) 555-0142' }).getAttribute('href')).toBe('tel:9515550142');
    expect(screen.getByRole('link', { name: 'dana@example.com' }).getAttribute('href')).toBe('mailto:dana@example.com');
    expect(screen.getByText('41 Vine St')).toBeTruthy();
    expect(screen.getByText('Temecula, CA 92590')).toBeTruthy();
    expect(screen.getByText('Military')).toBeTruthy();
    expect(screen.getByText('Texts are turned off (opted out).')).toBeTruthy();
    expect(screen.queryByText(/Emails are turned off/)).toBeNull();
  });

  it('says when Cubby could not be reached, shows the stored copy and tries again', async () => {
    api.opsTenantRecord.mockResolvedValueOnce(STORED);
    open();
    const line = await screen.findByTestId('ops-tenant-live');
    expect(line.textContent).toContain('Cubby could not be reached - showing the copy from 11/17/2026, 2:00 PM.');
    expect(line.style.color).toBe('var(--warn-fg)');
    expect(screen.getByText('41 Vine St')).toBeTruthy();
    api.opsTenantRecord.mockResolvedValueOnce(TENANT);
    fireEvent.click(within(line).getByRole('button', { name: 'Try Again' }));
    await waitFor(() => expect(screen.getByTestId('ops-tenant-live').textContent).toBe('Live from Cubby at 2:15 PM'));
    expect(api.opsTenantRecord).toHaveBeenCalledTimes(2);
  });

  it('keeps the stored copy on screen when the second try fails too', async () => {
    api.opsTenantRecord.mockResolvedValueOnce(STORED);
    open();
    const line = await screen.findByTestId('ops-tenant-live');
    api.opsTenantRecord.mockRejectedValueOnce(new Error('down'));
    fireEvent.click(within(line).getByRole('button', { name: 'Try Again' }));
    await waitFor(() => expect(api.opsTenantRecord).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Try Again' })).toBeTruthy();
    expect(screen.getByText('41 Vine St')).toBeTruthy();
    expect(screen.queryByText("Couldn't load this tenant.")).toBeNull();
  });

  it('shows the gate code plainly, with Enabled or Disabled as words, only where there is a code', async () => {
    api.opsTenantRecord.mockResolvedValue(TENANT);
    open();
    const code = await screen.findByTestId('ops-tenant-gate');
    expect(code.textContent).toBe('4821#');
    expect(screen.getByText('Enabled').style.color).toBe('var(--ok-fg)');
    expect(screen.getAllByTestId('ops-tenant-gate').length).toBe(1);
    expect(screen.getByText('Gate Access')).toBeTruthy();
  });

  it('leaves Gate Access and Second Contacts out when there is nothing to show', async () => {
    api.opsTenantRecord.mockResolvedValue({ ...TENANT, facilities: [{ facilityId: 'fac_a', facilityName: 'Temecula', gateCode: '', gateCodeEnabled: false }],
      leases: [{ ...LEASE, altContacts: [] }] });
    open();
    await screen.findByTestId('ops-tenant-live');
    expect(screen.queryByText('Gate Access')).toBeNull();
    expect(screen.queryByText('Second Contacts')).toBeNull();
  });

  it('draws each unit with its vehicle, move-out, overlock and policy lines', async () => {
    api.opsTenantRecord.mockResolvedValue(TENANT);
    open();
    const units = await screen.findByRole('table', { name: 'Units' });
    expect(within(units).getByText('RV - plate 7ABC123 (CA)')).toBeTruthy();
    expect(within(units).getByText('Moves out 12/01/2099')).toBeTruthy();
    expect(within(units).getByText('Overlock needed').style.color).toBe('var(--bad-fg)');
    expect(within(units).getByText('Policy expired 09/30/2026').style.color).toBe('var(--bad-fg)');
    expect(within(units).getByText('$158.00').style.color).toBe('var(--bad-fg)');
    expect(within(units).getByText('$189.00')).toBeTruthy();
    // A second contact on two leases is one person.
    expect(screen.getAllByText('Lee Whitfield').length).toBe(1);
  });

  it('reads the ledger for the lease picked and lists the payments newest first', async () => {
    api.opsTenantRecord.mockResolvedValue(TENANT);
    open();
    const ledger = await screen.findByRole('table', { name: 'Ledger' });
    expect(api.opsTenantLedger).toHaveBeenCalledWith('fac_a', 'cus_1');
    expect(within(ledger).getByText('November rent')).toBeTruthy();
    expect(within(ledger).queryByText('Late fee')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Lease for the ledger' }), { target: { value: 'fac_a:lease_2' } });
    expect(within(screen.getByRole('table', { name: 'Ledger' })).getByText('Late fee')).toBeTruthy();
    // Same facility: one read serves both leases.
    expect(api.opsTenantLedger).toHaveBeenCalledTimes(1);
    const rows = within(screen.getByRole('table', { name: 'Payments' })).getAllByRole('row');
    expect(rows[1].textContent).toContain('11/01/2026');
    expect(rows[1].textContent).toContain('Succeeded');
    expect(rows[2].textContent).toContain('10/01/2026');
  });

  it('gives the ledger its own failure line and keeps the rest of the record', async () => {
    api.opsTenantRecord.mockResolvedValue(TENANT);
    api.opsTenantLedger.mockReset();
    api.opsTenantLedger.mockRejectedValueOnce(new Error('Cubby did not answer'));
    open();
    expect(await screen.findByText("Couldn't load the ledger from Cubby.")).toBeTruthy();
    expect(screen.queryByText('No ledger entries in Cubby.')).toBeNull();
    expect(screen.getByRole('table', { name: 'Units' })).toBeTruthy();
    api.opsTenantLedger.mockResolvedValue(LEDGER);
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('table', { name: 'Ledger' })).toBeTruthy();
  });

  it('has nothing to edit and says where tenant details are changed', async () => {
    api.opsTenantRecord.mockResolvedValue({ ...TENANT, cubbyUrl: 'https://app.cubbystorage.com/tenants/cus_1' });
    open();
    await screen.findByTestId('ops-tenant-live');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryAllByRole('textbox').length).toBe(0);
    expect(within(dialog).queryAllByRole('checkbox').length).toBe(0);
    expect(within(dialog).queryAllByRole('switch').length).toBe(0);
    expect(dialog.querySelectorAll('input, textarea, [contenteditable="true"]').length).toBe(0);
    expect(within(dialog).queryByRole('button', { name: /save|edit/i })).toBeNull();
    expect(within(dialog).getByText('Tenant details are changed in Cubby.')).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: /Open in Cubby/ }).getAttribute('href')).toBe('https://app.cubbystorage.com/tenants/cus_1');
    // The X in the header and Close in the foot - the only buttons.
    expect(within(dialog).getAllByRole('button').map((b) => b.getAttribute('aria-label') || b.textContent)).toEqual(['Close', 'Close']);
  });

  it('says a failed open failed, and a refused one was refused', async () => {
    api.opsTenantRecord.mockRejectedValueOnce(Object.assign(new Error('down'), { status: 500 }));
    const first = open();
    expect(await screen.findByText("Couldn't load this tenant.")).toBeTruthy();
    api.opsTenantRecord.mockResolvedValueOnce(TENANT);
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByTestId('ops-tenant-live')).toBeTruthy();
    first.unmount();
    api.opsTenantRecord.mockRejectedValueOnce(Object.assign(new Error('no'), { status: 403 }));
    open();
    expect(await screen.findByText('You do not have access to tenant details.')).toBeTruthy();
  });
});
