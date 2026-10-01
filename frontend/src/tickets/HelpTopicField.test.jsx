import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

// Oct 1 2026 (Neil): departments come from the company's global list and can
// be turned off for tickets; a help topic may have an optional "Which One?"
// second level (Microsoft -> Outlook), saved on typeFields.svc_helpSubtopic.
// Covers both the Submit a Ticket form and the ticket drawer.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 3, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'agent@example.com' }),
}));
const DEPTS = [
  { id: 'd1', name: 'IT', companyId: 'c1', enabled: true },
  // Off for tickets (Neil: "I don't want a construction ticket").
  { id: 'd2', name: 'Construction', companyId: 'c1', enabled: false },
];
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  const rows = {
    getMyTicketDepartments: () => Promise.resolve(DEPTS),
    getTicketDepartments: () => Promise.resolve(DEPTS),
    getTicketCompanies: () => Promise.resolve([{ id: 'c1', name: 'Greens' }]),
  };
  return { api: new Proxy({}, { get: (_, k) => rows[k] || empty }) };
});
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
const MS = 'Microsoft (Outlook, Teams, OneDrive)';
const TICKET = {
  id: 't1', code: '000001', subject: 'Mail down', status: 'open', priority: 'medium', type: 'incident',
  requesterId: 'agent@example.com', assigneeId: '', approvalStatus: 'none',
  companyId: 'c1', hrDepartmentId: 'd1', application: MS, typeFields: {},
};
const createTicket = vi.fn(() => Promise.resolve({ id: 't9' }));
const updateTicket = vi.fn(() => Promise.resolve(TICKET));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: [TICKET], tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => e, createTicket, updateTicket, refresh: vi.fn() }),
}));

const { HELP_TOPICS } = await import('./ticketMeta');
const { CreateTicketModal, TicketDrawer } = await import('./TicketsView');

beforeEach(() => {
  HELP_TOPICS.length = 0;
  HELP_TOPICS.push({ label: 'IT', departments: ['it'], topics: [
    { name: MS, area: 'email', options: ['Outlook', 'Teams', 'OneDrive'] },
    { name: 'Egnyte', area: 'files' },
  ] });
});
afterEach(() => { cleanup(); createTicket.mockClear(); updateTicket.mockClear(); });

const selectWith = (value) => screen.getAllByRole('combobox')
  .find((el) => [...el.options].some((o) => o.value === value));

describe('Submit a Ticket - departments and Which One?', () => {
  it('offers only the departments turned on for tickets', async () => {
    render(<CreateTicketModal onClose={vi.fn()} />);
    await waitFor(() => expect(selectWith('d1')).toBeTruthy());
    expect([...selectWith('d1').options].map((o) => o.textContent)).not.toContain('Construction');
  });

  it('asks Which One? for a topic that has sub-options and saves the answer', async () => {
    render(<CreateTicketModal onClose={vi.fn()} />);
    await waitFor(() => expect(selectWith('d1')).toBeTruthy());
    fireEvent.change(selectWith('d1'), { target: { value: 'd1' } });
    // Egnyte has no sub-options - nothing more is asked.
    fireEvent.change(selectWith('Egnyte'), { target: { value: 'Egnyte' } });
    expect(screen.queryByText('Which One?')).toBeNull();
    fireEvent.change(selectWith(MS), { target: { value: MS } });
    expect(screen.getByText('Which One?')).toBeTruthy();
    fireEvent.change(selectWith('Outlook'), { target: { value: 'Outlook' } });

    fireEvent.change(screen.getByPlaceholderText(/What is the issue\?/), { target: { value: 'Mail will not send' } });
    fireEvent.click(screen.getByText('One User'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' })); });
    expect(createTicket).toHaveBeenCalledTimes(1);
    const sent = createTicket.mock.calls[0][0];
    expect(sent.application).toBe(MS);
    expect(sent.typeFields.svc_helpSubtopic).toBe('Outlook');
  });

  it('clears the answer when a different topic is picked', async () => {
    render(<CreateTicketModal onClose={vi.fn()} />);
    await waitFor(() => expect(selectWith('d1')).toBeTruthy());
    fireEvent.change(selectWith('d1'), { target: { value: 'd1' } });
    fireEvent.change(selectWith(MS), { target: { value: MS } });
    fireEvent.change(selectWith('Outlook'), { target: { value: 'Outlook' } });
    fireEvent.change(selectWith('Egnyte'), { target: { value: 'Egnyte' } });
    fireEvent.change(screen.getByPlaceholderText(/What is the issue\?/), { target: { value: 'Folder gone' } });
    fireEvent.click(screen.getByText('One User'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' })); });
    expect(createTicket.mock.calls[0][0].typeFields.svc_helpSubtopic).toBeUndefined();
  });
});

describe('Ticket drawer - Which One?', () => {
  it('shows the topic\'s sub-options and saves the pick on Done', async () => {
    render(<TicketDrawer ticketId="t1" onClose={vi.fn()} />);
    await waitFor(() => expect(selectWith('Outlook')).toBeTruthy());
    fireEvent.change(selectWith('Outlook'), { target: { value: 'Teams' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    expect(updateTicket).toHaveBeenCalledWith('t1', { typeFields: { svc_helpSubtopic: 'Teams' } });
  });
});
