import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Workday > Time Sheet (Oct 22): Time Sheets to Review moved to People > Time
// only. The tab keeps Time Sheets to Sign - my own time sheet waiting on my
// signature, signed in place.

const role = { level: 'manager', granted: new Set() };
const RANK = ['employee', 'supervisor', 'manager', 'administrator', 'owner'];
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: (min) => RANK.indexOf(role.level) >= RANK.indexOf(min), myGrantedModules: role.granted }),
}));
vi.mock('../components/PayrollTimecard', () => ({ default: () => <div>Timecard</div> }));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => () => Promise.resolve(
      key === 'timesheetReviewWaiting' ? { reviews: globalThis.__waiting || [], toSign: globalThis.__toSign || [] }
        : key === 'timeStatus' ? (globalThis.__status || {}) : []),
  });
  return { api, default: api };
});

const ROW = { id: 'r1', name: 'Valinda Cranfill', employeeEmail: 'v@x.com', periodStart: '2026-09-14', periodEnd: '2026-09-27',
  payType: 'hourly', workedMin: 4800, submittedAt: '2026-09-28', note: '', resubmitted: false, agreeBlocker: '' };
const SLOW = 20000;
beforeEach(() => {
  globalThis.__waiting = []; globalThis.__toSign = []; globalThis.__status = {};
  role.level = 'manager'; role.granted = new Set();
  Element.prototype.scrollIntoView = vi.fn();
});

async function renderTab(tab = 'timesheet') {
  const TimeClock = (await import('./TimeClock')).default;
  return render(<TimeClock initialTab={tab} activeSub={tab} onSubChange={() => {}} />);
}

describe('Workday > Time Sheet: signing only, reviewing is in People > Time (Oct 22)', () => {
  it('does not list time sheets waiting on my review', async () => {
    globalThis.__waiting = [ROW, { ...ROW, id: 'r2', name: 'Pranshu Upadhyay' }];
    await renderTab();
    await screen.findByText('Timecard');
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Valinda Cranfill')).toBeNull();
    expect(screen.queryByText(/waiting on you/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull();
  }, SLOW);

  it('still lists my time sheet waiting on my signature', async () => {
    globalThis.__toSign = [{ id: 's1', partyId: 'p1', role: 'employee', employeeEmail: 'me@x.com', name: 'Me',
      periodStart: '2026-09-14', periodEnd: '2026-09-27', payType: 'hourly' }];
    await renderTab();
    expect(await screen.findByText('Time Sheets to Sign')).toBeTruthy();
    expect(screen.getByText('1 waiting on your signature')).toBeTruthy();
  }, SLOW);

  it('gives a time-tracking-exempt person no Time Sheet tab for reviews alone', async () => {
    globalThis.__status = { timeTrackingExempt: true };
    globalThis.__waiting = [ROW];
    await renderTab('overview');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: 'Time Sheet' })).toBeNull();
  }, SLOW);
});
