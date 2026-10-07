import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

// Development is off the nav (Neil, Aug 11 - not being built), so a role's
// module bundle must not offer it: a grant on it opened nothing (Oct 2).

vi.mock('../api', () => ({
  api: new Proxy({}, { get: () => vi.fn(() => Promise.resolve([])) }),
}));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn(() => Promise.resolve(true)) } }));

const { RoleEditor } = await import('./RolesAccess');

afterEach(() => { cleanup(); });

describe('Role editor - module bundle', () => {
  it('does not offer Development, and still offers the live modules', () => {
    const role = { id: 'r1', name: 'Analyst', tier: 'employee', department: '', description: '', allowed_modules: [] };
    render(<RoleEditor role={role} jobRoles={[role]} onClose={() => {}} onSaved={() => {}} onErr={() => {}} />);
    expect(screen.queryByText('Development')).toBeNull();
    for (const label of ['Operations', 'Construction', 'Asset Management', 'Accounting']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('puts an x only on the selected level, and the x removes the screen', () => {
    const role = { id: 'r1', name: 'Analyst', tier: 'manager', department: '', description: '',
      allowed_modules: [{ id: 'tasks', level: 'editor' }] };
    render(<RoleEditor role={role} jobRoles={[role]} onClose={() => {}} onSaved={() => {}} onErr={() => {}} />);
    const xs = screen.getAllByRole('button', { name: /^Remove .* access$/ });
    expect(xs).toHaveLength(1);
    const group = xs[0].closest('[role="group"]');
    expect(within(group).getAllByRole('button', { pressed: true })).toHaveLength(1);
    fireEvent.click(xs[0]);
    expect(screen.queryAllByRole('button', { name: /^Remove .* access$/ })).toHaveLength(0);
    // Picking a level brings the x back on that chip.
    fireEvent.click(within(group).getAllByRole('button', { pressed: false })[0]);
    expect(screen.getAllByRole('button', { name: /^Remove .* access$/ })).toHaveLength(1);
  });
});
