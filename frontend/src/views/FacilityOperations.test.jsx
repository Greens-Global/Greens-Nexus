import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { combine, attentionItems, pastDueTrend, periodRange, periodStats, historyWindow, collectionSeries } from '../operations/model';

// Operations (storage facilities, Oct 2026): the screen reads Cubby through one
// endpoint. These are the render-smoke tests - every tab draws from the same
// payload without crashing, with one facility or several, and a failed read
// shows a message instead of a blank screen.

const getFacilityOps = vi.fn();
vi.mock('../api', () => ({ api: { getFacilityOps: (...a) => getFacilityOps(...a) } }));
vi.mock('../components/ModuleTabs', () => ({
  default: ({ tabs, active, onChange }) => (
    <div role="tablist">{tabs.map((t) => <button key={t.key} role="tab" aria-selected={t.key === active} onClick={() => onChange(t.key)}>{t.label}</button>)}</div>
  ),
}));

const FacilityOperations = (await import('./FacilityOperations')).default;

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
  facilities: [facility('fac_a', 'Temecula'), facility('fac_b', 'Murrieta', { units: { total: 50, rented: 45, vacant: 5, unavailable: 0 } })],
};

beforeEach(() => { getFacilityOps.mockReset().mockResolvedValue(PAYLOAD); });

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

  it('shows a message, not a blank screen, when Cubby cannot be read', async () => {
    getFacilityOps.mockRejectedValue(Object.assign(new Error('boom'), { status: 424 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<FacilityOperations activeSub="overview" onSubChange={() => {}} />);
    await waitFor(() => expect(screen.getByText("Couldn't load the facility figures from Cubby.")).toBeTruthy());
    expect(screen.queryByText('boom')).toBeNull();
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

  it('only draws a trend day once every chosen facility has a row for it', () => {
    const trend = [
      { date: '2026-10-12', facilityId: 'fac_a', pastDue: 100 }, { date: '2026-10-12', facilityId: 'fac_b', pastDue: 50 },
      { date: '2026-10-13', facilityId: 'fac_a', pastDue: 120 },
    ];
    expect(pastDueTrend(trend, ['fac_a', 'fac_b'])).toEqual([{ date: '2026-10-12', pastDue: 150, seen: 2 }]);
    expect(pastDueTrend(trend, ['fac_a'])).toHaveLength(2);
  });
});
