import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { fmtValue, fmtDiff, pill, monthText, monthOptions } from './opsBudgetFormat';

// Operations > Ops Budget (Oct 21): render smoke on a payload shaped like
// GET /ops-budget, the summary card, the All Numbers toggle, Pending API rows
// and dashes (never 0%) for missing figures.

const getOpsBudgetFacilities = vi.fn();
const getOpsBudget = vi.fn();
const getOpsBudgetTrend = vi.fn();
vi.mock('../api', () => ({
  api: {
    getOpsBudgetFacilities: (...a) => getOpsBudgetFacilities(...a),
    getOpsBudget: (...a) => getOpsBudget(...a),
    getOpsBudgetTrend: (...a) => getOpsBudgetTrend(...a),
    getOpsBudgetLoads: () => Promise.resolve({ loads: [] }),
  },
  saveBlob: () => {},
}));
vi.mock('../tasks/components', () => ({
  Modal: ({ title, children, footer }) => <div role="dialog" aria-label={title}>{children}{footer}</div>,
}));

const OpsBudget = (await import('./OpsBudget')).default;

const FACS = {
  facilities: [
    { id: 'escondido', name: 'Greens Storage Escondido', shortName: 'Escondido', fiscalStartMonth: 1, budgetYearStart: '2026-01', lastWorkbookAt: '2026-10-20T18:00:00Z', lastCubbyAt: '' },
    { id: 'fairfield', name: 'Greens Storage Fairfield', shortName: 'Fairfield', fiscalStartMonth: 1, budgetYearStart: '', lastWorkbookAt: '', lastCubbyAt: '' },
  ],
  defaultMonth: '2026-09', currentMonth: '2026-10', historyFrom: '2023-01', canUpload: true,
};

const v = (diff, status, arrow, pts = null) => ({ diff, pts, status, arrow, even: status === 'even' });
const row = (key, label, section, unit, budget, actual, lastYear, extra = {}) => ({
  key, label, section, unit, kind: 'flow', better: 'up', isRate: false, pending: false, budget, actual, lastYear,
  vsBudget: actual != null && budget != null ? v(actual - budget, actual >= budget ? 'better' : 'worse', actual > budget ? 'up' : 'down') : null,
  vsLastYear: actual != null && lastYear != null ? v(actual - lastYear, actual >= lastYear ? 'better' : 'worse', actual > lastYear ? 'up' : 'down') : null,
  source: 'workbook', otherSource: null, ...extra,
});

const REPORT = {
  segment: 'self_storage', segmentLabel: 'Self-Storage', month: '2026-09', monthLabel: 'Sep 2026', periodLabel: 'September 2026',
  period: 'month', budgetAvailable: true, funnelTakeaway: 'Out of every 10 inquiries, about 4 became a rental. 26 move-ins in total, including walk-ins who never reserved.',
  summary: {
    headline: 'Self-storage is 96.1% full and earning $10,700 more rent than the same month last year, but 2 items need attention.',
    goingWell: [{ metric: 'unit_occupancy', name: 'Unit occupancy', rest: ' is 96.1%, up 1.8 pts from last year.', arrow: 'up' }],
    needsAttention: [{ metric: 'net_rentals', name: 'Net rentals', rest: ' is 5 against a plan of 6.', arrow: 'down' },
      { metric: 'move_outs', name: 'Move-outs', rest: ' is 21 against a plan of 18.', arrow: 'up' }],
    attentionCount: 2, goingWellCount: 1,
  },
  sections: [{ key: 'occupancy', label: 'Occupancy' }, { key: 'funnel', label: 'Sales Funnel' }, { key: 'liens', label: 'Liens & Tows' }],
  metrics: [
    row('unit_occupancy', 'Unit occupancy', 'occupancy', 'pct', 0.969, 0.961, 0.942, { isRate: true, kind: 'rate' }),
    row('sqft_occupancy', 'Sq ft occupancy', 'occupancy', 'pct', null, null, null, { isRate: true, kind: 'rate' }),
    row('economic_occupancy', 'Economic occupancy', 'occupancy', 'pct', 0.906, 0.902, 0.884, { isRate: true, kind: 'rate' }),
    row('rental_income', 'Actual rental income', 'occupancy', 'money', 152500, 151900, 141200),
    row('website_visitors', 'Website visitors', 'funnel', 'count', null, null, null, { pending: true }),
    row('leads', 'Leads', 'funnel', 'count', 60, 64, 58),
    row('reservations', 'Reservations', 'funnel', 'count', 30, 31, 27),
    row('reservations_converted', 'Reservations converted', 'funnel', 'count', 18, 18, 14),
    row('reservation_to_move_in', 'Reservation to move-in', 'funnel', 'pct', 0.6, 0.581, 0.519, { isRate: true, kind: 'rate' }),
    row('liens', 'Liens completed', 'liens', 'count', 2, 2, 3),
  ],
  notes: ['Rates are worked out from the period\'s counts, never averaged.'],
};
const TREND = {
  points: Array.from({ length: 24 }, (_, i) => ({ month: `20${i < 3 ? '24' : i < 15 ? '25' : '26'}-${String(((i + 9) % 12) + 1).padStart(2, '0')}`,
    unit_occupancy: 0.92 + i * 0.001, economic_occupancy: 0.88, avg_standard_rate: 230, avg_web_rate: 210, move_ins: 22, move_outs: 20 })),
  takeaways: { inout: '264 customers moved in and 240 moved out over the last 12 months, a net gain of 24.', occupancy: 'Units rented rose from 92.0% to 94.3% over two years.', rates: '' },
};

beforeEach(() => {
  localStorage.clear();
  getOpsBudgetFacilities.mockReset().mockResolvedValue(FACS);
  getOpsBudget.mockReset().mockResolvedValue(REPORT);
  getOpsBudgetTrend.mockReset().mockResolvedValue(TREND);
});

describe('Ops Budget', () => {
  it('renders the summary, KPI cards and charts for the default month', async () => {
    render(<OpsBudget />);
    expect(await screen.findByText(/earning \$10,700 more rent/)).toBeTruthy();
    expect(getOpsBudget).toHaveBeenCalledWith({ facility: 'escondido', segment: 'self_storage', month: '2026-09', period: 'month' });
    const summary = screen.getByRole('region', { name: 'Summary' });
    expect(within(summary).getByText('Going Well')).toBeTruthy();
    expect(within(summary).getByText('Needs Attention')).toBeTruthy();
    expect(within(summary).getByText('Net rentals').tagName).toBe('B');
    expect(screen.getByText('Units Rented')).toBeTruthy();
    expect(screen.getByText('Revenue Captured')).toBeTruthy();
    expect(screen.getByText('Customers In vs. Out')).toBeTruthy();
    expect(screen.getByText('From Inquiry to Move-In')).toBeTruthy();
    expect(screen.getByText(/Out of every 10 inquiries/)).toBeTruthy();
    expect(screen.getByText('Tows are tracked for vehicle storage only.')).toBeTruthy();
    expect(screen.getByText(/Workbook loaded 10\/20\/2026/)).toBeTruthy();
  });

  it('shows a dash, never 0%, for a missing rate', async () => {
    render(<OpsBudget />);
    const card = (await screen.findByRole('region', { name: 'Space Rented' }));
    expect(within(card).getAllByText('-').length).toBeGreaterThan(0);
    expect(within(card).queryByText('0.0%')).toBeNull();
  });

  it('opens All Numbers on demand, with Pending API rows and variance pills', async () => {
    render(<OpsBudget />);
    await screen.findByText(/earning \$10,700/);
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show All Numbers/ }));
    const table = screen.getByRole('table');
    expect(within(table).getByText('Pending API')).toBeTruthy();
    expect(within(table).getByText('Occupancy')).toBeTruthy();
    const occ = within(table).getByText('Unit occupancy').closest('tr');
    expect(within(occ).getByText('96.1%')).toBeTruthy();
    expect(within(occ).getByText('0.8 pts').closest('.ob-pill').className).toContain('ob-pill-bad');
    fireEvent.click(screen.getByRole('button', { name: /Hide Numbers/ }));
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('switches segment and period, and remembers them', async () => {
    render(<OpsBudget />);
    await screen.findByText(/earning \$10,700/);
    fireEvent.click(screen.getByRole('button', { name: 'Vehicle Storage' }));
    await waitFor(() => expect(getOpsBudget).toHaveBeenLastCalledWith(expect.objectContaining({ segment: 'vehicle' })));
    fireEvent.click(screen.getByRole('button', { name: 'Year to Date' }));
    await waitFor(() => expect(getOpsBudget).toHaveBeenLastCalledWith(expect.objectContaining({ period: 'ytd' })));
    expect(JSON.parse(localStorage.getItem('nexus.ops.budget'))).toMatchObject({ segment: 'vehicle', period: 'ytd' });
  });

  it('shows an error with a retry when the figures fail, never a blank screen', async () => {
    getOpsBudget.mockRejectedValueOnce(new Error('boom'));
    render(<OpsBudget />);
    expect(await screen.findByText("Couldn't load the Ops Budget figures.")).toBeTruthy();
  });

  it('opens the upload dialog for an administrator', async () => {
    render(<OpsBudget />);
    await screen.findByText(/earning \$10,700/);
    fireEvent.click(screen.getByRole('button', { name: /Upload Workbook/ }));
    expect(screen.getByRole('dialog', { name: 'Upload Ops Budget Workbook' })).toBeTruthy();
  });
});

describe('Ops Budget formatting', () => {
  it('formats values, differences and pills', () => {
    expect(fmtValue('pct', 0.961)).toBe('96.1%');
    expect(fmtValue('pct', null)).toBe('-');
    expect(fmtValue('money', 151900)).toBe('$151,900');
    expect(fmtValue('rate', 236.5)).toBe('$236.50');
    expect(fmtValue('count', 3450)).toBe('3,450');
    expect(fmtDiff('pct', -0.008)).toBe('0.8 pts');
    expect(pill('count', null)).toEqual({ text: '-', tone: 'none', arrow: null });
    expect(pill('count', { diff: 0, status: 'even', arrow: null }).text).toBe('Even');
    expect(pill('money', { diff: 8600, status: 'neutral', arrow: 'up' })).toEqual({ text: '$8,600', tone: 'neutral', arrow: 'up' });
    expect(pill('count', { diff: 3, status: 'worse', arrow: 'up' }).tone).toBe('bad');
    expect(monthText('2026-09')).toBe('Sep 2026');
    expect(monthText('2026-09', { long: true })).toBe('September 2026');
    expect(monthOptions('2026-08', '2026-10')).toEqual(['2026-10', '2026-09', '2026-08']);
  });
});
