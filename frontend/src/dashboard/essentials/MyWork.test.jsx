// My Work tile (Essentials, Oct 7): render-smoke + behavior against the
// /me/work shape (mocked). Grouping and the 7-row cap, Complete finishing a
// task in place, the unread dot on a ticket reply, the empty state, and the
// two ways a row opens (task vs ticket). Since 11/13/2026 the list is every
// kind of work that is mine: the kind chips, the other kinds' rows and links,
// a source that failed being named, and View All opening the whole list.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ getMyWork: vi.fn(), updateTask: vi.fn() }));
vi.mock('../../api', () => ({ api: apiMock }));
// The composers are heavy lazy chunks (Tasks provider + ticket module); the
// tile only has to mount them, so stub them to a marker.
vi.mock('../QuickActionModals.jsx', () => ({ default: ({ kind }) => <div>composer:{kind}</div> }));
vi.mock('../../tasks/TasksContext', () => ({ TasksProvider: ({ children }) => <div>{children}</div> }));
vi.mock('../../tickets/TicketsView', () => ({ CreateTicketModal: () => <div>composer:ticket</div> }));

import MyWork, { pickRows, openItem, workSub } from './MyWork.jsx';
import { takePendingOpen, __clearPendingOpen } from '../../lib/pendingOpen';

const task = (id, dueOn, extra = {}) => ({
  kind: 'task', id, code: `TASK-${id}`, title: `Task ${id}`, project: 'Rollout', dueOn, status: 'in_progress',
  statusLabel: 'In Progress', priority: 'medium', unread: false, view: 'tasks', sub: '', taskId: id, ...extra,
});
const ticket = (id, dueOn, extra = {}) => ({
  kind: 'ticket', id, code: '000027', title: `Ticket ${id}`, project: 'IT', dueOn, status: 'open',
  statusLabel: 'Open', priority: 'high', unread: false, view: 'support', sub: '', ticketId: id, ...extra,
});
const shape = (groups) => {
  const d = { overdue: [], today: [], week: [], later: [], ...groups };
  const counts = { overdue: d.overdue.length, today: d.today.length, week: d.week.length, later: d.later.length };
  counts.total = counts.overdue + counts.today + counts.week + counts.later;
  return { ...d, counts, localDate: '2026-10-08' };
};

let events;
const onEvent = (e) => events.push([e.type, e.detail]);
beforeEach(() => {
  events = [];
  __clearPendingOpen();
  ['nexus:navigate', 'nexus:open-task', 'nexus:open-ticket'].forEach((n) => window.addEventListener(n, onEvent));
  apiMock.updateTask.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  ['nexus:navigate', 'nexus:open-task', 'nexus:open-ticket'].forEach((n) => window.removeEventListener(n, onEvent));
  apiMock.getMyWork.mockReset();
  apiMock.updateTask.mockReset();
});

describe('pickRows', () => {
  it('walks the groups overdue first and stops at the cap, keeping the real counts', () => {
    const data = shape({
      overdue: [task('o1', '2026-10-01'), task('o2', '2026-10-02')],
      today: [task('t1', '2026-10-08'), ticket('t2', '2026-10-08')],
      week: [task('w1', '2026-10-10'), task('w2', '2026-10-11'), task('w3', '2026-10-12')],
      later: [task('l1', ''), task('l2', '2026-11-01')],
    });
    const rows = pickRows(data);
    expect(rows.map((s) => [s.label, s.count, s.items.length])).toEqual([
      ['Overdue', 2, 2], ['Today', 2, 2], ['This Week', 3, 3],
    ]);
    expect(rows.flatMap((s) => s.items).length).toBe(7);
    // Caps are honored even when the server already sliced a group.
    expect(pickRows({ ...data, counts: { ...data.counts, later: 60 } }, 20).find((s) => s.key === 'later').count).toBe(60);
    expect(pickRows(null)).toEqual([]);
  });
});

describe('workSub', () => {
  it('names both kinds the number counts', () => {
    expect(workSub(1)).toBe('1 Open Task or Ticket');
    expect(workSub(50)).toBe('50 Open Tasks and Tickets');
  });
});

describe('My Work tile', () => {
  it('renders the groups with counts, seven rows at most, and View All opens the whole list', async () => {
    apiMock.getMyWork.mockResolvedValue(shape({
      overdue: [task('o1', '2026-10-01'), task('o2', '2026-10-02')],
      today: [task('t1', '2026-10-08'), ticket('t2', '2026-10-08')],
      week: [task('w1', '2026-10-10'), task('w2', '2026-10-11'), task('w3', '2026-10-12')],
      later: [task('l1', ''), task('l2', '2026-11-01')],
    }));
    render(<MyWork />);
    expect(await screen.findByText('Overdue')).toBeTruthy();
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('This Week')).toBeTruthy();
    expect(screen.queryByText('Later')).toBeNull();           // beyond the cap
    expect(screen.getAllByLabelText(/^Open /)).toHaveLength(7);
    // Tasks and tickets together, so it says so - never read against the
    // My Open Tasks number (live tasks only).
    expect(screen.getByText('9 Open Tasks and Tickets')).toBeTruthy();
    expect(screen.getByText(/View All/).textContent).not.toMatch(/\d/);
    expect(screen.getByText('Rollout · Due 10/01/2026')).toBeTruthy();   // US date
    expect(screen.getByText('#27 · Due 10/08/2026')).toBeTruthy();       // ticket number, not project
    expect(screen.queryByRole('group', { name: 'Show' })).toBeNull();     // one kind of list: no chips
    // View All: the whole list beside the page - all nine rows, Later included.
    fireEvent.click(screen.getByText(/View All/));
    expect(await screen.findByText('Open My Tasks')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Later')).toBeTruthy();
    expect(screen.getAllByLabelText(/^Open /).length).toBeGreaterThanOrEqual(9);
    fireEvent.click(screen.getByText('Open My Tasks'));
    expect(events).toContainEqual(['nexus:navigate', { view: 'tasks', sub: 'mine' }]);
  });

  it('Complete finishes the task through the Tasks API and takes the row off the tile', async () => {
    apiMock.getMyWork
      .mockResolvedValueOnce(shape({ today: [task('t1', '2026-10-08'), ticket('t2', '2026-10-08')] }))
      .mockResolvedValue(shape({ today: [ticket('t2', '2026-10-08')] }));
    render(<MyWork />);
    expect(await screen.findByText('Task t1')).toBeTruthy();
    expect(screen.queryByLabelText('Complete Ticket t2')).toBeNull();   // tickets have no Complete
    fireEvent.click(screen.getByLabelText('Complete Task t1'));
    expect(screen.queryByText('Task t1')).toBeNull();                   // optimistic
    await waitFor(() => expect(apiMock.updateTask).toHaveBeenCalledWith('t1', { completed: true }));
    await waitFor(() => expect(apiMock.getMyWork).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Task t1')).toBeNull();
    expect(screen.getByText('Ticket t2')).toBeTruthy();
  });

  it('puts the row back and says so when the completion fails', async () => {
    apiMock.getMyWork.mockResolvedValue(shape({ today: [task('t1', '2026-10-08')] }));
    apiMock.updateTask.mockRejectedValue(new Error('Dependency not finished'));
    render(<MyWork />);
    fireEvent.click(await screen.findByLabelText('Complete Task t1'));
    expect(await screen.findByText('Dependency not finished')).toBeTruthy();
    expect(screen.getByText('Task t1')).toBeTruthy();
  });

  it('marks a ticket with an unread reply', async () => {
    apiMock.getMyWork.mockResolvedValue(shape({
      today: [ticket('a', '2026-10-08', { unread: true }), ticket('b', '2026-10-08')],
    }));
    render(<MyWork />);
    expect(await screen.findByText('Ticket a')).toBeTruthy();
    expect(screen.getAllByLabelText('Unread reply')).toHaveLength(1);
  });

  it('opens a task in Tasks and a ticket where it lives, leaving the pending note', async () => {
    apiMock.getMyWork.mockResolvedValue(shape({
      today: [task('t1', '2026-10-08'), ticket('k1', '2026-10-08', { view: 'tickets' })],
    }));
    render(<MyWork />);
    fireEvent.click(await screen.findByLabelText('Open Task t1'));
    await waitFor(() => expect(events).toContainEqual(['nexus:open-task', { taskId: 't1' }]));
    expect(events).toContainEqual(['nexus:navigate', { view: 'tasks', sub: 'mine' }]);
    expect(takePendingOpen('task')).toBe('t1');
    fireEvent.click(screen.getByLabelText('Open Ticket k1'));
    await waitFor(() => expect(events).toContainEqual(['nexus:open-ticket', { ticketId: 'k1' }]));
    expect(events).toContainEqual(['nexus:navigate', { view: 'tickets', sub: null }]);
    expect(takePendingOpen('ticket')).toBe('k1');
    // A ticket row with no view from the server lands on Support.
    openItem({ kind: 'ticket', id: 'z' });
    await waitFor(() => expect(events).toContainEqual(['nexus:navigate', { view: 'support', sub: null }]));
  });

  it('says so when nothing is due, and never renders blank while loading or on an error', async () => {
    apiMock.getMyWork.mockResolvedValue(shape({}));
    const { unmount } = render(<MyWork />);
    expect(await screen.findByText('Nothing due this week.')).toBeTruthy();
    unmount();
    apiMock.getMyWork.mockRejectedValue(new Error('Network down'));
    render(<MyWork />);
    expect(await screen.findByText('Network down')).toBeTruthy();
  });

  it('header actions open the task and ticket composers', async () => {
    apiMock.getMyWork.mockResolvedValue(shape({}));
    render(<MyWork />);
    await screen.findByText('Nothing due this week.');
    fireEvent.click(screen.getByText('New Task'));
    expect(await screen.findByText('composer:task')).toBeTruthy();
    fireEvent.click(screen.getByText('Submit a Ticket'));
    expect(await screen.findByText('composer:ticket')).toBeTruthy();
  });

  it('Complete takes off the task only - a ticket with the same id stays', async () => {
    apiMock.getMyWork
      .mockResolvedValueOnce(shape({ today: [task('7', '2026-10-08'), ticket('7', '2026-10-08')] }))
      .mockReturnValue(new Promise(() => {}));   // the confirming refetch never lands
    render(<MyWork />);
    fireEvent.click(await screen.findByLabelText('Complete Task 7'));
    expect(screen.queryByText('Task 7')).toBeNull();
    expect(screen.getByText('Ticket 7')).toBeTruthy();
  });

  it('a failed Complete puts back only its own row, not one completed alongside it', async () => {
    apiMock.getMyWork
      .mockResolvedValueOnce(shape({ today: [task('a', '2026-10-08'), task('b', '2026-10-08')] }))
      .mockReturnValue(new Promise(() => {}));
    let failA;
    apiMock.updateTask.mockImplementation((id) => (id === 'a'
      ? new Promise((_, rej) => { failA = () => rej(new Error('Dependency not finished')); })
      : Promise.resolve({})));
    render(<MyWork />);
    fireEvent.click(await screen.findByLabelText('Complete Task a'));
    fireEvent.click(screen.getByLabelText('Complete Task b'));
    await waitFor(() => expect(apiMock.updateTask).toHaveBeenCalledWith('b', { completed: true }));
    failA();
    expect(await screen.findByText('Dependency not finished')).toBeTruthy();
    expect(screen.getByText('Task a')).toBeTruthy();
    expect(screen.queryByText('Task b')).toBeNull();
  });
});

// ── One list of everything that is mine (Neil, 11/13/2026) ──────────────────
const todo = (id, dueOn, extra = {}) => ({
  kind: 'todo', source: 'todo', id, code: '', title: `Sign ${id}`, project: 'Documents To Sign', dueOn, status: 'todo',
  statusLabel: 'Waiting on You', priority: 'medium', unread: false, view: 'myhr', sub: `sign:${id}`,
  link: { view: 'myhr', sub: `sign:${id}` }, cta: 'Review & Sign', detail: '', ...extra,
});
const sheetRow = (extra = {}) => ({
  kind: 'timesheet', source: 'timesheet', id: '2026-10-25:hourly', code: '', title: 'Submit Your Time Sheet', project: 'Time Sheet',
  dueOn: '2026-11-07', status: 'timesheet', statusLabel: 'Not Submitted', priority: 'high', unread: false, view: 'timeclock',
  sub: 'timesheet', link: { view: 'timeclock', sub: 'timesheet', start: '2026-10-25', payType: 'hourly', submit: true },
  cta: 'Review and Submit', detail: '', ...extra,
});
const course = (id, dueOn, extra = {}) => ({
  kind: 'course', source: 'training', id, code: '', title: `Course ${id}`, project: 'Training', dueOn, status: 'not_started',
  statusLabel: 'Not Started', priority: 'medium', unread: false, view: 'sop', sub: `course:${id}`,
  link: { view: 'sop', sub: `course:${id}` }, cta: 'Start', detail: '', ...extra,
});
const mixed = (extra = {}) => ({
  ...shape({
    overdue: [sheetRow(), course('c1', '2026-11-10')],
    today: [task('t1', '2026-11-13', { source: 'tasks' }), todo('nexus_sign:p1', '2026-11-13')],
    week: [ticket('k1', '2026-11-15', { source: 'tickets' })],
  }),
  sources: [{ key: 'tasks', label: 'Tasks', count: 1 }, { key: 'tickets', label: 'Tickets', count: 1 },
    { key: 'todo', label: 'Yours To Do', count: 1 }, { key: 'timesheet', label: 'Time Sheet', count: 1 },
    { key: 'training', label: 'Training', count: 1 }],
  errors: [], ...extra,
});

describe('My Work is one list', () => {
  it('shows every kind together, says what the number is, and only a task has Complete', async () => {
    apiMock.getMyWork.mockResolvedValue(mixed());
    render(<MyWork />);
    expect(await screen.findByText('Submit Your Time Sheet')).toBeTruthy();
    expect(screen.getByText('5 Waiting on You')).toBeTruthy();
    expect(screen.getByText('Time Sheet · Due 11/07/2026')).toBeTruthy();
    expect(screen.getByText('Documents To Sign · Due 11/13/2026')).toBeTruthy();
    expect(screen.getAllByLabelText(/^Open /)).toHaveLength(5);
    expect(screen.getAllByLabelText(/^Complete /)).toHaveLength(1);
    expect(screen.getByLabelText('Complete Task t1')).toBeTruthy();
  });

  it('kind chips filter the list and say which is on', async () => {
    apiMock.getMyWork.mockResolvedValue(mixed());
    render(<MyWork />);
    await screen.findByText('Submit Your Time Sheet');
    const chips = screen.getByRole('group', { name: 'Show' });
    expect([...chips.querySelectorAll('button')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()))
      .toEqual(['All 5', 'Tasks 1', 'Tickets 1', 'Yours To Do 1', 'Time Sheet 1', 'Training 1']);
    expect(screen.getByRole('button', { name: /^All/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /^Training/ }));
    expect(screen.getByRole('button', { name: /^Training/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByLabelText(/^Open /)).toHaveLength(1);
    expect(screen.getByLabelText('Open Course c1')).toBeTruthy();
    expect(screen.queryByText('Today')).toBeNull();          // no empty groups left behind
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    expect(screen.getAllByLabelText(/^Open /)).toHaveLength(5);
  });

  it('a row of another kind opens the screen that owns it, by its own link', async () => {
    window.addEventListener('nexus:open-my-timecard', onEvent);
    openItem(todo('nexus_sign:p1', ''));
    expect(events).toEqual([['nexus:navigate', { view: 'myhr', sub: 'sign:nexus_sign:p1' }]]);
    events.length = 0;
    openItem(course('c1', ''));
    expect(events).toEqual([['nexus:navigate', { view: 'sop', sub: 'course:c1' }]]);
    events.length = 0;
    // The Time Sheet row lands on that period, at Send to Manager.
    openItem(sheetRow());
    await new Promise((r) => setTimeout(r, 0));
    window.removeEventListener('nexus:open-my-timecard', onEvent);
    expect(events[0]).toEqual(['nexus:navigate', { view: 'timeclock', sub: 'timesheet' }]);
    expect(events).toContainEqual(['nexus:open-my-timecard', { start: '2026-10-25', payType: 'hourly', submit: true }]);
    expect(takePendingOpen('myTimecard')).toEqual({ start: '2026-10-25', payType: 'hourly', submit: true });
  });

  it('names a source that could not load - beside the rows, and in place of "nothing due"', async () => {
    apiMock.getMyWork.mockResolvedValue(mixed({ errors: [{ source: 'training', label: 'Training' }] }));
    const { unmount } = render(<MyWork />);
    expect(await screen.findByText("Couldn't load Training.")).toBeTruthy();
    expect(screen.getAllByLabelText(/^Open /)).toHaveLength(5);
    unmount();
    apiMock.getMyWork.mockResolvedValue({ ...shape({}), sources: [], errors: [{ source: 'todo', label: 'Yours To Do' }, { source: 'training', label: 'Training' }] });
    render(<MyWork />);
    expect(await screen.findByText("Couldn't load Yours To Do and Training.")).toBeTruthy();
    expect(screen.queryByText('Nothing due this week.')).toBeNull();
  });

  it('the whole list keeps the chip and closes when a row is opened', async () => {
    apiMock.getMyWork.mockResolvedValue(mixed());
    render(<MyWork />);
    await screen.findByText('Submit Your Time Sheet');
    fireEvent.click(screen.getByRole('button', { name: /^Yours To Do/ }));
    fireEvent.click(screen.getByText(/View All/));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelectorAll('[aria-label^="Open "]')).toHaveLength(1);
    expect(dialog.querySelector('[aria-pressed="true"]').textContent).toMatch(/^Yours To Do/);
    fireEvent.click(dialog.querySelector('[aria-label="Open Sign nexus_sign:p1"]'));
    expect(events).toContainEqual(['nexus:navigate', { view: 'myhr', sub: 'sign:nexus_sign:p1' }]);
    await waitFor(() => expect(screen.queryByText('Open My Tasks')).toBeNull());
  });
});

describe('workSub', () => {
  it('says Waiting on You once the list holds more than tasks and tickets', () => {
    expect(workSub(3, [{ key: 'tasks', count: 2 }, { key: 'training', count: 1 }])).toBe('3 Waiting on You');
    expect(workSub(3, [{ key: 'tasks', count: 2 }, { key: 'tickets', count: 1 }])).toBe('3 Open Tasks and Tickets');
    expect(workSub(2, [{ key: 'tasks', count: 2 }, { key: 'training', count: 0 }])).toBe('2 Open Tasks and Tickets');
  });
});
