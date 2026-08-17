import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// External users are badged "External" wherever a role/tier label renders
// (Visesh, Aug 18) - Pranshu's live guest test showed "Employee" in the
// profile chip. All three chip sites (TopHeader, Sidebar, MobileMenu) resolve
// the label with the same `isExternal ? EXTERNAL_ROLE_META : ROLES[myRole]`
// expression; MobileMenu is the lightest to mount, so it is the render probe.

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Jane Doe', username: 'jane.doe@acmeconstruction.com' }] }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
vi.mock('./Sidebar', () => ({ NAV: [] }));

const roleState = { isExternal: true, myRole: 'employee' };
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();   // keep the REAL ROLES / EXTERNAL_ROLE_META
  return {
    ...real,
    useRole: () => ({
      myRole: roleState.myRole, isExternal: roleState.isExternal,
      can: () => false, myGrantedModules: new Map([['tasks', 'editor']]),
    }),
  };
});

const { EXTERNAL_ROLE_META } = await import('../contexts/RoleContext');
const MobileMenu = (await import('./MobileMenu')).default;

describe('external role label', () => {
  it('EXTERNAL_ROLE_META reads External at employee level', () => {
    expect(EXTERNAL_ROLE_META.label).toBe('External');
    expect(EXTERNAL_ROLE_META.level).toBe(1);
  });

  it('shows External, not Employee, for an external account', () => {
    roleState.isExternal = true;
    render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="tasks" />);
    expect(screen.getByText('External')).toBeTruthy();
    expect(screen.queryByText('Employee')).toBeNull();
  });

  it('internal employees are unchanged', () => {
    roleState.isExternal = false;
    render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="tasks" />);
    expect(screen.getByText('Employee')).toBeTruthy();
    expect(screen.queryByText('External')).toBeNull();
  });
});
