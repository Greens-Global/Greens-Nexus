// My Time tile (Essentials, Oct 8): the pure view model against the real
// endpoint shapes, and a render smoke that pins the visible words and the
// punch hand-offs. A crash here would blank a saved dashboard view.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  timeStatus: vi.fn(), timeMySchedule: vi.fn(), timeMyPayroll: vi.fn(), timesheetReviewWaiting: vi.fn(),
}));
const punchMock = vi.hoisted(() => ({ punchDurable: vi.fn(), replayPending: vi.fn(), readPending: vi.fn() }));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../lib/punchQueue', () => punchMock);
vi.mock('../../lib/geoPosition', () => ({ punchPosition: vi.fn(async () => ({ lat: 1, lng: 2, accuracy_m: 5 })) }));
vi.mock('../../components/BodModal', () => ({ default: ({ mode }) => <div data-testid="bod-modal">{mode}</div> }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import MyTime, { deriveMyTime, dayLabel } from './MyTime.jsx';

// Fixed "now": Thursday 10/08/2026 10:30 local.
const NOW = new Date(2026, 9, 8, 10, 30);
const localKey = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
// Server stamps are UTC without a Z.
const stamp = (d) => d.toISOString().slice(0, 19);
const minsAgo = (m) => new Date(NOW.getTime() - m * 60000);
const TODAY = localKey(NOW);
const key = (daysFromNow) => localKey(new Date(NOW.getTime() + daysFromNow * 86400000));

const clockedInStatus = (overrides = {}) => ({
  lastPunch: { kind: 'in', at: stamp(minsAgo(148)), localDate: TODAY },   // 8:02 AM
  allowed: ['out', 'break_start'], staleOpenShift: false,
  days: { [TODAY]: { workedMin: 0, flags: ['missing_out'], punches: [{ kind: 'in', at: stamp(minsAgo(148)), localDate: TODAY }] } },
  ...overrides,
});

describe('deriveMyTime - status line', () => {
  it('clocked in: label, since the clock-in, live minutes counted into today and this week', () => {
    const vm = deriveMyTime({ status: clockedInStatus(), now: NOW });
    expect(vm.state).toBe('in');
    expect(vm.stateLabel).toBe('Clocked In');
    expect(vm.sinceLabel).toBe('since 8:02 AM');
    expect(vm.actions.map(a => a.label)).toEqual(['Punch Out', 'Start Break']);
    expect(vm.hours.todayMin).toBe(148);
    expect(vm.hours.weekMin).toBe(148);
    // The live session's own missing_out flag is not an exception.
    expect(vm.alerts).toEqual([]);
  });

  it('on break: the break pauses the live count and offers End Break', () => {
    const punches = [
      { kind: 'in', at: stamp(minsAgo(120)), localDate: TODAY },
      { kind: 'break_start', at: stamp(minsAgo(30)), localDate: TODAY },
    ];
    const status = clockedInStatus({ lastPunch: punches[1], allowed: ['break_end', 'out'], days: { [TODAY]: { workedMin: 0, flags: ['missing_out'], punches } } });
    const vm = deriveMyTime({ status, now: NOW });
    expect(vm.stateLabel).toBe('On Break');
    expect(vm.hours.todayMin).toBe(90);
    expect(vm.actions.map(a => a.label)).toEqual(['End Break', 'Punch Out']);
  });

  it('a finished break is subtracted from the live session, and since still names the clock-in', () => {
    const punches = [
      { kind: 'in', at: stamp(minsAgo(200)), localDate: TODAY },
      { kind: 'break_start', at: stamp(minsAgo(100)), localDate: TODAY },
      { kind: 'break_end', at: stamp(minsAgo(70)), localDate: TODAY },
    ];
    const status = clockedInStatus({ lastPunch: punches[2], days: { [TODAY]: { workedMin: 0, flags: ['missing_out'], punches } } });
    const vm = deriveMyTime({ status, now: NOW });
    expect(vm.hours.todayMin).toBe(170);
    expect(vm.sinceLabel).toBe(`since ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(minsAgo(200))}`);
  });

  it('clocked out: Punch In only, hours from closed segments', () => {
    const status = { lastPunch: { kind: 'out', at: stamp(minsAgo(60)) }, allowed: ['in'], days: { [TODAY]: { workedMin: 125, flags: [] } } };
    const vm = deriveMyTime({ status, now: NOW });
    expect(vm.stateLabel).toBe('Clocked Out');
    expect(vm.sinceLabel).toBe('');
    expect(vm.actions.map(a => a.kind)).toEqual(['in']);
    expect(vm.hours.todayMin).toBe(125);
  });

  it('exempt: no punch controls, no status, hours and time off kept', () => {
    const vm = deriveMyTime({ status: { timeTrackingExempt: true, lastPunch: { kind: 'in', at: stamp(minsAgo(10)) }, days: {} },
      schedule: { timeoff: [{ id: 1, type: 'vacation', startDate: key(3), endDate: key(4), status: 'approved' }] }, now: NOW });
    expect(vm.exempt).toBe(true);
    expect(vm.actions).toEqual([]);
    expect(vm.hours.todayMin).toBe(0);
    expect(vm.timeOff).toHaveLength(1);
    expect(vm.alerts).toEqual([]);
  });

  it('a stale open shift reads as clocked out and raises the Fix a Punch line', () => {
    const status = { lastPunch: { kind: 'in', at: '2026-10-06T15:00:00' }, staleOpenShift: true, staleOpenSince: '2026-10-06T15:00:00', allowed: ['in'], days: {} };
    const vm = deriveMyTime({ status, now: NOW });
    expect(vm.stateLabel).toBe('Clocked Out');
    expect(vm.alerts.map(a => a.id)).toEqual(['stale']);
    expect(vm.alerts[0].action.label).toBe('Fix a Punch');
  });
});

describe('deriveMyTime - hours', () => {
  it('this week sums from Sunday by default and from Monday when the schedule says so', () => {
    // NOW is a Thursday: Sunday is 4 days back, Monday 3.
    const days = { [key(0)]: { workedMin: 60 }, [key(-1)]: { workedMin: 60 }, [key(-2)]: { workedMin: 60 }, [key(-3)]: { workedMin: 60 }, [key(-4)]: { workedMin: 60 }, [key(-5)]: { workedMin: 999 } };
    const status = { lastPunch: { kind: 'out', at: stamp(minsAgo(5)) }, days };
    expect(deriveMyTime({ status, now: NOW }).hours.weekMin).toBe(300);
    expect(deriveMyTime({ status, schedule: { weekStart: 'monday' }, now: NOW }).hours.weekMin).toBe(240);
  });

  it('the pay period comes from the timecard totals plus the live session', () => {
    const card = { periodStart: '2026-10-04', periodEnd: '2026-10-17', totals: { regMin: 1200, otMin: 60, dtMin: 0, sickMin: 480 } };
    const vm = deriveMyTime({ status: clockedInStatus(), card, now: NOW });
    expect(vm.hours.period).toEqual({ min: 1260 + 148, start: '2026-10-04', end: '2026-10-17' });
    expect(deriveMyTime({ status: clockedInStatus(), card: null, now: NOW }).hours.period).toBeNull();
  });
});

describe('deriveMyTime - next shift and time off', () => {
  it('picks the first future published shift, skipping one that already ended today', () => {
    const schedule = { scheduled: [
      { date: key(0), start: '06:00', end: '09:00', label: 'Early' },
      { date: key(3), start: '07:00', end: '15:30', label: 'Open' },
      { date: key(1), start: '09:00', end: '17:00', label: '' },
    ] };
    const vm = deriveMyTime({ status: null, schedule, now: NOW });
    expect(vm.nextShift.date).toBe(key(1));
    expect(vm.nextShift.when).toBe('Tomorrow, 9:00 AM to 5:00 PM');
  });

  it('keeps today\'s shift while it is still running, and formats a later one as weekday + date', () => {
    const schedule = { scheduled: [{ date: key(0), start: '07:00', end: '15:30' }] };
    expect(deriveMyTime({ status: null, schedule, now: NOW }).nextShift.when).toBe('Today, 7:00 AM to 3:30 PM');
    const later = deriveMyTime({ status: null, schedule: { scheduled: [{ date: '2026-10-13', start: '07:00', end: '15:30' }] }, now: NOW });
    expect(later.nextShift.when).toBe('Tue 10/13, 7:00 AM to 3:30 PM');
  });

  it('falls back to the default preset on its next weekday, and hides the line with no schedule data', () => {
    const vm = deriveMyTime({ status: null, schedule: { scheduled: [], shift: { name: 'Day', start: '09:00', end: '17:00', days: '1,2,3,4,5' } }, now: NOW });
    expect(vm.nextShift.fromPreset).toBe(true);
    expect(vm.nextShift.when).toBe('Today, 9:00 AM to 5:00 PM');
    // Friday evening: the preset's next day is Monday.
    const fri = new Date(2026, 9, 9, 18, 0);
    expect(deriveMyTime({ status: null, schedule: { scheduled: [], shift: { start: '09:00', end: '17:00', days: '1,2,3,4,5' } }, now: fri }).nextShift.date).toBe('2026-10-12');
    expect(deriveMyTime({ status: null, schedule: null, now: NOW }).nextShift).toBeNull();
    expect(deriveMyTime({ status: null, schedule: { scheduled: [] }, now: NOW }).nextShift).toBeNull();
  });

  it('lists approved time off and holidays inside 14 days, sorted, and drops pending or distant ones', () => {
    const schedule = {
      timeoff: [
        { id: 1, type: 'vacation', startDate: key(5), endDate: key(7), status: 'approved' },
        { id: 2, type: 'sick', startDate: key(2), endDate: key(2), status: 'pending' },
        { id: 3, type: 'personal', startDate: key(20), endDate: key(20), status: 'approved' },
      ],
      holidays: [{ date: key(1), name: 'Founders Day', type: 'company' }, { date: key(16), name: 'Far Away', type: 'company' }],
    };
    const vm = deriveMyTime({ status: null, schedule, now: NOW });
    expect(vm.timeOff.map(r => r.title)).toEqual(['Founders Day', 'Vacation']);
    expect(vm.timeOff[0].meta).toBe('Company holiday · Tomorrow');
  });
});

describe('deriveMyTime - amber lines', () => {
  const out = { lastPunch: { kind: 'out', at: stamp(minsAgo(60)) }, allowed: ['in'] };
  it('a missing punch on an earlier day asks for a punch fix, counting the extra days', () => {
    const status = { ...out, days: { [key(-2)]: { workedMin: 0, flags: ['missing_out'] }, [key(-1)]: { workedMin: 0, flags: ['missing_break_end'] }, [key(0)]: { workedMin: 60, flags: ['manual'] } } };
    const vm = deriveMyTime({ status, now: NOW });
    expect(vm.alerts).toHaveLength(1);
    expect(vm.alerts[0].text).toMatch(/^Missing clock-out on \d\d\/\d\d\/2026 and 1 more day\.$/);
    expect(vm.alerts[0].action).toEqual({ label: 'Fix a Punch', view: 'timeclock', sub: 'timesheet' });
  });

  it('my time card: signature turn, with the manager, or sent back', () => {
    const base = { status: { ...out, days: {} }, now: NOW };
    expect(deriveMyTime({ ...base, card: { review: { status: 'signing', turn: 'employee' } } }).alerts[0].action.label).toBe('Sign Time Card');
    expect(deriveMyTime({ ...base, card: { review: { status: 'signing', turn: 'manager' } } }).alerts).toEqual([]);
    expect(deriveMyTime({ ...base, card: { review: { status: 'with_manager' } } }).alerts[0].text).toMatch(/with your manager/);
    expect(deriveMyTime({ ...base, card: { review: { status: 'with_employee', rounds: [{ action: 'sent_back' }] } } }).alerts[0].text).toMatch(/sent your time card back/);
    expect(deriveMyTime({ ...base, card: { review: { status: 'not_submitted', rounds: [] } } }).alerts).toEqual([]);
  });

  it('time cards waiting on me as a reviewer', () => {
    const vm = deriveMyTime({ status: { ...out, days: {} }, waiting: { reviews: [{ id: 'a' }, { id: 'b' }] }, now: NOW });
    expect(vm.alerts.map(a => a.text)).toEqual(['2 time cards waiting for your review.']);
    expect(deriveMyTime({ status: null, waiting: { reviews: [] }, now: NOW }).alerts).toEqual([]);
  });

  it('exempt people get no punch alerts', () => {
    const vm = deriveMyTime({ status: { timeTrackingExempt: true, staleOpenShift: true, days: { [key(-1)]: { flags: ['missing_out'] } } }, card: { review: { status: 'with_manager' } }, now: NOW });
    expect(vm.alerts).toEqual([]);
  });
});

describe('dayLabel', () => {
  it('says Today / Tomorrow, then weekday and MM/DD', () => {
    expect(dayLabel(NOW, NOW)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 9), NOW)).toBe('Tomorrow');
    expect(dayLabel(new Date(2026, 9, 13), NOW)).toBe('Tue 10/13');
  });
});

describe('<MyTime /> render', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    apiMock.timeMySchedule.mockResolvedValue({ scheduled: [{ date: key(1), start: '07:00', end: '15:30' }], timeoff: [], holidays: [], weekStart: 'monday' });
    apiMock.timeMyPayroll.mockResolvedValue({ periodStart: '2026-10-04', periodEnd: '2026-10-17', totals: { regMin: 600, otMin: 0, dtMin: 0 }, review: { status: 'not_submitted', rounds: [] } });
    apiMock.timesheetReviewWaiting.mockResolvedValue({ reviews: [] });
    punchMock.readPending.mockReturnValue(null);
    punchMock.replayPending.mockResolvedValue(null);
    punchMock.punchDurable.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('clocked in: status line, hours, next shift, footer; Start Break punches through the durable queue', async () => {
    apiMock.timeStatus.mockResolvedValue(clockedInStatus());
    punchMock.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'break_start' }, result: {} });
    render(<MyTime />);
    expect(await screen.findByText('Clocked In')).toBeTruthy();
    expect(screen.getByText('since 8:02 AM')).toBeTruthy();
    expect(screen.getAllByText('2h 28m')).toHaveLength(2);    // today and this week (nothing else this week)
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('This Week')).toBeTruthy();
    expect(await screen.findByText('Pay Period')).toBeTruthy();
    expect(screen.getByText('12h 28m')).toBeTruthy();         // 600 closed + 148 live
    expect(screen.getByText('Tomorrow, 7:00 AM to 3:30 PM')).toBeTruthy();
    expect(screen.getByText(/Request Time Off/)).toBeTruthy();
    expect(screen.queryByText(/Coming soon/)).toBeNull();

    const changed = vi.fn();
    window.addEventListener('nexus:timeclock-changed', changed);
    fireEvent.click(screen.getByRole('button', { name: /Start Break/ }));
    await waitFor(() => expect(punchMock.punchDurable).toHaveBeenCalledTimes(1));
    expect(punchMock.punchDurable.mock.calls[0][0]).toMatchObject({ kind: 'break_start', pos: { lat: 1, lng: 2 } });
    await waitFor(() => expect(changed).toHaveBeenCalled());
    window.removeEventListener('nexus:timeclock-changed', changed);
  });

  it('clocked out: Punch In hands off to the Time Clock screen instead of punching here', async () => {
    apiMock.timeStatus.mockResolvedValue({ lastPunch: { kind: 'out', at: stamp(minsAgo(30)) }, allowed: ['in'], days: {} });
    render(<MyTime />);
    expect((await screen.findAllByText('Clocked Out')).length).toBeGreaterThan(0);   // the status line and the card subtitle
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    fireEvent.click(screen.getByRole('button', { name: /Punch In/ }));
    expect(nav).toHaveBeenCalledTimes(1);
    expect(nav.mock.calls[0][0].detail).toEqual({ view: 'timeclock', sub: 'overview' });
    expect(punchMock.punchDurable).not.toHaveBeenCalled();
    window.removeEventListener('nexus:navigate', nav);
  });

  it('Punch Out that the server asks to follow with an end-of-day message opens the EOD modal', async () => {
    apiMock.timeStatus.mockResolvedValue(clockedInStatus());
    punchMock.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'out' }, result: { promptEod: true } });
    render(<MyTime />);
    fireEvent.click(await screen.findByRole('button', { name: /Punch Out/ }));
    expect(await screen.findByTestId('bod-modal')).toHaveTextContent('eod');
    expect(punchMock.punchDurable.mock.calls[0][0].kind).toBe('out');
  });

  it('a refused punch shows the server\'s words inline; an unreachable one says it is parked', async () => {
    apiMock.timeStatus.mockResolvedValue(clockedInStatus());
    punchMock.punchDurable.mockResolvedValueOnce({ ok: false, error: { status: 409, message: 'Already on a break.' } });
    render(<MyTime />);
    fireEvent.click(await screen.findByRole('button', { name: /Start Break/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Already on a break.');
    punchMock.punchDurable.mockResolvedValueOnce({ ok: false, unreachable: true, queued: true, error: {} });
    fireEvent.click(screen.getByRole('button', { name: /Start Break/ }));
    expect(await screen.findByText(/saved on this device/)).toBeTruthy();
  });

  it('exempt: no punch buttons or status, time off and the footer stay', async () => {
    apiMock.timeStatus.mockResolvedValue({ timeTrackingExempt: true, days: {} });
    apiMock.timeMySchedule.mockResolvedValue({ scheduled: [], timeoff: [{ id: 9, type: 'vacation', startDate: key(2), endDate: key(3), status: 'approved' }], holidays: [] });
    render(<MyTime />);
    expect(await screen.findByText(/not required for your role/)).toBeTruthy();
    expect(await screen.findByText('Vacation')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Punch/ })).toBeNull();
    expect(screen.queryByText('Clocked Out')).toBeNull();
    expect(screen.getByText(/Request Time Off/)).toBeTruthy();
  });

  it('amber lines render with their action, and a failed status call never blanks the tile', async () => {
    apiMock.timeStatus.mockResolvedValue({ lastPunch: { kind: 'out', at: stamp(minsAgo(30)) }, allowed: ['in'], days: { [key(-1)]: { workedMin: 0, flags: ['missing_out'] } } });
    apiMock.timeMyPayroll.mockResolvedValue({ periodStart: '2026-10-04', totals: { regMin: 0 }, review: { status: 'signing', turn: 'employee' } });
    const { unmount } = render(<MyTime />);
    expect(await screen.findByText(/Missing clock-out on/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Sign Time Card/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Fix a Punch/ })).toBeTruthy();
    unmount();

    apiMock.timeStatus.mockRejectedValue(new Error('boom'));
    apiMock.timeMySchedule.mockResolvedValue(null);
    apiMock.timeMyPayroll.mockResolvedValue(null);
    render(<MyTime />);
    expect(await screen.findByText(/Could not load your time right now/)).toBeTruthy();
    expect(screen.getByText(/Request Time Off/)).toBeTruthy();
  });
});
