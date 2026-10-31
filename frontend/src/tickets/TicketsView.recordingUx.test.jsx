import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// A computer: the browser can record a screen (Record Screen hides where it cannot - a phone, Oct 30 2026).
if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia: () => {} }, configurable: true });

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

describe('The desk bar', () => {
  // One bar of work queues (Neil, 10/31/2026) in place of the summary tiles:
  // Needs Reply leads, Unassigned next with its count in amber while anything
  // has no owner (the Oct 14 call to act, carried over), Create at the end.
  it('leads with Needs Reply, then Unassigned with an amber count, and no tiles', async () => {
    const { container } = render(<TicketsView />);
    await screen.findByText('Printer jam');
    expect(container.querySelector('[data-tour="ticket-tiles"]')).toBeNull();
    const tabs = [...container.querySelectorAll('[data-tour="ticket-scope"] button')];
    expect(tabs[0].textContent).toContain('Needs Reply');
    expect(tabs[1].textContent).toContain('Unassigned');
    expect(tabs[1].querySelector('.hdr-tab-badge--alarm')).toBeTruthy();
    expect(tabs[tabs.length - 1].textContent).toContain('+ View');
    expect(screen.getByRole('button', { name: /Create/ })).toBeTruthy();
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

// The red card became a calm bar under the description (Neil, Oct 28 2026).
describe('Create a Ticket recording bar', () => {
  it('puts Record Screen and Attach File right under the description', async () => {
    render(<CreateTicketModal onClose={vi.fn()} />);
    const rec = await screen.findByRole('button', { name: /Record Screen/ });
    expect(screen.getByRole('button', { name: /Attach File/ })).toBeTruthy();
    expect(screen.getByText(/press Ctrl\+V to paste a screenshot/)).toBeTruthy();
    expect(screen.queryByText('Show Us the Problem')).toBeNull();
    expect(rec.style.fontSize).toBe('12.5px');
  });
});
