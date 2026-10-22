// The Calendar's Unscheduled pane (Neil, Oct 22 2026; Microsoft Planner parity).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import {
  calendarDatePatch, clearingStopsSeries, datesLabel, schedulePatch, SERIES_NEEDS_DUE, unscheduledTasks,
} from './calendarMove';
import { EMPTY_FILTER, matchesFilter, personScoped } from './lib';
import { CalendarView } from './views/extras';
import { UNSCHEDULED_CAP } from './views/UnscheduledPane';

vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ canAccessModule: () => false }) }));
vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../api', () => ({ api: { getPeopleDirectory: () => Promise.resolve([]) } }));

const ORIGINAL_TZ = process.env.TZ;
const viewport = (phone) => {
  globalThis.matchMedia = (q) => ({
    matches: !!phone && q.includes('max-width: 640px'), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
};
beforeEach(() => { viewport(false); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); process.env.TZ = ORIGINAL_TZ; vi.restoreAllMocks(); });

const editorProject = { id: 'p', name: 'Escondido Build', accessLevel: 'org' };
const viewerProject = { id: 'v', name: 'Read Only Project', accessLevel: 'restricted', memberIds: ['me@x.com'], memberRoles: { 'me@x.com': 'viewer' } };

const base = [
  { id: 'a', title: 'Pour Footings', projectId: 'p', startOn: '2026-10-12', dueOn: '2026-10-14', status: 'not_started' },
  { id: 'u1', title: 'Order Rebar', projectId: 'p', dueOn: '', priority: 'low', createdAt: '2026-10-01T10:00:00Z', status: 'not_started', assigneeIds: ['me@x.com'] },
  { id: 'u2', title: 'Call Inspector', projectId: 'p', dueOn: '', priority: 'urgent', createdAt: '2026-09-01T10:00:00Z', status: 'not_started' },
  { id: 'u3', title: 'Pick Tile', projectId: 'p', startOn: '2026-10-28', priority: 'high', createdAt: '2026-10-02T10:00:00Z', status: 'not_started' },
  { id: 'ro', title: 'Viewer Only Task', projectId: 'v', dueOn: '', status: 'not_started' },
  { id: 'done', title: 'Already Done', projectId: 'p', dueOn: '', completed: true, status: 'completed' },
];

function setup({ tasks = base, saved, lockedProjectId = null, notify = true } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 15, 10, 0, 0));   // Oct 15 2026, local
  const store = {
    projects: [editorProject, viewerProject], teams: [], taskById: Object.fromEntries(tasks.map((t) => [t.id, t])),
    myEmail: 'me@x.com', nameOf: (e) => e,
    updateTask: vi.fn((id, patch) => Promise.resolve(saved ? saved(id, patch) : { ...tasks.find((t) => t.id === id), ...patch })),
    offerUndo: vi.fn(),
    ...(notify ? { notify: vi.fn() } : {}),
  };
  const onOpen = vi.fn();
  const utils = render(<CalendarView tasks={tasks} store={store} onOpen={onOpen} lockedProjectId={lockedProjectId} />);
  return { store, onOpen, ...utils };
}
const pane = () => screen.getByTestId('unscheduled-pane');
const rowOf = (title) => within(pane()).getByText(title).closest('[data-unscheduled]');
const dropOnDay = async (el, iso) => {
  const cell = document.querySelector(`[data-day="${iso}"]`);
  fireEvent.dragStart(el);
  fireEvent.dragOver(cell);
  await act(async () => { fireEvent.drop(cell); });
};

describe('unscheduledTasks', () => {
  it('lists open tasks with no due date: Urgent first, then the newest', () => {
    const { all, rows } = unscheduledTasks(base);
    expect(all.map((t) => t.id)).toEqual(['u2', 'u3', 'u1', 'ro']);
    expect(rows).toEqual(all);
  });

  it('leaves out completed and dated tasks, and the search narrows by title', () => {
    const { all, rows } = unscheduledTasks(base, '  rebar ');
    expect(all.some((t) => t.id === 'done' || t.id === 'a')).toBe(false);
    expect(rows.map((t) => t.id)).toEqual(['u1']);
  });

  it('is the calendar\'s own set: a project scope keeps subtasks out, a person scope lists them', () => {
    const parent = { id: 'par', title: 'Framing', projectId: 'p', dueOn: '', status: 'not_started', subtaskIds: ['sub'] };
    const sub = { id: 'sub', title: 'Order Studs', parentTaskId: 'par', dueOn: '', status: 'not_started', assigneeIds: ['me@x.com'] };
    const all = [parent, sub];
    const taskById = { par: parent, sub };
    const calendarSet = (f) => personScoped(all, f).filter((t) => matchesFilter(t, f, taskById));
    const projectScope = { ...EMPTY_FILTER, projectIds: ['p'] };
    const personScope = { ...EMPTY_FILTER, assigneeIds: ['me@x.com'] };
    expect(unscheduledTasks(calendarSet(projectScope)).all.map((t) => t.id)).toEqual(['par']);
    expect(unscheduledTasks(calendarSet(personScope)).all.map((t) => t.id)).toEqual(['sub']);
  });
});

describe('calendarDatePatch', () => {
  it('schedules an undated task on the day, and a later start comes back to it', () => {
    expect(schedulePatch({ dueOn: '' }, '2026-10-24')).toEqual({ dueOn: '2026-10-24' });
    expect(schedulePatch({ startOn: '2026-10-20' }, '2026-10-24')).toEqual({ dueOn: '2026-10-24' });
    expect(schedulePatch({ startOn: '2026-10-28' }, '2026-10-24')).toEqual({ dueOn: '2026-10-24', startOn: '2026-10-24' });
    expect(schedulePatch({ dueOn: '2026-10-22' }, '2026-10-24')).toBeNull();
  });

  it('an empty day clears the due date and keeps the start; a dated task still moves', () => {
    expect(calendarDatePatch({ dueOn: '2026-10-22', startOn: '2026-10-20' }, '')).toEqual({ dueOn: '' });
    expect(calendarDatePatch({ dueOn: '' }, '')).toBeNull();
    expect(calendarDatePatch({ startOn: '2026-10-20', dueOn: '2026-10-22' }, '2026-10-24')).toEqual({ dueOn: '2026-10-24', startOn: '2026-10-22' });
  });

  it('knows the live occurrence of a repeating series must keep its date', () => {
    const live = { dueOn: '2026-10-22', recurrence: { freq: 'weekly' } };
    expect(clearingStopsSeries(live)).toBe(true);
    expect(clearingStopsSeries({ ...live, completed: true })).toBe(false);
    expect(clearingStopsSeries({ ...live, recurrence: { freq: 'weekly', nextOccurrenceId: 'n' } })).toBe(false);
    expect(clearingStopsSeries({ ...live, recurrence: { freq: 'weekly', closedAsMissed: 'x' } })).toBe(false);
    expect(clearingStopsSeries({ dueOn: '2026-10-22', recurrence: { freq: 'none' } })).toBe(false);
  });

  it('says what happened', () => {
    expect(datesLabel({ dueOn: '' }, { dueOn: '2026-10-24' })).toBe('Scheduled for 10/24/2026');
    expect(datesLabel({ dueOn: '2026-10-22' }, { dueOn: '2026-10-24' })).toBe('Moved to 10/24/2026');
    expect(datesLabel({ dueOn: '2026-10-22' }, { dueOn: '' })).toBe('Due date removed');
  });
});

describe('Unscheduled pane on the calendar', () => {
  it('shows the count, the rows in order and no completed or dated task', () => {
    setup();
    expect(within(pane()).getByLabelText('4 unscheduled')).toBeTruthy();
    const titles = [...pane().querySelectorAll('[data-unscheduled]')].map((r) => r.getAttribute('data-unscheduled'));
    expect(titles).toEqual(['u2', 'u3', 'u1', 'ro']);
    expect(within(pane()).queryByText('Already Done')).toBeNull();
    expect(within(pane()).queryByText('Pour Footings')).toBeNull();
    // The project pill shows outside a project, not inside one.
    expect(within(rowOf('Order Rebar')).getByText('Escondido Build')).toBeTruthy();
  });

  it('hides the project pill inside a project', () => {
    setup({ lockedProjectId: 'p' });
    expect(within(rowOf('Order Rebar')).queryByText('Escondido Build')).toBeNull();
  });

  it('takes only the tasks the calendar was handed', () => {
    setup({ tasks: base.filter((t) => t.id !== 'u2') });
    expect(within(pane()).queryByText('Call Inspector')).toBeNull();
    expect(within(pane()).getByLabelText('3 unscheduled')).toBeTruthy();
  });

  it('clicking a row opens the task', () => {
    const { onOpen } = setup();
    fireEvent.click(rowOf('Order Rebar'));
    expect(onOpen).toHaveBeenCalledWith('u1');
  });

  it('dropping a row on a day sets that LOCAL day through the shared path, with Undo', async () => {
    process.env.TZ = 'America/Los_Angeles';
    const { store } = setup();
    vi.setSystemTime(new Date(2026, 9, 15, 23, 30, 0));   // late evening: already the 16th in UTC
    await dropOnDay(rowOf('Order Rebar'), '2026-10-24');
    expect(store.updateTask).toHaveBeenCalledWith('u1', { dueOn: '2026-10-24' });
    expect(store.offerUndo.mock.calls[0][0]).toBe('Scheduled for 10/24/2026');
    store.offerUndo.mock.calls[0][1]();
    expect(store.updateTask).toHaveBeenLastCalledWith('u1', { dueOn: '' });
  });

  it('a start after the dropped day comes back to it, and Undo puts both back', async () => {
    const { store } = setup();
    await dropOnDay(rowOf('Pick Tile'), '2026-10-24');
    expect(store.updateTask).toHaveBeenCalledWith('u3', { dueOn: '2026-10-24', startOn: '2026-10-24' });
    store.offerUndo.mock.calls[0][1]();
    expect(store.updateTask).toHaveBeenLastCalledWith('u3', { dueOn: '', startOn: '2026-10-28' });
  });

  it('a date held for approval says nothing more (the store already did)', async () => {
    const { store } = setup({ saved: (id) => ({ ...base.find((t) => t.id === id), dueOn: '', dueAgreement: 'extension_requested', dueProposal: { dueOn: '2026-10-24' } }) });
    await dropOnDay(rowOf('Order Rebar'), '2026-10-24');
    expect(store.updateTask).toHaveBeenCalled();
    expect(store.offerUndo).not.toHaveBeenCalled();
  });

  it('Undo takes the scheduling out on the server when it left a history entry', async () => {
    const { store } = setup({ saved: (id, patch) => ({ ...base.find((t) => t.id === id), ...patch, dueHistory: [{ at: 'T9', from: '', to: '2026-10-24', undo: {} }] }) });
    store.undoDueChange = vi.fn(() => Promise.resolve({}));
    await dropOnDay(rowOf('Order Rebar'), '2026-10-24');
    store.offerUndo.mock.calls[0][1]();
    expect(store.undoDueChange).toHaveBeenCalledWith('u1', 'T9');
  });

  it('dropping a dated chip on the pane clears its due date through the same path', async () => {
    const { store } = setup();
    const chip = screen.getByText('Pour Footings').closest('button');
    fireEvent.dragStart(chip);
    expect(within(pane()).getByText('Drop here to remove the due date')).toBeTruthy();
    fireEvent.dragOver(pane());
    expect(pane().style.boxShadow).toContain('inset');
    await act(async () => { fireEvent.drop(pane()); });
    expect(store.updateTask).toHaveBeenCalledWith('a', { dueOn: '' });
    expect(store.offerUndo.mock.calls[0][0]).toBe('Due date removed');
    store.offerUndo.mock.calls[0][1]();
    expect(store.updateTask).toHaveBeenLastCalledWith('a', { dueOn: '2026-10-14' });
  });

  it('a repeating task dropped on the pane is refused with the server\'s words', async () => {
    const tasks = [...base, { id: 'rep', title: 'Weekly Walkthrough', projectId: 'p', dueOn: '2026-10-14', recurrence: { freq: 'weekly' }, status: 'not_started' }];
    const { store } = setup({ tasks });
    fireEvent.dragStart(screen.getByText('Weekly Walkthrough').closest('button'));
    fireEvent.dragOver(pane());
    await act(async () => { fireEvent.drop(pane()); });
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.notify).toHaveBeenCalledWith(SERIES_NEEDS_DUE);
  });

  it('a server refusal offers no Undo', async () => {
    const { store } = setup();
    store.updateTask.mockImplementationOnce(() => Promise.reject(Object.assign(new Error(SERIES_NEEDS_DUE), { status: 422 })));
    fireEvent.dragStart(screen.getByText('Pour Footings').closest('button'));
    fireEvent.dragOver(pane());
    await act(async () => { fireEvent.drop(pane()); });
    expect(store.updateTask).toHaveBeenCalled();
    expect(store.offerUndo).not.toHaveBeenCalled();
  });

  it('the Schedule button picks a day in the shared calendar (never a native date box)', async () => {
    const { store } = setup();
    const row = rowOf('Call Inspector');
    expect(row.querySelector('input[type="date"]')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Schedule' }));
    const cal = document.querySelector('[data-nx-calendar]');
    await act(async () => { fireEvent.click(within(cal).getByText('24')); });
    expect(store.updateTask).toHaveBeenCalledWith('u2', { dueOn: '2026-10-24' });
  });

  it('a read-only person sees the row with no drag and no Schedule button', () => {
    setup();
    const ro = rowOf('Viewer Only Task');
    expect(ro.getAttribute('draggable')).toBeNull();
    expect(within(ro).queryByRole('button', { name: 'Schedule' })).toBeNull();
    const ed = rowOf('Order Rebar');
    expect(ed.getAttribute('draggable')).toBe('true');
    expect(within(ed).getByRole('button', { name: 'Schedule' })).toBeTruthy();
  });

  it('the pane takes no drop from a chip the person cannot change', () => {
    const tasks = [...base, { id: 'rod', title: 'Viewer Dated', projectId: 'v', dueOn: '2026-10-14', status: 'not_started' }];
    setup({ tasks });
    fireEvent.dragStart(screen.getByText('Viewer Dated').closest('button'));
    expect(within(pane()).queryByText('Drop here to remove the due date')).toBeNull();
  });

  it('caps the rows drawn and the search narrows them', () => {
    const many = Array.from({ length: UNSCHEDULED_CAP + 50 }, (_, i) => ({ id: `m${i}`, title: `Task ${i}`, projectId: 'p', dueOn: '', status: 'not_started' }));
    setup({ tasks: many });
    expect(pane().querySelectorAll('[data-unscheduled]').length).toBe(UNSCHEDULED_CAP);
    expect(within(pane()).getByText(`Showing ${UNSCHEDULED_CAP} of ${UNSCHEDULED_CAP + 50} - search to narrow down`)).toBeTruthy();
    fireEvent.change(within(pane()).getByLabelText('Search unscheduled tasks'), { target: { value: 'Task 24' } });
    expect([...pane().querySelectorAll('[data-unscheduled]')].map((r) => r.getAttribute('data-unscheduled')).sort())
      .toEqual(['m24', 'm240', 'm241', 'm242', 'm243', 'm244', 'm245', 'm246', 'm247', 'm248', 'm249']);
  });

  it('says so when every task has a due date', () => {
    setup({ tasks: [base[0]] });
    expect(within(pane()).getByText('Every task here has a due date.')).toBeTruthy();
  });

  it('collapses, and remembers it per person', () => {
    const { unmount } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Unscheduled' }));
    expect(screen.queryByTestId('unscheduled-pane')).toBeNull();
    expect(localStorage.getItem('nexus.calendarUnscheduled.me@x.com')).toBe('0');
    unmount();
    setup();
    expect(screen.queryByTestId('unscheduled-pane')).toBeNull();
    fireEvent.click(screen.getByText('Unscheduled (4)'));
    expect(screen.getByTestId('unscheduled-pane')).toBeTruthy();
    expect(localStorage.getItem('nexus.calendarUnscheduled.me@x.com')).toBe('1');
  });

  it('still renders when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((k) => { if (String(k).startsWith('nexus.calendarUnscheduled')) throw new Error('blocked'); return null; });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k) => { if (String(k).startsWith('nexus.calendarUnscheduled')) throw new Error('blocked'); });
    setup();
    expect(pane()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Unscheduled' }));
    expect(screen.queryByTestId('unscheduled-pane')).toBeNull();
  });

  it('week view carries the pane too', () => {
    setup();
    fireEvent.click(screen.getByText('Week'));
    expect(pane()).toBeTruthy();
  });

  it('Move To Date\'s Clear takes the due date off, the keyboard twin of the drop', async () => {
    const { store } = setup();
    fireEvent.keyDown(screen.getByText('Pour Footings').closest('button'), { key: 'F10', shiftKey: true });
    fireEvent.click(screen.getByTitle('Move To Date'));
    const cal = document.querySelector('[data-nx-calendar]');
    await act(async () => { fireEvent.click(within(cal).getByText('Clear')); });
    expect(store.updateTask).toHaveBeenCalledWith('a', { dueOn: '' });
  });

  it('the Teams calendar (no store) has no pane, as before', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 15, 10, 0, 0));
    render(<CalendarView tasks={base} onOpen={vi.fn()} />);
    expect(screen.queryByTestId('unscheduled-pane')).toBeNull();
    expect(screen.queryByText(/Unscheduled \(/)).toBeNull();
  });
});

describe('Unscheduled on a phone', () => {
  // The sheet locks the page's scroll; jsdom has no scrollTo.
  beforeEach(() => { viewport(true); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
  afterEach(() => viewport(false));

  it('is a full-screen sheet from the toolbar button, with Schedule and no drag', async () => {
    const { store, onOpen } = setup();
    expect(screen.queryByTestId('unscheduled-pane')).toBeNull();
    fireEvent.click(screen.getByText('Unscheduled (4)'));
    const sheet = document.querySelector('.nx-modal-sheet');
    expect(sheet).toBeTruthy();
    expect(within(sheet).getByText('Unscheduled (4)')).toBeTruthy();
    const row = within(sheet).getByText('Order Rebar').closest('[data-unscheduled]');
    expect(row.getAttribute('draggable')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Schedule' }));
    const cal = document.querySelector('[data-nx-calendar]');
    await act(async () => { fireEvent.click(within(cal).getByText('24')); });
    expect(store.updateTask).toHaveBeenCalledWith('u1', { dueOn: '2026-10-24' });
    // Opening a task closes the sheet first, so the drawer is not under it.
    fireEvent.click(within(document.querySelector('.nx-modal-sheet')).getByText('Call Inspector'));
    expect(onOpen).toHaveBeenCalledWith('u2');
  });
});
