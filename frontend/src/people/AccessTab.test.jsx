import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// The one access editor (Neil, 11/03/2026): the record's Access tab and
// Settings > People & Access both draw people/AccessTab.jsx. It renders the
// role (changed only through Change Role), the tier (override for a Super
// Administrator alone), extra groups and company limits.

const eff = {
  email: 'amy@x.com', tier: 'manager', tier_pinned: false,
  job_role: { id: 'r1', name: 'Site Lead', tier: 'manager', company_id: '' },
  extra_groups: [{ id: 'g1', name: 'Payroll Viewers' }],
  modules: [{ module: 'tasks', level: 'editor', manual: false, source: 'Site Lead' }],
};
vi.mock('../api', () => {
  const answers = {
    getEffectiveAccess: eff,
    getGroups: [{ id: 'g1', name: 'Payroll Viewers' }, { id: 'g2', name: 'Fleet' }],
    getJobRoles: [], getEntities: [], getAccessScopes: [], getExternalUsers: [],
  };
  const api = new Proxy({}, { get: (_, key) => () => Promise.resolve(key in answers ? answers[key] : []) });
  return { api, default: api };
});
const role = { level: 5 };
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: (r) => r === 'owner' && role.level >= 5, myLevel: role.level, assignRole: vi.fn() }),
}));
vi.mock('../components/RoleChangeRequests', () => ({ RoleChangeRequestCard: () => null, RoleHistory: () => null }));

const AccessTab = (await import('./AccessTab')).default;
afterEach(() => { cleanup(); role.level = 5; });

describe('AccessTab', () => {
  it('renders the role, tier, groups and modules, with Change Role as the only role control', async () => {
    render(<AccessTab email="amy@x.com" toastOk={vi.fn()} toastErr={vi.fn()} />);
    expect(await screen.findByText('Site Lead', { selector: 'span' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Change Role/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove from Payroll Viewers, press and hold' })).toBeTruthy();
    expect(await screen.findByRole('combobox', { name: 'Add to a Group' })).toBeTruthy();
    expect(screen.getByText('People Admin Companies')).toBeTruthy();
    expect(screen.getByText('What They Can Do')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Override Tier' })).toBeTruthy();   // a Super Administrator
  });

  it('an Administrator sees the tier but no override', async () => {
    role.level = 4;
    render(<AccessTab email="amy@x.com" toastOk={vi.fn()} toastErr={vi.fn()} />);
    await screen.findByRole('button', { name: /Change Role/ });
    expect(screen.queryByRole('combobox', { name: 'Override Tier' })).toBeNull();
    expect(screen.getByText(/Only a Super Administrator overrides/)).toBeTruthy();
  });

  it('an external user gets company access limits and no tier', async () => {
    render(<AccessTab email="pat@partner.com" identityType="external" toastOk={vi.fn()} toastErr={vi.fn()} />);
    await screen.findByRole('button', { name: /Change Role/ });
    expect(screen.getByText('Company Access')).toBeTruthy();
    expect(screen.queryByText('Tier')).toBeNull();
  });
});
