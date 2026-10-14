import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Collaborators on a ticket, as on a task (Oct 14 2026): the ticket's
// watchers, picked in the drawer and saved with the rest on Done.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 3, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'agent@example.com' }),
}));
const PEOPLE = [{ email: 'urmi@example.com', name: 'Urmi Patel' }, { email: 'sai@example.com', name: 'Sai Kumar' }];
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  return { api: new Proxy({}, { get: (_, k) => (k === 'getPeopleDirectory' ? () => Promise.resolve(PEOPLE) : empty) }) };
});
const TICKET = {
  id: 't1', code: '000001', subject: 'Printer jam', status: 'open', priority: 'medium', type: 'incident',
  requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'none', typeFields: {},
  watcherIds: ['sai@example.com'],
};
const updateTicket = vi.fn(() => Promise.resolve(TICKET));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: [TICKET], tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => PEOPLE.find((p) => p.email === e)?.name || e, updateTicket, refresh: vi.fn() }),
}));

const { TicketDrawer } = await import('./TicketsView');

afterEach(() => { cleanup(); updateTicket.mockClear(); });

describe('ticket collaborators', () => {
  it('shows who is on it, and an added one is saved on Done', async () => {
    render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    expect(screen.getByText('Collaborators')).toBeTruthy();
    expect(await screen.findByText('Sai Kumar')).toBeTruthy();
    // The Requester dropdown's look: a search box, then name over email.
    fireEvent.click(screen.getByRole('button', { name: 'Collaborators' }));
    expect(screen.getByPlaceholderText('Search people…')).toBeTruthy();
    expect(screen.getByText('urmi@example.com')).toBeTruthy();
    fireEvent.click(screen.getByText('Urmi Patel'));
    expect(updateTicket).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    expect(updateTicket).toHaveBeenCalledWith('t1', { watcherIds: ['sai@example.com', 'urmi@example.com'] });
  });

  it('one can be taken off', async () => {
    render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    fireEvent.click(await screen.findByTitle('Remove Sai Kumar'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    expect(updateTicket).toHaveBeenCalledWith('t1', { watcherIds: [] });
  });
});
