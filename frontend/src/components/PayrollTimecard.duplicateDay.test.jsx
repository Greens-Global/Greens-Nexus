import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Duplicate Day (Oct 27 2026) is HR's: the Time Sheet shows it when the
// review says the viewer is HR (review.isHr), never to a plain manager -
// who keeps Add Time exactly as it was. The server refuses anyone else too.

const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
let isHr = false;
const card = () => ({
  payType: 'hourly', email: 'emp@x.com', rate: 25, rateSet: true,
  days: [{ date: TODAY, workedMin: 480, rate: 25, segments: [
    { in: `${TODAY}T15:00:00`, out: `${TODAY}T23:00:00`, inId: 'p-in', outId: 'p-out', workedMin: 480, otMin: 0, amount: 200, category: '', breaks: [] },
  ] }],
  pendingRequests: [], punchMeta: {}, totals: { workedMin: 480, regMin: 480, otMin: 0, totalPay: 200 },
  review: { status: 'open', isHr },
});

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => true, myLevel: 4, myEmail: 'hr@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => () => Promise.resolve(
      key === 'timePayroll' ? card()
        : key === 'timeTeam' ? { rows: [{ email: 'emp@x.com', name: 'Erin Employee' }] } : []),
  });
  return { api, default: api };
});

const realMatchMedia = window.matchMedia;
beforeEach(async () => {
  (await import('./PayrollTimecard')).clearTimecardCache();
  window.matchMedia = (q) => ({ matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  try { sessionStorage.clear(); } catch { /* jsdom */ }
});
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; });

async function open() {
  const PayrollTimecard = (await import('./PayrollTimecard')).default;
  render(<QueryClientProvider client={new QueryClient()}>
    <PayrollTimecard initialEmail="emp@x.com" initialStart={TODAY} toastOk={() => {}} toastErr={() => {}} />
  </QueryClientProvider>);
  await screen.findByText('Deducted Time');
}

describe('Duplicate Day on the Time Sheet', () => {
  it('shows for HR next to Add Time', async () => {
    isHr = true;
    await open();
    expect(screen.getByRole('button', { name: /Duplicate Day/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add Time/ })).toBeTruthy();
  }, 20000);

  it('is not there for a manager, who keeps Add Time', async () => {
    isHr = false;
    await open();
    expect(screen.queryByRole('button', { name: /Duplicate Day/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Add Time/ })).toBeTruthy();
  }, 20000);
});
