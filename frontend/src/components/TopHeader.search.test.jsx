import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import fs from 'fs';
import path from 'path';

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
const searchTaskModule = vi.fn(() => Promise.resolve({
  tasks: [{ id: 't1', title: 'Fix the gate', completed: false, projectName: 'Austin' }],
  projects: [], people: [{ name: 'Charmi Patel', email: 'charmi@x.com' }], portfolios: [], teams: [],
  totals: { tasks: 3 },
}));
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => (k === 'searchTaskModule' ? searchTaskModule : k === 'qaEnabled' ? () => Promise.resolve({ enabled: false }) : () => Promise.resolve({})) }),
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

  it('Ctrl+K and "/" focus the bar on a desktop and take the key; "/" goes to a page that owns it; a phone leaves both to the sheet', () => {
    header();
    const k = fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(k).toBe(false);                                                   // defaultPrevented: the sheet stands down
    expect(document.activeElement).toBe(bar());
    bar().blur();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(bar());
    bar().blur();
    const own = document.createElement('input'); own.setAttribute('data-slash-search', ''); document.body.appendChild(own);
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(own);                                // the Contact Directory / Knowledge Base box
    own.remove();
    fireEvent.keyDown(bar(), { key: '/' });                                  // typing "/" in a field is a character
    cleanup();
    PHONE = true;
    header();
    const notTaken = fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(notTaken).toBe(true);
    expect(document.activeElement).not.toBe(bar());
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
      // Enter: the first row is the first content hit, not the module whose
      // name contains the letters; Pages come last.
      fireEvent.change(bar(), { target: { value: 'ta' } });
      await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve(); });
      const sections = [...document.querySelectorAll('.gs-section')].map(el => el.textContent);
      expect(sections[0]).toBe('Tasks');
      expect(sections[sections.length - 1]).toBe('Pages');
      fireEvent.keyDown(bar(), { key: 'ArrowDown' });                        // "See all 3 tasks" is a row the keyboard reaches
      expect(document.querySelector('[data-active="true"]').textContent).toContain('See all 3 tasks');
      fireEvent.keyDown(bar(), { key: 'ArrowUp' });
      fireEvent.keyDown(bar(), { key: 'Enter' });
      expect(nav.mock.calls.at(-1)[0].detail).toEqual({ view: 'tasks', sub: 'mine' });
      // ArrowDown with nothing to show yet never strands the highlight.
      fireEvent.change(bar(), { target: { value: 'zz' } });
      fireEvent.keyDown(bar(), { key: 'ArrowDown' });
      await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve(); });
      expect(document.querySelector('[data-active="true"]')).toBeTruthy();
      window.removeEventListener('nexus:navigate', nav);
    } finally { vi.useRealTimers(); }
  });

  it('a person opens their page in Tasks - their tasks - not the contact card (Neil, Oct 18)', async () => {
    vi.useFakeTimers();
    const nav = vi.fn(), person = vi.fn(), contact = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    window.addEventListener('nexus:tasks-person', person);
    window.addEventListener('nexus:contact', contact);
    try {
      header();
      fireEvent.focus(bar());
      fireEvent.change(bar(), { target: { value: 'charmi' } });
      await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve(); });
      fireEvent.click(screen.getByText('Charmi Patel'));
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(nav.mock.calls.at(-1)[0].detail).toEqual({ view: 'tasks', sub: 'home' });
      expect(person).toHaveBeenCalledTimes(1);
      expect(person.mock.calls[0][0].detail).toEqual({ email: 'charmi@x.com', name: 'Charmi Patel', fromOutside: true });
      expect(contact).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('nexus:navigate', nav);
      window.removeEventListener('nexus:tasks-person', person);
      window.removeEventListener('nexus:contact', contact);
      vi.useRealTimers();
    }
  });

  // Oct 23: Accounting's five dropdown tabs fit the center at 1366 and 1440
  // wide with the sidebar open. Only compactGroups opts in; jsdom applies no
  // CSS, so the rules are pinned and kept behind the opt-in class.
  it('tightens only a compactGroups strip, keeping the label font size', () => {
    const items = [{ key: 'x', label: 'X' }];
    render(
      <HeaderTabsProvider>
        <ModuleTabs tabs={[{ key: 'd', label: 'Dashboard', items }, { key: 'r', label: 'Reports', items: [{ key: 'y', label: 'Y' }] }]} active="x" onChange={() => {}} compactGroups />
        <TopHeader title="Accounting" activeView="accounting" theme="light" onThemeToggle={() => {}} onNavigate={() => {}} />
      </HeaderTabsProvider>,
    );
    const nav = document.querySelector('.header-center .hdr-tabs');
    expect(nav.classList.contains('hdr-tabs--compact')).toBe(true);
    expect(nav.querySelectorAll('.hdr-tab .tab-group-caret')).toHaveLength(2);
    cleanup();
    header({}, true);
    expect(document.querySelector('.header-center .hdr-tabs').classList.contains('hdr-tabs--compact')).toBe(false);
    const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
    const rules = css.split('\n').filter((l) => l.includes('hdr-tabs--compact'));
    expect(rules.length).toBeGreaterThan(0);
    rules.forEach((l) => expect(l).not.toMatch(/font/));
    expect(css).toMatch(/\.hdr-tabs--compact \.hdr-tab \{ padding: 9px 9px; gap: 4px; \}/);
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
