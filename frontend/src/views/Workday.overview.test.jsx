import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Workday Overview with the Time Clock folded in (Neil, Oct 1: "is there a
// need for the clock to be its own screen? ... it should be a widget and it
// should have the entire time clock in it"). Overview opens on the clock;
// there is no Clock tab, and an old 'clock' link lands on Overview. The
// employee code is gone from the employee's own profile, and paystubs are a
// folder inside My Documents rather than their own card.
// Cleanup (Neil, 11/08/2026): no profile card, no Hours / Time Off / Time
// With Us tiles - one row of action pills under the clock, the year's time
// off on My Schedule's week line, empty widgets one line each.

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
  it('opens on the clock widget with Punch In, above the action row', async () => {
    await renderWorkday('overview');
    expect(await screen.findByRole('region', { name: 'Time Clock' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Punch In/ })).toBeTruthy();
    expect(screen.getByText('Clocked Out')).toBeTruthy();
    // One state word (11/05/2026): the idle dial captions the time, it does not say a second state.
    expect(screen.getByText('Time Now')).toBeTruthy();
    expect(screen.queryByText('Not Clocked In')).toBeNull();
    // Phone layout hooks (Oct 13): the punch row is its own cell of the clock
    // card and the card is wrapped so the phone stylesheet can lead with it.
    expect(screen.getByRole('button', { name: /Punch In/ }).closest('.wd-punch-row')).toBeTruthy();
    expect(document.querySelector('.wd-overview > .wd-clock-wrap .wd-clock')).toBeTruthy();
    // The clock card comes first, the action pills right under it (11/08/2026);
    // the compact profile card (name, Reports to, Start date, no work email or
    // employment) heads the left column.
    expect(document.querySelector('.wd-overview > .wd-clock-wrap + .wd-actions')).toBeTruthy();
    expect(await screen.findByText('Amy Test')).toBeTruthy();
    expect(screen.getByText('Reports to')).toBeTruthy();
    expect(screen.getByText('01/15/2024')).toBeTruthy();
    expect(screen.queryByText('Work email')).toBeNull();
    expect(screen.queryByText('Employment')).toBeNull();
    // Overview, Time Sheet, Time Off, Purchase Requests (Oct 22 2026) - no Clock tab.
    const tabs = [...document.querySelectorAll('.module-tab-inline-btn')].map((b) => b.textContent.trim());
    // Purchase Requests is a popup from its Overview tile, not a tab (Sagar, Oct 27).
    expect(tabs).toEqual(['Overview', 'Time Sheet', 'Time Off', 'Performance']);
  }, SLOW);

  it('sends an old Clock link to Overview and rewrites the address', async () => {
    const onSubChange = await renderWorkday('clock');
    expect(await screen.findByRole('region', { name: 'Time Clock' })).toBeTruthy();
    await waitFor(() => expect(onSubChange).toHaveBeenCalledWith('overview'));
  }, SLOW);

  it('keeps the employee code off the profile and paystubs inside My Documents', async () => {
    await renderWorkday('overview');
    await screen.findByText('My Schedule');
    expect(screen.queryByText('EMP-0042')).toBeNull();
    expect(screen.queryByText(/Employee code/i)).toBeNull();
    expect(screen.queryByText('My paystubs')).toBeNull();
    expect(screen.getByText('My Documents', { selector: '.dash-card-title' })).toBeTruthy();
    // The only section, so it lists flat.
    expect(await screen.findByText('Paystub 09-30-2026.pdf')).toBeTruthy();
  }, SLOW);

  it('has no Time Off card (10/15); the time-off figure on My Schedule opens the tab (11/08/2026)', async () => {
    globalThis.__answers.timeOffMine = [
      { id: 't1', type: 'Medical Appointment', startDate: '2099-03-02', endDate: '2099-03-02', status: 'pending' },
    ];
    await renderWorkday('overview');
    expect(await screen.findByText('My Schedule')).toBeTruthy();
    expect(screen.queryByText('Medical Appointment')).toBeNull();
    expect(screen.queryByRole('button', { name: /Request Time Off/ })).toBeNull();
    expect(screen.queryByText('Time Off This Year')).toBeNull();
    // Its own line under the week summary, never inside it (the entry point does not wait on the shifts fetch).
    const line = await waitFor(() => { const el = document.querySelector('[data-trail]'); expect(el).toBeTruthy(); return el; });
    expect(line.textContent).toContain('Time off this year:');
    expect(screen.getByRole('status', { name: 'Week summary' }).textContent).not.toContain('Time off this year');
    // The figure is the button's accessible name (the explanation is its title).
    fireEvent.click(await within(line).findByRole('button', { name: '0d' }));
    expect(await screen.findByRole('button', { name: 'Reason: Personal' })).toBeTruthy();
  }, SLOW);

  it('shows the paid-leave balance on the week line once HR has balances on (11/02, line since 11/08)', async () => {
    globalThis.__answers.leaveMyBalance = {
      live: true,
      policy: { name: 'US Hourly' },
      vacation: { available: 51.07, method: 'per_hour' },
      sick: { available: 2, method: 'lump' },
    };
    await renderWorkday('overview');
    await screen.findByText('My Schedule');
    await waitFor(() => expect(document.querySelector('[data-trail]')?.textContent).toContain('Time off this year: 0d · 51h 04m vacation · 2h 00m sick left'));
  }, SLOW);

  it('keeps the plain time-off figure while balances are not set up', async () => {
    await renderWorkday('overview');
    await waitFor(() => expect(document.querySelector('[data-trail]')?.textContent).toMatch(/^Time off this year: 0d$/));
  }, SLOW);

  it("shows today's shift in the Hours tile with no greeting line, and the week Monday to Sunday", async () => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    globalThis.__answers.timeMySchedule = { scheduled: [{ id: 's1', date: today, start: '09:00', end: '17:30', label: 'Front Desk' }] };
    await renderWorkday('overview');
    // Today's shift is in My Schedule now, not the hero (Oct 15).
    await screen.findByText('My Schedule');
    expect(screen.queryByText(/^Good (Morning|Afternoon|Evening), Amy$/)).toBeNull();   // no greeting (Oct 14)
    expect(screen.queryByText('Your clock, hours, documents and time off - only you see this')).toBeNull();   // no header band
    expect(await screen.findByText('Front Desk')).toBeTruthy();          // in the My Schedule card
    expect(screen.queryByText("Today's Shift")).toBeNull();
  }, SLOW);

  it("draws today's shift as a live track while clocked in, and none without a shift (Neil, 11/02/2026)", async () => {
    const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
    const inAt = iso(now - 2 * 3600000).slice(0, 19);
    globalThis.__answers.timeStatus = {
      lastPunch: { kind: 'in', at: inAt }, allowed: ['out', 'break_start'],
      days: {}, todayShift: { startUtc: iso(now - 2 * 3600000), endUtc: iso(now + 6 * 3600000 + 30000) },
    };
    await renderWorkday('overview');
    const clock = await screen.findByRole('region', { name: 'Time Clock' });
    const bar = await within(clock).findByRole('progressbar', { name: "Today's shift" });
    expect(bar.closest('.nx-track').className).toContain('is-live');
    expect(within(clock).getByText('6h 01m left')).toBeTruthy();
    expect(clock.querySelector('.wd-shift-track .nx-track-marker')).toBeTruthy();
    cleanup();
    globalThis.__answers.timeStatus = { lastPunch: { kind: 'in', at: inAt }, allowed: ['out', 'break_start'], days: {}, todayShift: null };
    await renderWorkday('overview');
    const plain = await screen.findByRole('region', { name: 'Time Clock' });
    await within(plain).findByText('Clocked In');
    expect(within(plain).queryByRole('progressbar', { name: "Today's shift" })).toBeNull();
  }, SLOW);

  it('shows hours in the clock card behind a Today / This Week / Pay Period switch', async () => {
    await renderWorkday('overview');
    await screen.findByText('My Schedule');
    expect(screen.queryByText('Hours · This Week')).toBeNull();          // no tile (11/08/2026): the card's This Week is the one
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
    await screen.findByText('My Schedule');
    expect(screen.queryByText('No Shift Today')).toBeNull();
    expect(screen.queryByText('Signed, filed and paystubs')).toBeNull();
    // Nothing checked out: My Equipment is one line, title and words together (11/08/2026).
    const eq = screen.getByText('My Equipment').closest('.dash-card');
    expect(eq.classList.contains('wd-oneline')).toBe(true);
    expect(within(eq).getByText('Nothing checked out right now.')).toBeTruthy();
    expect(screen.queryByText('Assigned to you or checked out')).toBeNull();
    // Contact & Emergency empty: the nudge sentence inside the profile card, Edit opens the form in place.
    const contact = screen.getByText('Contact & Emergency').closest('.dash-card');
    expect(within(contact).getByText('Amy Test')).toBeTruthy();
    expect(within(contact).getByText('Nothing here yet - add your contact details so HR can reach you.')).toBeTruthy();
    fireEvent.click(within(contact).getByRole('button', { name: /Edit/ }));
    expect(screen.getByText('Emergency contact name')).toBeTruthy();
  }, SLOW);

  // Shifts Phase 3a + Oct 15: a "confirm your schedule" bell or email is your
  // own week, which lives on Workday's My Schedule card - the share it names
  // is the banner in front, and the address goes back to plain Overview.
  it('a confirm-your-schedule link opens My Schedule on that share', async () => {
    globalThis.__answers.timeMySchedule = { scheduled: [] };
    globalThis.__answers.timeMyConfirmations = { pending: [
      { publishId: 'pub-6', at: '2026-10-14T10:00:00Z', changes: 1 },
      { publishId: 'pub-7', at: '2026-10-15T10:00:00Z', changes: 2 }] };
    const onSubChange = await renderWorkday('shifts:confirm:pub-7');
    const banner = await waitFor(() => { const el = document.querySelector('[data-confirm-banner]'); expect(el).toBeTruthy(); return el; });
    expect(banner.getAttribute('data-confirm-banner')).toBe('pub-7');
    await waitFor(() => expect(onSubChange).toHaveBeenCalledWith('overview'));
  }, SLOW);

  it('opens the Time Sheet from the clock card', async () => {
    globalThis.__answers.timeMySchedule = { scheduled: [] };
    await renderWorkday('overview');
    const clock = await screen.findByRole('region', { name: 'Time Clock' });
    fireEvent.click(within(clock).getByRole('button', { name: /Time Sheet/ }));
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
    await screen.findByText('My Schedule');
    expect(screen.queryByRole('dialog', { name: 'Ask HR' })).toBeNull();     // no card on the page (Oct 15)
    fireEvent.click(screen.getByRole('button', { name: 'Ask HR' }));
    expect(screen.getByRole('dialog', { name: 'Ask HR' })).toBeTruthy();
    expect(screen.queryByText('What Do You Need?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /New Request/ }));
    expect(screen.getByText('What Do You Need?')).toBeTruthy();
    // No letters offered: no Request a Letter choice, and no form until a pick.
    expect(screen.queryByRole('radio', { name: /Request a Letter/ })).toBeNull();
    expect(screen.queryByText('Details')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Question for HR/ }));
    expect(screen.getByText('Details')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('What Do You Need?')).toBeNull();
  }, SLOW);

  // HR letters joined Ask HR (Neil, Oct 28 2026).
  it('asks for a letter from Ask HR and lists letters beside the tickets', async () => {
    try { localStorage.removeItem('nexus:askhr-seen'); } catch { /* ignore */ }
    globalThis.__answers.hrLetterTypes = [{ key: 'employment_verification', label: 'Employment Verification', desc: 'Confirms you work here.' }];
    globalThis.__answers.hrLettersMine = [
      { id: 'l1', typeLabel: 'Employment Verification', status: 'issued', statusLabel: 'Issued', documentId: 'env-1',
        purpose: 'Apartment lease', createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-21T10:00:00Z' },
    ];
    globalThis.__answers.myHrRequests = [
      { id: 't1', source: 'ticket', type: 'question', message: 'Leave policy?', status: 'open', createdAt: '2026-10-22T10:00:00Z' },
    ];
    await renderWorkday('overview');
    const btn = await screen.findByRole('button', { name: 'Ask HR, 1 update from HR' });   // the issued letter
    expect(within(btn).getByText('1 update from HR')).toBeTruthy();
    fireEvent.click(btn);
    const dialog = screen.getByRole('dialog', { name: 'Ask HR' });
    expect(within(dialog).getByText(/A letter, a document update/)).toBeTruthy();
    const rows = within(dialog).getAllByText(/Leave policy\?|Employment Verification ·/);
    expect(rows[0].textContent).toMatch(/Leave policy/);                       // newest first
    expect(within(dialog).getByRole('button', { name: /Download Letter/ })).toBeTruthy();
    expect(dialog.querySelectorAll('[data-ask-fresh]')).toHaveLength(1);
    fireEvent.change(within(dialog).getByLabelText('Filter my requests'), { target: { value: 'open' } });
    expect(within(dialog).queryByRole('button', { name: /Download Letter/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /New Request/ }));
    fireEvent.click(within(dialog).getByRole('radio', { name: /Request a Letter/ }));
    expect(within(dialog).getByRole('radio', { name: /Employment Verification/ })).toBeTruthy();
    expect(within(dialog).getByLabelText('What Is It For?')).toBeTruthy();
    expect(within(dialog).queryByText('Details')).toBeNull();
  }, SLOW);

  it('opens Ask HR on a letter link, with the requests waiting on HR at the top', async () => {
    globalThis.__answers.hrLetterQueue = { canReview: true, requests: [
      { id: 'q1', employeeName: 'Pat Peer', employeeEmail: 'pat@x.com', typeLabel: 'Salary Certificate', status: 'requested',
        statusLabel: 'Requested', purpose: 'Car loan', createdAt: '2026-10-27T10:00:00Z' },
    ] };
    const onSubChange = await renderWorkday('ask-hr');
    const dialog = await screen.findByRole('dialog', { name: 'Ask HR' });
    expect(await within(dialog).findByText('Waiting on You as HR')).toBeTruthy();
    expect(within(dialog).getByText('Pat Peer')).toBeTruthy();
    await waitFor(() => expect(onSubChange).toHaveBeenCalledWith('overview'));
  }, SLOW);

  it('shows an exempt person no clock, no time-tracking note and no Time Sheet tab', async () => {
    globalThis.__answers.timeStatus = { timeTrackingExempt: true, allowed: [], days: {} };
    await renderWorkday('overview');
    await screen.findByText('My Schedule');
    expect(screen.queryByText('Time Tracking Is Off for You')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Time Clock' })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Time Sheet/ })).toBeNull();
    // The answer is remembered for the next visit (per person - the role
    // mock has no email, so the key is the bare prefix).
    // Written by an effect after the status lands - wait for it (CI once read it before the write).
    await waitFor(() => expect(localStorage.getItem('nexus.timeExempt.')).toBe('1'));
  }, SLOW);

  it('shows the week in the clock card alone - no Hours tile, no Time With Us (11/08/2026)', async () => {
    // 11/05/2026: the tile waited on /time/me while the card already said
    // 1h 40m. 11/08/2026: the tile and the tenure tile went altogether.
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    globalThis.__answers.timeStatus = { allowed: ['in'], days: { [today]: { workedMin: 100, punches: [] } }, lastPunch: null };
    globalThis.__answers.timeMy = new Promise(() => {});
    globalThis.__answers.myHrProfile = { ...PROFILE, startDate: '' };
    await renderWorkday('overview');
    await screen.findByText('My Schedule');
    const clock = screen.getByRole('region', { name: 'Time Clock' });
    fireEvent.click(within(clock).getByRole('tab', { name: 'This Week' }));
    await waitFor(() => expect(clock.querySelector('.wd-hp-total').textContent).toBe('1h 40m'));
    expect(document.querySelector('.wd-hero')).toBeNull();
    expect(document.querySelector('.wd-statgrid')).toBeNull();
    expect(screen.queryByText('Time With Us')).toBeNull();
    expect(screen.queryByText('2.7y')).toBeNull();
  }, SLOW);

  it('shows a remembered-exempt person no clock skeleton or Hours tile while the status is still loading', async () => {
    // Neil, 10/08: swapping Dashboard > Workday as a salaried person showed
    // the time section loading, then took it away. Nothing answers here, so
    // only the memory can decide - and it does.
    localStorage.setItem('nexus.timeExempt.', '1');
    globalThis.__answers.timeStatus = new Promise(() => {});
    globalThis.__answers.timeMy = new Promise(() => {});
    await renderWorkday('overview');
    await screen.findByText('My Schedule');
    expect(screen.queryByRole('region', { name: 'Time Clock' })).toBeNull();
    expect(screen.queryByText('Hours · This Week')).toBeNull();
    expect([...document.querySelectorAll('.module-tab-inline-btn')].map((b) => b.textContent.trim())).toEqual(['Overview', 'Time Off', 'Performance']);
    expect(screen.getByRole('button', { name: 'Ask HR' })).toBeTruthy();   // the rest of Overview is there
  }, SLOW);

  it('holds the clock with a skeleton while the status loads for a tracked person', async () => {
    localStorage.setItem('nexus.timeExempt.', '0');
    globalThis.__answers.timeStatus = new Promise(() => {});
    await renderWorkday('overview');
    await screen.findByText('My Schedule');
    expect(screen.getByRole('region', { name: 'Time Clock' })).toBeTruthy();
    expect([...document.querySelectorAll('.module-tab-inline-btn')].map((b) => b.textContent.trim())).toContain('Time Sheet');
  }, SLOW);

  // Purchase Requisition moved here from Item Management (Neil, Oct 22 2026).
  // A popup like Reimbursements, not a tab (Sagar, Oct 27).
  it('has a Purchase Request tile beside Ask HR and Reimbursements that opens its popup', async () => {
    const onSubChange = await renderWorkday('overview');
    await screen.findByText('My Schedule');
    const tile = screen.getByRole('button', { name: 'Purchase Request' });
    expect(tile.closest('.wd-actions')).toBeTruthy();
    expect(tile.closest('.wd-actions').querySelectorAll('.wd-askhr')).toHaveLength(3);   // no form, no tickets: three pills
    fireEvent.click(tile);
    expect(await screen.findByRole('button', { name: /New Purchase Request/ })).toBeTruthy();
    expect(screen.getByText('No purchase requests yet')).toBeTruthy();
    const panel = screen.getByRole('dialog', { name: 'Purchase Requests' });
    expect(panel.style.width).toBe('85vw');
    expect(onSubChange).not.toHaveBeenCalledWith('purchase');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Purchase Requests' })).toBeNull();
  }, SLOW);

  it('opens the Purchase Requests popup from its link, and the form for purchase:new', async () => {
    // The request form reads the approver list through TanStack Query.
    const TimeClock = (await import('./TimeClock')).default;
    const { QueryClientProvider } = await import('@tanstack/react-query');
    const { queryClient } = await import('../lib/queryClient');
    const onSubChange = vi.fn();
    render(<QueryClientProvider client={queryClient}><TimeClock initialTab="overview" activeSub="purchase:new" onSubChange={onSubChange} /></QueryClientProvider>);
    expect(await screen.findByRole('dialog', { name: 'New Purchase Request' })).toBeTruthy();
    expect(screen.getByLabelText(/WHAT DO YOU NEED/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Purchase Requests' })).toBeTruthy();
    // The address settles on the Overview underneath.
    await waitFor(() => expect(onSubChange).toHaveBeenCalledWith('overview'));
  }, SLOW);
});
