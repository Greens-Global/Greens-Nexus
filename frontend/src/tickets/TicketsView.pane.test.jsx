import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';

// The desk's side pane (Neil, 10/31/2026): a per-person layout where a row
// opens the ticket beside the list instead of over it, ↑ ↓ step through the
// queue with the conversation in view, Previous / Next live in the pane's
// header, and Escape clears the pane. Desktop and the List view only.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 3, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'agent@example.com' }),
}));
vi.mock('../api', () => {
  const answer = (k) => (k === 'getToursSeen' ? { seen: { ticket: true, support: true } } : []);
  return { api: new Proxy({}, { get: (_, k) => () => Promise.resolve(answer(k)) }) };
});
const TICKETS = [
  { id: 't1', code: '000001', subject: 'Printer jam', status: 'in_progress', priority: 'medium', type: 'incident',
    requesterId: 'req@example.com', assigneeId: 'agent@example.com', approvalStatus: 'none', typeFields: {},
    createdAt: '2026-09-30T10:00:00', latestComment: null },
  { id: 't2', code: '000002', subject: 'VPN down', status: 'open', priority: 'high', type: 'incident',
    requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'none', typeFields: {}, createdAt: '2026-09-30T11:00:00', latestComment: null },
  { id: 't3', code: '000003', subject: 'Badge reader offline', status: 'open', priority: 'medium', type: 'incident',
    requesterId: 'req@example.com', assigneeId: 'other@example.com', approvalStatus: 'none', typeFields: {},
    createdAt: '2026-09-29T09:00:00', latestComment: null },
];
const updateTicket = vi.fn((id, p) => Promise.resolve({ ...TICKETS.find((t) => t.id === id), ...p }));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: TICKETS, ticketsLoaded: true, ticketViews: [], tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => ({ 'agent@example.com': 'Ava Agent', 'req@example.com': 'Rex Requester' })[e] || e,
    updateTicket, deleteTicket: vi.fn(), refresh: vi.fn(), createTicketView: vi.fn(), deleteTicketView: vi.fn() }),
}));

const { default: TicketsView } = await import('./TicketsView');
const { __setTablePrefsCache } = await import('../tasks/tableCols');

const key = (k, target = document.body) => fireEvent.keyDown(target, { key: k });
const drawer = () => screen.queryByTestId('ticket-drawer');

beforeEach(() => { __setTablePrefsCache({ 'tickets-v3': { layout: 'pane' } }); });
afterEach(() => { cleanup(); updateTicket.mockClear(); __setTablePrefsCache(null); });

describe('Tickets desk - side pane', () => {
  it('opens a clicked row beside the list, not as a popup, and Escape clears it', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    expect(screen.getByText('Pick a ticket')).toBeTruthy();
    fireEvent.click(screen.getByText('Printer jam'));
    const pane = await screen.findByTestId('ticket-drawer');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(pane).getByText('Ticket #1')).toBeTruthy();
    // The list is still there beside it, compressed to the columns that matter.
    expect(screen.getByText('VPN down')).toBeTruthy();
    expect(screen.queryByTitle('Sort by Requester')).toBeNull();
    expect(screen.getByTitle('Sort by Next Clock')).toBeTruthy();
    key('Escape');
    await waitFor(() => expect(drawer()).toBeNull());
    expect(screen.getByText('Pick a ticket')).toBeTruthy();
  });

  it('↓ opens tickets as it moves, and Next / Previous step through the queue', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    key('ArrowDown');
    let pane = await screen.findByTestId('ticket-drawer');
    expect(within(pane).getByText('Ticket #1')).toBeTruthy();
    key('ArrowDown');
    await waitFor(() => expect(within(screen.getByTestId('ticket-drawer')).getByText('Ticket #2')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(within(screen.getByTestId('ticket-drawer')).getByText('Ticket #3')).toBeTruthy());
    // Nothing after the last row.
    expect(screen.getByRole('button', { name: /Next/ }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Previous/ }));
    await waitFor(() => expect(within(screen.getByTestId('ticket-drawer')).getByText('Ticket #2')).toBeTruthy());
    pane = screen.getByTestId('ticket-drawer');
    expect(pane).toBeTruthy();
  });

  it('is a switch in the More menu, on here, and the Board ignores the pane', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const sw = screen.getByLabelText('Open Tickets in a Side Pane');
    expect(sw.checked).toBe(true);
    key('Escape');
    fireEvent.click(screen.getByRole('button', { name: /Board/ }));
    await screen.findByTestId('ticket-board');
    expect(screen.queryByText('Pick a ticket')).toBeNull();
  });
});
