import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Create a Ticket intake, Neil's Oct 1 2026 review:
//   - the type opens on Incident ("nine times out of ten it is simply an incident");
//   - a Requester field under the title, defaulting to me (who it is FOR);
//   - incident questions are dropdowns, pre-answered (One User, now);
//   - "Error message, if you saw one" only once the department is IT.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@example.com' }),
}));
// Two departments, one of them IT; everything else resolves empty.
const DEPTS = [{ id: 'd-it', name: 'IT' }, { id: 'd-fac', name: 'Facilities' }];
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  const named = { getMyTicketDepartments: () => Promise.resolve(DEPTS), getTicketDepartments: () => Promise.resolve(DEPTS) };
  return { api: new Proxy({}, { get: (_, k) => named[k] || empty }) };
});
const createTicket = vi.fn(() => Promise.resolve({ id: 't1' }));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ createTicket, projects: [], myEmail: 'me@example.com' }),
}));

const { CreateTicketModal } = await import('./TicketsView');

afterEach(() => { cleanup(); createTicket.mockClear(); });

async function open() {
  render(<CreateTicketModal onClose={vi.fn()} />);
  return screen.findByPlaceholderText(/What is the issue\?/);
}

async function pickDepartment(name) {
  fireEvent.click(await screen.findByText('Select department'));
  fireEvent.click(await screen.findByText(name));
}

const ERROR_Q = 'Error message, if you saw one';

describe('CreateTicketModal intake (Oct 1)', () => {
  it('opens on Incident, with its questions pre-answered as dropdowns', async () => {
    await open();
    expect(screen.getByText('Incident Details')).toBeTruthy();
    // Who is affected? is a dropdown showing its default, not a row of chips.
    expect(screen.getByText('Who is affected?')).toBeTruthy();
    expect(screen.getByText('One User')).toBeTruthy();
    expect(screen.queryByText('Entire Organization')).toBeNull();   // options only appear once opened
    expect(screen.getByText('Was it working before?')).toBeTruthy();
  });

  it('defaults the Requester to me and submits it with the default type', async () => {
    const title = await open();
    expect(screen.getByText('Requester')).toBeTruthy();
    expect(screen.getByText('me@example.com (Me)')).toBeTruthy();
    fireEvent.change(title, { target: { value: 'Printer jammed' } });
    await pickDepartment('Facilities');
    fireEvent.change(screen.getByPlaceholderText(/Front gate keypad/), { target: { value: 'Printer' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' })); });
    expect(createTicket).toHaveBeenCalledTimes(1);
    const body = createTicket.mock.calls[0][0];
    expect(body.type).toBe('incident');
    expect(body.requesterId).toBe('me@example.com');
    expect(body.typeFields.impact).toBe('One User');
    // When did it start? defaults to now (datetime-local shape).
    expect(body.typeFields.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('asks for an error message only when the department is IT', async () => {
    await open();
    expect(screen.queryByText(ERROR_Q)).toBeNull();
    await pickDepartment('Facilities');
    expect(screen.queryByText(ERROR_Q)).toBeNull();
    fireEvent.click(screen.getByText('Facilities'));
    fireEvent.click(await screen.findByText('IT'));
    expect(await screen.findByText(ERROR_Q)).toBeTruthy();
  });

  it('puts Record Screen and Upload Attachment under the description, with the paste hint', async () => {
    await open();
    expect(screen.getByRole('button', { name: /Record Screen/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Upload Attachment/ })).toBeTruthy();
    expect(screen.getByText(/or press Ctrl\+V to paste a screenshot/)).toBeTruthy();
    // The rich editor's toolbar, the same one the Task module uses.
    expect(screen.getByRole('button', { name: 'Bold' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bulleted list' })).toBeTruthy();
  });
});
