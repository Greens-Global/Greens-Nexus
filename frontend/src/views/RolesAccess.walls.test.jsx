import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Tiers (Neil, 11/02/2026): only a Super Administrator (level 5) sets the
// company walls or flags a group "Super Administrators"; the walls panel
// counts Super Administrators as the owner tier plus flagged-group members,
// once each; Administrators stay inside their companies either way.

let level = 5;
const confirm = vi.fn(() => Promise.resolve(false));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [] }) }));
vi.mock('../ui/dialog', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, dialog: { ...real.dialog, confirm: (...a) => confirm(...a) } };
});
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, key) => {
      if (key === 'getCompanyWalls') return vi.fn(() => Promise.resolve({ on: false, globalAdminGroups: 1, globalAdmins: 2 }));
      if (key === 'getAllRoles') return vi.fn(() => Promise.resolve([
        { email: 'neil@x.com', role: 'owner' }, { email: 'visesh@x.com', role: 'owner' },
        { email: 'sam@x.com', role: 'administrator' },
      ]));
      if (key === 'getGroups') return vi.fn(() => Promise.resolve([
        { id: 'g-ga', name: 'Across Companies', is_global_admin: 1, is_job_role: 0, members: ['NEIL@x.com', 'extra@x.com'], allowed_modules: [] },
      ]));
      return vi.fn(() => Promise.resolve([]));
    },
  }),
}));
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useRole: () => ({ can: t => (real.ROLES[t]?.level ?? 1) <= level, myLevel: level, myRole: level >= 5 ? 'owner' : 'administrator', myEmail: 'me@x.com' }) };
});

const { default: RolesAccess } = await import('./RolesAccess');

afterEach(() => { cleanup(); level = 5; confirm.mockClear(); });

async function openGroups() {
  render(<RolesAccess embedded />);
  fireEvent.click(screen.getByRole('button', { name: /^Groups$/ }));
  return screen.findByText(/Company walls/);
}

describe('Access > Groups > Company walls', () => {
  it('a Super Administrator sees the switch, and the copy keeps Administrators walled', async () => {
    await openGroups();
    // neil + visesh (owners) + extra (flagged group); NEIL@ in the group is neil, counted once.
    expect(await screen.findByText(/3 super administrators/)).toBeInTheDocument();
    expect(screen.getByText(/Administrators always stay inside their own companies/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Arm walls/ }));
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    const msg = confirm.mock.calls[0][0];
    expect(msg).toMatch(/Administrators are confined to their companies either way/);
    expect(msg).not.toMatch(/Mark a group/);
  });

  it('an Administrator sees the walls state but no switch', async () => {
    level = 4;
    await openGroups();
    expect(await screen.findByText(/only a Super Administrator changes the walls/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Arm walls|Disarm/ })).not.toBeInTheDocument();
  });

  it('only a Super Administrator can flag a group', async () => {
    await openGroups();
    fireEvent.click(screen.getByRole('button', { name: /New group/ }));
    expect(screen.getByLabelText(/Super Administrators \(sees every company\)/)).toBeInTheDocument();
    cleanup();
    level = 4;
    await openGroups();
    fireEvent.click(screen.getByRole('button', { name: /New group/ }));
    expect(screen.queryByLabelText(/Super Administrators \(sees every company\)/)).not.toBeInTheDocument();
  });
});
