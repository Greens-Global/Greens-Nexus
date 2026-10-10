import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Time on a task (Oct 2026): start and stop a timer through the store, log
// typed-in minutes, and the helpers behind the durations and the weekly sheet.

const calls = { add: vi.fn(), del: vi.fn(), upd: vi.fn() };
let serverEntries = [];
vi.mock('../api', () => ({
  api: {
    getTaskTime: () => Promise.resolve(serverEntries),
    addTaskTime: (...a) => calls.add(...a),
    deleteTaskTime: (...a) => calls.del(...a),
    updateTaskTime: (...a) => calls.upd(...a),
    getPeopleDirectory: () => Promise.resolve([]),
    getPersonPhotos: () => Promise.resolve({}),
  },
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set() }) }));
const store = { runningTimer: null, startTimer: vi.fn(), stopTimer: vi.fn(), applyServerTask: vi.fn(), nameOf: (e) => e, myEmail: 'me@greensglobal.com' };
vi.mock('./TasksContext', () => ({ useTasks: () => store }));

const TimeTracking = (await import('./TimeTracking')).default;
const { fmtMinutes, fmtElapsed, groupTimeByDay } = await import('./lib');
const { weekStart } = await import('./TimeSheetView');

const task = { id: 't1', title: 'Fix the pump', estimateHours: 2, actualHours: 0.5 };

describe('TimeTracking', () => {
  beforeEach(() => {
    serverEntries = [];
    Object.values(calls).forEach((f) => f.mockReset());
    store.startTimer.mockReset(); store.stopTimer.mockReset(); store.applyServerTask.mockReset();
    store.runningTimer = null;
  });

  it('shows estimate, tracked and a Start Timer button, and starts through the store', async () => {
    store.startTimer.mockResolvedValue({});
    render(<TimeTracking task={task} />);
    expect(await screen.findByText('No time logged yet.')).toBeInTheDocument();
    expect(screen.getByText('2h')).toBeInTheDocument();
    expect(screen.getByText('30m')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start Timer/ })); });
    expect(store.startTimer).toHaveBeenCalledWith('t1');
  });

  it('a timer running here shows elapsed time and Stop; running elsewhere offers Switch', async () => {
    store.runningTimer = { entry: { id: 'e1', taskId: 't1', startedAt: new Date(Date.now() - 65_000).toISOString(), running: true }, task };
    store.stopTimer.mockResolvedValue({});
    const { unmount } = render(<TimeTracking task={task} />);
    await screen.findByText('No time logged yet.');
    expect(screen.getByText(/00:01:0\d/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Timer note'), { target: { value: 'wiring' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Stop/ })); });
    expect(store.stopTimer).toHaveBeenCalledWith({ note: 'wiring' });
    unmount();
    store.runningTimer = { entry: { id: 'e2', taskId: 'other', startedAt: new Date().toISOString() }, task: { id: 'other', title: 'Other job' } };
    render(<TimeTracking task={task} />);
    expect(await screen.findByRole('button', { name: /Switch Timer Here/ })).toBeInTheDocument();
    expect(screen.getByText(/running on "Other job"/)).toBeInTheDocument();
  });

  it('logs typed minutes and hands the task back to the store', async () => {
    calls.add.mockResolvedValue({ entry: { id: 'e9', minutes: 90, note: 'calls', startedAt: '2026-10-10T12:00:00Z', personId: 'me@greensglobal.com' }, task: { ...task, actualHours: 2, timeEntryCount: 1 } });
    render(<TimeTracking task={task} />);
    await screen.findByText('No time logged yet.');
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'calls' } });
    serverEntries = [{ id: 'e9', minutes: 90, note: 'calls', startedAt: '2026-10-10T12:00:00Z', personId: 'me@greensglobal.com' }];
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Log Time' })); });
    expect(calls.add).toHaveBeenCalledWith('t1', expect.objectContaining({ minutes: 90, note: 'calls' }));
    expect(store.applyServerTask).toHaveBeenCalledWith(expect.objectContaining({ timeEntryCount: 1 }));
    await waitFor(() => expect(screen.getByText('1h 30m')).toBeInTheDocument());
  });

  it('a viewer sees the totals and entries but no controls', async () => {
    serverEntries = [{ id: 'e1', minutes: 20, note: '', source: 'timer', startedAt: '2026-10-10T12:00:00Z', personId: 'x@greensglobal.com' }];
    render(<TimeTracking task={task} canLog={false} />);
    expect(await screen.findByText('20m')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start Timer/ })).toBeNull();
    expect(screen.queryByLabelText('Hours')).toBeNull();
  });
});

describe('time helpers', () => {
  it('formats minutes and elapsed time', () => {
    expect(fmtMinutes(0)).toBe('0m');
    expect(fmtMinutes(45)).toBe('45m');
    expect(fmtMinutes(60)).toBe('1h');
    expect(fmtMinutes(65)).toBe('1h 05m');
    const start = new Date('2026-10-10T10:00:00Z');
    expect(fmtElapsed(start.toISOString(), start.getTime() + 3_725_000)).toBe('01:02:05');
  });

  it('groups entries by local day, newest first, with totals', () => {
    const g = groupTimeByDay([
      { id: 'a', minutes: 30, startedAt: '2026-10-08T15:00:00' },
      { id: 'b', minutes: 15, startedAt: '2026-10-10T09:00:00' },
      { id: 'c', minutes: 45, startedAt: '2026-10-08T09:00:00' },
    ]);
    expect(g.map((x) => [x.day, x.minutes, x.entries.length])).toEqual([['2026-10-10', 15, 1], ['2026-10-08', 75, 2]]);
  });

  it('finds the Monday of a week', () => {
    expect(weekStart(new Date(2026, 9, 10)).getDay()).toBe(1);        // Sat Oct 10 2026 -> Mon Oct 5
    expect(weekStart(new Date(2026, 9, 10)).getDate()).toBe(5);
    expect(weekStart(new Date(2026, 9, 5)).getDate()).toBe(5);        // a Monday stays
  });
});
