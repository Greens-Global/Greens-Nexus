import { describe, it, expect, vi } from 'vitest';

// Workforce Analytics moved into Team (Neil, Oct 29 2026) - and must not
// become visible to everyone with it. One rule (lib/workforceAccess.js) is
// read by Team's tab strip, the phone menu and the header search; old
// addresses land on the Team tab.
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));

const { canOpenWorkforceAnalytics, workforceRedirect } = await import('./workforceAccess');
const { visibleSubs } = await import('../components/MobileMenu');
const { NAV } = await import('../components/Sidebar');

const person = ({ tier = 1, grants = [] } = {}) => {
  const ranks = { employee: 1, supervisor: 2, manager: 3, administrator: 5 };
  const can = (r) => tier >= (ranks[r] ?? 1);
  return { can, canAccessModule: (m, minRole) => can(minRole) || grants.includes(m) };
};
const teamSubs = (p) => visibleSubs('shifts', p).map((s) => s.label);

describe('Workforce Analytics access', () => {
  it('is for administrators and its two grants only - never a plain manager', () => {
    expect(canOpenWorkforceAnalytics(person())).toBe(false);
    expect(canOpenWorkforceAnalytics(person({ tier: 3 }))).toBe(false);
    expect(canOpenWorkforceAnalytics(person({ grants: ['workforce-scorecard'] }))).toBe(true);
    expect(canOpenWorkforceAnalytics(person({ grants: ['employee-tracking'] }))).toBe(true);
    expect(canOpenWorkforceAnalytics(person({ tier: 5 }))).toBe(true);
    expect(canOpenWorkforceAnalytics({})).toBe(false);
  });

  it('the phone menu and the header search list the Team tab only for them', () => {
    expect(teamSubs(person())).toEqual(['Shifts', 'Company Directory']);
    expect(teamSubs(person({ tier: 3 }))).toEqual(['Shifts', 'Schedule', 'Requests', 'Company Directory']);
    expect(teamSubs(person({ grants: ['workforce-scorecard'] }))).toEqual(['Shifts', 'Workforce Analytics', 'Company Directory']);
    expect(teamSubs(person({ tier: 3, grants: ['employee-tracking'] })))
      .toEqual(['Shifts', 'Schedule', 'Requests', 'Workforce Analytics', 'Company Directory']);
    expect(teamSubs(person({ tier: 5 }))).toContain('Workforce Analytics');
  });

  it('an external guest is offered only the tab their grant opens', () => {
    expect(teamSubs({ ...person({ grants: ['employee-tracking'] }), isExternal: true })).toEqual(['Workforce Analytics']);
    expect(teamSubs({ ...person(), isExternal: true })).toEqual([]);
  });

  it('is off the left menu, and its old addresses land on the Team tab', () => {
    expect(NAV.find((n) => n.view === 'employee-tracking')?.menuOnly).toBe(true);
    expect(workforceRedirect('employee-tracking', null)).toEqual({ view: 'shifts', sub: 'analytics' });
    expect(workforceRedirect('employee-tracking', 'scorecard')).toEqual({ view: 'shifts', sub: 'analytics:scorecard' });
    expect(workforceRedirect('shifts', 'contact')).toBeNull();
  });
});
