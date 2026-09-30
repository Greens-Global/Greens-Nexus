import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Shifts > Requests (Sep 30): the one place to start a swap, an offer or a
// time-off request - whether or not a shift is on screen - and, for a
// manager, to decide the team's.

const timeMySchedule = vi.fn();
const shiftRequestsMine = vi.fn();
const shiftRequestCreate = vi.fn();
const shiftRequestsInbox = vi.fn();
vi.mock('../api', () => ({
  api: {
    timeMySchedule: (...a) => timeMySchedule(...a),
    shiftRequestsMine: (...a) => shiftRequestsMine(...a),
    shiftRequestCreate: (...a) => shiftRequestCreate(...a),
    shiftRequestsInbox: (...a) => shiftRequestsInbox(...a),
    shiftRequestCancel: vi.fn(), shiftRequestRespond: vi.fn(), shiftRequestDecide: vi.fn(), shiftRequestSettingsSave: vi.fn(),
    timeOffList: vi.fn().mockResolvedValue([]), timeOffDecide: vi.fn(),
    timeOffTypes: vi.fn().mockResolvedValue({ builtIn: [], custom: [] }), timeOffTypesSave: vi.fn(),
  },
}));

const Page = (await import('./ShiftRequestsPage')).default;

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const mine = { id: 'mine1', email: 'me@x.com', date: day(3), start: '09:00', end: '17:00', label: 'Front desk' };
const theirs = { id: 'bob1', email: 'bob@x.com', date: day(4), start: '12:00', end: '20:00', label: '' };
const reqs = (over = {}) => ({
  mine: [], incoming: [], openShifts: [], teammates: [{ email: 'bob@x.com', name: 'Bob Brown' }],
  swapShifts: { 'bob@x.com': [theirs] },
  settings: { openShifts: true, swaps: true, offers: true, timeOffRequests: true }, ...over,
});
const toastOk = vi.fn();

beforeEach(() => {
  timeMySchedule.mockReset().mockResolvedValue({ scheduled: [mine], teams: [] });
  shiftRequestsMine.mockReset().mockResolvedValue(reqs());
  shiftRequestCreate.mockReset().mockResolvedValue({});
  shiftRequestsInbox.mockReset().mockResolvedValue({ pending: [], recent: [], settings: reqs().settings, canConfigure: false });
  toastOk.mockReset();
});

async function openDialog() {
  render(<Page toastOk={toastOk} toastErr={vi.fn()} />);
  const btn = await screen.findByRole('button', { name: /New Request/ });
  await waitFor(() => expect(btn.disabled).toBe(false));
  fireEvent.click(btn);
  return screen.getByRole('dialog', { name: 'New Request' });
}

describe('Shifts > Requests', () => {
  it('looks eight weeks ahead for shifts to swap or offer', async () => {
    render(<Page toastOk={toastOk} toastErr={vi.fn()} />);
    await waitFor(() => expect(timeMySchedule).toHaveBeenCalledWith(day(0), day(56)));
    expect(shiftRequestsMine).toHaveBeenCalledWith(day(0), day(56));
    expect(await screen.findByText(/No requests yet/)).toBeTruthy();
  });

  it('swaps one of my shifts for a teammate’s', async () => {
    await openDialog();
    expect(screen.getByRole('button', { name: /Swap/, pressed: true })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Your shift'), { target: { value: 'mine1' } });
    fireEvent.change(screen.getByLabelText('Teammate'), { target: { value: 'bob@x.com' } });
    expect(screen.getByText('Send Swap Request').closest('button').disabled).toBe(true);   // their shift is still to pick
    fireEvent.change(screen.getByLabelText('Their shift'), { target: { value: 'bob1' } });
    fireEvent.click(screen.getByText('Send Swap Request'));
    await waitFor(() => expect(shiftRequestCreate).toHaveBeenCalledWith(
      { kind: 'swap', shift_id: 'mine1', target_email: 'bob@x.com', target_shift_id: 'bob1', note: '' }));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Swap request sent to Bob Brown.'));
  });

  it('offers a shift', async () => {
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: /Offer/ }));
    fireEvent.change(screen.getByLabelText('Your shift'), { target: { value: 'mine1' } });
    fireEvent.change(screen.getByLabelText('Teammate'), { target: { value: 'bob@x.com' } });
    expect(screen.queryByLabelText('Their shift')).toBeNull();
    fireEvent.click(screen.getByText('Send Offer'));
    await waitFor(() => expect(shiftRequestCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'offer', shift_id: 'mine1', target_email: 'bob@x.com', target_shift_id: '' })));
  });

  it('says why when there is nothing to swap', async () => {
    timeMySchedule.mockResolvedValue({ scheduled: [], teams: [] });
    const { unmount } = render(<Page toastOk={toastOk} toastErr={vi.fn()} />);
    const btn = await screen.findByRole('button', { name: /New Request/ });
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    expect(screen.getByText(/You have no published shifts coming up/)).toBeTruthy();
    expect(screen.getByText('Send Swap Request').closest('button').disabled).toBe(true);
    unmount();
    // ...and when there is no team to swap with.
    timeMySchedule.mockResolvedValue({ scheduled: [mine], teams: [] });
    shiftRequestsMine.mockResolvedValue(reqs({ teammates: [], swapShifts: {} }));
    await openDialog();
    expect(screen.getByText(/You are not on a team yet/)).toBeTruthy();
  });

  it('leaves out a shift that already has a request open, and a kind that is turned off', async () => {
    shiftRequestsMine.mockResolvedValue(reqs({
      settings: { openShifts: true, swaps: false, offers: true, timeOffRequests: true },
      mine: [{ id: 'r1', kind: 'offer', status: 'pending_peer', shift: { id: 'mine1', date: mine.date, start: '09:00', end: '17:00' },
        target: { email: 'bob@x.com', name: 'Bob Brown' } }] }));
    await openDialog();
    expect(screen.getByRole('button', { name: /Swap/ }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Offer/, pressed: true })).toBeTruthy();
    expect(screen.getByText(/You have no published shifts coming up/)).toBeTruthy();
  });

  it('takes a time-off request to Workday', async () => {
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', on);
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: /Time Off/ }));
    fireEvent.click(screen.getByText('Open Time Off'));
    window.removeEventListener('nexus:navigate', on);
    expect(seen).toEqual([{ view: 'timeclock', sub: 'timeoff' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gives a manager the team’s requests to decide, on the page', async () => {
    shiftRequestsInbox.mockResolvedValue({ pending: [{ id: 'p1', kind: 'open', status: 'pending_manager', summary: 'Amy Adams asked for the open shift',
      requester: { email: 'amy@x.com', name: 'Amy Adams' }, shift: { id: 's', date: day(2), start: '09:00', end: '17:00' }, createdAt: '2026-09-30T10:00:00' }],
    recent: [], settings: reqs().settings, canConfigure: false });
    const { unmount } = render(<Page canManage toastOk={toastOk} toastErr={vi.fn()} />);
    expect(await screen.findByText('Waiting on a Manager')).toBeTruthy();
    expect(await screen.findByText('Amy Adams asked for the open shift.')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Shift Requests' })).toBeTruthy();   // on the page, not a dialog
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();                              // not theirs to change
    unmount();
    // Staff get no inbox.
    render(<Page toastOk={toastOk} toastErr={vi.fn()} />);
    await screen.findByText(/No requests yet/);
    expect(screen.queryByText('Waiting on a Manager')).toBeNull();
  });
});
