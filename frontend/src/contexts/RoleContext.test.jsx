import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// useRole() carries myLevel, myTier and myTitle (Neil, 11/02/2026). myLevel
// was computed but never put on the context (the latent bug): every ticket /
// task settings guard that reads `myLevel < 3` compared against undefined.

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Pat Lee', username: 'pat@greensglobal.com' }], inProgress: 'none' }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
const me = { value: { role: 'employee' } };
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, k) => (k === 'getMyRole' ? () => Promise.resolve(me.value) : () => Promise.resolve([])),
  }),
  setActAsSessionId: vi.fn(),
  getActAsSessionId: () => null,
}));

const { RoleProvider, useRole, ROLES, tierOf } = await import('./RoleContext');

function Probe() {
  const { myLevel, myTier, myTitle, loading } = useRole();
  if (loading) return <div>loading</div>;
  return <div data-testid="probe">{`${myLevel}|${myTier}|${myTitle}`}</div>;
}
const mount = () => render(<RoleProvider><Probe /></RoleProvider>);

afterEach(cleanup);

describe('useRole - myLevel, myTier, myTitle', () => {
  it('a manager with a title: level 3, the manager tier, the title', async () => {
    me.value = { role: 'manager', level: 3, title: 'Operations Manager', email: 'pat@greensglobal.com' };
    mount();
    expect((await screen.findByTestId('probe')).textContent).toBe('3|manager|Operations Manager');
  });

  it('an employee with no title: level 1, no tier, no title', async () => {
    me.value = { role: 'employee', level: 1, title: '', email: 'pat@greensglobal.com' };
    mount();
    expect((await screen.findByTestId('probe')).textContent).toBe('1||');
  });

  it('tolerates an older server answer without level or title (level from ROLES)', async () => {
    me.value = { role: 'administrator' };
    mount();
    expect((await screen.findByTestId('probe')).textContent).toBe('4|admin|');
  });

  it('a Super Administrator is level 5 and the super tier', async () => {
    me.value = { role: 'owner', level: 5, title: 'CEO' };
    mount();
    expect((await screen.findByTestId('probe')).textContent).toBe('5|super|CEO');
  });

  it('tierOf maps the levels and ROLES keeps its levels', () => {
    expect([5, 4, 3, 2, 1, 0, undefined].map(tierOf)).toEqual(['super', 'admin', 'manager', '', '', '', '']);
    expect(ROLES.owner.level).toBe(5);
    expect(ROLES.manager.level).toBe(3);
  });
});
