import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

// What is waiting on me in the sidebar (Neil, Oct 25 2026: the red dot "doesn't
// show up properly ... it's also weird", then "more subtle"): quiet counts -
// the module's name a step bolder and a small muted number in the row; a dot
// on the folded rail; the count in the row's accessible name; rows reachable
// by keyboard and openable in a new tab.

vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: new Set(), isExternal: false, myRole: 'administrator' }),
  ROLES: {}, EXTERNAL_ROLE_META: { label: 'External' },
}));
vi.mock('../api', () => ({ api: { qaEnabled: () => Promise.resolve({ enabled: false }) } }));
vi.mock('../dashboard/essentials/usePunchClock.jsx', () => ({
  usePunchClock: () => ({ busy: '', note: null, act: vi.fn(), modals: null }),
}));
const COUNTS = { hr: { 'hr-time': 2, 'hr-people': 1 }, support: { kb: 120 } };
vi.mock('../lib/useActionCounts', async (orig) => ({ ...(await orig()), useActionCounts: () => COUNTS }));

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = (q) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
});
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; vi.restoreAllMocks(); });

const { default: Sidebar } = await import('./Sidebar');
const { countDetail, countText } = await import('../lib/useActionCounts');
const mount = (props = {}) => {
  const onNavigate = vi.fn();
  const r = render(<Sidebar activeView="dashboard" activeSub="" onNavigate={onNavigate} isOpen={false} onClose={() => {}} collapsed={false} onToggleCollapse={() => {}} {...props} />);
  return { ...r, onNavigate };
};

describe('Sidebar counts', () => {
  it('puts a quiet number in a busy module row, names it for screen readers, and caps it at 99+', () => {
    const { container } = mount();
    const people = screen.getByRole('link', { name: 'People, 3 waiting on you: 2 in Time, 1 in People' });
    expect(people.className).toContain('has-count');
    expect(within(people).getByText('3').getAttribute('title')).toBe('2 in Time, 1 in People');
    expect(screen.getByRole('link', { name: 'Help Center, 99+ waiting on you: 120 in Knowledge Base' })).toBeTruthy();
    // A quiet module carries nothing.
    expect(screen.getByRole('link', { name: 'Tasks' }).querySelector('.nav-count')).toBeNull();
    // The old corner dot is gone from the expanded rail.
    expect(container.querySelector('.nav-dot')).toBeNull();
  });

  it('shows a dot, not a number, on the folded rail', () => {
    mount({ collapsed: true });
    const people = screen.getByRole('link', { name: 'People, 3 waiting on you: 2 in Time, 1 in People' });
    const dot = people.querySelector('.nav-count.is-corner');
    expect(dot).toBeTruthy();
    expect(dot.textContent).toBe('');
  });

  it('opens a module from the keyboard, and in a new tab on Ctrl or Cmd click', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { onNavigate } = mount();
    const people = screen.getByRole('link', { name: /^People/ });
    expect(people.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(people, { key: 'Enter' });
    expect(onNavigate).toHaveBeenLastCalledWith('hr');
    fireEvent.click(people, { ctrlKey: true });
    expect(open).toHaveBeenCalledWith('/hr', '_blank', 'noopener');
    expect(onNavigate).toHaveBeenCalledTimes(1);
    // The address alias is used: Workday lives at /workday.
    fireEvent.click(screen.getByRole('link', { name: 'Workday' }), { metaKey: true });
    expect(open).toHaveBeenLastCalledWith('/workday', '_blank', 'noopener');
  });

  it('marks the current module for assistive tech', () => {
    mount({ activeView: 'hr' });
    expect(screen.getByRole('link', { name: /^People/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Tasks' }).getAttribute('aria-current')).toBeNull();
  });

  it('describes where a count comes from, and caps the text', () => {
    expect(countDetail(COUNTS, 'hr')).toBe('2 in Time, 1 in People');
    expect(countDetail({ x: { y: 4 } }, 'x')).toBe('');
    expect(countText(7)).toBe('7');
    expect(countText(100)).toBe('99+');
  });
});
