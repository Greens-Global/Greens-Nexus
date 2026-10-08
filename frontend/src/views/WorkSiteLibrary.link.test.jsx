import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Location Library (Neil, Oct 1): a location is placed ONE way - its Google
// Maps link - and its address fills itself from that link, written the US way
// (typed by hand only when the link has none). The companies that use it are
// picked right in the form (All, or some). The last 30 days of punches are an
// opt-in check, off by default. Save sends none of the form-only fields, and a
// radius-only edit never re-sends the location source.

if (typeof SVGSVGElement !== 'undefined' && !SVGSVGElement.prototype.createSVGRect) {
  SVGSVGElement.prototype.createSVGRect = () => ({});
}

const LINK = 'https://maps.app.goo.gl/AbC123';
const saved = {
  id: 's1', name: 'PBK Residence', address: '469 Bohemian Hwy', latitude: '38.373334', longitude: '-122.916713', radiusM: 150,
  companies: ['c1'], notes: '', addressVerifiedAt: '2026-09-30T10:00:00', addressVerifiedBy: 'hr@greensglobal.com',
  locationSource: 'google_link', mapLink: LINK,
};
const ENTITIES = [{ id: 'c1', name: 'Greens Global' }, { id: 'c2', name: 'GG Con' }];
const RESOLVED = { lat: 33.1512, lng: -117.1189, precision: 'place', label: 'Green Storage Escondido',
  address: '25260 N Centre City Pkwy, Escondido, CA 92026', placeName: 'Green Storage Escondido' };
const api = {
  getWorkSites: vi.fn(async () => [saved]),
  getEntities: vi.fn(async () => ENTITIES),
  resolveWorkSiteLink: vi.fn(async () => RESOLVED),
  workSiteFenceCheck: vi.fn(async () => ({ days: 30, near: 0, inside: 0, people: 0, savedInside: null, points: [] })),
  createWorkSite: vi.fn(async (b) => ({ id: 'new', ...b })),
  updateWorkSite: vi.fn(async (id, b) => ({ id, ...b })),
};
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => api[k] || (async () => []) }) }));
const { WorkSiteLibrary } = await import('./HR');

afterEach(() => { vi.clearAllMocks(); try { localStorage.clear(); } catch { /* none */ } });

const pasteLink = async () => {
  fireEvent.paste(screen.getByLabelText('Google Maps link or coordinates'), { clipboardData: { getData: () => LINK } });
  await screen.findByTestId('link-result');
};
const openCompanies = () => fireEvent.click(screen.getByRole('button', { name: 'COMPANIES' }));
const openNew = async () => {
  render(<WorkSiteLibrary toastOk={vi.fn()} toastErr={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Add Location/ }));
};

describe('Location Library - placed from the Google Maps link', () => {
  it('fills the name and the US address from the link, and saves the link with the point', { timeout: 20000 }, async () => {
    await openNew();
    expect(screen.queryByRole('button', { name: 'Search Address' })).toBeNull();   // one way to place it
    await pasteLink();
    expect(screen.getByDisplayValue('Green Storage Escondido')).toBeInTheDocument();   // empty name took the business name
    const address = screen.getByLabelText('ADDRESS');
    expect(address).toHaveValue('25260 N Centre City Pkwy, Escondido, CA 92026');
    expect(address).toHaveAttribute('readonly');
    expect(screen.getByText(/33\.151200, -117\.118900/)).toBeInTheDocument();
    openCompanies();
    fireEvent.click(screen.getByRole('option', { name: 'All' }));
    expect(screen.getByRole('button', { name: 'COMPANIES' })).toHaveTextContent('All Companies');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.createWorkSite).toHaveBeenCalled());
    const body = api.createWorkSite.mock.calls[0][0];
    expect(body).toMatchObject({ name: 'Green Storage Escondido', address: '25260 N Centre City Pkwy, Escondido, CA 92026',
      latitude: '33.151200', longitude: '-117.118900', location_source: 'google_link', map_link: LINK, radius_m: 150 });
    expect(body.company_ids).toEqual(['c1', 'c2']);
    for (const k of ['link_point', 'loc_changed', 'addr_manual', 'link_address', 'verifiedAt', 'saved_point']) expect(body).not.toHaveProperty(k);
  });

  it("replaces an old address with the link's, and keeps a name already typed", { timeout: 20000 }, async () => {
    render(<WorkSiteLibrary toastOk={vi.fn()} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    expect(screen.getByLabelText('ADDRESS')).toHaveValue('469 Bohemian Hwy');
    await pasteLink();
    expect(screen.getByLabelText('ADDRESS')).toHaveValue('25260 N Centre City Pkwy, Escondido, CA 92026');
    expect(screen.getByDisplayValue('PBK Residence')).toBeInTheDocument();
  });

  it('asks for the address by hand when the link has none', { timeout: 20000 }, async () => {
    api.resolveWorkSiteLink.mockResolvedValueOnce({ ...RESOLVED, address: '', placeName: '' });
    await openNew();
    await pasteLink();
    const address = screen.getByLabelText('ADDRESS');
    expect(address).not.toHaveAttribute('readonly');
    expect(screen.getByText('The link does not include an address - type it in.')).toBeInTheDocument();
    fireEvent.change(address, { target: { value: '12 Main St, Escondido, CA 92025' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Green Storage Escondido'), { target: { value: 'Main St' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.createWorkSite).toHaveBeenCalled());
    expect(api.createWorkSite.mock.calls[0][0].address).toBe('12 Main St, Escondido, CA 92025');
  });

  it('picks some companies from the dropdown, or none', { timeout: 20000 }, async () => {
    await openNew();
    fireEvent.change(screen.getByPlaceholderText('e.g. Green Storage Escondido'), { target: { value: 'Yard' } });
    expect(screen.getByRole('button', { name: 'COMPANIES' })).toHaveTextContent('Select companies');
    expect(screen.getByText(/No company yet/)).toBeInTheDocument();
    openCompanies();
    const all = screen.getByRole('option', { name: 'All' });
    expect(all).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(screen.getByRole('option', { name: 'Greens Global' }));
    fireEvent.click(screen.getByRole('option', { name: 'GG Con' }));
    expect(screen.getByRole('option', { name: 'All' })).toHaveAttribute('aria-selected', 'true');   // every one picked = All
    fireEvent.click(screen.getByRole('option', { name: 'Greens Global' }));
    expect(screen.getByRole('button', { name: 'COMPANIES' })).toHaveTextContent('GG Con');
    expect(screen.getByText(/1 of 2 companies/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.createWorkSite).toHaveBeenCalled());
    expect(api.createWorkSite.mock.calls[0][0].company_ids).toEqual(['c2']);
  });

  it('puts the geofence radius under the map', { timeout: 20000 }, async () => {
    await openNew();
    const map = document.querySelector('[aria-label="Map of the location and its geofence"]');
    const slider = screen.getByLabelText('Geofence radius slider');
    expect(map.compareDocumentPosition(slider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(map.parentElement.parentElement.contains(slider)).toBe(true);   // same (right) column as the map
  });

  it('shows recent punches only when turned on', { timeout: 20000 }, async () => {
    render(<WorkSiteLibrary toastOk={vi.fn()} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    const toggle = screen.getByRole('switch', { name: 'Show Punches Here' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await new Promise((r) => setTimeout(r, 700));   // past the check's debounce
    expect(api.workSiteFenceCheck).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await waitFor(() => expect(api.workSiteFenceCheck).toHaveBeenCalled());
  });

  it('a radius-only edit does not re-send the location source', { timeout: 20000 }, async () => {
    render(<WorkSiteLibrary toastOk={vi.fn()} toastErr={vi.fn()} />);
    expect(await screen.findByText('Used by Greens Global')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    expect(screen.getByText(/Placed from a Google Maps link on 09\/30\/2026 by hr@greensglobal.com/)).toBeInTheDocument();
    // The radius is picked in feet (Oct 2) and still saved in whole meters.
    fireEvent.click(screen.getByRole('button', { name: '650 ft' }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.updateWorkSite).toHaveBeenCalled());
    const [id, body] = api.updateWorkSite.mock.calls[0];
    expect(id).toBe('s1');
    expect(body.radius_m).toBe(198);   // 650 ft
    expect(body.company_ids).toEqual(['c1']);
    expect(body).not.toHaveProperty('location_source');
    expect(body).not.toHaveProperty('map_link');
  });
});
