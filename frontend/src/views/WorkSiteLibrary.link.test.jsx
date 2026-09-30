import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Work Site Library, placed from a Google Maps link (Sep 30): pasting the
// link sets the point, and Save sends the link as the record of it - with
// none of the form-only fields, and a radius-only edit never re-sends it.

if (typeof SVGSVGElement !== 'undefined' && !SVGSVGElement.prototype.createSVGRect) {
  SVGSVGElement.prototype.createSVGRect = () => ({});
}

const LINK = 'https://maps.app.goo.gl/AbC123';
const saved = {
  id: 's1', name: 'PBK Residence', address: '469 Bohemian Hwy', latitude: '38.373334', longitude: '-122.916713', radiusM: 150,
  companies: [], notes: '', addressVerifiedAt: '2026-09-30T10:00:00', addressVerifiedBy: 'hr@greensglobal.com',
  locationSource: 'google_link', mapLink: LINK,
};
const api = {
  getWorkSites: vi.fn(async () => [saved]),
  getEntities: vi.fn(async () => []),
  resolveWorkSiteLink: vi.fn(async () => ({ lat: 38.3733338, lng: -122.916713, precision: 'place', label: '469 Bohemian Hwy, Sebastopol, CA 95472' })),
  workSiteFenceCheck: vi.fn(async () => ({ days: 30, near: 0, inside: 0, people: 0, savedInside: null, points: [] })),
  createWorkSite: vi.fn(async (b) => ({ id: 'new', ...b })),
  updateWorkSite: vi.fn(async (id, b) => ({ id, ...b })),
};
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => api[k] || (async () => []) }) }));
const { WorkSiteLibrary } = await import('./HR');

afterEach(() => vi.clearAllMocks());

describe('Work Site Library - Google Maps link', () => {
  it('pastes a link, shows the site as placed from it, and saves the link with the point', { timeout: 20000 }, async () => {
    render(<WorkSiteLibrary toastOk={vi.fn()} toastErr={vi.fn()} />);
    expect(await screen.findByText('Google Maps')).toBeInTheDocument();   // list badge for a link-placed site
    fireEvent.click(screen.getByRole('button', { name: /Add Work Site/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Escondido Office'), { target: { value: 'PBK Residence 2' } });
    fireEvent.paste(screen.getByLabelText('Google Maps link or coordinates'), { clipboardData: { getData: () => LINK } });
    await screen.findByTestId('link-result');
    expect(screen.getByDisplayValue('38.373334')).toBeInTheDocument();
    expect(screen.getByDisplayValue('469 Bohemian Hwy, Sebastopol, CA 95472')).toBeInTheDocument();   // address filled from the link
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.createWorkSite).toHaveBeenCalled());
    const body = api.createWorkSite.mock.calls[0][0];
    expect(body).toMatchObject({ name: 'PBK Residence 2', latitude: '38.373334', longitude: '-122.916713',
      location_source: 'google_link', map_link: LINK, radius_m: 150 });
    for (const k of ['link_point', 'loc_changed', 'loc_mode', 'verifiedAt', 'saved_point']) expect(body).not.toHaveProperty(k);
  });

  it('a radius-only edit does not re-send the location source', { timeout: 20000 }, async () => {
    render(<WorkSiteLibrary toastOk={vi.fn()} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    expect(screen.getByText(/Set from a Google Maps link on 09\/30\/2026 by hr@greensglobal.com/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '200 m' }));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.updateWorkSite).toHaveBeenCalled());
    const [id, body] = api.updateWorkSite.mock.calls[0];
    expect(id).toBe('s1');
    expect(body.radius_m).toBe(200);
    expect(body).not.toHaveProperty('location_source');
    expect(body).not.toHaveProperty('map_link');
  });
});
