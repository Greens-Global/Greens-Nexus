import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Rate Management (Neil / Miranda, Oct 20 2026): the CMA table renders grouped
// by category with subtotals, the facility is a dropdown (not chips), a typed
// Proposed rate is saved as a draft, and Review & Push lists old -> new and
// shows a result per row.

const apiMock = vi.hoisted(() => ({
  getOpsRates: vi.fn(), saveOpsRateDraft: vi.fn(), pushOpsRates: vi.fn(), getOpsRateHistory: vi.fn(),
  checkOpsCompetitor: vi.fn(), getOpsMarket: vi.fn(), getOpsNearby: vi.fn(),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));

import RateManagement from './RateManagement';

const FACILITIES = [{ id: 'fac_f', shortName: 'Fairfield' }, { id: 'fac_t', shortName: 'Temecula' }];
const row = (over) => ({
  name: "8' x 10'", category: 'Self-Storage', groupId: 'pg_810', ambiguous: false, width: 8, depth: 10, parking: false,
  total: 2, rented: 0, vacant: 2, offline: 0, occupancy: 0, set: 11900, sell: 11350, walkIn: 10200, valuePricing: '',
  competitors: 6, marketLow: 10300, marketHigh: 19900, marketMedian: 13353, lowestBy: 'StorQuest', newestObservation: '2026-10-15',
  sources: ['web'], variance: -2003, variancePct: -0.15, suggested: 11400, why: '0% occupied: a lot of vacancy.',
  draft: null, proposed: null, proposedSet: null, revDelta: 0, ready: false, ...over,
});
const view = (rows, over) => ({
  facilityId: 'fac_f', facility: 'Fairfield', name: 'Greens Storage Fairfield', asOf: '2026-10-20',
  address: '5044 Peabody Road, Fairfield, CA 94533', billingCycle: 'MONTHLY', lastSurvey: '2026-10-15',
  cubbyGroups: { ok: true, count: 3, error: '' }, compSet: { active: 8, web: 5, stortrack: 0, manual: 3, closed: 1 },
  kpis: { vsMarket: -0.157, rateable: 6, belowMarket: 5, occupancy: 0.697, units: 307, rented: 214, offline: 13,
    ready: rows.filter((r) => r.ready).length, readyDelta: rows.reduce((a, r) => a + (r.ready ? r.revDelta : 0), 0) },
  attention: ["12' x 20' Parking is fully offline (11 units)"], rows,
  competitors: [], freshDays: 120, minCompetitors: 2, pushes: [], canEdit: true, canPush: true, ...over,
});
const ROWS = [
  row(),
  row({ name: "12' x 30' Parking", category: 'Vehicle Storage', groupId: 'pg_1230', total: 6, rented: 5, vacant: 1, occupancy: 0.833,
    set: 11900, sell: 13150, marketMedian: 13130, variance: 20, variancePct: 0.002 }),
];

beforeEach(() => {
  Object.values(apiMock).forEach((f) => f.mockReset());
});

describe('Rate Management', () => {
  it('points at the page Facility dropdown, then renders the table grouped by category', async () => {
    // The facility is the Operations page's one dropdown (Oct 20): no picker of its own.
    const { rerender } = render(<RateManagement facility={null} />);
    expect(screen.getByText(/Pick a facility above to see Rate Management/)).toBeTruthy();
    expect(screen.queryByLabelText('Facility')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fairfield' })).toBeNull();          // no chips

    apiMock.getOpsRates.mockResolvedValue(view(ROWS));
    rerender(<RateManagement facility={FACILITIES[0]} />);
    expect(screen.queryByLabelText('Facility')).toBeNull();
    expect(await screen.findByText('Greens Storage Fairfield')).toBeTruthy();
    expect(apiMock.getOpsRates).toHaveBeenCalledWith('fac_f');
    expect(screen.getByText('5044 Peabody Road, Fairfield, CA 94533')).toBeTruthy();
    expect(screen.getByText('8 active')).toBeTruthy();
    expect(screen.getByText('-15.7%')).toBeTruthy();
    expect(screen.getByText('Subtotal Self-Storage')).toBeTruthy();
    expect(screen.getByText('Subtotal Vehicle Storage')).toBeTruthy();
    expect(screen.getByText('-$20.03 - -15.0%')).toBeTruthy();
    expect(screen.getByText('0 changes ready for Cubby')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review & Push to Cubby' }).disabled).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Vehicle Storage' }));
    expect(screen.queryByText('Subtotal Self-Storage')).toBeNull();
    expect(screen.getByText('Subtotal Vehicle Storage')).toBeTruthy();
  });

  it('saves a typed Proposed rate as a draft', async () => {
    apiMock.getOpsRates.mockResolvedValue(view(ROWS));
    const saved = view([row({ proposed: 11500, proposedSet: 12050, revDelta: 300, ready: true,
      draft: { proposed: 11500, proposedSet: null, note: '', updatedBy: 'miranda@greensglobal.com', updatedAt: '2026-10-20T18:00:00Z' } }), ROWS[1]]);
    apiMock.saveOpsRateDraft.mockResolvedValue(saved);
    render(<RateManagement facility={FACILITIES[0]} facilities={FACILITIES} onPick={() => {}} />);
    const input = await screen.findByLabelText("Proposed rate for 8' x 10'");
    fireEvent.change(input, { target: { value: '115' } });
    fireEvent.blur(input);
    await waitFor(() => expect(apiMock.saveOpsRateDraft).toHaveBeenCalledWith({ facility_id: 'fac_f', unit_type: "8' x 10'", proposed: 115 }));
    expect(await screen.findByText('1 change ready for Cubby')).toBeTruthy();
    expect(screen.getAllByText('+$3').length).toBeGreaterThan(0);
  });

  it('reviews old to new and shows a result per row after the push', async () => {
    const ready = [row({ proposed: 11500, proposedSet: 12050, revDelta: 300, ready: true,
      draft: { proposed: 11500, proposedSet: null, note: '', updatedBy: 'miranda@greensglobal.com', updatedAt: '2026-10-20T18:00:00Z' } }),
    { ...ROWS[1], proposed: 13500, proposedSet: 12250, revDelta: 350, ready: true, draft: { proposed: 13500 } }];
    apiMock.getOpsRates.mockResolvedValue(view(ready));
    apiMock.pushOpsRates.mockResolvedValue({ batchId: 'b1', view: view(ROWS), results: [
      { unitType: "8' x 10'", status: 'ok', detail: 'Updated in Cubby' },
      { unitType: "12' x 30' Parking", status: 'failed', detail: 'Access Denied' },
    ] });
    render(<RateManagement facility={FACILITIES[0]} facilities={FACILITIES} onPick={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review & Push to Cubby' }));
    const dialog = await screen.findByRole('dialog');
    const table = within(dialog).getByTestId('review-table');
    expect(table.textContent).toContain('$113.50 → $115');
    expect(table.textContent).toContain('$119 → $120.50');
    expect(within(dialog).getByText(/2 changes, \+\$6\.50 per month/)).toBeTruthy();

    fireEvent.click(within(dialog).getByLabelText("Include 12' x 30' Parking"));
    expect(within(dialog).getByText(/1 change, \+\$3 per month/)).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText("Include 12' x 30' Parking"));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Push 2 to Cubby' }));
    await waitFor(() => expect(apiMock.pushOpsRates).toHaveBeenCalledWith('fac_f', ["8' x 10'", "12' x 30' Parking"]));
    expect(await within(dialog).findByText('Pushed')).toBeTruthy();
    expect(within(dialog).getByText('Failed')).toBeTruthy();
    expect(within(dialog).getByText('Access Denied')).toBeTruthy();
  });

  it('opens the rate history for a unit type', async () => {
    apiMock.getOpsRates.mockResolvedValue(view(ROWS));
    apiMock.getOpsRateHistory.mockResolvedValue({ unitType: "8' x 10'", ours: [
      { id: 'p1', oldSell: 11000, newSell: 11350, oldSet: 11500, newSet: 11900, pushedBy: 'neil@greensglobal.com', pushedAt: '2026-10-01T17:00:00Z', status: 'ok', detail: '' }],
    competitors: [{ competitorId: 'c1', competitor: 'StorQuest', rate: 10300, observedOn: '2026-10-15', source: 'web', promo: '' }] });
    render(<RateManagement facility={FACILITIES[0]} facilities={FACILITIES} onPick={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: "8' x 10'" }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('StorQuest')).toBeTruthy();
    expect(within(dialog).getByText('$110 → $113.50')).toBeTruthy();
    expect(apiMock.getOpsRateHistory).toHaveBeenCalledWith('fac_f', "8' x 10'");
  });
});
