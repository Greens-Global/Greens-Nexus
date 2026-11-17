import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { __resetBackToClose } from '../lib/useBackToClose';

// The phone menu is a full-screen sheet: the phone's Back and Escape take
// its top layer off - the sub-panel, then the menu. Back used to change the
// screen underneath and leave the menu standing over it; there was no Escape.
// Also here: a module whose sub-list comes back empty opens the module (a
// guest got an empty panel), and Item Management lists its real tabs.

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Test Person', username: 'test@example.com' }] }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
const nav = vi.hoisted(() => ({ items: [], role: {} }));
vi.mock('./Sidebar', () => ({ get NAV() { return nav.items; } }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => nav.role,
}));
vi.mock('../lib/peoplePhotos', () => ({ usePersonPhoto: () => '' }));
vi.mock('../lib/timeclockStore', async (importOriginal) => ({
  ...(await importOriginal()),
  useTimeclock: () => ({ state: 'out', todayMin: 0 }),
  openTimeClock: vi.fn(),
}));

const { default: MobileMenu, visibleSubs } = await import('./MobileMenu');

// Wait for a history traversal (jsdom runs back()/go() asynchronously).
const settle = (ms = 30) => act(() => new Promise((r) => setTimeout(r, ms)));
const staff = { myRole: 'manager', isExternal: false, can: (r) => r !== 'administrator', canAccessModule: () => true, myGrantedModules: new Map() };

let appPop;
beforeEach(async () => {
  await settle();            // an earlier test's menu is still stepping history back
  __resetBackToClose();
  nav.role = staff;
  nav.items = [{ view: 'dashboard', label: 'Dashboard' }, { view: 'hr', label: 'People' }, { view: 'inventory', label: 'Item Management' }];
  window.history.replaceState({ depth: 2, fromLabel: 'Home' }, '', '/tasks');
  // Stand-in for App.jsx's popstate listener: it must never hear the menu's Back.
  appPop = vi.fn();
  window.addEventListener('popstate', appPop);
});
afterEach(() => { window.removeEventListener('popstate', appPop); cleanup(); });

describe('the phone menu closes on Back and Escape', () => {
  it('Back closes the menu and the screen underneath does not move', async () => {
    const onClose = vi.fn();
    render(<MobileMenu open onClose={onClose} onNavigate={() => {}} activeView="tasks" />);
    expect(window.history.state.nxSheet).toBeTruthy();   // its own entry, App's stamp kept
    expect(window.history.state.depth).toBe(2);
    await act(async () => { window.history.back(); });
    await settle();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(window.location.pathname).toBe('/tasks');
    expect(appPop).not.toHaveBeenCalled();
  });

  it('Back steps out of a sub-panel first, then closes the menu', async () => {
    const onClose = vi.fn();
    render(<MobileMenu open onClose={onClose} onNavigate={() => {}} activeView="tasks" />);
    fireEvent.click(screen.getByText('People'));
    expect(screen.getByRole('dialog', { name: 'People' })).toBeTruthy();
    await act(async () => { window.history.back(); });
    await settle(320);
    expect(screen.queryByRole('dialog', { name: 'People' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { window.history.back(); });
    await settle();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(appPop).not.toHaveBeenCalled();
  });

  it('Escape does the same, and leaves a popup over the menu its own Escape', async () => {
    const onClose = vi.fn();
    render(<MobileMenu open onClose={onClose} onNavigate={() => {}} activeView="tasks" />);
    fireEvent.click(screen.getByText('People'));
    const over = document.body.appendChild(Object.assign(document.createElement('div'), { role: 'dialog' }));
    over.setAttribute('aria-modal', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    await settle(320);
    expect(screen.getByRole('dialog', { name: 'People' })).toBeTruthy();
    over.remove();
    fireEvent.keyDown(document, { key: 'Escape' });
    await settle(320);
    expect(screen.queryByRole('dialog', { name: 'People' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('a module with no sub-screen to offer opens itself', () => {
  it('an external guest taps People and lands in People, never on an empty panel', () => {
    nav.role = { myRole: 'employee', isExternal: true, can: () => false, canAccessModule: () => false, myGrantedModules: new Map([['hr', 'viewer']]) };
    expect(visibleSubs('hr', nav.role)).toEqual([]);
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<MobileMenu open onClose={onClose} onNavigate={onNavigate} activeView="hr" />);
    const row = screen.getByText('People').closest('button');
    expect(row.querySelectorAll('svg').length).toBe(0);   // no "more inside" arrow
    fireEvent.click(row);
    expect(document.querySelector('.mobile-submenu')).toBeNull();
    expect(onNavigate).toHaveBeenCalledWith('hr', null);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Item Management's sub-screens are its real tabs", () => {
  const labels = (role) => visibleSubs('inventory', role).map((s) => `${s.sub}:${s.label}`);
  const person = ({ tier = 1, itemsManager = false } = {}) => {
    const ranks = { employee: 1, supervisor: 2, manager: 3, administrator: 5 };
    return { can: (r) => tier >= (ranks[r] ?? 1), canAccessModule: (m) => m === 'inventory' && itemsManager };
  };

  it('My Stuff and Borrow for everyone; Requests for supervisors and items managers; Inventory for items managers', () => {
    expect(labels(person())).toEqual(['mystuff:My Stuff', 'borrow:Borrow']);
    expect(labels(person({ tier: 2 }))).toEqual(['mystuff:My Stuff', 'borrow:Borrow', 'requests:Requests']);
    expect(labels(person({ itemsManager: true }))).toEqual(['mystuff:My Stuff', 'borrow:Borrow', 'requests:Requests', 'inventory:Inventory']);
  });

  it('none of the retired tabs is listed', () => {
    const all = labels(person({ tier: 5, itemsManager: true })).join(' ');
    for (const gone of ['My Items', 'Catalog', 'Manage', 'Checkouts', 'Who Has What', 'Audit Log']) expect(all).not.toContain(gone);
  });
});
