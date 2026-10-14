import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Teams in a ticket's Collaborators (Neil, Oct 14 2026: "use the same
// functionality that is in the task module"): a team adds its whole roster
// in one click, and two or more picked people can be saved as a team.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 3, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'agent@example.com' }),
}));
const PEOPLE = [
  { email: 'sagar@example.com', name: 'Sagar Shoundik' },
  { email: 'pranshu@example.com', name: 'Pranshu Rao' },
  { email: 'vl@example.com', name: 'VL Kumar' },
];
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  return { api: new Proxy({}, { get: (_, k) => (k === 'getPeopleDirectory' ? () => Promise.resolve(PEOPLE) : empty) }) };
});
const TICKET = {
  id: 't1', code: '000001', subject: 'Printer jam', status: 'open', priority: 'medium', type: 'incident',
  requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'none', typeFields: {}, watcherIds: [],
};
const updateTicket = vi.fn(() => Promise.resolve(TICKET));
const createTeam = vi.fn(() => Promise.resolve({ id: 'tm2' }));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: [TICKET], tasks: [], projects: [], myEmail: 'agent@example.com',
    teams: [{ id: 'tm1', name: 'IT Dev', memberIds: ['sagar@example.com', 'pranshu@example.com'] }], createTeam,
    nameOf: (e) => PEOPLE.find((p) => p.email === e)?.name || e, updateTicket, refresh: vi.fn() }),
}));

const { TicketDrawer } = await import('./TicketsView');

afterEach(() => { cleanup(); updateTicket.mockClear(); createTeam.mockClear(); });

const openPicker = async () => {
  render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
  await screen.findAllByText(/Collaborators/);
  fireEvent.click(screen.getByRole('button', { name: 'Collaborators' }));
};

describe('ticket collaborators: teams, as in the task module', () => {
  it('a team adds its whole roster in one click', async () => {
    await openPicker();
    fireEvent.click(await screen.findByTitle('Add IT Dev (2)'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    expect(updateTicket).toHaveBeenCalledWith('t1', { watcherIds: ['sagar@example.com', 'pranshu@example.com'] });
  });

  it('three people picked can be saved as a personal team', async () => {
    await openPicker();
    for (const n of ['Sagar Shoundik', 'Pranshu Rao', 'VL Kumar']) fireEvent.click(await screen.findByText(n));
    fireEvent.click(screen.getByText(/Save These 3 People as a Team/));
    fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'Ticket Crew' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Team' })); });
    expect(createTeam).toHaveBeenCalledWith({
      name: 'Ticket Crew', memberIds: ['sagar@example.com', 'pranshu@example.com', 'vl@example.com'], personal: true,
    });
  });
});
