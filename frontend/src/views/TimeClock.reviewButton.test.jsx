import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Timesheets to Review on Workday > Time Sheet (Oct 1): the list of
// timesheets submitted to me sits on my own Time Sheet tab - where the
// "Timesheet to review" bell lands - with a header button that jumps to it.
// Agree / Send Back work for any reviewer; Review (the full timecard in
// People > Time) only shows to those who can open People > Time. A
// time-tracking-exempt reviewer gets the Time Sheet tab while something waits.

const role = { level: 'manager', granted: new Set() };
const RANK = ['employee', 'supervisor', 'manager', 'administrator', 'owner'];
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: (min) => RANK.indexOf(role.level) >= RANK.indexOf(min), myGrantedModules: role.granted }),
}));
vi.mock('../components/PayrollTimecard', () => ({ default: () => <div>Timecard</div> }));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => () => Promise.resolve(
      key === 'timesheetReviewWaiting' ? { reviews: globalThis.__waiting || [] }
        : key === 'timeStatus' ? (globalThis.__status || {}) : []),
  });
  return { api, default: api };
});

const ROW = { id: 'r1', name: 'Valinda Cranfill', employeeEmail: 'v@x.com', periodStart: '2026-09-14', periodEnd: '2026-09-27',
  payType: 'hourly', workedMin: 4800, submittedAt: '2026-09-28', note: '', resubmitted: false, agreeBlocker: '' };
const SLOW = 20000;
beforeEach(() => {
  globalThis.__waiting = []; globalThis.__status = {};
  role.level = 'manager'; role.granted = new Set();
  Element.prototype.scrollIntoView = vi.fn();
});

async function renderTab(tab = 'timesheet') {
  const TimeClock = (await import('./TimeClock')).default;
  return render(<TimeClock initialTab={tab} activeSub={tab} onSubChange={() => {}} />);
}

describe('Timesheets to Review on the Time Sheet tab', () => {
  it('lists what is waiting, counts it on the header button, and the button jumps to the list', async () => {
    globalThis.__waiting = [ROW, { ...ROW, id: 'r2', name: 'Pranshu Upadhyay' }];
    await renderTab();
    expect(await screen.findByText('Valinda Cranfill')).toBeTruthy();
    expect(screen.getByText('2 waiting on you')).toBeTruthy();
    const btn = await screen.findByRole('button', { name: /Timesheets to Review/ });
    await waitFor(() => expect(screen.getByLabelText('2 waiting')).toBeTruthy());
    fireEvent.click(btn);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    // Agree / Send Back for a manager without the HR grant; no Review link.
    expect(screen.getAllByRole('button', { name: /Agree/ }).length).toBe(2);
    expect(screen.queryByRole('button', { name: /^Review/ })).toBeNull();
  }, SLOW);

  it('offers Review to someone who can open People > Time', async () => {
    globalThis.__waiting = [ROW];
    role.granted = new Set(['hr']);
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    await renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /^Review/ }));
    expect(nav.mock.calls[0][0].detail).toEqual({ view: 'hr', sub: 'hr-time' });
    window.removeEventListener('nexus:navigate', nav);
  }, SLOW);

  it('shows no button and no list when nothing is waiting', async () => {
    await renderTab();
    await screen.findByText('Timecard');
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('button', { name: /Timesheets to Review/ })).toBeNull();
    expect(screen.queryByText(/waiting on you/)).toBeNull();
  }, SLOW);

  it('gives a time-tracking-exempt reviewer the Time Sheet tab while something waits', async () => {
    globalThis.__status = { timeTrackingExempt: true };
    globalThis.__waiting = [ROW];
    await renderTab('overview');
    // ModuleTabs renders its strip as plain buttons outside the header provider.
    expect(await screen.findByRole('button', { name: 'Time Sheet' })).toBeTruthy();
  }, SLOW);
});
