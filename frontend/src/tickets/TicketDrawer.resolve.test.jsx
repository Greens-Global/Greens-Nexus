import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// The requester may mark their own ticket Resolved from the drawer while it is
// still being worked (Neil, Oct 1 2026) - a small dialog with an optional
// "What fixed it?", saved at once (it is their finishing move, like Confirm).

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myLevel: 1, canAccessModule: () => false,
    myGrantedModules: new Set(), myEmail: 'req@example.com' }),
}));
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  return { api: new Proxy({}, { get: () => empty }) };
});
const TICKET = {
  id: 't1', code: '000001', subject: 'Printer jam', status: 'in_progress', priority: 'medium', type: 'incident',
  requesterId: 'req@example.com', assigneeId: 'agent@example.com', approvalStatus: 'none', typeFields: {},
};
const updateTicket = vi.fn(() => Promise.resolve({ ...TICKET, status: 'resolved' }));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: [TICKET], ticketsLoaded: true, tasks: [], projects: [], myEmail: 'req@example.com',
    nameOf: (e) => e, updateTicket, refresh: vi.fn() }),
}));

const { TicketDrawer } = await import('./TicketsView');

afterEach(() => { cleanup(); updateTicket.mockClear(); });

describe('TicketDrawer - requester Mark Resolved', () => {
  it('offers Mark Resolved on an in-progress ticket someone else holds', async () => {
    render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Mark Resolved/ })); });
    expect(screen.getByText('What fixed it? (optional)')).toBeTruthy();
    // No written resolution asked of the requester.
    expect(screen.queryByText(/^Resolution/)).toBeNull();
    const dialogButtons = screen.getAllByRole('button', { name: 'Mark Resolved' });
    await act(async () => { fireEvent.click(dialogButtons[dialogButtons.length - 1]); });
    expect(updateTicket).toHaveBeenCalledWith('t1', { status: 'resolved' });
  });

  it('opens on the tab it is asked to', async () => {
    render(<TicketDrawer ticketId="t1" onClose={() => {}} initialTab="conversation" />);
    expect(await screen.findByText('No comments yet.')).toBeTruthy();
  });
});
