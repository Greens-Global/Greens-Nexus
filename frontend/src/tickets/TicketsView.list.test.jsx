import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';

// The ticket list (Neil, Oct 1 2026): a Latest Comment column at the end that
// opens the ticket on its Conversation, whole-row hover, the requester's own
// Mark Resolved, and status colors with a logic (Open is red, never blue).

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
let ME = 'agent@example.com';
let LEVEL = 3;
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: LEVEL, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: ME }),
}));
vi.mock('../api', () => {
  const answer = (k) => (k === 'getToursSeen' ? { seen: { ticket: true, support: true } } : []);
  return { api: new Proxy({}, { get: (_, k) => () => Promise.resolve(answer(k)) }) };
});
const nowIso = () => new Date(Date.now() - 2 * 3600 * 1000).toISOString().replace('Z', '');
const TICKETS = [
  { id: 't1', code: '000001', subject: 'Printer jam', status: 'in_progress', priority: 'medium', type: 'incident',
    requesterId: 'req@example.com', assigneeId: 'agent@example.com', approvalStatus: 'none', typeFields: {},
    createdAt: '2026-09-30T10:00:00', latestComment: { authorId: 'agent@example.com', preview: 'Swapping the toner now', createdAt: nowIso(), internal: false } },
  { id: 't2', code: '000002', subject: 'VPN down', status: 'open', priority: 'high', type: 'incident',
    requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'none', typeFields: {}, createdAt: '2026-09-30T11:00:00', latestComment: null },
];
const updateTicket = vi.fn((id, p) => Promise.resolve({ ...TICKETS.find((t) => t.id === id), ...p }));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: TICKETS, ticketsLoaded: true, ticketViews: [], tasks: [], projects: [], myEmail: ME,
    nameOf: (e) => ({ 'agent@example.com': 'Ava Agent', 'req@example.com': 'Rex Requester' })[e] || e,
    updateTicket, deleteTicket: vi.fn(), refresh: vi.fn(), createTicketView: vi.fn(), deleteTicketView: vi.fn() }),
}));

const { default: TicketsView, TicketActionDialog } = await import('./TicketsView');
const { TICKET_STATUS_META } = await import('./ticketMeta');

afterEach(() => { cleanup(); updateTicket.mockClear(); ME = 'agent@example.com'; LEVEL = 3; });

describe('Ticket list - Latest Comment column', () => {
  it('shows the newest reply at the end of the row, author first', async () => {
    render(<TicketsView />);
    expect(await screen.findByText('Latest Comment')).toBeTruthy();
    const cell = screen.getByRole('button', { name: /Latest comment by Ava Agent, 2h ago/ });
    expect(within(cell).getByText(/Swapping the toner now/)).toBeTruthy();
    // A ticket nobody has replied to says so instead of rendering blank.
    expect(screen.getByText('No comments yet')).toBeTruthy();
  });

  it('opens the ticket on its Conversation when clicked', async () => {
    render(<TicketsView />);
    const cell = await screen.findByRole('button', { name: /Latest comment by Ava Agent/ });
    await act(async () => { fireEvent.click(cell); });
    expect(await screen.findByText('No comments yet.')).toBeTruthy();   // the Conversation tab's own empty thread
  });

  it('every list row carries the whole-row hover class', async () => {
    const { container } = render(<TicketsView />);
    await screen.findByText('Printer jam');
    expect(container.querySelectorAll('.nx-row-hover').length).toBeGreaterThanOrEqual(2);
  });
});

describe('Ticket status colors', () => {
  it('Open is red and In Progress amber - blue is not a status color', () => {
    expect(TICKET_STATUS_META.open.color).toBe('#dc2626');
    expect(TICKET_STATUS_META.in_progress.color).toBe('#d97706');
    const blue = '#2563eb';
    expect(Object.values(TICKET_STATUS_META).some((m) => m.color === blue)).toBe(false);
  });
});

describe('Requester resolves their own ticket', () => {
  it('the dialog asks "What fixed it?" and does not require it', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    render(<TicketActionDialog mode="self_resolve" ticket={TICKETS[1]} onSubmit={onSubmit} onClose={onClose} />);
    expect(screen.getByText('What fixed it? (optional)')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark Resolved' })); });
    expect(onSubmit).toHaveBeenCalledWith({ status: 'resolved' });
    expect(onClose).toHaveBeenCalled();
  });

  it('sends the comment as an escaped reply', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<TicketActionDialog mode="self_resolve" ticket={TICKETS[1]} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/A colleague showed me/), { target: { value: 'Sam fixed it <3\nThanks' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark Resolved' })); });
    expect(onSubmit).toHaveBeenCalledWith({ status: 'resolved', comment: '<p>Sam fixed it &lt;3</p><p>Thanks</p>' });
  });

  it('the requester gets Mark Resolved on their in-progress ticket and resolves it from the list', async () => {
    ME = 'req@example.com'; LEVEL = 1;
    render(<TicketsView />);
    const btn = await screen.findByRole('button', { name: /^Mark #?0*1 Resolved$/ });
    await act(async () => { fireEvent.click(btn); });
    expect(screen.getByText('What fixed it? (optional)')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/A colleague showed me/), { target: { value: 'Rebooted' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark Resolved' })); });
    expect(updateTicket).toHaveBeenCalledWith('t1', { status: 'resolved', comment: '<p>Rebooted</p>' });
  });
});
