import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render smoke for Operations > Customer Map (Oct 21 2026): Leaflet is mocked;
// the screen must draw the rings, the counts card and the coverage note, and
// toggling a ring chip redraws the circles.
const circles = [];
vi.mock('leaflet', () => {
  const chain = () => { const o = { addTo: () => o, bindTooltip: () => o, on: () => o, clearLayers: () => { circles.length = 0; }, setView: () => o, fitBounds: () => o, invalidateSize: () => {}, remove: () => {} }; return o; };
  const L = { map: chain, tileLayer: chain, layerGroup: chain, circleMarker: chain, marker: chain, divIcon: () => ({}),
    circle: (c, opts) => { circles.push(opts.radius); return chain(); } };
  return { default: L };
});
vi.mock('leaflet/dist/leaflet.css', () => ({}));

const getOpsCustomerMap = vi.fn();
vi.mock('../api', () => ({ api: { getOpsCustomerMap: (...a) => getOpsCustomerMap(...a) } }));

const CustomerMap = (await import('./CustomerMap')).default;

const MAP = {
  facilities: [{ id: 'fac_a', name: 'Greens Storage Temecula', shortName: 'Temecula', lat: 33.5, lng: -117.15, state: 'CA' }],
  points: [{ lat: 33.51, lng: -117.15, facilityId: 'fac_a', count: 3, precision: 'street' },
    { lat: 33.6, lng: -117.2, facilityId: 'fac_a', count: 1, precision: 'zip' }],
  coverage: { fac_a: { current: 3345, placed: 1786, zipOnly: 120, missing: 1559, pending: 0 } },
  total: { current: 3345, placed: 1786, zipOnly: 120, missing: 1559, pending: 0 },
  rings: [{ miles: 1, count: 300 }, { miles: 2, count: 700 }, { miles: 3, count: 1000 }, { miles: 5, count: 1400 },
    { miles: 10, count: 1700 }, { miles: 50, count: 1780 }],
  beyond: 6, placed: 1786,
};

describe('CustomerMap', () => {
  beforeEach(() => {
    getOpsCustomerMap.mockReset().mockResolvedValue(MAP);
    circles.length = 0;
    localStorage.removeItem('nexus.ops.customerMap.rings');
  });

  it('shows the counts card, the coverage note and the privacy note', async () => {
    render(<CustomerMap facility={{ id: 'fac_a', shortName: 'Temecula' }} state="CA" />);
    expect(await screen.findByText('Customers Within')).toBeTruthy();
    expect(getOpsCustomerMap).toHaveBeenCalledWith({ facility: 'fac_a', state: 'CA' });
    expect(screen.getByRole('status').textContent).toMatch(/Showing 1,786 of 3,345 current customers - 1,559 have no usable address in Cubby/);
    const table = screen.getByRole('table');
    const row = within(table).getByText('3 Miles').closest('tr');
    expect(row.textContent).toBe('3 Miles1,00056%');
    expect(within(table).getByText('Beyond 50 Miles').closest('tr').textContent).toBe('Beyond 50 Miles60%');
    expect(screen.getByText('ZIP area only (approximate)')).toBeTruthy();
    expect(screen.getByText('Points are rounded to about 100 m. Nexus stores no customer addresses.')).toBeTruthy();
  });

  it('draws the default rings and toggles one', async () => {
    render(<CustomerMap facility={null} />);
    const chip = await screen.findByRole('button', { name: '2 Miles' });
    expect(getOpsCustomerMap).toHaveBeenCalledWith({ facility: 'all', state: '' });
    expect(screen.getByRole('button', { name: '1 Mile' }).getAttribute('aria-pressed')).toBe('true');
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => expect(circles.length).toBe(4));                  // 1, 3, 5, 10 by default
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(circles.length).toBe(5));
    expect(circles.map((r) => Math.round(r / 1609.344)).sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 10]);
    fireEvent.click(screen.getByRole('button', { name: '10 Miles' }));
    await waitFor(() => expect(circles.length).toBe(4));
  });

  it('says how far placing has got instead of an empty map', async () => {
    getOpsCustomerMap.mockResolvedValue({ ...MAP, points: [], rings: MAP.rings.map((r) => ({ ...r, count: 0 })), beyond: 0, placed: 0,
      total: { current: 3345, placed: 0, zipOnly: 0, missing: 0, pending: 3000 } });
    render(<CustomerMap facility={null} />);
    expect((await screen.findAllByText(/Placing customers on the map - 345 of 3,345 done/)).length).toBeGreaterThan(0);
  });

  it('explains a TPM store and an error without a blank screen', async () => {
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
