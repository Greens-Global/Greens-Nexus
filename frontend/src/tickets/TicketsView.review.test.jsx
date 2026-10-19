import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

// Ticket list fixes from the Oct 2026 module review: select-all takes only the
// rows on screen (never the collapsed Completed section), bulk actions report
// what failed and keep it selected, and a saved view carries the Department
// filter and the sort.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 3, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'agent@example.com' }),
}));
vi.mock('../api', () => {
  const answer = (k) => (k === 'getToursSeen' ? { seen: { ticket: true, support: true } }
    : k === 'getTicketDepartments' ? [{ id: 'd1', name: 'IT' }, { id: 'd2', name: 'Facilities' }] : []);
  return { api: new Proxy({}, { get: (_, k) => () => Promise.resolve(answer(k)) }) };
});
vi.mock('./ticketAccess', () => ({ useTicketAccess: () => ({ canDelete: true, privileged: true, canWorkQueue: true, canReadInternal: true, onDesk: true }) }));
// A plain <select> stands in for the searchable picker.
vi.mock('./TicketAtoms', async (importOriginal) => ({
  ...(await importOriginal()),
  TicketSelect: ({ value, onChange, options, disabled }) => (
    <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {(options || []).map((o) => (Array.isArray(o) ? { id: o[0], label: o[1] } : o))
        .map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  ),
}));
const TICKETS = [
  { id: 't1', code: '000001', subject: 'Printer jam', status: 'open', priority: 'medium', type: 'incident', hrDepartmentId: 'd1',
    requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'none', typeFields: {}, createdAt: '2026-09-30T10:00:00', latestComment: null },
  { id: 't2', code: '000002', subject: 'Leaking sink', status: 'open', priority: 'high', type: 'incident', hrDepartmentId: 'd2',
    requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'none', typeFields: {}, createdAt: '2026-09-30T11:00:00', latestComment: null },
  { id: 't3', code: '000003', subject: 'Old monitor replaced', status: 'resolved', priority: 'low', type: 'incident', hrDepartmentId: 'd1',
    requesterId: 'req@example.com', assigneeId: 'agent@example.com', approvalStatus: 'none', typeFields: {}, createdAt: '2026-09-20T11:00:00', latestComment: null },
];
let VIEWS = [];
const deleteTicket = vi.fn(() => Promise.resolve());
const createTicketView = vi.fn((v) => Promise.resolve({ id: 'v9', ...v }));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: TICKETS, ticketsLoaded: true, ticketViews: VIEWS, tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => e, updateTicket: vi.fn(), deleteTicket, refresh: vi.fn(), reloadTickets: vi.fn(),
    createTicketView, deleteTicketView: vi.fn(() => Promise.resolve()) }),
}));

const { default: TicketsView, bulkFailureMessage } = await import('./TicketsView');
const { dialog } = await import('../ui/dialog');

afterEach(() => { cleanup(); vi.restoreAllMocks(); deleteTicket.mockReset(); deleteTicket.mockImplementation(() => Promise.resolve()); createTicketView.mockClear(); VIEWS = []; });

describe('Ticket list - select all', () => {
  it('takes only the rows on screen, not the collapsed Completed section', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    fireEvent.click(screen.getByTitle('Select all'));
    expect(screen.getByText('2 selected')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Delete/ })); });
    expect(deleteTicket.mock.calls.map((c) => c[0]).sort()).toEqual(['t1', 't2']);
  });

  it('includes Completed once that section is open', async () => {
    render(<TicketsView />);
    fireEvent.click(await screen.findByRole('button', { name: /Completed/ }));
    fireEvent.click(screen.getByTitle('Select all'));
    expect(screen.getByText('3 selected')).toBeTruthy();
  });
});

describe('Ticket list - bulk failures', () => {
  it('says how many failed and why, and keeps the failed ones selected', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const told = vi.spyOn(dialog, 'alert').mockResolvedValue(undefined);
    deleteTicket.mockImplementation((id) => (id === 't2' ? Promise.reject(new Error('Not allowed')) : Promise.resolve()));
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    fireEvent.click(screen.getByTitle('Select all'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Delete/ })); });
    expect(told).toHaveBeenCalled();
    expect(told.mock.calls[0][0]).toMatch(/^1 of 2 tickets could not be deleted: Not allowed/);
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('asks before a bulk delete and does nothing when declined', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    fireEvent.click(screen.getByTitle('Select all'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Delete/ })); });
    expect(deleteTicket).not.toHaveBeenCalled();
    expect(screen.getByText('2 selected')).toBeTruthy();
  });

  it('builds the message from the settled results', () => {
    const ok = { status: 'fulfilled', value: 1 };
    const bad = { status: 'rejected', reason: new Error('Locked') };
    expect(bulkFailureMessage([ok, ok], 2, 'updated')).toBe('');
    expect(bulkFailureMessage([bad, bad], 2, 'updated')).toBe('2 of 2 tickets could not be updated: Locked');
    expect(bulkFailureMessage([ok, { status: 'rejected', reason: {} }], 2, 'resolved'))
      .toBe('1 of 2 tickets could not be resolved. The rest went through; the ones that failed are still selected.');
  });
});

describe('Ticket list - saved views', () => {
  it('saves the Department filter and the sort with the view', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    const dept = (await screen.findAllByRole('combobox')).find((el) => [...el.options].some((o) => o.value === 'd1'));
    fireEvent.change(dept, { target: { value: 'd1' } });
    await waitFor(() => expect(screen.queryByText('Leaking sink')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save Current View/ }));
    fireEvent.change(screen.getByLabelText('View Name'), { target: { value: 'IT queue' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save View' })); });
    expect(createTicketView).toHaveBeenCalledTimes(1);
    const saved = createTicketView.mock.calls[0][0];
    expect(saved.name).toBe('IT queue');
    expect(saved.filters.hrDeptFilter).toBe('d1');
    expect(saved.filters.sort).toEqual({ key: 'created', dir: 'desc' });
  });

  it('applies the Department filter a view was saved with', async () => {
    VIEWS = [{ id: 'v1', name: 'Facilities only', view: 'list', group: 'none', filters: { hrDeptFilter: 'd2' } }];
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Facilities only' }));
    await waitFor(() => expect(screen.queryByText('Printer jam')).toBeNull());
    expect(screen.getByText('Leaking sink')).toBeTruthy();
  });

  it('asks before deleting a saved view', async () => {
    VIEWS = [{ id: 'v1', name: 'Facilities only', filters: {} }];
    const ask = vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete view Facilities only' })); });
    expect(ask).toHaveBeenCalled();
  });
});
