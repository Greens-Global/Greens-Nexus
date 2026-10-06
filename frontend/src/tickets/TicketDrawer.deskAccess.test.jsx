import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// The drawer's desk controls follow the role the SERVER gives (my-access,
// backend/ticket_roles.py), not the raw module grants: the internal-note
// switch is an agent's, Delete is a supervisor's. A manager who is only an
// agent under the company's Desk Access rule sees no Delete button.

let access = {};
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 3, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'agent@example.com' }),
}));
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  return {
    api: new Proxy({}, {
      get: (_, key) => (key === 'getMyTicketAccess' ? () => Promise.resolve(access) : empty),
    }),
  };
});
const TICKET = {
  id: 't1', code: '000001', subject: 'Printer jam', status: 'open', priority: 'medium', type: 'incident',
  requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'none', typeFields: {},
};
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: [TICKET], tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => e, updateTicket: vi.fn(), refresh: vi.fn() }),
}));

const { TicketDrawer } = await import('./TicketsView');

afterEach(() => { cleanup(); });

describe('TicketDrawer desk controls follow the server role', () => {
  it('an agent gets the internal-note switch but no Delete', async () => {
    access = { role: 'agent', canWorkQueue: true, canReadInternal: true, canDelete: false, canManageDesk: false };
    render(<TicketDrawer ticketId="t1" onClose={() => {}} initialTab="conversation" />);
    expect(await screen.findByRole('button', { name: /Internal note/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Delete$/ })).toBeNull();
  });

  it('a supervisor also gets Delete', async () => {
    access = { role: 'supervisor', canWorkQueue: true, canReadInternal: true, canDelete: true, canManageDesk: true };
    render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    expect(await screen.findByRole('button', { name: /Delete/ })).toBeTruthy();
  });

  it('a requester gets neither', async () => {
    access = { role: 'requester', canWorkQueue: false, canReadInternal: false, canDelete: false, canManageDesk: false };
    render(<TicketDrawer ticketId="t1" onClose={() => {}} initialTab="conversation" />);
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: /Internal note/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete$/ })).toBeNull();
  });
});
