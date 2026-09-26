import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Ticket deflection (Sep 26): while a ticket is written, the create form
// shows Suggested Articles from the user guide. They must appear for a
// matching title, stay absent for junk, open inline without touching the
// draft, and "This Solved My Problem" closes the form without creating a
// ticket. Submitting is never blocked.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@example.com' }),
}));
// Every API the form touches resolves empty: no departments, no application
// directory, no people - so step 1 has nothing required and step 2 opens.
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  return { api: new Proxy({}, { get: () => empty }) };
});
const createTicket = vi.fn(() => Promise.resolve({ id: 't1' }));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ createTicket, projects: [], myEmail: 'me@example.com' }),
}));

const { CreateTicketModal } = await import('./TicketsView');

afterEach(() => { cleanup(); createTicket.mockClear(); document.querySelectorAll('.help-toast').forEach((n) => n.remove()); });

async function openDetails(onClose = vi.fn()) {
  render(<CreateTicketModal onClose={onClose} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
  return { onClose, title: await screen.findByPlaceholderText('What is the issue?') };
}

// Past the 250 ms debounce.
const settle = () => act(() => new Promise((r) => { setTimeout(r, 320); }));

describe('CreateTicketModal suggested articles', () => {
  it('shows suggestions for a matching title', async () => {
    const { title } = await openDetails();
    fireEvent.change(title, { target: { value: 'Need PTO next week' } });
    await settle();
    const block = screen.getByTestId('ticket-deflection');
    expect(block.textContent).toContain('Suggested Articles');
    expect(block.textContent).toContain('Request Time Off');
    expect(screen.getByRole('button', { name: /This Solved My Problem/ })).toBeTruthy();
  });

  it('shows nothing for junk', async () => {
    const { title } = await openDetails();
    fireEvent.change(title, { target: { value: 'asdf qwerty zxcv' } });
    await settle();
    expect(screen.queryByTestId('ticket-deflection')).toBeNull();
    expect(screen.queryByText('Suggested Articles')).toBeNull();
  });

  it('opens an article inline and keeps the draft', async () => {
    const { title } = await openDetails();
    fireEvent.change(title, { target: { value: 'Need PTO next week' } });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /Request Time Off/ }));
    expect(screen.getByText('Click the Time Off tab.')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Open Full Article/ });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('href')).toContain('/support/documentation?doc=workday');
    expect(title.value).toBe('Need PTO next week');
  });

  it('"This Solved My Problem" closes without creating a ticket', async () => {
    const { title, onClose } = await openDetails();
    fireEvent.change(title, { target: { value: 'Need PTO next week' } });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /This Solved My Problem/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createTicket).not.toHaveBeenCalled();
    expect(document.querySelector('.help-toast')?.textContent).toMatch(/No ticket was created/);
  });

  it('"Still Need Help" hides the suggestions and the ticket still submits', async () => {
    const { title, onClose } = await openDetails();
    fireEvent.change(title, { target: { value: 'Need PTO next week' } });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Still Need Help' }));
    expect(screen.queryByTestId('ticket-deflection')).toBeNull();
    // The default Incident type's one required question.
    fireEvent.click(screen.getByText('One User'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' })); });
    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(createTicket.mock.calls[0][0].subject).toBe('Need PTO next week');
    expect(onClose).toHaveBeenCalled();
  });
});
