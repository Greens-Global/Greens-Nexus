import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, within, waitFor } from '@testing-library/react';

// The asset Overview (Neil, 11/17/2026): renders without a crash for a property
// and a vehicle, says why Needs Attention is quiet, never prints the raw Google
// Maps link, and keeps the detail form mounted when editing starts - the edit
// lives in the form, and a remount would drop it.
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../../../api.js', () => {
  const named = {
    getPropertyTickets: () => Promise.resolve({ open: [{ id: 't1', codeLabel: 'Ticket #12', subject: 'Gate sticks', status: 'in_progress' }], history: [], services: [], records: [] }),
    getPropertyJobs: () => Promise.resolve({ open: [], recent: [] }),
    getSiteModels: () => Promise.resolve([]),
  };
  return { api: new Proxy({}, { get: (_, k) => named[k] || (() => Promise.resolve({})) }) };
});
vi.mock('./PhotoGallery.jsx', () => ({ PhotoGallery: () => <div data-testid="media" /> }));

const { AssetOverviewPage, changeLine } = await import('./AssetOverviewPage.jsx');
const { editGuard } = await import('../../lib/editGuard.js');

const MAPS = 'https://www.google.com/maps/place/Greens/@30.4,-97.8,17z';
const PROPERTY = {
  id: 'p1', kind: 'property', name: 'Greens Storage, Austin', devStage: 'Stabilized', assetType: 'Self-Storage',
  address: '8023 West Parmer Lane', city: 'Austin', state: 'TX', zip: '78729', entity: 'Greens Austin, LLC.', manager: 'Neil Kadakia',
  mapUrl: MAPS, geo: { lat: 30.4, lng: -97.8 },
};
const VAN = { id: 'v1', kind: 'vehicle', assetType: 'Vehicle', name: 'Ford Transit', snapshot: [{ group: 'Identity', fields: [{ label: 'Make', value: 'Ford' }] }] };
const store = (assets) => ({ properties: assets, logs: [{ id: 'l1', propertyId: 'p1', action: 'edited', user: 'You', ts: '2026-06-29T10:30:00Z', changes: [{ field: 'Country', from: '', to: 'United States' }] }], warranties: [], inspections: [], vendors: [], ahj: [], vservice: [], odometer: [] });

afterEach(() => { act(() => { editGuard.cancel?.(); }); cleanup(); });

describe('AssetOverviewPage', () => {
  it('lays out a property: Needs Attention says why it is quiet, the rail holds the glance blocks', async () => {
    render(<AssetOverviewPage asset={PROPERTY} store={store([PROPERTY])} onTab={vi.fn()} onStartEdit={vi.fn()} />);
    const attention = screen.getByRole('region', { name: 'Needs Attention' });
    expect(within(attention).getByText('Nothing due in the next 90 days.')).toBeTruthy();
    expect(attention.textContent).toContain('No insurance or property tax dates are on file, so none can come due.');
    const rail = screen.getByRole('complementary', { name: 'At a Glance' });
    for (const name of ['Key Details', 'Location', 'Work', 'Financing', 'Recent Changes']) {
      expect(within(rail).getByRole('region', { name })).toBeTruthy();
    }
    // A real map of the stored point, and the link only as a link.
    expect(screen.getByTitle('Map of Greens Storage, Austin').getAttribute('src')).toContain('30.4,-97.8');
    expect(document.body.textContent).not.toContain('google.com');
    expect(screen.getByRole('link', { name: 'Open in Maps' }).getAttribute('href')).toBe(MAPS);
    expect(screen.getByText('Country set to United States')).toBeTruthy();
    // The open ticket shows in Work with its state as words.
    await waitFor(() => expect(screen.getByText('Gate sticks')).toBeTruthy());
    expect(screen.getByText('In Progress')).toBeTruthy();
    // An operating property's details read under its own section names.
    expect(screen.getByRole('heading', { name: 'Ownership and Team' })).toBeTruthy();
  });

  it('keeps the detail form mounted when editing starts, and drops the rail', () => {
    const props = { asset: PROPERTY, store: store([PROPERTY]), onTab: vi.fn(), onStartEdit: vi.fn() };
    const { rerender } = render(<AssetOverviewPage {...props} />);
    act(() => { editGuard.startEdit(); });
    rerender(<AssetOverviewPage {...props} editing />);
    expect(screen.getByRole('navigation', { name: 'On This Page' })).toBeTruthy();   // still editing
    expect(screen.queryByRole('complementary', { name: 'At a Glance' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Google Maps Link' }).value).toBe(MAPS);
  });

  it('gives a vehicle its own facts', () => {
    render(<AssetOverviewPage asset={VAN} store={store([VAN])} onTab={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Service and Papers' })).toBeTruthy();
    expect(within(screen.getByRole('complementary', { name: 'At a Glance' })).queryByRole('region', { name: 'Location' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Needs Attention' }).textContent).toContain('No insurance or registration dates are on file');
  });

  it('reads a log entry as a short line', () => {
    expect(changeLine({ action: 'edited', changes: [{ field: 'Policy Expiration', to: '2026-10-04' }] })).toBe('Policy Expiration set to 10/04/2026');
    expect(changeLine({ action: 'added', item: 'Electric Utility' })).toBe('Added Electric Utility');
  });
});
