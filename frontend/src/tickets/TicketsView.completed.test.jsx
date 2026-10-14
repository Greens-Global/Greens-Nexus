import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// The Completed section (resolved / closed tickets) starts collapsed on EVERY
// visit (Neil, Oct 13 2026) - opening it lasts for the visit only. It used to
// be a saved preference, so one click left it open on every screen after.

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

describe('Ticket list - Completed section', () => {
  it('starts collapsed on every visit and opens for this visit only', async () => {
    const { unmount } = render(<TicketsView />);
    const head = await screen.findByRole('button', { name: /Completed/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Old monitor replaced')).toBeNull();     // resolved ticket hidden
    expect(screen.getByText('Printer jam')).toBeTruthy();              // open one still listed
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Old monitor replaced')).toBeTruthy();
    unmount();
    render(<TicketsView />);                                           // the next visit: collapsed again
    const again = await screen.findByRole('button', { name: /Completed/ });
    expect(again.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Old monitor replaced')).toBeNull();
  });
});
