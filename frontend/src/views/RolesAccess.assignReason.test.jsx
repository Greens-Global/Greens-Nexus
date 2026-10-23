import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Settings > Roles > a role > Assign (Neil, Oct 22): someone who already holds
// another job role is a role change - one required reason for everyone picked,
// shown on their Role History. Someone with no role yet goes straight on.

const target = { id: 'r-crew', name: 'Crew Member', tier: 'employee', company_id: '', members: [] };
const roles = [target, { id: 'r-test', name: 'Tester', tier: 'employee', company_id: '', members: ['amy@example.com'] }];
const dir = [{ email: 'amy@example.com', display_name: 'Amy Poe' }, { email: 'ned@example.com', display_name: 'Ned New' }];
const assignJobRole = vi.fn(() => Promise.resolve({ assigned: true }));
let canChange = true;

vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: dir }) }));
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, key) => {
      if (key === 'getJobRoles') return vi.fn(() => Promise.resolve(roles));
      if (key === 'assignJobRole') return assignJobRole;
      return vi.fn(() => Promise.resolve([]));
    },
  }),
}));
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useRole: () => ({ can: () => true, myLevel: 5, hrTeam: false, canAccessModule: () => canChange }) };
});

const { AssignModal } = await import('./RolesAccess');

afterEach(() => { cleanup(); vi.clearAllMocks(); canChange = true; });

const open = () => render(<AssignModal role={target} onClose={() => {}} onAssigned={() => {}} onErr={() => {}} />);

describe('Assign dialog: a role change needs a reason', () => {
  it('assigns someone with no role at once, with no reason box', async () => {
    open();
    fireEvent.click(await screen.findByText('Ned New'));
    await waitFor(() => expect(assignJobRole).toHaveBeenCalledWith('r-crew', 'ned@example.com', undefined));
    expect(screen.queryByText(/Reason For The Change/)).toBeNull();
  });

  it('asks for the reason when someone already holds a role, Assign disabled until it is filled', async () => {
    open();
    await screen.findByText(/Holds Tester/);
    expect(screen.queryByText(/Reason For The Change/)).toBeNull();
    fireEvent.click(screen.getByText('Amy Poe'));
    expect(screen.getByText(/Reason For The Change/)).toBeTruthy();
    expect(screen.getByText(/Shown on their Role History/)).toBeTruthy();
    const btn = screen.getByRole('button', { name: /Assign 1/ });
    expect(btn).toBeDisabled();
    expect(assignJobRole).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Reason For The Change/), { target: { value: 'Moving to the crew' } });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() => expect(assignJobRole).toHaveBeenCalledWith('r-crew', 'amy@example.com', 'Moving to the crew'));
  });

  it('someone who cannot change roles gets a plain message, not a swap', async () => {
    canChange = false;
    open();
    expect(await screen.findByText(/only HR, an IT Admin or a Global Admin can change their role/)).toBeTruthy();
    fireEvent.click(screen.getByText('Amy Poe'));
    expect(screen.queryByText(/Reason For The Change/)).toBeNull();
    expect(assignJobRole).not.toHaveBeenCalled();
  });
});
