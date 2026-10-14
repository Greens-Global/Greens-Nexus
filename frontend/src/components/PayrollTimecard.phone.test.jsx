import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The Time Sheet on a phone (Oct 14): one card per day instead of the
// 12-column table, which scrolled sideways and hid Hours, OT, Notes and the
// Work Log. The weekly total is a band between the weeks.

const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const CARD = {
  payType: 'hourly', email: 'me@x.com', rate: 20, rateSet: true,
  days: [{ date: TODAY, workedMin: 510, segments: [
    { id: 1, in: `${TODAY}T15:00:00`, out: `${TODAY}T23:30:00`, workedMin: 510, otMin: 30, amount: 175, category: 'Front Desk', breaks: [] },
  ] }],
  totals: { workedMin: 510, regMin: 480, otMin: 30, totalPay: 175 },
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

let PHONE = true;
const realMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = (q) => ({ matches: PHONE && /max-width:\s*900px/.test(q), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
});
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; PHONE = true; });

const mount = async () => {
  const PayrollTimecard = (await import('./PayrollTimecard')).default;
  return render(<QueryClientProvider client={new QueryClient()}>
    <PayrollTimecard selfMode toastOk={() => {}} toastErr={() => {}} />
  </QueryClientProvider>);
};

describe('the Time Sheet on a phone', () => {
  it('draws a card per day with its hours, OT and category, and no table', async () => {
    const { container } = await mount();
    await screen.findByText('8:30', { selector: '.pr-dcard-total span' });
    expect(container.querySelector('.pr-days')).toBeTruthy();
    expect(container.querySelector('table[data-tour], [data-tour="pr-table"] table')).toBeNull();
    expect(container.querySelectorAll('.pr-dcard')).toHaveLength(14);
    expect(screen.getByText(/OT 0:30/)).toBeTruthy();
    expect(screen.getByText('Front Desk')).toBeTruthy();
    expect(screen.getAllByText(/^Week of /)).toHaveLength(2);
    // A day with no punches offers Add Punch on its one line.
    expect(screen.getAllByRole('button', { name: 'Add Punch' }).length).toBeGreaterThan(0);
  }, 20000);

  it('keeps the table on a desktop', async () => {
    PHONE = false;
    const { container } = await mount();
    await screen.findByText('Deducted time');
    expect(container.querySelector('.pr-days')).toBeNull();
  }, 20000);
});
