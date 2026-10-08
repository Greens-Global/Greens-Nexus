// Render-smoke + behavior tests for the My Team tile (Essentials, Oct 7).
// A supervisor's board would blank if this crashed, so it is mounted against
// the real endpoint shapes (mocked) and the visible words are pinned: tile
// counts, the toggled name lists and where a name goes, Late hidden when the
// team has no schedule, Needs a Push order / cap / hand-offs, the empty state,
// a failed load that still renders something, and the refresh cadence.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ getMyTeamToday: vi.fn(), getMyTeamOverdue: vi.fn() }));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({
  myEmail: 'neil@greensglobal.com', can: () => true, myGrantedModules: new Set(['tasks', 'tickets']),
}) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import MyTeam, { bucketMeta, pushMeta, PUSH_CAP, REFRESH_MS } from './MyTeam.jsx';
import { takePendingOpen, __clearPendingOpen } from '../../lib/pendingOpen';
import { takePendingPerson } from '../../lib/personNav';

// Fixed "now": Thursday 10/08/2026 9:00 AM local.
const NOW = new Date(2026, 9, 8, 9, 0);

const TODAY = {
  date: '2026-10-08', scheduleAvailable: true,
  in: [{ email: 'amy@greensglobal.com', name: 'Amy Adams', since: new Date(2026, 9, 8, 7, 2).toISOString(), detail: 'Clocked in', onBreak: false }],
  out: [{ email: 'bob@greensglobal.com', name: 'Bob Brown', since: '', detail: 'Not clocked in' },
        { email: 'dee@greensglobal.com', name: 'Dee Dunn', since: new Date(2026, 9, 8, 8, 30).toISOString(), detail: 'Clocked out' }],
  onLeave: [{ email: 'eve@greensglobal.com', name: 'Eve Evans', since: '2026-10-07', until: '2026-10-09', detail: 'Vacation' }],
  late: [{ email: 'fay@greensglobal.com', name: 'Fay Fox', since: new Date(2026, 9, 8, 8, 0).toISOString(), detail: 'Scheduled, not clocked in' }],
  counts: { in: 1, out: 2, onLeave: 1, late: 1 },
};

const person = (i, extra = {}) => ({
  email: `p${i}@greensglobal.com`, name: `Person ${i}`, overdueTasks: 2, breachedTickets: 0,
  worst: { kind: 'task', id: `task-${i}`, code: `T-${i}`, title: `Task ${i}`, dueOn: '2026-10-01' }, ...extra,
});

const navEvents = [];
const onNav = (e) => navEvents.push(e.detail);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  __clearPendingOpen();
  takePendingPerson();
  navEvents.length = 0;
  window.addEventListener('nexus:navigate', onNav);
  apiMock.getMyTeamToday.mockClear();
  apiMock.getMyTeamOverdue.mockClear();
  apiMock.getMyTeamToday.mockResolvedValue(TODAY);
  apiMock.getMyTeamOverdue.mockResolvedValue({ people: [], total: 0 });
});
afterEach(() => {
  window.removeEventListener('nexus:navigate', onNav);
  vi.useRealTimers();
});

describe('My Team tile', () => {
  it('shows the four tile counts and the date', async () => {
    render(<MyTeam />);
    expect(await screen.findByRole('button', { name: 'In: 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Out: 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'On Leave: 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Late: 1' })).toBeTruthy();
    expect(screen.getByText('Today, 10/08/2026')).toBeTruthy();
    expect(screen.getByText('My Team')).toBeTruthy();
  });

  it('hides the Late tile when the team has no schedule', async () => {
    apiMock.getMyTeamToday.mockResolvedValue({ ...TODAY, late: [], scheduleAvailable: false, counts: { ...TODAY.counts, late: 0 } });
    render(<MyTeam />);
    expect(await screen.findByRole('button', { name: 'In: 1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Late/ })).toBeNull();
  });

  it('tapping a tile toggles its names, and a name opens the person in People', async () => {
    render(<MyTeam />);
    const tile = await screen.findByRole('button', { name: 'In: 1' });
    expect(screen.queryByText('Amy Adams')).toBeNull();
    fireEvent.click(tile);
    expect(screen.getByText('Amy Adams')).toBeTruthy();
    expect(screen.getByText('Since 7:02 AM')).toBeTruthy();
    expect(tile.getAttribute('aria-pressed')).toBe('true');
    // Another tile swaps the list.
    fireEvent.click(screen.getByRole('button', { name: 'Out: 2' }));
    expect(screen.queryByText('Amy Adams')).toBeNull();
    expect(screen.getByText('Bob Brown')).toBeTruthy();
    expect(screen.getByText('Not clocked in')).toBeTruthy();
    expect(screen.getByText('Clocked out 8:30 AM')).toBeTruthy();
    fireEvent.click(screen.getByText('Bob Brown'));
    expect(navEvents.at(-1)).toEqual({ view: 'hr', sub: 'hr-people' });
    expect(takePendingPerson()).toBe('bob@greensglobal.com');
    // Tapping the open tile again closes the list.
    fireEvent.click(screen.getByRole('button', { name: 'Out: 2' }));
    expect(screen.queryByText('Bob Brown')).toBeNull();
  });

  it('describes leave and late people', async () => {
    render(<MyTeam />);
    fireEvent.click(await screen.findByRole('button', { name: 'On Leave: 1' }));
    expect(screen.getByText('Vacation through 10/09/2026')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Late: 1' }));
    expect(screen.getByText('Fay Fox')).toBeTruthy();
    expect(screen.getByText('Shift started 8:00 AM')).toBeTruthy();
  });

  it('says everyone is on track when nothing is overdue', async () => {
    render(<MyTeam />);
    expect(await screen.findByText('Everyone is on track.')).toBeTruthy();
    expect(screen.getByText('Needs a Push')).toBeTruthy();
  });

  it('lists Needs a Push in server order, caps at 7 with View All, and opens the worst item', async () => {
    const people = Array.from({ length: 9 }, (_, i) => person(i));
    people[1] = person(1, { overdueTasks: 0, breachedTickets: 3, worst: { kind: 'ticket', id: 'tk-1', code: 'TK-1', title: 'Printer', dueOn: '2026-10-05' } });
    apiMock.getMyTeamOverdue.mockResolvedValue({ people, total: 9 });
    render(<MyTeam />);
    expect(await screen.findByText('Person 0')).toBeTruthy();
    const names = screen.getAllByText(/^Person \d$/).map(n => n.textContent);
    expect(names).toEqual(['Person 0', 'Person 1', 'Person 2', 'Person 3', 'Person 4', 'Person 5', 'Person 6']);
    expect(names).toHaveLength(PUSH_CAP);
    expect(screen.getByText('2 overdue tasks - Worst: T-0 Task 0 (due 10/01/2026)')).toBeTruthy();
    expect(screen.getByText('3 breached tickets - Worst: TK-1 Printer (due 10/05/2026)')).toBeTruthy();
    expect(screen.getAllByText('Overdue').length).toBe(PUSH_CAP);
    // A task row hands off to the Tasks module and leaves the id for a cold mount.
    fireEvent.click(screen.getByText('Person 0'));
    expect(navEvents.at(-1)).toEqual({ view: 'tasks', sub: 'mine' });
    expect(takePendingOpen('task')).toBe('task-0');
    // A ticket row goes through the Tickets desk hand-off.
    const opened = [];
    const onTicket = (e) => opened.push(e.detail.ticketId);
    window.addEventListener('nexus:open-ticket', onTicket);
    fireEvent.click(screen.getByText('Person 1'));
    expect(navEvents.at(-1)).toEqual({ view: 'tickets', sub: null });
    expect(takePendingOpen('ticket')).toBe('tk-1');
    await act(async () => { await vi.advanceTimersByTimeAsync(5); });
    expect(opened).toEqual(['tk-1']);
    window.removeEventListener('nexus:open-ticket', onTicket);
    // Message on Teams, per person.
    const msg = screen.getByLabelText('Message Person 0 on Teams');
    expect(msg.getAttribute('href')).toBe('https://teams.microsoft.com/l/chat/0/0?users=p0%40greensglobal.com');
    // View All goes to the Tasks workspace team view when tasks are what is overdue.
    fireEvent.click(screen.getByText(/View All \(9\)/));
    expect(navEvents.at(-1)).toEqual({ view: 'tasks', sub: 'teams' });
  });

  it('View All opens the Tickets desk when only tickets are breached', async () => {
    const people = Array.from({ length: 8 }, (_, i) => person(i, { overdueTasks: 0, breachedTickets: 1, worst: { kind: 'ticket', id: `tk-${i}`, code: `TK-${i}`, title: 'T', dueOn: '2026-10-01' } }));
    apiMock.getMyTeamOverdue.mockResolvedValue({ people, total: 8 });
    render(<MyTeam />);
    fireEvent.click(await screen.findByText(/View All/));
    expect(navEvents.at(-1)).toEqual({ view: 'tickets', sub: null });
  });

  it('never renders blank: a failed load shows the error and a Retry', async () => {
    apiMock.getMyTeamToday.mockRejectedValue(new Error('offline'));
    apiMock.getMyTeamOverdue.mockRejectedValue(new Error('offline'));
    render(<MyTeam />);
    expect(await screen.findByText('offline')).toBeTruthy();
    apiMock.getMyTeamToday.mockResolvedValue(TODAY);
    apiMock.getMyTeamOverdue.mockResolvedValue({ people: [] });
    fireEvent.click(screen.getByText('Retry'));
    expect(await screen.findByRole('button', { name: 'In: 1' })).toBeTruthy();
  });

  it('tells a supervisor with no reports so', async () => {
    apiMock.getMyTeamToday.mockResolvedValue({ in: [], out: [], onLeave: [], late: [], counts: { in: 0, out: 0, onLeave: 0, late: 0 }, scheduleAvailable: false });
    render(<MyTeam />);
    expect(await screen.findByText('No one reports to you in People yet.')).toBeTruthy();
    expect(screen.queryByText('Needs a Push')).toBeNull();
  });

  it('refreshes every minute while the tab is visible and when it becomes visible again', async () => {
    render(<MyTeam />);
    await screen.findByRole('button', { name: 'In: 1' });
    expect(apiMock.getMyTeamToday).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS + 10); });
    expect(apiMock.getMyTeamToday).toHaveBeenCalledTimes(2);
    // Hidden: the timer stops.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS * 2); });
    expect(apiMock.getMyTeamToday).toHaveBeenCalledTimes(2);
    // Visible again: an immediate read, then the minute cadence resumes.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(apiMock.getMyTeamToday).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS + 10); });
    expect(apiMock.getMyTeamToday).toHaveBeenCalledTimes(4);
  });
});

describe('meta lines', () => {
  it('bucketMeta reads each bucket', () => {
    const at = new Date(2026, 9, 8, 7, 2).toISOString();
    expect(bucketMeta('in', { since: at, onBreak: true })).toBe('Since 7:02 AM - On Break');
    expect(bucketMeta('in', { since: '' })).toBe('Clocked in');
    expect(bucketMeta('late', { since: at })).toBe('Shift started 7:02 AM');
    expect(bucketMeta('onLeave', { since: '2026-10-08', until: '2026-10-08', detail: 'Sick' })).toBe('Sick today');
    expect(bucketMeta('onLeave', { since: '2026-10-08', until: '2026-10-10', detail: 'Founders Day' })).toBe('Founders Day through 10/10/2026');
    expect(bucketMeta('out', { since: at, detail: 'Shift later today' })).toBe('Shift at 7:02 AM');
    expect(bucketMeta('out', { since: '', detail: '' })).toBe('Not clocked in');
  });

  it('pushMeta counts and names the worst item', () => {
    expect(pushMeta({ overdueTasks: 1, breachedTickets: 2, worst: { code: 'T-1', title: 'Budget', dueOn: '2026-09-30' } }))
      .toBe('1 overdue task - 2 breached tickets - Worst: T-1 Budget (due 09/30/2026)');
    expect(pushMeta({ overdueTasks: 0, breachedTickets: 0, worst: null })).toBe('');
  });
});

describe('within', () => {
  it('a bucket list is scoped to its own container', async () => {
    render(<MyTeam />);
    fireEvent.click(await screen.findByRole('button', { name: 'Late: 1' }));
    expect(within(screen.getByTestId('bucket-late')).getByText('Fay Fox')).toBeTruthy();
  });
});
