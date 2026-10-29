import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// A time-tracking-exempt person has no time card (Charmi, Aug 21), and the
// Workday salary advance card is gone (Neil, Oct 29 2026) - their advances
// are on their Time Sheet tab on their own, "Your Salary Advances"
// (Oct 29 2026 review: they had lost them).

const SLOW = 20000;
const calls = [];
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: new Set(), myEmail: 'sal@x.com' }),
}));
vi.mock('../components/PayrollTimecard', () => ({ default: () => <div>Timecard</div> }));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => (...a) => {
      if (key === 'personSalaryAdvances') calls.push(a[0]);
      return Promise.resolve(
        key === 'timeStatus' ? (globalThis.__status || {})
          : key === 'timesheetReviewWaiting' ? { reviews: [], toSign: [] }
            : key === 'personSalaryAdvances' ? (globalThis.__adv || { advances: [] }) : []);
    },
  });
  return { api, default: api };
});

const PAID = {
  id: 'a1', email: 'sal@x.com', name: 'Sal Exempt', company: 'c1', amount: 1200, currency: 'USD', reason: 'Moving costs',
  installments: 2, status: 'paid_out', statusLabel: 'Paid Out', source: 'grant', requestedBy: 'hana@x.com',
  requestedByName: 'Hana Test', requestedAt: '2026-10-20T17:00:00Z', decidedByName: 'Hana Test', decidedAt: '', decisionNote: '',
  paidOn: '2026-10-21', paidByName: 'Hana Test', paymentMethod: 'ach', paymentRef: '', repaid: 0, balance: 1200, scheduled: 1200,
  schedule: [], history: [], createdAt: '', updatedAt: '', payVisible: true, canDecide: false,
};

beforeEach(() => {
  calls.length = 0;
  globalThis.__status = { timeTrackingExempt: true };
  globalThis.__adv = { email: 'sal@x.com', name: 'Sal Exempt', canAsk: '', advances: [PAID] };
  Element.prototype.scrollIntoView = vi.fn();
});

async function renderTab(tab) {
  const TimeClock = (await import('./TimeClock')).default;
  return render(<TimeClock initialTab={tab} activeSub={tab} onSubChange={() => {}} />);
}

describe('an exempt person\'s own salary advances', () => {
  it('are on their Time Sheet tab, with no time card', async () => {
    await renderTab('timesheet');
    expect(await screen.findByText('Your Salary Advances')).toBeTruthy();
    expect(screen.getByText('$1,200.00')).toBeTruthy();
    expect(screen.getByText(/Paid out 10\/21\/2026/)).toBeTruthy();
    expect(screen.queryByText('Timecard')).toBeNull();
    expect(calls).toContain('sal@x.com');
  }, SLOW);

  it('bring the Time Sheet tab when there is nothing to sign', async () => {
    await renderTab('overview');
    expect(await screen.findByRole('button', { name: 'Time Sheet' })).toBeTruthy();
  }, SLOW);

  it('leave no tab and no section when there are none', async () => {
    globalThis.__adv = { email: 'sal@x.com', advances: [] };
    await renderTab('overview');
    await waitFor(() => expect(calls).toContain('sal@x.com'));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: 'Time Sheet' })).toBeNull();
    expect(screen.queryByText('Your Salary Advances')).toBeNull();
  }, SLOW);
});
