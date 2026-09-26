import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';

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
  },
}));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: DIRECTORY }) }));
vi.mock('../lib/useNameResolver', () => ({ useNameResolver: () => email => email }));

const CompanyRoles = (await import('./CompanyRoles')).default;

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

    const local = within(screen.getByTestId('shared-role-r-office'));
    expect(local.getByRole('button', { name: /Move to This Company/ })).toBeEnabled();
  });
});
