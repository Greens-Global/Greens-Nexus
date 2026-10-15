import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Workday Overview with the Time Clock folded in (Neil, Oct 1: "is there a
// need for the clock to be its own screen? ... it should be a widget and it
// should have the entire time clock in it"). Overview opens on the clock;
// there is no Clock tab, and an old 'clock' link lands on Overview. The
// employee code is gone from the employee's own profile, and paystubs are a
// folder inside My Documents rather than their own card.

vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set() }) }));
vi.mock('../components/PayrollTimecard', () => ({ default: () => <div>Timecard</div> }));
vi.mock('../components/DayTimeline', () => ({ default: () => <div>Timeline</div> }));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => () => {
      const a = globalThis.__answers || {};
      return key in a ? Promise.resolve(a[key]) : Promise.resolve(key === 'timesheetReviewWaiting' ? { reviews: [] } : []);
    },
  });
  return { api, default: api };
});

const PROFILE = { firstName: 'Amy', lastName: 'Test', jobTitle: 'Manager', department: 'Ops', status: 'active',
  employeeCode: 'EMP-0042', workEmail: 'amy@x.com', startDate: '2024-01-15', manager: 'Neil K' };
const SLOW = 20000;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  try { localStorage.removeItem('nx-wd-hours-view'); localStorage.removeItem('nexus.timeExempt.'); } catch { /* ignore */ }
  globalThis.__answers = {
    timeStatus: { allowed: ['in'], days: {}, lastPunch: null },
    myHrProfile: PROFILE,
    myHrDocs: [],
    timeOffMine: [],
    myPaystubs: [{ id: 'p1', name: 'Paystub 09-30-2026.pdf', createdAt: '2026-09-30T10:00:00' }],
    myAssets: { assignments: [], checkouts: [] },
    myHrRequests: [],
    myhrEgnyteDocs: { available: false },
    timeMy: { days: {} },
    timeMyPayroll: { periodStart: '2026-09-28', periodEnd: '2026-10-11', days: [], totals: { workedMin: 0 } },
    timeOffTypes: { builtIn: [], custom: [], requestsOn: true },
  };
});

async function renderWorkday(sub) {
  const TimeClock = (await import('./TimeClock')).default;
  const onSubChange = vi.fn();
  render(<TimeClock initialTab="overview" activeSub={sub} onSubChange={onSubChange} />);
  return onSubChange;
}

describe('Workday Overview with the Time Clock', () => {
  it('opens on the clock widget with Punch In, above the profile', async () => {
    await renderWorkday('overview');
    expect(await screen.findByRole('region', { name: 'Time Clock' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Punch In/ })).toBeTruthy();
    expect(screen.getByText('Clocked Out')).toBeTruthy();
    expect(screen.getByText('Not Clocked In')).toBeTruthy();
    // Phone layout hooks (Oct 13): the punch row is its own cell of the clock
    // card and the card is wrapped so the phone stylesheet can lead with it.
    expect(screen.getByRole('button', { name: /Punch In/ }).closest('.wd-punch-row')).toBeTruthy();
    expect(document.querySelector('.wd-overview > .wd-clock-wrap .wd-clock')).toBeTruthy();
    expect(await screen.findByText('Amy Test')).toBeTruthy();
    // Overview, Time Sheet, Time Off - no Clock tab.
    const tabs = [...document.querySelectorAll('.module-tab-inline-btn')].map((b) => b.textContent.trim());
    expect(tabs).toEqual(['Overview', 'Time Sheet', 'Time Off']);
  }, SLOW);

  it('sends an old Clock link to Overview and rewrites the address', async () => {
    const onSubChange = await renderWorkday('clock');
    expect(await screen.findByRole('region', { name: 'Time Clock' })).toBeTruthy();
    await waitFor(() => expect(onSubChange).toHaveBeenCalledWith('overview'));
  }, SLOW);

  it('keeps the employee code off the profile and paystubs inside My Documents', async () => {
    await renderWorkday('overview');
    await screen.findByText('Amy Test');
    expect(screen.queryByText('EMP-0042')).toBeNull();
    expect(screen.queryByText(/Employee code/i)).toBeNull();
    expect(screen.queryByText('My paystubs')).toBeNull();
    expect(screen.getByText('My Documents', { selector: '.dash-card-title' })).toBeTruthy();
    // The only section, so it lists flat.
    expect(await screen.findByText('Paystub 09-30-2026.pdf')).toBeTruthy();
  }, SLOW);

  it('has no Time Off card (10/15); the Time Off This Year tile opens the tab', async () => {
    globalThis.__answers.timeOffMine = [
      { id: 't1', type: 'Medical Appointment', startDate: '2099-03-02', endDate: '2099-03-02', status: 'pending' },
    ];
    await renderWorkday('overview');
    expect(await screen.findByText('My Schedule')).toBeTruthy();
    expect(screen.queryByText('Medical Appointment')).toBeNull();
    expect(screen.queryByRole('button', { name: /Request Time Off/ })).toBeNull();
    fireEvent.click(screen.getByText('Time Off This Year'));
    expect(await screen.findByRole('button', { name: 'Reason: Personal' })).toBeTruthy();
  }, SLOW);

  it("shows today's shift in the Hours tile with no greeting line, and the week Monday to Sunday", async () => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    globalThis.__answers.timeMySchedule = { scheduled: [{ id: 's1', date: today, start: '09:00', end: '17:30', label: 'Front Desk' }] };
    await renderWorkday('overview');
    // Today's shift is in My Schedule now, not the hero (Oct 15).
    await screen.findByText('Amy Test');
    expect(screen.queryByText(/^Good (Morning|Afternoon|Evening), Amy$/)).toBeNull();   // no greeting (Oct 14)
    expect(screen.queryByText('Your clock, hours, documents and time off - only you see this')).toBeNull();   // no header band
    expect(await screen.findByText('Front Desk')).toBeTruthy();          // in the My Schedule card
    expect(screen.queryByText("Today's Shift")).toBeNull();
  }, SLOW);

  it('shows hours in the clock card behind a Today / This Week / Pay Period switch', async () => {
    await renderWorkday('overview');
    await screen.findByText('Amy Test');
    expect(screen.getByText('Hours · This Week')).toBeTruthy();          // the tile stays
    const clock = screen.getByRole('region', { name: 'Time Clock' });
    const tabs = within(clock).getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Today', 'This Week', 'Pay Period']);
    expect(within(clock).getByText('Worked today')).toBeTruthy();           // Today by default (Neil, Oct 14)
    // The week: seven days against the 8-hour line.
    fireEvent.click(within(clock).getByRole('tab', { name: 'This Week' }));
    expect(within(clock).getAllByRole('listitem').length).toBe(7);
    // The pay period: every day of it, not only the days with hours.
    fireEvent.click(within(clock).getByRole('tab', { name: 'Pay Period' }));
    expect(within(clock).getAllByRole('listitem').length).toBe(14);
    expect(within(clock).getByText('Worked Sep 28 - Oct 11')).toBeTruthy();
    fireEvent.click(within(clock).getByRole('tab', { name: 'Today' }));
    expect(within(clock).getByText('Worked today')).toBeTruthy();
    expect(screen.queryByText('My Hours')).toBeNull();                   // no separate card
  }, SLOW);

  it('has no Today\'s Shift half on the hero, and no My Documents tile', async () => {
    globalThis.__answers.timeMySchedule = { scheduled: [] };
    await renderWorkday('overview');
    await screen.findByText('Amy Test');
    expect(screen.queryByText('No Shift Today')).toBeNull();
    expect(screen.queryByText('Signed, filed and paystubs')).toBeNull();
  }, SLOW);

  it('opens the Time Sheet from the hours', async () => {
    globalThis.__answers.timeMySchedule = { scheduled: [] };
    await renderWorkday('overview');
    expect(await screen.findByText('My Schedule')).toBeTruthy();
    fireEvent.click(screen.getByText('Hours · This Week'));
    expect(await screen.findByText('Timecard')).toBeTruthy();   // the Time Sheet tab
  }, SLOW);

  it('dots the Ask HR button when HR answered, marks the request, and clears once seen', async () => {
    try { localStorage.removeItem('nexus:askhr-seen'); } catch { /* ignore */ }
    globalThis.__answers.myHrRequests = [
      { id: 'r1', type: 'document', message: 'Update my visa', status: 'resolved', response: 'Done - filed.', resolvedAt: '2026-10-14T10:00:00Z', createdAt: '2026-10-10T10:00:00Z' },
      { id: 'r2', type: 'question', message: 'Leave policy?', status: 'open', response: '', resolvedAt: '', createdAt: '2026-10-12T10:00:00Z' },
    ];
    await renderWorkday('overview');
    const btn = await screen.findByRole('button', { name: 'Ask HR, 1 update from HR' });
    expect(btn.querySelector('[data-askhr-dot]')).toBeTruthy();
    fireEvent.click(btn);
    const dialog = screen.getByRole('dialog', { name: 'Ask HR' });
    expect(dialog.querySelectorAll('[data-ask-fresh]')).toHaveLength(1);        // only the answered one
    expect(within(dialog).getByText('Updated by HR')).toBeTruthy();
    expect(within(dialog).getByText('Leave policy?')).toBeTruthy();              // old requests are listed too
    cleanup();
    await renderWorkday('overview');
    expect(await screen.findByRole('button', { name: 'Ask HR' })).toBeTruthy();   // seen: no dot
  }, SLOW);

  it('opens Ask HR from the button in the top row, and its form only on New Request', async () => {
    await renderWorkday('overview');
    await screen.findByText('Amy Test');
    expect(screen.queryByRole('dialog', { name: 'Ask HR' })).toBeNull();     // no card on the page (Oct 15)
    fireEvent.click(screen.getByRole('button', { name: 'Ask HR' }));
    expect(screen.getByRole('dialog', { name: 'Ask HR' })).toBeTruthy();
    expect(screen.queryByText('What do you need?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /New Request/ }));
    expect(screen.getByText('What do you need?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('What do you need?')).toBeNull();
  }, SLOW);

  it('shows an exempt person no clock, no time-tracking note and no Time Sheet tab', async () => {
    globalThis.__answers.timeStatus = { timeTrackingExempt: true, allowed: [], days: {} };
    await renderWorkday('overview');
    await screen.findByText('Amy Test');
    expect(screen.queryByText('Time Tracking Is Off for You')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Time Clock' })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Time Sheet/ })).toBeNull();
    // The answer is remembered for the next visit (per person - the role
    // mock has no email, so the key is the bare prefix).
    // Written by an effect after the status lands - wait for it (CI once read it before the write).
    await waitFor(() => expect(localStorage.getItem('nexus.timeExempt.')).toBe('1'));
  }, SLOW);

  it('shows a remembered-exempt person no clock skeleton or Hours tile while the status is still loading', async () => {
    // Neil, 10/08: swapping Dashboard > Workday as a salaried person showed
    // the time section loading, then took it away. Nothing answers here, so
    // only the memory can decide - and it does.
    localStorage.setItem('nexus.timeExempt.', '1');
    globalThis.__answers.timeStatus = new Promise(() => {});
    globalThis.__answers.timeMy = new Promise(() => {});
    await renderWorkday('overview');
    await screen.findByText('Amy Test');
    expect(screen.queryByRole('region', { name: 'Time Clock' })).toBeNull();
    expect(screen.queryByText('Hours · This Week')).toBeNull();
    expect([...document.querySelectorAll('.module-tab-inline-btn')].map((b) => b.textContent.trim())).toEqual(['Overview', 'Time Off']);
    expect(screen.getByText('Time Off This Year')).toBeTruthy();   // the rest of Overview is there
  }, SLOW);

  it('holds the clock with a skeleton while the status loads for a tracked person', async () => {
    localStorage.setItem('nexus.timeExempt.', '0');
    globalThis.__answers.timeStatus = new Promise(() => {});
    await renderWorkday('overview');
    await screen.findByText('Amy Test');
    expect(screen.getByRole('region', { name: 'Time Clock' })).toBeTruthy();
    expect([...document.querySelectorAll('.module-tab-inline-btn')].map((b) => b.textContent.trim())).toContain('Time Sheet');
  }, SLOW);
});
