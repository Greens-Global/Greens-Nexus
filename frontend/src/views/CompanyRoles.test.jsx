import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';

// Company Settings > [company] > Roles: the company's own roles render grouped
// by department, shared roles render below, and Move is only offered for a
// shared role whose people all work at this company.

const ROLES_FIXTURE = [
  { id: 'r-lead', name: 'Site Lead', tier: 'supervisor', department: 'Field', company_id: 'co-a',
    members: ['amy@greensglobal.com'], member_count: 1, allowed_modules: [{ id: 'tasks', level: 'editor' }] },
  { id: 'r-crew', name: 'Crew Member', tier: 'employee', department: '', company_id: '',
    members: ['amy@greensglobal.com', 'beth@greensglobal.com'], member_count: 2, allowed_modules: [] },
  { id: 'r-office', name: 'Office Admin', tier: 'employee', department: '', company_id: '',
    members: ['amy@greensglobal.com'], member_count: 1, allowed_modules: [] },
];
const DIRECTORY = [
  { email: 'amy@greensglobal.com', name: 'Amy Alpha', company: 'co-a' },
  { email: 'beth@greensglobal.com', name: 'Beth Beta', company: 'co-b' },
];

vi.mock('../api', () => ({
  api: {
    getCompanyJobRoles: vi.fn(() => Promise.resolve(ROLES_FIXTURE)),
    getCompanyDepartments: vi.fn(() => Promise.resolve([{ id: 'd1', name: 'Field' }])),
    getRoleChecklistRoles: vi.fn(() => Promise.resolve({ isHr: true, roles: [
      { roleId: 'r-lead', roleName: 'Site Lead', counts: { onboarding: 1, promotion: 0, offboarding: 0, inactive: 0 } }] })),
    getChecklistMeta: vi.fn(() => Promise.resolve({ kinds: [{ value: 'onboarding', label: 'Onboarding' }, { value: 'promotion', label: 'Promotion' }], roles: [], exitTypes: [], signals: [] })),
    getRoleChecklist: vi.fn(() => Promise.resolve({ roleId: 'r-lead', roleName: 'Site Lead', department: 'Field', templates: [
      { kind: 'onboarding', kindLabel: 'Onboarding', entityId: '', inherited: false, updatedAt: 'x',
        items: [{ key: 'SL-1', phase: 'Site Lead Steps', title: 'Site Safety Walkthrough', owner: 'manager', anchor: 'S', offset: 5, bd: false, applies: {}, signal: '', hint: '' }] },
    ] })),
    unassignJobRole: vi.fn(() => Promise.resolve({})),
  },
}));
vi.mock('../ui/dialog', () => ({ dialog: { prompt: vi.fn(() => Promise.resolve('Left the field team')), confirm: vi.fn() } }));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: DIRECTORY }), useEntities: () => ({ data: [] }) }));
vi.mock('../lib/useNameResolver', () => ({ useNameResolver: () => email => email }));

const CompanyRoles = (await import('./CompanyRoles')).default;
const { api } = await import('../api');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const renderTab = () => render(
  <CompanyRoles entity={{ id: 'co-a', name: 'Alpha Co' }} toastOk={() => {}} toastErr={() => {}} />);

describe('CompanyRoles', () => {
  it("renders the company's roles grouped by department", async () => {
    renderTab();
    expect(await screen.findByRole('heading', { name: 'Roles at Alpha Co' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Site Lead/ })).toBeInTheDocument();
    expect(screen.getByText('Field')).toBeInTheDocument();
  });

  it('renders the shared roles', async () => {
    renderTab();
    expect(await screen.findByRole('heading', { name: 'Shared Across Companies' })).toBeInTheDocument();
    expect(within(screen.getByTestId('shared-role-r-crew')).getByText('Crew Member')).toBeInTheDocument();
    expect(within(screen.getByTestId('shared-role-r-office')).getByText('Office Admin')).toBeInTheDocument();
  });

  it('disables Move when a member works at another company, and says why', async () => {
    renderTab();
    const mixed = within(await screen.findByTestId('shared-role-r-crew'));
    expect(mixed.getByRole('button', { name: /Move to This Company/ })).toBeDisabled();
    expect(mixed.getByText(/1 of 2 people in this role doesn't work at Alpha Co/)).toBeInTheDocument();
    expect(mixed.getByRole('button', { name: /Duplicate for This Company/ })).toBeEnabled();
    // A shared role that can't move is still editable in place.
    expect(mixed.getByRole('button', { name: 'Edit Crew Member' })).toBeEnabled();

    const local = within(screen.getByTestId('shared-role-r-office'));
    expect(local.getByRole('button', { name: /Move to This Company/ })).toBeEnabled();
  });

  it("a role's Checklists tab shows its extra steps, and the role card counts them", async () => {
    renderTab();
    const card = await screen.findByRole('button', { name: /Site Lead/ });
    expect(await within(card).findByText('1 step')).toBeInTheDocument();
    fireEvent.click(card);
    expect(screen.getByRole('tab', { name: 'Access & People' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: /Checklists/ }));
    expect(await screen.findByText('Site Safety Walkthrough')).toBeInTheDocument();
  });

  // Taking a role away asks why - kept in their role history (Neil, Oct 22).
  it('asks for the reason before removing someone from a role', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Site Lead/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove amy@greensglobal.com' }));
    await vi.waitFor(() => expect(api.unassignJobRole).toHaveBeenCalledWith('r-lead', 'amy@greensglobal.com', 'Left the field team'));
  });

  it("opens a shared role's steps from its Checklists button", async () => {
    renderTab();
    const row = within(await screen.findByTestId('shared-role-r-crew'));
    fireEvent.click(row.getByRole('button', { name: /Checklists/ }));
    expect(await screen.findByText('Crew Member - Checklist Steps')).toBeInTheDocument();
    expect(screen.getByText(/apply in every company that uses it/)).toBeInTheDocument();
  });
});
