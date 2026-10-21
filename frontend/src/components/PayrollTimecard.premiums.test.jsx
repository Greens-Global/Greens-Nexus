import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Shift differentials and call-back pay (Oct 17): a day that earned them gets
// its own line under the day, and the summary lists each differential and the
// call-back shortfall with its hours and pay - never added into the hours.

const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const CARD = {
  payType: 'hourly', email: 'me@x.com', rate: 25, rateSet: true,
  days: [{ date: TODAY, workedMin: 475, rate: 25,
    differentials: [{ name: 'Night Differential', min: 95, pay: 11.0 }], diffMin: 95, diffPay: 11.0,
    callBackMin: 60, callBackPay: 25.0, segments: [
    { in: `${TODAY}T15:35:00`, out: `${TODAY}T23:35:00`, inId: 'p-in', outId: 'p-out', workedMin: 475, otMin: 0, amount: 197.92, category: '',
      breaks: [{ start: `${TODAY}T19:05:00`, end: `${TODAY}T20:10:00`, min: 65, implicit: false, startId: 'p-bs', endId: 'p-be' }] },
  ] }],
  punchMeta: {
    'p-in': { kind: 'in', at: `${TODAY}T15:35:12`, source: 'Mobile app', ip: '10.0.0.7', site: 'GSE', manual: false },
    'p-be': { kind: 'break_end', at: `${TODAY}T20:10:00`, source: 'Entered by a manager', manual: true, createdBy: 'Charmi Desai', createdAt: `${TODAY}T21:00:00` },
  },
  totals: { workedMin: 475, regMin: 475, otMin: 0, regPay: 197.92, totalPay: 233.92,
    diffMin: 95, diffPay: 11.0, differentials: [{ name: 'Night Differential', min: 95, pay: 11.0 }],
    callBackMin: 60, callBackPay: 25.0 },
};

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => false, myLevel: 1, myEmail: 'me@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, { get: (_, key) => () => Promise.resolve(key === 'timeMyPayroll' ? CARD : []) });
  return { api, default: api };
});

const realMatchMedia = window.matchMedia;
beforeEach(async () => {
  (await import('./PayrollTimecard')).clearTimecardCache();
  window.matchMedia = (q) => ({ matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
});
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; });

describe('shift differentials on the Time Sheet', () => {
  it('shows the day line and the summary lines, outside the worked hours', async () => {
    const PayrollTimecard = (await import('./PayrollTimecard')).default;
    render(<QueryClientProvider client={new QueryClient()}>
      <PayrollTimecard selfMode toastOk={() => {}} toastErr={() => {}} />
    </QueryClientProvider>);
    await screen.findByText('Deducted Time');
    expect(screen.getByText(/1:35 worked in the window/)).toBeTruthy();
    expect(screen.getByText(/1:00 short of the minimum/)).toBeTruthy();
    expect(screen.getByText('Night Differential (shift differential)')).toBeTruthy();
    expect(screen.getByText(/^Call-Back Pay \(minimum not worked\)/)).toBeTruthy();
    expect(screen.getAllByText('$36.00').length).toBeGreaterThan(0);   // the day's line: 11 + 25
    expect(screen.getAllByText('$233.92').length).toBeGreaterThan(0);  // the period total includes them
  }, 20000);
});
