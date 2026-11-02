import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Finished tickets (resolved / closed) live in the Done queue (10/31/2026),
// the successor of the Completed section that collapsed under the list
// (Pranshu, Sept 8 2026; collapsed on every visit, Neil, Oct 13 2026): out of
// the way by default, one click to see them.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 3, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'agent@example.com' }),
}));
vi.mock('../api', () => {
  // A saved "collapsed: []" (the old expanded preference) must not reopen it.
  const answer = (k) => (k === 'getToursSeen' ? { seen: { ticket: true, support: true } }
    : k === 'getTablePrefs' ? { tickets: { collapsed: [] } } : []);
  return { api: new Proxy({}, { get: (_, k) => () => Promise.resolve(answer(k)) }) };
});
const TICKETS = [
  { id: 't1', code: '000001', subject: 'Printer jam', status: 'in_progress', priority: 'medium', type: 'incident',
    requesterId: 'req@example.com', assigneeId: 'agent@example.com', approvalStatus: 'none', typeFields: {}, createdAt: '2026-09-30T10:00:00', latestComment: null },
  { id: 't2', code: '000002', subject: 'Old monitor replaced', status: 'resolved', priority: 'low', type: 'incident',
    requesterId: 'req@example.com', assigneeId: 'agent@example.com', approvalStatus: 'none', typeFields: {}, createdAt: '2026-09-20T11:00:00', latestComment: null },
];
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: TICKETS, ticketsLoaded: true, ticketViews: [], tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => e, updateTicket: vi.fn(), deleteTicket: vi.fn(), refresh: vi.fn(), createTicketView: vi.fn(), deleteTicketView: vi.fn() }),
}));

const { default: TicketsView } = await import('./TicketsView');

afterEach(() => cleanup());

describe('Ticket list - the Done queue', () => {
  it('keeps finished tickets out of the working queues and one tab away', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    expect(screen.queryByText('Old monitor replaced')).toBeNull();     // resolved ticket out of the way
    const done = screen.getByRole('button', { name: /^Done/ });
    expect(done.textContent.trim()).toBe('Done');                      // a tally, not work waiting - no count pill (10/31/2026)
    fireEvent.click(done);
    expect(screen.getByText('Old monitor replaced')).toBeTruthy();
    expect(screen.queryByText('Printer jam')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^All Open/ }));
    expect(screen.getByText('Printer jam')).toBeTruthy();
    expect(screen.queryByText('Old monitor replaced')).toBeNull();
  });
});
