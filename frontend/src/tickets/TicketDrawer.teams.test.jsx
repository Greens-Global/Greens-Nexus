import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Message and Call on Teams beside the requester and the assignee (Frontline
// Reach, 11/02/2026): the desk reaches the person without leaving the ticket,
// never for yourself, never for an external.
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 3, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'desk@greensglobal.com' }),
}));
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  return { api: new Proxy({}, { get: () => empty }) };
});
vi.mock('../tasks/components', async (importOriginal) => ({
  ...(await importOriginal()),
  usePeople: () => [
    { email: 'req@greensglobal.com', name: 'Rita Req' },
    { email: 'desk@greensglobal.com', name: 'Dan Desk' },
    { email: 'guest@partner.com', name: 'Gus Guest', external: true },
  ],
}));
const TICKET = {
  id: 't27', code: '000027', subject: 'Printer jam', status: 'in_progress', priority: 'medium', type: 'incident',
  requesterId: 'req@greensglobal.com', assigneeId: 'desk@greensglobal.com', approvalStatus: 'none', typeFields: {},
};
const store = { tickets: [TICKET], ticketsLoaded: true };
const NAMES = { 'req@greensglobal.com': 'Rita Req', 'desk@greensglobal.com': 'Dan Desk', 'guest@partner.com': 'Gus Guest' };
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ ...store, tasks: [], projects: [], myEmail: 'desk@greensglobal.com',
    nameOf: (e) => NAMES[e] || e, updateTicket: vi.fn(), refresh: vi.fn() }),
}));

const { TicketDrawer } = await import('./TicketsView');
afterEach(() => cleanup());

describe('Teams actions on a ticket', () => {
  it('offers Message and Call for the requester, and nothing for the viewer who is the assignee', async () => {
    render(<TicketDrawer ticketId="t27" onClose={() => {}} />);
    const msg = await screen.findByRole('link', { name: 'Message Rita Req on Teams' });
    expect(msg.getAttribute('href')).toBe('https://teams.microsoft.com/l/chat/0/0?users=req%40greensglobal.com');
    expect(screen.getByRole('link', { name: 'Call Rita Req on Teams' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Dan Desk on Teams/ })).toBeNull();
  });
  it('shows nothing for an external assignee', async () => {
    store.tickets = [{ ...TICKET, assigneeId: 'guest@partner.com' }];
    render(<TicketDrawer ticketId="t27" onClose={() => {}} />);
    await screen.findByRole('link', { name: 'Message Rita Req on Teams' });
    expect(screen.queryByRole('link', { name: /Gus Guest on Teams/ })).toBeNull();
    store.tickets = [TICKET];
  });
});
