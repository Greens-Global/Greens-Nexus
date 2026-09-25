// Render-smoke + data-shaping tests for the workday widgets (phase 2, Sep 24):
// Time Clock, My Requests, Due Back Soon, Coming Up, plus the Signatures
// Needed KPI and the new quick-action deep links. A crash-on-render here
// would blank a saved dashboard view, so each tile is mounted against the
// real endpoint shapes (mocked) and the visible words are pinned.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  timeStatus: vi.fn(), timeOffMine: vi.fn(), timeMyPunchRequests: vi.fn(), myHrRequests: vi.fn(),
  getItemCheckouts: vi.fn(), getAssignments: vi.fn(), dashBirthdays: vi.fn(), dashHolidays: vi.fn(),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import { WIDGETS, KPI_CATALOG, QUICK_ACTIONS, DEFAULT_QUICK_ACTIONS } from './widgets.jsx';
import { TimeClockWidget, MyRequestsWidget, DueBackWidget, ComingUpWidget, normalizeRequests, dueRows, comingUpRows } from './workdayWidgets.jsx';

// Fixed "now": Tuesday 09/22/2026 10:30 local.
const NOW = new Date(2026, 8, 22, 10, 30);
const iso = (d) => d.toISOString();
const localKey = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  apiMock.timeOffMine.mockResolvedValue([]);
  apiMock.timeMyPunchRequests.mockResolvedValue([]);
  apiMock.myHrRequests.mockResolvedValue([]);
  apiMock.getItemCheckouts.mockResolvedValue([]);
  apiMock.getAssignments.mockResolvedValue([]);
  apiMock.dashBirthdays.mockResolvedValue({ birthdays: [] });
  apiMock.dashHolidays.mockResolvedValue({ holidays: [] });
});
afterEach(() => { vi.useRealTimers(); });

describe('Time Clock tile', () => {
  it('shows Clocked In, today’s hours including the live session, and hands off to Time Clock', async () => {
    // Punched in 90 minutes ago (server stamps are UTC without a Z); 2h already closed today.
    const at = new Date(NOW.getTime() - 90 * 60000).toISOString().slice(0, 19);
    apiMock.timeStatus.mockResolvedValue({ lastPunch: { kind: 'in', at }, staleOpenShift: false, days: { [localKey(NOW)]: { workedMin: 120 } } });
    render(<TimeClockWidget />);
    expect(await screen.findByText('Clocked In')).toBeTruthy();
    expect(screen.getAllByText('3h 30m')).toHaveLength(2); // today and last 7 days both 3h 30m in this fixture
    expect(screen.getByText(/Open Time Clock/)).toBeTruthy();
  });

  it('shows Clocked Out with a Punch In hand-off, and On Break pauses the live count', async () => {
    apiMock.timeStatus.mockResolvedValue({ lastPunch: { kind: 'out', at: '2026-09-21T23:00:00' }, days: {} });
    const { unmount } = render(<TimeClockWidget />);
    expect(await screen.findByText('Clocked Out')).toBeTruthy();
    expect(screen.getByText(/Punch In/)).toBeTruthy();
    unmount();
    const at = new Date(NOW.getTime() - 20 * 60000).toISOString().slice(0, 19);
    apiMock.timeStatus.mockResolvedValue({ lastPunch: { kind: 'break_start', at }, days: { [localKey(NOW)]: { workedMin: 60 } } });
    render(<TimeClockWidget />);
    expect(await screen.findByText('On Break')).toBeTruthy();
    expect(screen.getAllByText('1h 00m')).toHaveLength(2); // live session paused: today stays 1h 00m
  });

  it('tells exempt roles they need not track time', async () => {
    apiMock.timeStatus.mockResolvedValue({ timeTrackingExempt: true, days: {} });
    render(<TimeClockWidget />);
    expect(await screen.findByText(/not required for your role/)).toBeTruthy();
  });
});

describe('My Requests', () => {
  const old = iso(new Date(NOW.getTime() - 40 * 86400000));
  const recent = iso(new Date(NOW.getTime() - 3 * 86400000));
  it('merges the three sources, pending first, and drops decisions older than 14 days', () => {
    const rows = normalizeRequests({
      timeOff: [
        { id: 1, type: 'vacation', startDate: '2026-10-05', endDate: '2026-10-07', status: 'pending', createdAt: recent },
        { id: 2, type: 'sick', startDate: '2026-08-01', endDate: '2026-08-01', status: 'approved', createdAt: old, decidedAt: old },
      ],
      punch: [{ id: 'p1', action: 'add', punchKind: 'out', localDate: '2026-09-18', status: 'approved', createdAt: recent, decidedAt: recent }],
      hr: [{ id: 'h1', type: 'document', message: 'Need my offer letter', status: 'open', createdAt: old }],
    }, NOW);
    expect(rows.map(r => r.id)).toEqual(['to-1', 'hr-h1', 'pr-p1']);
    expect(rows[0].title).toBe('Vacation · 10/05/2026 - 10/07/2026');
    expect(rows[1].status).toBe('pending');
    expect(rows[2].title).toBe('Add Punch Out · 09/18/2026');
  });

  it('renders rows and the waiting count; empty state otherwise', async () => {
    apiMock.timeOffMine.mockResolvedValue([{ id: 1, type: 'personal', startDate: '2026-10-01', endDate: '2026-10-01', status: 'pending', createdAt: recent }]);
    const { unmount } = render(<MyRequestsWidget />);
    expect(await screen.findByText('Personal · 10/01/2026')).toBeTruthy();
    expect(screen.getByText('1 waiting on a decision')).toBeTruthy();
    unmount();
    apiMock.timeOffMine.mockResolvedValue([]);
    render(<MyRequestsWidget />);
    expect(await screen.findByText(/No open requests/)).toBeTruthy();
  });
});

describe('Due Back Soon', () => {
  it('computes due from handover + days, flags overdue, includes acceptances, ignores other people’s rows', () => {
    const handed = (daysAgo) => iso(new Date(NOW.getTime() - daysAgo * 86400000));
    const rows = dueRows([
      { id: 'a', item_name: 'Drill', status: 'allocated', requested_by_email: 'neil@greensglobal.com', handed_over_at: handed(5), days: 3 },
      { id: 'b', item_name: 'Ladder', status: 'allocated', requested_by_email: 'neil@greensglobal.com', handed_over_at: handed(1), days: 7 },
      { id: 'c', item_name: 'Not mine', status: 'allocated', requested_by_email: 'someone@greensglobal.com', handed_over_at: handed(9), days: 1 },
      { id: 'd', item_name: 'Returned', status: 'returned', requested_by_email: 'neil@greensglobal.com', handed_over_at: handed(9), days: 1 },
      { id: 'e', item_name: 'Awaiting', status: 'approved', requested_by_email: 'neil@greensglobal.com', handed_over_at: '', days: 2 },
    ], [
      { id: 'x', item_name: 'Laptop', status: 'pending_acceptance', assignee_email: 'neil@greensglobal.com', assigned_by: 'Charmi' },
      { id: 'y', item_name: 'Active one', status: 'active', assignee_email: 'neil@greensglobal.com' },
    ], 'neil@greensglobal.com', NOW);
    expect(rows.map(r => r.title)).toEqual(['Laptop', 'Drill', 'Ladder', 'Awaiting']);
    expect(rows[0].statusLabel).toBe('Accept');
    expect(rows[1].statusLabel).toBe('Overdue 2 days');
    expect(rows[2].statusLabel).toBe('Due in 6 days');
    expect(rows[3].statusLabel).toBe('Awaiting handover');
  });

  it('renders the overdue count and the empty state', async () => {
    apiMock.getItemCheckouts.mockResolvedValue([{ id: 'a', item_name: 'Drill', status: 'allocated', requested_by_email: 'neil@greensglobal.com', handed_over_at: iso(new Date(NOW.getTime() - 5 * 86400000)), days: 3 }]);
    const { unmount } = render(<DueBackWidget />);
    expect(await screen.findByText('Drill')).toBeTruthy();
    expect(screen.getByText('1 overdue')).toBeTruthy();
    unmount();
    apiMock.getItemCheckouts.mockResolvedValue([]);
    render(<DueBackWidget />);
    expect(await screen.findByText(/Nothing due back/)).toBeTruthy();
  });
});

describe('Coming Up', () => {
  it('orders birthdays and holidays by days away, wraps year-end birthdays, ignores past holidays', () => {
    const rows = comingUpRows(
      [{ name: 'Ava', month: 9, day: 23 }, { name: 'Ben', month: 9, day: 22 }, { name: 'Far', month: 12, day: 25 }, { name: 'Cal', month: 10, day: 20 }],
      [{ date: '2026-10-12', name: 'Columbus Day', type: 'optional' }, { date: '2026-09-07', name: 'Labor Day' }],
      NOW,
    );
    expect(rows.map(r => r.title)).toEqual(['Ben', 'Ava', 'Columbus Day', 'Cal']);
    expect(rows[0].diff).toBe(0);
    expect(rows[2].meta).toBe('Optional holiday');
  });

  it('renders Today / Tomorrow labels', async () => {
    apiMock.dashBirthdays.mockResolvedValue({ birthdays: [{ name: 'Ava', month: 9, day: 23 }, { name: 'Ben', month: 9, day: 22 }] });
    render(<ComingUpWidget />);
    expect(await screen.findByText('Ben')).toBeTruthy();
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Tomorrow')).toBeTruthy();
  });
});

describe('registry, KPI catalog and quick actions', () => {
  it('registers the four Workday tiles and the Signatures Needed metric', () => {
    for (const k of ['time-clock', 'my-requests', 'due-back', 'coming-up']) expect(WIDGETS[k]?.cat).toBe('Workday');
    expect(KPI_CATALOG.signatures_needed.label).toBe('Signatures Needed');
  });
  it('adds the workday deep links to the catalog without changing the default six', () => {
    const keys = QUICK_ACTIONS.map(a => a.key);
    for (const k of ['time-off', 'punch-fix', 'ask-hr', 'purchase']) expect(keys).toContain(k);
    expect(DEFAULT_QUICK_ACTIONS).toEqual(['task', 'event', 'email', 'request-item', 'timeclock', 'kb']);
    expect(QUICK_ACTIONS.find(a => a.key === 'time-off')).toMatchObject({ view: 'timeclock', sub: 'timeoff' });
  });
});
