import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { toCsv, csvName } from '../operations/csv';
import { combine, attentionItems, pastDueTrend, periodRange, periodStats, historyWindow, collectionSeries } from '../operations/model';

// Operations (storage facilities, Oct 2026): the screen reads Cubby through one
// endpoint. These are the render-smoke tests - every tab draws from the same
// payload without crashing, with one facility or several, and a failed read
// shows a message instead of a blank screen.

const getFacilityOps = vi.fn();
const facilityOpsLookup = vi.fn();
const facilityOpsReport = vi.fn();
const getOpsMarket = vi.fn();
const recordOpsRate = vi.fn();
const getOpsNearby = vi.fn();
const addOpsCompetitor = vi.fn();
const checkOpsCompetitor = vi.fn();
const updateOpsCompetitor = vi.fn();
const getCubbySync = vi.fn();
const startCubbySync = vi.fn();
vi.mock('../api', () => ({ api: {
  getOpsNearby: (...a) => getOpsNearby(...a), addOpsCompetitor: (...a) => addOpsCompetitor(...a),
  checkOpsCompetitor: (...a) => checkOpsCompetitor(...a), updateOpsCompetitor: (...a) => updateOpsCompetitor(...a),
  getFacilityOps: (...a) => getFacilityOps(...a), facilityOpsLookup: (...a) => facilityOpsLookup(...a),
  facilityOpsReport: (...a) => facilityOpsReport(...a), getOpsMarket: (...a) => getOpsMarket(...a),
  recordOpsRate: (...a) => recordOpsRate(...a),
  getCubbySync: (...a) => getCubbySync(...a), startCubbySync: (...a) => startCubbySync(...a),
  // Reports > Reports (Oct 20) loads its list on open; the export test below uses Quick Exports.
  opsReportCatalog: () => Promise.resolve({ categories: [], reports: [] }),
} }));
let isManager = false;
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: (r) => (r === 'manager' ? isManager : true) }) }));
const downloadCsv = vi.fn();
vi.mock('../operations/csv', async (orig) => ({ ...(await orig()), downloadCsv: (...a) => downloadCsv(...a) }));
vi.mock('../components/ModuleTabs', () => ({
  default: ({ tabs, active, onChange }) => (
    <div role="tablist">{tabs.map((t) => <button key={t.key} role="tab" aria-selected={t.key === active} onClick={() => onChange(t.key)}>{t.label}</button>)}</div>
  ),
}));

const FacilityOperations = (await import('./FacilityOperations')).default;
const { default: SyncStatus } = await import('../operations/SyncStatus');
const { syncDelayed } = await import('../operations/sync');

function facility(id, shortName, over = {}) {
  return {
    id, name: `Greens Storage ${shortName}`, shortName, asOf: '2026-10-13',
    units: { total: 100, rented: 70, vacant: 20, unavailable: 10 },
    area: { total: 20000, rented: 14000 },
    rent: { rentRoll: 1400000, streetRented: 1500000, vacantPotential: 400000, belowStreetGap: 100000, belowStreetCount: 12 },
    autoPay: 50, protected: 30,
    pastDue: {
      total: 90000, tenants: 2,
      buckets: { d0_30: 30000, d30_60: 60000, d60_90: 0, d90_120: 0, d120_plus: 0, unknown: 0 },
      rows: [{ unit: 'A12', tenant: 'Pat Example', amount: 60000, oldest: 'd30_60', buckets: {}, autoPay: false, overlocked: false, paidThrough: '2026-08-31', url: 'https://app.cubbystorage.com/tenants/cust_1' }],
    },
    locks: { toPlace: [{ unit: 'A12', tenant: 'Pat Example', paidThrough: '2026-08-31', url: '' }], toRemove: [], applied: 1 },
    history: [{ month: '2026-09', moveIns: 4, moveOuts: 2, rented: 68 }, { month: '2026-10', moveIns: 3, moveOuts: 1, rented: 70 }],
    moves: { insMtd: 3, outsMtd: 1, movingOut: [{ unit: 'B02', tenant: 'Sam Example', date: '2026-10-20', url: '' }], movingIn: [],
      daily: [{ date: '2026-09-20', ins: 4, outs: 2 }, { date: '2026-10-02', ins: 3, outs: 1 }] },
    rentChanges: { count: 0, lift: 0 },
    unitTypes: [{ name: "10' x 20' Drive-Up", total: 100, rented: 70, vacant: 20, unavailable: 10, street: 20000, rentSum: 1400000, vacantPotential: 400000 }],
    belowStreet: [{ unit: 'C03', tenant: 'Lee Example', type: "10' x 20' Drive-Up", rent: 15000, street: 20000, moveIn: '2024-02-01', lastChange: '', url: '' }],
    offMarket: [{ unit: 'D09', type: "10' x 20' Drive-Up", reason: 'REPAIRS_REQUIRED', note: 'Door off track', street: 20000 }],
    leads: { total: 10, open: 1, reserved: 0, converted: 4, byStatus: {}, rows: [{ status: 'NEW', source: 'Website', createdAt: '', ageDays: 3, targetMoveIn: '2026-10-25', url: '' }] },
    tasks: { open: 1, overdue: 1, rows: [{ title: 'Sweep aisle B', dueDate: '2026-10-10', overdue: true, unit: '' }] },
    payments: { collectedMtd: 900000, daily: [{ date: '2026-09-20', collected: 500000, failed: 2 }, { date: '2026-10-12', collected: 300000, failed: 1 }], failed: [{ date: '2026-10-12', amount: 20000, method: 'CREDIT_CARD', reason: 'Insufficient funds', tenant: 'Pat Example', unit: 'A12', url: '' }] },
    ...over,
  };
}

const PAYLOAD = {
  organization: 'Greens Storage', fetchedAt: '2026-10-13T16:00:00Z', trend: [],
  syncedAt: new Date().toISOString(), syncStatus: 'ok', syncRunning: false, cubbyConfigured: true,
  facilities: [facility('fac_a', 'Temecula'), facility('fac_b', 'Murrieta', { units: { total: 50, rented: 45, vacant: 5, unavailable: 0 } })],
};

const NO_NEARBY = { facilityId: 'fac_a', radiusKm: 8, radiusMiles: 5, attribution: 'Nearby facilities from OpenStreetMap contributors', facilities: [], detail: '' };

beforeEach(() => {
  getFacilityOps.mockReset().mockResolvedValue(PAYLOAD);
  getOpsNearby.mockReset().mockResolvedValue(NO_NEARBY);
});

describe('Operations module', () => {
  it('draws every tab from one read', async () => {
    const { rerender } = render(<FacilityOperations activeSub="overview" onSubChange={() => {}} />);
    expect(await screen.findByText('Facility Scorecard')).toBeTruthy();
    expect(screen.getByText('76.7%')).toBeTruthy();                       // 115 rented of 150 units
    rerender(<FacilityOperations activeSub="collections" onSubChange={() => {}} />);
    expect(screen.getByText('Tenants Past Due', { selector: '.dash-card-title' })).toBeTruthy();
    rerender(<FacilityOperations activeSub="units" onSubChange={() => {}} />);
    expect(screen.getByText('Off-Market Units')).toBeTruthy();
    rerender(<FacilityOperations activeSub="worklist" onSubChange={() => {}} />);
    expect(screen.getAllByText('Sweep aisle B').length).toBe(2);          // one per facility
    expect(getFacilityOps).toHaveBeenCalledTimes(1);
  });

  it('narrows to one facility, and an old bookmarked tab lands on Overview', async () => {
    render(<FacilityOperations activeSub="reputation" onSubChange={() => {}} />);
    await screen.findByText('Facility Scorecard');
    fireEvent.click(screen.getAllByRole('button', { name: 'Murrieta' })[0]);   // the picker pill
    expect(screen.getByText('90.0%')).toBeTruthy();                       // 45 of 50
    expect(screen.queryByText('Facility Scorecard')).toBeNull();          // nothing to compare against
  });

  it('jumps from a flagged item to its tab and facility', async () => {
    const onSubChange = vi.fn();
    render(<FacilityOperations activeSub="overview" onSubChange={onSubChange} />);
    fireEvent.click((await screen.findAllByText('1 unit needs an overlock'))[0]);
    expect(onSubChange).toHaveBeenCalledWith('worklist');
  });

  it('opens the list behind a KPI, on another tab when that is where it lives', async () => {
    const onSubChange = vi.fn();
    render(<FacilityOperations activeSub="overview" onSubChange={onSubChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Past Due, .*Show tenants past due$/ }));
    expect(onSubChange).toHaveBeenCalledWith('collections');
  });

  it('narrows the past-due table from a KPI, and clears it again', async () => {
    render(<FacilityOperations activeSub="collections" onSubChange={() => {}} />);
    const table = () => document.getElementById('ops-past-due');
    await screen.findByText('Tenants Past Due', { selector: '.dash-card-title' });
    expect(table().querySelectorAll('tbody tr')).toHaveLength(2);          // one per facility
    fireEvent.click(screen.getByRole('button', { name: /^On Autopay|Older Than 30 Days, / }));
    expect(screen.getByText(/Older Than 30 Days - 2 of 2/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Older Than 30 Days - 2 of 2/));
    expect(screen.queryByText(/Older Than 30 Days - /)).toBeNull();
  });

  it('makes a tenant name the way into Cubby', async () => {
    render(<FacilityOperations activeSub="collections" onSubChange={() => {}} />);
    const links = await screen.findAllByRole('link', { name: 'Pat Example' });
    expect(links[0].getAttribute('href')).toBe('https://app.cubbystorage.com/tenants/cust_1');
  });

  it('re-counts activity when the period changes, and leaves balances alone', async () => {
    render(<FacilityOperations activeSub="collections" onSubChange={() => {}} />);
    await screen.findByText('Tenants Past Due', { selector: '.dash-card-title' });
    const kpi = (name) => screen.getByRole('button', { name: new RegExp(`^${name}, `) }).querySelector('.kpi-value').textContent;
    expect(kpi('Collected')).toBe('$6,000');             // this month: $3,000 at each of two facilities
    expect(kpi('Failed Payments')).toBe('2');
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'last-month' } });
    expect(kpi('Collected')).toBe('$10.0K');
    expect(kpi('Failed Payments')).toBe('4');
    expect(kpi('Past Due')).toBe('$1,800');              // a balance is as of today whatever the period
  });

  it('pages a long list instead of growing the page, and finds a row by typing', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ unit: `D${String(i).padStart(2, '0')}`, type: 'Drive-Up', reason: 'OTHER', note: '', street: 20000 }));
    getFacilityOps.mockResolvedValue({ ...PAYLOAD, facilities: [facility('fac_a', 'Temecula', { offMarket: many })] });
    render(<FacilityOperations activeSub="units" onSubChange={() => {}} />);
    await screen.findByText('Off-Market Units');
    const card = () => document.getElementById('ops-off-market');
    expect(card().querySelectorAll('tbody tr')).toHaveLength(6);
    expect(card().textContent).toContain('1-6 of 30');
    fireEvent.click(screen.getByRole('button', { name: 'Next units' }));
    expect(card().textContent).toContain('7-12 of 30');
    expect(card().querySelectorAll('tbody tr')).toHaveLength(6);
    fireEvent.change(screen.getByLabelText('Search units'), { target: { value: 'd27' } });
    expect(card().querySelectorAll('tbody tr')).toHaveLength(1);
    expect(card().textContent).toContain('1-1 of 1 (30 in all)');
  });

  it('finds a unit from the lookup box', async () => {
    facilityOpsLookup.mockResolvedValue({ results: [{ facility: 'Temecula', facilityId: 'fac_a', unit: 'B211', type: "10' x 20'", status: 'rented',
      street: 20000, tenant: 'Pat Example', rent: 18000, balance: 14450, paidThrough: '2026-09-30', moveIn: '2025-01-15', autoPay: false, overlocked: true, url: 'https://app.cubbystorage.com/tenants/cust_1' }] });
    render(<FacilityOperations activeSub="overview" onSubChange={() => {}} />);
    await screen.findByText('Facility Scorecard');
    fireEvent.change(screen.getByLabelText('Find a unit or tenant across every facility'), { target: { value: 'b211' } });
    expect(await screen.findByText('$144.50')).toBeTruthy();
    expect(screen.getByText('09/30/2026')).toBeTruthy();
    expect(facilityOpsLookup).toHaveBeenCalledWith('b211');
  });

  it('exports a list from the screen and a report from Cubby', async () => {
    facilityOpsReport.mockResolvedValue({ title: 'Rent Roll', asOf: '2026-10-13', columns: ['Unit'], rows: [['A12']] });
    render(<FacilityOperations activeSub="reports" onSubChange={() => {}} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Quick Exports' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Download Tenants Past Due as a spreadsheet' }));
    expect(downloadCsv.mock.calls[0][0]).toBe('Tenants Past Due - All Facilities - 10-13-2026.csv');
    expect(downloadCsv.mock.calls[0][2]).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Download Rent Roll as a spreadsheet' }));
    await waitFor(() => expect(downloadCsv).toHaveBeenCalledTimes(2));
    expect(facilityOpsReport).toHaveBeenCalledWith('rent-roll', '');
    expect(downloadCsv.mock.calls[1].slice(1)).toEqual([['Unit'], [['A12']]]);
  });

  it('compares one facility against its market, and asks for one when all are chosen', async () => {
    const row = { name: "10' x 20' Drive-Up", width: 10, depth: 20, parking: false, total: 100, rented: 70, vacant: 30, street: 20000, averageRent: 19000,
      competitors: 2, marketLow: 21000, marketMedian: 22000, marketHigh: 23000, lowestBy: 'StorQuest', newestObservation: '2026-10-01',
      suggested: 20500, why: '70% occupied: some vacancy, so sit just under the market to fill it.', change: 500, monthlyImpact: 15000 };
    getOpsMarket.mockResolvedValue({ facilityId: 'fac_a', facility: 'Temecula', asOf: '2026-10-13', freshDays: 120, minCompetitors: 2, rows: [row],
      competitors: [{ id: 'c1', name: 'StorQuest', distanceMiles: 1.2, rates: [{ observedOn: '2026-10-01' }] }] });
    render(<FacilityOperations activeSub="market" onSubChange={() => {}} />);
    expect(await screen.findByText('Choose a Facility')).toBeTruthy();
    expect(getOpsMarket).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Temecula' })[0]);
    expect(await screen.findByText('9% Below')).toBeTruthy();                 // $200 against a $220 median
    expect(screen.getByText('$205')).toBeTruthy();
    expect(getOpsMarket).toHaveBeenCalledWith('fac_a');
    expect(screen.queryByLabelText('Period')).toBeNull();                     // a period does not apply here
  });

  it('shows rate moves, nearby facilities to add, and how each competitor was last read', async () => {
    const competitor = { id: 'c1', name: 'Example Storage', distanceMiles: 1.2, website: 'https://www.example.com', ratesUrl: 'https://www.example.com/units',
      watch: true, lastCheckedAt: '2026-10-13T16:05:00', lastStatus: 'ok', lastDetail: 'Read 6 rates',
      rates: [{ id: 'r1', width: 10, depth: 10, parking: false, rate: 14500, promo: '', observedOn: '2026-10-13', source: 'web' }] };
    const market = { facilityId: 'fac_a', facility: 'Temecula', asOf: '2026-10-13', freshDays: 120, minCompetitors: 2, rows: [],
      engine: { connected: true, everyHours: 24 }, competitors: [competitor],
      moves: [{ competitorId: 'c1', competitor: 'Example Storage', width: 10, depth: 10, parking: false, oldRate: 12900, newRate: 14500,
        percent: 12.4, date: '2026-10-13', promo: '', source: 'web' }] };
    const blocked = { ...competitor, id: 'c2', name: 'Sample Self Storage', lastStatus: 'blocked_by_robots', rates: [],
      lastDetail: "The site's robots rules do not allow automated readers on this page", lastCheckedAt: '2026-10-13T16:10:00' };
    getOpsMarket.mockResolvedValue(market);
    getOpsNearby.mockResolvedValue({ ...NO_NEARBY, facilities: [
      { osmId: 'way/2', name: 'Sample Self Storage', address: '100 Main St, Sampletown, CA 90000', website: 'https://sample.example.org', lat: 33.505, lng: -117.15, distanceMiles: 0.3 }] });
    addOpsCompetitor.mockResolvedValue({ ...market, competitors: [competitor, blocked] });
    checkOpsCompetitor.mockResolvedValue({ ...market, competitors: [{ ...competitor, lastDetail: 'Read 7 rates' }, blocked] });
    render(<FacilityOperations activeSub="market" onSubChange={() => {}} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Temecula' }))[0]);

    // The move: $129 to $145, up 12.4%, seen 10/13.
    const moves = (await screen.findByText('Rate Moves')).closest('.dash-card');
    expect(moves.textContent).toContain('10% or more in the last 30 days');
    expect([...moves.querySelectorAll('tbody td')].map((td) => td.textContent))
      .toEqual(['Example Storage', '10 x 10', '$129', '$145', '+12.4%', '10/13/2026', 'Read From Website']);
    expect(screen.getByText(/read once a day by an identified reader that follows the site's robots rules/)).toBeTruthy();

    // The competitor: where its rates are read from and how the last read went.
    const row = screen.getByRole('link', { name: 'www.example.com/units' }).closest('li');
    expect(row.textContent).toContain('Rates Read Read 6 rates. Checked 10/13/2026, 4:05 PM.');
    expect(row.textContent).toContain('Latest: 10 x 10 at $145 - Read From Website');
    expect(row.querySelector('input[type="checkbox"]').checked).toBe(true);

    // Nearby, with the OpenStreetMap credit, and Add sends what OpenStreetMap knew.
    expect(await screen.findByText('Nearby facilities from OpenStreetMap contributors')).toBeTruthy();
    expect(getOpsNearby).toHaveBeenCalledWith('fac_a');
    expect(screen.getByText('0.3 miles away - 100 Main St, Sampletown, CA 90000')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Sample Self Storage' }));
    expect(addOpsCompetitor).toHaveBeenCalledWith({ facility_id: 'fac_a', name: 'Sample Self Storage', address: '100 Main St, Sampletown, CA 90000',
      website: 'https://sample.example.org', distance_miles: 0.3, lat: 33.505, lng: -117.15, osm_id: 'way/2' });
    expect(await screen.findByText('Blocked by Robots Rules')).toBeTruthy();
    expect(screen.getByText('No other storage facilities found within 5 miles.')).toBeTruthy();   // it left the nearby list

    fireEvent.click(screen.getAllByRole('button', { name: /Check Now/ })[0]);
    expect(await screen.findByText(/Read 7 rates\./)).toBeTruthy();
    expect(checkOpsCompetitor).toHaveBeenCalledWith('c1');
  });

  it('keeps the Market tab standing when the nearby list cannot be loaded', async () => {
    getOpsMarket.mockResolvedValue({ facilityId: 'fac_a', facility: 'Temecula', asOf: '2026-10-13', freshDays: 120, minCompetitors: 2, rows: [],
      competitors: [], moves: [], engine: { connected: false, everyHours: 24 } });
    getOpsNearby.mockRejectedValue(Object.assign(new Error('boom'), { status: 424 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<FacilityOperations activeSub="market" onSubChange={() => {}} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Temecula' }))[0]);
    expect(await screen.findByText(/The nearby list could not be loaded just now/)).toBeTruthy();
    expect(screen.getByText('Our Rates Against the Market')).toBeTruthy();
    expect(screen.queryByText('Rate Moves')).toBeNull();
    expect(screen.getByText(/The automatic reader is not connected on this server yet/)).toBeTruthy();
  });

  it('shows a message, not a blank screen, when Cubby cannot be read', async () => {
    getFacilityOps.mockRejectedValue(Object.assign(new Error('boom'), { status: 424 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<FacilityOperations activeSub="overview" onSubChange={() => {}} />);
    await waitFor(() => expect(screen.getByText("Couldn't load the facility figures from Cubby.")).toBeTruthy());
    expect(screen.queryByText('boom')).toBeNull();
  });
});

describe('Cubby sync indicator', () => {
  const NOW = Date.parse('2026-10-15T17:42:00Z');

  it('says when the figures were synced, with no warning while current', () => {
    render(<SyncStatus data={{ syncedAt: '2026-10-15T17:30:00Z', syncStatus: 'ok' }} now={NOW} />);
    expect(screen.getByTestId('ops-sync').textContent).toMatch(/^Synced \d{1,2}:\d{2} (AM|PM)$/);
    expect(screen.queryByText('Cubby Sync Delayed')).toBeNull();
  });

  it('warns when the last sync failed, only partly finished, or is over 45 minutes old', () => {
    expect(syncDelayed({ syncedAt: '2026-10-15T17:30:00Z', syncStatus: 'failed' }, NOW)).toBe(true);
    expect(syncDelayed({ syncedAt: '2026-10-15T17:30:00Z', syncStatus: 'partial' }, NOW)).toBe(true);
    expect(syncDelayed({ syncedAt: '2026-10-15T16:50:00Z', syncStatus: 'ok' }, NOW)).toBe(true);
    expect(syncDelayed({ syncedAt: '2026-10-15T17:00:00Z', syncStatus: 'ok' }, NOW)).toBe(false);
    expect(syncDelayed({ syncedAt: '', syncStatus: 'live' }, NOW)).toBe(false);
    render(<SyncStatus data={{ syncedAt: '2026-10-14T17:30:00Z', syncStatus: 'failed' }} now={NOW} />);
    expect(screen.getByText('Cubby Sync Delayed')).toBeTruthy();
    expect(screen.getByTestId('ops-sync').textContent).toMatch(/^Synced \d{2}\/\d{2}\/2026, /);   // another day shows the date
  });

  it('shows the indicator on the screen, and Refresh syncs then re-reads', async () => {
    getFacilityOps.mockResolvedValue({ ...PAYLOAD, syncedAt: '2026-10-15T08:00:00Z', syncStatus: 'partial' });
    startCubbySync.mockReset().mockResolvedValue({ started: true, runId: 'r1' });
    getCubbySync.mockReset().mockResolvedValue({ running: false, last: { status: 'ok' } });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<FacilityOperations activeSub="overview" onSubChange={() => {}} />);
      expect(await screen.findByText('Cubby Sync Delayed')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
      expect(await screen.findByText('Syncing…')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3500);
      await waitFor(() => expect(getFacilityOps).toHaveBeenLastCalledWith(true));
      expect(startCubbySync).toHaveBeenCalledTimes(1);
      expect(getCubbySync).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a sync someone else started instead of failing', async () => {
    startCubbySync.mockReset().mockRejectedValue(Object.assign(new Error('A Cubby sync is already running.'), { status: 409 }));
    getCubbySync.mockReset().mockResolvedValue({ running: false, last: { status: 'ok' } });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<FacilityOperations activeSub="overview" onSubChange={() => {}} />);
      await screen.findByText('Facility Scorecard');
      fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
      await vi.advanceTimersByTimeAsync(3500);
      await waitFor(() => expect(getFacilityOps).toHaveBeenLastCalledWith(true));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('No Cubby key on the server', () => {
  const KEY_HINT = /An administrator needs to set CUBBY_API_KEY/;

  it('says Cubby is not connected instead of a blank screen when nothing was ever synced', async () => {
    getFacilityOps.mockResolvedValue({ organization: '', fetchedAt: '', facilities: [], trend: [], syncedAt: '',
      syncStatus: 'not_configured', syncRunning: false, cubbyConfigured: false });
    render(<FacilityOperations activeSub="overview" onSubChange={() => {}} />);
    expect(await screen.findByText("Cubby is not connected on this server yet. An administrator needs to set CUBBY_API_KEY in the API's app settings.")).toBeTruthy();
  });

  it('still shows the synced figures with the delayed chip, and the key hint to managers only', async () => {
    getFacilityOps.mockResolvedValue({ ...PAYLOAD, cubbyConfigured: false });
    isManager = false;
    const { unmount } = render(<FacilityOperations activeSub="overview" onSubChange={() => {}} />);
    expect(await screen.findByText('Facility Scorecard')).toBeTruthy();
    expect(screen.getByText('Cubby Sync Delayed')).toBeTruthy();
    expect(screen.queryByText(KEY_HINT)).toBeNull();
    unmount();
    isManager = true;
    try {
      render(<FacilityOperations activeSub="overview" onSubChange={() => {}} />);
      expect(await screen.findByText(KEY_HINT)).toBeTruthy();
      expect(screen.getByText('Cubby Sync Delayed')).toBeTruthy();
    } finally {
      isManager = false;
    }
  });
});

describe('Operations figures', () => {
  it('adds facilities into one block and merges the monthly series', () => {
    const all = combine(PAYLOAD.facilities);
    expect(all.units).toEqual({ total: 150, rented: 115, vacant: 25, unavailable: 10 });
    expect(all.pastDue.total).toBe(180000);
    expect(all.history.map((h) => h.rented)).toEqual([136, 140]);
    expect(all.unitTypes).toHaveLength(1);
    expect(all.unitTypes[0].vacant).toBe(40);
    expect(combine([]).units.total).toBe(0);
  });

  it('flags a facility with many units off the market', () => {
    const items = attentionItems([facility('fac_c', 'Valley Center', { units: { total: 100, rented: 60, vacant: 10, unavailable: 30 } })]);
    expect(items.map((i) => [i.tab, i.text])).toContainEqual(['units', '30 of 100 units are off the market (30%)']);
    expect(items[0].tab).toBe('collections');                              // money owed leads the list
  });

  it('turns a period into dates counted from the facility day', () => {
    expect(periodRange('this-month', '2026-10-13')).toMatchObject({ from: '2026-10-01', to: '2026-10-13' });
    expect(periodRange('last-month', '2026-10-13')).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(periodRange('last-30', '2026-10-13')).toMatchObject({ from: '2026-09-14', to: '2026-10-13' });
    expect(periodRange('this-year', '2026-10-13')).toMatchObject({ from: '2026-01-01', to: '2026-10-13' });
    expect(periodRange('last-12', '2026-10-13')).toMatchObject({ from: '2025-10-14', to: '2026-10-13' });
  });

  it('counts only what happened inside the period', () => {
    const all = combine(PAYLOAD.facilities);
    expect(periodStats(all, periodRange('this-month', '2026-10-13'))).toMatchObject({ moveIns: 6, moveOuts: 2, collected: 600000, failed: 2 });
    expect(periodStats(all, periodRange('last-month', '2026-10-13'))).toMatchObject({ moveIns: 8, moveOuts: 4, collected: 1000000, failed: 4 });
  });

  it('never draws a trend of fewer than six months, and switches long periods to monthly bars', () => {
    const history = Array.from({ length: 36 }, (_, i) => ({ month: `${2023 + Math.floor((i + 10) / 12)}-${String(((i + 10) % 12) + 1).padStart(2, '0')}`, rented: i, moveIns: 0, moveOuts: 0 }));
    expect(history[35].month).toBe('2026-10');
    expect(historyWindow(history, periodRange('this-month', '2026-10-13'))).toHaveLength(6);
    expect(historyWindow(history, periodRange('last-12', '2026-10-13'))).toHaveLength(13);
    expect(historyWindow(history, periodRange('last-month', '2026-10-13')).at(-1).month).toBe('2026-09');
    const daily = Array.from({ length: 200 }, (_, i) => { const d = new Date(2026, 9, 13 - i); return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, collected: 100, failed: 0 }; }).reverse();
    expect(collectionSeries(daily, periodRange('last-30', '2026-10-13'))).toHaveLength(30);
    const yearly = collectionSeries(daily, periodRange('this-year', '2026-10-13'));
    expect(yearly.at(-1)).toMatchObject({ date: '2026-10', collected: 1300 });
  });

  it('writes a csv a spreadsheet opens safely', () => {
    expect(toCsv(['Unit', 'Tenant', 'Gap'], [['A1', 'Smith, Pat', '-20.00'], ['A2', '=HYPERLINK("x")', '5']]))
      .toBe('Unit,Tenant,Gap\r\nA1,"Smith, Pat",-20.00\r\nA2,"\'=HYPERLINK(""x"")",5');
    expect(csvName('Rent Roll', 'Temecula', '2026-10-13')).toBe('Rent Roll - Temecula - 10-13-2026.csv');
  });

  it('only draws a trend day once every chosen facility has a row for it', () => {
    const trend = [
      { date: '2026-10-12', facilityId: 'fac_a', pastDue: 100 }, { date: '2026-10-12', facilityId: 'fac_b', pastDue: 50 },
      { date: '2026-10-13', facilityId: 'fac_a', pastDue: 120 },
    ];
    expect(pastDueTrend(trend, ['fac_a', 'fac_b'])).toEqual([{ date: '2026-10-12', pastDue: 150, seen: 2 }]);
    expect(pastDueTrend(trend, ['fac_a'])).toHaveLength(2);
  });
});
