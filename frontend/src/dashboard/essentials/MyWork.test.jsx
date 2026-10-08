// My Work tile (Essentials, Oct 7): render-smoke + behavior against the
// /me/work shape (mocked). Grouping and the 7-row cap, Complete finishing a
// task in place, the unread dot on a ticket reply, the empty state, and the
// two ways a row opens (task vs ticket).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ getMyWork: vi.fn(), updateTask: vi.fn() }));
vi.mock('../../api', () => ({ api: apiMock }));
// The composers are heavy lazy chunks (Tasks provider + ticket module); the
// tile only has to mount them, so stub them to a marker.
vi.mock('../QuickActionModals.jsx', () => ({ default: ({ kind }) => <div>composer:{kind}</div> }));
vi.mock('../../tasks/TasksContext', () => ({ TasksProvider: ({ children }) => <div>{children}</div> }));
vi.mock('../../tickets/TicketsView', () => ({ CreateTicketModal: () => <div>composer:ticket</div> }));

import MyWork, { pickRows, openItem } from './MyWork.jsx';
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

describe('My Work tile', () => {
  it('renders the groups with counts, seven rows at most, and View All goes to My Tasks', async () => {
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
    expect(screen.getByText('9 open')).toBeTruthy();
    expect(screen.getByText('Rollout · Due 10/01/2026')).toBeTruthy();   // US date
    expect(screen.getByText('#27 · Due 10/08/2026')).toBeTruthy();       // ticket number, not project
    fireEvent.click(screen.getByText(/View All/));
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
});
