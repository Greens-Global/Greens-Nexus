import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// The desk's default columns (Tickets desk re-cut, 10/31/2026): the floors
// fit a 1,300 px list without a sideways scroll, and widths someone saved
// under the old 'tickets' key never squeeze the elastic Title (the key moved
// to 'tickets-v3' for exactly that reason).

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
];
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: TICKETS, ticketsLoaded: true, ticketViews: [], tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => e, updateTicket: vi.fn(), deleteTicket: vi.fn(), refresh: vi.fn(), createTicketView: vi.fn(), deleteTicketView: vi.fn() }),
}));

const { default: TicketsView } = await import('./TicketsView');
const { TICKET_COLUMNS } = await import('./ticketViewShared');
const { __setTablePrefsCache } = await import('../tasks/tableCols');

afterEach(() => { cleanup(); __setTablePrefsCache(null); });

describe('ticket list columns', () => {
  it('default floors fit a 1,300 px list, Company and Created ship hidden', () => {
    const shown = TICKET_COLUMNS.filter((c) => !c.defaultHidden && c.key !== 'company');
    const floor = shown.reduce((sum, c) => sum + (c.shrink ?? c.minWidth ?? c.width), 0);
    expect(floor).toBeLessThanOrEqual(1300);
    expect(TICKET_COLUMNS.find((c) => c.key === 'created').defaultHidden).toBe(true);
    expect(TICKET_COLUMNS.find((c) => c.key === 'title').template).toBe('minmax(260px, 1fr)');
  });

  it('widths saved under the old table key do not shrink the Title', async () => {
    __setTablePrefsCache({ tickets: { widths: { title: 120, state: 60 } } });
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    const grid = document.querySelector('[style*="--nx-grid"]');
    expect(grid.style.getPropertyValue('--nx-grid')).toContain('minmax(260px, 1fr)');
  });
});
