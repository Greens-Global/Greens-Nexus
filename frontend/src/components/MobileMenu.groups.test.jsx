import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// The phone drawer wears the rail's brand (Neil, 11/07/2026): the same groups
// in the same order with Title Case labels, the time clock chip under the
// person, and a chevron only on a row that opens a list.

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Test Person', username: 'test@example.com' }] }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
vi.mock('./Sidebar', () => ({
  NAV: [
    { view: 'dashboard', label: 'Dashboard' },
    { view: 'hr', label: 'People', sub: [{ subview: 'contact', label: 'Directory' }] },
    { divider: true },
    { view: 'tasks', label: 'Tasks' },
    { divider: true },
    { view: 'accounting', label: 'Accounting' },
    { view: 'it', label: 'IT' },
    { divider: true },
    { view: 'support', label: 'Help Center' },
  ],
}));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ myRole: 'administrator', isExternal: false, can: () => true, myGrantedModules: new Map() }),
}));
vi.mock('../lib/peoplePhotos', () => ({ usePersonPhoto: () => '' }));
vi.mock('../lib/timeclockStore', () => ({ useTimeclock: () => ({ state: 'out', todayMin: 0 }), openTimeClock: vi.fn() }));

const MobileMenu = (await import('./MobileMenu')).default;

describe('mobile menu groups', () => {
  it('draws the rail groups in order, the clock chip, and chevrons only where a row opens a list', () => {
    render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="dashboard" />);
    expect([...document.querySelectorAll('.mm-kicker')].map((k) => k.textContent)).toEqual(['My Desk', 'Work', 'Operations', 'Finance', 'System']);
    const labels = [...document.querySelectorAll('.mobile-menu-rows:not(.secondary) .mobile-menu-row-label')].map((l) => l.textContent);
    expect(labels).toEqual(['Dashboard', 'People', 'Tasks', 'IT', 'Accounting', 'Help Center']);
    const chevrons = (name) => screen.getByRole('button', { name }).querySelectorAll('svg.lucide-chevron-right').length;
    expect(chevrons('People')).toBe(1);
    expect(chevrons('Tasks')).toBe(0);
    expect(screen.getByRole('button', { name: /Clocked Out/ })).toBeTruthy();
  });
});
