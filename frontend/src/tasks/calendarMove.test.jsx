// Calendar drag and the batch bar's Dates action (Neil, Oct 22 2026).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  bulkDatesSummary, calendarMovePatch, canMoveOnCalendar, daysBetween, movedLabel, previousDates, undoEntryAt, wasSentForApproval,
} from './calendarMove';
import { CalendarView } from './views/extras';
import BulkActionBar from './BulkActionBar';

vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ canAccessModule: () => false }) }));
vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../api', () => ({ api: { getPeopleDirectory: () => Promise.resolve([]) } }));

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => { vi.useRealTimers(); process.env.TZ = ORIGINAL_TZ; });
beforeEach(() => {
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
});

describe('calendarMovePatch', () => {
  it('moves the due date and keeps the length by moving the start too', () => {
    const t = { id: 'a', startOn: '2026-10-20', dueOn: '2026-10-22' };
    expect(calendarMovePatch(t, '2026-10-24')).toEqual({ dueOn: '2026-10-24', startOn: '2026-10-22' });
  });

  it('crosses month and year boundaries both ways', () => {
    expect(calendarMovePatch({ startOn: '2026-10-29', dueOn: '2026-10-31' }, '2026-11-02'))
      .toEqual({ dueOn: '2026-11-02', startOn: '2026-10-31' });
    expect(calendarMovePatch({ startOn: '2027-01-01', dueOn: '2027-01-03' }, '2026-12-30'))
      .toEqual({ dueOn: '2026-12-30', startOn: '2026-12-28' });
  });

  it('sends only the due date for a task without a start, and nothing for the same day', () => {
    expect(calendarMovePatch({ dueOn: '2026-10-22' }, '2026-10-23')).toEqual({ dueOn: '2026-10-23' });
    expect(calendarMovePatch({ dueOn: '2026-10-22' }, '2026-10-22')).toBeNull();
    expect(calendarMovePatch({ dueOn: '' }, '2026-10-22')).toBeNull();
  });

  it('never touches a recurring rule', () => {
    const t = { dueOn: '2026-10-26', recurrence: { freq: 'weekly', daysOfWeek: [1] } };
    expect(Object.keys(calendarMovePatch(t, '2026-10-28'))).toEqual(['dueOn']);
  });

  it('counts local days, not UTC ones, across a daylight-saving change', () => {
    for (const tz of ['America/Los_Angeles', 'Asia/Kolkata', 'Europe/London']) {
      process.env.TZ = tz;
      expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2);     // US clocks change 11/01
      expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
      expect(calendarMovePatch({ startOn: '2026-10-30', dueOn: '2026-10-31' }, '2026-11-03'))
        .toEqual({ dueOn: '2026-11-03', startOn: '2026-11-02' });
    }
  });

  it('Undo puts back exactly the dates it moved', () => {
    const t = { startOn: '2026-10-20', dueOn: '2026-10-22' };
    expect(previousDates(t, { dueOn: 'x', startOn: 'y' })).toEqual({ dueOn: '2026-10-22', startOn: '2026-10-20' });
    expect(movedLabel({ dueOn: '2026-10-24' })).toBe('Moved to 10/24/2026');
  });

  it('finds the history entry an Undo names', () => {
    const saved = { dueHistory: [{ at: 'T0', to: '2026-10-20' }, { at: 'T1', to: '2026-11-02', undo: {} }] };
    expect(undoEntryAt(saved, { dueOn: '2026-11-02' })).toBe('T1');
    expect(undoEntryAt(saved, { dueOn: '2026-11-03' })).toBe('');
    expect(undoEntryAt({ dueHistory: [{ at: 'T0', to: '2026-11-02' }] }, { dueOn: '2026-11-02' })).toBe('');
  });

  it('knows a move the server held for approval', () => {
    const patch = { dueOn: '2026-11-02' };
    expect(wasSentForApproval({ dueOn: '2026-10-30', dueAgreement: 'extension_requested', dueProposal: { dueOn: '2026-11-02' } }, patch)).toBe(true);
    expect(wasSentForApproval({ dueOn: '2026-11-02', dueAgreement: 'accepted' }, patch)).toBe(false);
  });
});

describe('canMoveOnCalendar', () => {
  const projects = [{ id: 'p', accessLevel: 'restricted', memberIds: ['v@x.com', 'e@x.com'], memberRoles: { 'v@x.com': 'viewer', 'e@x.com': 'editor' } }];
  const task = { id: 'a', projectId: 'p', dueOn: '2026-10-22' };
  it('an editor may, a viewer may not, and a completed task stays put', () => {
    expect(canMoveOnCalendar(task, { projects, email: 'e@x.com' })).toBe(true);
    expect(canMoveOnCalendar(task, { projects, email: 'v@x.com' })).toBe(false);
    expect(canMoveOnCalendar({ ...task, completed: true }, { projects, email: 'e@x.com' })).toBe(false);
    expect(canMoveOnCalendar(task, { projects, email: 'v@x.com', isManager: true })).toBe(true);
  });
});

describe('bulkDatesSummary', () => {
  it('says what moved, what was skipped and what waits', () => {
    expect(bulkDatesSummary('shift', { changed: 3, skipped: 2, sentForApproval: 1 }, -2))
      .toBe('Moved 3 tasks 2 days earlier - 2 without a due date skipped - 1 sent for approval');
    expect(bulkDatesSummary('shift', { changed: 1 }, 1)).toBe('Moved 1 task 1 day later');
    expect(bulkDatesSummary('clear_due', { changed: 4 })).toBe('Cleared the due date on 4 tasks');
    expect(bulkDatesSummary('set_due', { changed: 2 })).toBe('Set the due date on 2 tasks');
    expect(bulkDatesSummary('shift', { changed: 1, blocked: 2 }, 3)).toBe('Moved 1 task 3 days later - 2 not moved');
  });
});

describe('CalendarView drag', () => {
  const editorProject = { id: 'p', accessLevel: 'org' };
  const viewerProject = { id: 'v', accessLevel: 'restricted', memberIds: ['me@x.com'], memberRoles: { 'me@x.com': 'viewer' } };
  const tasks = [
    { id: 'a', title: 'Pour Footings', projectId: 'p', startOn: '2026-10-12', dueOn: '2026-10-14', status: 'not_started' },
    { id: 'b', title: 'Read Only', projectId: 'v', dueOn: '2026-10-14', status: 'not_started' },
  ];
  const setup = (saved) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 15, 10, 0, 0));   // Oct 15 2026, local
    const store = {
      projects: [editorProject, viewerProject], teams: [], taskById: Object.fromEntries(tasks.map((t) => [t.id, t])),
      myEmail: 'me@x.com',
      updateTask: vi.fn((id, patch) => Promise.resolve(saved ? saved(id, patch) : { ...tasks[0], ...patch })),
      offerUndo: vi.fn(),
    };
    render(<CalendarView tasks={tasks} store={store} onOpen={vi.fn()} />);
    return store;
  };
  const drop = async (title, iso) => {
    const chip = screen.getByText(title).closest('button');
    const cell = document.querySelector(`[data-day="${iso}"]`);
    fireEvent.dragStart(chip);
    fireEvent.dragOver(cell);
    await act(async () => { fireEvent.drop(cell); });
  };

  it('dropping on another day moves due and start together and offers Undo', async () => {
    const store = setup();
    await drop('Pour Footings', '2026-10-24');
    expect(store.updateTask).toHaveBeenCalledWith('a', { dueOn: '2026-10-24', startOn: '2026-10-22' });
    expect(store.offerUndo).toHaveBeenCalledTimes(1);
    expect(store.offerUndo.mock.calls[0][0]).toBe('Moved to 10/24/2026');
    store.offerUndo.mock.calls[0][1]();
    expect(store.updateTask).toHaveBeenLastCalledWith('a', { dueOn: '2026-10-14', startOn: '2026-10-12' });
  });

  it('Undo takes the move out on the server when the move left a history entry', async () => {
    const store = setup((id, patch) => ({ ...tasks[0], ...patch, dueHistory: [{ at: 'T1', from: '2026-10-14', to: '2026-10-24', undo: {} }] }));
    store.undoDueChange = vi.fn(() => Promise.resolve({}));
    await drop('Pour Footings', '2026-10-24');
    store.offerUndo.mock.calls[0][1]();
    expect(store.undoDueChange).toHaveBeenCalledWith('a', 'T1');
    expect(store.updateTask).toHaveBeenCalledTimes(1);
  });

  it('a refused move (a repeating task before its previous occurrence) offers no Undo', async () => {
    const store = setup();
    store.updateTask.mockImplementationOnce(() => Promise.reject(Object.assign(new Error("A repeating task can't move on or before its previous occurrence (10/12/2026)."), { status: 422 })));
    await drop('Pour Footings', '2026-10-10');
    expect(store.updateTask).toHaveBeenCalled();
    expect(store.offerUndo).not.toHaveBeenCalled();
  });

  it('highlights the day being dragged over', () => {
    setup();
    const cell = document.querySelector('[data-day="2026-10-20"]');
    fireEvent.dragStart(screen.getByText('Pour Footings').closest('button'));
    fireEvent.dragOver(cell);
    expect(cell.style.boxShadow).toContain('inset');
  });

  it('a move held for approval offers no Moved toast (the store says it was sent)', async () => {
    const store = setup(() => ({ ...tasks[0], dueAgreement: 'extension_requested', dueProposal: { dueOn: '2026-10-24' } }));
    await drop('Pour Footings', '2026-10-24');
    expect(store.updateTask).toHaveBeenCalled();
    expect(store.offerUndo).not.toHaveBeenCalled();
  });

  it('a viewer cannot drag, and dropping on the same day does nothing', async () => {
    const store = setup();
    expect(screen.getByText('Read Only').closest('button').getAttribute('draggable')).toBeNull();
    expect(screen.getByText('Pour Footings').closest('button').getAttribute('draggable')).toBe('true');
    await drop('Pour Footings', '2026-10-14');
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it('Shift+F10 opens Move To Date for keyboard users', () => {
    setup();
    fireEvent.keyDown(screen.getByText('Pour Footings').closest('button'), { key: 'F10', shiftKey: true });
    expect(screen.getAllByText('Move To Date').length).toBeGreaterThan(0);
  });

  it('without a store the calendar is read-only, as before', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 15, 10, 0, 0));
    render(<CalendarView tasks={tasks} onOpen={vi.fn()} />);
    expect(screen.getByText('Pour Footings').closest('button').getAttribute('draggable')).toBeNull();
  });
});

describe('BulkActionBar - Dates', () => {
  const tasks = [
    { id: 'a', title: 'A', dueOn: '2026-10-22' },
    { id: 'b', title: 'B', dueOn: '' },
  ];
  const renderBar = () => {
    const clearSel = vi.fn();
    const store = {
      tasks, customFields: [], bulkUpdate: vi.fn(), deleteTask: vi.fn(),
      statusOrder: ['not_started'], statusMeta: { not_started: { label: 'Not Started' } }, projects: [],
      bulkDates: vi.fn(() => Promise.resolve({ tasks: [], changed: 1, skipped: 1, sentForApproval: 0 })),
      notify: vi.fn(),
    };
    render(<BulkActionBar selected={new Set(['a', 'b'])} clearSel={clearSel} store={store} people={[]} />);
    return { store, clearSel };
  };

  it('shifts by N days with Skip Weekends and reports what was skipped', async () => {
    const { store, clearSel } = renderBar();
    fireEvent.click(screen.getByText('Dates…'));
    expect(screen.getByText('Change Dates on 2 Tasks')).toBeTruthy();
    expect(screen.getByText(/1 without a due date will be skipped/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Days'), { target: { value: '-2' } });
    fireEvent.click(screen.getByLabelText('Skip Weekends'));
    await act(async () => { fireEvent.click(screen.getByText('Apply')); });
    expect(store.bulkDates).toHaveBeenCalledWith(['a', 'b'], { op: 'shift', days: -2, skip_weekends: true });
    expect(store.notify).toHaveBeenCalledWith('Moved 1 task 2 days earlier - 1 without a due date skipped');
    expect(clearSel).toHaveBeenCalled();
  });

  it('a zero shift cannot be applied; Clear Due Date sends just the op', async () => {
    const { store } = renderBar();
    fireEvent.click(screen.getByText('Dates…'));
    fireEvent.change(screen.getByLabelText('Days'), { target: { value: '0' } });
    expect(screen.getByText('Apply').disabled).toBe(true);
    fireEvent.click(screen.getByText('Clear Due Date'));
    await act(async () => { fireEvent.click(screen.getByText('Apply')); });
    expect(store.bulkDates).toHaveBeenCalledWith(['a', 'b'], { op: 'clear_due' });
  });

  it('says which tasks were left alone and why', async () => {
    const { store } = renderBar();
    store.bulkDates.mockResolvedValueOnce({ tasks: [], changed: 1, skipped: 0, blocked: 1,
      blockedTasks: [{ id: 'a', title: 'A', code: 'series', reason: "A repeating task can't move on or before its previous occurrence (10/12/2026)." }] });
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    fireEvent.click(screen.getByText('Dates…'));
    await act(async () => { fireEvent.click(screen.getByText('Apply')); });
    expect(store.notify).toHaveBeenCalledWith('Moved 1 task 1 day later - 1 not moved');
    expect(alert.mock.calls[0][0]).toContain('"A": A repeating task can\'t move on or before its previous occurrence (10/12/2026).');
    alert.mockRestore();
  });

  it('Set Due Date waits for a date', () => {
    renderBar();
    fireEvent.click(screen.getByText('Dates…'));
    fireEvent.click(screen.getByText('Set Due Date'));
    expect(screen.getByText('Apply').disabled).toBe(true);
  });
});
