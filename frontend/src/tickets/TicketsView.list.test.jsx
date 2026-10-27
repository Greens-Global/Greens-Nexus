import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';

// The ticket list (Neil, Oct 1 2026): a Latest Comment column at the end that
// opens the ticket on its Conversation, whole-row hover, the requester's own
// Mark Resolved, and status colors with a logic (Open is slate, never blue).

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
    // A ticket nobody has replied to, past its check-in window, says it needs
    // a comment here - the flag left the Priority cell (Oct 14 2026).
    expect(screen.getAllByText('Needs a Comment').length).toBeGreaterThan(0);
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
  // Open moved from red to slate (Neil, Oct 14 2026): red is kept for a
  // breach or an Urgent priority, so a queue of new tickets no longer reads
  // as an alarm. Still never blue.
  it('Open is slate and In Progress amber - blue is not a status color', () => {
    expect(TICKET_STATUS_META.open.color).toBe('#64748b');
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

  // Neil, Oct 19: no one-click resolve on the row - a ticket is resolved
  // from inside it, with a comment.
  it('the list row has no Mark Resolved button', async () => {
    ME = 'req@example.com'; LEVEL = 1;
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    expect(screen.queryByRole('button', { name: /^Mark #?0*\d+ Resolved$/ })).toBeNull();
  });
});

// Neil, Oct 14 2026: "Assignee" and "Created" as the column words, the
// author's picture (not name) in the comment cell, and an unassigned ticket
// turning the Unassigned tile into a call to act.
describe('Ticket list - Oct 14 column and tile words', () => {
  it('heads the columns Assignee and Created', async () => {
    render(<TicketsView />);
    expect(await screen.findByText('Assignee')).toBeTruthy();
    expect(screen.getByText('Created')).toBeTruthy();
    expect(screen.queryByText('Assigned To')).toBeNull();
    expect(screen.queryByText('Created Date')).toBeNull();
  });

  it('shows the commenter as a picture, their name only on hover', async () => {
    render(<TicketsView />);
    const cell = await screen.findByRole('button', { name: /Latest comment by Ava Agent/ });
    expect(cell.getAttribute('title')).toMatch(/^Ava Agent/);
    expect(within(cell).queryByText(/Ava Agent/)).toBeNull();          // not as text...
    const pic = within(cell).getByTitle('Ava Agent');                    // ...but as their picture (initials here)
    expect(pic.textContent).toBe('AA');
    expect(pic.getAttribute('role')).toBeNull();                         // no hover card inside the button
    expect(within(cell).getByText(/Swapping the toner now/)).toBeTruthy();
  });

  it('marks the Unassigned tile Action Required while a ticket has no owner', async () => {
    render(<TicketsView />);
    const tile = (await screen.findByText('Unassigned', { selector: 'button span' })).closest('button');
    expect(tile.hasAttribute('data-action-required')).toBe(true);
    expect(within(tile).getByText('Action Required')).toBeTruthy();
    expect(within(tile).queryByText('nobody working them')).toBeNull();
  });
});

// Tickets to Assign (Oct 26 2026): the priority notice and the dashboard's
// My Open Tickets tile land on the desk's own list - a mounted screen hears
// the event, a first visit drains the pending note.
describe('Landing on a desk list', () => {
  it('Unassigned from the live event, Assigned to Me from the pending note', async () => {
    const { setPendingOpen } = await import('../lib/pendingOpen');
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    await act(async () => { window.dispatchEvent(new CustomEvent('nexus:ticket-filter', { detail: { filter: 'unassigned' } })); });
    expect(screen.queryByText('Printer jam')).toBeNull();          // assigned to Ava
    expect(screen.getByText('VPN down')).toBeTruthy();
    cleanup();
    setPendingOpen('ticketFilter', 'assigned');
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    expect(screen.queryByText('VPN down')).toBeNull();             // nobody's
  });
});
