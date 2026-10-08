import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// The ticket drawer holds every edit until Done (Pranshu, Oct 1): changing a
// field saves nothing and tells the requester nothing; Done sends it all as
// ONE save; closing with unsaved edits asks first.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 3, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'agent@example.com' }),
}));
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  return { api: new Proxy({}, { get: () => empty }) };
});
// A plain <select> stands in for the searchable picker - this test is about
// when the drawer saves, not how the picker opens.
vi.mock('./TicketAtoms', async (importOriginal) => ({
  ...(await importOriginal()),
  TicketSelect: ({ value, onChange, options, disabled }) => (
    <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {(options || []).map((o) => (Array.isArray(o) ? { id: o[0], label: o[1] } : o))
        .map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  ),
}));
const TICKET = {
  id: 't1', code: '000001', subject: 'Printer jam', status: 'open', priority: 'medium', type: 'incident',
  requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'none', typeFields: {},
};
const updateTicket = vi.fn(() => Promise.resolve(TICKET));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: [TICKET], tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => e, updateTicket, refresh: vi.fn() }),
}));

const { TicketDrawer } = await import('./TicketsView');

afterEach(() => { cleanup(); updateTicket.mockClear(); vi.restoreAllMocks(); });

const prioritySelect = () => screen.getAllByRole('combobox').find((el) => [...el.options].some((o) => o.value === 'urgent'));

describe('TicketDrawer saves on Done only', () => {
  it('holds a field change until Done, then saves it in one call', async () => {
    const onClose = vi.fn();
    render(<TicketDrawer ticketId="t1" onClose={onClose} />);
    fireEvent.change(prioritySelect(), { target: { value: 'high' } });
    expect(updateTicket).not.toHaveBeenCalled();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    expect(updateTicket).toHaveBeenCalledTimes(1);
    expect(updateTicket).toHaveBeenCalledWith('t1', { priority: 'high' });
    expect(onClose).toHaveBeenCalled();
  });

  it('saves nothing when a field is put back the way it was', async () => {
    const onClose = vi.fn();
    render(<TicketDrawer ticketId="t1" onClose={onClose} />);
    fireEvent.change(prioritySelect(), { target: { value: 'high' } });
    fireEvent.change(prioritySelect(), { target: { value: 'medium' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    expect(updateTicket).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('asks before throwing unsaved changes away', () => {
    const onClose = vi.fn();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<TicketDrawer ticketId="t1" onClose={onClose} />);
    fireEvent.change(prioritySelect(), { target: { value: 'high' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(ask).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(updateTicket).not.toHaveBeenCalled();
  });
});
