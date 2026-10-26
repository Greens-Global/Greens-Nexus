import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Workforce > Computers: a PC's Owner is the Tasks people picker (Oct 25
// 2026) - type to search - and it assigns the picked email, or '' for
// Unassigned (Shared), exactly as the old list did.

// The server keeps what was assigned, so a re-read after a save shows it.
let owner = '';
const assign = vi.fn((id, email) => { owner = email; return Promise.resolve({}); });
vi.mock('../api', () => ({
  api: {
    timeAgentInstallCommand: () => Promise.resolve({ configured: true, command: 'install' }),
    timeAgentDevices: () => Promise.resolve({ devices: [{ id: 'd1', label: 'Front Desk PC', email: owner, name: '' }] }),
    getPeopleDirectory: () => Promise.resolve([{ email: 'Amy.Adams@x.com', name: 'Amy Adams' }, { email: 'ben.bell@x.com', name: 'Ben Bell' }]),
    timeAgentAssignDevice: (...a) => assign(...a),
  },
}));
vi.mock('../lib/pollWhileVisible', () => ({ pollWhileVisible: () => () => {} }));
vi.mock('./PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('leaflet', () => ({ default: {} }));
vi.mock('leaflet/dist/leaflet.css', () => ({}));

const { AgentInstall } = await import('./TimeTrackingAdmin');

describe('Computer owner picker', () => {
  it('searches the People list and assigns the email, then clears to shared', async () => {
    render(<AgentInstall />);
    const owner = await screen.findByRole('button', { name: /^Owner:/ });
    expect(owner.textContent).toContain('Unassigned (Shared)');
    fireEvent.click(owner);
    fireEvent.change(screen.getByPlaceholderText('Search people…'), { target: { value: 'amy' } });
    fireEvent.click(await within(screen.getByRole('listbox')).findByText('Amy Adams'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('d1', 'amy.adams@x.com'));
    fireEvent.click(screen.getByRole('button', { name: /^Owner:/ }));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Unassigned (Shared)'));
    await waitFor(() => expect(assign).toHaveBeenLastCalledWith('d1', ''));
  });

  it('picking the person already assigned saves nothing', async () => {
    owner = '';
    assign.mockClear();
    render(<AgentInstall />);
    fireEvent.click(await screen.findByRole('button', { name: /^Owner:/ }));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Unassigned (Shared)'));
    expect(assign).not.toHaveBeenCalled();
  });
});
