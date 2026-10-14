import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// The header search (Neil, Oct 14 2026): ONE bar, the same size in the same
// place on every module - with module tabs in the center or without - with
// one placeholder and one professional tooltip. Ctrl/Cmd+K and "/" land in
// it; Pages come from the sidebar's screens and content from the Task
// module's search; a pick navigates through the app's one navigate event.

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Pat Lee', username: 'pat@greensglobal.com' }] }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
vi.mock('./NotificationBell', () => ({ default: () => null }));
vi.mock('../support/HelpMenu', () => ({ default: () => <button aria-label="Help">?</button> }));
vi.mock('./MyProfileModal', () => ({ default: () => null }));
vi.mock('./EmailSettingsModal', () => ({ default: () => null }));
const searchTaskModule = vi.fn(() => Promise.resolve({
  tasks: [{ id: 't1', title: 'Fix the gate', completed: false, projectName: 'Austin' }],
  projects: [], people: [{ name: 'Charmi Patel', email: 'charmi@x.com' }], portfolios: [], teams: [],
  totals: { tasks: 3 },
}));
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => (k === 'searchTaskModule' ? searchTaskModule : () => Promise.resolve({})) }),
}));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ myRole: 'administrator', isExternal: false, can: () => true, myGrantedModules: new Map(),
    actingAs: null, stopActAs: vi.fn(), myEmail: 'pat@greensglobal.com' }),
}));
vi.mock('../contexts/InventoryContext', () => ({ useInventory: () => ({ items: [{ id: 'i1', name: 'Hilti Drill', itemType: 'Tool', status: 'available', ownershipType: 'transient' }], checkouts: [] }) }));
vi.mock('../contexts/RequisitionContext', () => ({ useRequisitions: () => ({ requisitions: [] }) }));

const { default: TopHeader } = await import('./TopHeader');
const { HeaderTabsProvider, default: ModuleTabs } = await import('./ModuleTabs');

let PHONE = false;
const realMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = (q) => ({ matches: PHONE && /max-width:\s*900px/.test(q), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
});
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; PHONE = false; searchTaskModule.mockClear(); });

const header = (props = {}, tabs = false) => render(
  <HeaderTabsProvider>
    {tabs && <ModuleTabs tabs={[{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }]} active="a" onChange={() => {}} />}
    <TopHeader title="Tasks" activeView="tasks" theme="light" onThemeToggle={() => {}} onNavigate={() => {}} {...props} />
  </HeaderTabsProvider>,
);
const bar = () => screen.getByRole('textbox', { name: 'Search Nexus' });
const inRight = (el) => !!el.closest('.header-right');

describe('TopHeader search', () => {
  it('is the same bar in the same place with and without module tabs', () => {
    header();
    const plain = bar();
    expect(plain.placeholder).toBe('Search Nexus');
    expect(plain.title).toMatch(/^Search Nexus \((⌘|Ctrl) K\)$/);
    expect(inRight(plain)).toBe(true);
    expect(document.querySelector('.header-center .search-bar')).toBeNull();
    cleanup();
    header({}, true);
    const withTabs = bar();
    expect(withTabs.placeholder).toBe('Search Nexus');
    expect(inRight(withTabs)).toBe(true);
    expect(document.querySelector('.header-center .hdr-tabs')?.textContent).toContain('Alpha');   // tabs still in the center
    expect(document.querySelector('.hdr-search-pop')).toBeNull();           // no icon-and-popover any more
    expect(document.querySelector('.header-right button[aria-label="Search Nexus"]')).toBeNull();   // no icon trigger on the right
  });

  it('Ctrl+K and "/" focus the bar on a desktop; on a phone they open the sheet', () => {
    header();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(bar());
    bar().blur();
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(bar());
    cleanup();
    PHONE = true;
    const opened = vi.fn();
    window.addEventListener('nexus:search-open', opened);
    header();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener('nexus:search-open', opened);
  });

  it('finds pages, items and Task-module content in one grouped list, and a pick navigates', async () => {
    vi.useFakeTimers();
    try {
      const nav = vi.fn();
      window.addEventListener('nexus:navigate', nav);
      header();
      fireEvent.focus(bar());
      expect(screen.getByText('Pages, tasks, projects, people, items and requests.')).toBeTruthy();
      fireEvent.change(bar(), { target: { value: 'hilti' } });
      expect(screen.getByText('Items', { selector: '.gs-section' })).toBeTruthy();
      expect(screen.getByText('Hilti Drill')).toBeTruthy();
      fireEvent.change(bar(), { target: { value: 'ga' } });
      await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve(); });
      expect(searchTaskModule).toHaveBeenCalledWith('ga');
      expect(screen.getByText('Tasks', { selector: '.gs-section' })).toBeTruthy();
      expect(screen.getByText('Fix the gate')).toBeTruthy();
      expect(screen.getByText('See all 3 tasks')).toBeTruthy();
      expect(screen.getByText('Charmi Patel')).toBeTruthy();
      fireEvent.click(screen.getByText('Fix the gate'));
      expect(nav).toHaveBeenCalled();
      expect(nav.mock.calls[0][0].detail).toEqual({ view: 'tasks', sub: 'mine' });
      expect(bar().value).toBe('');                                          // a pick clears and closes
      window.removeEventListener('nexus:navigate', nav);
    } finally { vi.useRealTimers(); }
  });

  it('Esc clears and closes; the clear button reads Clear', () => {
    header();
    fireEvent.change(bar(), { target: { value: 'tasks' } });
    expect(screen.getByRole('button', { name: 'Clear search' }).title).toBe('Clear');
    fireEvent.keyDown(bar(), { key: 'Escape' });
    expect(bar().value).toBe('');
    expect(document.querySelector('.hdr-search-panel')).toBeNull();
  });
});
