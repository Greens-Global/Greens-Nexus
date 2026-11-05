import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The Time Sheet on a phone (Oct 14): one card per day instead of the
// 12-column table, which scrolled sideways and hid Hours, OT, Notes and the
// Work Log. The weekly total is a band between the weeks.

const now = new Date();
// Today on the card's clock (California) - not the test machine's, which
// runs in UTC on CI and is a day ahead every evening Pacific time.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
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
beforeEach(async () => {
  (await import('./PayrollTimecard')).clearTimecardCache();
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
    // One week at a time (11/04/2026), opened on the week holding today.
    expect(container.querySelectorAll('.pr-dcard')).toHaveLength(7);
    expect(container.querySelector(`[data-ts-day="${TODAY}"]`)).toBeTruthy();
    expect(screen.getByText(/OT 0:30/)).toBeTruthy();
    expect(screen.getByText('Front Desk')).toBeTruthy();
    expect(screen.getAllByText(/^Total hours clocked for week of /)).toHaveLength(1);
    // The summary card on top, hours:minutes only.
    expect(container.querySelector('.ts-psum').textContent).toContain('8:30');
    // Add Punch: on a past day with no punches, and in the bar at the bottom.
    expect(screen.getAllByRole('button', { name: /Add Punch/ }).length).toBeGreaterThan(0);
    // The other week is one tap away.
    const weekBtns = screen.getAllByRole('button', { name: /^Week [12]$/ });
    expect(weekBtns).toHaveLength(2);
    const other = weekBtns.find(b => b.getAttribute('aria-pressed') === 'false');
    fireEvent.click(other);
    expect(other.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector(`[data-ts-day="${TODAY}"]`)).toBeNull();
    expect(container.querySelectorAll('.pr-dcard')).toHaveLength(7);
  }, 20000);

  it('keeps the table on a desktop', async () => {
    PHONE = false;
    const { container } = await mount();
    await screen.findByText('Deducted Time');
    expect(container.querySelector('.pr-days')).toBeNull();
  }, 20000);
});
