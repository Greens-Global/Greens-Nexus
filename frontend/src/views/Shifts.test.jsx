import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Shifts module (Oct 2026): My Shifts for everyone; Schedule and Requests -
// the manager's inbox, with a badge for what waits - for managers and above.
// No Presets & Teams tab (that is Settings > Global Settings > Shifts) and
// no employee New Request here (that is Workday > Time Off).

const role = { level: 1 };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: (r) => role.level >= ({ manager: 3 }[r] ?? 1) }) }));
const shiftRequestsInbox = vi.fn();
const timeOffList = vi.fn();
vi.mock('../api', () => ({ api: { shiftRequestsInbox: (...a) => shiftRequestsInbox(...a), timeOffList: (...a) => timeOffList(...a) } }));
vi.mock('../components/MyShifts', () => ({ default: () => <div>My week</div> }));
vi.mock('../components/ShiftSchedule', () => ({ default: () => <div>Schedule grid</div> }));
vi.mock('../components/ShiftRequestsPage', () => ({ default: ({ inbox, timeoff, error }) => <div>Requests page ({error ? 'error' : inbox ? `${inbox.pending.length} + ${timeoff.length}` : 'loading'})</div> }));

const Shifts = (await import('./Shifts')).default;
const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent.trim());

beforeEach(() => {
  shiftRequestsInbox.mockReset().mockResolvedValue({ pending: [{ id: 'p1', kind: 'swap' }], recent: [], waitingOnPeer: [] });
  timeOffList.mockReset().mockResolvedValue([{ id: 't1', canDecide: true }, { id: 't2', canDecide: false }]);
});

describe('Shifts module', () => {
  it('shows an employee only My Shifts, and never a manager page by address', () => {
    role.level = 1;
    const onSubChange = vi.fn();
    const { rerender } = render(<Shifts activeSub={null} onSubChange={onSubChange} />);
    expect(screen.getByRole('heading', { name: 'Shifts' })).toBeTruthy();
    expect(screen.getByText('My week')).toBeTruthy();
    expect(tabNames()).toEqual(['My Shifts']);
    rerender(<Shifts activeSub="schedule" onSubChange={onSubChange} />);
    expect(screen.getByText('My week')).toBeTruthy();
    expect(screen.queryByText('Schedule grid')).toBeNull();
    rerender(<Shifts activeSub="requests" onSubChange={onSubChange} />);
    expect(screen.queryByText(/Requests page/)).toBeNull();
    expect(shiftRequestsInbox).not.toHaveBeenCalled();   // nothing of a manager's is fetched
  });

  it('gives a manager three tabs, with what waits counted on Requests', async () => {
    role.level = 3;
    const onSubChange = vi.fn();
    const { rerender } = render(<Shifts activeSub="mine" onSubChange={onSubChange} />);
    expect(tabNames().map((t) => t.replace(/\d+$/, '').trim())).toEqual(['My Shifts', 'Schedule', 'Requests']);
    expect(screen.queryByText(/Presets/)).toBeNull();
    // One pending swap + one decidable time-off request = 2 (the one that is not theirs to decide is not counted).
    expect(await screen.findByRole('tab', { name: 'Requests, 2 waiting' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Schedule/ }));
    expect(onSubChange).toHaveBeenCalledWith('schedule');
    rerender(<Shifts activeSub="schedule" onSubChange={onSubChange} />);
    expect(screen.getByText('Schedule grid')).toBeTruthy();
    rerender(<Shifts activeSub="requests" onSubChange={onSubChange} />);
    expect(await screen.findByText('Requests page (1 + 2)')).toBeTruthy();   // the same data as the badge
    expect(shiftRequestsInbox).toHaveBeenCalledTimes(1);                    // fetched once for both
  });

  it('shows the Requests page an error, not a skeleton forever, when the inbox fails', async () => {
    role.level = 3;
    shiftRequestsInbox.mockRejectedValue(new Error('API error 500'));
    render(<Shifts activeSub="requests" onSubChange={() => {}} />);
    expect(await screen.findByText('Requests page (error)')).toBeTruthy();
  });
});
