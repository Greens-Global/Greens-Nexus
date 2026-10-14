import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Tasks from tickets (Oct 14 2026): Create Task from Ticket is one server
// call that links both sides; the new task opens straight away, and closing
// it comes back to the ticket's Overview.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 3, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'agent@example.com' }),
}));
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  return { api: new Proxy({}, { get: () => empty }) };
});
// The task drawer stands in as a stub: this is about the ticket's side.
vi.mock('../tasks/TaskDetailDrawer', () => ({
  default: ({ taskId, onClose, onBackToTicket }) => (
    <div role="dialog" aria-label="task">
      Task {taskId}
      <button onClick={onClose}>Close Task</button>
      <button onClick={onBackToTicket}>Back to Ticket</button>
    </div>
  ),
}));
const TICKET = {
  id: 't1', code: '000123', subject: 'Printer jam', status: 'open', priority: 'medium', type: 'incident',
  requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'none', typeFields: {}, taskIds: [],
};
const createTaskFromTicket = vi.fn(() => Promise.resolve({ task: { id: 'task9' }, ticket: { ...TICKET, taskIds: ['task9'] } }));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: [TICKET], tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => e, updateTicket: vi.fn(), createTaskFromTicket, refresh: vi.fn() }),
}));

const { TicketDrawer } = await import('./TicketsView');

afterEach(() => { cleanup(); createTaskFromTicket.mockClear(); });

describe('Create Task from Ticket', () => {
  it('makes the task in one call and opens it', async () => {
    render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Create Task from Ticket/ })); });
    expect(createTaskFromTicket).toHaveBeenCalledWith('t1');
    expect(screen.getByRole('dialog', { name: 'task' }).textContent).toContain('task9');
  });

  it('closing the task comes back to the ticket Overview', async () => {
    render(<TicketDrawer ticketId="t1" initialTab="activity" onClose={() => {}} />);
    expect(screen.queryByText('Tasks')).toBeNull();          // the Activity tab is showing
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Create Task from Ticket/ })); });
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close Task' }));
    expect(screen.queryByRole('dialog', { name: 'task' })).toBeNull();
    expect(screen.getByText('Tasks')).toBeTruthy();         // back on the Overview
  });
});
