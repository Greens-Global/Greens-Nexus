import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

// A shorter phone menu (Neil, 11/10/2026): past FOLD_AT modules, the groups
// after Work fold to one row each that opens in place; My Desk and Work stay
// open, a group of one never folds, the group holding the open page opens by
// itself, and what was opened is remembered in this browser.

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Test Person', username: 'test@example.com' }] }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
const nav = vi.hoisted(() => ({ items: [] }));
vi.mock('./Sidebar', () => ({ get NAV() { return nav.items; } }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ myRole: 'administrator', isExternal: false, can: () => true, myGrantedModules: new Map() }),
}));
vi.mock('../lib/peoplePhotos', () => ({ usePersonPhoto: () => '' }));
vi.mock('../lib/timeclockStore', async (importOriginal) => ({
  ...(await importOriginal()),
  useTimeclock: () => ({ state: 'out', todayMin: 0 }),
  openTimeClock: vi.fn(),
}));

const { default: MobileMenu, FOLD_AT } = await import('./MobileMenu');

const FULL = [
  { view: 'dashboard', label: 'Dashboard' }, { view: 'workday', label: 'Workday' }, { view: 'shifts', label: 'Team' },
  { divider: true },
  { view: 'tasks', label: 'Tasks' }, { view: 'tickets', label: 'Tickets' }, { view: 'files', label: 'Files' },
  { view: 'documents', label: 'Documents' }, { view: 'credvault', label: 'Credentials' },
  { divider: true },
  { view: 'property-asset', label: 'Asset Management' }, { view: 'ops', label: 'Construction' }, { view: 'it', label: 'IT' },
  { view: 'inventory', label: 'Item Management' }, { view: 'operations', label: 'Operations' },
  { view: 'accounting', label: 'Accounting' }, { view: 'investor-relations', label: 'Investor Relations' },
  { view: 'marketing', label: 'Marketing' }, { view: 'hr', label: 'People' },
  { divider: true },
  { view: 'support', label: 'Help Center' }, { view: 'settings', label: 'Settings' },
];
const rowLabels = () => [...document.querySelectorAll('.mobile-menu-rows:not(.secondary) .mobile-menu-row')].map((r) => r.textContent);
const group = (name) => [...document.querySelectorAll('.mm-group')].find((g) => g.firstChild.textContent === name);

describe('mobile menu folding groups', () => {
  beforeEach(() => { localStorage.clear(); nav.items = FULL; });

  it('folds the groups after Work when there are more than FOLD_AT modules', () => {
    expect(FULL.filter((i) => !i.divider).length).toBeGreaterThan(FOLD_AT);
    render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="dashboard" />);
    expect(rowLabels()).toEqual(['Dashboard', 'Workday', 'Team', 'Tasks', 'Tickets', 'Files', 'Documents', 'Credentials']);
    for (const name of ['Operations', 'Finance', 'Company', 'System']) {
      expect(group(name).getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('opens a group in place and remembers it', () => {
    const { unmount } = render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="dashboard" />);
    fireEvent.click(group('Finance'));
    expect(group('Finance').getAttribute('aria-expanded')).toBe('true');
    expect(rowLabels()).toContain('Investor Relations');
    unmount();
    render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="dashboard" />);
    expect(rowLabels()).toContain('Accounting');
    expect(group('Operations').getAttribute('aria-expanded')).toBe('false');
  });

  it("opens the group holding the page you are on", () => {
    render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="it" />);
    expect(group('Operations').getAttribute('aria-expanded')).toBe('true');
    expect(rowLabels()).toContain('IT');
  });

  it('shows everything flat for someone with a handful of modules', () => {
    nav.items = [
      { view: 'dashboard', label: 'Dashboard' }, { divider: true }, { view: 'tasks', label: 'Tasks' },
      { divider: true }, { view: 'it', label: 'IT' }, { view: 'inventory', label: 'Item Management' },
      { divider: true }, { view: 'support', label: 'Help Center' },
    ];
    render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="dashboard" />);
    expect(document.querySelector('.mm-group')).toBe(null);
    expect(rowLabels()).toEqual(['Dashboard', 'Tasks', 'IT', 'Item Management', 'Help Center']);
  });
});
