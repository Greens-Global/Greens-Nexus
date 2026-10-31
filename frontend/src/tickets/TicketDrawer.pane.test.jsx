import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

// The ticket drawer as a pane (Oct 31 2026): `inline` renders the same
// header / body / footer as a plain column with no popup overlay, so the
// desk can show it beside the list; `onPrev` / `onNext` add Previous and
// Next to the header, driven by the [ and ] keys when nobody is typing.

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
  useTasks: () => ({ tickets: [TICKET], ticketsLoaded: true, tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => e, updateTicket, refresh: vi.fn() }),
}));

const { TicketDrawer } = await import('./TicketsView');

afterEach(() => { cleanup(); updateTicket.mockClear(); });

const key = (k, target = document.body) => fireEvent.keyDown(target, { key: k });

describe('TicketDrawer as a pane', () => {
  it('inline renders the ticket as a plain column, not a dialog, with the footer actions', () => {
    render(<TicketDrawer inline ticketId="t1" onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    const root = screen.getByTestId('ticket-drawer');
    expect(within(root).getByText('Ticket #1')).toBeTruthy();
    expect(within(root).getByText('Printer jam')).toBeTruthy();
    expect(within(root).getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(within(root).getByRole('button', { name: 'Mark Resolved' })).toBeTruthy();
  });

  it('the popup still renders as a dialog when inline is off', () => {
    render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows Previous and Next when given, disabled where there is nothing to step to', () => {
    const onNext = vi.fn();
    render(<TicketDrawer inline ticketId="t1" onClose={() => {}} onPrev={null} onNext={onNext} />);
    const prev = screen.getByRole('button', { name: 'Previous' });
    const next = screen.getByRole('button', { name: 'Next' });
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('offers no Previous / Next when neither is given', () => {
    render(<TicketDrawer inline ticketId="t1" onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('[ and ] step to the previous and next ticket, but not while typing', () => {
    const onPrev = vi.fn(); const onNext = vi.fn();
    render(<TicketDrawer inline ticketId="t1" onClose={() => {}} onPrev={onPrev} onNext={onNext} />);
    key(']');
    key('[');
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).toHaveBeenCalledTimes(1);
    const field = document.createElement('input');
    document.body.appendChild(field);
    key(']', field);
    expect(onNext).toHaveBeenCalledTimes(1);
    field.remove();
  });

  it('a changed initialTab re-targets the open drawer without a remount - the held edit survives', async () => {
    const { rerender } = render(<TicketDrawer inline ticketId="t1" onClose={() => {}} />);
    const prioritySelect = () => screen.getAllByRole('combobox').find((el) => [...el.options].some((o) => o.value === 'urgent'));
    fireEvent.change(prioritySelect(), { target: { value: 'high' } });
    rerender(<TicketDrawer inline ticketId="t1" onClose={() => {}} initialTab="conversation" />);
    expect(await screen.findByText('No comments yet.')).toBeTruthy();   // the Conversation is showing
    fireEvent.click(screen.getByRole('button', { name: /Overview/ }));
    expect(prioritySelect().value).toBe('high');
  });

  it('[ and ] from a dialog over the pane are that dialog\'s, not the pane\'s', () => {
    const onNext = vi.fn();
    render(<TicketDrawer inline ticketId="t1" onClose={() => {}} onPrev={null} onNext={onNext} />);
    const dlg = document.createElement('div'); dlg.setAttribute('role', 'dialog');
    const btn = document.createElement('button'); dlg.appendChild(btn); document.body.appendChild(dlg);
    key(']', btn);
    expect(onNext).not.toHaveBeenCalled();
    dlg.remove();
    key(']');
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('the inline close button goes through the same close as the popup', () => {
    const onClose = vi.fn();
    render(<TicketDrawer inline ticketId="t1" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
