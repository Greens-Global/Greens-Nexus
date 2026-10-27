import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Ask HR runs through Tickets (Oct 27 2026): an HR ticket says it is
// confidential, HR works it whatever their desk role (the server's per-ticket
// hrCanWork), and nothing that would carry it outside HR is offered - no
// Tasks, Linked Tickets, Equipment or Property, no Delete.

let ticket = {};
let me = 'hr@example.com';
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 1, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: me }),
}));
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  return {
    api: new Proxy({}, {
      get: (_, key) => (key === 'getMyTicketAccess'
        ? () => Promise.resolve({ role: 'supervisor', canWorkQueue: true, canReadInternal: true, canDelete: true, canManageDesk: true })
        : empty),
    }),
  };
});
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: [ticket], tasks: [], projects: [], myEmail: me,
    nameOf: (e) => e, updateTicket: vi.fn(), refresh: vi.fn() }),
}));

const { TicketDrawer } = await import('./TicketsView');

const HR_TICKET = {
  id: 't1', code: '000042', subject: 'Document Update: my visa', status: 'in_progress', priority: 'medium', type: 'other',
  requesterId: 'emp@example.com', assigneeId: 'hr@example.com', approvalStatus: 'none', typeFields: { askHrKind: 'document' },
  confidentialDesk: 'hr', serviceArea: 'hr', application: 'Document Update',
};

afterEach(() => { cleanup(); });

describe('TicketDrawer on a confidential HR ticket', () => {
  it('says it is confidential and offers nothing that carries it outside HR', async () => {
    me = 'hr@example.com';
    ticket = { ...HR_TICKET, hrCanWork: true };
    render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    expect(await screen.findByText(/Confidential HR Request\./)).toBeTruthy();
    expect(screen.queryByText('Tasks')).toBeNull();
    expect(screen.queryByText('Linked Tickets')).toBeNull();
    expect(screen.queryByText('Equipment')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete$/ })).toBeNull();
  });

  it('HR gets the internal-note switch; the requester does not', async () => {
    me = 'hr@example.com';
    ticket = { ...HR_TICKET, hrCanWork: true };
    render(<TicketDrawer ticketId="t1" onClose={() => {}} initialTab="conversation" />);
    expect(await screen.findByRole('button', { name: /Internal Note/ })).toBeTruthy();
    cleanup();
    me = 'emp@example.com';
    ticket = { ...HR_TICKET, hrCanWork: false };
    render(<TicketDrawer ticketId="t1" onClose={() => {}} initialTab="conversation" />);
    await screen.findByText(/Confidential HR Request\./);
    expect(screen.queryByRole('button', { name: /Internal Note/ })).toBeNull();
  });

  it('an ordinary ticket shows no confidential note', async () => {
    me = 'hr@example.com';
    ticket = { ...HR_TICKET, confidentialDesk: undefined, hrCanWork: undefined };
    render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    expect(await screen.findByText('Linked Tickets')).toBeTruthy();
    expect(screen.queryByText(/Confidential HR Request\./)).toBeNull();
  });
});
