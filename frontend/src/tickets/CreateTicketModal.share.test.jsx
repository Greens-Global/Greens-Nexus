import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Share to Nexus (lib/shareTarget.js): a ticket started from the phone's
// share sheet opens with the words filled in and the shared files already in
// the form's own attachment list - uploaded by the form's own save, once the
// ticket exists, like any file picked in the form.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@example.com' }),
}));
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  return { api: new Proxy({}, { get: () => empty }) };
});
const uploaded = [];
vi.mock('./ticketViewShared', async (importOriginal) => ({
  ...(await importOriginal()),
  uploadTicketFile: vi.fn(async (ticketId, file) => { uploaded.push({ ticketId, name: file.name }); return true; }),
}));
const createTicket = vi.fn(() => Promise.resolve({ id: 't1' }));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ createTicket, projects: [], myEmail: 'me@example.com' }),
}));

const { CreateTicketModal } = await import('./TicketsView');
const { shareSeed } = await import('../lib/shareTarget');

afterEach(() => { cleanup(); createTicket.mockClear(); uploaded.length = 0; });

describe('CreateTicketModal started from Share to Nexus', () => {
  it('opens with the words and the shared files, and nothing is uploaded until the ticket is created', async () => {
    const photo = new File(['x'], 'gate-keypad.jpg', { type: 'image/jpeg' });
    const initial = shareSeed('ticket', { title: '', text: 'Front gate keypad is dead\nNo lights at all', url: '', files: [photo] });
    render(<CreateTicketModal onClose={vi.fn()} initial={initial} />);
    const title = await screen.findByPlaceholderText(/What is the issue\?/);
    expect(title.value).toBe('Front gate keypad is dead');
    expect(await screen.findByText(/gate-keypad\.jpg/)).toBeTruthy();
    expect(uploaded).toEqual([]);
    fireEvent.change(screen.getByPlaceholderText(/Front gate keypad/), { target: { value: 'Gate' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' })); });
    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(createTicket.mock.calls[0][0].description).toContain('No lights at all');
    expect(uploaded).toEqual([{ ticketId: 't1', name: 'gate-keypad.jpg' }]);
  });
});
