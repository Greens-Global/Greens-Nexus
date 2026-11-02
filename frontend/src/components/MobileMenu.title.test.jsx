import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// The line under the name on the phone menu is the person's JOB TITLE, never
// the Nexus tier (Neil, 11/02/2026: "It should not say global admin here under
// my name ... pull my title"). No title = nothing there (not "Employee"). The
// tier shows only as the small mark after the name.

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
vi.mock('./Sidebar', () => ({ NAV: [] }));

const roleState = { myRole: 'owner', myTier: 'super', myTitle: 'Chief Executive Officer', isExternal: false };
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    useRole: () => ({
      myRole: roleState.myRole, isExternal: roleState.isExternal, myTier: roleState.myTier, myTitle: roleState.myTitle,
      can: () => true, myGrantedModules: new Map(),
    }),
  };
});

const MobileMenu = (await import('./MobileMenu')).default;
const menu = () => render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="tasks" />);

afterEach(cleanup);

describe('phone menu - title under the name', () => {
  it('shows the job title, and the tier only as the mark after the name', () => {
    Object.assign(roleState, { myRole: 'owner', myTier: 'super', myTitle: 'Chief Executive Officer', isExternal: false });
    menu();
    expect(screen.getByText('Chief Executive Officer')).toBeTruthy();
    expect(screen.queryByText('Super Administrator')).toBeNull();
    expect(screen.queryByText('Employee')).toBeNull();
    const name = document.querySelector('.mobile-menu-name');
    expect(name.textContent).toContain('Neil Kadakia');
    expect(name.querySelector('[aria-label="Super Administrator"]')).toBeTruthy();
  });

  it('a manager carries the Manager mark, never the word', () => {
    Object.assign(roleState, { myRole: 'manager', myTier: 'manager', myTitle: 'Site Lead', isExternal: false });
    menu();
    expect(screen.getByText('Site Lead')).toBeTruthy();
    expect(screen.queryByText('Manager')).toBeNull();
    expect(screen.getByLabelText('Manager')).toBeTruthy();
  });

  it('no title, no mark for an employee: nothing under the name', () => {
    Object.assign(roleState, { myRole: 'employee', myTier: '', myTitle: '', isExternal: false });
    menu();
    expect(screen.queryByText('Employee')).toBeNull();
    expect(document.querySelector('.mobile-menu-role')).toBeNull();
    expect(document.querySelector('.mobile-menu-name svg')).toBeNull();
  });
});
