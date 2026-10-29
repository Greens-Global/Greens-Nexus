import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Collaborators on the Create a Ticket form (Oct 14 2026), beside Requester:
// picked people go out as the new ticket's watchers.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@example.com' }),
}));
const DEPTS = [{ id: 'd-fac', name: 'Facilities' }];
const PEOPLE = [{ email: 'urmi@example.com', name: 'Urmi Patel' }];
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  const named = {
    getMyTicketDepartments: () => Promise.resolve(DEPTS), getTicketDepartments: () => Promise.resolve(DEPTS),
    getPeopleDirectory: () => Promise.resolve(PEOPLE),
  };
  return { api: new Proxy({}, { get: (_, k) => named[k] || empty }) };
});
const createTicket = vi.fn(() => Promise.resolve({ id: 't1' }));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ createTicket, projects: [], myEmail: 'me@example.com' }),
}));

const { CreateTicketModal } = await import('./TicketsView');

afterEach(() => { cleanup(); createTicket.mockClear(); });

describe('Create a Ticket - Collaborators', () => {
  it('sends the people picked as the ticket\'s collaborators', async () => {
    render(<CreateTicketModal onClose={vi.fn()} />);
    const title = await screen.findByPlaceholderText(/What is the issue\?/, {}, { timeout: 5000 });
    expect(screen.getByText('Collaborators')).toBeTruthy();
    fireEvent.change(title, { target: { value: 'Printer jammed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Collaborators' }));
    fireEvent.click(await screen.findByText('Urmi Patel'));
    fireEvent.keyDown(screen.getByPlaceholderText('Search people…'), { key: 'Escape' });
    fireEvent.click(await screen.findByRole('radio', { name: /Facilities/ }));
    fireEvent.change(screen.getByPlaceholderText(/Front gate keypad/), { target: { value: 'Printer' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' })); });
    expect(createTicket).toHaveBeenCalledWith(expect.objectContaining({ watcherIds: ['urmi@example.com'] }));
  });

  it("a converted task's assignees and collaborators come over, less its owner", async () => {
    render(<CreateTicketModal onClose={vi.fn()} fromTask={{ id: 'task1', title: 'Fix the printer', description: '', priority: 'medium',
      ownerId: 'me@example.com', fileCount: 0, collaboratorIds: ['me@example.com', 'Urmi@example.com', 'urmi@example.com'] }} />);
    // Generous waits: the form loads its lists first, and a full-suite run is slow.
    expect(await screen.findByText(/collaborators filled in/, {}, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findByTitle('Remove Urmi Patel', {}, { timeout: 5000 })).toBeTruthy();
  });
});
