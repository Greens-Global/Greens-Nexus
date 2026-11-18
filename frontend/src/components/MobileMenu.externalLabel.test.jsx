import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// External users are badged "External" wherever a role/tier label renders
// (Visesh, Aug 18) - Pranshu's live guest test showed "Employee" in the
// profile chip. The label comes from EXTERNAL_ROLE_META; the phone menu no
// longer shows a role line at all (Neil, 11/13/2026).

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

  // The phone menu no longer carries a name or a line under it (Neil,
  // 11/13/2026), so it shows no role word at all - for an external account
  // neither "External" nor "Employee".
  it('the phone menu shows no role word for an external account', () => {
    roleState.isExternal = true;
    render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="tasks" />);
    expect(screen.queryByText('External')).toBeNull();
    expect(screen.queryByText('Employee')).toBeNull();
  });
});
