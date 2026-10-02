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
vi.mock('../api', () => ({
  api: {
    timeMySchedule: (...a) => timeMySchedule(...a),
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
  shiftRequestsMine.mockReset().mockResolvedValue(reqs());
  shiftRequestCreate.mockReset().mockResolvedValue({});
  availabilityMine.mockReset().mockResolvedValue({ days: [] });
  availabilitySave.mockReset().mockImplementation(async (b) => ({ days: b.days.filter((d) => d.kind !== 'any') }));
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
    render(<MyShifts />);
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
    expect(block.style.borderLeft).toContain('3px solid');
    const grid = screen.getByRole('table', { name: 'Store schedule' });
    expect(grid.textContent).toContain('Week · 15.5 Hrs');
    expect(grid.textContent).not.toContain('Times in');
    expect(screen.getAllByText(/^Times in /)).toHaveLength(1);           // said once, under the grid
    expect(grid.textContent).toContain('Day Notes');
    expect(grid.textContent).toContain('Inventory day');
    expect(grid.textContent).toContain('Open Shifts');
    expect(grid.textContent).toContain('Store15.5 Hrs · 2 people');
    const header = within(grid).getAllByRole('columnheader')[0];
    expect(header.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}[A-Z][a-z]{2}/);   // "Mon 28" with the month said once
  });

  it('says the week in one line, and nothing repeats the date range', async () => {
    render(<MyShifts />);
    const line = await screen.findByRole('status', { name: 'Week summary' });
    expect(line.textContent).toMatch(/^This week: 1 shift · 8 Hrs · no time off · (on shift now until 5:00p|next shift today 9:00a - 5:00p|next shift none)$/);
    expect(screen.getAllByText(new RegExp(`${monday.slice(5, 7)}/${monday.slice(8, 10)}/${monday.slice(0, 4)} - `))).toHaveLength(1);
    expect(screen.queryByText('NEXT SHIFT')).toBeNull();
  });

  it('on a phone, lays the group out as a day list with a day strip', async () => {
    const mm = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
      matches: /max-width/.test(q), media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    }));
    try {
      render(<MyShifts />);
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
    render(<MyShifts />);
    const bob = (await screen.findByText('Bob Brown')).closest('[data-member]');
    expect(bob.querySelector('[data-shift="bob1"]')).toBeTruthy();          // the shift is still there
    expect(bob.querySelector('[data-timeoff="to2"]').textContent).toBe('2:00p - 4:00p Personal');
    expect(bob.textContent).toContain('8 Hrs');                              // and still counts
    // My own day card shows both too, and my hours are not dropped.
    expect(document.querySelector('[data-timeoff="to1"]').textContent).toContain('Personal');
    expect(screen.getAllByText('8 Hrs').length).toBeGreaterThan(0);
  });

  it('shows nothing, not "Off", on a day with nothing shared; usual hours as a reminder', async () => {
    timeMySchedule.mockResolvedValue({ ...sched, shift: { id: 'p', name: 'Day Shift', start: '08:30', end: '17:30', days: '1,2,3,4,5,6,7' } });
    render(<MyShifts />);
    await screen.findAllByText('Usual Hours');
    expect(screen.getAllByText('Usual Hours')).toHaveLength(6);
    expect(screen.queryByText('Off')).toBeNull();
    expect(screen.getAllByText('8 Hrs').length).toBeGreaterThan(0);   // only the shared shift counts
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
    await screen.findByText('Me Here');
    expect(screen.queryByRole('button', { name: /Request a swap/ })).toBeNull();
  });

  it('requests an open shift from the Open Shifts row, but not on a past day', async () => {
    const open = [{ id: 'open1', date: DAY, start: '06:00', end: '14:00', label: 'Early', openSlots: 2 }];
    if (PAST) open.push({ id: 'open0', date: PAST, start: '06:00', end: '14:00', label: 'Gone', openSlots: 1 });
    shiftRequestsMine.mockResolvedValue(reqs({ openShifts: open }));
    render(<MyShifts />);
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
