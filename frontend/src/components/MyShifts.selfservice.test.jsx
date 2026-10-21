import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Shifts > My Shifts (Oct 2026; decluttered 10/02): one line that says the
// week, my shared shifts as one-line blocks, time off BESIDE a shift (a
// partial day with its hours), the group grid laid out like Teams Shifts
// (a day list on a phone), a Request link under a shift that opens the one
// request dialog, open shifts requestable only from today on, the zone chip
// only in another zone, availability that never saves over a failed load,
// and an error with Retry.

const timeMySchedule = vi.fn();
const shiftRequestsMine = vi.fn();
const shiftRequestCreate = vi.fn();
const availabilityMine = vi.fn();
const availabilitySave = vi.fn();
const weatherCallMine = vi.fn();
const weatherCallMyPrefs = vi.fn();
const weatherCallAck = vi.fn();
const weatherCallMyPrefsSave = vi.fn();
const timeSchedActuals = vi.fn();
const timeMyScheduleLive = vi.fn();
const timeMyConfirmations = vi.fn();
const timeSchedConfirm = vi.fn();
const timeMyPrefsGet = vi.fn();
const timeMyPrefsSet = vi.fn();
const timeMyIcalLink = vi.fn();
const timeMyIcalRotate = vi.fn();
const confirmAsk = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmAsk(...a), prompt: vi.fn(), alert: vi.fn() } }));
vi.mock('../api', () => ({
  api: {
    timeMySchedule: (...a) => timeMySchedule(...a),
    timeSchedActuals: (...a) => timeSchedActuals(...a),
    timeMyScheduleLive: (...a) => timeMyScheduleLive(...a),
    timeMyConfirmations: (...a) => timeMyConfirmations(...a),
    timeSchedConfirm: (...a) => timeSchedConfirm(...a),
    timeMyPrefsGet: (...a) => timeMyPrefsGet(...a),
    timeMyPrefsSet: (...a) => timeMyPrefsSet(...a),
    timeMyIcalLink: (...a) => timeMyIcalLink(...a),
    timeMyIcalRotate: (...a) => timeMyIcalRotate(...a),
    weatherCallMine: (...a) => weatherCallMine(...a),
    weatherCallMyPrefs: (...a) => weatherCallMyPrefs(...a),
    weatherCallAck: (...a) => weatherCallAck(...a),
    weatherCallMyPrefsSave: (...a) => weatherCallMyPrefsSave(...a),
    shiftRequestsMine: (...a) => shiftRequestsMine(...a),
    shiftRequestCreate: (...a) => shiftRequestCreate(...a),
    shiftRequestRespond: vi.fn(), shiftRequestCancel: vi.fn(),
    availabilityMine: (...a) => availabilityMine(...a),
    availabilitySave: (...a) => availabilitySave(...a),
    getPeopleDirectory: vi.fn().mockResolvedValue([{ email: 'me@x.com', name: 'Me Here' }, { email: 'bob@x.com', name: 'Bob Brown' }]),
    getRolesDirectory: vi.fn().mockResolvedValue([]),
  },
}));

const MyShifts = (await import('./MyShifts')).default;

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DAY = iso(new Date());
const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
// A day in this week before today (the week's Monday if today is not Monday), else null.
const monday = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); })();
const PAST = monday < DAY ? monday : null;

const sched = {
  shift: null, timeoff: [], holidays: [], timeZone: 'America/Los_Angeles',
  scheduled: [{ id: 'mine1', email: 'me@x.com', date: DAY, start: '09:00', end: '17:00', label: 'Front Desk', published: true }],
  teams: [{ id: 'g', name: 'Store', members: [
    { email: 'me@x.com', name: 'Me Here', isMe: true, scheduled: [], timeoff: [] },
    { email: 'bob@x.com', name: 'Bob Brown', isMe: false, timeoff: [], scheduled: [{ id: 'bob1', email: 'bob@x.com', date: DAY, start: '12:00', end: '20:00', label: '' }] },
  ] }],
};
const reqs = (over = {}) => ({
  mine: [], incoming: [], openShifts: [], teammates: [{ email: 'bob@x.com', name: 'Bob Brown' }],
  swapShifts: { 'bob@x.com': [{ id: 'bob1', email: 'bob@x.com', date: DAY, start: '12:00', end: '20:00', label: '' }] },
  settings: { openShifts: true, swaps: true, offers: true }, ...over,
});

beforeEach(() => {
  timeMySchedule.mockReset().mockResolvedValue(sched);
  weatherCallMine.mockReset().mockResolvedValue({ calls: [] });
  weatherCallMyPrefs.mockReset().mockResolvedValue(null);
  weatherCallAck.mockReset().mockResolvedValue({ ok: true });
  weatherCallMyPrefsSave.mockReset().mockResolvedValue({ weatherSms: false, phone: false });
  timeSchedActuals.mockReset().mockResolvedValue({ cells: {}, people: {}, totals: {} });
  timeMyScheduleLive.mockReset().mockRejectedValue(new Error('API error 404'));
  timeMyConfirmations.mockReset().mockResolvedValue({ pending: [] });
  timeSchedConfirm.mockReset().mockResolvedValue({ ok: true });
  timeMyPrefsGet.mockReset().mockResolvedValue({ shiftCalendar: true, companyOutlookCalendar: true, hasMailbox: true, showAs: 'free' });
  timeMyPrefsSet.mockReset().mockImplementation(async (b) => ({ shiftCalendar: b.shiftCalendar !== false, companyOutlookCalendar: true, hasMailbox: true, showAs: 'free' }));
  window.history.replaceState({}, '', '/shifts/mine');
  timeMyIcalLink.mockReset().mockResolvedValue({ url: 'https://api.nexus.test/timeclock/ical/abc123.ics' });
  timeMyIcalRotate.mockReset().mockResolvedValue({ url: 'https://api.nexus.test/timeclock/ical/new456.ics' });
  confirmAsk.mockReset().mockResolvedValue(true);
  shiftRequestsMine.mockReset().mockResolvedValue(reqs());
  shiftRequestCreate.mockReset().mockResolvedValue({});
  availabilityMine.mockReset().mockResolvedValue({ days: [] });
  availabilitySave.mockReset().mockImplementation(async (b) => ({ days: b.days.filter((d) => d.kind !== 'any') }));
});

describe('MyShifts weather calls', () => {
  // Weather Call (Oct 2026): a call on one of my days sits at the top until
  // I acknowledge it; the texts switch is mine.
  it('shows an open weather call with Acknowledge, and the texts switch', async () => {
    weatherCallMine.mockResolvedValue({ calls: [
      { id: 'd1', groupName: 'Yard Crew', date: plus(1), kind: 'cancel', status: 'active', outcome: 'cancelled', reason: 'Flooded road', headline: 'Day cancelled for weather (unpaid)', ackAt: '' },
      { id: 'd0', groupName: 'Yard Crew', date: PAST || DAY, kind: 'delay', status: 'active', outcome: 'delayed', reason: '', headline: 'Start delayed to 10:00 AM for weather', ackAt: '2026-10-01T00:00:00Z' },
    ] });
    weatherCallMyPrefs.mockResolvedValue({ weatherSms: true, phone: false });
    weatherCallAck.mockResolvedValue({ ok: true });
    weatherCallMyPrefsSave.mockImplementation(async (b) => ({ weatherSms: b.weatherSms, phone: false }));
    render(<MyShifts />);
    const card = await screen.findByRole('alert');
    expect(card.textContent).toContain('Day cancelled for weather (unpaid)');
    expect(card.textContent).toContain('Yard Crew');
    expect(card.textContent).toContain('Flooded road · The day is unpaid.');
    expect(screen.queryByText('Start delayed to 10:00 AM for weather')).toBeNull();   // already acknowledged
    fireEvent.click(within(card).getByRole('button', { name: /Acknowledge/ }));
    await waitFor(() => expect(weatherCallAck).toHaveBeenCalledWith('d1'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    const sw = await screen.findByLabelText('Text me when a weather call changes my shift');
    expect(sw.checked).toBe(true);
    expect(screen.getByText(/no phone number on file/)).toBeTruthy();
    fireEvent.click(sw);
    await waitFor(() => expect(weatherCallMyPrefsSave).toHaveBeenCalledWith({ weatherSms: false }));
  });
});

describe('MyShifts week and group grid', () => {
  it('lays the group out like Teams Shifts: photos, hours, colored blocks, month in the day header', async () => {
    timeMySchedule.mockResolvedValue({ ...sched, dayNotes: [{ date: DAY, note: 'Inventory day' }],
      teams: [{ id: 'g', name: 'Store', members: [
        { ...sched.teams[0].members[0], photoUrl: 'https://x.test/me.jpg',
          scheduled: [{ id: 'mine1', email: 'me@x.com', date: DAY, start: '09:00', end: '17:00', breakMin: 30, code: 'GST', label: 'Front Desk', color: '#2563eb',
            activities: [{ start: '12:00', end: '12:30', label: 'Lunch', paid: false }] }] },
        sched.teams[0].members[1],
      ] }] });
    render(<MyShifts part="team" />);
    const me = (await screen.findByText('Me Here')).closest('[data-member]');
    expect(me.querySelector('img').getAttribute('src')).toBe('https://x.test/me.jpg');
    const bob = screen.getByText('Bob Brown').closest('[data-member]');
    expect(bob.querySelector('img')).toBeNull();
    expect(bob.textContent).toContain('BB');
    expect(me.textContent).toContain('7.5 Hrs');
    expect(bob.textContent).toContain('8 Hrs');
    const block = me.querySelector('[data-shift="mine1"]');
    expect(block.textContent).toBe('9:00a - 5:00pGSTFront Desk');       // one line, the code in color, the label under it
    expect(block.getAttribute('title')).toContain('Lunch 30m');          // the lunch is the hover title
    expect(block.textContent).not.toMatch(/PDT|PST/);                    // same zone as the team: no chip
    expect(block.getAttribute('style')).not.toMatch(/border-left|inset/);          // no colored edge stripe (Neil, Oct 14): the tint carries the color
    expect(block.style.background).toMatch(/rgba|color-mix|#/);
    const grid = screen.getByRole('table', { name: 'Store schedule' });
    expect(grid.textContent).toContain('Week · 15.5 Hrs');
    expect(grid.textContent).not.toContain('Times in');
    expect(screen.getAllByText(/^Times in /)).toHaveLength(1);           // said once, under the grid
    expect(grid.textContent).toContain('Day Notes');
    expect(grid.textContent).toContain('Inventory day');
    expect(grid.textContent).not.toContain('Open Shifts');              // only when there are open shifts
    expect(grid.querySelector('[data-team]')).toBeNull();                 // one team: no group header row (the heading names it)
    // The same one-grid engine as the manager's Schedule: me marked with "You" only: no edge bar, no row tint.
    expect(grid.querySelectorAll('[data-week-grid]')).toHaveLength(1);
    const mePerson = me.querySelector('[data-person]');
    expect(mePerson.textContent).toContain('You');
    expect(mePerson.style.boxShadow).not.toContain('inset');
    me.querySelectorAll('[data-cell]').forEach((c) => expect(c.style.gridRow).toBe(mePerson.style.gridRow));
    const header = within(grid).getAllByRole('columnheader')[0];
    expect(header.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}[A-Z][a-z]{2}/);   // "Mon 28" with the month said once
  });

  it('says the week in one line, and nothing repeats the date range', async () => {
    render(<MyShifts />);
    const line = await screen.findByRole('status', { name: 'Week summary' });
    expect(line.textContent).toMatch(/^This week: 1 shift · 8 Hrs · no time off · (on shift now until 5:00p|next shift today 9:00a - 5:00p|next shift none)$/);
    expect(document.querySelectorAll('[data-range-title]')).toHaveLength(1);   // the decorated date, once
    expect(document.querySelector('.date-block').getAttribute('title')).toMatch(new RegExp(`^${monday.slice(5, 7)}/${monday.slice(8, 10)}/${monday.slice(0, 4)} - `));
    expect(screen.queryByText('NEXT SHIFT')).toBeNull();
  });

  it('on a phone, lays the group out as a day list with a day strip', async () => {
    const mm = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
      matches: /max-width/.test(q), media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    }));
    try {
      render(<MyShifts part="team" />);
      const grid = await screen.findByRole('table', { name: 'Store schedule' });
      expect(within(grid).queryByRole('columnheader')).toBeNull();
      const strip = screen.getByRole('tablist', { name: 'Day' });
      expect(within(strip).getAllByRole('tab')).toHaveLength(7);
      expect(within(strip).getByRole('tab', { selected: true }).getAttribute('aria-label')).toContain(`${DAY.slice(5, 7)}/${DAY.slice(8, 10)}/${DAY.slice(0, 4)}`);
      expect(grid.querySelector('[data-member="bob@x.com"] [data-shift="bob1"]')).toBeTruthy();
    } finally { mm.mockRestore(); }
  });

  it('keeps a shift beside a partial day of time off, with its hours (QA 19 / 20)', async () => {
    timeMySchedule.mockResolvedValue({ ...sched,
      timeoff: [{ id: 'to1', startDate: DAY, endDate: DAY, startTime: '14:00', endTime: '16:00', allDay: false, type: 'personal', status: 'approved', note: 'Dentist' }],
      teams: [{ id: 'g', name: 'Store', members: [sched.teams[0].members[0],
        { ...sched.teams[0].members[1], timeoff: [{ id: 'to2', startDate: DAY, endDate: DAY, startTime: '14:00', endTime: '16:00', allDay: false, type: 'personal', status: 'approved' }] }] }] });
    const { unmount } = render(<MyShifts part="team" />);
    const bob = (await screen.findByText('Bob Brown')).closest('[data-member]');
    expect(bob.querySelector('[data-shift="bob1"]')).toBeTruthy();          // the shift is still there
    expect(bob.querySelector('[data-timeoff="to2"]').textContent).toBe('2:00p - 4:00p Personal');
    expect(bob.textContent).toContain('8 Hrs');                              // and still counts
    unmount();
    // My own day card (Workday > My Shifts) shows both too, and my hours are not dropped.
    render(<MyShifts />);
    await waitFor(() => expect(document.querySelector('[data-timeoff="to1"]')).toBeTruthy());
    expect(document.querySelector('[data-timeoff="to1"]').textContent).toContain('Personal');
    expect(screen.getAllByText('8 Hrs').length).toBeGreaterThan(0);
  });

  it('shows nothing, not "Off", on a day with nothing shared; usual hours as a reminder', async () => {
    timeMySchedule.mockResolvedValue({ ...sched, shift: { id: 'p', name: 'Day Shift', start: '08:30', end: '17:30', days: '1,2,3,4,5,6,7' },
      teams: [{ ...sched.teams[0], members: [{ ...sched.teams[0].members[0], shift: { id: 'p', start: '08:30', end: '17:30', days: '1,2,3,4,5,6,7' } }, sched.teams[0].members[1]] }] });
    const { unmount } = render(<MyShifts />);
    await screen.findAllByText('Usual Hours');
    expect(screen.getAllByText('Usual Hours')).toHaveLength(6);
    expect(screen.queryByText('Off')).toBeNull();
    expect(screen.getAllByText('8 Hrs').length).toBeGreaterThan(0);   // only the shared shift counts
    unmount();
    // In the group grid (Team > Shifts), usual hours are one line under the name - the cells stay empty.
    render(<MyShifts part="team" />);
    const me = (await screen.findByText('Me Here')).closest('[data-member]');
    expect(me.querySelector('[data-person]').textContent).toContain('Usual 8:30a - 5:30p');
    me.querySelectorAll('[data-cell]').forEach((c) => expect(c.textContent).toBe(''));
  });

  it('draws a teammate\'s days off as one spanning pill in the group grid', async () => {
    timeMySchedule.mockResolvedValue({ ...sched, teams: [{ ...sched.teams[0], members: [sched.teams[0].members[0],
      { ...sched.teams[0].members[1], scheduled: [], timeoff: [{ id: 'vac', startDate: monday, endDate: plus(30), type: 'vacation', status: 'pending' }] }] }] });
    render(<MyShifts part="team" />);
    const bob = (await screen.findByText('Bob Brown')).closest('[data-member]');
    const pills = bob.querySelectorAll('[data-timeoff="vac"]');
    expect(pills).toHaveLength(1);
    expect(pills[0].style.gridColumn).toBe('2 / span 7');
    expect(pills[0].style.border).toContain('dashed');                  // requested
    expect(within(pills[0]).getByLabelText('Continues next week')).toBeTruthy();
  });

  it('marks a shift kept in another zone', async () => {
    timeMySchedule.mockResolvedValue({ ...sched, scheduled: [{ ...sched.scheduled[0], timeZone: 'Asia/Kolkata' }] });
    render(<MyShifts />);
    const block = await waitFor(() => { const el = document.querySelector('[data-shift="mine1"]'); expect(el).toBeTruthy(); return el; });
    expect(block.getAttribute('title')).toContain('Times in');
    expect(block.textContent).toMatch(/IST|GMT\+5:30/);
  });

  it('shows an error with Retry when the week cannot load', async () => {
    timeMySchedule.mockRejectedValueOnce(new Error('API error 500')).mockResolvedValue(sched);
    render(<MyShifts />);
    expect(await screen.findByText('Your shifts could not be loaded right now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Front Desk')).toBeTruthy();
  });
});

describe('MyShifts parts (Workday vs Team, Oct 13 2026)', () => {
  it('shows my own days on Workday and only the group grid on Team', async () => {
    const { unmount } = render(<MyShifts />);
    await screen.findByRole('status', { name: 'Week summary' });
    expect(screen.queryByRole('table', { name: 'Store schedule' })).toBeNull();
    unmount();
    render(<MyShifts part="team" />);
    await screen.findByRole('table', { name: 'Store schedule' });
    expect(screen.queryByRole('status', { name: 'Week summary' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Request a swap/ })).toBeNull();
  });
});

describe('MyShifts embedded (Workday > My Schedule, Oct 15 2026)', () => {
  it('switches between my week and the group grid, with availability behind a toggle', async () => {
    render(<MyShifts embedded />);
    await screen.findByRole('status', { name: 'Week summary' });
    expect(screen.getByRole('button', { name: /Request a swap or offer/ })).toBeTruthy();   // my own day cards
    expect(screen.queryByRole('table', { name: 'Store schedule' })).toBeNull();
    expect(screen.queryByText('Edit Availability')).toBeNull();                              // folded until opened
    fireEvent.click(screen.getByRole('button', { name: 'My Availability' }));
    expect(await screen.findByText('Edit Availability')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Team' }));
    expect(await screen.findByRole('table', { name: 'Store schedule' })).toBeTruthy();       // the group's week
    expect(screen.queryByRole('status', { name: 'Week summary' })).toBeNull();
  });
});

describe('MyShifts requests', () => {
  it('opens the request dialog from a shift with it filled in, and sends a swap', async () => {
    render(<MyShifts />);
    fireEvent.click(await screen.findByRole('button', { name: /Request a swap or offer/ }));
    const dialog = screen.getByRole('dialog', { name: 'New Request' });
    expect(within(dialog).getByLabelText('Your shift').value).toBe('mine1');
    fireEvent.change(within(dialog).getByLabelText('Teammate'), { target: { value: 'bob@x.com' } });
    fireEvent.change(within(dialog).getByLabelText('Their shift'), { target: { value: 'bob1' } });
    fireEvent.click(screen.getByText('Send Swap Request'));
    await waitFor(() => expect(shiftRequestCreate).toHaveBeenCalledWith({ kind: 'swap', shift_id: 'mine1', target_email: 'bob@x.com', target_shift_id: 'bob1', note: '' }));
    expect(await screen.findByText('Swap request sent to Bob Brown.')).toBeTruthy();
  });

  it('hides Request while a request is pending, and when swaps and offers are off', async () => {
    shiftRequestsMine.mockResolvedValue(reqs({ mine: [{ id: 'r', kind: 'offer', status: 'pending_peer', shift: { id: 'mine1', date: DAY, start: '09:00', end: '17:00' }, target: { email: 'bob@x.com', name: 'Bob Brown' } }] }));
    const { unmount } = render(<MyShifts />);
    expect(await screen.findByText('Request Pending')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Request a swap/ })).toBeNull();
    unmount();
    shiftRequestsMine.mockResolvedValue(reqs({ settings: { openShifts: true, swaps: false, offers: false } }));
    render(<MyShifts />);
    await screen.findByText('Front Desk');
    expect(screen.queryByRole('button', { name: /Request a swap/ })).toBeNull();
  });

  it('requests an open shift from the Open Shifts row, but not on a past day', async () => {
    const open = [{ id: 'open1', date: DAY, start: '06:00', end: '14:00', label: 'Early', openSlots: 2 }];
    if (PAST) open.push({ id: 'open0', date: PAST, start: '06:00', end: '14:00', label: 'Gone', openSlots: 1 });
    shiftRequestsMine.mockResolvedValue(reqs({ openShifts: open }));
    render(<MyShifts part="team" />);
    await screen.findByText('Me Here');
    const block = await waitFor(() => { const el = document.querySelector('[data-shift="open1"]'); expect(el).toBeTruthy(); return el; });
    expect(block.closest('[data-member]').getAttribute('data-member')).toBe('open');
    expect(block.textContent).toContain('Early');
    expect(block.textContent).toContain('×2');
    expect(screen.getAllByRole('button', { name: /Request the open shift/ })).toHaveLength(1);   // none on the past day
    fireEvent.click(screen.getByRole('button', { name: `Request the open shift on ${DAY}` }));
    await waitFor(() => expect(shiftRequestCreate).toHaveBeenCalledWith({ kind: 'open', shift_id: 'open1' }));
    expect(await screen.findByText('Request sent. A manager will approve it.')).toBeTruthy();
  });

  it('names the team on an open shift, and marks another team\'s with an Other Team chip (Phase 3b)', async () => {
    shiftRequestsMine.mockResolvedValue(reqs({ openShifts: [
      { id: 'open1', date: DAY, start: '06:00', end: '14:00', label: 'Early', openSlots: 1, team: 'Store', crossTeam: false },
      { id: 'open2', date: DAY, start: '10:00', end: '18:00', label: 'Yard', openSlots: 1, team: 'Yard Crew', crossTeam: true },
    ] }));
    render(<MyShifts part="team" />);   // the group grid is Team > Shifts (Oct 15)
    await screen.findByText('Me Here');
    const ours = await waitFor(() => { const el = document.querySelector('[data-shift="open1"]'); expect(el).toBeTruthy(); return el; });
    expect(ours.textContent).toContain('Store');
    expect(ours.querySelector('[data-cross-team]')).toBeNull();
    const theirs = document.querySelector('[data-shift="open2"]');
    expect(theirs.textContent).toContain('Yard Crew');
    expect(theirs.querySelector('[data-cross-team]').textContent).toBe('Other Team');
    expect(screen.getAllByRole('button', { name: `Request the open shift on ${DAY}` })).toHaveLength(2);
  });
});

describe('MyShifts availability', () => {
  it('sets my availability for the week', async () => {
    render(<MyShifts />);
    fireEvent.click(await screen.findByText('Edit Availability'));
    fireEvent.change(screen.getByLabelText('Monday availability'), { target: { value: 'unavailable' } });
    fireEvent.change(screen.getByLabelText('Tuesday availability'), { target: { value: 'available' } });
    fireEvent.change(screen.getByLabelText('Tuesday to'), { target: { value: '12:00' } });
    fireEvent.click(screen.getByText('Save Availability'));
    await waitFor(() => expect(availabilitySave).toHaveBeenCalled());
    const days = availabilitySave.mock.calls[0][0].days;
    expect(days[0]).toMatchObject({ weekday: 0, kind: 'unavailable' });
    expect(days[1]).toMatchObject({ weekday: 1, kind: 'available', start: '09:00', end: '12:00' });
    expect(await screen.findByText('9:00 AM - 12:00 PM')).toBeTruthy();
  });

  it('never lets Save write over availability it could not load (QA 22)', async () => {
    availabilityMine.mockRejectedValueOnce(new Error('API error 500')).mockResolvedValue({ days: [{ weekday: 0, kind: 'unavailable' }] });
    render(<MyShifts />);
    expect(await screen.findByText('Your availability could not be loaded right now.')).toBeTruthy();
    expect(screen.queryByText('Edit Availability')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Unavailable')).toBeTruthy();
    expect(screen.getByText('Edit Availability')).toBeTruthy();
    expect(availabilitySave).not.toHaveBeenCalled();
  });
});

// Actuals (Shifts Phase 1, Oct 14): my own clock results on my blocks, and
// the week line counts my late days.
describe('actuals on my shifts', () => {
  it('draws the bar on my block from my own actuals, and counts late days on the week line', async () => {
    timeSchedActuals.mockResolvedValue({ cells: { [`me@x.com|${DAY}`]: { shiftId: 'mine1', status: 'late', firstIn: `${DAY}T16:12:00`, lastOut: '', workedMin: 0, lateMin: 12, earlyMin: 0, excuse: '' } },
      people: { 'me@x.com': { scheduledMin: 480, workedMin: 0, late: 1, noShow: 0, leftEarly: 0, onTime: 0 } }, totals: {} });
    render(<MyShifts />);
    await screen.findByRole('status', { name: 'Week summary' });
    await waitFor(() => expect(timeSchedActuals).toHaveBeenCalledWith(monday, expect.any(String)));
    const mine = await waitFor(() => { const b = document.querySelector('[data-shift="mine1"] [data-actual]'); expect(b).toBeTruthy(); return b; });
    expect(mine.getAttribute('data-actual')).toBe('late');
    expect(mine.closest('[data-shift]').getAttribute('title')).toContain('(12 min late)');
    expect(screen.getByRole('status', { name: 'Week summary' }).textContent).toMatch(/ · 1 late$/);
    // On My Shifts a tap on the bar always opens the readable sheet (a phone has no hover) - Oct 15.
    fireEvent.click(mine);
    const sheet = document.querySelector('[data-actual-sheet]');
    expect(sheet.getAttribute('data-actual-sheet')).toBe('late');
    expect(sheet.textContent).toContain('(12 min late)');
  });
  it('shows no bar when the actuals cannot load', async () => {
    timeSchedActuals.mockRejectedValue(new Error('API error 500'));
    render(<MyShifts />);
    const line = await screen.findByRole('status', { name: 'Week summary' });
    await waitFor(() => expect(timeSchedActuals).toHaveBeenCalled());
    expect(document.querySelector('[data-actual]')).toBeNull();
    expect(line.textContent).not.toContain('late');
  });
});

// Shifts Phase 3a (Oct 14): the schedule comes to people. A shared schedule
// I have not confirmed sits at the top until I confirm it (then the next
// one); the Calendar row holds my Outlook switch (no switch when the
// company's is off, or with no Microsoft 365 mailbox on file) and my iCal
// link with Copy and New Link. GET /timeclock/my-schedule/confirmations
// answers { pending: [...] }; GET /timeclock/my-prefs answers
// { shiftCalendar, companyOutlookCalendar, hasMailbox, showAs }.
describe('MyShifts confirmations and calendar', () => {
  const banner = () => screen.queryByRole('note', { name: 'Confirm your schedule' });
  const two = () => [
    { publishId: 'pub2', at: '2026-10-14T18:05:00Z', by: 'amy@x.com', start: monday, end: plus(6), changes: 3 },
    { publishId: 'pub1', at: '2026-10-07T18:05:00Z', by: 'bob@x.com', start: monday, end: plus(6), changes: 1 },
  ];
  it('asks me to confirm the newest shared schedule, then the next one; a failed confirm asks again', async () => {
    timeMyConfirmations.mockResolvedValue({ pending: two() });
    timeSchedConfirm.mockRejectedValueOnce(new Error('API error 500')).mockResolvedValue({ ok: true });
    render(<MyShifts />);
    const b = await waitFor(() => { const el = banner(); expect(el).toBeTruthy(); return el; });
    expect(b.textContent).toContain('Your schedule was shared on 10/14/2026 by amy@x.com (3 changes) - have a look and confirm.');
    expect(b.textContent).toContain('1 more waiting.');
    fireEvent.click(within(b).getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(timeSchedConfirm).toHaveBeenCalledWith('pub2'));
    // The call failed: the same share is back with a quiet retry line, never an error banner.
    await waitFor(() => expect(banner().textContent).toContain('Could not confirm - try again.'));
    expect(banner().getAttribute('data-confirm-banner')).toBe('pub2');
    fireEvent.click(within(banner()).getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(banner().getAttribute('data-confirm-banner')).toBe('pub1'));   // the next one steps up
    expect(banner().textContent).toContain('by Bob Brown (1 change)');
    expect(banner().textContent).not.toContain('more waiting');
    fireEvent.click(within(banner()).getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(timeSchedConfirm).toHaveBeenLastCalledWith('pub1'));
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('shows no banner with nothing to confirm, or when the call fails', async () => {
    timeMyConfirmations.mockRejectedValue(new Error('API error 500'));
    render(<MyShifts />);
    await screen.findByRole('status', { name: 'Week summary' });
    await waitFor(() => expect(timeMyConfirmations).toHaveBeenCalled());
    expect(banner()).toBeNull();
  });

  // A bell's click-through (sub "mine:confirm:<id>", handed down by
  // Shifts.jsx) and the email's /shifts/mine?confirm=<id> both put THAT
  // share's banner in front, even when a newer one is waiting.
  it('puts the share a bell points at in front, and the one from an email link', async () => {
    timeMyConfirmations.mockResolvedValue({ pending: two() });
    const { unmount } = render(<MyShifts focusConfirm="pub1" />);
    const b = await waitFor(() => { const el = banner(); expect(el).toBeTruthy(); return el; });
    expect(b.getAttribute('data-confirm-banner')).toBe('pub1');
    expect(b.textContent).toContain('1 more waiting.');
    unmount();
    window.history.replaceState({}, '', '/shifts/mine?confirm=pub1&x=1');
    render(<MyShifts />);
    const b2 = await waitFor(() => { const el = banner(); expect(el).toBeTruthy(); return el; });
    expect(b2.getAttribute('data-confirm-banner')).toBe('pub1');
    expect(window.location.search).toBe('?x=1');                             // read once, then stripped
  });

  it('says so quietly when the share a link points at is no longer waiting on me', async () => {
    timeMyConfirmations.mockResolvedValue({ pending: [two()[0]] });
    render(<MyShifts focusConfirm="pub-gone" />);
    expect(await screen.findByText('No confirmation is waiting for that schedule.')).toBeTruthy();
    expect(banner().getAttribute('data-confirm-banner')).toBe('pub2');   // the newest still shows
  });

  it('turns my Outlook calendar off and on from the Calendar row, and puts it back when the save fails', async () => {
    render(<MyShifts />);
    const sw = await screen.findByRole('switch', { name: 'In your Outlook calendar' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() => expect(timeMyPrefsSet).toHaveBeenCalledWith({ shiftCalendar: false }));
    expect(screen.getByRole('switch', { name: 'In your Outlook calendar' }).getAttribute('aria-checked')).toBe('false');
    timeMyPrefsSet.mockRejectedValueOnce(new Error('API error 500'));
    fireEvent.click(screen.getByRole('switch', { name: 'In your Outlook calendar' }));
    await waitFor(() => expect(timeMyPrefsSet).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'In your Outlook calendar' }).getAttribute('aria-checked')).toBe('false'));
    expect(screen.getByText('Could not save that.')).toBeTruthy();
  });

  it('shows no Outlook line when the company switch is off (the default), or says I have no mailbox', async () => {
    timeMyPrefsGet.mockResolvedValue({ shiftCalendar: true, companyOutlookCalendar: false, hasMailbox: true, showAs: 'free' });
    const { unmount } = render(<MyShifts />);
    expect(await screen.findByText('Subscribe in another calendar')).toBeTruthy();   // the iCal link still works
    expect(screen.queryByRole('switch', { name: 'In your Outlook calendar' })).toBeNull();
    expect(screen.queryByText(/Outlook calendar/)).toBeNull();
    unmount();
    timeMyPrefsGet.mockResolvedValue({ shiftCalendar: true, companyOutlookCalendar: true, hasMailbox: false, showAs: 'free' });
    render(<MyShifts />);
    expect(await screen.findByText(/No Microsoft 365 mailbox on file/i)).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'In your Outlook calendar' })).toBeNull();
    expect(screen.getByText('Subscribe in another calendar')).toBeTruthy();
  });

  it('reveals my iCal link on request, copies it, and makes a new one only after a confirmation', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      render(<MyShifts />);
      await screen.findByRole('switch', { name: 'In your Outlook calendar' });
      expect(timeMyIcalLink).not.toHaveBeenCalled();                       // lazy: only when asked
      fireEvent.click(screen.getByText('Subscribe in another calendar'));
      const url = await screen.findByLabelText('Calendar subscription link');
      expect(url.value).toBe('https://api.nexus.test/timeclock/ical/abc123.ics');
      fireEvent.click(screen.getByRole('button', { name: /Copy/ }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://api.nexus.test/timeclock/ical/abc123.ics'));
      expect(await screen.findByText('Copied')).toBeTruthy();
      confirmAsk.mockResolvedValueOnce(false);
      fireEvent.click(screen.getByRole('button', { name: /New Link/ }));
      await waitFor(() => expect(confirmAsk).toHaveBeenCalled());
      expect(timeMyIcalRotate).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /New Link/ }));
      await waitFor(() => expect(timeMyIcalRotate).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByLabelText('Calendar subscription link').value).toBe('https://api.nexus.test/timeclock/ical/new456.ics'));
      expect(screen.getByText('New link made. The old one no longer works.')).toBeTruthy();
    } finally { delete navigator.clipboard; }
  });

  it('falls back to selecting the link when there is no clipboard, and says so quietly when the link cannot load', async () => {
    delete navigator.clipboard;
    document.execCommand = vi.fn(() => true);
    render(<MyShifts />);
    await screen.findByRole('switch', { name: 'In your Outlook calendar' });
    fireEvent.click(screen.getByText('Subscribe in another calendar'));
    const url = await screen.findByLabelText('Calendar subscription link');
    url.select = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }));
    await waitFor(() => expect(document.execCommand).toHaveBeenCalledWith('copy'));
    expect(url.select).toHaveBeenCalled();
    delete document.execCommand;
  });

  it('shows no Calendar row when my preferences cannot load', async () => {
    timeMyPrefsGet.mockRejectedValue(new Error('API error 500'));
    render(<MyShifts />);
    await screen.findByRole('status', { name: 'Week summary' });
    await waitFor(() => expect(timeMyPrefsGet).toHaveBeenCalled());
    expect(document.querySelector('[data-calendar-row]')).toBeNull();
  });
});

describe('MyShifts live status (Miranda, Oct 21 2026)', () => {
  // Who in the group is working, on a break or clocked out, from today's
  // punches: a chip under the name, a dot that follows the clock, and a
  // header line with On Break first. This week only; a failed call is the
  // schedule as before.
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const liveMap = (people) => ({ people, asOf: new Date().toISOString() });

  it('shows Working, On Break with minutes and Clocked Out, and says who is on a break', async () => {
    timeMySchedule.mockResolvedValue({ ...sched, teams: [{ id: 'g', name: 'Store', members: [
      ...sched.teams[0].members,
      { email: 'cara@x.com', name: 'Cara Diaz', isMe: false, scheduled: [], timeoff: [] },
    ] }] });
    timeMyScheduleLive.mockResolvedValue(liveMap({
      'me@x.com': { state: 'working', label: 'Working', since: ago(90) },
      'bob@x.com': { state: 'break', label: 'On Break', since: ago(12) },
      'cara@x.com': { state: 'out', label: 'Clocked Out', since: ago(30) },
    }));
    render(<MyShifts part="team" />);
    const bob = (await screen.findByText(/^On Break · 1[23]m$/)).closest('[data-member]');
    expect(bob.getAttribute('data-member')).toBe('bob@x.com');
    expect(bob.querySelector('[title^="On break since "]').getAttribute('title')).toMatch(/^On break since \d{1,2}:\d{2} (AM|PM)$/);
    expect(bob.querySelector('[data-on-dot]').getAttribute('data-on-dot')).toBe('break');
    const me = screen.getByText('Working').closest('[data-member]');
    expect(me.getAttribute('data-member')).toBe('me@x.com');
    expect(me.querySelector('[data-on-dot]').getAttribute('data-on-dot')).toBe('working');
    const cara = screen.getByText('Clocked Out').closest('[data-member]');
    expect(cara.getAttribute('data-member')).toBe('cara@x.com');
    expect(cara.querySelector('[data-on-dot]')).toBeNull();
    const head = document.querySelector('[data-live-summary]');
    expect(head.textContent).toBe('On Break: Bob · Working: you');
    expect(head.querySelector('b').textContent).toBe('On Break: Bob');
    expect(screen.queryByText(/^On shift now/)).toBeNull();
  });

  it('says nobody is clocked in when the live map has no one working', async () => {
    timeMyScheduleLive.mockResolvedValue(liveMap({}));
    render(<MyShifts part="team" />);
    expect(await screen.findByText('Nobody clocked in right now')).toBeTruthy();
  });

  it('keeps the schedule and the On shift now line when the live call fails', async () => {
    render(<MyShifts part="team" />);
    const grid = await screen.findByRole('table', { name: 'Store schedule' });
    await waitFor(() => expect(timeMyScheduleLive).toHaveBeenCalled());
    expect(grid.querySelector('[data-shift="bob1"]')).toBeTruthy();
    expect(screen.getByText(/^(On shift now: |Nobody on shift right now)/)).toBeTruthy();
    expect(document.querySelector('[data-live-summary]')).toBeNull();
    expect(screen.queryByText('Working')).toBeNull();
  });

  it('shows no live chips on another week', async () => {
    timeMyScheduleLive.mockResolvedValue(liveMap({ 'bob@x.com': { state: 'break', label: 'On Break', since: ago(5) } }));
    render(<MyShifts part="team" />);
    await screen.findByText(/^On Break · /);
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await screen.findByRole('table', { name: 'Store schedule' });
    expect(screen.queryByText(/^On Break/)).toBeNull();
    expect(document.querySelector('[data-live-summary]')).toBeNull();
  });

  it('on a phone, shows the chip in the day list', async () => {
    const mm = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
      matches: /max-width/.test(q), media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    }));
    timeMyScheduleLive.mockResolvedValue(liveMap({ 'bob@x.com': { state: 'break', label: 'On Break', since: ago(3) } }));
    try {
      render(<MyShifts part="team" />);
      const chip = await screen.findByText(/^On Break · [34]m$/);
      expect(chip.closest('[data-member]').getAttribute('data-member')).toBe('bob@x.com');
      expect(document.querySelector('[data-member="bob@x.com"] [data-on-dot]').getAttribute('data-on-dot')).toBe('break');
    } finally { mm.mockRestore(); }
  });
});
