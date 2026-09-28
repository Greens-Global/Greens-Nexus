import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Access > People > "Change role": a searchable popover instead of one flat
// native <select> mixing a person's own company roles with every shared role
// (Pranshu, Sep 28 - "make it more UI friendly").

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

vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: dir }) }));
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, key) => {
      if (key === 'getJobRoles') return vi.fn(() => Promise.resolve(roles));
      if (key === 'getEntities') return vi.fn(() => Promise.resolve([{ id: 'acme', name: 'Acme Co' }]));
      if (key === 'getEffectiveAccess') return vi.fn(() => Promise.resolve(eff));
      if (key === 'assignJobRole') return assignJobRole;
      return vi.fn(() => Promise.resolve([]));
    },
  }),
}));
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useRole: () => ({ can: () => true, myRole: 'owner', myLevel: 5, myEmail: 'me@example.com', assignRole: vi.fn() }) };
});
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn(() => Promise.resolve(true)) } }));

const RolesAccess = (await import('./RolesAccess')).default;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Access > People > role picker', () => {
  it('opens a popover, groups roles, filters by search, and assigns on pick', async () => {
    render(<RolesAccess embedded />);
    fireEvent.click(await screen.findByText('Amy Poe'));

    const trigger = await screen.findByRole('button', { name: /Assign a role…/ });
    fireEvent.click(trigger);

    expect(screen.getByPlaceholderText('Search roles')).toBeInTheDocument();
    expect(screen.getByText('This Company')).toBeInTheDocument();
    expect(screen.getByText('Acme Accountant')).toBeInTheDocument();
    expect(screen.getByText('Shared Across Companies')).toBeInTheDocument();
    expect(screen.getByText('Tester')).toBeInTheDocument();
    expect(screen.getByText('Crew Member')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search roles'), { target: { value: 'crew' } });
    expect(screen.queryByText('Tester')).not.toBeInTheDocument();
    expect(screen.getByText('Crew Member')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Crew Member'));
    await waitFor(() => expect(assignJobRole).toHaveBeenCalledWith('r-shared-2', 'amy@example.com'));
    // Picking closes the panel.
    expect(screen.queryByPlaceholderText('Search roles')).not.toBeInTheDocument();
  });

  it('closes on Escape and on an outside click', async () => {
    render(<RolesAccess embedded />);
    fireEvent.click(await screen.findByText('Amy Poe'));
    fireEvent.click(await screen.findByRole('button', { name: /Assign a role…/ }));
    expect(screen.getByPlaceholderText('Search roles')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Search roles')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Assign a role…/ }));
    expect(screen.getByPlaceholderText('Search roles')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByPlaceholderText('Search roles')).not.toBeInTheDocument();
  });
});
