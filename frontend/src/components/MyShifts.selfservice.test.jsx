import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// My Workday > Shifts self-service (Sep 29): Swap / Offer on my own upcoming
// placed shifts, the teammate's Accept / Decline, and requesting open shifts.

const timeMySchedule = vi.fn();
const shiftRequestsMine = vi.fn();
const shiftRequestCreate = vi.fn();
const shiftRequestRespond = vi.fn();
vi.mock('../api', () => ({
  api: {
    timeMySchedule: (...a) => timeMySchedule(...a),
    shiftRequestsMine: (...a) => shiftRequestsMine(...a),
    shiftRequestCreate: (...a) => shiftRequestCreate(...a),
    shiftRequestRespond: (...a) => shiftRequestRespond(...a),
    shiftRequestCancel: vi.fn(),
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
  settings: { openShifts: true, swaps: true, offers: true }, ...over,
});

beforeEach(() => {
  timeMySchedule.mockReset().mockResolvedValue(sched);
  shiftRequestsMine.mockReset().mockResolvedValue(reqs());
  shiftRequestCreate.mockReset().mockResolvedValue({});
  shiftRequestRespond.mockReset().mockResolvedValue({});
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

  it('requests an open shift', async () => {
    shiftRequestsMine.mockResolvedValue(reqs({ openShifts: [{ id: 'open1', date: DAY, start: '06:00', end: '14:00', label: 'Early', openSlots: 2 }] }));
    render(<MyShifts />);
    expect(await screen.findByText('Early · 2 spots open')).toBeTruthy();
    fireEvent.click(screen.getByText('Request'));
    await waitFor(() => expect(shiftRequestCreate).toHaveBeenCalledWith({ kind: 'open', shift_id: 'open1' }));
  });
});
