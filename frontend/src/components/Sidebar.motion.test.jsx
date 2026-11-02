import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// The rail's motion (Neil, 11/01/2026): two pills behind the rows - one
// glides to the hovered row, the active tint travels on a module change -
// the newly active icon pops once, labels cascade in when the rail unfolds,
// the edge tab's chevron turns, and all of it is gone when the strength is
// Off or the sidebar is the phone drawer.

vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: new Set(), isExternal: false, myRole: 'administrator' }),
  ROLES: {}, EXTERNAL_ROLE_META: { label: 'External' },
}));
const mockApi = vi.hoisted(() => ({
  qaEnabled: vi.fn(() => Promise.resolve({ enabled: false })),
  getBrandingConfig: vi.fn(() => Promise.resolve({ accent: 'green', navMotion: 'lively' })),
  getTaskTablePrefs: vi.fn(() => Promise.resolve({ prefs: {} })),
  saveTaskTablePrefs: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../api', () => ({ api: mockApi }));
vi.mock('../dashboard/essentials/usePunchClock.jsx', () => ({
  usePunchClock: () => ({ busy: '', note: null, act: vi.fn(async () => {}), modals: null }),
}));

let PHONE = false;
const realMatchMedia = window.matchMedia;
// jsdom lays nothing out: rows report their place in the list, 36px apart.
const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
beforeEach(() => {
  window.matchMedia = (q) => ({
    matches: (PHONE && /max-width:\s*900px/.test(q)) || (!PHONE && /hover:\s*hover/.test(q)), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() {
    const rows = Array.from(this.parentElement?.querySelectorAll(':scope > li:not(.nav-pill)') || []);
    return Math.max(0, rows.indexOf(this)) * 36;
  } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 36; } });
});
afterEach(() => {
  cleanup(); window.matchMedia = realMatchMedia; PHONE = false;
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTop);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
  delete document.documentElement.dataset.railMotion;
});

const { default: Sidebar } = await import('./Sidebar');
const { __setTablePrefsCache } = await import('../tasks/tableCols');
const { __resetRailMotion } = await import('../lib/railMotion');

const mount = (props = {}) => {
  const r = render(<Sidebar activeView="dashboard" activeSub="" onNavigate={() => {}} isOpen={false} onClose={() => {}} collapsed={false} onToggleCollapse={() => {}} {...props} />);
  const rerender = (next) => r.rerender(<Sidebar activeView="dashboard" activeSub="" onNavigate={() => {}} isOpen={false} onClose={() => {}} collapsed={false} onToggleCollapse={() => {}} {...props} {...next} />);
  return { ...r, rerender };
};
const row = (name) => screen.getByRole('link', { name });
const aside = () => document.querySelector('.sidebar');
const pill = (kind) => document.querySelector(`.nav-pill--${kind}`);
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('Sidebar motion', () => {
  beforeEach(() => { __resetRailMotion(); __setTablePrefsCache({}); vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('marks the rail with the strength and draws the two pills, the active one under the active module', async () => {
    mount();
    await flush();
    expect(aside().dataset.motion).toBe('lively');
    expect(document.documentElement.dataset.railMotion).toBe('lively');
    const active = pill('active');
    expect(active).toBeTruthy();
    expect(active.style.transform).toBe(`translateY(${row('Dashboard').offsetTop}px)`);
    expect(active.style.opacity).toBe('1');
    expect(pill('hover').classList.contains('is-on')).toBe(false);
  });

  it('the hover pill glides to the row under the pointer, stands down on the active row, and fades when the pointer leaves the list', async () => {
    mount();
    await flush();
    const tasks = row('Tasks');
    fireEvent.pointerEnter(tasks, { pointerType: 'mouse' });
    expect(pill('hover').classList.contains('is-on')).toBe(true);
    expect(pill('hover').style.transform).toBe(`translateY(${tasks.offsetTop}px)`);
    fireEvent.pointerEnter(row('Dashboard'), { pointerType: 'mouse' });
    expect(pill('hover').classList.contains('is-on')).toBe(false);
    fireEvent.pointerEnter(tasks, { pointerType: 'mouse' });
    fireEvent.pointerLeave(document.querySelector('.nav-list'));
    expect(pill('hover').classList.contains('is-on')).toBe(false);
    // A finger has no hover: a touch never lights the pill. (jsdom drops
    // pointerType from PointerEvent init, so it is pinned on the event itself.)
    const touch = new Event('pointerover', { bubbles: true });
    Object.defineProperty(touch, 'pointerType', { value: 'touch' });
    fireEvent(row('Tickets'), touch);
    expect(pill('hover').classList.contains('is-on')).toBe(false);
  });

  it('the active tint travels to the newly active module and its icon pops once', async () => {
    const { rerender } = mount();
    await flush();
    rerender({ activeView: 'tickets' });
    const tickets = row('Tickets');
    expect(pill('active').style.transform).toBe(`translateY(${tickets.offsetTop}px)`);
    expect(tickets.querySelector('.nav-ico').classList.contains('is-pop')).toBe(true);
    expect(row('Dashboard').querySelector('.nav-ico').classList.contains('is-pop')).toBe(false);
    act(() => { vi.advanceTimersByTime(400); });
    expect(tickets.querySelector('.nav-ico').classList.contains('is-pop')).toBe(false);
  });

  it('unfolding cascades the labels (is-opening for a beat, --i top to bottom); folding does not', async () => {
    const { rerender } = mount({ collapsed: true });
    await flush();
    expect(aside().classList.contains('is-opening')).toBe(false);
    rerender({ collapsed: false });
    expect(aside().classList.contains('is-opening')).toBe(true);
    const labels = Array.from(document.querySelectorAll('.nav-kicker, .nav-label')).map((el) => Number(el.style.getPropertyValue('--i')));
    expect(labels[0]).toBe(1);
    expect(labels.every((v, i) => i === 0 || v > labels[i - 1])).toBe(true);
    expect(document.querySelector('.company-name').style.getPropertyValue('--i')).toBe('0');
    act(() => { vi.advanceTimersByTime(750); });
    expect(aside().classList.contains('is-opening')).toBe(false);
    rerender({ collapsed: true });
    expect(aside().classList.contains('is-opening')).toBe(false);
  });

  it('the edge tab is one chevron the stylesheet turns; the folded rail still does not peek on hover', async () => {
    const { container, rerender } = mount();
    await flush();
    const tab = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(tab.className).toBe('sidebar-collapse-btn');
    expect(tab.querySelectorAll('svg').length).toBe(1);
    rerender({ collapsed: true });
    expect(screen.getByRole('button', { name: 'Expand sidebar' }).querySelectorAll('svg').length).toBe(1);
    fireEvent.mouseEnter(container.querySelector('.sidebar'));
    expect(container.querySelector('.sidebar.peek')).toBeNull();
  });

  it("Off is today's sidebar: no pills, no data-motion, no pop", async () => {
    __setTablePrefsCache({ nav: { motion: 'off' } });
    const { rerender } = mount();
    await flush();
    expect(aside().dataset.motion).toBeUndefined();
    expect(pill('active')).toBeNull();
    rerender({ activeView: 'tickets' });
    expect(document.querySelector('.nav-ico.is-pop')).toBeNull();
  });

  it('the phone drawer never gets the motion, whatever the setting', async () => {
    PHONE = true;
    mount();
    await flush();
    expect(aside().dataset.motion).toBeUndefined();
    expect(pill('hover')).toBeNull();
  });
});
