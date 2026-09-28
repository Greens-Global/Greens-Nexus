import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Phones have no room for the header's "?" button, so the phone menu carries a
// Help row that closes the menu and opens the same Help menu.

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Test Person', username: 'test@example.com' }] }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
vi.mock('./Sidebar', () => ({ NAV: [] }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ myRole: 'employee', isExternal: false, can: () => false, myGrantedModules: new Map() }),
}));
vi.mock('../lib/peoplePhotos', () => ({ usePersonPhoto: () => '' }));

const MobileMenu = (await import('./MobileMenu')).default;

describe('mobile menu Help row', () => {
  it('closes the menu and asks the Help menu to open', async () => {
    const onClose = vi.fn();
    const opened = vi.fn();
    window.addEventListener('nexus:help-open', opened);
    render(<MobileMenu open onClose={onClose} onNavigate={() => {}} activeView="dashboard" />);
    fireEvent.click(screen.getByRole('button', { name: /Help/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(() => new Promise((r) => { setTimeout(r, 5); }));
    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener('nexus:help-open', opened);
  });
});
