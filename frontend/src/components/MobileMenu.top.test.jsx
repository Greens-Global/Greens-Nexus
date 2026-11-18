import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// The phone menu's top (Neil, 11/13/2026: "we don't need the Nexus name ...
// Don't need name or title either. Let's reduce bloat"): ONE row - the time
// clock chip and the close button - then the modules. No N tile or wordmark,
// no photo, no name, no job title and no tier mark.

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Neil Kadakia', username: 'neil@example.com' }] }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
vi.mock('./Sidebar', () => ({ NAV: [] }));
vi.mock('../lib/peoplePhotos', () => ({ usePersonPhoto: () => 'https://example.test/photos/neil.jpg' }));
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    useRole: () => ({
      myRole: 'owner', myTier: 'super', myTitle: 'Chief Executive Officer', isExternal: false,
      can: () => true, myGrantedModules: new Map(),
    }),
  };
});

const MobileMenu = (await import('./MobileMenu')).default;
afterEach(cleanup);

describe('phone menu - no brand, no profile card', () => {
  it('opens on the close button with no wordmark, photo, name, title or tier mark', () => {
    const { container } = render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="tasks" />);
    expect(screen.getAllByRole('button', { name: 'Close menu' }).length).toBe(1);
    expect(screen.queryByText('Nexus')).toBeNull();
    expect(container.querySelector('.dk-mark')).toBeNull();
    expect(screen.queryByText('Neil Kadakia')).toBeNull();
    expect(screen.queryByText('NK')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByText('Chief Executive Officer')).toBeNull();
    expect(screen.queryByLabelText('Super Administrator')).toBeNull();
  });

  it('the close button shares the top row with the time clock', () => {
    const { container } = render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="tasks" />);
    const head = container.querySelector('.mobile-menu-head');
    expect(head.querySelector('.mobile-menu-clock')).toBeTruthy();
    expect(head.querySelector('[aria-label="Close menu"]')).toBeTruthy();
  });
});
