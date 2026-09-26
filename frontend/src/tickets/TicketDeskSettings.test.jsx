import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Routing & Escalation: a list of desks on the left (each saying where its
// tickets go), one desk at a time on the right, and Save only once something
// changed.

vi.mock('../api', () => ({
  api: {
    getTicketNotifySettings: vi.fn(() => Promise.resolve({ agentEmails: [], agentEmailsByCompany: { acme: ['a@x.com'] } })),
    getTicketCompanies: vi.fn(() => Promise.resolve([{ id: 'acme', name: 'Acme' }, { id: 'beta', name: 'Beta' }])),
    getTicketDepartments: vi.fn(() => Promise.resolve([{ id: 'd1', name: 'Finance', companyId: 'beta', leadEmail: '' }])),
    updateTicketNotifySettings: vi.fn((b) => Promise.resolve(b)),
  },
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myLevel: 4 }) }));
vi.mock('../tasks/components', () => ({
  usePeople: () => [],
  PersonMultiSelect: ({ value, onChange }) => (
    <button type="button" onClick={() => onChange([...value, 'new@x.com'])}>Agents: {value.length}</button>
  ),
  PersonSelect: () => <span>Head picker</span>,
}));

const TicketDeskSettings = (await import('./TicketDeskSettings')).default;

afterEach(() => { cleanup(); });

describe('TicketDeskSettings', () => {
  it('lists every desk with where its tickets go, and shows one at a time', async () => {
    render(<TicketDeskSettings />);
    const nav = await screen.findByRole('navigation', { name: 'Ticket desks' });
    expect(nav).toHaveTextContent('Default Agents');
    expect(nav).toHaveTextContent('Acme1 agent');
    expect(nav).toHaveTextContent('BetaFalls back to admins');

    // Default Agents is open first; no company's departments are on screen.
    expect(screen.queryByText('Finance')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
    expect(screen.getByText('Finance')).toBeInTheDocument();   // departments open in the detail pane
    expect(screen.getByText('Agents: 0')).toBeInTheDocument();
  });

  it('enables Save only after a change, and flags it', async () => {
    render(<TicketDeskSettings />);
    const save = await screen.findByRole('button', { name: /Save/ });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByText('Agents: 0'));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(save).toBeEnabled();
  });
});
