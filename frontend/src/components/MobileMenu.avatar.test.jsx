import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// The phone menu's profile card shows the person's own photo when the Nexus
// People directory has one (Sep 22), and their initials otherwise - the same
// source and fallback the header pill uses.

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Neil Kadakia', username: 'neil@example.com' }] }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
vi.mock('./Sidebar', () => ({ NAV: [] }));
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    useRole: () => ({ myRole: 'employee', isExternal: false, can: () => false, myGrantedModules: new Map() }),
  };
});

const photoState = { url: '' };
vi.mock('../lib/peoplePhotos', () => ({
  usePersonPhoto: (email) => (email === 'neil@example.com' ? photoState.url : ''),
}));

const MobileMenu = (await import('./MobileMenu')).default;

describe('mobile menu profile photo', () => {
  it('shows the directory photo when the person has one', () => {
    photoState.url = 'https://example.test/photos/neil.jpg';
    const { container } = render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="tasks" />);
    const img = container.querySelector('.mobile-menu-avatar img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('https://example.test/photos/neil.jpg');
    expect(screen.queryByText('NK')).toBeNull();
    expect(screen.getByText('Neil Kadakia')).toBeTruthy();
  });

  it('falls back to initials without a photo', () => {
    photoState.url = '';
    const { container } = render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="tasks" />);
    expect(container.querySelector('.mobile-menu-avatar img')).toBeNull();
    expect(screen.getByText('NK')).toBeTruthy();
  });
});
