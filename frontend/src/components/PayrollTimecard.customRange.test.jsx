import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { rangePresets, rangeProblem } from './PayrollTimecard';

// Custom date range (Neil, 11/05/2026): the period button also offers a range;
// a range is fetched with custom=true and is a view - no approve, no edits.

const calls = [];
const card = (start, end, custom) => ({
  payType: 'hourly', email: 'emp@x.com', rate: 20, rateSet: true, days: [], punchMeta: {},
  totals: { workedMin: 0, regMin: 0, otMin: 0, totalPay: 0 },
  review: custom ? undefined : { status: 'open', canApprove: true },
  ...(custom ? { customRange: { start, end } } : {}),
});
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => true, myLevel: 4, myEmail: 'mgr@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => (...args) => {
      if (key === 'timePayroll') { calls.push(args); return Promise.resolve(card(args[1], args[2], args[3])); }
      return Promise.resolve(key === 'timeTeam' ? { rows: [{ email: 'emp@x.com', name: 'Erin Employee' }] } : []);
    },
  });
  return { api, default: api };
});

const realMatchMedia = window.matchMedia;
beforeEach(async () => {
  (await import('./PayrollTimecard')).clearTimecardCache();
  calls.length = 0;
  window.matchMedia = (q) => ({ matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
});
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; });

describe('range helpers', () => {
  it('builds the quick picks from today', () => {
    const p = Object.fromEntries(rangePresets(new Date(2026, 10, 5)).map(x => [x.label, [x.start, x.end]]));   // Thu 11/05/2026
    expect(p['This Week']).toEqual(['2026-11-01', '2026-11-07']);
    expect(p['Last Week']).toEqual(['2026-10-25', '2026-10-31']);
    expect(p['This Month']).toEqual(['2026-11-01', '2026-11-30']);
    expect(p['Last Month']).toEqual(['2026-10-01', '2026-10-31']);
    expect(p['Last 30 Days']).toEqual(['2026-10-07', '2026-11-05']);
    expect(p['This Year']).toEqual(['2026-01-01', '2026-11-05']);
  });
  it('checks the dates', () => {
    expect(rangeProblem('2026-10-01', '2026-10-31')).toBe('');
    expect(rangeProblem('2026-10-31', '2026-10-01')).toMatch(/before/);
    expect(rangeProblem('2025-01-01', '2026-10-01')).toMatch(/one year/);
    expect(rangeProblem('', '2026-10-01')).toMatch(/Pick/);
  });
});

describe('a custom range on People > Time', () => {
  it('loads the range as a view and goes back to the pay period', async () => {
    const PayrollTimecard = (await import('./PayrollTimecard')).default;
    render(<QueryClientProvider client={new QueryClient()}>
      <PayrollTimecard initialEmail="emp@x.com" initialStart="2026-10-18" toastOk={() => {}} toastErr={() => {}} />
    </QueryClientProvider>);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'Pick a pay period' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Last Month' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await screen.findByTestId('ts-range-note');
    const last = calls[calls.length - 1];
    expect(last[3]).toBe(true);
    expect(rangeProblem(last[1], last[2])).toBe('');
    expect(screen.queryByRole('button', { name: /Add Time/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add Note/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Pay Period' }));
    await waitFor(() => expect(screen.queryByTestId('ts-range-note')).toBeNull());
    expect(calls[calls.length - 1][3]).toBe(false);
  }, 20000);
});
