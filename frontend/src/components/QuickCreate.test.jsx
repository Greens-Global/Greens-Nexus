import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// The header's Create menu (Neil, Oct 29 2026): a "+" beside the search bar.
// It opens on the first row, the arrows move, Escape closes back to the "+",
// a row the person cannot use is not offered, and each row lands on its
// module's own create flow.

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Pat Lee', username: 'pat@greensglobal.com' }] }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
vi.mock('./NotificationBell', () => ({ default: () => null }));
vi.mock('../support/HelpMenu', () => ({ default: () => <button aria-label="Help">?</button> }));
vi.mock('./MyProfileModal', () => ({ default: () => null }));
vi.mock('../dashboard/QuickActionModals.jsx', () => ({ default: ({ kind }) => <div role="dialog" aria-label={`Composer ${kind}`} /> }));
const perfMe = vi.fn(() => Promise.resolve({ hasTeam: true }));
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => (k === 'perfMe' ? perfMe : k === 'qaEnabled' ? () => Promise.resolve({ enabled: false }) : () => Promise.resolve({})) }),
}));
// An employee whose Access Groups give Tasks and Documents, and Credentials
// at viewer level only - no Workflows.
let ROLE = {};
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ROLE,
}));
vi.mock('../contexts/InventoryContext', () => ({ useInventory: () => ({ items: [], checkouts: [] }) }));
vi.mock('../contexts/RequisitionContext', () => ({ useRequisitions: () => ({ requisitions: [] }) }));

const { default: TopHeader } = await import('./TopHeader');
const { HeaderTabsProvider } = await import('./ModuleTabs');

const employee = () => {
  const granted = new Map([['tasks', 'editor'], ['documents', 'viewer'], ['credvault', 'viewer']]);
  return {
    myRole: 'employee', isExternal: false, myEmail: 'pat@greensglobal.com', actingAs: null, stopActAs: vi.fn(),
    can: (r) => r === 'employee', myGrantedModules: granted,
    canAccessModule: (m, minRole, level) => (granted.get(m) === 'editor' || granted.get(m) === 'full' ? true : level === 'viewer' && granted.has(m)),
  };
};

afterEach(() => { cleanup(); perfMe.mockClear(); });

const header = () => render(
  <HeaderTabsProvider>
    <TopHeader title="Dashboard" activeView="dashboard" theme="light" onThemeToggle={() => {}} onNavigate={() => {}} />
  </HeaderTabsProvider>,
);
const plus = () => screen.getByRole('button', { name: 'Create' });
const rows = () => screen.getAllByRole('menuitem').map((el) => el.textContent.trim());

describe('Header Create menu', () => {
  it('sits beside the search bar and opens on its first row', async () => {
    ROLE = employee();
    header();
    const btn = plus();
    expect(btn.title).toBe('Create');
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.closest('.header-right')).toBeTruthy();
    expect(btn.closest('.qc-wrap').previousElementSibling.classList.contains('hdr-search')).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    await act(async () => { fireEvent.click(btn); });
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu', { name: 'Create' })).toBeTruthy();
    expect(document.activeElement.textContent.trim()).toBe('New Task');
    // Section labels and rows in order. No 1:1, Ask HR, Reimbursement,
    // Credential, Purchase Request, Send for Signature, Workflow or Time Off
    // (Neil, Oct 29 2026).
    expect([...document.querySelectorAll('.qc-menu .hud-sec')].map((e) => e.textContent)).toEqual(['Work', 'Requests', 'Outlook']);
    expect(rows()).toEqual(['New Task', 'New Note', 'New Ticket', 'New Document', 'Request an Item', 'New Email', 'New Event']);
  });

  it('hides what the person cannot use', async () => {
    // Without a Tasks grant, no New Task; an administrator still gets no
    // Workflow, Credential or Time Off row.
    ROLE = { ...employee(), myGrantedModules: new Map() };
    header();
    await act(async () => { fireEvent.click(plus()); });
    expect(rows()).not.toContain('New Task');
    expect(rows()).toContain('New Ticket');
    cleanup();
    ROLE = { ...employee(), myRole: 'administrator', can: () => true, canAccessModule: () => true };
    header();
    await act(async () => { fireEvent.click(plus()); });
    expect(rows()).toContain('New Task');
    ['New Workflow', 'New Credential', 'Request Time Off'].forEach((r) => expect(rows()).not.toContain(r));
  });

  it('is not shown to an external guest with no module that creates anything', () => {
    ROLE = { ...employee(), isExternal: true, myGrantedModules: new Map([['accounting', 'viewer']]) };
    header();
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
  });

  it('arrows move, Escape closes back to the "+", a click outside closes', async () => {
    ROLE = employee();
    header();
    await act(async () => { fireEvent.click(plus()); });
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement.textContent.trim()).toBe('New Note');
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement.textContent.trim()).toBe(rows().at(-1));   // wraps to the last row
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement.textContent.trim()).toBe('New Task');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(plus());
    fireEvent.keyDown(plus(), { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a composer row opens in place; a module row navigates to its create sub', async () => {
    ROLE = employee();
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    try {
      header();
      await act(async () => { fireEvent.click(plus()); });
      await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'New Task' })); });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(await screen.findByRole('dialog', { name: 'Composer task' })).toBeTruthy();
      expect(nav).not.toHaveBeenCalled();
      await act(async () => { fireEvent.click(plus()); });
      const quick = vi.fn();
      window.addEventListener('nexus:quick-note', quick);
      fireEvent.click(screen.getByRole('menuitem', { name: 'New Note' }));
      window.removeEventListener('nexus:quick-note', quick);
      expect(quick).toHaveBeenCalledTimes(1);
      await act(async () => { fireEvent.click(plus()); });
      fireEvent.click(screen.getByRole('menuitem', { name: 'Request an Item' }));
      expect(nav.mock.calls.at(-1)[0].detail).toEqual({ view: 'inventory', sub: 'catalog' });
      await act(async () => { fireEvent.click(plus()); });
      fireEvent.click(screen.getByRole('menuitem', { name: 'New Document' }));
      expect(nav.mock.calls.at(-1)[0].detail).toEqual({ view: 'documents', sub: 'documents-new' });
    } finally {
      window.removeEventListener('nexus:navigate', nav);
    }
  });

  it('Performance reads "performance:1on1:new" as Set Up a 1:1, not a 1:1 called "new"', async () => {
    const { parsePerfSub } = await import('../performance/lib');
    expect(parsePerfSub('performance:1on1:new')).toMatchObject({ view: 'me', oneOnOne: '', newOneOnOne: true });
    expect(parsePerfSub('performance:1on1:abc')).toMatchObject({ oneOnOne: 'abc', newOneOnOne: false });
  });
});
