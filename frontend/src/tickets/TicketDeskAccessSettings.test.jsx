import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Ticket Manager > Desk Access: the legacy / explicit switch, who would lose
// access before switching, and administrators only.

let isAdmin = true;
vi.mock('../api', () => ({
  api: {
    getTicketDeskAccess: vi.fn(() => Promise.resolve({
      deskAccess: 'legacy',
      explicitChanges: [
        { email: 'pat@x.com', name: 'Pat Lee', from: 'supervisor', to: 'requester' },
        { email: 'sam@x.com', name: '', from: 'supervisor', to: 'agent' },
      ],
    })),
    updateTicketDeskAccess: vi.fn((mode) => Promise.resolve({ deskAccess: mode, explicitChanges: [] })),
  },
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => isAdmin }) }));

const { api } = await import('../api');
const TicketDeskAccessSettings = (await import('./TicketDeskAccessSettings')).default;

afterEach(() => { cleanup(); isAdmin = true; vi.restoreAllMocks(); });

describe('TicketDeskAccessSettings', () => {
  it('shows the current rule and who would change on a switch', async () => {
    render(<TicketDeskAccessSettings />);
    const legacy = await screen.findByRole('radio', { name: /Any Tasks or Tickets Access/ });
    expect(legacy).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Pat Lee')).toBeInTheDocument();
    expect(screen.getByText('Supervisor to Requester')).toBeInTheDocument();
    expect(screen.getByText('Supervisor to Agent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
  });

  it('confirms before switching to explicit, then saves', async () => {
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<TicketDeskAccessSettings />);
    fireEvent.click(await screen.findByRole('radio', { name: /Tickets Access Only/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(ask).toHaveBeenCalled();
    await waitFor(() => expect(api.updateTicketDeskAccess).toHaveBeenCalledWith('explicit'));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('tells a non-administrator instead of rendering blank', () => {
    isAdmin = false;
    render(<TicketDeskAccessSettings />);
    expect(screen.getByText(/Administrator access is required/)).toBeInTheDocument();
  });
});
