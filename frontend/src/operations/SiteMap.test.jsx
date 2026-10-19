// Render-smoke test for Operations > Site Map: the tab renders the site model,
// switching a layer recolors the units and swaps the legend, and a missing
// maintenance endpoint reads "not connected yet" instead of failing. jsdom has
// no WebGL: the viewer is mocked and records what it was told.
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const calls = { colors: [], markers: [] };
vi.mock('../sitemodel/siteModelViewer.js', async () => {
  const real = await vi.importActual('../sitemodel/siteModelViewer.js');
  return {
    ...real,
    createSiteModelViewer: (container, model, opts) => {
      calls.colors.push(opts.colors);
      return {
        selectUnit: (n) => { const u = model.units.find((x) => x.n === n); if (!u) return false; opts.onSelectUnit(u); return true; },
        clearSelection() {}, setMode() {}, setXray() {}, setLevel() {}, setPins() {}, setMarkers: (m) => calls.markers.push(m), setPlacing() {}, setBackground() {}, view() {}, flyToPin() {},
        setUnitColors: (c) => calls.colors.push(c), flyToStep() {}, resetView() {}, getRoute: () => null, getState: () => ({}), destroy() {},
      };
    },
  };
});

const model = {
  property: { id: 'greens-storage-escondido', name: 'Greens Storage Escondido' },
  frame: { north: [-0.78, 0.62] }, image: { attribution: 'Imagery: Esri' },
  buildings: [{ id: 'C', letters: ['C'], name: 'Building C', u: [0, 100], v: [0, 20], height: 7, floors: 2, roof: 'solar' }],
  zones: [], gates: [{ id: 'main', name: 'Main Gate', uv: [50, 30] }],
  units: [{ n: 'C214', b: 'C', f: 2, u: 10, v: 2, wu: 3, dv: 4.5, door: 'ne', k: 'cc', w: 10, d: 15, l: 0, r: 1, dvac: 160 },
          { n: 'C001', b: 'C', f: 1, u: 0, v: 0, wu: 3, dv: 6, door: 'sw', k: 'du', w: 10, d: 20, l: 1, r: 0, why: 'ACTIVE_LEASE' }],
  layout: { schematic: false }, sources: [], live: { source: 'cubby', unplaced: [], missing: [] },
};
const facts = { C214: { status: 'vacant', daysVacant: 160, street: 9000, rate: 9000, market: 'under', marketPct: -10, marketMedian: 10000, marketCount: 3, type: '10x15 CC' } };

vi.mock('../api', () => ({
  api: {
    getOpsSiteMapFacilities: vi.fn(async () => [{ facilityId: 'fac_1', modelId: 'greens-storage-escondido', name: 'Escondido' }]),
    getOpsSiteMap: vi.fn(async () => ({ facilityId: 'fac_1', modelId: 'greens-storage-escondido', model, facts, entrance: { lat: 33.17, lng: -117.1, source: 'gate', name: 'Main Gate', mapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=33.17,-117.1' }, cubbyTemplate: 'https://nexus/find/u?f=x&k=y&unit=${unit.name}', marketBand: 0.05 })),
    getOpsMaintenanceMap: vi.fn(async () => { const e = new Error('Not Found'); e.status = 404; throw e; }),
    getOpsCustomerLink: vi.fn(async () => ({ url: 'https://nexus/find/abc', unit: 'C214' })),
    saveOpsEntrance: vi.fn(),
  },
}));

import SiteMap from './SiteMap';

beforeEach(() => { calls.colors.length = 0; calls.markers.length = 0; localStorage.removeItem('nexus.ops.siteMap.layer'); });

describe('Operations > Site Map', () => {
  it('asks for a facility when All Facilities is picked', async () => {
    render(<SiteMap facility={null} facilities={[{ id: 'fac_1', shortName: 'Escondido' }]} onPick={() => {}} />);
    expect(await screen.findByText('Choose a Facility')).toBeTruthy();
  });

  it('renders the model, switches layers and their legends', async () => {
    render(<SiteMap facility={{ id: 'fac_1', shortName: 'Escondido' }} facilities={[]} onPick={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Occupancy' })).toBeTruthy();
    // occupancy: the leased-but-unrentable unit is leased, not out of service
    await waitFor(() => expect(calls.colors.at(-1)).toMatchObject({ C001: '#5fae7d', C214: '#e0b45a' }));
    expect(screen.getAllByText(/Leased \(1\)/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Days Vacant' }));
    await waitFor(() => expect(calls.colors.at(-1).C001).toBe('#cfcac0'));
    expect(screen.getByText('180+')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Market' }));
    await waitFor(() => expect(calls.colors.at(-1).C214).toBe('#2563eb'));
    expect(screen.getByText(/Under Market \(1\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Maintenance' }));
    expect((await screen.findAllByText('Maintenance layer not connected yet')).length).toBeGreaterThan(0);
  });

  it('shows the layer facts and copies the customer link from the unit card', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
    render(<SiteMap facility={{ id: 'fac_1', shortName: 'Escondido' }} facilities={[]} onPick={() => {}} />);
    const box = await screen.findByLabelText('Unit number');
    fireEvent.change(box, { target: { value: 'C214' } });
    fireEvent.submit(box.closest('form'));
    expect(screen.getByText(/160 /)).toBeTruthy();
    expect(screen.getByText(/\$90 vs \$100 median, 10% under/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Customer Link' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://nexus/find/abc');
    expect(screen.getByText('Customer Entrance')).toBeTruthy();
    expect(screen.queryByText(/^Pins/)).toBeNull();   // no pin grant on this screen
  });
});
