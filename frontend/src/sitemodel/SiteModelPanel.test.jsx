// Render-smoke test for the site model screen (CLAUDE.md: new high-risk views
// get one). jsdom has no WebGL, so the three.js viewer is mocked; the test
// proves the panel renders its chrome and the unit card without crashing.
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const styles = [];
vi.mock('./siteModelViewer.js', async () => {
  const real = await vi.importActual('./siteModelViewer.js');
  return {
    ...real,
    createSiteModelViewer: (container, model, opts) => (styles.push(opts.style), {
      selectUnit: (n) => { const u = model.units.find((x) => x.n === n); if (!u) return false; opts.onSelectUnit(u); return true; },
      clearSelection() {}, setMode() {}, setXray() {}, setLevel() {}, setPins() {}, setMarkers() {}, setPlacing() {}, setBackground() {}, view() {}, flyToPin() {}, getState: () => ({}), destroy() {},
    }),
  };
});

import { SiteModelPanel } from './SiteModelPanel.jsx';

const model = {
  property: { id: 'greens-storage-escondido', name: 'Greens Storage Escondido' },
  frame: { north: [-0.78, 0.62] }, image: { attribution: 'Imagery: Esri' },
  buildings: [{ id: 'C', letters: ['C'], name: 'Building C', u: [0, 100], v: [0, 20], height: 7, floors: 2, roof: 'solar', note: 'Main building.' }],
  zones: [], gates: [{ id: 'main', name: 'Main Gate', uv: [50, 30] }],
  units: [{ n: 'C214', b: 'C', f: 2, u: 10, v: 2, wu: 3, dv: 4.5, door: 'ne', k: 'cc', veh: 0, pw: 0, w: 10, d: 15, l: 1, r: 1, why: '', note: '', dvac: 0 },
          { n: 'C001', b: 'C', f: 1, u: 0, v: 0, wu: 3, dv: 6, door: 'sw', k: 'du', veh: 1, pw: 0, w: 10, d: 20, l: 0, r: 0, why: 'DAMAGE', note: 'door', dvac: 12 }],
  layout: { schematic: true, flags: ['C: confirm floors'] }, sources: ['Cubby'],
};

describe('SiteModelPanel', () => {
  // See Inside opens real buildings; a site of open stalls (units tagged with a
  // section letter, no building of that id) has nothing to open (Oct 20).
  it('shows See Inside only where units sit inside a building', () => {
    const { unmount } = render(<SiteModelPanel model={model} mode="owner" images={{}} />);
    expect(screen.queryByRole('button', { name: 'See Inside' })).toBeTruthy();
    unmount();
    const stalls = { ...model, buildings: [{ id: 'OFFICE', kind: 'office', letters: ['O'], name: 'Office', u: [0, 5], v: [0, 5], height: 3, floors: 1 }],
      units: model.units.map((u) => ({ ...u, b: 'E', f: 1, k: 'park' })) };
    render(<SiteModelPanel model={stalls} mode="owner" images={{}} />);
    expect(screen.queryByRole('button', { name: 'See Inside' })).toBeNull();
  });

  it('renders the customer finder and a unit card after a search', () => {
    render(<SiteModelPanel model={model} mode="customer" images={{}} />);
    expect(screen.getByText('Find Your Unit')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Unit number'), { target: { value: 'c214' } });
    fireEvent.submit(screen.getByLabelText('Unit number').closest('form'));
    // the unit card's number and the last route step both read C214
    expect(screen.getAllByText('C214').length).toBeGreaterThan(0);
    expect(screen.getByText(/Building C, Level 2/)).toBeTruthy();
    expect(screen.getByText('How to Get There')).toBeTruthy();
    expect(screen.queryByText(/^Inventory/)).toBeNull();
  });
  it('shows owner inventory, out-of-service units and pins', () => {
    render(<SiteModelPanel model={model} mode="owner" images={{}} pins={[{ id: 'p1', unit: 'C001', title: 'Replace door spring', category: 'maintenance', status: 'open', u: 1, v: 1, y: 0 }]} />);
    expect(screen.getByText('Inventory')).toBeTruthy();
    // production's 2x2 tiles (Oct 20: "make it like the asset management site model")
    ['Active Units and Stalls', 'Leased (1)', 'Vacant, Rentable', 'Out of Service'].forEach((t) => expect(screen.getAllByText(t).length).toBeGreaterThan(0));
    expect(screen.getByText('Needs Attention (1)')).toBeTruthy();
    expect(screen.getByText('Pins (1)')).toBeTruthy();
    expect(screen.getByText(/Replace door spring/)).toBeTruthy();
    expect(screen.getByText('Layout Notes')).toBeTruthy();
  });
  it('shows the live Cubby state and the units not on the map yet', () => {
    const live = { ...model, live: { source: 'cubby', enabled: true, ok: true, asOf: '2026-10-11T20:00:00Z', matched: 2, unplaced: [{ n: 'Q001', w: 10, d: 20, k: 'park', l: 1, r: 1, group: 'RV 10x20' }], missing: [] } };
    render(<SiteModelPanel model={live} mode="owner" images={{}} />);
    expect(screen.getByText(/Live from Cubby/)).toBeTruthy();
    expect(screen.getByText('Not On The Map Yet (1)')).toBeTruthy();
    expect(screen.getByText('Q001')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Unit number'), { target: { value: 'q1' } });
    fireEvent.submit(screen.getByLabelText('Unit number').closest('form'));
    expect(screen.getByRole('alert').textContent).toMatch(/not on the map yet/);
  });
  it('says when the model is a snapshot without a live link', () => {
    render(<SiteModelPanel model={{ ...model, live: { source: 'snapshot', enabled: false, asOf: 'Oct 11, 2026', unplaced: [], missing: [] } }} mode="owner" images={{}} />);
    expect(screen.getByText(/Cubby snapshot from Oct 11, 2026 · live link off/)).toBeTruthy();
    expect(screen.queryByText(/Not On The Map Yet/)).toBeNull();
  });
  it('tells the customer when a unit does not exist', () => {
    render(<SiteModelPanel model={model} mode="customer" images={{}} />);
    fireEvent.change(screen.getByLabelText('Unit number'), { target: { value: 'Z999' } });
    fireEvent.submit(screen.getByLabelText('Unit number').closest('form'));
    expect(screen.getByRole('alert').textContent).toMatch(/No unit Z999/);
  });
  it('opens on the Satellite look, switches to Illustrated and remembers the choice', () => {
    localStorage.removeItem('nexus.siteModel.look'); styles.length = 0;
    const { unmount } = render(<SiteModelPanel model={model} mode="customer" images={{}} />);
    expect(styles.at(-1)).toBe('satellite');   // production's look is the default (Oct 20)
    expect(screen.getByText(/Imagery: Esri · 1 unit = 1 m/)).toBeTruthy();
    // production's look buttons; no Realistic 3D without a Google key
    const looks = screen.getByRole('group', { name: 'View' });
    expect([...looks.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Satellite', 'Illustrated']);
    fireEvent.click(screen.getByRole('button', { name: 'Illustrated' }));
    expect(styles.at(-1)).toBe('illustrated');
    expect(screen.getByText(/Illustrated, drawn to scale/)).toBeTruthy();
    unmount();
    render(<SiteModelPanel model={model} mode="customer" images={{}} />);
    expect(styles.at(-1)).toBe('illustrated');
    localStorage.removeItem('nexus.siteModel.look');
  });
  it('never opens Realistic 3D without a key: a remembered choice falls back to Satellite', () => {
    localStorage.setItem('nexus.siteModel.look', 'photoreal'); styles.length = 0;
    render(<SiteModelPanel model={model} mode="owner" images={{}} />);
    expect(styles.at(-1)).toBe('satellite');
    expect(screen.getByRole('button', { name: 'Satellite' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Realistic 3D' })).toBeNull();
    localStorage.removeItem('nexus.siteModel.look');
  });
  it('keeps the production map buttons: camera, See Inside and the levels', () => {
    render(<SiteModelPanel model={model} mode="owner" images={{}} />);
    ['Reset View', 'Overview', 'Plan', 'From Gate', 'See Inside', 'All Levels', 'L1', 'L2'].forEach((n) => expect(screen.getByRole('button', { name: n })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'L2' }));
    expect(screen.getByRole('button', { name: 'L2' }).getAttribute('aria-pressed')).toBe('true');
  });
  it('one status per unit: a lease beats the ACTIVE_LEASE unrentable flag everywhere', () => {
    localStorage.setItem('nexus.siteModel.look', 'satellite');
    const m = { ...model, units: [...model.units, { n: 'C002', b: 'C', f: 1, u: 4, v: 0, wu: 3, dv: 6, door: 'sw', k: 'du', w: 10, d: 20, l: 1, r: 0, why: 'ACTIVE_LEASE' }] };
    render(<SiteModelPanel model={m} mode="owner" images={{}} />);
    expect(screen.getByText('Needs Attention (1)')).toBeTruthy();          // C001 only, not the leased C002
    fireEvent.change(screen.getByLabelText('Unit number'), { target: { value: 'C002' } });
    fireEvent.submit(screen.getByLabelText('Unit number').closest('form'));
    const card = screen.getAllByText('C002').find((el) => el.closest('section'))?.closest('section');
    expect(card.textContent).toMatch(/Leased/);
    expect(card.textContent).not.toMatch(/Out of Service/);
    localStorage.removeItem('nexus.siteModel.look');
  });
  it('draws the dashboard cards in the illustrated look: route for customers, KPIs and attention for owners', () => {
    localStorage.setItem('nexus.siteModel.look', 'illustrated');
    const { unmount } = render(<SiteModelPanel model={model} mode="customer" images={{}} />);
    fireEvent.change(screen.getByLabelText('Unit number'), { target: { value: 'C214' } });
    fireEvent.submit(screen.getByLabelText('Unit number').closest('form'));
    expect(screen.getByLabelText('Route to C214')).toBeTruthy();
    expect(screen.getAllByText('Level 2').length).toBeGreaterThan(1);   // the route card and the route step chips
    expect(screen.queryByText('Out of Service')).toBeNull();   // customers never see occupancy
    unmount();
    render(<SiteModelPanel model={model} mode="owner" images={{}} />);
    expect(screen.getByText('Attention 1')).toBeTruthy();
    expect(screen.getAllByText('Damage').length).toBeGreaterThan(0);   // DAMAGE reads as Title Case
    localStorage.removeItem('nexus.siteModel.look');
  });
});

