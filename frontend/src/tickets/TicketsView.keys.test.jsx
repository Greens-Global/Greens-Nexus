import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';

// Keyboard flow on the desk in its default (popup) layout (Neil, 10/31/2026):
// ↑ ↓ move a highlight through the list, Enter opens the highlighted ticket,
// and keys typed into the search box are the box's.

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
];
const updateTicket = vi.fn((id, p) => Promise.resolve({ ...TICKETS.find((t) => t.id === id), ...p }));
// Per-test changes to the store (the first-load tests below).
const over = {};
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: TICKETS, ticketsLoaded: true, ticketViews: [], tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => e, updateTicket, deleteTicket: vi.fn(), refresh: vi.fn(), createTicketView: vi.fn(), deleteTicketView: vi.fn(), ...over }),
}));

const { default: TicketsView } = await import('./TicketsView');

const key = (k, target = document.body) => fireEvent.keyDown(target, { key: k });
const focusedRow = () => document.querySelector('.nx-row-hover[data-focused="true"]');

afterEach(() => { cleanup(); updateTicket.mockClear(); for (const k of Object.keys(over)) delete over[k]; });

describe('Tickets desk - keyboard in the popup layout', () => {
  it('↑ ↓ highlight a row and Enter opens it as the popup', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    expect(focusedRow()).toBeNull();
    key('ArrowDown');
    expect(within(focusedRow()).getByText('Printer jam')).toBeTruthy();
    key('ArrowDown');
    expect(within(focusedRow()).getByText('VPN down')).toBeTruthy();
    key('ArrowUp');
    expect(within(focusedRow()).getByText('Printer jam')).toBeTruthy();
    // Nothing opened yet - the highlight is only a highlight.
    expect(screen.queryByRole('dialog')).toBeNull();
    key('Enter');
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('Ticket #1')).toBeTruthy();
    // Previous / Next are offered in the popup too, in the list's order.
    expect(within(dlg).getByRole('button', { name: /Next/ }).disabled).toBe(false);
    expect(within(dlg).getByRole('button', { name: /Previous/ }).disabled).toBe(true);
  });

  it('leaves the arrow keys to the search box while typing in it', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    const box = screen.getByLabelText('Search tickets');
    box.focus();
    key('ArrowDown', box);
    expect(focusedRow()).toBeNull();
  });
});

// The first load (11/17/2026): a list that has not arrived, or could not be
// read, is never "No Tickets Yet".
describe('Tickets desk - before the list has loaded', () => {
  it('shows rows loading, not an empty desk, until the first load lands', () => {
    Object.assign(over, { tickets: [], ticketsLoaded: false });
    render(<TicketsView />);
    expect(screen.getByTestId('tickets-loading').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('No Tickets Yet')).toBeNull();
  });

  it('says a failed load failed, and Try Again reads the list again', async () => {
    let finish;
    const reloadTickets = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    Object.assign(over, { tickets: [], ticketsLoaded: true, ticketsFailed: true, reloadTickets });
    render(<TicketsView />);
    expect(screen.getByTestId('tickets-failed').textContent).toContain('Tickets Could Not Be Loaded');
    expect(screen.queryByText('No Tickets Yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(reloadTickets).toHaveBeenCalledTimes(1);
    // Loading again while it reads; failed again if it still did not come.
    expect(screen.getByTestId('tickets-loading')).toBeTruthy();
    await act(async () => { finish(); });
    expect(screen.getByTestId('tickets-failed')).toBeTruthy();
  });

  it('an empty list that did load still says No Tickets Yet', () => {
    Object.assign(over, { tickets: [], ticketsLoaded: true, ticketsFailed: false });
    render(<TicketsView />);
    expect(screen.getByText('No Tickets Yet')).toBeTruthy();
    expect(screen.queryByTestId('tickets-loading')).toBeNull();
    expect(screen.queryByTestId('tickets-failed')).toBeNull();
  });
});

// A task open over the desk owns the keys (11/17/2026).
describe('Tickets desk - a task drawer open over it', () => {
  it('the arrows do not walk the list underneath', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    const drawer = document.createElement('div');
    drawer.setAttribute('data-nx-task-drawer', '');
    document.body.appendChild(drawer);
    key('ArrowDown');
    expect(focusedRow()).toBeNull();
    drawer.remove();
    key('ArrowDown');
    expect(within(focusedRow()).getByText('Printer jam')).toBeTruthy();
  });
});
