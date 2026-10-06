import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Convert to Ticket (Neil, 10/05): the ticket form opens pre-filled from the
// task - title, description, priority, requester - and says which required
// fields the task could not supply ("this is missing, this is missing").
// The create carries the task id and whether to close the task.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@example.com' }),
}));
const DEPTS = [{ id: 'd-it', name: 'IT' }, { id: 'd-fac', name: 'Facilities' }];
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  const named = { getMyTicketDepartments: () => Promise.resolve(DEPTS), getTicketDepartments: () => Promise.resolve(DEPTS) };
  return { api: new Proxy({}, { get: (_, k) => named[k] || empty }) };
});
const createTicket = vi.fn(() => Promise.resolve({ id: 'tk1', sourceTaskClosed: true }));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ createTicket, projects: [], myEmail: 'me@example.com' }),
}));

const { CreateTicketModal } = await import('./TicketsView');

const TASK = { id: 'task-9', title: 'Light out in the front office', description: '<p>Since Monday</p>',
  priority: 'high', ownerId: 'me@example.com', fileCount: 2 };

afterEach(() => { cleanup(); createTicket.mockClear(); });

describe('Convert to Ticket', () => {
  it('opens pre-filled and names what is still missing', async () => {
    render(<CreateTicketModal onClose={vi.fn()} fromTask={TASK} />);
    const title = await screen.findByPlaceholderText(/What is the issue\?/);
    expect(title.value).toBe('Light out in the front office');
    expect(screen.getAllByText('Convert to Ticket').length).toBeGreaterThan(0);
    expect(screen.getByText(/title, description, priority, requester, 2 files filled in/)).toBeTruthy();
    expect(await screen.findByText(/Still needed: .*Department.*What Do You Need Help With\?/)).toBeTruthy();
  });

  it('sends the task id and the close choice with the new ticket', async () => {
    const onCreated = vi.fn();
    render(<CreateTicketModal onClose={vi.fn()} fromTask={TASK} onCreated={onCreated} />);
    await screen.findByPlaceholderText(/What is the issue\?/);
    fireEvent.click(await screen.findByText('Select department'));
    fireEvent.click(await screen.findByText('Facilities'));
    fireEvent.change(screen.getByPlaceholderText(/Front gate keypad/), { target: { value: 'Lighting' } });
    fireEvent.click(screen.getByLabelText('Close the task'));   // keep the task open this time
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Convert to Ticket' })); });
    expect(createTicket).toHaveBeenCalledTimes(1);
    const body = createTicket.mock.calls[0][0];
    expect(body).toMatchObject({ subject: 'Light out in the front office', priority: 'high', fromTaskId: 'task-9',
      closeSourceTask: false, requesterId: 'me@example.com' });
    expect(onCreated).toHaveBeenCalledWith({ id: 'tk1', sourceTaskClosed: true });
  });

  it('leaves the plain form exactly as it was', async () => {
    render(<CreateTicketModal onClose={vi.fn()} />);
    await screen.findByPlaceholderText(/What is the issue\?/);
    expect(screen.getByRole('button', { name: 'Create Ticket' })).toBeTruthy();
    expect(screen.queryByText(/Still needed/)).toBeNull();
    expect(screen.queryByLabelText('Close the task')).toBeNull();
  });
});
