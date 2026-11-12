import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

// Three grant levels (11/2026): Owner is retired. The bundle editor offers
// Viewer / Editor / Full per row, a legacy 'owner' row reads as Full, and
// "What does this unlock?" opens the Level Guide for that module.

vi.mock('../api', () => ({
  api: new Proxy({}, { get: () => vi.fn(() => Promise.resolve([])) }),
}));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn(() => Promise.resolve(true)) } }));

const { RoleEditor } = await import('./RolesAccess');
const { SUPER_LINE, MODULE_CAPABILITIES } = await import('../lib/moduleCapabilities');

afterEach(() => { cleanup(); });

const role = (allowed_modules) => ({ id: 'r1', name: 'Analyst', tier: 'employee', department: '', description: '', allowed_modules });

describe('Role editor - three levels and the Level Guide', () => {
  it('offers exactly Viewer, Editor and Full on every row', () => {
    render(<RoleEditor role={role([])} jobRoles={[]} onClose={() => {}} onSaved={() => {}} onErr={() => {}} />);
    const rows = screen.getAllByRole('group', { name: / level$/ });
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) {
      const names = within(row).getAllByRole('button').filter(b => b.hasAttribute('aria-pressed')).map(b => b.textContent);
      expect(names).toEqual(['Viewer', 'Editor', 'Full']);
    }
    expect(screen.queryByText('Owner')).toBeNull();
  });

  it('renders a legacy owner grant as Full', () => {
    render(<RoleEditor role={role([{ id: 'tasks', level: 'owner' }])} jobRoles={[]} onClose={() => {}} onSaved={() => {}} onErr={() => {}} />);
    const row = screen.getByRole('group', { name: 'Tasks level' });
    const pressed = within(row).getAllByRole('button', { pressed: true });
    expect(pressed).toHaveLength(1);
    expect(pressed[0].textContent).toBe('Full');
    expect(screen.getByText(MODULE_CAPABILITIES.tasks.full)).toBeInTheDocument();
  });

  it('"What does this unlock?" opens the Level Guide for that module', () => {
    render(<RoleEditor role={role([])} jobRoles={[]} onClose={() => {}} onSaved={() => {}} onErr={() => {}} />);
    fireEvent.click(within(screen.getByText('Tasks').parentElement).getByRole('button', { name: /What does this unlock\?/ }));
    const guide = document.querySelector('[data-tour="level-guide"]');
    expect(guide).toBeTruthy();
    expect(within(guide).getByRole('combobox', { name: 'Module' }).value).toBe('tasks');
    for (const level of ['viewer', 'editor', 'full']) {
      expect(within(guide).getByText(MODULE_CAPABILITIES.tasks[level])).toBeInTheDocument();
    }
    expect(within(guide).getByText('Manager tier - all of Full without a grant')).toBeInTheDocument();
    expect(within(guide).getByText(SUPER_LINE)).toBeInTheDocument();
    // No Open in Matrix without a parent to jump to (Company Settings' editor).
    expect(screen.queryByRole('button', { name: 'Open in Matrix' })).toBeNull();
  });

  it('Open in Matrix closes a clean editor and hands the module to the parent', () => {
    const onClose = vi.fn(); const onOpenGuide = vi.fn();
    render(<RoleEditor role={role([])} jobRoles={[]} onClose={onClose} onSaved={() => {}} onErr={() => {}} onOpenGuide={onOpenGuide} />);
    fireEvent.click(screen.getAllByRole('button', { name: /What does this unlock\?/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Open in Matrix' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenGuide).toHaveBeenCalledWith('dashboard');
  });
});
