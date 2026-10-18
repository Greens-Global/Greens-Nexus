import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

// Ticket drawer fixes from the Oct 2026 module review: a screenshot pasted into
// the description or a reply is stored in ticket evidence before Done sends
// it (never base64 in the ticket), deleting a comment asks first and says when
// it failed, a save over someone else's change asks first, and a ticket that
// is not there says so instead of rendering nothing.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 3, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'agent@example.com' }),
}));
const apiMock = {
  getTicketComments: vi.fn(() => Promise.resolve([
    { id: 'c1', authorId: 'req@example.com', body: '<p>Still broken</p>', createdAt: '2026-10-01T10:00:00', internal: false },
  ])),
  deleteTicketComment: vi.fn(() => Promise.resolve()),
  addTicketAttachment: vi.fn(() => Promise.resolve({})),
};
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => apiMock[k] || (() => Promise.resolve([])) }),
}));
vi.mock('./ticketAccess', () => ({ useTicketAccess: () => ({ canDelete: true, privileged: true, canWorkQueue: true, canReadInternal: true, onDesk: true }) }));
vi.mock('./evidenceUpload', () => ({ uploadTicketEvidence: vi.fn(() => Promise.resolve('https://store/ticket-evidence/pasted.png')) }));
// A textarea stands in for the contentEditable editor.
vi.mock('../tasks/RichDescription', async (importOriginal) => ({
  ...(await importOriginal()),
  default: ({ value, onChange, placeholder }) => (
    <textarea aria-label={placeholder} value={value || ''} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock('./TicketAtoms', async (importOriginal) => ({
  ...(await importOriginal()),
  TicketSelect: ({ value, onChange, options, disabled }) => (
    <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {(options || []).map((o) => (Array.isArray(o) ? { id: o[0], label: o[1] } : o))
        .map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  ),
}));
const BASE = {
  id: 't1', code: '000001', subject: 'Printer jam', description: '<p>It jams</p>', status: 'open', priority: 'medium', type: 'incident',
  requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'none', typeFields: {}, modifiedAt: '2026-10-01T09:00:00',
};
const store = { tickets: [BASE], ticketsLoaded: true };
const updateTicket = vi.fn((id, p) => Promise.resolve({ ...BASE, ...p, modifiedAt: '2026-10-01T09:05:00' }));
const reloadTickets = vi.fn(() => Promise.resolve());
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ ...store, tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => e, updateTicket, refresh: vi.fn(), reloadTickets }),
}));

const { TicketDrawer } = await import('./TicketsView');
const { dialog } = await import('../ui/dialog');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  updateTicket.mockClear(); reloadTickets.mockClear();
  apiMock.deleteTicketComment.mockReset(); apiMock.deleteTicketComment.mockImplementation(() => Promise.resolve());
  apiMock.addTicketAttachment.mockClear();
  store.tickets = [BASE]; store.ticketsLoaded = true;
});

describe('TicketDrawer - pasted screenshots', () => {
  it('stores a screenshot pasted into the description before Done sends it', async () => {
    render(<TicketDrawer ticketId="t1" onClose={() => {}} startEditing />);
    fireEvent.change(screen.getByLabelText('Describe the issue'), { target: { value: `<p>See this</p><img src="${PNG}">` } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    expect(updateTicket).toHaveBeenCalledTimes(1);
    const sent = updateTicket.mock.calls[0][1];
    expect(sent.description).toContain('src="https://store/ticket-evidence/pasted.png"');
    expect(sent.description).not.toContain('data:image');
    // Filed under Attachments too, like the create form does.
    expect(apiMock.addTicketAttachment).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'image', url: 'https://store/ticket-evidence/pasted.png' }));
  });

  it('stores a screenshot pasted into a reply before Done sends it', async () => {
    render(<TicketDrawer ticketId="t1" onClose={() => {}} initialTab="conversation" />);
    const box = await screen.findByLabelText('Public reply…');
    fireEvent.change(box, { target: { value: `<p>Here</p><img src="${PNG}">` } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    const sent = updateTicket.mock.calls[0][1];
    expect(sent.comment).toContain('https://store/ticket-evidence/pasted.png');
    expect(sent.comment).not.toContain('data:image');
  });
});

describe('TicketDrawer - someone else changed it', () => {
  it('asks before saving over a field another person changed', async () => {
    const ask = vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    const onClose = vi.fn();
    const { rerender } = render(<TicketDrawer ticketId="t1" onClose={onClose} />);
    const prio = () => screen.getAllByRole('combobox').find((el) => [...el.options].some((o) => o.value === 'urgent'));
    fireEvent.change(prio(), { target: { value: 'high' } });
    // Meanwhile the background refresh brings in another agent's save.
    store.tickets = [{ ...BASE, priority: 'urgent', modifiedAt: '2026-10-01T09:03:00' }];
    rerender(<TicketDrawer ticketId="t1" onClose={onClose} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    expect(ask).toHaveBeenCalledWith(expect.stringMatching(/changed by someone else/), expect.anything());
    expect(updateTicket).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not ask when nothing it is sending changed underneath', async () => {
    const ask = vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const { rerender } = render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    const prio = () => screen.getAllByRole('combobox').find((el) => [...el.options].some((o) => o.value === 'urgent'));
    fireEvent.change(prio(), { target: { value: 'high' } });
    store.tickets = [{ ...BASE, subject: 'Printer jam (2nd floor)', modifiedAt: '2026-10-01T09:03:00' }];
    rerender(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    expect(ask).not.toHaveBeenCalled();
    expect(updateTicket).toHaveBeenCalledWith('t1', { priority: 'high' });
  });
});

describe('TicketDrawer - deleting a comment', () => {
  it('asks first, and deletes nothing when declined', async () => {
    const ask = vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    render(<TicketDrawer ticketId="t1" onClose={() => {}} initialTab="conversation" />);
    const del = await screen.findByRole('button', { name: 'Delete comment' });
    await act(async () => { fireEvent.click(del); });
    expect(ask).toHaveBeenCalled();
    expect(apiMock.deleteTicketComment).not.toHaveBeenCalled();
  });

  it('deletes once confirmed and refreshes only the tickets', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    render(<TicketDrawer ticketId="t1" onClose={() => {}} initialTab="conversation" />);
    const del = await screen.findByRole('button', { name: 'Delete comment' });
    await act(async () => { fireEvent.click(del); });
    expect(apiMock.deleteTicketComment).toHaveBeenCalledWith('c1');
    expect(reloadTickets).toHaveBeenCalled();
  });

  it('says so when the delete fails', async () => {
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const told = vi.spyOn(dialog, 'alert').mockResolvedValue(undefined);
    apiMock.deleteTicketComment.mockImplementation(() => Promise.reject(new Error('Forbidden')));
    render(<TicketDrawer ticketId="t1" onClose={() => {}} initialTab="conversation" />);
    const del = await screen.findByRole('button', { name: 'Delete comment' });
    await act(async () => { fireEvent.click(del); });
    await waitFor(() => expect(told).toHaveBeenCalledWith(expect.stringMatching(/Forbidden/), expect.anything()));
  });
});

describe('TicketDrawer - a ticket that is not there', () => {
  it('pulls the tickets once more, then shows a Ticket Not Found card that closes', async () => {
    const onClose = vi.fn();
    render(<TicketDrawer ticketId="gone" onClose={onClose} />);
    expect(await screen.findByText('Ticket Not Found')).toBeTruthy();
    expect(reloadTickets).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/no longer have access to this ticket/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
