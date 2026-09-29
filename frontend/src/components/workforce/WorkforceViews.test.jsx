import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Workforce Analytics team views (Sep 29): a saved team narrows every tab.
// Pins the picker/editor flow, that the default view opens first, that
// "Everyone I Can See" turns it off, and that Locations' list follows it.

const VIEWS = [
  { id: 'v1', name: 'Front Desk', isDefault: true, criteria: { people: ['amy@x.com'] }, emails: ['amy@x.com'], count: 1 },
  { id: 'v2', name: 'Sales', isDefault: false, criteria: { departments: ['Sales'] }, emails: ['ben@x.com'], count: 1 },
];
const PEOPLE = [
  { email: 'amy@x.com', name: 'Amy Ames', department: 'Ops', status: 'working', clockedIn: true, lat: '33.1', lng: '-117.1', accuracyM: 12, geoStatus: 'in_fence', at: '2026-09-29T10:00:00', device: 'mobile' },
  { email: 'ben@x.com', name: 'Ben Bell', department: 'Sales', status: 'off', clockedIn: false, lat: '34.0', lng: '-118.2', accuracyM: 900, geoStatus: 'no_location', at: '2026-09-29T09:00:00', device: 'desktop' },
];

const api = {
  workforceViews: vi.fn(),
  workforceViewOptions: vi.fn(),
  workforceViewPreview: vi.fn(),
  workforceViewCreate: vi.fn(),
  workforceViewUpdate: vi.fn(),
  workforceViewDelete: vi.fn(),
  timeLocations: vi.fn(),
};
vi.mock('../../api', () => ({ api }));
vi.mock('../../api.js', () => ({ api }));
vi.mock('../../lib/pollWhileVisible', () => ({ pollWhileVisible: () => () => {} }));
// jsdom has no layout engine for Leaflet; a stub map is all these tests need.
vi.mock('leaflet', () => {
  const chain = () => { const o = { addTo: () => o, bindTooltip: () => o, on: () => o, clearLayers: () => {}, setView: () => o, fitBounds: () => o, invalidateSize: () => {}, remove: () => {} }; return o; };
  const L = { map: chain, tileLayer: chain, layerGroup: chain, marker: chain, divIcon: () => ({}), control: { layers: chain } };
  return { default: L };
});
vi.mock('leaflet/dist/leaflet.css', () => ({}));

const { WorkforceViewBar } = await import('./WorkforceViews');
const { WorkforceViewProvider, useWorkforceViews } = await import('./viewContext');
const Locations = (await import('../../views/Locations')).default;

function Harness() {
  const state = useWorkforceViews();
  return (
    <WorkforceViewProvider value={state.ctx}>
      <WorkforceViewBar state={state} />
      <Locations embedded />
    </WorkforceViewProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  Object.values(api).forEach(f => f.mockReset());
  api.workforceViews.mockResolvedValue({ views: VIEWS });
  api.timeLocations.mockResolvedValue({ people: PEOPLE });
  api.workforceViewOptions.mockResolvedValue({
    companies: [], locations: [], managers: [], shiftGroups: [],
    departments: [{ id: 'Sales', name: 'Sales', count: 1 }],
    people: PEOPLE.map(p => ({ email: p.email, name: p.name, department: p.department })),
  });
  api.workforceViewPreview.mockResolvedValue({ emails: ['ben@x.com'], count: 1 });
  globalThis.ResizeObserver ||= class { observe() {} disconnect() {} };
  globalThis.CSS ||= {};
  globalThis.CSS.escape ||= (s) => s;
});

const rows = () => [...document.querySelectorAll('[data-person-row]')].map(r => r.getAttribute('data-person-row'));

describe('Workforce Analytics team views', () => {
  it('opens on the default view and narrows the Locations list to it', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByLabelText('Team View').value).toBe('v1'));
    await waitFor(() => expect(rows()).toEqual(['amy@x.com']));
    expect(screen.getByText('Front Desk', { selector: 'strong' })).toBeTruthy();
  });

  it('"Everyone I Can See" shows everyone, and the choice is remembered', async () => {
    render(<Harness />);
    await waitFor(() => expect(rows()).toEqual(['amy@x.com']));
    fireEvent.change(screen.getByLabelText('Team View'), { target: { value: '' } });
    await waitFor(() => expect(rows().sort()).toEqual(['amy@x.com', 'ben@x.com']));
    expect(localStorage.getItem('nexus:workforceView')).toBe('');
    fireEvent.change(screen.getByLabelText('Team View'), { target: { value: 'v2' } });
    await waitFor(() => expect(rows()).toEqual(['ben@x.com']));
  });

  it('builds a view: picks a department, shows the live count, saves', async () => {
    api.workforceViewCreate.mockResolvedValue({ ...VIEWS[1], id: 'v3', name: 'Sales Floor' });
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /New View/ }));
    const dialog = await screen.findByRole('dialog', { name: 'New Team View' });
    fireEvent.change(screen.getByPlaceholderText(/Front Desk Team/), { target: { value: 'Sales Floor' } });
    fireEvent.click(await screen.findByRole('button', { name: /Sales/, pressed: false }));
    await waitFor(() => expect(dialog.textContent).toContain('1 person match'), { timeout: 2000 });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save View/ })); });
    expect(api.workforceViewCreate).toHaveBeenCalledWith({ name: 'Sales Floor', criteria: expect.objectContaining({ departments: ['Sales'] }), isDefault: false });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('will not save a view with no name or nothing picked', async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /New View/ }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /Save View/ }));
    expect(await screen.findByText('Give the view a name.')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Front Desk Team/), { target: { value: 'Empty' } });
    fireEvent.click(screen.getByRole('button', { name: /Save View/ }));
    expect(await screen.findByText('Pick at least one team filter or person.')).toBeTruthy();
    expect(api.workforceViewCreate).not.toHaveBeenCalled();
  });

  it('Locations filters by status and never renders blank while loading', async () => {
    api.workforceViews.mockResolvedValue({ views: [] });
    render(<Harness />);
    await waitFor(() => expect(rows().length).toBe(2));
    fireEvent.click(screen.getByRole('tab', { name: /Working/ }));
    expect(rows()).toEqual(['amy@x.com']);
    expect(screen.getByRole('button', { name: /Full-Screen Map/ })).toBeTruthy();
  });
});
