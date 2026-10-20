import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { cellText, csvValue, sortRows } from './reportFormat';

// Operations > Reports (Neil, Oct 20): Cubby's reports as tables, the tenant /
// unit drill-down, and the Report Builder. Render-smoke and the main paths;
// the server is mocked.

const api = {
  opsReportCatalog: vi.fn(), opsReport: vi.fn(), opsTenant: vi.fn(), opsTenantLedger: vi.fn(), opsUnit: vi.fn(),
  opsBuilderRegistry: vi.fn(), opsBuilderRun: vi.fn(), opsSavedReports: vi.fn(), createOpsSavedReport: vi.fn(),
  updateOpsSavedReport: vi.fn(), deleteOpsSavedReport: vi.fn(), shareOpsSavedReport: vi.fn(), sendOpsSavedReport: vi.fn(),
  getPeopleDirectory: vi.fn(), facilityOpsReport: vi.fn(),
  opsReportExport: vi.fn(), opsReportSchedules: vi.fn(), createOpsReportSchedule: vi.fn(), updateOpsReportSchedule: vi.fn(),
  deleteOpsReportSchedule: vi.fn(), sendOpsReportSchedule: vi.fn(),
};
const saveBlob = vi.fn();
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }), saveBlob: (...a) => saveBlob(...a) }));
const confirm = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a) } }));
const downloadCsv = vi.fn();
vi.mock('./csv', async (orig) => ({ ...(await orig()), downloadCsv: (...a) => downloadCsv(...a) }));

const Reports = (await import('./Reports')).default;

const FACS = [{ id: 'fac_a', shortName: 'Temecula', asOf: '2026-10-15' }, { id: 'fac_b', shortName: 'Murrieta', asOf: '2026-10-15' }];
const RANGE = { key: 'this-month', label: 'This Month', from: '2026-10-01', to: '2026-10-15' };
const CATALOG = {
  categories: ['Rent and Occupancy', 'Activity'],
  reports: [
    { key: 'rent-roll', title: 'Rent Roll', category: 'Rent and Occupancy', about: 'Every unit.', source: 'cubby', period: false },
    { key: 'move-in-move-out-detail', title: 'Move-In / Move-Out Detail', category: 'Activity', about: 'Moves.', source: 'nexus', period: true,
      options: [{ key: 'ignore_parking', label: 'Ignore Parking Units', type: 'bool', default: false, help: 'Leave parking spaces out.' }] },
    { key: 'inventory-activity', title: 'Inventory Activity', category: 'Activity', about: 'Not Available From Cubby Yet.', source: 'unavailable', period: true },
  ],
};
const RENT_ROLL = {
  key: 'rent-roll', title: 'Rent Roll', available: true, asOf: '2026-10-15', period: null, fetchedAt: '2026-10-15T15:00:00Z', notes: [],
  columns: [{ key: 'unit', label: 'Unit', type: 'unit' }, { key: 'tenant', label: 'Tenant', type: 'tenant' },
    { key: 'rent', label: 'Monthly Rent', type: 'money', total: true }, { key: 'paidThrough', label: 'Paid Through', type: 'date' }],
  rows: [
    { _f: 'fac_a', _c: 'cust_1', _u: 'b213', unit: 'B213', tenant: 'Aiden Robb', rent: 95108, paidThrough: '2026-09-30' },
    { _f: 'fac_a', _c: 'cust_2', _u: 'a104', unit: 'A104', tenant: 'Amanda Sakama', rent: 12000, paidThrough: '2026-10-31' },
  ],
  totals: { rent: 107108 }, groups: {},
  summary: [{ label: 'Units Rented', value: 2, type: 'int' }, { label: 'Monthly Rent', value: 107108, type: 'money' }, { label: 'Occupancy', value: 87.5, type: 'pct' }],
};
const TENANT = {
  facilityId: 'fac_a', facility: 'Temecula', customerId: 'cust_1', name: 'Aiden Robb', cubbyUrl: 'https://app.cubbystorage.com/tenants/cust_1',
  units: [{ unitId: 'b213', unit: 'B213', type: '10x10', rent: 95108, street: 100000, paidThrough: '2026-09-30', moveIn: '2025-01-01', autoPay: false, overlocked: true }],
  balance: { total: 95108, lines: [{ unitId: 'b213', unit: 'B213', total: 95108, range_0_30: 95108 }] },
  payments: [{ date: '2026-09-02', amount: 15000, status: 'Succeeded', method: 'Credit Card', reason: '' }],
  rentals: [{ unitId: 'b213', unit: 'B213', moveIn: '2025-01-01', moveOut: '', rent: 95108, stayDays: 652 }], leases: ['lease_1'],
};
const REGISTRY = {
  datasets: [{ key: 'units', label: 'Units', about: 'Every unit.', dated: false,
    dimensions: [{ key: 'facility', label: 'Facility' }, { key: 'unit_type', label: 'Unit Type' }],
    fields: [{ key: 'rent', label: 'Monthly Rent', format: 'money' }, { key: 'occupied_area', label: 'Occupied Sq Ft', format: 'area' }] }],
  aggregations: [{ key: 'count', label: 'Count' }, { key: 'sum', label: 'Sum' }, { key: 'avg', label: 'Average' }],
  formats: ['area', 'money', 'number', 'pct'], periods: [{ key: 'this-month', label: 'This Month' }],
  schedules: [{ key: '', label: 'Not Scheduled' }, { key: 'weekly', label: 'Weekly' }, { key: 'monthly', label: 'Monthly' }],
  weekdays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  limits: { dimensions: 3, measures: 8, formulas: 6, recipients: 25 },
};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  downloadCsv.mockReset();
  saveBlob.mockReset();
  confirm.mockReset();
  window.localStorage.clear();
  api.opsReportSchedules.mockResolvedValue([]);
  api.opsReportCatalog.mockResolvedValue(CATALOG);
  api.opsReport.mockImplementation((kind) => Promise.resolve(kind === 'rent-roll' ? RENT_ROLL
    : { key: kind, title: kind, available: false, notes: ['Retail sales and stock movements. Not Available From Cubby Yet.'], columns: [], rows: [] }));
  api.opsTenant.mockResolvedValue(TENANT);
  api.opsTenantLedger.mockResolvedValue({ entries: [{ date: '2026-10-01', unit: 'B213', type: 'Charge', category: 'Rent', description: '', accrues: '', amount: 15000, paid: 0, waived: false }] });
  api.opsUnit.mockResolvedValue({ facilityId: 'fac_a', facility: 'Temecula', unitId: 'b213', unit: 'B213', type: '10x10', size: '10x10', area: 100,
    status: 'Rented', street: 100000, rent: 95108, reason: '', note: '', overlocked: true, tenant: { customerId: 'cust_1', name: 'Aiden Robb' },
    paidThrough: '2026-09-30', autoPay: false, balance: 95108, history: [{ customerId: 'cust_0', tenant: 'Earlier Tenant', moveIn: '2024-01-01', moveOut: '2024-12-01', rent: 9000, stayDays: 335 }], tasks: [] });
  api.opsBuilderRegistry.mockResolvedValue(REGISTRY);
  api.opsSavedReports.mockResolvedValue({ reports: [] });
  api.getPeopleDirectory.mockResolvedValue([{ email: 'neil@greensglobal.com', name: 'Neil Kadakia' }]);
});

const renderReports = () => render(<Reports data={{}} facilities={FACS} scope={FACS} range={RANGE} />);

describe('Operations > Reports', () => {
  it('lists the reports, opens one as a table with headline figures, totals, sorting and search', async () => {
    renderReports();
    expect(await screen.findByRole('button', { name: 'Rent Roll' })).toBeTruthy();       // the library first
    expect(api.opsReport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Rent Roll' }));
    expect(await screen.findByText('Aiden Robb')).toBeTruthy();
    expect(api.opsReport).toHaveBeenCalledWith('rent-roll', { facilityIds: [], start: '', end: '', options: undefined });   // a snapshot, every facility
    expect(screen.getByText('As of the Last Cubby Sync')).toBeTruthy();
    expect(screen.getByText('Units Rented')).toBeTruthy();                   // headline tiles
    expect(screen.getByText('87.5%')).toBeTruthy();
    expect(screen.getAllByText('$1,071.08')).toHaveLength(2);                // the tile and the total row
    expect(screen.getByText('09/30/2026')).toBeTruthy();                      // US dates
    fireEvent.click(screen.getByRole('button', { name: 'Monthly Rent' }));    // ascending
    const first = () => document.querySelector('.ops-rtable tbody tr td').textContent;
    expect(first()).toBe('A104');
    fireEvent.change(screen.getByLabelText('Search Rent Roll'), { target: { value: 'aiden' } });
    expect(document.querySelectorAll('.ops-rtable tbody tr')).toHaveLength(1);
    // CSV from the Download menu; before the export endpoint is live it is built here.
    api.opsReportExport.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    fireEvent.click(screen.getByRole('button', { name: /Download/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /CSV/ }));
    await waitFor(() => expect(downloadCsv).toHaveBeenCalled());
    expect(api.opsReportExport).toHaveBeenCalledWith('rent-roll', { facilityIds: [], start: '', end: '', options: undefined, format: 'csv' });
    expect(downloadCsv.mock.calls[0][1]).toEqual(['Unit', 'Tenant', 'Monthly Rent', 'Paid Through']);
    expect(downloadCsv.mock.calls[0][2]).toEqual([['B213', 'Aiden Robb', '951.08', '09/30/2026'], ['A104', 'Amanda Sakama', '120.00', '10/31/2026']]);
    fireEvent.click(screen.getByRole('button', { name: 'All Reports' }));
    expect(await screen.findByLabelText('Search Reports')).toBeTruthy();
    expect(screen.getByText('Recent')).toBeTruthy();
  });

  it('opens a tenant, then their unit, then back', async () => {
    renderReports();
    fireEvent.click(await screen.findByRole('button', { name: 'Rent Roll' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Aiden Robb' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aiden Robb' });
    expect(api.opsTenant).toHaveBeenCalledWith('fac_a', 'cust_1');
    await within(dialog).findByText('Cubby Ledger');
    await waitFor(() => expect(api.opsTenantLedger).toHaveBeenCalledWith('fac_a', 'cust_1'));
    expect(within(dialog).getByText('Open in Cubby').closest('a').getAttribute('href')).toBe('https://app.cubbystorage.com/tenants/cust_1');
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'B213' })[0]);
    expect(await screen.findByRole('dialog', { name: 'Unit B213' })).toBeTruthy();
    expect(screen.getByText('Earlier Tenant')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('dialog', { name: 'Aiden Robb' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('follows the page period on an activity report and names what Cubby does not have', async () => {
    renderReports();
    fireEvent.click(await screen.findByRole('button', { name: 'Move-In / Move-Out Detail' }));
    await waitFor(() => expect(api.opsReport).toHaveBeenCalledWith('move-in-move-out-detail',
      { facilityIds: [], start: '2026-10-01', end: '2026-10-15', options: { ignore_parking: false } }));
    expect(screen.getByText('Current Month: 10/01/2026 - 10/15/2026')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All Reports' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Inventory Activity' }));
    expect(await screen.findByText(/Retail sales and stock movements/)).toBeTruthy();
  });

  it('searches, filters by category and keeps favorites at the top', async () => {
    renderReports();
    const search = await screen.findByLabelText('Search Reports');
    fireEvent.change(search, { target: { value: 'moves' } });
    expect(screen.queryByRole('button', { name: 'Rent Roll' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Move-In / Move-Out Detail' })).toBeTruthy();
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Rent and Occupancy' } });
    expect(screen.getByText('1 report')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '' } });
    const names = () => [...document.querySelectorAll('.ops-lib-name')].map((b) => b.textContent);
    expect(names()[0]).toBe('Inventory Activity');
    fireEvent.click(screen.getByRole('button', { name: 'Add Rent Roll to Favorites' }));
    expect(names()[0]).toBe('Rent Roll');
    expect(JSON.parse(window.localStorage.getItem('nexus.opsReports.favorites'))).toEqual(['rent-roll']);
    fireEvent.keyDown(document, { key: '/' });
    expect(document.activeElement).toBe(search);
  });

  it('downloads a report for the period, facilities, options and format picked', async () => {
    api.opsReportExport.mockResolvedValue({ blob: new Blob(['x']), filename: 'Move-In Move-Out Detail.pdf' });
    renderReports();
    fireEvent.click(await screen.findByRole('button', { name: 'Download Move-In / Move-Out Detail' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move-In / Move-Out Detail' });
    fireEvent.click(within(dialog).getByLabelText('Previous'));
    expect(within(dialog).getByText('Covers 09/01/2026 - 09/30/2026.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Period Length'), { target: { value: 'quarter' } });
    expect(within(dialog).getByText('Covers 07/01/2026 - 09/30/2026.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /All Facilities \(2\)/ }));
    fireEvent.click(within(dialog).getByLabelText('Murrieta'));                     // only Temecula left
    fireEvent.click(within(dialog).getByLabelText(/Ignore Parking Units/));
    fireEvent.click(within(dialog).getByLabelText(/PDF/));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Download/ }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalled());
    expect(api.opsReportExport).toHaveBeenCalledWith('move-in-move-out-detail',
      { facilityIds: ['fac_a'], start: '2026-07-01', end: '2026-09-30', options: { ignore_parking: true }, format: 'pdf' });
    expect(saveBlob.mock.calls[0][1]).toBe('Move-In Move-Out Detail.pdf');
    expect(screen.queryByRole('dialog')).toBeNull();
    // Remembered for next time (the facilities follow the page).
    expect(JSON.parse(window.localStorage.getItem('nexus.opsReports.choices.move-in-move-out-detail')))
      .toMatchObject({ period: { mode: 'previous', unit: 'quarter' }, options: { ignore_parking: true }, format: 'pdf' });
  });

  it('lists, sends, switches off, deletes and creates scheduled reports', async () => {
    const SCHED = { id: 's1', name: 'Weekly Moves', kind: 'move-in-move-out-detail', title: 'Move-In / Move-Out Detail', facilityIds: [],
      period: { mode: 'previous', unit: 'week' }, options: {}, format: 'xlsx', frequency: 'weekly', day: 0, hour: 8, includeWeekends: false,
      active: true, recipients: ['neil@greensglobal.com'], lastSentAt: '', lastError: '', owner: 'me', mine: true, canEdit: true, nextRunAt: '' };
    api.opsReportSchedules.mockResolvedValue([SCHED]);
    api.sendOpsReportSchedule.mockResolvedValue({ ok: true });
    api.updateOpsReportSchedule.mockResolvedValue({ schedule: { ...SCHED, active: false } });
    api.deleteOpsReportSchedule.mockResolvedValue({ ok: true });
    api.createOpsReportSchedule.mockImplementation((b) => Promise.resolve({ schedule: { id: 's2', ...b } }));
    confirm.mockResolvedValue(true);
    renderReports();
    fireEvent.click(await screen.findByRole('tab', { name: 'Scheduled (1)' }));
    expect(await screen.findByText('Every Monday at 8:00 AM')).toBeTruthy();
    expect(await screen.findByText('Neil Kadakia')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Send Now/ }));
    await waitFor(() => expect(api.sendOpsReportSchedule).toHaveBeenCalledWith('s1'));
    fireEvent.click(screen.getByRole('switch', { name: 'Weekly Moves Active' }));
    await waitFor(() => expect(api.updateOpsReportSchedule).toHaveBeenCalledWith('s1', { active: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Weekly Moves' }));
    await waitFor(() => expect(api.deleteOpsReportSchedule).toHaveBeenCalledWith('s1'));
    expect(confirm).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /New Schedule/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Schedule Report' });
    fireEvent.change(within(dialog).getByLabelText('Report'), { target: { value: 'rent-roll' } });
    expect(within(dialog).getByLabelText('Name').value).toBe('Rent Roll');
    fireEvent.change(within(dialog).getByLabelText('How Often'), { target: { value: 'monthly' } });
    fireEvent.change(within(dialog).getByLabelText('Day of the Month'), { target: { value: '3' } });
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '14' } });
    expect(within(dialog).getByText('Monthly on the 3rd at 2:00 PM, Pacific Time.')).toBeTruthy();
    await waitFor(() => expect(api.getPeopleDirectory).toHaveBeenCalled());
    fireEvent.change(within(dialog).getByLabelText('Add a Person'), { target: { value: 'neil@greensglobal.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByRole('button', { name: 'Remove Neil Kadakia' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Schedule' }));
    await waitFor(() => expect(api.createOpsReportSchedule).toHaveBeenCalled());
    expect(api.createOpsReportSchedule.mock.calls[0][0]).toMatchObject({ name: 'Rent Roll', kind: 'rent-roll', frequency: 'monthly', day: 3, hour: 14,
      recipients: ['neil@greensglobal.com'], facilityIds: [], format: 'xlsx', active: true });
    expect(await screen.findByText('Rent Roll was saved.')).toBeTruthy();
  });

  it('stays calm before the server has scheduled reports', async () => {
    api.opsReportSchedules.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    renderReports();
    expect(await screen.findByRole('button', { name: 'Schedule Rent Roll' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('tab', { name: 'Scheduled' }));
    expect(await screen.findByText('Scheduled report emails are not switched on yet.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('builds a metric from two measures and saves it on a weekly schedule', async () => {
    api.opsBuilderRun.mockResolvedValue({
      dataset: 'Units', facility: 'All Facilities', asOf: '2026-10-15', period: null, count: 5,
      columns: [{ key: 'facility', label: 'Facility', type: 'text' }, { key: 'rent', label: 'Sum of Monthly Rent', type: 'money' },
        { key: 'occ_sqft', label: 'Sum of Occupied Sq Ft', type: 'area' }, { key: 'per_sqft', label: 'Rent per Occupied Sq Ft', type: 'money' }],
      rows: [{ facility: 'Temecula', rent: 35000, occ_sqft: 300, per_sqft: 116.67 }], totals: { rent: 35000, occ_sqft: 300, per_sqft: 116.67 },
    });
    api.createOpsSavedReport.mockImplementation((body) => Promise.resolve({ report: { id: 'r1', ...body, mine: true, canEdit: true, owner: 'me' } }));
    renderReports();
    fireEvent.click(await screen.findByRole('tab', { name: 'Report Builder' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rent per Occupied Sq Ft' }));     // a starting point
    expect((await screen.findAllByText('$1.17')).length).toBe(2);             // the line and the total
    const spec = api.opsBuilderRun.mock.calls[0][0];
    expect(spec.formulas[0].expr).toBe('rent / occ_sqft');
    fireEvent.click(screen.getByRole('button', { name: /Save Report/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Save Report' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Rent per Sq Ft' } });
    fireEvent.change(within(dialog).getByLabelText('Send Automatically'), { target: { value: 'weekly' } });
    await waitFor(() => expect(api.getPeopleDirectory).toHaveBeenCalled());
    fireEvent.change(within(dialog).getByPlaceholderText('Name or email from Nexus People'), { target: { value: 'neil@greensglobal.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(within(dialog).getByRole('button', { name: 'Remove Neil Kadakia' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Report' }));
    await waitFor(() => expect(api.createOpsSavedReport).toHaveBeenCalled());
    const body = api.createOpsSavedReport.mock.calls[0][0];
    expect(body).toMatchObject({ name: 'Rent per Sq Ft', schedule: 'weekly', scheduleDay: 0, recipients: ['neil@greensglobal.com'] });
    expect(body.spec.dataset).toBe('units');
    expect(await screen.findByText('Rent per Sq Ft was saved.')).toBeTruthy();
  });
});

describe('report cells', () => {
  it('formats and sorts the way the screen and CSV need', () => {
    expect(cellText(95108, 'money')).toBe('$951.08');
    expect(cellText('2026-10', 'text')).toBe('10/2026');
    expect(cellText(33.333, 'pct')).toBe('33.3%');
    expect(csvValue(-500, 'money')).toBe('-5.00');
    expect(csvValue('2026-10-04', 'date')).toBe('10/04/2026');
    const rows = [{ v: 2 }, { v: null }, { v: 10 }];
    expect(sortRows(rows, 'v', true, 'int').map((r) => r.v)).toEqual([10, 2, null]);
  });
});
