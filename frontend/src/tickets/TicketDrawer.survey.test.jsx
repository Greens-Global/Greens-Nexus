import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// The requester's Confirm Resolution is held like any other edit; Done asks
// how satisfied they are, and the answer then sits at the top of Overview
// (Oct 1).

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 1, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'req@example.com' }),
}));
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  return { api: new Proxy({}, { get: () => empty }) };
});
const RESOLVED = {
  id: 't1', code: '000007', subject: 'Printer jam', status: 'resolved', priority: 'medium', type: 'incident',
  requesterId: 'req@example.com', assigneeId: 'agent@example.com', approvalStatus: 'none', typeFields: {},
  resolution: 'fixed', resolutionNote: 'Cleared the paper path.', csatRating: 0, csatComment: '',
};
const RATED = { ...RESOLVED, status: 'closed', csatRating: 4, csatComment: 'Quick and friendly.' };
let current = RESOLVED;
const updateTicket = vi.fn(() => Promise.resolve(current));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: [current], tasks: [], projects: [], myEmail: 'req@example.com',
    nameOf: (e) => (e === 'req@example.com' ? 'Rita Requester' : e), updateTicket, refresh: vi.fn() }),
}));

const { TicketDrawer } = await import('./TicketsView');

afterEach(() => { cleanup(); updateTicket.mockClear(); current = RESOLVED; });

describe('Confirm Resolution asks for a satisfaction survey on Done', () => {
  it('holds the confirm, then Done opens the survey, which saves the rating and closes', async () => {
    const onClose = vi.fn();
    render(<TicketDrawer ticketId="t1" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Confirm Resolution/ }));
    expect(updateTicket).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Resolution Confirmed/ })).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    expect(updateTicket).not.toHaveBeenCalled();
    expect(screen.getByText('How Satisfied Are You?')).toBeTruthy();

    // Stars are required.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit and Close Ticket' })); });
    expect(updateTicket).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '4 stars' }));
    expect(screen.getByText('Satisfied')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit and Close Ticket' })); });
    expect(updateTicket).toHaveBeenCalledTimes(1);
    expect(updateTicket).toHaveBeenCalledWith('t1', expect.objectContaining({ status: 'closed', csatRating: 4 }));
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking Confirm Resolution again undoes it, and Done then just closes', async () => {
    const onClose = vi.fn();
    render(<TicketDrawer ticketId="t1" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Confirm Resolution/ }));
    fireEvent.click(screen.getByRole('button', { name: /Resolution Confirmed/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    expect(screen.queryByText('How Satisfied Are You?')).toBeNull();
    expect(updateTicket).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the survey result at the top of Overview once rated', () => {
    current = RATED;
    render(<TicketDrawer ticketId="t1" onClose={vi.fn()} />);
    const card = screen.getByTestId('satisfaction-card');
    expect(card.textContent).toContain('Satisfaction Survey');
    expect(card.textContent).toContain('Satisfied');
    expect(card.textContent).toContain('4/5');
    expect(card.textContent).toContain('Rita Requester');
    expect(card.textContent).toContain('Quick and friendly.');
  });
});
