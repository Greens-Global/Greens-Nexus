import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Routing & Escalation: a list of desks on the left (each saying where its
// tickets go), one desk at a time on the right, and a roster that saves the
// moment it changes.

vi.mock('../api', () => ({
  api: {
    getTicketNotifySettings: vi.fn(() => Promise.resolve({ agentEmails: [], agentEmailsByCompany: { acme: ['a@x.com'] } })),
    getTicketCompanies: vi.fn(() => Promise.resolve([{ id: 'acme', name: 'Acme' }, { id: 'beta', name: 'Beta' }])),
    getTicketDepartments: vi.fn(() => Promise.resolve([
      { id: 'd1', name: 'Finance', companyId: 'beta', leadEmail: '', enabled: true },
      { id: 'd2', name: 'Construction', companyId: 'beta', leadEmail: '', enabled: true },
      // Deleted from the company's global list - only there to name old tickets.
      { id: 'd3', name: 'Old Dept', companyId: 'beta', leadEmail: '', enabled: true, removed: true },
    ])),
    updateTicketNotifySettings: vi.fn((b) => Promise.resolve(b)),
    setTicketDepartmentEnabled: vi.fn((id, enabled) => Promise.resolve([
      { id: 'd1', name: 'Finance', companyId: 'beta', leadEmail: '', enabled: true },
      { id: 'd2', name: 'Construction', companyId: 'beta', leadEmail: '', enabled },
    ])),
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

const { api } = await import('../api');
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

  // One save pattern (Oct 23 2026): a roster is a chip list - it saves the
  // moment it changes, with no Save button, and a refused save puts it back.
  it('saves a roster change at once, with no Save button', async () => {
    render(<TicketDeskSettings />);
    fireEvent.click(await screen.findByText('Agents: 0'));
    expect(screen.queryByRole('button', { name: /^Save/ })).not.toBeInTheDocument();
    await waitFor(() => expect(api.updateTicketNotifySettings).toHaveBeenLastCalledWith({ agentEmails: ['new@x.com'], agentEmailsByCompany: { acme: ['a@x.com'] } }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('Agents: 1')).toBeInTheDocument();
  });

  it('puts the roster back when the save is refused', async () => {
    api.updateTicketNotifySettings.mockImplementationOnce(() => Promise.reject(new Error('No access')));
    render(<TicketDeskSettings />);
    fireEvent.click(await screen.findByText('Agents: 0'));
    expect(await screen.findByText(/Could not save the agents: No access/)).toBeInTheDocument();
    expect(screen.getByText('Agents: 0')).toBeInTheDocument();
  });

  // Oct 1 2026 (Neil): departments come from the company's global list - no
  // add/rename/delete here, just an on/off switch for Submit a Ticket.
  it('shows the global departments with an on/off switch and no add, rename or delete', async () => {
    render(<TicketDeskSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Beta/ }));
    expect(screen.getByText('Construction')).toBeInTheDocument();
    expect(screen.queryByText('Old Dept')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Add a department/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rename|Delete/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Settings > Companies/ }).length).toBeGreaterThan(0);

    const sw = screen.getByRole('switch', { name: 'Offer Construction on Submit a Ticket' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(api.setTicketDepartmentEnabled).toHaveBeenCalledWith('d2', false);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Offer Construction on Submit a Ticket' }))
      .toHaveAttribute('aria-checked', 'false'));
  });

  it('links to Settings > Companies, where departments are managed', async () => {
    const seen = vi.fn();
    window.addEventListener('nexus:navigate', seen);
    render(<TicketDeskSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Beta/ }));
    fireEvent.click(screen.getAllByRole('button', { name: /Settings > Companies/ })[0]);
    expect(seen.mock.calls[0][0].detail).toEqual({ view: 'admin-console', sub: 'companies' });
    window.removeEventListener('nexus:navigate', seen);
  });
});
