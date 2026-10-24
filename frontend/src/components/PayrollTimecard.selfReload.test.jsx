import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Oct 23 (Charmi, item 17: "When you do refresh it should take you back to the
// same screen"): my own Time Sheet (Workday > Time Clock) reopens on the pay
// period that was on screen, as HR's card already does with its own key.

const card = () => ({
  payType: 'hourly', email: 'me@x.com', rate: 25, rateSet: true, days: [],
  pendingRequests: [], punchMeta: {}, totals: { workedMin: 0, regMin: 0, otMin: 0, totalPay: 0 },
});
const calls = [];
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => true, myLevel: 1, myEmail: 'me@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => (...args) => {
      calls.push([key, ...args]);
      return Promise.resolve(key === 'timeMyPayroll' || key === 'timePayroll' ? card() : []);
    },
  });
  return { api, default: api };
});

const realMatchMedia = window.matchMedia;
beforeEach(async () => {
  (await import('./PayrollTimecard')).clearTimecardCache();
  (await import('../lib/refreshState')).resetRefreshForTests();
  window.matchMedia = (q) => ({ matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  sessionStorage.clear();
  calls.length = 0;
});
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; });

async function openSelf() {
  const PayrollTimecard = (await import('./PayrollTimecard')).default;
  return render(<QueryClientProvider client={new QueryClient()}>
    <PayrollTimecard selfMode toastOk={() => {}} toastErr={() => {}} />
  </QueryClientProvider>);
}
const myStarts = () => calls.filter((c) => c[0] === 'timeMyPayroll').map((c) => c[1]);

describe('my Time Sheet after a reload', () => {
  it('reopens on the pay period that was on screen', async () => {
    // 08/09/2026 is a Sunday on the bi-weekly series (anchor 01/14/2024 + 67 periods).
    sessionStorage.setItem('nexus.refresh.timeclock.my-time-sheet', JSON.stringify({ start: '2026-08-09', payType: 'hourly' }));
    await openSelf();
    await waitFor(() => expect(myStarts()).toContain('2026-08-09'));
  });

  it('keeps the period on screen for the next reload', async () => {
    await openSelf();
    await waitFor(() => expect(myStarts().length).toBeGreaterThan(0));
    const kept = JSON.parse(sessionStorage.getItem('nexus.refresh.timeclock.my-time-sheet'));
    expect(kept.start).toBe(myStarts()[0]);
  });

  it("leaves HR's card on its own key", async () => {
    sessionStorage.setItem('nexus.refresh.timeclock.my-time-sheet', JSON.stringify({ start: '2026-08-09', payType: 'hourly' }));
    const PayrollTimecard = (await import('./PayrollTimecard')).default;
    render(<QueryClientProvider client={new QueryClient()}>
      <PayrollTimecard initialEmail="emp@x.com" toastOk={() => {}} toastErr={() => {}} />
    </QueryClientProvider>);
    await waitFor(() => expect(calls.some((c) => c[0] === 'timePayroll')).toBe(true));
    expect(calls.filter((c) => c[0] === 'timePayroll').map((c) => c[2])).not.toContain('2026-08-09');
    expect(screen.queryByText(/08\/02\/2026/)).toBeNull();
  });
});
