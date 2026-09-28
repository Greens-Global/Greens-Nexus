import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Global Settings > Access > Shared Roles: the roles people at any company
// can hold are managed here (create, edit, delete); a company's own roles are
// not listed, since those live in Company Settings.

const roles = [
  { id: 'r-shared', name: 'Tester', tier: 'employee', company_id: '', members: ['a@x.com', 'b@x.com'], member_count: 2, allowed_modules: [] },
  { id: 'r-acme', name: 'Acme Accountant', tier: 'employee', company_id: 'acme', members: [], member_count: 0, allowed_modules: [] },
];
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [] }) }));
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, key) => (key === 'getJobRoles'
      ? vi.fn(() => Promise.resolve(roles))
      : vi.fn(() => Promise.resolve([]))),
  }),
}));
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useRole: () => ({ can: () => true, myRole: 'owner', myEmail: 'me@example.com' }) };
});

const { default: RolesAccess, PENDING_ACCESS_TAB } = await import('./RolesAccess');
const { setPendingOpen } = await import('../lib/pendingOpen');

afterEach(() => { cleanup(); });

describe('Access > Shared Roles', () => {
  it('sits between Groups and Audit, and lists shared roles only', async () => {
    render(<RolesAccess embedded />);
    const tabs = screen.getAllByRole('button').map(b => b.textContent.trim())
      .filter(t => ['People', 'Groups', 'Shared Roles', 'Audit'].includes(t));
    expect(tabs).toEqual(['People', 'Groups', 'Shared Roles', 'Audit']);

    fireEvent.click(screen.getByRole('button', { name: /Shared Roles/ }));
    expect(await screen.findByText('Tester')).toBeInTheDocument();
    expect(screen.queryByText('Acme Accountant')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Shared Role/ })).toBeInTheDocument();

    // A count, never faces or names - this list is a browsing view, not a
    // roster (Pranshu, Sep 28).
    expect(screen.getByText('2 people')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByText('a@x.com')).not.toBeInTheDocument();
  });

  it('opens the role editor at a generous width', async () => {
    render(<RolesAccess embedded />);
    fireEvent.click(screen.getByRole('button', { name: /Shared Roles/ }));
    fireEvent.click(await screen.findByRole('button', { name: /New Shared Role/ }));
    expect(screen.getByRole('heading', { name: 'New job role' })).toBeInTheDocument();
  });

  it('opens straight on Shared Roles from the Company Settings link', async () => {
    setPendingOpen(PENDING_ACCESS_TAB, 'jobroles');
    render(<RolesAccess embedded />);
    expect(await screen.findByText('Tester')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Shared Role/ })).toBeInTheDocument();
  });
});
