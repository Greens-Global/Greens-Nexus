import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

// Managers see their own team in People (Pranshu, 10/06): the Manager tier
// with the People grant sees People and Time only - no
// Hiring / Org Chart / Leave / Checklists, no Add Person - and each person's
// profile has five read-only tabs (Overview, Assets, Work Mode, Access, Work
// Logs): no Pay & Benefits, Compliance, Documents or Checklist, no Edit. The
// server enforces all of it; this is the matching screen.

const PEOPLE = [
  { id: 'e1', firstName: 'Mia', lastName: 'Mid', workEmail: 'mia@x.com', managerEmail: 'val@x.com', status: 'active',
    jobTitle: 'Lead', company: 'co1', identityType: 'internal', employmentType: 'full_time', compliance: {}, contractor: {}, personal: {} },
  { id: 'e2', firstName: 'Leo', lastName: 'Low', workEmail: 'leo@x.com', managerEmail: 'mia@x.com', status: 'active',
    jobTitle: 'Tech', company: 'co1', identityType: 'internal', employmentType: 'full_time', compliance: {}, contractor: {}, personal: {} },
];
const ACCESS = { email: 'leo@x.com', tier: 'employee', job_role: { name: 'Technician' }, extra_groups: [],
  modules: [{ module: 'timeclock', level: 'viewer', source: 'Technician', manual: false }] };

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ hrTeam: true, hrScope: [], can: () => false, canAccessModule: () => true, myEmail: 'val@x.com',
    myRole: 'supervisor', myGrantedModules: new Map([['hr', 'editor']]), isExternal: false }),
}));
const calls = [];
vi.mock('../api', () => {
  const data = { getEmployees: PEOPLE, getEntities: [{ id: 'co1', name: 'Greens Co' }], getEmployeeAccessRead: ACCESS };
  const api = new Proxy({}, {
    get: (_, key) => (...args) => { calls.push(key); return Promise.resolve(key in data ? data[key] : []); },
  });
  return { api, default: api };
});

afterEach(() => { cleanup(); calls.length = 0; });

async function renderPeople(activeSub = 'hr-people') {
  const { default: HR } = await import('./HR');
  render(<HR activeSub={activeSub} onSubChange={() => {}} />);
  await screen.findAllByText('Mia Mid');
}

describe('People limited to my team', () => {
  it('shows People and Time only, the team chip, and no Add Person', async () => {
    await renderPeople();
    expect(screen.getByText('Showing: Your Team')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add Person/ })).toBeNull();
    expect(screen.getAllByText('Time').length).toBeGreaterThan(0);   // the strip is there...
    for (const gone of ['Hiring', 'Org Chart', 'Leave', 'Checklists']) {   // ...without these
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    }
    expect(calls).not.toContain('getChecklistProgress');
  }, 20000);

  it('falls back to People when a deep link points at a hidden section', async () => {
    await renderPeople('hr-hiring');
    expect(screen.getByText('Showing: Your Team')).toBeTruthy();
  }, 20000);

  it('names the manager themself as "you", not "no manager"', async () => {
    await renderPeople();
    fireEvent.click(screen.getAllByText('Mia Mid')[0]);   // reports to val@x.com - the viewer, not in their own list
    expect(screen.getByText('reports to you')).toBeTruthy();
    expect(screen.queryByText('no manager')).toBeNull();
  }, 20000);

  it('opens a profile with five read-only tabs and the Access tab as a list', async () => {
    await renderPeople();
    fireEvent.click(screen.getAllByText('Leo Low')[0]);
    const tabNames = ['Overview', 'Assets', 'Work Mode', 'Access', 'Work Logs'];
    for (const t of tabNames) expect(screen.getByRole('button', { name: t })).toBeTruthy();
    for (const t of ['Pay & Benefits', 'Compliance', 'Documents', 'Checklist']) {
      expect(screen.queryByRole('button', { name: t })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /^Edit$/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Access' }));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Time Clock')).toBeTruthy();
    expect(within(table).getByText('Viewer')).toBeTruthy();
    expect(screen.getByText(/Read only - administrators change access/)).toBeTruthy();
    expect(calls).toContain('getEmployeeAccessRead');
  }, 20000);
});
