import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// The named approver may decide a ticket without desk access (backend #643):
// the drawer shows them Approve / Reject - matched case-insensitively - and
// nobody else gets the buttons.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
let ME = 'boss@example.com';
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myLevel: 1, canAccessModule: () => false,
    myGrantedModules: new Set(), myEmail: ME }),
}));
const decideTicketApproval = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, k) => (k === 'decideTicketApproval' ? decideTicketApproval
      : k === 'getMyTicketAccess' ? () => Promise.resolve({ onDesk: false, canAct: false })
        : () => Promise.resolve([])),
  }),
}));
vi.mock('./ticketAccess', () => ({ useTicketAccess: () => ({ canDelete: false, privileged: false, canWorkQueue: false, canReadInternal: false, onDesk: false }) }));
const TICKET = {
  id: 't1', code: '000001', subject: 'New laptop', status: 'open', priority: 'medium', type: 'request',
  requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'pending', approverId: 'Boss@Example.com', typeFields: {},
};
const reloadTickets = vi.fn(() => Promise.resolve());
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: [TICKET], ticketsLoaded: true, tasks: [], projects: [], myEmail: ME,
    nameOf: (e) => e, updateTicket: vi.fn(), refresh: vi.fn(), reloadTickets }),
}));

const { TicketDrawer } = await import('./TicketsView');

afterEach(() => { cleanup(); ME = 'boss@example.com'; decideTicketApproval.mockClear(); reloadTickets.mockClear(); });

// The words a reader sees, without the avatars' initials in between.
const said = (el) => { const c = el.cloneNode(true); c.querySelectorAll('[data-avatar]').forEach((n) => n.remove()); return c.textContent.replace(/\s+/g, ' '); };

describe('TicketDrawer - the named approver', () => {
  it('shows Approve and Reject to the approver with no desk access, and decides', async () => {
    render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    expect(said(screen.getByText(/waiting on/))).toMatch(/waiting on you/);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Approve/ })); });
    expect(decideTicketApproval).toHaveBeenCalledWith('t1', 'approve', '');
    expect(reloadTickets).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Reject/ })).toBeTruthy();
  });

  it('gives the requester no Approve / Reject buttons', () => {
    ME = 'req@example.com';
    render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reject/ })).toBeNull();
    expect(screen.getByText(/can't be worked on until it's approved/)).toBeTruthy();
  });

  it('gives someone else no Approve / Reject buttons', () => {
    ME = 'other@example.com';
    render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reject/ })).toBeNull();
  });
});
