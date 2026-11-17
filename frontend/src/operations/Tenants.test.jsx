import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Operations > Tenants (Neil, 11/17/2026): the read-only tenant directory.
// The server does the searching; these pin what the screen does with the
// answers - the rows, the three states that must never look alike (failed,
// no access, nothing found), the debounced search and its guard against an
// older answer landing late, and the way into a tenant's record.

const api = { opsTenants: vi.fn(), opsAccessMe: vi.fn(), getFacilityOps: vi.fn(), getThirdPartyFacilities: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) }));
vi.mock('./TenantSheet', () => ({ default: ({ customerId }) => <div data-testid="sheet">Sheet for {customerId}</div> }));
// For the tab's gate in the Operations page (the last tests): the role, and a
// plain stand-in for the header's tab strip that lists each menu's items.
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));
vi.mock('../components/ModuleTabs', () => ({
  default: ({ tabs }) => <div role="tablist">{tabs.map((t) => <span key={t.key} role="tab" data-items={(t.items || []).map((i) => i.label).join('|')}>{t.label}</span>)}</div>,
  ModuleActions: ({ children }) => children,
}));

const { default: Tenants } = await import('./Tenants');
const { default: FacilityOperations } = await import('../views/FacilityOperations');

const ROW = { customerId: 'cus_1', facilityId: 'fac_a', facilityName: 'Temecula', name: 'Dana Whitfield', companyName: 'Whitfield Landscaping',
  phone: '(951) 555-0142', email: 'dana@example.com', units: ['A12', 'B4'], current: true, balanceCents: 12950, paidThrough: '2026-12-01', autopay: true, plates: ['7ABC123'] };
const PAID = { ...ROW, customerId: 'cus_2', name: 'Omar Reyes', companyName: '', phone: '', email: '', units: ['C7'], balanceCents: 0, paidThrough: '2026-11-30' };
const page = (rows, total = rows.length) => ({ rows, total, syncedAt: '2026-11-17T14:15:00' });
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const box = () => screen.getByRole('searchbox');

beforeEach(() => { Object.values(api).forEach((f) => f.mockReset()); });

describe('Operations > Tenants', () => {
  it('draws a row per tenant, with links for the phone and the email', async () => {
    api.opsTenants.mockResolvedValue(page([ROW, PAID]));
    render(<Tenants many />);
    expect(await screen.findByRole('button', { name: 'Dana Whitfield' })).toBeTruthy();
    expect(api.opsTenants).toHaveBeenCalledWith({ q: '', facility: '', status: 'current', limit: 50, offset: 0 });
    expect(screen.getByText('Whitfield Landscaping')).toBeTruthy();
    expect(screen.getByText('A12, B4')).toBeTruthy();
    expect(screen.getAllByText('Temecula').length).toBe(2);
    expect(screen.getByRole('link', { name: '(951) 555-0142' }).getAttribute('href')).toBe('tel:9515550142');
    expect(screen.getByRole('link', { name: 'dana@example.com' }).getAttribute('href')).toBe('mailto:dana@example.com');
    // What is owed is red words; nothing owed is a hyphen. US dates.
    expect(screen.getByText('$129.50').style.color).toBe('var(--bad-fg)');
    expect(screen.getByText('12/01/2026')).toBeTruthy();
    const paid = screen.getByRole('button', { name: 'Omar Reyes' }).closest('tr');
    expect(paid.querySelector('td[data-th="Balance"]').textContent).toBe('-');
    expect(screen.getByTestId('ops-tenants-synced').textContent).toMatch(/^Read from Cubby (at|on) .*2:15 PM$/);
  });

  it('follows the facility picked on the page', async () => {
    api.opsTenants.mockResolvedValue(page([ROW]));
    render(<Tenants facility={{ id: 'fac_a', shortName: 'Temecula' }} />);
    await screen.findByRole('button', { name: 'Dana Whitfield' });
    expect(api.opsTenants).toHaveBeenCalledWith(expect.objectContaining({ facility: 'fac_a' }));
    // One facility in view: the row does not repeat its name.
    expect(screen.queryByText('Temecula')).toBeNull();
  });

  it('says a failed load failed - never "No tenants match." - and tries again', async () => {
    api.opsTenants.mockRejectedValueOnce(Object.assign(new Error('down'), { status: 500 }));
    render(<Tenants />);
    expect(await screen.findByText("Couldn't load the tenants.")).toBeTruthy();
    expect(screen.queryByText('No tenants match.')).toBeNull();
    api.opsTenants.mockResolvedValue(page([ROW]));
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('button', { name: 'Dana Whitfield' })).toBeTruthy();
  });

  it('says so in plain words when the person has no access (403)', async () => {
    api.opsTenants.mockRejectedValue(Object.assign(new Error('You do not have access to tenant details.'), { status: 403 }));
    render(<Tenants />);
    expect(await screen.findByText('You do not have access to tenant details.')).toBeTruthy();
    expect(screen.queryByText('No tenants match.')).toBeNull();
    expect(screen.queryByText("Couldn't load the tenants.")).toBeNull();
  });

  it('has its own words for an empty answer', async () => {
    api.opsTenants.mockResolvedValue(page([]));
    render(<Tenants />);
    expect(await screen.findByText('No tenants match.')).toBeTruthy();
  });

  it('searches as the person types, after a pause', async () => {
    api.opsTenants.mockResolvedValue(page([ROW, PAID]));
    render(<Tenants />);
    await screen.findByRole('button', { name: 'Dana Whitfield' });
    api.opsTenants.mockResolvedValue(page([PAID]));
    fireEvent.change(box(), { target: { value: 'rey' } });
    fireEvent.change(box(), { target: { value: 'reyes' } });
    await waitFor(() => expect(api.opsTenants).toHaveBeenLastCalledWith({ q: 'reyes', facility: '', status: 'current', limit: 50, offset: 0 }));
    // One question for the pause, not one per keystroke.
    expect(api.opsTenants).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Dana Whitfield' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Omar Reyes' })).toBeTruthy();
  });

  it('never lets an older answer replace a newer one', async () => {
    api.opsTenants.mockResolvedValueOnce(page([]));
    render(<Tenants />);
    await screen.findByText('No tenants match.');
    const older = deferred();
    const newer = deferred();
    api.opsTenants.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    fireEvent.change(box(), { target: { value: 'da' } });
    await waitFor(() => expect(api.opsTenants).toHaveBeenCalledTimes(2));
    fireEvent.change(box(), { target: { value: 'omar' } });
    await waitFor(() => expect(api.opsTenants).toHaveBeenCalledTimes(3));
    newer.resolve(page([PAID]));
    expect(await screen.findByRole('button', { name: 'Omar Reyes' })).toBeTruthy();
    older.resolve(page([ROW]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Dana Whitfield' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Omar Reyes' })).toBeTruthy();
  });

  it('asks for Former and All, starting on Current', async () => {
    api.opsTenants.mockResolvedValue(page([ROW]));
    render(<Tenants />);
    await screen.findByRole('button', { name: 'Dana Whitfield' });
    expect(screen.getByRole('button', { name: 'Current' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Former' }));
    await waitFor(() => expect(api.opsTenants).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'former', offset: 0 })));
  });

  it('pages 50 at a time and says where it is', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({ ...PAID, customerId: `cus_${i}`, name: `Tenant ${i}` }));
    api.opsTenants.mockResolvedValue(page(fifty, 1729));
    render(<Tenants />);
    expect(await screen.findByText('1 - 50 of 1,729')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.opsTenants).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 })));
    expect(await screen.findByText('51 - 100 of 1,729')).toBeTruthy();
  });

  it('opens the tenant record from the row and from the name', async () => {
    api.opsTenants.mockResolvedValue(page([ROW, PAID]));
    render(<Tenants />);
    const name = await screen.findByRole('button', { name: 'Dana Whitfield' });
    expect(screen.queryByTestId('sheet')).toBeNull();
    // The name is a real button, so Tab reaches it and Enter opens it.
    fireEvent.click(name);
    expect(screen.getByTestId('sheet').textContent).toBe('Sheet for cus_1');
    fireEvent.click(screen.getByRole('button', { name: 'Omar Reyes' }).closest('tr'));
    expect(screen.getByTestId('sheet').textContent).toBe('Sheet for cus_2');
  });

  it('says why a store another operator runs has no tenants here, without asking the server', () => {
    render(<Tenants facility={{ id: 'tpm_1', shortName: 'Hemet', thirdParty: { sourceLabel: 'CubeSmart' } }} />);
    expect(screen.getByText(/Hemet is run by another operator/)).toBeTruthy();
    expect(api.opsTenants).not.toHaveBeenCalled();
  });
});

// The Tenants tab is in the Operations bar only for someone the access rules
// give Tenant Details (GET /facility-ops/access/me, asked once).
const FACILITY = { id: 'fac_a', name: 'Greens Storage Temecula', shortName: 'Temecula', asOf: '2026-11-17',
  units: { total: 100, rented: 70, vacant: 20, unavailable: 10 }, area: { total: 20000, rented: 14000 },
  rent: { rentRoll: 1400000, streetRented: 1500000, vacantPotential: 400000, belowStreetGap: 100000, belowStreetCount: 12 },
  autoPay: 50, protected: 30,
  pastDue: { total: 0, tenants: 0, buckets: { d0_30: 0, d30_60: 0, d60_90: 0, d90_120: 0, d120_plus: 0, unknown: 0 }, rows: [] },
  locks: { toPlace: [], toRemove: [], applied: 0 }, history: [], moves: { insMtd: 0, outsMtd: 0, movingOut: [], movingIn: [], daily: [] },
  rentChanges: { count: 0, lift: 0 }, unitTypes: [], belowStreet: [], offMarket: [],
  leads: { total: 0, open: 0, reserved: 0, converted: 0, byStatus: {}, rows: [] }, tasks: { open: 0, overdue: 0, rows: [] },
  payments: { collectedMtd: 0, daily: [], failed: [] } };
const OPS = { organization: 'Greens Storage', fetchedAt: '2026-11-17T16:00:00Z', trend: [], syncedAt: new Date().toISOString(),
  syncStatus: 'ok', syncRunning: false, cubbyConfigured: true, facilities: [FACILITY] };
const facilitiesMenu = () => screen.getByRole('tab', { name: 'Facilities' }).dataset.items;

describe('Operations > the Tenants tab', () => {
  beforeEach(() => {
    api.getFacilityOps.mockResolvedValue(OPS);
    api.getThirdPartyFacilities.mockResolvedValue({ facilities: [] });
    api.opsTenants.mockResolvedValue(page([ROW]));
    localStorage.removeItem('nexus.ops.facility');
    localStorage.removeItem('nexus.ops.state');
  });

  it('leads the Facilities menu for someone with Tenant Details, and the page search steps aside', async () => {
    api.opsAccessMe.mockResolvedValue({ facilities: null, tenantDetails: true, canManage: false });
    render(<FacilityOperations activeSub="tenants" onSubChange={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Dana Whitfield' })).toBeTruthy();
    expect(facilitiesMenu()).toBe('Tenants|Collections|Units & Pricing|Facility Tasks');
    expect(api.opsAccessMe).toHaveBeenCalledTimes(1);
    // One search box on this screen, and no period: tenants are as of now.
    expect(screen.getAllByRole('searchbox').length).toBe(1);
    expect(screen.queryByText('Period')).toBeNull();
  });

  it('is not in the bar without Tenant Details, and a link to it says so instead of asking for tenants', async () => {
    api.opsAccessMe.mockResolvedValue({ facilities: ['fac_a'], tenantDetails: false, canManage: false });
    render(<FacilityOperations activeSub="tenants" onSubChange={() => {}} />);
    expect(await screen.findByText('You do not have access to tenant details.')).toBeTruthy();
    expect(facilitiesMenu()).toBe('Collections|Units & Pricing|Facility Tasks');
    expect(api.opsTenants).not.toHaveBeenCalled();
  });

  it('stays out of the bar while the answer is on its way and when it could not be read', async () => {
    api.opsAccessMe.mockRejectedValueOnce(new Error('down'));
    render(<FacilityOperations activeSub="tenants" onSubChange={() => {}} />);
    expect(await screen.findByText(/Couldn't check your access to tenant details\./)).toBeTruthy();
    expect(facilitiesMenu()).toBe('Collections|Units & Pricing|Facility Tasks');
    expect(api.opsTenants).not.toHaveBeenCalled();
    api.opsAccessMe.mockResolvedValue({ facilities: null, tenantDetails: true, canManage: true });
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('button', { name: 'Dana Whitfield' })).toBeTruthy();
    expect(facilitiesMenu()).toBe('Tenants|Collections|Units & Pricing|Facility Tasks');
  });
});
