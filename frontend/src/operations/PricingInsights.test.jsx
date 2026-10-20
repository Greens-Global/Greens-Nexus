import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Pricing Insights (Visesh, Oct 20 2026): renders the ranked insights with
// Kind / Severity dropdowns (never chips), the Overview for every facility,
// and one facility's sections picked from a Section dropdown. With no
// competitor rates it says StorTrack is not connected instead of guessing.

const apiMock = vi.hoisted(() => ({ getOpsInsights: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));

import PricingInsights from './PricingInsights';

const insight = (over) => ({
  id: 'market-position:fac_e:g1', facilityId: 'fac_e', facility: 'Escondido', kind: 'market-position', kindLabel: 'Market Position',
  severity: 'high', title: '10x10 CC Below Market at 95% Full',
  detail: "10x10 CC (10' x 10') at Escondido is 13% below the market median ($199 vs $230, 3 competitors) while 95% full: room to raise.",
  metrics: {}, action: 'Review the street rate in Rate Management.', link: { tab: 'pricing', section: 'standard', facilityId: 'fac_e', filters: { group: 'g1' } },
  impact: 3100, ...over,
});
const group = (over) => ({
  groupId: 'g1', name: "10' x 10'", label: '10x10 CC', kind: 'storage', area: 100, lastChangedAt: '', trackedSince: '2026-10-20T00:00:00+00:00',
  standard: 19900, web: 19400, walkIn: 19900, strike: null, perSqFt: 199, marketMedian: 23000, competitors: 3, suggested: 21900,
  target: 23700, targetGap: 0.19, why: '', discounts: [{ name: '5% Teacher', band: '5% off', visibility: 'ALL' }], vacant: 1,
  net30: 2, ins30: 3, outs30: 1, occupancy: 0.95, flags: ['move-in-spike'], ...over,
});
const COLS = [{ key: 'S:10x10:cc', label: '10x10 CC', competitors: 2, median: 23000 }];
const bundle = (hasMarket = true) => ({
  facilityId: 'fac_e', facility: 'Escondido', asOf: '2026-10-20',
  standardRates: [group(), group({ groupId: 'g2', name: "5' x 5'", label: '5x5 NCC', flags: [] })],
  competitive: {
    hasMarket, columns: hasMarket ? COLS : [{ ...COLS[0], competitors: 0, median: null }],
    rows: [
      { kind: 'ours', facilityId: 'fac_e', name: 'Escondido', address: '', main: true, cells: { 'S:10x10:cc': { rate: 19900, vsMarket: -0.13 } } },
      ...(hasMarket ? [{ kind: 'competitor', id: 'c1', name: 'Extra Space', address: '1 A St', distanceMiles: 1.2,
        cells: { 'S:10x10:cc': { rate: 22000, observedOn: '2026-10-18', source: 'stortrack' } } }] : []),
    ],
  },
  trends: { my: { 'S:10x10:cc': 19900 }, competitors: { 'S:10x10:cc': hasMarket ? 22500 : null },
    myChange: { 1: {}, 7: {}, 30: {} }, competitorChange: { 1: { 'S:10x10:cc': 0 }, 7: { 'S:10x10:cc': -0.05 }, 30: {} } },
  ecri: { candidates: [{ unit: 'A1', tenant: 'Pat Tenant', unitType: '10x10', rent: 15000, street: 19900, gap: 4900, gapPct: 24.6,
    monthsStayed: 28, monthsSinceIncrease: null, lastIncrease: '', url: '' }], candidateCount: 1, upside: 4900,
  scheduled: [], scheduledLift: 0, early: 0, survival: [] },
  risk: { vacancy: [], vacancyLoss: 0, pastDue: { total: 0, tenants: 0, rentRoll: 300000, top: [], top5Share: null } },
  insights: [],
});
const payload = (over = {}) => ({
  generatedAt: '2026-10-20T12:00:00Z', syncedAt: '2026-10-20T11:45:00Z', pricingSyncedAt: '2026-10-20T11:45:00Z',
  market: { connected: true, stortrack: { connected: false } }, notices: [],
  kinds: [{ key: 'market-position', label: 'Market Position' }, { key: 'ecri', label: 'ECRI' }],
  discounts: [{ id: 'd1', name: '5% Teacher', band: '5% off', type: 'PERPETUAL', live: true, facilityIds: ['fac_e'],
    pricingGroups: [{ pricingGroupId: 'g1' }] }],
  overview: { rows: [
    { facilityId: 'fac_e', facility: 'Escondido', units: 884, pricingGroups: 40, tenants: 760, area: 90000, monthlyRent: 15000000,
      occupancy: 0.91, moveInsMonth: 20, moveIns60: 70, moveOuts60: 50, lowOccGroups: 3, zeroMoveInGroups: 5 },
    { facilityId: 'fac_t', facility: 'Temecula', units: 516, pricingGroups: 39, tenants: 318, area: 50000, monthlyRent: 6000000,
      occupancy: 0.69, moveInsMonth: 10, moveIns60: 30, moveOuts60: 20, lowOccGroups: 8, zeroMoveInGroups: 9 }],
  totals: { facility: 'Total', units: 1400, pricingGroups: 79, tenants: 1078, area: 140000, monthlyRent: 21000000, occupancy: 0.82,
    moveInsMonth: 30, moveIns60: 100, moveOuts60: 70, lowOccGroups: 11, zeroMoveInGroups: 14 } },
  insights: [insight(), insight({ id: 'ecri:fac_e:candidates', kind: 'ecri', kindLabel: 'ECRI', severity: 'medium',
    title: '3 Tenants Below Street for 12+ Months', link: { tab: 'revenue', facilityId: 'fac_e' } })],
  facilityId: '', facility: null, facilities: [{ id: 'fac_e', name: 'Escondido' }],
  ...over,
});

beforeEach(() => { apiMock.getOpsInsights.mockReset(); });

describe('Pricing Insights', () => {
  it('renders ranked insights with dropdown filters and the overview for every facility', async () => {
    apiMock.getOpsInsights.mockResolvedValue(payload());
    const onPick = vi.fn();
    render(<PricingInsights facility={null} onPick={onPick} onGo={vi.fn()} />);
    expect(screen.getByTestId('pi-loading')).toBeTruthy();                       // skeleton, never blank
    expect(await screen.findByText('10x10 CC Below Market at 95% Full')).toBeTruthy();
    expect(apiMock.getOpsInsights).toHaveBeenCalledWith('');
    expect(screen.getByLabelText('Kind').tagName).toBe('SELECT');
    expect(screen.getByLabelText('Severity').tagName).toBe('SELECT');
    expect(screen.getByLabelText('Section').tagName).toBe('SELECT');
    expect(screen.queryByRole('tab')).toBeNull();                                 // no pill rows

    fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'medium' } });
    const list = screen.getByTestId('insight-list');
    expect(within(list).queryByText('10x10 CC Below Market at 95% Full')).toBeNull();
    expect(within(list).getByText('3 Tenants Below Street for 12+ Months')).toBeTruthy();

    const ov = screen.getByTestId('pi-overview');
    expect(within(ov).getByText('Total')).toBeTruthy();
    expect(within(ov).getByText('1,400')).toBeTruthy();
    fireEvent.click(within(ov).getByText('Temecula'));
    expect(onPick).toHaveBeenCalledWith('fac_t');

    fireEvent.change(screen.getByLabelText('Section'), { target: { value: 'standard' } });
    expect(screen.getByText(/Pick a facility above to see Standard Rates/)).toBeTruthy();
  });

  it("shows one facility's sections and opens an insight where it points", async () => {
    apiMock.getOpsInsights.mockResolvedValue(payload({ facilityId: 'fac_e', facility: bundle() }));
    const onGo = vi.fn();
    render(<PricingInsights facility={{ id: 'fac_e', shortName: 'Escondido' }} onPick={vi.fn()} onGo={onGo} />);
    await screen.findByText('10x10 CC Below Market at 95% Full');
    expect(apiMock.getOpsInsights).toHaveBeenCalledWith('fac_e');

    fireEvent.click(screen.getByRole('button', { name: 'Open: 10x10 CC Below Market at 95% Full' }));
    const table = screen.getByTestId('pi-standard');
    expect(within(table).getAllByText('$199').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('5% Teacher').length).toBe(2);
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'move-in-spike' } });
    expect(within(screen.getByTestId('pi-standard')).queryByText("5' x 5'")).toBeNull();

    fireEvent.change(screen.getByLabelText('Section'), { target: { value: 'competitive' } });
    const grid = screen.getByTestId('pi-competitive');
    expect(within(grid).getByText('Extra Space')).toBeTruthy();
    expect(within(grid).getByText('$220')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Section'), { target: { value: 'trends' } });
    expect(within(screen.getByTestId('pi-trends')).getByText('-5.00%')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Section'), { target: { value: 'ecri' } });
    expect(within(screen.getByTestId('pi-ecri')).getByText('Pat Tenant')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open: 3 Tenants Below Street for 12+ Months' }));
    expect(onGo).toHaveBeenCalledWith('revenue');
  });

  it('says StorTrack is not connected when there are no competitor rates', async () => {
    apiMock.getOpsInsights.mockResolvedValue(payload({
      facilityId: 'fac_e', facility: bundle(false), insights: [], market: { connected: false, stortrack: { connected: false } },
      notices: ['Connect StorTrack to compare with the market'],
    }));
    render(<PricingInsights facility={{ id: 'fac_e', shortName: 'Escondido' }} onPick={vi.fn()} onGo={vi.fn()} />);
    expect(await screen.findByText(/StorTrack not connected yet, so market position/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Section'), { target: { value: 'competitive' } });
    expect(screen.getByText(/StorTrack not connected yet\. Connect StorTrack/)).toBeTruthy();
  });

  it('shows an error with Retry instead of a blank screen', async () => {
    apiMock.getOpsInsights.mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PricingInsights facility={null} onPick={vi.fn()} onGo={vi.fn()} />);
    expect(await screen.findByText("Couldn't load the pricing insights.")).toBeTruthy();
  });
});
