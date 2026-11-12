import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// The header's Quick Actions menu (Neil, 11/12/2026): a green bolt beside the
// search bar, where the "+" Create menu was. The first tap shows the top row
// (one tap each) and a row per group; a group row opens its own list. A row
// the person cannot use is not offered, and each row lands on its module's
// own create flow.

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
const bolt = () => screen.getByRole('button', { name: 'Quick Actions' });
// A row's name as it is read out: its label, without the shortcut hint beside it.
const nameOf = (el) => {
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
  const copy = el.cloneNode(true);
  copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return copy.textContent.trim();
};
const rows = () => screen.getAllByRole('menuitem').map(nameOf);
const open = async () => { await act(async () => { fireEvent.click(bolt()); }); };
const step = async (name) => { await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name })); }); };
const focused = () => nameOf(document.activeElement);

describe('Header Quick Actions menu', () => {
  it('sits beside the search bar and opens on its first action', async () => {
    ROLE = employee();
    header();
    const btn = bolt();
    expect(btn.title).toBe('Quick Actions');
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.closest('.header-right')).toBeTruthy();
    expect(btn.closest('.qc-wrap').previousElementSibling.classList.contains('hdr-search')).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    await open();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu', { name: 'Quick Actions' })).toBeTruthy();
    expect(focused()).toBe('New Task');
    // The top row in Neil's order (11/12/2026), then a row per group.
    expect([...document.querySelectorAll('.qc-tile')].map((e) => e.textContent.trim())).toEqual(['New Task', 'New Ticket', 'New Note', 'New Board']);
    expect(rows()).toEqual(['New Task', 'New Ticket', 'New Note', 'New Board', 'New', 'Request', 'Send']);
    // A group row says what is inside it.
    expect(screen.getByRole('menuitem', { name: 'Send' }).textContent).toContain('Email, Event Invite, Kudos');
  });

  it('a group row opens its own list, and the line back returns to it', async () => {
    ROLE = employee();
    header();
    await open();
    await step('Request');
    expect(screen.getByRole('menu', { name: 'Request' })).toBeTruthy();
    expect(rows()).toEqual(['Back to Quick Actions', 'Time Off', 'Reimbursement', 'Purchase Request', 'Item', 'Fill a Form', 'Time Sheet Fix']);
    expect(focused()).toBe('Time Off');
    await step('Back to Quick Actions');
    expect(screen.getByRole('menu', { name: 'Quick Actions' })).toBeTruthy();
    expect(focused()).toBe('Request');
    await step('New');
    expect(rows().slice(1)).toEqual(['Task', 'Ticket', 'Note', 'Board', 'Document']);
    // The shortcut that already exists is shown beside its row.
    expect(screen.getByRole('menuitem', { name: 'Task' }).querySelector('.hud-end').textContent).toBe('CT');
    await step('Back to Quick Actions');
    await step('Send');
    expect(rows().slice(1)).toEqual(['Email', 'Event Invite', 'Kudos']);
    // No 1:1, Ask HR, Credential, Send for Signature or Workflow anywhere (Neil, Oct 29 2026).
  });

  it('hides what the person cannot use', async () => {
    // Without a Tasks grant there is no New Task, and the top row fills from
    // the next thing the person can start.
    ROLE = { ...employee(), myGrantedModules: new Map() };
    header();
    await open();
    expect([...document.querySelectorAll('.qc-tile')].map((e) => e.textContent.trim())).toEqual(['New Ticket', 'New Note', 'New Board', 'Fill a Form']);
    cleanup();
    // A person whose time is not tracked has no Time Sheet to fix.
    ROLE = { ...employee(), timeTrackingExempt: true };
    header();
    await open();
    await step('Request');
    expect(rows()).not.toContain('Time Sheet Fix');
    expect(rows()).toContain('Time Off');
    cleanup();
    // An administrator still gets no Workflow or Credential row.
    ROLE = { ...employee(), myRole: 'administrator', can: () => true, canAccessModule: () => true };
    header();
    await open();
    await step('New');
    expect(rows()).toContain('Task');
    ['Workflow', 'Credential'].forEach((r) => expect(rows()).not.toContain(r));
  });

  it('is not shown to an external guest with no module that starts anything', () => {
    ROLE = { ...employee(), isExternal: true, myGrantedModules: new Map([['accounting', 'viewer']]) };
    header();
    expect(screen.queryByRole('button', { name: 'Quick Actions' })).toBeNull();
  });

  it('two taps only where there is a choice: a group of one is that action, a group the top row covers is left out', async () => {
    // A guest with the Dashboard, Tasks, the Help Center and Items: the top
    // row is every "New", Request is one action, Send is Outlook's two. No Kudos for a guest.
    ROLE = { ...employee(), isExternal: true, myGrantedModules: new Map([['dashboard', 'viewer'], ['tasks', 'editor'], ['support', 'viewer'], ['inventory', 'viewer']]) };
    header();
    await open();
    expect(rows()).toEqual(['New Task', 'New Ticket', 'New Note', 'New Board', 'Request an Item', 'Send']);
    await step('Send');
    expect(rows().slice(1)).toEqual(['Email', 'Event Invite']);
  });

  it('the keys: arrows, a letter, Right into a group, Left and Escape back out, Escape closes back to the bolt, a click outside closes', async () => {
    ROLE = employee();
    header();
    await open();
    const menu = () => screen.getByRole('menu');
    fireEvent.keyDown(menu(), { key: 'ArrowRight' });
    expect(focused()).toBe('New Ticket');
    fireEvent.keyDown(menu(), { key: 'ArrowLeft' });
    expect(focused()).toBe('New Task');
    fireEvent.keyDown(menu(), { key: 'ArrowDown' });   // from the top row to the first row under it
    expect(focused()).toBe('New');
    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(focused()).toBe('Request');
    fireEvent.keyDown(menu(), { key: 'End' });
    expect(focused()).toBe('Send');
    fireEvent.keyDown(menu(), { key: 'ArrowDown' });   // wraps to the first action
    expect(focused()).toBe('New Task');
    fireEvent.keyDown(menu(), { key: 't' });           // a letter: the next row that starts with it
    expect(focused()).toBe('New Ticket');
    fireEvent.keyDown(menu(), { key: 't' });
    expect(focused()).toBe('New Task');
    fireEvent.keyDown(menu(), { key: 'r' });
    expect(focused()).toBe('Request');
    await act(async () => { fireEvent.keyDown(menu(), { key: 'ArrowRight' }); });
    expect(screen.getByRole('menu', { name: 'Request' })).toBeTruthy();
    expect(focused()).toBe('Time Off');
    fireEvent.keyDown(menu(), { key: 'ArrowUp' });
    expect(focused()).toBe('Back to Quick Actions');
    await act(async () => { fireEvent.keyDown(menu(), { key: 'ArrowLeft' }); });
    expect(screen.getByRole('menu', { name: 'Quick Actions' })).toBeTruthy();
    expect(focused()).toBe('Request');
    await act(async () => { fireEvent.keyDown(menu(), { key: 'ArrowRight' }); });
    await act(async () => { fireEvent.keyDown(menu(), { key: 'Escape' }); });   // Escape in a group steps back, it does not close
    expect(screen.getByRole('menu', { name: 'Quick Actions' })).toBeTruthy();
    fireEvent.keyDown(menu(), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(bolt());
    fireEvent.keyDown(bolt(), { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a composer row opens in place; a module row navigates to its create sub', async () => {
    ROLE = employee();
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    const went = () => nav.mock.calls.at(-1)[0].detail;
    try {
      header();
      await open();
      await step('New Task');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(await screen.findByRole('dialog', { name: 'Composer task' })).toBeTruthy();
      expect(nav).not.toHaveBeenCalled();
      const go = async (group, row) => { await open(); await step(group); fireEvent.click(screen.getByRole('menuitem', { name: row })); };
      await go('Request', 'Item');
      expect(went()).toEqual({ view: 'inventory', sub: 'catalog' });
      expect(screen.queryByRole('menu')).toBeNull();
      await go('New', 'Document');
      expect(went()).toEqual({ view: 'documents', sub: 'documents-new' });
      await go('Request', 'Time Off');
      expect(went()).toEqual({ view: 'timeclock', sub: 'timeoff' });
      await go('Request', 'Reimbursement');
      expect(went()).toEqual({ view: 'timeclock', sub: 'reimbursements:new' });
      await go('Request', 'Purchase Request');
      expect(went()).toEqual({ view: 'timeclock', sub: 'purchase:new' });
      await go('Request', 'Time Sheet Fix');
      expect(went()).toEqual({ view: 'timeclock', sub: 'timesheet' });
      await go('Send', 'Kudos');
      expect(went()).toEqual({ view: 'timeclock', sub: 'performance:kudos:new' });
      // The menu opens on its first step again, never where it was left.
      await open();
      expect(screen.getByRole('menu', { name: 'Quick Actions' })).toBeTruthy();
    } finally {
      window.removeEventListener('nexus:navigate', nav);
    }
  });

  it('on a phone, New Note is in the top row and opens Quick Note', async () => {
    // The Quick Note button leaves the phone's top bar (Neil, Oct 29 2026).
    ROLE = employee();
    const mm = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q === '(max-width: 900px)', media: q, addEventListener() {}, removeEventListener() {} });
    const opened = vi.fn();
    window.addEventListener('nexus:quick-note', opened);
    try {
      header();
      await open();
      expect(rows().slice(0, 4)).toEqual(['New Task', 'New Ticket', 'New Note', 'New Board']);
      await step('New Note');
      expect(opened).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      window.matchMedia = mm;
      window.removeEventListener('nexus:quick-note', opened);
    }
  });

  it('Performance reads "performance:1on1:new" as Set Up a 1:1, not a 1:1 called "new"', async () => {
    const { parsePerfSub } = await import('../performance/lib');
    expect(parsePerfSub('performance:1on1:new')).toMatchObject({ view: 'me', oneOnOne: '', newOneOnOne: true });
    expect(parsePerfSub('performance:1on1:abc')).toMatchObject({ oneOnOne: 'abc', newOneOnOne: false });
  });

  it('Performance reads "performance:kudos:new" as Give Kudos, not a kudos called "new"', async () => {
    const { parsePerfSub } = await import('../performance/lib');
    expect(parsePerfSub('performance:kudos:new')).toMatchObject({ view: 'me', kudos: '', newKudos: true });
    expect(parsePerfSub('performance:kudos:k1')).toMatchObject({ kudos: 'k1', newKudos: false });
  });
});
