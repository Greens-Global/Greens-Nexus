import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Accounting on a phone is one tap (Neil, Oct 1): the menu row goes straight
// into the module - no one-row "Reports" folder in between - and the view
// lands on the first tab the person may see, like the desktop sidebar.

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Test Person', username: 'test@example.com' }] }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
vi.mock('./Sidebar', () => ({ NAV: [
  { view: 'dashboard', label: 'Dashboard' },
  { view: 'accounting', label: 'Accounting', minRole: 'manager' },
  { view: 'inventory', label: 'Item Management' },
] }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ myRole: 'manager', isExternal: false, can: () => true, myGrantedModules: new Map([['accounting', 'viewer']]) }),
}));
vi.mock('../lib/peoplePhotos', () => ({ usePersonPhoto: () => '' }));

const { default: MobileMenu, SUBMENUS } = await import('./MobileMenu');

describe('mobile menu: Accounting', () => {
  it('has no sub-panel; one tap opens the module and closes the menu', () => {
    expect(SUBMENUS.accounting).toBeUndefined();
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<MobileMenu open onClose={onClose} onNavigate={onNavigate} activeView="dashboard" />);
    fireEvent.click(screen.getByRole('button', { name: 'Accounting' }));
    expect(onNavigate).toHaveBeenCalledWith('accounting', null);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Accounting' })).toBeNull();
  });

  it('modules with sub-screens still open their panel', () => {
    const onNavigate = vi.fn();
    render(<MobileMenu open onClose={() => {}} onNavigate={onNavigate} activeView="dashboard" />);
    fireEvent.click(screen.getByRole('button', { name: 'Item Management' }));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Item Management' })).toBeTruthy();
  });
});
