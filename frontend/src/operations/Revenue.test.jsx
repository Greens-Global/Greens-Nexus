import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Operations > Revenue Management (Oct 20 2026): the tab renders the tenant
// table, a strategy can be built, and the preview shows the revenue impact.
// The numbers come from the server; these tests check the screen draws them.

const api = {
  opsRevenueTenants: vi.fn(), opsRevenueStrategies: vi.fn(), opsRevenueBatches: vi.fn(),
  opsRevenueSaveStrategy: vi.fn(), opsRevenuePreview: vi.fn(), opsRevenueCreateBatch: vi.fn(),
  opsRevenueBatch: vi.fn(),
};
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) }));
// The shared Modal pulls in the Tasks module's providers; a plain dialog is enough here.
vi.mock('../tasks/components', () => ({
  Modal: ({ title, children, footer }) => <div role="dialog" aria-label={title}>{children}<div>{footer}</div></div>,
}));

const { default: Revenue, filterTenants, defaultEffective, toBody, blankStrategy } = await import('./Revenue');

const FAC = { id: 'fac_t', shortName: 'Temecula' };
const tenant = (key, extra = {}) => ({
  key, leaseId: key, unitId: key, tenant: `Tenant ${key}`, unit: key.toUpperCase(), unitType: '10x10',
  moveIn: '2024-01-10', monthsStayed: 33, rent: 10000, street: 15000, gap: 5000, gapPct: 33.3,
  lastIncrease: '', lastIncreaseSource: '', monthsSinceIncrease: null, balance: 0, pastDue: false,
  scheduled: null, pending: null, url: '', ...extra,
});
const DATA = {
  facilityId: 'fac_t', facility: 'Temecula', asOf: '2026-10-20', writeEnabled: false,
  unitTypes: ['10x10', '10x20'],
  defaults: { method: 'percent', increasePct: 8, capMode: 'street', minMonthsIn: 12, minMonthsSince: 12, skipBalance: true, noticeDays: 30, roundDollar: true },
  tenants: [
    tenant('a1'),
    tenant('a2', { rent: 14500, gap: 500, gapPct: 3.3, monthsStayed: 6 }),
    tenant('b1', { unitType: '10x20', balance: 5000, pastDue: true, lastIncrease: '2026-05-01', lastIncreaseSource: 'cubby', monthsSinceIncrease: 5 }),
  ],
};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.opsRevenueTenants.mockResolvedValue(DATA);
  api.opsRevenueStrategies.mockResolvedValue({ strategies: [] });
  api.opsRevenueBatches.mockResolvedValue({ batches: [] });
});

describe('Revenue Management', () => {
  it('asks for a facility when none is picked', () => {
    render(<Revenue facility={null} facilities={[FAC]} onPick={() => {}} />);
    expect(screen.getByText('Choose a Facility')).toBeTruthy();
  });

  it('renders the tenant table with the gap, balance and last change', async () => {
    render(<Revenue facility={FAC} facilities={[FAC]} onPick={() => {}} />);
    expect(await screen.findByText('Tenant a1')).toBeTruthy();
    expect(screen.getAllByText('$50.00 (33.3%)')).toHaveLength(2);
    expect(screen.getByText('$50.00 Past Due')).toBeTruthy();
    expect(screen.getByText('05/01/2026')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Under street by more than percent'), { target: { value: '10' } });
    expect(screen.queryByText('Tenant a2')).toBeNull();
  });

  it('builds a new strategy and previews the impact', async () => {
    api.opsRevenuePreview.mockResolvedValue({
      scopeLabel: 'Unit type 10x10', effectiveDate: '2026-12-01', noticeDate: '2026-11-01',
      strategy: { summary: '+10%, capped at street rate' },
      totals: { inScope: 2, eligible: 1, skipped: 1, currentMonthly: 10000, newMonthly: 11000, monthlyIncrease: 1000,
        annualIncrease: 12000, avgIncreasePct: 10, capped: 0, skippedBy: {} },
      rows: [
        { ...tenant('a1'), eligible: true, reasons: [], newRent: 11000, increase: 1000, increasePct: 10, capped: false },
        { ...tenant('a2'), eligible: false, reasons: ['Moved in less than 12 months before the effective date'], newRent: 14500, increase: 0, increasePct: 0, capped: false },
      ],
    });
    render(<Revenue facility={FAC} facilities={[FAC]} onPick={() => {}} />);
    await screen.findByText('Tenant a1');
    fireEvent.click(screen.getByRole('button', { name: /Apply Strategy/ }));
    const dialog = screen.getByRole('dialog', { name: 'Apply a Strategy' });
    // No saved strategies: the form for a new one is open.
    fireEvent.change(within(dialog).getByLabelText('Increase percent'), { target: { value: '10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(api.opsRevenuePreview).toHaveBeenCalled());
    const body = api.opsRevenuePreview.mock.calls[0][0];
    expect(body.strategy.increase_pct).toBe(10);
    expect(body.scope).toEqual({ type: 'unit_type', unitType: '10x10' });
    expect(body.effective_date).toBe('2026-12-01');
    expect(await within(dialog).findByText('+$120.00')).toBeTruthy();          // annual impact
    expect(within(dialog).getByText('+$10.00')).toBeTruthy();                  // monthly impact
    expect(within(dialog).getByText(/Moved in less than 12 months/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save as Draft' }).disabled).toBe(false);
  });
});

describe('Revenue helpers', () => {
  it('filters tenants', () => {
    expect(filterTenants(DATA.tenants, { unitType: '10x20' }).map((t) => t.key)).toEqual(['b1']);
    expect(filterTenants(DATA.tenants, { stayed: '12' }).map((t) => t.key)).toEqual(['a1', 'b1']);
    expect(filterTenants(DATA.tenants, { noIncrease: '12' }).map((t) => t.key)).toEqual(['a1']);
  });

  it('picks the first of the month after the notice period', () => {
    expect(defaultEffective('2026-10-20', 30)).toBe('2026-12-01');
    expect(defaultEffective('2026-10-02', 30)).toBe('2026-11-01');
  });

  it('turns the form into the API body', () => {
    const b = toBody({ ...blankStrategy(), name: 'Flat', method: 'amount', increase_dollars: '25' });
    expect(b).toMatchObject({ name: 'Flat', method: 'amount', increase_cents: 2500, increase_pct: 0, notice_days: 30 });
  });
});
