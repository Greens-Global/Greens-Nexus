import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render smoke for Operations > Customer Map (trade area analysis, Oct 22
// 2026): Leaflet and the drawing module are mocked; the screen must draw the
// statistics beside the map, switch views, follow Color By in the legend,
// refetch with the filters (stats change with them) and fit the trade area.
const fitBounds = vi.fn();
vi.mock('leaflet', () => {
  const chain = () => {
    const o = { addTo: () => o, bindTooltip: () => o, on: () => o, off: () => o, clearLayers: () => {}, setView: () => o,
      fitBounds: (...a) => { fitBounds(...a); return o; }, invalidateSize: () => {}, remove: () => {}, getZoom: () => 11 };
    return o;
  };
  const L = { map: chain, tileLayer: chain, layerGroup: chain, circleMarker: chain, marker: chain, circle: chain, polygon: chain, divIcon: () => ({}) };
  return { default: L };
});
vi.mock('leaflet/dist/leaflet.css', () => ({}));

const heatSet = vi.fn();
const drawn = { dots: vi.fn(), hexes: vi.fn(() => [{ min: 1, max: 4, color: '#93c5fd' }, { min: 5, max: 9, color: '#1d4ed8' }]), facs: vi.fn(), comps: vi.fn() };
vi.mock('./customerMapLayers', () => ({
  createHeat: () => ({ set: (...a) => heatSet(...a), destroy: () => {} }),
  drawDots: (...a) => drawn.dots(...a),
  drawHexes: (...a) => drawn.hexes(...a),
  drawFacilities: (...a) => drawn.facs(...a),
  drawCompetitors: (...a) => drawn.comps(...a),
}));

const getOpsCustomerMap = vi.fn();
vi.mock('../api', () => ({ api: { getOpsCustomerMap: (...a) => getOpsCustomerMap(...a) } }));

const CustomerMap = (await import('./CustomerMap')).default;

const COLS = ['lat', 'lng', 'facility', 'zip', 'kind', 'tenure', 'band', 'count', 'rent', 'miles', 'closer'];
const BUCKETS = [[0, 1, 300], [1, 2, 400], [2, 3, 300], [3, 5, 400], [5, 10, 300], [10, 50, 80], [50, null, 6]]
  .map(([min, max, count]) => ({ min, max, count }));
const RINGS = [{ miles: 1, count: 300 }, { miles: 2, count: 700 }, { miles: 3, count: 1000 }, { miles: 5, count: 1400 },
  { miles: 10, count: 1700 }, { miles: 50, count: 1780 }];
const STATS = {
  radii: { 50: 2.4, 80: 5.6, 90: 8.9 }, median: 2.4, mean: 4.1, buckets: BUCKETS, rings: RINGS, beyond: 6, placed: 1786,
  customers: 1786, outside50: { count: 6, regions: [{ state: 'CA', count: 4 }, { state: 'Other', count: 2 }] },
  overlap: 12, competitorsWithin: { 3: 2, 5: 5, 10: 9 },
};
const MAP = {
  facilities: [{ id: 'fac_a', name: 'Greens Storage Temecula', shortName: 'Temecula', lat: 33.5, lng: -117.15, state: 'CA' }],
  greens: [{ id: 'fac_b', shortName: 'Escondido', lat: 33.12, lng: -117.08 }, { id: 'fac_a', shortName: 'Temecula', lat: 33.5, lng: -117.15 }],
  pointCols: COLS,
  points: [[33.51, -117.15, 1, 0, 0, 0, 1, 3, 450, 0.7, null], [33.6, -117.2, 1, 1, 1, 3, 3, 1, 380, 7.4, 0],
    [40.7, -74.0, 1, 0, 0, 2, 0, 1, 90, 2400, null]],
  kinds: ['storage', 'vehicle'], tenures: ['under90d', 'under1y', '1to3y', 'over3y', 'unknown'],
  rentBands: [{ band: 0, min: 20, max: 80 }, { band: 1, min: 80, max: 120 }, { band: 2, min: 120, max: 200 }, { band: 3, min: 200, max: 900 }],
  filters: { kind: 'all', since: 'all', band: 'all' },
  coverage: { fac_a: { current: 3345, placed: 1786, zipOnly: 120, missing: 1559, pending: 0 } },
  total: { current: 3345, placed: 1786, zipOnly: 120, missing: 1559, pending: 0 },
  stats: STATS,
  byFacility: { fac_a: { ...STATS, vehiclePct: 12.5, closer: [{ facilityId: 'fac_b', shortName: 'Escondido', count: 12 }], competitorsWithin: { 3: 2, 5: 5, 10: 9 } } },
  competitors: [{ name: 'Public Storage', lat: 33.52, lng: -117.15, miles: 1.4 }],
};

describe('CustomerMap', () => {
  beforeEach(() => {
    getOpsCustomerMap.mockReset().mockResolvedValue(MAP);
    fitBounds.mockReset(); heatSet.mockReset();
    Object.values(drawn).forEach((f) => f.mockClear());
    localStorage.removeItem('nexus.ops.customerMap.rings');
    localStorage.removeItem('nexus.ops.customerMap.prefs');
  });

  it('shows the trade area statistics, the distance chart and the coverage note', async () => {
    render(<CustomerMap facility={{ id: 'fac_a', shortName: 'Temecula' }} state="CA" />);
    expect(await screen.findByText('Trade Area Statistics')).toBeTruthy();
    expect(getOpsCustomerMap).toHaveBeenCalledWith({ facility: 'fac_a', state: 'CA', kind: 'all', since: 'all', band: 'all' });
    expect(screen.getByText(/of customers live within/).textContent).toBe('80% of customers live within 5.6 miles');
    expect(screen.getByText('50% Within').nextSibling.textContent).toBe('2.4 miles');
    expect(screen.getByText('90% Within').nextSibling.textContent).toBe('8.9 miles');
    const chart = screen.getByRole('table', { name: 'Distance Distribution' });
    const rows = within(chart).getAllByRole('row').map((r) => r.textContent);
    expect(rows).toEqual(['0-1 mi30017%', '1-2 mi40022%', '2-3 mi30017%', '3-5 mi40022%', '5-10 mi30017%', '10-50 mi804%', '50+ mi60%']);
    expect(screen.getByText('Outside 50 Miles')).toBeTruthy();
    expect(screen.getByText('California').nextSibling.textContent).toBe('4');
    expect(screen.getByText('Other Areas')).toBeTruthy();
    const comps = screen.getByText('Competitors Within').closest('.cm-stat-card');
    expect(within(comps).getByText('5 Miles').nextSibling.textContent).toBe('5');
    expect(screen.getByText('12 customers live closer to Escondido')).toBeTruthy();
    expect(screen.getByText(/Showing 1,786 of 3,345 current customers - 1,559 have no usable address in Cubby/)).toBeTruthy();
    expect(screen.getByText(/Nexus stores no customer addresses/)).toBeTruthy();
    // One facility: no comparison table.
    expect(screen.queryByText('Facility Comparison')).toBeNull();
  });

  it('opens on the trade area, not the far-away customer', async () => {
    render(<CustomerMap facility={{ id: 'fac_a', shortName: 'Temecula' }} />);
    await screen.findByText('Trade Area Statistics');
    await waitFor(() => expect(fitBounds).toHaveBeenCalled());
    const [[s, w], [n, e]] = fitBounds.mock.calls[0][0];
    expect(n).toBeLessThan(34);
    expect(e).toBeLessThan(-117);
    expect(s).toBeGreaterThan(33);
    expect(w).toBeGreaterThan(-118);
  });

  it('switches views and follows Color By in the legend, remembering both', async () => {
    render(<CustomerMap facility={null} />);
    const heat = await screen.findByRole('button', { name: 'Heat Map' });
    expect(heat.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(heatSet).toHaveBeenCalled());
    expect(heatSet.mock.calls.at(-1)[0]).toHaveLength(3);
    expect(screen.getByText('Customer Density')).toBeTruthy();
    expect(screen.queryByLabelText('Color By')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Hex Grid' }));
    await waitFor(() => expect(drawn.hexes).toHaveBeenCalled());
    expect(await screen.findByText('Customers per Hexagon')).toBeTruthy();
    expect(screen.getByText('5-9')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Dots' }));
    await waitFor(() => expect(drawn.dots).toHaveBeenCalled());
    expect(drawn.dots.mock.calls.at(-1)[3]).toBe('kind');
    const legend = screen.getByLabelText('Legend');
    expect(within(legend).getByText('Self-Storage')).toBeTruthy();
    expect(within(legend).getByText('Vehicle/RV')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Color By'), { target: { value: 'tenure' } });
    expect(within(legend).getByText('New (Last 90 Days)')).toBeTruthy();
    expect(drawn.dots.mock.calls.at(-1)[3]).toBe('tenure');
    fireEvent.change(screen.getByLabelText('Color By'), { target: { value: 'band' } });
    expect(within(legend).getByText('$200+')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('nexus.ops.customerMap.prefs'))).toMatchObject({ view: 'dots', colorBy: 'band' });
  });

  it('filters refetch and the statistics change with them', async () => {
    render(<CustomerMap facility={null} />);
    await screen.findByText('Trade Area Statistics');
    getOpsCustomerMap.mockResolvedValue({
      ...MAP, points: [MAP.points[1]], filters: { kind: 'vehicle', since: 'all', band: 'all' },
      stats: { ...STATS, customers: 210, radii: { 50: 6.2, 80: 14.0, 90: 22.5 } },
    });
    fireEvent.change(screen.getByLabelText('Unit Kind'), { target: { value: 'vehicle' } });
    expect(getOpsCustomerMap).toHaveBeenLastCalledWith({ facility: 'all', state: '', kind: 'vehicle', since: 'all', band: 'all' });
    await waitFor(() => expect(screen.getByText(/of customers live within/).textContent).toBe('80% of customers live within 14 miles'));
    expect(screen.getByText(/Filters on: 210 match/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Rent Band'), { target: { value: '3' } });
    expect(getOpsCustomerMap).toHaveBeenLastCalledWith({ facility: 'all', state: '', kind: 'vehicle', since: 'all', band: '3' });
    fireEvent.change(screen.getByLabelText('Customers'), { target: { value: '90' } });
    expect(getOpsCustomerMap).toHaveBeenLastCalledWith({ facility: 'all', state: '', kind: 'vehicle', since: '90', band: '3' });
    expect(JSON.parse(localStorage.getItem('nexus.ops.customerMap.prefs'))).toMatchObject({ kind: 'vehicle', since: '90', band: '3' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear Filters' }));
    expect(getOpsCustomerMap).toHaveBeenLastCalledWith({ facility: 'all', state: '', kind: 'all', since: 'all', band: 'all' });
  });

  it('compares facilities when All Facilities is picked', async () => {
    const b = { id: 'fac_b', name: 'Greens Storage Escondido', shortName: 'Escondido', lat: 33.12, lng: -117.08, state: 'CA' };
    getOpsCustomerMap.mockResolvedValue({
      ...MAP, facilities: [b, MAP.facilities[0]],
      byFacility: { ...MAP.byFacility, fac_b: { ...STATS, customers: 400, radii: { 50: 1.1, 80: 2.5, 90: 4 }, median: 1.1, vehiclePct: 40, closer: [], competitorsWithin: { 3: 1, 5: 1, 10: 2 } } },
    });
    render(<CustomerMap facility={null} />);
    const title = await screen.findByText('Facility Comparison');
    const card = title.closest('.cm-compare');
    expect(within(card).getByText(/Temecula draws from 2\.2x as far as Escondido/)).toBeTruthy();
    const rows = within(card).getAllByRole('row').map((r) => r.textContent);
    expect(rows[1]).toBe('Escondido4001.1 miles2.5 miles4.0 miles1.1 miles40%01');
    expect(rows[2]).toBe('Temecula1,7862.4 miles5.6 miles8.9 miles2.4 miles12.5%125');
  });

  it('draws the rings with labels and toggles one; competitors can be hidden', async () => {
    render(<CustomerMap facility={{ id: 'fac_a', shortName: 'Temecula' }} />);
    const chip = await screen.findByRole('button', { name: '2 Miles' });
    await waitFor(() => expect(drawn.facs).toHaveBeenCalled());
    let opts = drawn.facs.mock.calls.at(-1)[1];
    expect(opts.rings).toEqual([1, 3, 5, 10]);
    expect(opts.labelRings).toBe(true);
    expect(opts.ringCounts.fac_a.find((r) => r.miles === 5).count).toBe(1400);
    expect(opts.others.map((f) => f.id)).toEqual(['fac_b']);
    fireEvent.click(chip);
    opts = drawn.facs.mock.calls.at(-1)[1];
    expect(opts.rings).toEqual([1, 2, 3, 5, 10]);
    expect(drawn.comps.mock.calls.at(-1)[1]).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Competitors (1)' }));
    expect(drawn.comps.mock.calls.at(-1)[1]).toHaveLength(0);
  });

  it('Show on Map switches to dots colored by overlap', async () => {
    render(<CustomerMap facility={{ id: 'fac_a', shortName: 'Temecula' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show on Map' }));
    expect(screen.getByRole('button', { name: 'Dots' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Color By').value).toBe('overlap');
  });

  it('says how far placing has got instead of an empty map', async () => {
    getOpsCustomerMap.mockResolvedValue({ ...MAP, points: [], stats: { ...STATS, customers: 0, placed: 0 },
      total: { current: 3345, placed: 0, zipOnly: 0, missing: 0, pending: 3000 } });
    render(<CustomerMap facility={null} />);
    expect((await screen.findAllByText(/Placing customers on the map - 345 of 3,345 done/)).length).toBeGreaterThan(0);
    expect(screen.getByText('No customers on the map match these filters.')).toBeTruthy();
  });

  it('explains a TPM store without a blank screen', async () => {
    render(<CustomerMap facility={{ id: 'tp1', shortName: 'Hemet', thirdParty: { label: 'TPM' } }} />);
    expect(screen.getByText(/run by another operator/)).toBeTruthy();
    expect(getOpsCustomerMap).not.toHaveBeenCalled();
  });

  it('shows an error banner when the read fails', async () => {
    getOpsCustomerMap.mockRejectedValue(Object.assign(new Error('x'), { status: 500 }));
    render(<CustomerMap facility={null} />);
    expect(await screen.findByText("Couldn't load the customer map.")).toBeTruthy();
  });
});
