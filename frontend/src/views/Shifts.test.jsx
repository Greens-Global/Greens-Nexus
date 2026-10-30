import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Team module (Neil, Oct 13 2026; was Shifts): Contact (the directory) and
// Shifts (the group's week) for everyone; Schedule and Requests - the
// manager's inbox, with a badge for what waits - for managers and above.
// Your own week is Workday > My Shifts. No Presets & Teams tab (that is
// Settings > Global Settings > Shifts) and no employee New Request here
// (that is Workday > Time Off).

const role = { level: 1, grants: new Set() };
const ADMIN = 5;
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({
  can: (r) => role.level >= ({ manager: 3, administrator: ADMIN }[r] ?? 1),
  // RoleContext's rule: the role tier, else a grant at the level asked for.
  canAccessModule: (m, minRole) => role.level >= ({ administrator: ADMIN }[minRole] ?? 1) || role.grants.has(m),
}) }));
vi.mock('../components/TimeTrackingAdmin', () => ({ default: ({ initialSub, embedded }) => <div>Workforce Analytics on {initialSub || 'its first tab'}{embedded ? ' (embedded)' : ''}</div> }));
const shiftRequestsInbox = vi.fn();
const timeOffList = vi.fn();
vi.mock('../api', () => ({ api: { shiftRequestsInbox: (...a) => shiftRequestsInbox(...a), timeOffList: (...a) => timeOffList(...a) } }));
vi.mock('../components/MyShifts', () => ({ default: ({ part }) => <div>{part === 'team' ? 'Group week' : 'My week'}</div> }));
vi.mock('./Directory', () => ({ default: ({ embedded }) => <div>Directory{embedded ? ' (embedded)' : ''}</div> }));
vi.mock('../components/ShiftSchedule', () => ({ default: ({ focus }) => <div>Schedule grid{focus ? ` at ${focus.date} for ${focus.groupId || 'all'}` : ''}</div> }));
vi.mock('../components/ShiftRequestsPage', () => ({ default: ({ inbox, timeoff, error }) => <div>Requests page ({error ? 'error' : inbox ? `${inbox.pending.length} + ${timeoff.length}` : 'loading'})</div> }));

const Shifts = (await import('./Shifts')).default;
const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent.trim());

beforeEach(() => {
  role.grants = new Set();
  shiftRequestsInbox.mockReset().mockResolvedValue({ pending: [{ id: 'p1', kind: 'swap' }], recent: [], waitingOnPeer: [] });
  timeOffList.mockReset().mockResolvedValue([{ id: 't1', canDecide: true }, { id: 't2', canDecide: false }]);
});

describe('Team module', () => {
  it('opens an employee on Shifts, Company Directory last, and never a manager page by address', async () => {
    role.level = 1;
    const onSubChange = vi.fn();
    const { rerender } = render(<Shifts activeSub={null} onSubChange={onSubChange} />);
    expect(screen.getByRole('heading', { name: 'Team' })).toBeTruthy();
    expect(screen.getByText('Group week')).toBeTruthy();
    expect(tabNames()).toEqual(['Shifts', 'Company Directory']);
    rerender(<Shifts activeSub="contact" onSubChange={onSubChange} />);
    expect(await screen.findByText('Directory (embedded)')).toBeTruthy();
    rerender(<Shifts activeSub="schedule" onSubChange={onSubChange} />);
    expect(screen.queryByText('Schedule grid')).toBeNull();
    rerender(<Shifts activeSub="requests" onSubChange={onSubChange} />);
    expect(screen.queryByText(/Requests page/)).toBeNull();
    expect(shiftRequestsInbox).not.toHaveBeenCalled();   // nothing of a manager's is fetched
  });

  // Weather Call (Oct 2026): a weather advisory's bell opens one day of
  // one group - sub "schedule:YYYY-MM-DD:<group>" - and an employee, who
  // has no Schedule tab, lands on the module's first tab instead.
  it('lands a manager on the day and group a weather advisory points at', async () => {
    role.level = 3;
    render(<Shifts activeSub="schedule:2026-10-16:g1" onSubChange={vi.fn()} />);
    expect(screen.getByRole('tab', { name: /Schedule/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Schedule grid at 2026-10-16 for g1')).toBeTruthy();
    role.level = 1;
    render(<Shifts activeSub="schedule:2026-10-16:g1" onSubChange={vi.fn()} />);
    expect(screen.getByText('Group week')).toBeTruthy();
  });

  it('gives a manager four tabs, with what waits counted on Requests', async () => {
    role.level = 3;
    const onSubChange = vi.fn();
    const { rerender } = render(<Shifts activeSub="shifts" onSubChange={onSubChange} />);
    expect(tabNames().map((t) => t.replace(/\d+$/, '').trim())).toEqual(['Shifts', 'Schedule', 'Requests', 'Company Directory']);
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
  // Workforce Analytics moved into Team (Neil, Oct 29 2026). Team is
  // everyone's, so the tab is only for administrators and the people given
  // the Workforce Analytics or Workforce Scorecard grant - never a plain
  // manager - and its address (a bell, the Monday email) falls back to
  // Shifts for anyone else.
  it('shows Workforce Analytics only to its grant holders and administrators', async () => {
    role.level = 1;
    const { unmount } = render(<Shifts activeSub="analytics:scorecard" onSubChange={vi.fn()} />);
    expect(tabNames()).not.toContain('Workforce Analytics');
    expect(screen.getByText('Group week')).toBeTruthy();
    expect(screen.queryByText(/Workforce Analytics on/)).toBeNull();
    unmount();

    role.level = 3;   // a manager with no grant: still no tab, nothing loaded
    const m = render(<Shifts activeSub="analytics" onSubChange={vi.fn()} />);
    expect(tabNames()).not.toContain('Workforce Analytics');
    expect(screen.queryByText(/Workforce Analytics on/)).toBeNull();
    m.unmount();

    role.level = 1; role.grants = new Set(['workforce-scorecard']);   // Scorecard grant alone
    const e = render(<Shifts activeSub="analytics:scorecard" onSubChange={vi.fn()} />);
    expect(tabNames()).toContain('Workforce Analytics');
    expect(await screen.findByText('Workforce Analytics on scorecard (embedded)')).toBeTruthy();
    e.unmount();

    role.level = 3; role.grants = new Set(['employee-tracking']);
    const g = render(<Shifts activeSub={null} onSubChange={vi.fn()} />);
    expect(tabNames()).toEqual(['Shifts', 'Schedule', 'Requests', 'Workforce Analytics', 'Company Directory']);
    g.unmount();

    role.level = ADMIN; role.grants = new Set();
    render(<Shifts activeSub="analytics" onSubChange={vi.fn()} />);
    expect(await screen.findByText('Workforce Analytics on its first tab (embedded)')).toBeTruthy();
  });
});
