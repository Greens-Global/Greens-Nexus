// Render-smoke test for Operations > Site Map: the tab renders the site model,
// switching a layer recolors the units and swaps the legend, a missing
// maintenance endpoint reads "not connected yet" instead of failing, the unit
// card shows the tenant, the lease facts and the unit's tickets, and ONE status
// per unit drives the badge, the tiles and the colors. jsdom has no WebGL: the
// viewer is mocked and records what it was told.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const calls = { colors: [], markers: [], styles: [] };
vi.mock('../sitemodel/siteModelViewer.js', async () => {
  const real = await vi.importActual('../sitemodel/siteModelViewer.js');
  return {
    ...real,
    createSiteModelViewer: (container, model, opts) => {
      calls.colors.push(opts.colors); calls.styles.push(opts.style);
      return {
        selectUnit: (n) => { const u = model.units.find((x) => x.n === n); if (!u) return false; opts.onSelectUnit(u); return true; },
        clearSelection: () => opts.onSelectUnit(null), setMode() {}, setXray() {}, setLevel() {}, setPins() {}, setMarkers: (m) => calls.markers.push(m), setPlacing() {}, setBackground() {}, view() {}, flyToPin() {},
        setUnitColors: (c) => calls.colors.push(c), flyToStep() {}, resetView() {}, getRoute: () => null, getState: () => ({}), destroy() {},
      };
    },
  };
});
vi.mock('../asset/components/maintenance/ticketMounts', () => ({
  PropertyTicketDrawer: ({ ticketId }) => <div role="dialog" aria-label="Ticket">{`Ticket ${ticketId}`}</div>,
  PropertyTicketComposer: ({ property }) => <div role="dialog" aria-label="New Ticket">{`New ticket at ${property.name} unit ${property.unit}`}</div>,
}));

const model = {
  property: { id: 'greens-storage-escondido', name: 'Greens Storage Escondido' },
  frame: { north: [-0.78, 0.62] }, image: { attribution: 'Imagery: Esri' },
  buildings: [{ id: 'C', letters: ['C'], name: 'Building C', u: [0, 100], v: [0, 20], height: 7, floors: 2, roof: 'solar' }],
  zones: [], gates: [{ id: 'main', name: 'Main Gate', uv: [50, 30] }],
  units: [{ n: 'C214', b: 'C', f: 2, u: 10, v: 2, wu: 3, dv: 4.5, door: 'ne', k: 'cc', w: 10, d: 15, l: 0, r: 1, dvac: 160 },
          { n: 'C001', b: 'C', f: 1, u: 0, v: 0, wu: 3, dv: 6, door: 'sw', k: 'du', w: 10, d: 20, l: 1, r: 0, why: 'ACTIVE_LEASE' },
          { n: 'C002', b: 'C', f: 1, u: 4, v: 0, wu: 3, dv: 6, door: 'sw', k: 'du', w: 10, d: 20, l: 0, r: 0, why: 'REPAIRS_REQUIRED', note: 'Door spring' }],
  layout: { schematic: false }, sources: ['Cubby export'], live: { source: 'cubby', unplaced: [{ n: 'Q001', w: 10, d: 20, k: 'park', l: 1, r: 1 }], missing: [] },
};
const facts = {
  C214: { status: 'vacant', daysVacant: 160, street: 9000, rate: 9000, market: 'under', marketPct: -10, marketMedian: 10000, marketCount: 3, type: '10x15 CC' },
  C001: { status: 'rented', rent: 18000, street: 19400, rate: 18000, type: '10x20 Drive-Up' },
  C002: { status: 'off-market', street: 19400, rate: 19400, type: '10x20 Drive-Up' },
};
const unitCard = {
  unit: 'C001', status: 'rented', street: 19400, connected: true,
  tenant: { name: 'Pat Example', moveIn: '2024-07-01', daysInUnit: 841, rent: 18000, balance: 14450, daysPastDue: 35, paidThrough: '2026-09-15',
    autoPay: false, rentChange: { date: '2026-12-01', rent: 19000 }, moveOut: '', overlocked: false, leaseStatus: 'past-due', cubbyUrl: 'https://app.cubbystorage.com/tenants/cust_9' },
  tickets: { property: { id: 'esc', name: 'Greens Storage Escondido' },
    open: [{ id: 't1', subject: 'Gate code not working', status: 'open', createdAt: '2026-10-01T10:00:00Z', closed: false }],
    recent: [{ id: 't2', subject: 'Light out', status: 'resolved', createdAt: '2026-09-01T10:00:00Z', resolvedAt: '2026-09-02T10:00:00Z', closed: true }] },
};

vi.mock('../api', () => ({
  api: {
    getOpsSiteMap: vi.fn(async () => ({ facilityId: 'fac_1', modelId: 'greens-storage-escondido', model, facts, entrance: { lat: 33.17, lng: -117.1, source: 'gate', name: 'Main Gate', mapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=33.17,-117.1' }, cubbyTemplate: 'https://nexus/find/u?f=x&k=y&unit=${unit.name}', marketBand: 0.05 })),
    getOpsMaintenanceMap: vi.fn(async () => { const e = new Error('Not Found'); e.status = 404; throw e; }),
    getOpsCustomerLink: vi.fn(async () => ({ url: 'https://nexus/find/abc', unit: 'C214' })),
    getOpsSiteMapUnit: vi.fn(async (fac, unit) => (unit === 'C001' ? unitCard : { unit, status: 'vacant', street: 9000, connected: true, tenant: null, daysVacant: 160, tickets: { property: null, open: [], recent: [] } })),
    saveOpsEntrance: vi.fn(),
    facilityOpsLookup: vi.fn(async () => ({ results: [
      { facilityId: 'fac_1', facility: 'Escondido', unit: 'C001', tenant: 'Pat Example', status: 'rented' },
      { facilityId: 'fac_2', facility: 'Vista', unit: 'B102', tenant: 'Pat Other', status: 'rented' },
      { facilityId: 'fac_3', facility: 'Temecula', unit: 'A015', tenant: 'Pat Third', status: 'rented', url: 'https://app.cubbystorage.com/tenants/cust_3' },
    ] })),
  },
}));

import SiteMap from './SiteMap';

const SEARCH = 'Find a unit or tenant';
const pick = (n) => { const box = screen.getByRole('combobox', { name: SEARCH }); fireEvent.change(box, { target: { value: n } }); fireEvent.submit(box.closest('form')); };
const cardOf = (n) => screen.getAllByText(n).map((el) => el.closest('section')).find(Boolean);

beforeEach(() => { calls.colors.length = 0; calls.markers.length = 0; calls.styles.length = 0; localStorage.removeItem('nexus.ops.siteMap.layer'); localStorage.removeItem('nexus.siteModel.look'); });

describe('Operations > Site Map', () => {
  it('points to the page Facility menu when no single facility is picked - no picker of its own', async () => {
    render(<SiteMap facility={null} />);
    expect(await screen.findByText('Pick a facility above to see the Site Map.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Escondido' })).toBeNull();
  });

  it('tells the page when its own search is on screen, so the page Lookup stands in otherwise', async () => {
    const seen = [];
    const onMapSearch = (v) => seen.push(v);
    const { rerender } = render(<SiteMap facility={{ id: 'fac_1', shortName: 'Escondido' }} onMapSearch={onMapSearch} />);
    expect(seen[0]).toBe(false);                      // loading: no map search yet
    await screen.findByRole('combobox', { name: SEARCH });
    expect(seen.at(-1)).toBe(true);
    rerender(<SiteMap facility={null} onMapSearch={onMapSearch} />);
    await waitFor(() => expect(seen.at(-1)).toBe(false));
  });

  it('opens on the Illustrated look with Inventory, then Needs Attention open and the rest folded', async () => {
    render(<SiteMap facility={{ id: 'fac_1', shortName: 'Escondido' }} />);
    expect(await screen.findByLabelText('Layer')).toHaveProperty('value', 'occupancy');
    expect(calls.styles.at(-1)).toBe('illustrated');
    expect(screen.getByText('Needs Attention (1)').closest('button').getAttribute('aria-expanded')).toBe('true');   // fills the panel, scrolls on its own
    expect(screen.queryByRole('button', { name: /Show All/ })).toBeNull();
    for (const t of ['Not on the Map (1)', 'Sources']) {
      expect(screen.getByText(t).closest('details').open).toBe(false);
    }
    expect(screen.getByText(/Pick a unit on the map or search/)).toBeTruthy();
    // the entrance + template link moved behind a button into a dialog
    expect(screen.queryByText('Customer Entrance')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Customer Link Settings' }));
    expect(await screen.findByText('Customer Entrance')).toBeTruthy();
    expect(screen.getByLabelText('Cubby template link').value).toContain('${unit.name}');
  });

  it('switches layers and their legends; tiles and colors read one status', async () => {
    render(<SiteMap facility={{ id: 'fac_1', shortName: 'Escondido' }} />);
    expect(await screen.findByLabelText('Layer')).toHaveProperty('value', 'occupancy');
    // the leased-but-unrentable unit is leased, not out of service
    await waitFor(() => expect(calls.colors.at(-1)).toMatchObject({ C001: '#5fae7d', C214: '#e0b45a', C002: '#d65a4c' }));
    const tiles = screen.getByText(/^Inventory/).closest('section');
    expect(within(tiles).getByText('Leased').parentElement.textContent).toBe('1Leased');
    expect(within(tiles).getByText('Out of Service').parentElement.textContent).toBe('1Out of Service');

    fireEvent.change(screen.getByLabelText('Layer'), { target: { value: 'days' } });
    await waitFor(() => expect(calls.colors.at(-1).C001).toBe('#cfcac0'));
    expect(screen.getByText('180+')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Layer'), { target: { value: 'market' } });
    await waitFor(() => expect(calls.colors.at(-1).C214).toBe('#2563eb'));
    expect(screen.getByText(/Under Market \(1\)/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Layer'), { target: { value: 'maintenance' } });
    expect((await screen.findAllByText(/Maintenance layer not connected yet/)).length).toBeGreaterThan(0);
  });

  it('a leased unit card: the badge says Leased, with the tenant, the money, Cubby and the tickets', async () => {
    render(<SiteMap facility={{ id: 'fac_1', shortName: 'Escondido' }} />);
    await screen.findByRole('combobox', { name: SEARCH });
    pick('C001');
    expect(await screen.findByText('Pat Example')).toBeTruthy();
    const card = cardOf('C001');
    expect(within(card).getByText('Leased')).toBeTruthy();                 // badge agrees with the rent roll
    expect(within(card).queryByText('Out of Service')).toBeNull();
    expect(card.textContent).toMatch(/07\/01\/2024 · 2 yr 3 mo/);
    expect(card.textContent).toMatch(/\$180\/mo vs street \$194 \(\$14 under\)/);
    expect(card.textContent).toMatch(/\$144\.50 past due · 35 days/);
    expect(card.textContent).toMatch(/Autopay\s*Off/);
    expect(card.textContent).toMatch(/\$190\/mo on 12\/01\/2026/);
    expect(card.textContent).toMatch(/Lease Status\s*Past Due/);
    expect(within(card).getByText('Open in Cubby ↗').closest('a').getAttribute('href')).toBe('https://app.cubbystorage.com/tenants/cust_9');
    expect(within(card).getByText('Tickets (1 Open)')).toBeTruthy();
    expect(within(card).getByText('Light out')).toBeTruthy();
    fireEvent.click(within(card).getByText('Gate code not working'));
    expect(screen.getByRole('dialog', { name: 'Ticket' }).textContent).toBe('Ticket t1');
    fireEvent.click(within(card).getByRole('button', { name: 'Report an Issue' }));
    expect(screen.getByRole('dialog', { name: 'New Ticket' }).textContent).toBe('New ticket at Greens Storage Escondido unit C001');
  });

  it('a vacant unit card: days vacant, street rate, vs market, and the customer link', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
    render(<SiteMap facility={{ id: 'fac_1', shortName: 'Escondido' }} />);
    await screen.findByRole('combobox', { name: SEARCH });
    pick('C214');
    const card = cardOf('C214');
    expect(within(card).getByText('Vacant')).toBeTruthy();
    expect(card.textContent).toMatch(/Days Vacant\s*160/);
    expect(card.textContent).toMatch(/\$90 vs \$100 median, 10% under/);
    expect(await within(card).findByText('No open tickets on this unit.')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Report an Issue' }).disabled).toBe(true);   // no property linked
    fireEvent.click(within(card).getByRole('button', { name: 'Copy Customer Link' }));
    expect(await within(card).findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://nexus/find/abc');
    expect(screen.queryByText(/^Pins/)).toBeNull();   // no pin grant on this screen
  });

  // Visesh, Oct 20: "this looks glitchy when you have to scroll down to see options".
  it('puts every control on the map: one search, Layer, View, camera and the legend', async () => {
    render(<SiteMap facility={{ id: 'fac_1', shortName: 'Escondido' }} />);
    expect(await screen.findAllByRole('combobox', { name: SEARCH })).toHaveLength(1);
    expect(screen.queryByLabelText('Unit number')).toBeNull();               // the old full-width search row is gone
    expect(screen.queryByRole('button', { name: 'Find' })).toBeNull();
    expect(screen.getByLabelText('Layer')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'View' }).value).toBe('illustrated');
    for (const b of ['Reset View', 'Overview', 'Plan', 'From Gate', 'Customer Link Settings', 'About This Layer']) {
      expect(screen.getByRole('button', { name: b })).toBeTruthy();
    }
    expect(screen.getByRole('combobox', { name: 'Level' })).toBeTruthy();   // a dropdown, not a row of level buttons
    const stage = document.querySelector('.sm-stage');
    expect(stage.contains(screen.getByRole('combobox', { name: SEARCH }))).toBe(true);
    expect(stage.contains(screen.getByLabelText('Layer'))).toBe(true);
    // the layer's explanation sits behind the legend's info button
    fireEvent.click(screen.getByRole('button', { name: 'About This Layer' }));
    expect(screen.getByRole('tooltip').textContent).toMatch(/Green is leased/);
  });

  it('finds a tenant here, opens a unit at another facility, and offers Cubby where there is no map', async () => {
    const onPick = vi.fn();
    render(<SiteMap facility={{ id: 'fac_1', shortName: 'Escondido' }} onPick={onPick} modelIds={['fac_1', 'fac_2']}
      facilities={[{ id: 'fac_1', shortName: 'Escondido' }, { id: 'fac_2', shortName: 'Vista' }, { id: 'fac_3', shortName: 'Temecula' }]} />);
    const box = await screen.findByRole('combobox', { name: SEARCH });
    fireEvent.change(box, { target: { value: 'pat' } });
    expect(await screen.findByText('Pat Third')).toBeTruthy();
    expect(screen.getByText('Tenants and Other Facilities')).toBeTruthy();
    expect(screen.getByText('No Site Map Yet', { exact: false })).toBeTruthy();
    expect(screen.getByText(/Open in Cubby/).closest('a').getAttribute('href')).toBe('https://app.cubbystorage.com/tenants/cust_3');
    fireEvent.click(screen.getByText('Pat Example'));
    expect(await screen.findByText('Pat Example', { selector: 'dd' })).toBeTruthy();   // the unit card opened on C001
    fireEvent.change(box, { target: { value: 'pat' } });
    fireEvent.click(await screen.findByText('Pat Other'));
    expect(onPick).toHaveBeenCalledWith('fac_2');
  });

  it('says inside the search when a unit is not here, and the card closes with its X', async () => {
    render(<SiteMap facility={{ id: 'fac_1', shortName: 'Escondido' }} />);
    await screen.findByRole('combobox', { name: SEARCH });
    pick('Z999');
    expect(screen.getByRole('status').textContent).toMatch(/No unit Z999 at Escondido/);
    pick('C002');
    const card = cardOf('C002');
    expect(within(card).getAllByText('Out of Service').length).toBe(2);   // badge + heading, never "Vacancy"
    expect(card.textContent).toMatch(/Reason.*Door spring/);
    expect(card.textContent).not.toMatch(/Days Vacant/);
    fireEvent.click(within(card).getByRole('button', { name: 'Close Unit C002' }));
    expect(cardOf('C002')).toBeUndefined();
  });
});
