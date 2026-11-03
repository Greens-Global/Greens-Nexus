import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Access > People (Neil, 11/03/2026): a person opens in a sheet holding the
// one access editor (people/AccessTab.jsx). The job role changes ONLY through
// Change Role (RoleChangeModal, a reason required) and the tier override is a
// Super Administrator's alone.

// jsdom has no scrollIntoView - selecting a person (setPerson) runs the
// existing panel-into-view effect regardless of this test's own changes.
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });

const roles = [
  { id: 'r-own', name: 'Acme Accountant', tier: 'employee', company_id: 'acme', members: [], member_count: 0, allowed_modules: [] },
  { id: 'r-shared-1', name: 'Tester', tier: 'employee', company_id: '', members: [], member_count: 0, allowed_modules: [] },
  { id: 'r-shared-2', name: 'Crew Member', tier: 'employee', company_id: '', members: [], member_count: 0, allowed_modules: [] },
];
const dir = [{ email: 'amy@example.com', display_name: 'Amy Poe', company: 'acme' }];
const eff = { email: 'amy@example.com', tier: 'employee', job_role: null, extra_groups: [] };
const assignJobRole = vi.fn(() => Promise.resolve({ assigned: true }));
const changeRoleNow = vi.fn(() => Promise.resolve({ roleId: 'r-shared-2', roleName: 'Crew Member', warning: '' }));

vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: dir }) }));
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, key) => {
      if (key === 'getJobRoles') return vi.fn(() => Promise.resolve(roles));
      if (key === 'getEntities') return vi.fn(() => Promise.resolve([{ id: 'acme', name: 'Acme Co' }]));
      if (key === 'getEffectiveAccess') return vi.fn(() => Promise.resolve(eff));
      if (key === 'assignJobRole') return assignJobRole;
      if (key === 'changeRoleNow') return changeRoleNow;
      if (key === 'getMyRole') return vi.fn(() => Promise.resolve(myRoleAnswer.value));
      return vi.fn(() => Promise.resolve([]));
    },
  }),
  setActAsSessionId: vi.fn(),
  getActAsSessionId: () => null,
}));
// The real /roles/me answer for the "from the provider" case below.
const myRoleAnswer = { value: { role: 'administrator', level: 4, title: 'IT Lead', email: 'me@example.com' } };
vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Me', username: 'me@example.com' }], inProgress: 'none' }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
// useRole is mocked as an owner by default; a test that sets `viaProvider`
// gets the REAL hook, fed by the REAL RoleProvider mounted around the screen.
const viaProvider = { on: false };
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    useRole: () => (viaProvider.on ? real.useRole() : { can: () => true, myRole: 'owner', myLevel: 5, myEmail: 'me@example.com', assignRole: vi.fn() }),
  };
});
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn(() => Promise.resolve(true)) } }));

const RolesAccess = (await import('./RolesAccess')).default;
const { RoleProvider } = await import('../contexts/RoleContext');

afterEach(() => { cleanup(); vi.clearAllMocks(); viaProvider.on = false; });

describe('Access > People > the access sheet', () => {
  it('opens the person in a sheet; Set Job Role goes through Change Role with a reason', async () => {
    render(<RolesAccess embedded />);
    fireEvent.click(await screen.findByText('Amy Poe'));
    expect(await screen.findByText('Access - Amy Poe')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Assign a role…/ })).not.toBeInTheDocument();   // no second picker

    fireEvent.click(await screen.findByRole('button', { name: /Set Job Role/ }));
    const pick = await screen.findByDisplayValue('- pick a role -');
    const offered = [...pick.querySelectorAll('option')].map((o) => o.textContent).slice(1);
    expect(offered).toEqual(expect.arrayContaining(['Acme Accountant', 'Tester', 'Crew Member']));
    fireEvent.change(pick, { target: { value: 'r-shared-2' } });
    const change = screen.getByRole('button', { name: /^Change Role$/ });
    expect(change).toBeDisabled();                                  // the reason is required
    fireEvent.change(screen.getByPlaceholderText(/Moving to the Accounting team/), { target: { value: 'Covers the crew' } });
    fireEvent.click(change);
    await waitFor(() => expect(changeRoleNow).toHaveBeenCalledWith('amy@example.com', { role_id: 'r-shared-2', reason: 'Covers the crew' }));
    expect(assignJobRole).not.toHaveBeenCalled();
  });

  it('a Super Administrator may override the tier', async () => {
    render(<RolesAccess embedded />);
    fireEvent.click(await screen.findByText('Amy Poe'));
    expect(await screen.findByRole('combobox', { name: 'Override Tier' })).toBeInTheDocument();
  });

  it('an Administrator sees the tier but cannot override it', async () => {
    viaProvider.on = true;
    myRoleAnswer.value = { role: 'administrator', level: 4, title: 'IT Lead', email: 'me@example.com' };
    render(<RoleProvider><RolesAccess embedded /></RoleProvider>);
    fireEvent.click(await screen.findByText('Amy Poe'));
    await screen.findByRole('button', { name: /Set Job Role/ });
    expect(screen.queryByRole('combobox', { name: 'Override Tier' })).not.toBeInTheDocument();
  });
});
