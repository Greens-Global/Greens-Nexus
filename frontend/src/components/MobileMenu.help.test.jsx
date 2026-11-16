import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Neil, 11/16/2026: "I don't think help and legal are needed in the main
// navigation on mobile". The phone menu has no Help or Legal row: Legal is in
// the profile dropdown (the header's photo) and Help Center is a module.

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

describe('mobile menu', () => {
  it('has no Help or Legal row, and keeps Sign Out', () => {
    render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="dashboard" />);
    expect(screen.queryByRole('button', { name: /^Help$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Legal$/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Sign Out/ })).toBeTruthy();
  });
});
