// The customer unit map (/find/<token>): renders the route and that one unit,
// no search, the entrance link, and - with no WebGL, as in jsdom - the flat
// plan with the route line instead of a blank stage.
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PublicFindUnit from './PublicFindUnit';

const view = {
  property: { id: 'greens-storage-escondido', name: 'Greens Storage Escondido', address: '25260 N Centre City Pkwy, Escondido, CA 92026' },
  frame: { north: [-0.78, 0.62] }, image: null, imageWide: null, parcel: null, pad: null,
  gates: [{ id: 'main', name: 'Main Gate', uv: [0, 0] }],
  buildings: [{ id: 'A', letters: ['A'], name: 'Building A', u: [20, 60], v: [-10, 10], height: 4, floors: 1 },
              { id: 'C', letters: ['C'], name: 'Building C', u: [80, 120], v: [-10, 10], height: 7, floors: 2 }],
  zones: [], sources: [], layout: { schematic: false }, live: { source: 'snapshot', unplaced: [] },
  units: [{ n: 'C246', b: 'C', f: 1, u: 100, v: 0, wu: 3, dv: 3, door: 'ne', k: 'cc', w: 10, d: 10 }],
  unit: { n: 'C246', b: 'C', f: 1, u: 100, v: 0, wu: 3, dv: 3, door: 'ne', k: 'cc', w: 10, d: 10 },
  building: 'Building C',
  entrance: { lat: 33.17, lng: -117.1, name: 'Main Gate', note: 'Turn in at the green sign.', source: 'setting', mapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=33.17,-117.1' },
};

afterEach(() => { vi.restoreAllMocks(); });

describe('PublicFindUnit', () => {
  it('shows the unit, the entrance and the route - and nothing to search', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => view });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(<PublicFindUnit token="tok123" />);
    expect(await screen.findByText('Getting Here')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/unit-map\/t\/tok123$/);
    expect(screen.getByRole('link', { name: 'Open in Google Maps' }).getAttribute('href')).toBe(view.entrance.mapsUrl);
    expect(screen.getByText('Turn in at the green sign.')).toBeTruthy();
    expect(screen.queryByLabelText('Unit number')).toBeNull();          // no search box
    expect(screen.getByRole('list', { name: 'Route steps' })).toBeTruthy();
    expect(screen.queryByText(/Leased|Vacant|Out of Service/)).toBeNull();   // never occupancy
    // no WebGL in jsdom: the flat plan draws instead, with the route line
    await waitFor(() => expect(container.querySelector('svg[aria-label$="plan"]')).toBeTruthy());
    expect(container.querySelector('svg polyline')).toBeTruthy();
    expect(container.querySelectorAll('svg rect[data-unit]').length).toBe(1);
  });

  it('turns a Cubby template link into the signed address', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ ...view, token: 'signed1' }) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const replace = vi.spyOn(window.history, 'replaceState');
    render(<PublicFindUnit token="u" search="?f=greens-storage-escondido&k=KEY&unit=C246" />);
    expect(await screen.findByText('Getting Here')).toBeTruthy();
    expect(globalThis.fetch.mock.calls[0][0]).toMatch(/\/unit-map\/u\?f=greens-storage-escondido&k=KEY&unit=C246$/);
    expect(replace).toHaveBeenCalledWith(null, '', '/find/signed1');
  });

  it('says when a link is not valid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404, json: async () => ({ detail: 'This link is not valid. Ask the office for a new one.' }) });
    render(<PublicFindUnit token="bad" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/not valid/);
  });
});
