import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Market Rates fed by StorTrack (Oct 2026): until the Cubby warehouse key is
// set the tab says "StorTrack not connected yet" and never shows an error;
// once connected it shows when StorTrack last synced, a Sync Now button for
// managers, and a StorTrack / Website / Manual chip on each rate.

const apiMock = vi.hoisted(() => ({ getOpsMarket: vi.fn(), getOpsNearby: vi.fn(), syncOpsStorTrack: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));
const roleMock = vi.hoisted(() => ({ level: 3 }));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: (r) => ({ employee: 1, supervisor: 2, manager: 3 })[r] <= roleMock.level }),
}));

import Market from './Market';

const FACILITY = { id: 'fac_1', shortName: 'Temecula' };
const rate = (over) => ({ id: 'r', competitorId: 'c1', width: 10, depth: 10, parking: false, rate: 15000, promo: '',
  observedOn: '2026-10-10', enteredBy: 'stortrack', source: 'stortrack', online: 13500, promoRate: null, ...over });
const market = (stortrack) => ({
  facilityId: 'fac_1', facility: 'Temecula', asOf: '2026-10-13', freshDays: 120, minCompetitors: 2,
  competitors: [
    { id: 'c1', name: 'Extra Space Storage', distanceMiles: 0, ratesUrl: '', watch: false, lastStatus: '', rates: [rate()] },
    { id: 'c2', name: 'Corner Storage', distanceMiles: 1.2, ratesUrl: '', watch: true, lastStatus: '', rates: [rate({ id: 'r2', competitorId: 'c2', source: 'manual', rate: 12000 })] },
  ],
  rows: [{ name: "10' x 10'", width: 10, depth: 10, parking: false, total: 100, rented: 90, vacant: 10, street: 14000,
    averageRent: 13000, competitors: 2, marketLow: 12000, marketMedian: 13500, marketHigh: 15000, lowestBy: 'Corner Storage',
    newestObservation: '2026-10-10', sources: ['manual', 'stortrack'], suggested: 14000, why: 'ok', change: 0, monthlyImpact: 0 }],
  moves: [],
  engine: { connected: true, everyHours: 24 },
  stortrack,
});

beforeEach(() => {
  roleMock.level = 3;
  apiMock.getOpsNearby.mockReset().mockResolvedValue({ facilities: [], radiusMiles: 5, attribution: 'OSM' });
  apiMock.syncOpsStorTrack.mockReset();
  apiMock.getOpsMarket.mockReset();
});

describe('Market Rates - StorTrack', () => {
  it('says not connected yet, with a hint and no error, before the key is set', async () => {
    apiMock.getOpsMarket.mockResolvedValue(market({ connected: false, hint: 'Rates appear once the Cubby warehouse key is set.', lastSyncedAt: '' }));
    render(<Market facility={FACILITY} facilities={[FACILITY]} onPick={vi.fn()} />);
    const box = await screen.findByTestId('stortrack-status');
    expect(box.textContent).toContain('StorTrack not connected yet');
    expect(box.textContent).toContain('Cubby warehouse key');
    expect(screen.queryByRole('button', { name: /Sync StorTrack Now/ })).toBeNull();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it('shows the last sync in US format, the source chips, and syncs on demand', async () => {
    const synced = new Date(2026, 9, 20, 9, 5).toISOString();
    const st = { connected: true, lastSyncedAt: synced, lastStatus: 'ok', running: false, everyHours: 6 };
    apiMock.getOpsMarket.mockResolvedValue(market(st));
    const after = market({ ...st, lastSyncedAt: new Date(2026, 9, 20, 14, 30).toISOString() });
    apiMock.syncOpsStorTrack.mockResolvedValue({ result: { status: 'ok' }, market: after });
    render(<Market facility={FACILITY} facilities={[FACILITY]} onPick={vi.fn()} />);
    const box = await screen.findByTestId('stortrack-status');
    expect(box.textContent).toContain('StorTrack last synced 10/20/2026 9:05 AM');
    expect(screen.getAllByText('StorTrack').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Manual').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /Sync StorTrack Now/ }));
    await waitFor(() => expect(apiMock.syncOpsStorTrack).toHaveBeenCalledWith('fac_1'));
    await waitFor(() => expect(screen.getByTestId('stortrack-status').textContent).toContain('10/20/2026 2:30 PM'));
  });

  it('offers Sync Now to managers only', async () => {
    roleMock.level = 2;
    apiMock.getOpsMarket.mockResolvedValue(market({ connected: true, lastSyncedAt: '', lastStatus: '', running: false }));
    render(<Market facility={FACILITY} facilities={[FACILITY]} onPick={vi.fn()} />);
    const box = await screen.findByTestId('stortrack-status');
    expect(box.textContent).toContain('StorTrack has not synced yet');
    expect(screen.queryByRole('button', { name: /Sync StorTrack Now/ })).toBeNull();
  });
});
