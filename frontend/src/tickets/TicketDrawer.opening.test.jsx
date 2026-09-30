import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// A ticket opened from an email link (Oct 1): until the ticket list lands the
// drawer shows "Opening your ticket" - like the Task module's loading screen -
// instead of nothing, and the ticket's number reads "#27", not "#000027".

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
const TICKET = {
  id: 't27', code: '000027', subject: 'Printer jam', status: 'open', priority: 'medium', type: 'incident',
  requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'none', typeFields: {},
};
const store = { tickets: [], ticketsLoaded: false };
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ ...store, tasks: [], projects: [], myEmail: 'req@example.com',
    nameOf: (e) => e, updateTicket: vi.fn(), refresh: vi.fn() }),
}));

const { TicketDrawer } = await import('./TicketsView');

afterEach(() => { cleanup(); store.tickets = []; store.ticketsLoaded = false; });

describe('Opening a ticket from a link', () => {
  it('shows the loading screen while the tickets are still arriving', () => {
    render(<TicketDrawer ticketId="t27" onClose={() => {}} />);
    expect(screen.getByText('Opening your ticket…')).toBeTruthy();
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
  });

  it('opens the ticket once it is there, numbered without padding', () => {
    store.tickets = [TICKET];
    store.ticketsLoaded = true;
    render(<TicketDrawer ticketId="t27" onClose={() => {}} />);
    expect(screen.queryByText('Opening your ticket…')).toBeNull();
    expect(screen.getByText('Ticket #27')).toBeTruthy();
  });

  it('shows nothing for a ticket that is not in the loaded list', () => {
    store.ticketsLoaded = true;
    const { container } = render(<TicketDrawer ticketId="gone" onClose={() => {}} />);
    expect(screen.queryByText('Opening your ticket…')).toBeNull();
    expect(container.textContent).toBe('');
  });
});
