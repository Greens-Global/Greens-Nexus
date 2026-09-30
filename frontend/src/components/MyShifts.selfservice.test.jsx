import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Shifts > My Shifts self-service (Sep 29; was My Workday > Shifts): Swap / Offer on my own upcoming
// placed shifts, the teammate's Accept / Decline, and requesting open shifts.

const timeMySchedule = vi.fn();
const shiftRequestsMine = vi.fn();
const shiftRequestCreate = vi.fn();
const shiftRequestRespond = vi.fn();
const availabilityMine = vi.fn();
const availabilitySave = vi.fn();
vi.mock('./ShiftSchedule', () => ({ default: () => <div>Schedule grid</div> }));
vi.mock('../api', () => ({
  api: {
    timeMySchedule: (...a) => timeMySchedule(...a),
    shiftRequestsMine: (...a) => shiftRequestsMine(...a),
    shiftRequestCreate: (...a) => shiftRequestCreate(...a),
    shiftRequestRespond: (...a) => shiftRequestRespond(...a),
    shiftRequestCancel: vi.fn(),
    availabilityMine: (...a) => availabilityMine(...a),
    availabilitySave: (...a) => availabilitySave(...a),
  },
}));

const MyShifts = (await import('./MyShifts')).default;

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Today - always in the week on screen, and never in the past.
const DAY = iso(new Date());

const sched = {
  shift: null, timeoff: [], holidays: [],
  scheduled: [{ id: 'mine1', email: 'me@x.com', date: DAY, start: '09:00', end: '17:00', label: 'Front desk', published: true }],
  teams: [{ id: 'g', name: 'Store', members: [
    { email: 'me@x.com', name: 'Me Here', isMe: true, scheduled: [], timeoff: [] },
    { email: 'bob@x.com', name: 'Bob Brown', isMe: false, timeoff: [],
      scheduled: [{ id: 'bob1', email: 'bob@x.com', date: DAY, start: '12:00', end: '20:00', label: '' }] },
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
  shiftRequestRespond.mockReset().mockResolvedValue({});
  availabilityMine.mockReset().mockResolvedValue({ days: [] });
  availabilitySave.mockReset().mockImplementation(async (b) => ({ days: b.days.filter(d => d.kind !== 'any') }));
});

describe('MyShifts availability and group scheduling', () => {
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

  it('never offers editing - managing lives in the Shifts module now', async () => {
    // Even for someone who schedules a group (Sep 29: Manage is the module's,
    // managers and above only; My Shifts is read-only for everyone).
    timeMySchedule.mockResolvedValue({ ...sched, schedulerOf: [{ id: 'g', name: 'Store' }] });
    render(<MyShifts />);
    await screen.findByText('Front desk');
    expect(screen.queryByText('Manage Schedule')).toBeNull();
    expect(screen.queryByText('Schedule grid')).toBeNull();
  });

  it('pins me first in Team Shifts and marks my row', async () => {
    render(<MyShifts />);
    const mine = await screen.findByText('Me Here');
    const row = mine.closest('[data-member]');
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(row.textContent).toContain('YOU');
    const rows = [...document.querySelectorAll('[data-member]')].filter(r => r.getAttribute('data-member') !== 'open');
    expect(rows[0]).toBe(row);                                   // first, above Bob
    expect(rows[1].textContent).toContain('Bob Brown');
    expect(rows[1].getAttribute('aria-current')).toBeNull();
  });

  it('shows a company holiday, and never crashes on the older {date: {name}} shape', async () => {
    timeMySchedule.mockResolvedValue({ ...sched, holidays: [{ date: DAY, name: 'Founders Day', type: 'mandatory' }] });
    const { unmount } = render(<MyShifts />);
    expect((await screen.findAllByText(/Founders Day/)).length).toBeGreaterThan(0);
    unmount();
    timeMySchedule.mockResolvedValue({ ...sched, holidays: { [DAY]: { name: 'Founders Day', type: 'mandatory' } } });
    render(<MyShifts />);
    expect((await screen.findAllByText(/Founders Day/)).length).toBeGreaterThan(0);
  });

  it('lays the team out like Teams Shifts: photos, hours, colored blocks', async () => {
    timeMySchedule.mockResolvedValue({ ...sched, dayNotes: [{ date: DAY, note: 'Inventory day' }],
      teams: [{ id: 'g', name: 'Store', members: [
        { ...sched.teams[0].members[0], photoUrl: 'https://x.test/me.jpg',
          scheduled: [{ id: 'mine1', email: 'me@x.com', date: DAY, start: '09:00', end: '17:00', breakMin: 30, code: 'GST', label: 'Front desk', color: '#2563eb' }] },
        sched.teams[0].members[1],
      ] }] });
    render(<MyShifts />);
    const me = (await screen.findByText('Me Here')).closest('[data-member]');
    expect(me.querySelector('img').getAttribute('src')).toBe('https://x.test/me.jpg');     // a photo
    const bob = screen.getByText('Bob Brown').closest('[data-member]');
    expect(bob.querySelector('img')).toBeNull();                                           // initials when there is none
    expect(bob.textContent).toContain('BB');
    expect(me.textContent).toContain('7.5 Hrs');                                           // my paid hours this week
    expect(bob.textContent).toContain('8 Hrs');
    const block = me.querySelector('[data-shift="mine1"]');
    expect(block.textContent).toContain('GST');
    expect(block.textContent).toContain('9 AM - 5 PM');
    expect(block.style.borderLeft).toContain('4px solid');
    const grid = screen.getByRole('table', { name: 'Store schedule' });
    expect(grid.textContent).toContain('Week: 15.5 Hrs');
    expect(grid.textContent).toContain('Day Notes');
    expect(grid.textContent).toContain('Inventory day');
    expect(grid.textContent).toContain('Open Shifts');
  });

  it('sums my week at a glance in paid hours', async () => {
    timeMySchedule.mockResolvedValue({ ...sched,
      scheduled: [{ ...sched.scheduled[0], breakMin: 30 }] });  // 9-5 with a 30 min break
    render(<MyShifts />);
    expect(await screen.findByText('7.5 hrs')).toBeTruthy();
    expect(screen.getByText(/1 shift · paid time/)).toBeTruthy();
  });
});

describe('MyShifts shows only what is published (Sep 29 audit)', () => {
  const preset = { id: 'p', name: 'Day Shift', code: 'DAY', start: '08:30', end: '17:30', days: '1,2,3,4,5,6,7', breakMin: 0, color: '#2563eb' };

  it('shows the default preset as usual hours, never as a shift', async () => {
    timeMySchedule.mockResolvedValue({ ...sched, shift: preset });
    render(<MyShifts />);
    await screen.findByText('Front desk');
    // Six days have nothing published: usual hours, not shifts.
    expect(screen.getAllByText('Usual hours')).toHaveLength(6);
    expect(screen.getAllByText('8:30 AM - 5:30 PM')).toHaveLength(6);
    // The week is the one published shift - the usual hours add nothing.
    expect(screen.getByText('8 hrs')).toBeTruthy();
    expect(screen.getByText(/1 shift · paid time/)).toBeTruthy();
    expect(screen.getByText(/Usual hours are your regular schedule/)).toBeTruthy();
  });

  it('says nothing is published when there are only usual hours', async () => {
    timeMySchedule.mockResolvedValue({ ...sched, shift: preset, scheduled: [] });
    render(<MyShifts />);
    expect(await screen.findByText('None this week')).toBeTruthy();
    expect(screen.getByText('0 hrs')).toBeTruthy();
    expect(screen.getAllByText('Usual hours')).toHaveLength(7);
    expect(screen.queryByText('Swap')).toBeNull();   // nothing to swap: usual hours are not a shift
  });

  it('shows a teammate the reason and details the settings share', async () => {
    const team = (bob) => ({ ...sched, teams: [{ id: 'g', name: 'Store', members: [sched.teams[0].members[0], { ...sched.teams[0].members[1], ...bob }] }] });
    timeMySchedule.mockResolvedValue(team({ scheduled: [], timeoff: [{ startDate: DAY, endDate: DAY, type: 'vacation', note: 'Back Monday' }] }));
    const { unmount } = render(<MyShifts />);
    const reason = await screen.findByText('Vacation');
    expect(reason.closest('[title]').getAttribute('title')).toBe('Back Monday');
    unmount();
    // Withheld by the settings (or confidential): plain "Time off".
    timeMySchedule.mockResolvedValue(team({ scheduled: [], timeoff: [{ startDate: DAY, endDate: DAY }] }));
    render(<MyShifts />);
    const row = (await screen.findByText('Bob Brown')).closest('[data-member]');
    expect(row.textContent).toContain('Time off');
    expect(row.textContent).not.toContain('Vacation');
  });

  it('shows the note on a teammate shift when it is shared', async () => {
    timeMySchedule.mockResolvedValue({ ...sched, teams: [{ id: 'g', name: 'Store', members: [sched.teams[0].members[0],
      { ...sched.teams[0].members[1], scheduled: [{ ...sched.teams[0].members[1].scheduled[0], note: 'Bring keys', breakMin: 30 }] }] }] });
    render(<MyShifts />);
    const row = (await screen.findByText('Bob Brown')).closest('[data-member]');
    expect(row.textContent).toContain('Bring keys +1');
  });
});

describe('MyShifts self-service', () => {
  it('offers my upcoming shift to a teammate', async () => {
    render(<MyShifts />);
    fireEvent.click(await screen.findByText('Offer'));
    const dialog = screen.getByRole('dialog', { name: 'Offer Shift' });
    fireEvent.change(dialog.querySelector('select'), { target: { value: 'bob@x.com' } });
    fireEvent.click(screen.getByText('Send Offer'));
    await waitFor(() => expect(shiftRequestCreate).toHaveBeenCalledWith(
      { kind: 'offer', shift_id: 'mine1', target_email: 'bob@x.com', target_shift_id: '', note: '' }));
    expect(await screen.findByText('Shift offered to Bob Brown.')).toBeTruthy();
  });

  it('swaps for one of a teammate’s shifts', async () => {
    render(<MyShifts />);
    fireEvent.click(await screen.findByText('Swap'));
    const dialog = screen.getByRole('dialog', { name: 'Swap Shift' });
    fireEvent.change(dialog.querySelector('select'), { target: { value: 'bob@x.com' } });
    fireEvent.change(dialog.querySelectorAll('select')[1], { target: { value: 'bob1' } });
    fireEvent.click(screen.getByText('Send Swap Request'));
    await waitFor(() => expect(shiftRequestCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'swap', shift_id: 'mine1', target_email: 'bob@x.com', target_shift_id: 'bob1' })));
  });

  it('hides Swap and Offer while a request is pending, and when turned off', async () => {
    shiftRequestsMine.mockResolvedValue(reqs({ mine: [{ id: 'r', kind: 'offer', status: 'pending_peer',
      shift: { id: 'mine1', date: DAY, start: '09:00', end: '17:00' }, target: { email: 'bob@x.com', name: 'Bob Brown' } }] }));
    const { unmount } = render(<MyShifts />);
    expect(await screen.findByText('Request pending')).toBeTruthy();
    expect(screen.getByText(/^You offered .* to Bob Brown$/)).toBeTruthy();
    unmount();
    shiftRequestsMine.mockResolvedValue(reqs({ settings: { openShifts: true, swaps: false, offers: false } }));
    render(<MyShifts />);
    await screen.findByText('Front desk');
    expect(screen.queryByText('Swap')).toBeNull();
    expect(screen.queryByText('Offer')).toBeNull();
  });

  it('accepts a request a teammate sent me', async () => {
    shiftRequestsMine.mockResolvedValue(reqs({ incoming: [{ id: 'in1', kind: 'offer', status: 'pending_peer',
      summary: 'Bob Brown offered 10/05/2026 12:00 PM - 8:00 PM to Me Here', shift: { id: 'bob1', date: DAY, start: '12:00', end: '20:00' } }] }));
    render(<MyShifts />);
    fireEvent.click(await screen.findByText('Accept'));
    await waitFor(() => expect(shiftRequestRespond).toHaveBeenCalledWith('in1', { accept: true }));
    expect(await screen.findByText('Accepted. A manager will approve it next.')).toBeTruthy();
  });

  it('requests an open shift from the Open Shifts row', async () => {
    shiftRequestsMine.mockResolvedValue(reqs({ openShifts: [{ id: 'open1', date: DAY, start: '06:00', end: '14:00', label: 'Early', openSlots: 2 }] }));
    render(<MyShifts />);
    await screen.findByText('Me Here');
    const open = await waitFor(() => { const el = document.querySelector('[data-shift="open1"]'); expect(el).toBeTruthy(); return el; });
    expect(open.closest('[data-member]').getAttribute('data-member')).toBe('open');
    expect(open.textContent).toContain('Early');
    expect(open.textContent).toContain('2 spots');
    fireEvent.click(screen.getByText('Request'));
    await waitFor(() => expect(shiftRequestCreate).toHaveBeenCalledWith({ kind: 'open', shift_id: 'open1' }));
    expect(await screen.findByText('Request sent. A manager will approve it.')).toBeTruthy();
  });

  it('still lists open shifts for someone with no team', async () => {
    timeMySchedule.mockResolvedValue({ ...sched, teams: [] });
    shiftRequestsMine.mockResolvedValue(reqs({ teammates: [], openShifts: [{ id: 'open1', date: DAY, start: '06:00', end: '14:00', label: 'Early', openSlots: 2 }] }));
    render(<MyShifts />);
    expect(await screen.findByText('Early · 2 spots open')).toBeTruthy();
  });
});
