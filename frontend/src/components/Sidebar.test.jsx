import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// The sidebar (Oct 14 2026): the N and wordmark go Home, the edge tab folds
// the rail (a header chevron and a hover peek were tried and sent back),
// there is no user footer, and the time clock chip sits where the footer
// was, drawn from the engine's published view-model - only while a shift is
// live.

vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: new Set(), isExternal: false, myRole: 'administrator' }),
  ROLES: {}, EXTERNAL_ROLE_META: { label: 'External' },
}));
vi.mock('../api', () => ({ api: { qaEnabled: () => Promise.resolve({ enabled: false }) } }));
// Off the clock the sidebar draws Punch In from the Punch tile's hook.
const punch = vi.hoisted(() => ({ act: vi.fn(async () => {}) }));
vi.mock('../dashboard/essentials/usePunchClock.jsx', () => ({
  usePunchClock: () => ({ busy: '', note: null, act: punch.act, modals: null }),
}));

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
const live = () => ({ state: 'in', timer: '2:10', todayMin: 130, sinceLabel: 'since 7:52 AM', lost: false, note: '', busy: false, breakBusy: false, capture: null,
  actions: { toggleBreak: vi.fn(), punchOut: vi.fn(), startCapture: vi.fn(), stopCapture: vi.fn(), openClock: vi.fn() } });

describe('Sidebar', () => {
  it('the mark goes Home, the edge tab folds the rail; no header chevron, no user footer', () => {
    const { onNavigate, onToggleCollapse, container } = mount();
    fireEvent.click(screen.getByRole('link', { name: 'Nexus - go to Dashboard' }));
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
    const tab = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(tab.className).toBe('sidebar-collapse-btn');
    fireEvent.click(tab);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.sidebar-fold')).toBeNull();
    expect(container.querySelector('.sidebar-user')).toBeNull();
    expect(screen.queryByText('Master portal')).toBeNull();
  });

  it('collapsed: the edge tab reads Expand and the rail is icons only', () => {
    const { container } = mount({ collapsed: true });
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
    expect(screen.queryByText('Nexus')).toBeNull();
    fireEvent.mouseEnter(container.querySelector('.sidebar'));
    expect(container.querySelector('.sidebar.peek')).toBeNull();          // no hover peek (sent back, Oct 14)
  });

  it('off the clock: the chip offers Punch In from the Punch tile hook; live: the engine draws it and claims the surface', () => {
    act(() => publishTimeclock({ state: 'out', sinceLabel: 'Last clocked out at 4:30 PM' }));
    const r = mount();
    expect(screen.getByText('Clocked Out', { selector: '.sbclock-state' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Punch In' }));
    expect(punch.act).toHaveBeenCalledWith('in');
    expect(timeclockSurfaceClaimed()).toBe(false);
    act(() => publishTimeclock(live()));
    expect(screen.getByText('Clocked In', { selector: '.sbclock-state' })).toBeTruthy();
    expect(screen.getByText('2:10')).toBeTruthy();
    expect(timeclockSurfaceClaimed()).toBe(true);                           // the capsule stands down
    r.unmount();
    expect(timeclockSurfaceClaimed()).toBe(false);
  });

  it('collapsed: the chip is a column of icons with Break and Punch Out', () => {
    act(() => publishTimeclock(live()));
    const { container } = mount({ collapsed: true });
    expect(container.querySelector('.sbclock-rail .sbring')).toBeTruthy();
    expect(container.querySelector('.sbclock')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start Break' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Punch Out' })).toBeTruthy();
  });

  it('nothing for an exempt person', () => {
    act(() => publishTimeclock({ state: 'exempt' }));
    const { container } = mount();
    expect(container.querySelector('.sidebar-foot')).toBeNull();
  });

  it('on a phone the drawer never draws the chip - the capsule keeps it', () => {
    PHONE = true;
    act(() => publishTimeclock(live()));
    const { container } = mount();
    expect(container.querySelector('.sidebar-foot')).toBeNull();
    expect(timeclockSurfaceClaimed()).toBe(false);
  });
});
