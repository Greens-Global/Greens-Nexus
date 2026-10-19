import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { groupsOf, toggle, selectionLabel, loadSelection, saveSelection } from './portfolioModel';

// Operations > Portfolio (Oct 20): render smoke, the property multi-select and
// a drill-down, on a fixed payload shaped like GET /facility-ops/portfolio.

const getOpsPortfolio = vi.fn();
vi.mock('../api', () => ({ api: { getOpsPortfolio: (...a) => getOpsPortfolio(...a) } }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ realEmail: 'pat@example.com', can: () => true }) }));
vi.mock('../tasks/components', () => ({
  Modal: ({ title, children, onClose }) => <div role="dialog" aria-label={title}><button type="button" onClick={onClose}>Close</button>{children}</div>,
}));

const Portfolio = (await import('./Portfolio')).default;

const PROPS = [
  { id: 'fa', name: 'Greens Storage Temecula', shortName: 'Temecula', source: 'cubby', managedBy: 'Greens', state: 'CA', market: 'Southern California', connected: true, status: '' },
  { id: 'fb', name: 'Greens Storage Fairfield', shortName: 'Fairfield', source: 'cubby', managedBy: 'Greens', state: 'CA', market: 'Northern California', connected: true, status: '' },
  { id: 'cubesmart:pending', name: 'CubeSmart-Managed Properties', shortName: 'CubeSmart-Managed', source: 'cubesmart', managedBy: 'CubeSmart', state: '', market: '', connected: false, status: 'Not Connected Yet' },
];

const occ = (o, v) => [
  { key: 'occupied', label: 'Occupied', units: o, sqft: o * 100, unitPct: 75, sqftPct: 80 },
  { key: 'vacant', label: 'Vacant', units: v, sqft: v * 100, unitPct: 25, sqftPct: 20 },
  { key: 'reserved', label: 'Reserved', units: 0, sqft: 0, unitPct: 0, sqftPct: 0 },
  { key: 'damaged', label: 'Damaged', units: 0, sqft: 0, unitPct: 0, sqftPct: 0 },
  { key: 'unrentable', label: 'Unrentable', units: 0, sqft: 0, unitPct: 0, sqftPct: 0 },
];
const trend = [
  { month: '2026-09', label: "Sep '26", cy: { moveIns: 4, moveOuts: 2, sqftPct: 79 }, py: null },
  { month: '2026-10', label: "Oct '26", cy: { moveIns: 3, moveOuts: 1, sqftPct: 80 }, py: null },
];
const block = {
  occupancy: occ(3, 1), totalUnits: 4, totalSqft: 400, mailboxesExcluded: 2, trend,
  netRentals: { daily: { ins: 1, outs: 0 }, mtd: { ins: 3, outs: 1 }, priorYear: null },
  revenue: ['Accrued Rent', 'Fees', 'Insurance', 'Merchandise'].map((label, i) => ({ key: `r${i}`, label, mtd: null, priorYear: null })),
  allowances: [{ key: 'discount', label: 'Discount', mtd: null, priorYear: null }, { key: 'writeOffs', label: 'Write Offs', mtd: null, priorYear: null }],
  revenueTotal: { mtd: null, priorYear: null }, allowanceTotal: { mtd: null, priorYear: null }, netRevenue: { mtd: null, priorYear: null },
  collected: { mtd: 25000, priorYear: null }, rentRoll: 45000,
};
const PAYLOAD = {
  asOf: '2026-10-20', month: '2026-10', monthLabel: "Oct '26", through: '2026-10-20',
  properties: PROPS, selected: ['fa', 'fb'], notConnected: [],
  budget: { available: false, note: 'No Ops budget is set up in Nexus yet, so budget and variance columns are hidden.', figures: null },
  notes: ['No data before cutover: months before a property\'s history in Cubby are left blank, not estimated.'],
  total: {
    ...block,
    lists: {
      units: [
        { id: 'a1', name: 'A1', type: '10x10', status: 'occupied', sqft: 100, rent: 10000, tenant: 'Tenant One', facility: 'Temecula' },
        { id: 'a2', name: 'A2', type: '10x10', status: 'occupied', sqft: 100, rent: 20000, tenant: 'Tenant Two', facility: 'Temecula' },
        { id: 'b1', name: 'B1', type: '10x10', status: 'occupied', sqft: 100, rent: 15000, tenant: 'Tenant Three', facility: 'Fairfield' },
        { id: 'a3', name: 'A3', type: '10x10', status: 'vacant', sqft: 100, rent: 0, tenant: '', facility: 'Temecula' },
      ],
      moves: [{ date: '2026-10-20', kind: 'in', unit: 'B1', tenant: 'Tenant Three', facility: 'Fairfield' }],
      payments: [{ date: '2026-10-10', amount: 25000, tenant: 'Tenant Three', facility: 'Fairfield' }],
    },
  },
  byProperty: [
    { id: 'fa', shortName: 'Temecula', ...block, occupancy: occ(2, 1) },
    { id: 'fb', shortName: 'Fairfield', ...block, occupancy: occ(1, 0) },
  ],
};

beforeEach(() => {
  localStorage.clear();
  getOpsPortfolio.mockReset().mockResolvedValue(PAYLOAD);
});

describe('Portfolio', () => {
  it('renders the Daily Flash sections and hides budget columns with no budget', async () => {
    render(<Portfolio />);
    expect(await screen.findByText('Occupancy by Status')).toBeTruthy();
    for (const t of ['Move-In Trend', 'Move-Out Trend', 'Square Foot Occupancy Trend', 'Revenue', 'Allowances', 'Net Rentals', 'Net Revenue']) {
      expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText('Budget')).toBeNull();
    expect(screen.getByText(/No data before cutover/)).toBeTruthy();
    expect(getOpsPortfolio).toHaveBeenCalledWith([], '');
  });

  it('picks properties, remembers them, and shows Not Connected Yet', async () => {
    render(<Portfolio />);
    fireEvent.click(await screen.findByRole('button', { name: /All Properties \(2\)/ }));
    const panel = screen.getByRole('group', { name: 'Choose properties' });
    expect(within(panel).getByText('Not Connected Yet')).toBeTruthy();
    expect(within(panel).getAllByRole('checkbox')[2].disabled).toBe(true);
    fireEvent.click(within(panel).getAllByRole('checkbox')[1]);           // untick Fairfield
    await waitFor(() => expect(getOpsPortfolio).toHaveBeenLastCalledWith(['fa'], ''));
    expect(loadSelection('pat@example.com')).toEqual(['fa']);
    fireEvent.click(within(panel).getByRole('button', { name: 'Market: Northern California' }));
    await waitFor(() => expect(getOpsPortfolio).toHaveBeenLastCalledWith(['fb'], ''));
  });

  it('starts from the remembered selection', async () => {
    saveSelection('pat@example.com', ['fb']);
    render(<Portfolio />);
    await screen.findByText('Occupancy by Status');
    expect(getOpsPortfolio).toHaveBeenCalledWith(['fb'], '');
  });

  it('opens the list behind a figure and expands a measure by property', async () => {
    render(<Portfolio />);
    await screen.findByText('Occupancy by Status');
    fireEvent.click(screen.getByRole('button', { name: 'Occupied units: 3. Show the list' }));
    const dialog = screen.getByRole('dialog', { name: 'Occupied Units' });
    expect(within(dialog).getByText('Tenant Three')).toBeTruthy();
    expect(within(dialog).queryByText('A3')).toBeNull();
    fireEvent.click(within(dialog).getByText('Close'));
    fireEvent.click(screen.getByRole('button', { name: 'Show Occupied by property' }));
    expect(screen.getByText('Temecula')).toBeTruthy();
    expect(screen.getByText('Fairfield')).toBeTruthy();
  });
});

describe('portfolioModel', () => {
  it('builds groups and toggles from All', () => {
    const labels = groupsOf(PROPS).map((g) => g.label);
    expect(labels).toContain('Managed By: CubeSmart');
    expect(labels).toContain('Market: Southern California');
    expect(labels.some((l) => l.startsWith('State:'))).toBe(false);  // one state (CA) is not worth a chip
    expect(toggle([], 'fb', PROPS)).toEqual(['fa']);
    expect(toggle(['fa'], 'fb', PROPS)).toEqual([]);                 // back to everything = All
    expect(selectionLabel(['fa'], PROPS)).toBe('Temecula');
  });
});
