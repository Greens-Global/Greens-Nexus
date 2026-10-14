import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// The sidebar (Oct 14 2026): the N and wordmark go Home, the green chevron
// folds the rail (no edge tab), a collapsed rail peeks open on hover, there
// is no user footer, and the time clock chip sits where the footer was,
// drawn from the engine's published view-model - only while a shift is live.

vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: new Set(), isExternal: false, myRole: 'administrator' }),
  ROLES: {}, EXTERNAL_ROLE_META: { label: 'External' },
}));
vi.mock('../api', () => ({ api: { qaEnabled: () => Promise.resolve({ enabled: false }) } }));

let PHONE = false;
const realMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = (q) => ({
    matches: (PHONE && /max-width:\s*900px/.test(q)) || (!PHONE && /hover:\s*hover/.test(q)), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
});
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; PHONE = false; });

const { default: Sidebar } = await import('./Sidebar');
const { publishTimeclock, timeclockSurfaceClaimed } = await import('../lib/timeclockStore');

const mount = (props = {}) => {
  const onNavigate = vi.fn(), onToggleCollapse = vi.fn();
  const r = render(<Sidebar activeView="dashboard" activeSub="" onNavigate={onNavigate} isOpen={false} onClose={() => {}} collapsed={false} onToggleCollapse={onToggleCollapse} {...props} />);
  return { ...r, onNavigate, onToggleCollapse };
};
const live = () => ({ state: 'in', timer: '2:10', sinceLabel: 'since 7:52 AM', lost: false, busy: false, breakBusy: false, capture: null,
  actions: { toggleBreak: vi.fn(), punchOut: vi.fn(), toggleCapture: vi.fn(), addScreen: vi.fn(), openClock: vi.fn() } });

describe('Sidebar', () => {
  it('the mark goes Home and the chevron folds the rail; no edge tab, no user footer', () => {
    const { onNavigate, onToggleCollapse, container } = mount();
    fireEvent.click(screen.getByRole('link', { name: 'Nexus - go to Dashboard' }));
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.sidebar-collapse-btn')).toBeNull();
    expect(container.querySelector('.sidebar-user')).toBeNull();
    expect(screen.queryByText('Master portal')).toBeNull();
  });

  it('collapsed: the chevron reads Expand and the rail peeks open on hover', () => {
    const { container } = mount({ collapsed: true });
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
    expect(screen.queryByText('Nexus')).toBeNull();                       // rail: icons only
    fireEvent.mouseEnter(container.querySelector('.sidebar'));
    expect(container.querySelector('.sidebar.peek')).toBeTruthy();
    expect(screen.getByText('Nexus')).toBeTruthy();                         // labels while peeking
    fireEvent.mouseLeave(container.querySelector('.sidebar'));
    expect(container.querySelector('.sidebar.peek')).toBeNull();
  });

  it('draws the time clock chip from the engine only while a shift is live, and claims the surface', () => {
    act(() => publishTimeclock({ state: 'out' }));
    const r = mount();
    expect(r.container.querySelector('.sbclock')).toBeNull();
    expect(timeclockSurfaceClaimed()).toBe(false);
    act(() => publishTimeclock(live()));
    expect(screen.getByText('Working')).toBeTruthy();
    expect(screen.getByText('2:10')).toBeTruthy();
    expect(timeclockSurfaceClaimed()).toBe(true);                           // the capsule stands down
    r.unmount();
    expect(timeclockSurfaceClaimed()).toBe(false);
  });

  it('collapsed: the chip is the rail tile', () => {
    act(() => publishTimeclock(live()));
    const { container } = mount({ collapsed: true });
    expect(container.querySelector('.sbclock-tile')).toBeTruthy();
    expect(container.querySelector('.sbclock')).toBeNull();
  });

  it('on a phone the drawer never draws the chip - the capsule keeps it', () => {
    PHONE = true;
    act(() => publishTimeclock(live()));
    const { container } = mount();
    expect(container.querySelector('.sbclock')).toBeNull();
    expect(timeclockSurfaceClaimed()).toBe(false);
  });
});
