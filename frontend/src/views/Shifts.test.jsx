import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Team module (Neil, Oct 13 2026; was Shifts): Contact (the directory) and
// Shifts (the group's week) for everyone; the Shift Planner for managers
// and above. Requests moved into Dashboard > Approvals (Neil, 11/04/2026) -
// Team has no Requests tab and fetches no manager inbox.
// Your own week is Workday > My Shifts. No Presets & Teams tab (that is
// Settings > Global Settings > Shifts) and no employee New Request here
// (that is Workday > Time Off).

const role = { level: 1, grants: new Set(), external: false };
const ADMIN = 5;
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({
  isExternal: role.external,
  can: (r) => role.level >= ({ manager: 3, administrator: ADMIN }[r] ?? 1),
  // RoleContext's rule: the role tier, else a grant at the level asked for.
  canAccessModule: (m, minRole) => role.level >= ({ manager: 3, administrator: ADMIN }[minRole] ?? 1) || role.grants.has(m),
}) }));
vi.mock('../components/TimeTrackingAdmin', () => ({ default: ({ initialSub, embedded }) => <div>Workforce Analytics on {initialSub || 'its first tab'}{embedded ? ' (embedded)' : ''}</div> }));
const shiftRequestsInbox = vi.fn();
const timeOffList = vi.fn();
vi.mock('../api', () => ({ api: { shiftRequestsInbox: (...a) => shiftRequestsInbox(...a), timeOffList: (...a) => timeOffList(...a) } }));
vi.mock('../components/MyShifts', () => ({ default: ({ part }) => <div>{part === 'team' ? 'Group week' : 'My week'}</div> }));
vi.mock('./Directory', () => ({ default: ({ embedded }) => <div>Directory{embedded ? ' (embedded)' : ''}</div> }));
vi.mock('../components/ShiftSchedule', () => ({ default: ({ focus }) => <div>Schedule grid{focus ? ` at ${focus.date} for ${focus.groupId || 'all'}` : ''}</div> }));

const Shifts = (await import('./Shifts')).default;
// The tabs are the module's ModuleTabs strip (the module bar on a computer,
// 11/05/2026); rendered alone, the module draws the in-page strip.
const tabButtons = () => [...document.querySelectorAll('.module-tab-inline-btn')];
const tabNames = () => tabButtons().map((t) => t.textContent.trim());
const tabNamed = (re) => tabButtons().find((t) => re.test(t.textContent));

beforeEach(() => {
  role.grants = new Set();
  role.external = false;
  shiftRequestsInbox.mockReset().mockResolvedValue({ pending: [{ id: 'p1', kind: 'swap' }], recent: [], waitingOnPeer: [] });
  timeOffList.mockReset().mockResolvedValue([{ id: 't1', canDecide: true }, { id: 't2', canDecide: false }]);
});

describe('Team module', () => {
  it('opens an employee on Shifts, Directory last, and never a manager page by address', async () => {
    role.level = 1;
    const onSubChange = vi.fn();
    const { rerender } = render(<Shifts activeSub={null} onSubChange={onSubChange} />);
    // No page title (Neil, 11/06/2026): the module bar names the module and lights the tab.
    expect(screen.queryByRole('heading', { name: 'Shifts' })).toBeNull();
    expect(screen.getByText('Group week')).toBeTruthy();
    expect(tabNames()).toEqual(['Shifts', 'Directory']);
    rerender(<Shifts activeSub="contact" onSubChange={onSubChange} />);
    expect(await screen.findByText('Directory (embedded)')).toBeTruthy();
    rerender(<Shifts activeSub="schedule" onSubChange={onSubChange} />);
    expect(screen.queryByText('Schedule grid')).toBeNull();
    rerender(<Shifts activeSub="requests" onSubChange={onSubChange} />);
    expect(screen.getByText('Group week')).toBeTruthy();
    expect(shiftRequestsInbox).not.toHaveBeenCalled();   // nothing of a manager's is fetched
  });

  // Weather Call (Oct 2026): a weather advisory's bell opens one day of
  // one group - sub "schedule:YYYY-MM-DD:<group>" - and an employee, who
  // has no Schedule tab, lands on the module's first tab instead.
  it('lands a manager on the day and group a weather advisory points at', async () => {
    role.level = 3;
    render(<Shifts activeSub="schedule:2026-10-16:g1" onSubChange={vi.fn()} />);
    expect(tabNamed(/Shift Planner/).classList.contains('active')).toBe(true);
    expect(screen.getByText('Schedule grid at 2026-10-16 for g1')).toBeTruthy();
    role.level = 1;
    render(<Shifts activeSub="schedule:2026-10-16:g1" onSubChange={vi.fn()} />);
    expect(screen.getByText('Group week')).toBeTruthy();
  });

  it('gives a manager three tabs - no Requests tab, requests are in Approvals', async () => {
    role.level = 3;
    const onSubChange = vi.fn();
    const { rerender } = render(<Shifts activeSub="shifts" onSubChange={onSubChange} />);
    expect(tabNames()).toEqual(['Shifts', 'Shift Planner', 'Directory']);
    expect(screen.queryByText(/Presets/)).toBeNull();
    fireEvent.click(tabNamed(/Shift Planner/));
    expect(onSubChange).toHaveBeenCalledWith('schedule');
    rerender(<Shifts activeSub="schedule" onSubChange={onSubChange} />);
    expect(screen.getByText('Schedule grid')).toBeTruthy();
    // An old 'requests' address that reaches the module anyway opens its first tab.
    rerender(<Shifts activeSub="requests" onSubChange={onSubChange} />);
    expect(screen.getByText('Group week')).toBeTruthy();
    expect(shiftRequestsInbox).not.toHaveBeenCalled();
    expect(timeOffList).not.toHaveBeenCalled();
  });
  // The Shift Planner grant (11/10/2026) opens the planner tab below Manager.
  it('gives a Shift Planner grant holder the Shift Planner tab without the Manager role', () => {
    role.level = 1;
    role.grants = new Set(['shifts']);
    render(<Shifts activeSub="schedule" onSubChange={vi.fn()} />);
    expect(tabNames()).toEqual(['Shifts', 'Shift Planner', 'Directory']);
    expect(screen.getByText('Schedule grid')).toBeTruthy();
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
    expect(tabNames()).toEqual(['Shifts', 'Shift Planner', 'Directory', 'Workforce Analytics']);
    g.unmount();

    role.level = ADMIN; role.grants = new Set();
    render(<Shifts activeSub="analytics" onSubChange={vi.fn()} />);
    expect(await screen.findByText('Workforce Analytics on its first tab (embedded)')).toBeTruthy();
  });
  it('gives an external guest with the grant that one tab, and nothing of Team else', async () => {
    role.level = 1; role.external = true; role.grants = new Set(['employee-tracking']);
    const { unmount } = render(<Shifts activeSub="contact" onSubChange={vi.fn()} />);
    expect(tabNames()).toEqual([]);   // one tab draws no strip (Neil, 11/06/2026)
    expect(await screen.findByText('Workforce Analytics on its first tab (embedded)')).toBeTruthy();
    expect(screen.queryByText(/Directory/)).toBeNull();
    expect(screen.queryByText('Group week')).toBeNull();
    unmount();
    role.grants = new Set();   // a guest without it: no tab, no content, no manager page
    render(<Shifts activeSub="requests" onSubChange={vi.fn()} />);
    expect(tabButtons()).toEqual([]);
    expect(screen.queryByText(/Group week|Workforce Analytics on/)).toBeNull();
  });
});
