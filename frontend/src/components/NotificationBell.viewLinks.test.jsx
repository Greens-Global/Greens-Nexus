// A task or ticket notification names the thing it is about, so both ways in -
// card itself and the blue label button under it - have to OPEN that task.
// They drifted: the card dispatched `nexus:open-task`, the button called
// onNavigate alone and stopped propagation, so "View task" reached My Tasks and
// left the person to find the task the card had just named. These pin both
// paths, because fixing one and missing the other is exactly what happened.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const notifications = [];

vi.mock('../contexts/NotificationContext', () => ({
  useNotifications: () => ({
    notifications, unreadCount: 0,
    markRead: vi.fn(), markAllRead: vi.fn(), dismiss: vi.fn(),
    addNotification: vi.fn(), markActioned: vi.fn(),
    pendingApprovalId: null, clearPendingApproval: vi.fn(),
  }),
}));
vi.mock('../contexts/InventoryContext', () => ({
  useInventory: () => ({
    approveRequest: vi.fn(), allocateItem: vi.fn(), requests: [],
    requestsLoading: false, refreshRequests: vi.fn(),
  }),
}));
vi.mock('../contexts/RequisitionContext', () => ({
  useRequisitions: () => ({ approveRequisition: vi.fn(), rejectRequisition: vi.fn() }),
}));
vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ accounts: [{ name: 'Sagar Shoundik', username: 'sagar.shoundik@greensglobal.com' }] }),
}));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => false, myLevel: 1 }),
}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => vi.fn(async () => []) }) }));

import { takePendingOpen, __clearPendingOpen } from '../lib/pendingOpen';
import NotificationBell from './NotificationBell';

const TASK_ID = 'e116aa36-e81b-4726-b945-088e02acdd9a';
const taskNotification = (over = {}) => ({
  id: 'n1', type: 'task_task_assigned',
  recipient: 'sagar.shoundik@greensglobal.com',
  title: 'You were assigned a task', body: 'Test for View Task Button',
  refId: TASK_ID, read: false, actioned: false,
  createdAt: new Date().toISOString(),
  action: { view: 'tasks', sub: 'mine', label: 'View task', taskId: TASK_ID },
  ...over,
});

const TICKET_ID = '7c2f1a04-3d55-4a8e-9b21-0f6d5c4e8a11';
const ticketNotification = (over = {}) => ({
  id: 'n2', type: 'task_ticket_escalated',
  recipient: 'sagar.shoundik@greensglobal.com',
  title: 'A ticket was escalated', body: 'TKT-003 · Testing',
  refId: TICKET_ID, read: false, actioned: false,
  createdAt: new Date().toISOString(),
  action: { view: 'tickets', label: 'View ticket', ticketId: TICKET_ID },
  ...over,
});

let opened;        // task ids the bell asked the Task module to open
let openedTickets; // ticket ids the bell asked the Ticket module to open
const onOpenTask = (e) => opened.push(e.detail?.taskId);
const onOpenTicket = (e) => openedTickets.push(e.detail?.ticketId);

beforeEach(() => {
  opened = [];
  openedTickets = [];
  notifications.length = 0;
  window.addEventListener('nexus:open-task', onOpenTask);
  window.addEventListener('nexus:open-ticket', onOpenTicket);
  __clearPendingOpen();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  window.removeEventListener('nexus:open-task', onOpenTask);
  window.removeEventListener('nexus:open-ticket', onOpenTicket);
  vi.useRealTimers();
});

// The dispatch is deferred a tick (the Task module may not be mounted yet), so
// every assertion has to let that timer run first.
const flush = () => vi.advanceTimersByTime(1);

describe('"View task" on a task notification', () => {
  it('opens the task, not just the Tasks module', () => {
    notifications.push(taskNotification());
    const onNavigate = vi.fn();
    render(<NotificationBell onNavigate={onNavigate} />);

    fireEvent.click(screen.getByLabelText("Notifications"));
    fireEvent.click(screen.getByText('View task'));
    flush();

    // Still navigates - the drawer is hosted inside the Task module.
    expect(onNavigate).toHaveBeenCalledWith('tasks', 'mine');
    // ...and names the task, which is the part that was missing.
    expect(opened).toEqual([TASK_ID]);
  });

  it('opens the task when the card itself is clicked', () => {
    notifications.push(taskNotification());
    render(<NotificationBell onNavigate={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Notifications"));
    fireEvent.click(screen.getByText('Test for View Task Button'));
    flush();

    expect(opened).toEqual([TASK_ID]);
  });

  it('stays quiet for a notification carrying no task', () => {
    // Pre-Aug-27 rows and the "you were assigned 5 tasks" roll-up have no
    // taskId; those must navigate and nothing more, never open a blank drawer.
    notifications.push(taskNotification({ action: { view: 'tasks', sub: 'mine', label: 'View tasks' } }));
    const onNavigate = vi.fn();
    render(<NotificationBell onNavigate={onNavigate} />);

    fireEvent.click(screen.getByLabelText("Notifications"));
    fireEvent.click(screen.getByText('View tasks'));
    flush();

    expect(onNavigate).toHaveBeenCalledWith('tasks', 'mine');
    expect(opened).toEqual([]);
  });

  it('does not treat a ticket notification as a task', () => {
    notifications.push(ticketNotification());
    render(<NotificationBell onNavigate={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Notifications"));
    fireEvent.click(screen.getByText('View ticket'));
    flush();

    expect(opened).toEqual([]);
  });
});

describe('"View ticket" on a ticket notification', () => {
  it('opens the ticket, not just the Tickets list', () => {
    notifications.push(ticketNotification());
    const onNavigate = vi.fn();
    render(<NotificationBell onNavigate={onNavigate} />);

    fireEvent.click(screen.getByLabelText("Notifications"));
    fireEvent.click(screen.getByText('View ticket'));
    flush();

    expect(onNavigate).toHaveBeenCalledWith('tickets', undefined);
    expect(openedTickets).toEqual([TICKET_ID]);
  });

  it('opens the ticket when the card itself is clicked', () => {
    notifications.push(ticketNotification());
    render(<NotificationBell onNavigate={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Notifications"));
    fireEvent.click(screen.getByText('TKT-003 · Testing'));
    flush();

    expect(openedTickets).toEqual([TICKET_ID]);
  });

  it('stays quiet for a ticket notification written before the id was carried', () => {
    // Every ticket notification predating this change has no ticketId and no
    // ref_id to recover one from, so those navigate and stop - as they always
    // did - rather than opening an empty drawer.
    notifications.push(ticketNotification({
      action: { view: 'tickets', label: 'View ticket' }, refId: '',
    }));
    const onNavigate = vi.fn();
    render(<NotificationBell onNavigate={onNavigate} />);

    fireEvent.click(screen.getByLabelText("Notifications"));
    fireEvent.click(screen.getByText('View ticket'));
    flush();

    expect(onNavigate).toHaveBeenCalledWith('tickets', undefined);
    expect(openedTickets).toEqual([]);
  });

  it('does not treat a task notification as a ticket', () => {
    notifications.push(taskNotification());
    render(<NotificationBell onNavigate={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Notifications"));
    fireEvent.click(screen.getByText('View task'));
    flush();

    expect(openedTickets).toEqual([]);
  });
});

// Tasks and Tickets are both lazy() in App.jsx, so the first time you open one
// from a notification the chunk is still downloading when the event fires and
// nothing is listening. These stand in for that view mounting late: the id has
// to still be recoverable after the click, or the drawer never opens.
describe('a module that is still loading when the notification is clicked', () => {
  it('can still recover the task once it mounts', () => {
    notifications.push(taskNotification());
    render(<NotificationBell onNavigate={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Notifications"));
    fireEvent.click(screen.getByText('View task'));
    flush();

    // The view mounts only now, long after the event went out.
    expect(takePendingOpen('task')).toBe(TASK_ID);
  });

  it('can still recover the ticket once it mounts', () => {
    notifications.push(ticketNotification());
    render(<NotificationBell onNavigate={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Notifications"));
    fireEvent.click(screen.getByText('View ticket'));
    flush();

    expect(takePendingOpen('ticket')).toBe(TICKET_ID);
  });

  it('leaves nothing behind for a notification that names no task or ticket', () => {
    notifications.push(taskNotification({ action: { view: 'tasks', sub: 'mine', label: 'View tasks' } }));
    render(<NotificationBell onNavigate={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Notifications"));
    fireEvent.click(screen.getByText('View tasks'));
    flush();

    expect(takePendingOpen('task')).toBeNull();
    expect(takePendingOpen('ticket')).toBeNull();
  });
});
