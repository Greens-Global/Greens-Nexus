import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Tickets, Oct 6 (Pranshu): the screen-recording area on Create a Ticket is its
// own obvious card; the Conversation can record / attach again ("if the same
// issue happens again there's no option to add a recording"); the list fits
// the screen instead of scrolling sideways; and Unassigned leads the summary
// tiles, in yellow.

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
  { id: 't1', code: '000001', subject: 'Printer jam', status: 'open', priority: 'medium', type: 'incident',
    requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'none', typeFields: {}, createdAt: '2026-09-30T10:00:00', latestComment: null },
  { id: 't2', code: '000002', subject: 'New laptop', status: 'open', priority: 'low', type: 'feature_request',
    requesterId: 'req@example.com', assigneeId: 'agent@example.com', approvalStatus: 'none', typeFields: {}, createdAt: '2026-09-30T11:00:00', latestComment: null },
];
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: TICKETS, ticketsLoaded: true, ticketViews: [], tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => e, updateTicket: vi.fn(), deleteTicket: vi.fn(), refresh: vi.fn(), createTicketView: vi.fn(), deleteTicketView: vi.fn() }),
}));

const { default: TicketsView, TicketDrawer, CreateTicketModal } = await import('./TicketsView');

afterEach(cleanup);

describe('Ticket summary tiles', () => {
  it('lead with Unassigned, tinted yellow, then Open', async () => {
    const { container } = render(<TicketsView />);
    await screen.findByText('Printer jam');
    const tiles = [...container.querySelector('[data-tour="ticket-tiles"]').children];
    expect(tiles[0].textContent).toContain('Unassigned');
    expect(tiles[1].textContent).toContain('Open');
    expect(tiles[0].style.background).toContain('245, 158, 11');   // amber/yellow, not red or white
  });
});

describe('Ticket list width', () => {
  it('fills the screen with elastic columns instead of a fixed, wider-than-screen grid', async () => {
    const { container } = render(<TicketsView />);
    await screen.findByText('Printer jam');
    const grid = container.querySelector('.nx-list-scroll > div');
    expect(grid.style.width).toBe('100%');
    expect(grid.style.getPropertyValue('--nx-grid')).toContain('minmax(200px, 260fr)');   // Title
  });
});

describe('Conversation can record and attach again', () => {
  it('offers Record Screen and Upload Attachment under the reply', async () => {
    render(<TicketDrawer ticketId="t1" onClose={vi.fn()} initialTab="conversation" />);
    expect(await screen.findByRole('button', { name: /Record Screen/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Upload Attachment/ })).toBeTruthy();
    expect(screen.getByText(/Saved to Attachments and linked in your reply/)).toBeTruthy();
  });

  it('follows the type: a feature request attaches files but does not record', async () => {
    render(<TicketDrawer ticketId="t2" onClose={vi.fn()} initialTab="conversation" />);
    expect(await screen.findByRole('button', { name: /Upload Attachment/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Record Screen/ })).toBeNull();
  });
});

describe('Create a Ticket recording card', () => {
  it('is its own titled card with the full-size Record Screen button', async () => {
    render(<CreateTicketModal onClose={vi.fn()} />);
    expect(await screen.findByText('Show Us the Problem')).toBeTruthy();
    expect(screen.getByText(/A short screen recording is the fastest way/)).toBeTruthy();
    const rec = screen.getByRole('button', { name: /Record Screen/ });
    expect(rec.style.fontSize).toBe('14px');   // the featured size, not the compact 12.5px
  });
});
