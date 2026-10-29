import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Rate Management as Miranda's CMA (Oct 21 2026): four screens - Overview,
// Comp Set & Manual Entry, Rate History, Review & Push. Render-smoke for each
// and the key flows: a Proposed rate is a draft; "Add Manual Rate" records a
// rate for THAT pricing group from its competitor panel; a survey and an
// import preview; Review ends in Mark Entered in Cubby while Push to Cubby is
// off, and pushes when it is on. Numbers come from the server.

const apiMock = vi.hoisted(() => ({
  getOpsRates: vi.fn(), saveOpsRateDraft: vi.fn(), checkOpsCompetitor: vi.fn(), getOpsMarket: vi.fn(), getOpsNearby: vi.fn(),
  getOpsCmaCompset: vi.fn(), addOpsCmaCompetitor: vi.fn(), updateOpsCmaCompetitor: vi.fn(), closeOpsCmaCompetitor: vi.fn(),
  saveOpsCmaSurvey: vi.fn(), saveOpsCmaOverride: vi.fn(), importOpsCmaRates: vi.fn(), getOpsCmaHistory: vi.fn(),
  getOpsCmaReview: vi.fn(), proposeOpsCmaPromo: vi.fn(), withdrawOpsCmaPromo: vi.fn(), applyOpsCmaReview: vi.fn(),
  rejectOpsCmaReview: vi.fn(), markOpsCmaEntered: vi.fn(), retryOpsCmaChange: vi.fn(), revertOpsCmaChange: vi.fn(),
  syncOpsStorTrack: vi.fn(),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));
vi.mock('../tasks/components', () => ({
  Modal: ({ title, children, footer }) => <div role="dialog" aria-label={title}>{children}<div>{footer}</div></div>,
  // Stand-ins for the searchable dropdown and the date picker: a plain select / input.
  SearchSelect: ({ options, value, onPick, placeholder }) => (
    <select aria-label="Unit Type" value={value} onChange={(e) => onPick(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((o) => (o.header ? <option key={o.id} value={o.id} disabled>{`-- ${o.label} --`}</option> : <option key={o.id} value={o.id}>{o.label}</option>))}
    </select>
  ),
  DateField: ({ value, onChange, title }) => <input aria-label={title} value={value} onChange={(e) => onChange(e.target.value)} />,
  // Review & Push names who approved / entered a change (face + name).
  usePeople: () => [],
  AvatarName: ({ name, email }) => <span>{name || email}</span>,
}));
const exportMock = vi.hoisted(() => ({ exportExcel: vi.fn(), exportPdf: vi.fn() }));
vi.mock('../tasks/exporting', () => exportMock);
const csvMock = vi.hoisted(() => ({ downloadCsv: vi.fn() }));
vi.mock('./csv', async (orig) => ({ ...(await orig()), downloadCsv: csvMock.downloadCsv }));

const { default: RateManagement } = await import('./RateManagement');

const FAC = { id: 'fac_f', shortName: 'Fairfield' };
const comp = (over) => ({ competitorId: 'tri', competitor: 'Tri-City Boat & RV Storage', distanceMiles: 0.2, rate: 11000, online: null,
  promo: 'Rate locked in for 2 years', adminFee: null, insurance: '', observedOn: '2026-10-15', source: 'manual', locked: false, ...over });
const row = (over) => ({
  name: "12' x 32' Parking", category: 'Vehicle Storage', groupId: 'pg_1232', width: 12, depth: 32, parking: true,
  total: 114, rented: 92, vacant: 21, offline: 1, occupancy: 0.807, avgDaysVacant: 34, avgRent: 12274,
  set: 11400, sell: 11450, webRate: 11450, walkIn: 11450, algorithmWebRate: null, competitors: 3,
  marketLow: 11000, marketHigh: 15400, marketAvg: 12467, nearestSize: '', variance: -1017, variancePct: -0.0816,
  promoCount: 2, promoBy: ['Tri-City Boat & RV Storage', 'Security Public Storage'], adminFeeLow: null, adminFeeHigh: null,
  suggested: 11950, why: 'Raise halfway to market: 80%+ occupied, below avg', move: 'raise', offlineOnly: false,
  draft: null, proposed: null, proposedSet: null, revDelta: 0, ready: false,
  comps: [comp(), comp({ competitorId: 'sps', competitor: 'Security Public Storage', distanceMiles: 2.1, rate: 15400, source: 'web', promo: '50% off 6 mo.' })],
  ...over,
});
const ROWS = [
  row({ name: "8' x 10'", category: 'Self-Storage', width: 8, depth: 10, parking: false, total: 2, rented: 0, vacant: 2, offline: 0, occupancy: 0,
    set: 11900, sell: 11350, webRate: 11350, competitors: 1, marketLow: 10300, marketHigh: 10300, marketAvg: 10300, variance: 1050, variancePct: 0.1,
    suggested: 11350, why: 'Hold - only 1 comp; add a manual rate before changing', move: 'hold', comps: [comp({ rate: 10300 })], promoCount: 0, promoBy: [] }),
  row(),
];
const VIEW = (rows = ROWS, over = {}) => ({
  facilityId: 'fac_f', facility: 'Fairfield', name: 'Greens Storage Fairfield', asOf: '2026-10-20', address: '5044 Peabody Road, Fairfield, CA 94533',
  billingCycle: 'MONTHLY', lastSurvey: '2026-10-15', lastSurveyBy: 'JW', cubbyGroups: { ok: true, count: 2, error: '' },
  compSet: { active: 8, web: 5, stortrack: 0, manual: 3, closed: 1 },
  kpis: { vsMarket: -0.157, rateable: 6, belowMarket: 5, occupancy: 0.697, units: 307, rented: 214, offline: 13, ready: 0, readyDelta: 0 },
  attention: ["12' x 20' Parking is fully offline (11 units)"], rows,
  competitors: [{ id: 'tri', name: 'Tri-City Boat & RV Storage', ratesUrl: '', watch: false }], proposedPromos: 0,
  canEdit: true, canMark: true, pushOn: false, writeConfigured: false, pushReady: false, canPush: true, ...over,
});

beforeEach(() => {
  Object.values(apiMock).forEach((f) => f.mockReset());
  exportMock.exportExcel.mockReset();
  csvMock.downloadCsv.mockReset();
});

describe('CMA Overview', () => {
  it('renders the header, cards, the grouped table and the competitor panel', async () => {
    apiMock.getOpsRates.mockResolvedValue(VIEW());
    render(<RateManagement facility={FAC} />);
    expect(await screen.findByText('Greens Storage Fairfield')).toBeTruthy();
    expect(screen.getByText(/Competitive Market Analysis/)).toBeTruthy();
    expect(screen.getByText('8 active')).toBeTruthy();
    expect(screen.getByText('-15.7%')).toBeTruthy();
    expect(screen.getByText('Subtotal Vehicle Storage')).toBeTruthy();
    expect(screen.getByText('Subtotal Self-Storage')).toBeTruthy();
    for (const h of ['Current Standard Rate', 'Web Rate', 'Avg Days Vacant', 'Comp Promotions', 'Comp Admin Fee', 'Mkt Avg']) {
      expect(screen.getAllByText(h).length).toBeGreaterThan(0);
    }
    const table = screen.getByTestId('rate-table');
    expect(table.textContent).toContain('-$10.17 · -8.2%');
    expect(table.textContent).toContain('Raise halfway to market');
    expect(screen.getByText('0 changes ready for Cubby')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /push/i })).toBeNull();          // the switch is off
    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Export PDF/ })).toBeNull();
    // A click on a unit type shows its competitors below the table.
    fireEvent.click(screen.getByRole('button', { name: "Show competitors for 12' x 32' Parking" }));
    const panel = screen.getByTestId('comp-panel');
    expect(within(panel).getByText('Security Public Storage')).toBeTruthy();
    expect(within(panel).getByText('50% off 6 mo.')).toBeTruthy();
  });

  it('filters Self-Storage and Vehicle Storage with pills', async () => {
    apiMock.getOpsRates.mockResolvedValue(VIEW());
    render(<RateManagement facility={FAC} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vehicle Storage' }));
    expect(screen.queryByText('Subtotal Self-Storage')).toBeNull();
    expect(screen.getByText('Subtotal Vehicle Storage')).toBeTruthy();
  });

  it('saves a typed Proposed rate as a draft and shows it ready', async () => {
    apiMock.getOpsRates.mockResolvedValue(VIEW());
    apiMock.saveOpsRateDraft.mockResolvedValue(VIEW([ROWS[0], row({ proposed: 11950, proposedSet: 11900, revDelta: 46000, ready: true, draft: { proposed: 11950 } })]));
    render(<RateManagement facility={FAC} />);
    const input = await screen.findByLabelText("Proposed rate for 12' x 32' Parking");
    fireEvent.change(input, { target: { value: '119.50' } });
    fireEvent.blur(input);
    await waitFor(() => expect(apiMock.saveOpsRateDraft).toHaveBeenCalledWith({ facility_id: 'fac_f', unit_type: "12' x 32' Parking", proposed: 119.5 }));
    expect(await screen.findByText('1 change ready for Cubby')).toBeTruthy();
    expect(screen.getAllByText('+$460').length).toBeGreaterThan(0);
  });

  it('adds a manual rate for the pricing group being looked at', async () => {
    apiMock.getOpsRates.mockResolvedValue(VIEW());
    apiMock.saveOpsCmaSurvey.mockResolvedValue({});
    render(<RateManagement facility={FAC} />);
    fireEvent.click(await screen.findByRole('button', { name: "Show competitors for 12' x 32' Parking" }));
    fireEvent.click(screen.getByRole('button', { name: /Add Manual Rate/ }));
    const dialog = screen.getByRole('dialog', { name: /Add Manual Rate/ });
    fireEvent.change(within(dialog).getByPlaceholderText('JW'), { target: { value: 'JW' } });
    fireEvent.change(within(dialog).getByPlaceholderText('110'), { target: { value: '110' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Rate' }));
    await waitFor(() => expect(apiMock.saveOpsCmaSurvey).toHaveBeenCalled());
    const body = apiMock.saveOpsCmaSurvey.mock.calls[0][0];
    expect(body.competitor_id).toBe('tri');
    expect(body.rates[0]).toMatchObject({ their_size: '12 x 32', kind: 'parking', street: 110, matched_unit_type: "12' x 32' Parking" });
  });

  it('exports CSV and XLS, never PDF', async () => {
    apiMock.getOpsRates.mockResolvedValue(VIEW());
    render(<RateManagement facility={FAC} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Export CSV/ }));
    await waitFor(() => expect(csvMock.downloadCsv).toHaveBeenCalled());
    const [name, cols] = csvMock.downloadCsv.mock.calls[0];
    expect(name).toMatch(/^CMA - Fairfield - 10-20-2026\.csv$/);
    expect(cols).toContain('Current Standard Rate');
    fireEvent.click(screen.getByRole('button', { name: /^Export XLS/ }));
    await waitFor(() => expect(exportMock.exportExcel).toHaveBeenCalled());
    expect(exportMock.exportPdf).not.toHaveBeenCalled();
  });
});

const COMPSET = {
  facilityId: 'fac_f', facility: 'Fairfield', name: 'Greens Storage Fairfield', asOf: '2026-10-20', lockDays: 30,
  methods: { phone: 'Phone Call', drive_by: 'Drive-By', walk_in: 'Walk-In / Mystery Shop', flyer: 'Flyer / Signage' },
  storageAccess: ['Drive-Up', 'Interior', 'Climate'], parkingAccess: ['Gravel - Open - Drive-In', 'Covered'],
  unitTypes: [{ name: "12' x 32' Parking", width: 12, depth: 32, parking: true }, { name: "8' x 10'", width: 8, depth: 10, parking: false }],
  counts: { active: 2, website: 1, manual: 1, closed: 1 },
  competitors: [
    { id: 'almond', name: 'Almond Acres RV & Storage', address: '4535 Olive Ave, Suisun City', phone: '(707) 864-8056', propertyType: 'Self-Storage & RV Storage',
      distanceMiles: 3.8, closed: false, badge: 'manual', priceSource: 'manual', syncedOn: '', lockedOverrides: 0, lastSurvey: null, rates: [] },
    { id: 'cube', name: 'CubeSmart', address: '', phone: '', distanceMiles: 0.5, closed: false, badge: 'website', priceSource: 'website',
      syncedOn: '2026-10-12', lockedOverrides: 1, lastSurvey: null,
      rates: [{ id: 'r1', theirSize: "10' x 20'", width: 10, depth: 20, parking: true, access: '', street: 16260, online: null, source: 'web', observedOn: '2026-10-12', matchedUnitType: '', note: '' }] },
    { id: 'sq', name: 'StorQuest', distanceMiles: 13.1, closed: true, closedNote: 'STORE now at this address', badge: 'closed', priceSource: 'website', rates: [], lastSurvey: null },
  ],
};

describe('Comp Set & Manual Entry', () => {
  it('lists competitors with badges and saves a survey matched to our nearest type', async () => {
    apiMock.getOpsCmaCompset.mockResolvedValue(COMPSET);
    apiMock.saveOpsCmaSurvey.mockResolvedValue(COMPSET);
    render(<RateManagement facility={FAC} section="comps" onSection={() => {}} />);
    expect(await screen.findByText('Fairfield Competitive Set')).toBeTruthy();
    expect(screen.getAllByText('Closed').length).toBeGreaterThan(0);
    expect(screen.getByText(/Excluded from averages/)).toBeTruthy();
    const form = screen.getByTestId('survey-form');
    fireEvent.change(within(form).getByPlaceholderText('JW'), { target: { value: 'JW' } });
    fireEvent.change(within(form).getByLabelText('Row 1 their size'), { target: { value: '12 x 30' } });
    fireEvent.change(within(form).getByLabelText('Row 1 kind'), { target: { value: 'parking' } });
    fireEvent.change(within(form).getByLabelText('Row 1 street rate'), { target: { value: '110' } });
    expect(within(form).getByText("Auto: 12' x 32' Parking")).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Save Survey' }));
    await waitFor(() => expect(apiMock.saveOpsCmaSurvey).toHaveBeenCalled());
    expect(apiMock.saveOpsCmaSurvey.mock.calls[0][0]).toMatchObject({ competitor_id: 'almond', method: 'phone', surveyed_by: 'JW',
      rates: [{ their_size: '12 x 30', kind: 'parking', street: 110 }] });
  });

  it('switches the price source and offers a locked website override', async () => {
    apiMock.getOpsCmaCompset.mockResolvedValue(COMPSET);
    apiMock.updateOpsCmaCompetitor.mockResolvedValue(COMPSET);
    apiMock.saveOpsCmaOverride.mockResolvedValue(COMPSET);
    render(<RateManagement facility={FAC} section="comps" onSection={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /CubeSmart/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Manual Only' }));
    await waitFor(() => expect(apiMock.updateOpsCmaCompetitor).toHaveBeenCalledWith('cube', { price_source: 'manual' }));
    const card = screen.getByTestId('override-card');
    fireEvent.change(within(card).getByPlaceholderText('e.g. after a phone quote'), { target: { value: '150' } });
    fireEvent.change(within(card).getByPlaceholderText('Phone quote lower than site'), { target: { value: 'Phone quote' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save Override' }));
    await waitFor(() => expect(apiMock.saveOpsCmaOverride).toHaveBeenCalledWith({ competitor_id: 'cube', width: 10, depth: 20, parking: true, rate: 150, reason: 'Phone quote', lock: true }));
  });
});

describe('Rate History', () => {
  it('draws the chart, the side cards and the change log - no workbook seed', async () => {
    apiMock.getOpsRates.mockResolvedValue(VIEW());
    apiMock.getOpsCmaHistory.mockResolvedValue({
      unitType: "12' x 32' Parking", asOf: '2026-10-20',
      points: [{ date: '2026-08-15', sell: 11450, avgRent: 12200, marketAvg: 12300, marketLow: 11000, marketHigh: 15400, comps: 3, occupied: 93, total: 114 },
        { date: '2026-10-20', sell: 11450, avgRent: 12274, marketAvg: 12467, marketLow: 11000, marketHigh: 15400, comps: 3, occupied: 92, total: 114 }],
      cards: { gap: -1017, gapPct: -0.0816, comps: 3, asOf: '2026-10-20', avgRent: 12274, sell: 11450, rentVsSell: 824, occupiedThen: 93, occupiedFrom: '2026-08-15', occupiedNow: 92, total: 114 },
      log: [{ at: '2026-10-15T18:00:00Z', date: '2026-10-15', text: 'StorQuest marked closed - removed from averages', source: 'comp_set', by: 'JW' }],
    });
    render(<RateManagement facility={FAC} section="history" onSection={() => {}} />);
    expect(await screen.findByTestId('history-chart')).toBeTruthy();
    expect(screen.getByText('-$10.17 · -8.2%')).toBeTruthy();
    expect(screen.getByText('Existing tenants pay more than new move-ins')).toBeTruthy();
    expect(within(screen.getByTestId('change-log')).getByText('Comp Set')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Upload Workbooks/ })).toBeNull();   // the old Excel CMAs are not wanted (Neil, Oct 21)
    expect(apiMock.getOpsCmaHistory).toHaveBeenCalledWith('fac_f', "8' x 10'", { start: '', end: '' });   // the first unit type with comps, All History
  });
});

describe('Rate History - unit type dropdown', () => {
  it('lists unit types by full name under Self-Storage / Vehicle Storage, no chips, and switches the history', async () => {
    apiMock.getOpsRates.mockResolvedValue(VIEW());
    apiMock.getOpsCmaHistory.mockResolvedValue({ unitType: "8' x 10'", asOf: '2026-10-20', points: [], cards: { comps: 0, asOf: '2026-10-20', occupiedNow: 0, total: 0 }, log: [] });
    const { container } = render(<RateManagement facility={FAC} section="history" onSection={() => {}} />);
    const pick = await screen.findByRole('combobox', { name: 'Unit Type' });
    const labels = [...pick.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toContain('-- Self-Storage --');
    expect(labels.some((l) => /Parking/.test(l))).toBe(true);
    expect(container.querySelector('.cma-pill')).toBeNull();                      // the chip rows are gone
    const other = [...pick.querySelectorAll('option')].find((o) => !o.disabled && o.value && o.value !== pick.value);
    fireEvent.change(pick, { target: { value: other.value } });
    await waitFor(() => expect(apiMock.getOpsCmaHistory).toHaveBeenLastCalledWith('fac_f', other.value, expect.any(Object)));
  });
});

describe('Rate History - period filter', () => {
  it('works out each period from today', async () => {
    const { periodBounds } = await import('./cma/CmaHistory');
    const today = new Date(2026, 9, 21);
    expect(periodBounds({ key: 'all' }, today)).toEqual({ start: '', end: '' });
    expect(periodBounds({ key: '12m' }, today)).toEqual({ start: '2025-10-21', end: '' });
    expect(periodBounds({ key: '3m' }, today)).toEqual({ start: '2026-07-21', end: '' });
    expect(periodBounds({ key: 'ytd' }, today)).toEqual({ start: '2026-01-01', end: '' });
    expect(periodBounds({ key: 'custom', start: '2024-01-01', end: '2024-12-31' }, today)).toEqual({ start: '2024-01-01', end: '2024-12-31' });
    expect(periodBounds({ key: 'nonsense' }, today)).toEqual({ start: '', end: '' });
  });

  it('asks the server for the period picked, remembers it, and says how far the record goes', async () => {
    localStorage.removeItem('nexus.ops.rateHistory.period');
    apiMock.getOpsRates.mockResolvedValue(VIEW());
    apiMock.getOpsCmaHistory.mockResolvedValue({
      unitType: "8' x 10'", asOf: '2026-10-20', points: [{ date: '2023-12-31', sell: 11000, avgRent: 10500, comps: 0, occupied: 80, total: 113, source: 'hummingbird' }],
      cards: { gap: null, gapPct: null, comps: 0, asOf: '2026-10-20', avgRent: null, sell: 11000, rentVsSell: null, occupiedThen: 80, occupiedFrom: '2023-12-31', occupiedNow: 92, total: 114 },
      log: [], span: { first: '2023-12-31', last: '2026-10-20' }, hummingbird: { first: '2023-12', last: '2026-08' },
    });
    render(<RateManagement facility={FAC} section="history" onSection={() => {}} />);
    expect(await screen.findByText(/History on record 12\/31\/2023 - 10\/20\/2026/)).toBeTruthy();
    expect(screen.getByText('Hummingbird from 12/01/2023')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), { target: { value: '24m' } });
    await waitFor(() => expect(apiMock.getOpsCmaHistory).toHaveBeenLastCalledWith('fac_f', "8' x 10'", expect.objectContaining({ end: '' })));
    const { start } = apiMock.getOpsCmaHistory.mock.calls.at(-1)[2];
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.parse(localStorage.getItem('nexus.ops.rateHistory.period'))).toEqual({ key: '24m' });
    localStorage.removeItem('nexus.ops.rateHistory.period');
  });
});

describe('Rate History - Hummingbird months', () => {
  it('labels the months before Cubby as Hummingbird in the table and the change log', async () => {
    apiMock.getOpsRates.mockResolvedValue(VIEW());
    apiMock.getOpsCmaHistory.mockResolvedValue({
      unitType: "12' x 32' Parking", asOf: '2026-10-20',
      points: [{ date: '2025-11-30', sell: 11000, avgRent: 10500, marketAvg: null, marketLow: null, marketHigh: null, comps: 0, occupied: 80, total: 113, source: 'hummingbird' },
        { date: '2026-10-20', sell: 11450, avgRent: 12274, marketAvg: 12467, marketLow: 11000, marketHigh: 15400, comps: 3, occupied: 92, total: 114 }],
      cards: { gap: -1017, gapPct: -0.0816, comps: 3, asOf: '2026-10-20', avgRent: 12274, sell: 11450, rentVsSell: 824, occupiedThen: 80, occupiedFrom: '2025-11-30', occupiedNow: 92, total: 114 },
      log: [{ at: '2026-01-01', date: '2026-01-01', text: 'Sell rate $110.00 -> $114.50', source: 'hummingbird', by: '' }],
      hummingbird: { first: '2025-11', last: '2026-01' },
    });
    render(<RateManagement facility={FAC} section="history" onSection={() => {}} />);
    const log = await screen.findByTestId('change-log');
    expect(within(log).getByText('Hummingbird')).toBeTruthy();
    expect(within(log).getByText('Sell rate $110.00 -> $114.50')).toBeTruthy();
    expect(within(log).getByText('01/01/2026')).toBeTruthy();
    const chart = screen.getByTestId('history-chart');
    expect(chart.textContent).toContain('11/30/2025');                       // the axis reaches back, in US format
    expect(screen.getAllByText('Hummingbird').length).toBeGreaterThan(1);    // the table's Source column too
    expect(screen.getByText('80 → 92')).toBeTruthy();
  });
});

const REVIEW = (over = {}) => ({
  facilityId: 'fac_f', facility: 'Fairfield', name: 'Greens Storage Fairfield', asOf: '2026-10-20',
  rates: [{ type: 'rate', key: "rate:12' x 32' Parking", unitType: "12' x 32' Parking", groupId: 'pg_1232', nowWeb: 11450, newWeb: 11950,
    nowStandard: 11400, newStandard: 11900, why: '81% occupied, 8.2% below market avg ($124.67)', change: 'Rate Increase',
    effective: '2026-11-01', affects: 'New move-ins - 21 vacant spaces', revDelta: 46000, proposedBy: 'jw@greensglobal.com',
    needsOwner: false, notes: [], blocks: [] }],
  promos: [{ id: 'p1', kind: 'promo_add', promo: { name: 'Fall Promo', unitTypes: ["12' x 26' Parking"], start: '2026-11-01', end: '2026-12-31' },
    promoText: 'First 2 months 50% off', reason: '66% occupied', affects: 'New move-ins only - 47 vacant spaces', proposedBy: 'jw@greensglobal.com' }],
  decided: [], unitTypes: [{ name: "12' x 32' Parking" }], roles: { ops_manager: true, owner: false },
  roleLabels: { ops_manager: 'Ops Manager', owner: 'Owner' }, canPropose: true,
  calculations: { percent: 'Percent Off', fixed: 'Fixed Amount Off', first_month_1: '$1 First Month' },
  pushOn: false, writeConfigured: false, pushReady: false, ...over,
});

describe('Review & Push', () => {
  it('lists rate and promotion changes and ends in Mark Entered while the switch is off', async () => {
    apiMock.getOpsCmaReview.mockResolvedValue(REVIEW());
    apiMock.applyOpsCmaReview.mockResolvedValue({ results: [{ key: "rate:12' x 32' Parking", unitType: "12' x 32' Parking", status: 'entered' }], review: REVIEW({ rates: [], promos: [] }) });
    render(<RateManagement facility={FAC} section="review" onSection={() => {}} />);
    expect(await screen.findByText('Review & Mark Entered in Cubby')).toBeTruthy();
    const table = screen.getByTestId('review-table');
    expect(table.textContent).toContain('81% occupied, 8.2% below market avg ($124.67)');
    expect(table.textContent).toContain('First 2 months 50% off');
    expect(table.textContent).toContain('11/01/2026');
    expect(screen.queryByRole('button', { name: /Approve & Push/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mark 2 Entered in Cubby' }));
    await waitFor(() => expect(apiMock.applyOpsCmaReview).toHaveBeenCalled());
    const body = apiMock.applyOpsCmaReview.mock.calls[0][0];
    expect(body).toMatchObject({ facility_id: 'fac_f', mode: 'entered', approver_role: 'ops_manager', rates: ["12' x 32' Parking"], promos: ['p1'] });
    expect(body.request_id).toBeTruthy();
    expect(await screen.findByTestId('apply-results')).toBeTruthy();
  });

  it('pushes when the switch is on and previews what Cubby will show', async () => {
    apiMock.getOpsCmaReview.mockResolvedValue(REVIEW({ pushOn: true, writeConfigured: true, pushReady: true }));
    apiMock.applyOpsCmaReview.mockResolvedValue({ results: [], review: REVIEW({ pushOn: true, pushReady: true, rates: [], promos: [] }) });
    render(<RateManagement facility={FAC} section="review" onSection={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Preview What Cubby Will Show/ }));
    expect(within(screen.getByTestId('preview-table')).getByText(/was \$114\.50/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Include Fall Promo'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Push 1 Change' }));
    await waitFor(() => expect(apiMock.applyOpsCmaReview).toHaveBeenCalled());
    expect(apiMock.applyOpsCmaReview.mock.calls[0][0]).toMatchObject({ mode: 'push', send: 'effective', promos: [] });
  });

  it('says when a change needs the Owner and leaves blocked rows unticked', async () => {
    apiMock.getOpsCmaReview.mockResolvedValue(REVIEW({ promos: [], rates: [{ ...REVIEW().rates[0], needsOwner: true, notes: ['Changes the web rate 22% (over 10%) - needs the Owner\'s approval'] },
      { ...REVIEW().rates[0], key: 'rate:b', unitType: 'B', blocks: ['This pricing group changed on 10/16/2026 - it can\'t change again within 7 days'] }] }));
    render(<RateManagement facility={FAC} section="review" onSection={() => {}} />);
    expect(await screen.findByText('A ticked change needs the Owner as approver.')).toBeTruthy();
    expect(screen.getByLabelText('Include B')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark 1 Entered in Cubby' })).toBeTruthy();
  });
});
