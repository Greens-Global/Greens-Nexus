import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Shifts > Requests (Oct 2026): the manager's inbox - tabs with counts, a
// Waiting On Teammate section, a swap card with BOTH shifts, a time-off card
// with the shifts inside the leave and Approve And Remove Shifts, decisions
// with a note, a decided list with Title Case chips, and an error with
// Retry when the inbox cannot load.

const shiftRequestDecide = vi.fn();
const timeOffDecide = vi.fn();
const confirmAsk = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmAsk(...a) } }));
vi.mock('../api', () => ({
  api: {
    shiftRequestDecide: (...a) => shiftRequestDecide(...a),
    timeOffDecide: (...a) => timeOffDecide(...a),
    getPeopleDirectory: vi.fn().mockResolvedValue([{ email: 'amy@x.com', name: 'Amy Adams' }, { email: 'bob@x.com', name: 'Bob Brown' }]),
    getRolesDirectory: vi.fn().mockResolvedValue([]),
  },
}));

const Page = (await import('./ShiftRequestsPage')).default;

const amy = { email: 'amy@x.com', name: 'Amy Adams' };
const bob = { email: 'bob@x.com', name: 'Bob Brown' };
const swap = { id: 'r1', kind: 'swap', status: 'pending_manager', summary: "Amy Adams wants to swap 10/05/2026 9:00 AM - 5:00 PM for Bob Brown's 10/06/2026 9:00 AM - 5:00 PM",
  requester: amy, target: bob, note: 'Doctor visit', peerNote: 'Fine by me', createdAt: '2026-09-29T10:00:00',
  shift: { id: 's1', date: '2026-10-05', start: '09:00', end: '17:00', code: 'GST', color: '#2563eb' },
  targetShift: { id: 's2', date: '2026-10-06', start: '09:00', end: '17:00', code: 'GST', color: '#2563eb' } };
const offer = { id: 'r2', kind: 'offer', status: 'pending_manager', summary: 'Bob Brown offered 10/07/2026 12:00 PM - 8:00 PM to Amy Adams', requester: bob, target: amy,
  note: '', peerNote: '', createdAt: '2026-09-29T11:00:00', shift: { id: 's3', date: '2026-10-07', start: '12:00', end: '20:00' }, targetShift: null };
const waiting = { id: 'r3', kind: 'swap', status: 'pending_peer', summary: "Bob Brown wants to swap 10/08/2026 9:00 AM - 5:00 PM for Amy Adams's 10/09/2026 9:00 AM - 5:00 PM",
  requester: bob, target: amy, createdAt: '2026-09-29T12:00:00', shift: { id: 's4', date: '2026-10-08', start: '09:00', end: '17:00' }, targetShift: null };
const recent = { id: 'r4', kind: 'open', status: 'declined', summary: 'Amy Adams asked for the open shift 10/01/2026 6:00 AM - 2:00 PM', decisionNote: 'Another request filled this shift', decidedAt: '2026-09-30T10:00:00',
  requester: amy, target: null, shift: { id: 's5', date: '2026-10-01', start: '06:00', end: '14:00' } };
const inbox = { pending: [swap, offer], waitingOnPeer: [waiting], recent: [recent], photos: {} };
const timeoff = [{ id: 't1', email: 'amy@x.com', name: 'Amy Adams', type: 'vacation', startDate: '2026-10-05', endDate: '2026-10-06', startTime: '', endTime: '', note: 'Family trip', status: 'pending',
  conflicts: [{ id: 's1', date: '2026-10-05', start: '09:00', end: '17:00', code: 'GST', color: '#2563eb' }] },
{ id: 't2', email: 'bob@x.com', name: 'Bob Brown', type: 'sick', startDate: '2026-10-07', endDate: '2026-10-07', startTime: '14:00', endTime: '16:00', note: 'Dentist', status: 'pending' }];
const toastOk = vi.fn();
const toastErr = vi.fn();
const onChanged = vi.fn();
const page = (over = {}) => render(<Page inbox={inbox} timeoff={timeoff} loading={false} error={null} onRetry={vi.fn()} onChanged={onChanged} toastOk={toastOk} toastErr={toastErr} {...over} />);

beforeEach(() => {
  shiftRequestDecide.mockReset().mockResolvedValue({});
  timeOffDecide.mockReset().mockResolvedValue({ conflicts: [] });
  confirmAsk.mockReset().mockResolvedValue(true);
  toastOk.mockReset(); toastErr.mockReset(); onChanged.mockReset();
});

describe('Shifts > Requests (manager inbox)', () => {
  it('has tabs with counts and opens on Time Off', () => {
    page();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent.replace(/\d+$/, '').trim());
    expect(tabs).toEqual(['Time Off', 'Swaps', 'Offers', 'Open Shifts']);
    expect(screen.getByRole('tab', { name: /Time Off/ }).textContent).toContain('2');
    expect(screen.getByRole('tab', { name: /Swaps/ }).textContent).toContain('1');
    expect(screen.getByRole('tab', { name: /Offers/ }).textContent).toContain('1');
    expect(screen.getByRole('tab', { name: /Open Shifts/ }).textContent).not.toMatch(/\d/);
    expect(screen.getByText('Amy Adams · 10/05/2026 - 10/06/2026')).toBeTruthy();
    expect(screen.getByText('Bob Brown · 10/07/2026, 2:00 PM - 4:00 PM')).toBeTruthy();   // a partial day shows its hours
  });

  it('shows the shifts inside a leave and approves with removal, or plainly', async () => {
    page();
    expect(screen.getByText('1 shared shift inside this leave')).toBeTruthy();
    fireEvent.click(screen.getByText('Approve And Remove Shifts'));
    await waitFor(() => expect(timeOffDecide).toHaveBeenCalledWith('t1', { status: 'approved', note: '', remove_shifts: true }));
    expect(toastOk).toHaveBeenCalledWith(expect.stringMatching(/approved and the shifts inside it marked for removal/));
    expect(onChanged).toHaveBeenCalled();
    // Bob's has no conflict: one Approve, with a note; Decline sends "rejected".
    const bobCard = screen.getByText('Bob Brown · 10/07/2026, 2:00 PM - 4:00 PM').closest('div').parentElement;
    fireEvent.change(within(bobCard).getByLabelText('Note to the employee'), { target: { value: 'Feel better' } });
    fireEvent.click(within(bobCard).getByText('Decline'));
    await waitFor(() => expect(timeOffDecide).toHaveBeenLastCalledWith('t2', { status: 'rejected', note: 'Feel better' }));
    expect(toastOk).toHaveBeenCalledWith('Time off declined. They were told.');
  });

  it('offers to remove the shifts the approval reports back', async () => {
    timeOffDecide.mockResolvedValueOnce({ conflicts: [{ id: 's9', date: '2026-10-07', start: '09:00', end: '17:00' }] });
    page();
    const bobCard = screen.getByText('Bob Brown · 10/07/2026, 2:00 PM - 4:00 PM').closest('div').parentElement;
    fireEvent.click(within(bobCard).getByText('Approve'));
    await waitFor(() => expect(timeOffDecide).toHaveBeenCalledWith('t2', { status: 'approved', note: '' }));
    expect(await screen.findByText('Remove Those Shifts')).toBeTruthy();
    fireEvent.click(screen.getByText('Remove Those Shifts'));
    await waitFor(() => expect(timeOffDecide).toHaveBeenLastCalledWith('t2', { status: 'approved', note: '', remove_shifts: true }));
  });

  it('draws both shifts of a swap, lists what waits on the teammate, and approves with a note', async () => {
    page();
    fireEvent.click(screen.getByRole('tab', { name: /Swaps/ }));
    expect(screen.getByText(`${swap.summary}.`)).toBeTruthy();
    expect(document.querySelectorAll('[data-shift="s1"]').length).toBe(1);
    expect(document.querySelectorAll('[data-shift="s2"]').length).toBe(1);
    expect(screen.getByText('Amy Adams: “Doctor visit”')).toBeTruthy();
    expect(screen.getByText('Bob Brown: “Fine by me”')).toBeTruthy();
    expect(screen.getAllByText('Waiting On Teammate').length).toBe(2);   // the section and its chip
    expect(screen.getByText('Amy Adams has not answered yet. It reaches you once they accept.')).toBeTruthy();
    expect(screen.queryByText(/offered/)).toBeNull();   // offers are on their own tab
    fireEvent.change(screen.getByLabelText('Note to the team'), { target: { value: 'OK this once' } });
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(shiftRequestDecide).toHaveBeenCalledWith('r1', { approve: true, note: 'OK this once' }));
    expect(toastOk).toHaveBeenCalledWith('Approved. The schedule is updated and everyone involved was told.');
  });

  it('asks before forcing an approval the new owner has a conflict with (409)', async () => {
    const conflict = Object.assign(new Error('Bob Brown already has a shift 9:00 AM - 1:00 PM that day.'), { status: 409 });
    shiftRequestDecide.mockRejectedValueOnce(conflict).mockResolvedValue({});
    page();
    fireEvent.click(screen.getByRole('tab', { name: /Offers/ }));
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(confirmAsk).toHaveBeenCalledWith(expect.stringMatching(/already has a shift .* Approve anyway\?/), expect.objectContaining({ title: 'Approve With A Conflict' })));
    await waitFor(() => expect(shiftRequestDecide).toHaveBeenLastCalledWith('r2', { approve: true, note: '', force: true }));
  });

  it('shows the decided list with Title Case chips on the Open Shifts tab', () => {
    page();
    fireEvent.click(screen.getByRole('tab', { name: /Open Shifts/ }));
    expect(screen.getByText('Nothing waiting on a manager.')).toBeTruthy();
    expect(screen.getByText('Recently Decided')).toBeTruthy();
    expect(screen.getByText('Declined')).toBeTruthy();
    expect(screen.getByText(/Another request filled this shift/)).toBeTruthy();
  });

  it('shows an error with Retry, never a skeleton forever, when the inbox failed', () => {
    const onRetry = vi.fn();
    page({ inbox: null, timeoff: null, loading: false, error: 'API error 500', onRetry });
    expect(screen.getByText('The requests could not be loaded right now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });
});
