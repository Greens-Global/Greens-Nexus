import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// A manager on someone's open shift today (Oct 26): the clock-out is still to
// come, so the form starts with Clock Out unticked and saves only what is
// ticked. A 5 PM clock-out saved at 10 AM jammed the person's clock until 5.

const TODAY = '2026-10-28';   // a Wednesday; the same date in California, India and UTC at 18:00Z
const OPEN = { in: `${TODAY}T15:31:00`, inId: 'p-in', out: null, outId: '', workedMin: 0, otMin: 0, amount: 0, category: '' };
const CARD = {
  payType: 'hourly', email: 'emp@x.com', rate: 22, rateSet: true,
  days: [{ date: TODAY, workedMin: 0, rate: 22, segments: [OPEN] }],
  punchMeta: { 'p-in': { kind: 'in', at: OPEN.in, source: 'Mobile app', manual: false, clock: true } },
  totals: { workedMin: 0, regMin: 0, otMin: 0, regPay: 0, totalPay: 0 },
};
const calls = vi.hoisted(() => []);

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => true, myLevel: 4, myEmail: 'hr@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => (...args) => {
      if (key === 'timeAddPunch' || key === 'timeAdjustPunch') { calls.push([key, ...args]); return Promise.resolve({}); }
      return Promise.resolve((key === 'timePayroll' || key === 'timeMyPayroll') ? CARD
        : key === 'timeTeam' ? { rows: [{ email: 'emp@x.com', name: 'Nimi Patel' }] } : []);
    },
  });
  return { api, default: api };
});

const realMatchMedia = window.matchMedia;
beforeEach(async () => {
  calls.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T18:00:00Z`));
  (await import('./PayrollTimecard')).clearTimecardCache();
  window.matchMedia = (q) => ({ matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  try { sessionStorage.clear(); } catch { /* jsdom */ }
});
afterEach(() => { cleanup(); vi.useRealTimers(); window.matchMedia = realMatchMedia; });

async function openMissingOut() {
  const PayrollTimecard = (await import('./PayrollTimecard')).default;
  render(<QueryClientProvider client={new QueryClient()}>
    <PayrollTimecard initialEmail="emp@x.com" initialStart={TODAY} toastOk={() => {}} toastErr={() => {}} />
  </QueryClientProvider>);
  fireEvent.click(await screen.findByTitle('Add the missing clock-out'));
  return screen.findByRole('dialog', { name: 'Edit punch' });
}

describe('a manager on an open shift today', () => {
  it('starts with Clock Out unticked and saves without adding one', async () => {
    const dialog = await openMissingOut();
    expect(within(dialog).getByRole('checkbox', { name: 'Clock Out' }).checked).toBe(false);
    expect(within(dialog).queryByLabelText('Clock out time')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit punch' })).toBeNull());
    expect(calls.filter(([k]) => k === 'timeAddPunch')).toEqual([]);
  }, 20000);

  it('adds the clock-out once it is ticked and in the past', async () => {
    const dialog = await openMissingOut();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Clock Out' }));
    const inAt = within(dialog).getByLabelText('Clock in time').value;
    // An hour after the clock-in, which is hours before "now".
    const out = `${inAt.slice(0, 11)}${String(Number(inAt.slice(11, 13)) + 1).padStart(2, '0')}${inAt.slice(13)}`;
    fireEvent.change(within(dialog).getByLabelText('Clock out time'), { target: { value: out } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some(([k, b]) => k === 'timeAddPunch' && b.kind === 'out')).toBe(true));
  }, 20000);

  it('refuses a clock-out still to come', async () => {
    const dialog = await openMissingOut();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Clock Out' }));
    fireEvent.change(within(dialog).getByLabelText('Clock out time'), { target: { value: '2026-10-29T09:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/still to come/);
    expect(calls).toEqual([]);
  }, 20000);
});
