import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Where a role's BOD / EOD / break messages post in Teams is set on the job
// role (Neil, 10/07: "it isn't even based on the person, it's based on a role").

const updateJobRole = vi.fn((id, body) => Promise.resolve({ id, ...body }));
const timeMyChannels = vi.fn(() => Promise.resolve({ channels: [
  { teamId: 't-it', teamName: 'IT', channelId: 'c-sup', channelName: 'IT Support', membershipType: 'standard' }], reason: '' }));
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, key) => (key === 'updateJobRole' ? updateJobRole : key === 'timeMyChannels' ? timeMyChannels : vi.fn(() => Promise.resolve([]))),
  }),
}));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn(() => Promise.resolve(true)) } }));

const { RoleEditor } = await import('./RolesAccess');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const role = { id: 'r-dev', name: 'IT Developer', tier: 'employee', department: 'IT', description: '',
  monitoring_exempt: false, bod_exempt: false, time_tracking_exempt: false, allowed_modules: [], teams: {} };

describe('Role editor - Teams Messages', () => {
  it('binds a channel and saves it with the role', async () => {
    render(<RoleEditor role={role} jobRoles={[role]} onClose={() => {}} onSaved={() => {}} onErr={() => {}} />);
    expect(screen.getByText('Where BOD, EOD and break messages post')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Channel/ }));
    fireEvent.click(screen.getByText('Bind A Channel'));
    fireEvent.change(await screen.findByLabelText('Teams channel'), { target: { value: 'c-sup' } });
    expect(screen.getByText(/IT › IT Support/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save Job Role/ }));
    await waitFor(() => expect(updateJobRole).toHaveBeenCalled());
    expect(updateJobRole.mock.calls[0][1].teams).toEqual({ type: 'channel', id: 'c-sup', name: 'IT Support', teamId: 't-it', teamName: 'IT' });
  });

  it('a role that skips day messages offers no destination', () => {
    render(<RoleEditor role={{ ...role, bod_exempt: true }} jobRoles={[]} onClose={() => {}} onSaved={() => {}} onErr={() => {}} />);
    expect(screen.getByText(/skip these messages/)).toBeInTheDocument();
    expect(screen.queryByText('Bind A Chat')).toBeNull();
  });
});
