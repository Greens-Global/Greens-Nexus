import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

// Help Center (Oct 2026): a question handed over from Ask Nexus opens the
// ticket form already filled in; a ticket filed after searching here is
// recorded as "searched, then filed" (support/helpLog.js); a posted Known
// Issue shows at the top of the form.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@example.com' }),
}));
const logged = [];
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  const named = {
    helpSearchLog: (q, results, source) => { logged.push({ q, results, source }); return Promise.resolve(null); },
    helpKnownIssues: () => Promise.resolve({ issues: [{ id: 'i1', title: 'Email Is Delayed', note: '', severity: 'warning', until: '' }], canEdit: false }),
  };
  return { api: new Proxy({}, { get: (_, k) => named[k] || empty }) };
});
const createTicket = vi.fn(() => Promise.resolve({ id: 't1' }));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ createTicket, projects: [], myEmail: 'me@example.com' }),
}));

const { CreateTicketModal } = await import('./TicketsView');

afterEach(() => { cleanup(); createTicket.mockClear(); logged.length = 0; });

describe('CreateTicketModal handed a question from help', () => {
  it('starts with the question, shows the known issue, and records the search when filed', async () => {
    const onClose = vi.fn();
    render(<CreateTicketModal onClose={onClose} initial={{ subject: 'Paystub <missing> for October', description: 'Paystub <missing> for October' }} />);
    const title = await screen.findByPlaceholderText(/What is the issue\?/);
    expect(title.value).toBe('Paystub <missing> for October');
    expect(await screen.findByText(/Known Issue: Email Is Delayed/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Front gate keypad/), { target: { value: 'Payroll' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' })); });
    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(createTicket.mock.calls[0][0].subject).toBe('Paystub <missing> for October');
    // Plain text went in as escaped HTML, never as markup.
    expect(createTicket.mock.calls[0][0].description).toContain('&lt;missing&gt;');
    // With how many Suggested Articles it was showing when they filed anyway.
    await waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toMatchObject({ q: 'Paystub <missing> for October', source: 'ticket-form' });
    expect(typeof logged[0].results).toBe('number');
  });
});
