import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Rate Management (Neil / Miranda, Oct 20 2026): the CMA table renders grouped
// by category with subtotals, the facility is a dropdown (not chips), a typed
// Proposed rate is saved as a draft, and Review Changes lists old -> new and
// marks rows Entered in Cubby (per row or all ticked). Nexus never writes to
// Cubby (Oct 20 2026): the Push button is shown but DISABLED - manual entry only.

const apiMock = vi.hoisted(() => ({
  getOpsRates: vi.fn(), saveOpsRateDraft: vi.fn(), markOpsRatesEntered: vi.fn(), getOpsRateHistory: vi.fn(),
  checkOpsCompetitor: vi.fn(), getOpsMarket: vi.fn(), getOpsNearby: vi.fn(), getOpsRateComps: vi.fn(),
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
  draft: null, proposed: null, proposedSet: null, revDelta: 0, ready: false,
  position: 'below', reason: 'Vacancy: Raise', held: false, offlineOnly: false, hasWeb: true, hasWalkIn: true,
  staleComps: 1, suggestedDelta: 100, ...over,
});
const view = (rows, over) => ({
  facilityId: 'fac_f', facility: 'Fairfield', name: 'Greens Storage Fairfield', asOf: '2026-10-20',
  address: '5044 Peabody Road, Fairfield, CA 94533', billingCycle: 'MONTHLY', lastSurvey: '2026-10-15',
  cubbyGroups: { ok: true, count: 3, error: '' }, compSet: { active: 8, web: 5, stortrack: 0, manual: 3, closed: 1 },
  kpis: { vsMarket: -0.157, rateable: 6, belowMarket: 5, occupancy: 0.697, units: 307, rented: 214, offline: 13,
    ready: rows.filter((r) => r.ready).length, readyDelta: rows.reduce((a, r) => a + (r.ready ? r.revDelta : 0), 0) },
  attention: ["12' x 20' Parking is fully offline (11 units)"], rows,
  headline: { below: 5, at: 1, above: 2, noMarket: 3, offline: 1, suggestions: 6, upside: 7550, raises: 9550, cuts: -2000 },
  gaps: [
    { key: 'no_market', title: 'No Competitor Rate', count: 1, items: ["10' x 11'"], action: "Add a competitor rate for these sizes by hand under Manage Competitors." },
    { key: 'offline', title: 'Offline Only', count: 1, items: ["12' x 20' Parking (11)"], action: 'These are offline units - nothing to price.' },
  ],
  staleDays: 30,
  competitors: [
    { id: 'c1', name: 'StorQuest', address: '1 Main St', distanceMiles: 1.24, source: 'web', lastUpdated: '2026-10-15', sizes: 9, ratesUrl: '', watch: false },
    { id: 'c2', name: 'Extra Space', address: '', distanceMiles: null, source: 'stortrack', lastUpdated: '2026-10-12', sizes: 4, ratesUrl: '', watch: false },
  ],
  freshDays: 120, minCompetitors: 2, pushes: [], canEdit: true, canMark: true, ...over,
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
    // The summary: who we compare with and what is missing.
    const summary = screen.getByTestId('market-summary');
    expect(within(summary).getByText('Compared With 2 Competitors')).toBeTruthy();
    expect(within(summary).getByText('1.2 mi')).toBeTruthy();
    expect(within(summary).getByText('Distance not recorded')).toBeTruthy();
    expect(within(summary).getByText('Updated 10/15/2026')).toBeTruthy();
    expect(within(summary).getByText('Website')).toBeTruthy();
    expect(within(summary).getByText("No Competitor Rate")).toBeTruthy();
    expect(within(summary).getByText("10' x 11'")).toBeTruthy();
    expect(within(summary).getByText(/nothing to price/)).toBeTruthy();
    expect(within(summary).getByText('-15.7%')).toBeTruthy();
    expect(within(summary).getByText('+$75.50 / Mo')).toBeTruthy();
    expect(screen.getByText('Subtotal Self-Storage')).toBeTruthy();
    expect(screen.getByText('Subtotal Vehicle Storage')).toBeTruthy();
    // Plain variance, a position chip and a short reason.
    expect(screen.getByText('$20.03 below (15%)')).toBeTruthy();
    expect(screen.getAllByText('15% Below Market').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Vacancy: Raise').length).toBeGreaterThan(0);
    expect(screen.queryByText(/- -/)).toBeNull();
    expect(screen.getByText('0 changes ready')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review Changes' }).disabled).toBe(true);
    expect(screen.getByText(/Nexus doesn't change rates in Cubby/)).toBeTruthy();
    // Shown but off: disabled, and it says why (manual entry only).
    for (const b of screen.getAllByRole('button', { name: /push/i })) expect(b).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Unit Category'), { target: { value: 'Vehicle Storage' } });
    expect(screen.queryByText('Subtotal Self-Storage')).toBeNull();
    expect(screen.getByText('Subtotal Vehicle Storage')).toBeTruthy();
  });

  it('saves a typed Proposed rate as a draft', async () => {
    apiMock.getOpsRates.mockResolvedValue(view(ROWS));
    const saved = view([row({ proposed: 11500, proposedSet: 12050, revDelta: 300, ready: true,
      draft: { proposed: 11500, proposedSet: null, note: '', updatedBy: 'miranda@greensglobal.com', updatedAt: '2026-10-20T18:00:00Z' } }), ROWS[1]]);
    apiMock.saveOpsRateDraft.mockResolvedValue(saved);
    render(<RateManagement facility={FACILITIES[0]} facilities={FACILITIES} onPick={() => {}} />);
    // Wait for the rates to load before typing: on a slow CI runner the input can
    // render, then re-render from the loaded view and drop a value typed too early.
    await waitFor(() => expect(apiMock.getOpsRates).toHaveBeenCalled());
    await waitFor(() => {
      const input = screen.getByLabelText("Proposed rate for 8' x 10'");
      fireEvent.change(input, { target: { value: '115' } });
      fireEvent.blur(input);
      expect(apiMock.saveOpsRateDraft).toHaveBeenCalledWith({ facility_id: 'fac_f', unit_type: "8' x 10'", proposed: 115 });
    }, { timeout: 4000 });
    expect(await screen.findByText('1 change ready')).toBeTruthy();
    expect(screen.getAllByText('+$3').length).toBeGreaterThan(0);
  });

  it('reviews old to new and marks rows Entered in Cubby, one or all ticked', async () => {
    const ready = [row({ proposed: 11500, proposedSet: 12050, revDelta: 300, ready: true,
      draft: { proposed: 11500, proposedSet: null, note: '', updatedBy: 'miranda@greensglobal.com', updatedAt: '2026-10-20T18:00:00Z' } }),
    { ...ROWS[1], proposed: 13500, proposedSet: 12250, revDelta: 350, ready: true, draft: { proposed: 13500 } }];
    apiMock.getOpsRates.mockResolvedValue(view(ready));
    const entered = (unitType) => ({ unitType, status: 'entered', detail: 'Entered in Cubby by hand',
      pushedBy: 'miranda@greensglobal.com', pushedAt: '2026-10-20T19:00:00Z' });
    apiMock.markOpsRatesEntered
      .mockResolvedValueOnce({ batchId: 'b1', view: view([ROWS[0], ready[1]]), results: [entered("8' x 10'")] })
      .mockResolvedValueOnce({ batchId: 'b2', view: view(ROWS), results: [entered("12' x 30' Parking")] });
    render(<RateManagement facility={FACILITIES[0]} facilities={FACILITIES} onPick={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review Changes' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /push/i })).toBeDisabled();
    expect(within(dialog).getByText(/Nexus doesn't change rates in Cubby/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Export Checklist/ })).toBeTruthy();
    const table = within(dialog).getByTestId('review-table');
    expect(table.textContent).toContain('$113.50 → $115');
    expect(table.textContent).toContain('$119 → $120.50');
    expect(within(dialog).getByText(/2 changes, \+\$6\.50 per month/)).toBeTruthy();

    fireEvent.click(within(dialog).getByLabelText("Include 12' x 30' Parking"));
    expect(within(dialog).getByText(/1 change, \+\$3 per month/)).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText("Include 12' x 30' Parking"));

    // One row on its own: it records the rates the review showed.
    fireEvent.click(within(dialog).getByRole('button', { name: "Mark 8' x 10' Entered in Cubby" }));
    await waitFor(() => expect(apiMock.markOpsRatesEntered).toHaveBeenCalledWith('fac_f', ["8' x 10'"],
      { "8' x 10'": { set: 11900, sell: 11350 } }));
    expect(await within(dialog).findByText('Entered in Cubby')).toBeTruthy();
    expect(within(dialog).getByText(/miranda@greensglobal\.com/)).toBeTruthy();

    // Then everything still ticked.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark 1 Entered in Cubby' }));
    await waitFor(() => expect(apiMock.markOpsRatesEntered).toHaveBeenLastCalledWith('fac_f', ["12' x 30' Parking"],
      { "12' x 30' Parking": { set: 11900, sell: 13150 } }));
    await waitFor(() => expect(within(dialog).getAllByText('Entered in Cubby')).toHaveLength(2));
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeTruthy();
    for (const b of screen.queryAllByRole('button', { name: /push/i })) expect(b).toBeDisabled();
  });

  it('opens a row to each competitor for the size, with ours among them', async () => {
    apiMock.getOpsRates.mockResolvedValue(view(ROWS));
    apiMock.getOpsRateComps.mockResolvedValue({ unitType: "8' x 10'", freshDays: 120, staleDays: 30, competitors: [
      { competitorId: 'c1', competitor: 'StorQuest', distanceMiles: 1.24, rate: 10300, online: 9900, promoRate: null, promo: 'First month free', observedOn: '2026-10-15', ageDays: 5, stale: false, source: 'web' },
      { competitorId: 'c3', competitor: 'Public Storage', distanceMiles: null, rate: 13353, online: null, promoRate: 7000, promo: '', observedOn: '2026-08-01', ageDays: 80, stale: true, source: 'manual' },
      { competitorId: 'c2', competitor: 'Extra Space', distanceMiles: 2, rate: 19900, online: null, promoRate: null, promo: '', observedOn: '2026-10-12', ageDays: 8, stale: false, source: 'stortrack' },
    ] });
    apiMock.getOpsRateHistory.mockResolvedValue({ unitType: "8' x 10'", ours: [], competitors: [] });
    render(<RateManagement facility={FACILITIES[0]} />);
    fireEvent.click(await screen.findByRole('button', { name: "8' x 10'" }));
    const table = await screen.findByTestId('comp-table');
    expect(apiMock.getOpsRateComps).toHaveBeenCalledWith('fac_f', "8' x 10'");
    const names = within(table).getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(names[0]).toContain('StorQuest');
    expect(names[0]).toContain('Lowest');
    expect(names[1]).toContain('Greens Storage (Us)');          // our $113.50 sits between $103 and $133.53
    expect(names[names.length - 1]).toContain('Highest');
    expect(table.textContent).toContain('Market Median $133.53');
    expect(table.textContent).toContain('First month free');
    expect(table.textContent).toContain('08/01/2026 (80 days old)');
    expect(table.textContent).toContain('1.2 mi');
    expect(screen.getByText('No rate changes marked entered in Cubby yet.')).toBeTruthy();
    // Collapse again.
    fireEvent.click(screen.getByRole('button', { name: "8' x 10'" }));
    expect(screen.queryByTestId('comp-table')).toBeNull();
  });

  it('opens the rate history for a unit type', async () => {
    apiMock.getOpsRates.mockResolvedValue(view(ROWS));
    apiMock.getOpsRateHistory.mockResolvedValue({ unitType: "8' x 10'", ours: [
      { id: 'p1', oldSell: 11000, newSell: 11350, oldSet: 11500, newSet: 11900, pushedBy: 'neil@greensglobal.com', pushedAt: '2026-10-01T17:00:00Z', status: 'entered', detail: 'Entered in Cubby by hand' }],
    competitors: [{ competitorId: 'c1', competitor: 'StorQuest', rate: 10300, observedOn: '2026-10-15', source: 'web', promo: '' }] });
    render(<RateManagement facility={FACILITIES[0]} facilities={FACILITIES} onPick={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rate History' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('StorQuest')).toBeTruthy();
    expect(within(dialog).getByText('$110 → $113.50')).toBeTruthy();
    expect(within(dialog).getByText('Entered in Cubby')).toBeTruthy();
    expect(apiMock.getOpsRateHistory).toHaveBeenCalledWith('fac_f', "8' x 10'");
  });
});
