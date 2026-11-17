import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

// The sidebar's off-the-clock chip (11/17/2026): its busy flag and its error
// note were refs only a child wrote, so nothing redrew the chip - Play showed
// no spinner during the location wait (up to 9 s) and a failed punch showed
// no note. Both are state now: the chip redraws when either changes.

const hook = vi.hoisted(() => ({ value: { busy: '', note: null, act: () => Promise.resolve(), modals: null }, bump: null }));
vi.mock('../dashboard/essentials/usePunchClock.jsx', async () => {
  const { useState } = await import('react');
  return {
    // The real hook holds busy / note in its own state: a change re-renders
    // the component that called it (OffClock) and nothing above it.
    usePunchClock: () => { const [, set] = useState(0); hook.bump = () => set((n) => n + 1); return hook.value; },
  };
});
vi.mock('../lib/timeclockStore', () => ({
  useTimeclock: () => ({ state: 'out', sinceLabel: 'since 4:30 PM', track: null }),
  claimTimeclockSurface: () => () => {},
  openTimeClock: vi.fn(),
}));

const { default: SidebarClock } = await import('./SidebarClock');

beforeEach(() => { hook.value = { busy: '', note: null, act: vi.fn(async () => {}), modals: null }; });
afterEach(cleanup);

const setHook = (next) => act(() => { hook.value = { ...hook.value, ...next }; hook.bump(); });

describe('SidebarClock - off the clock', () => {
  it('shows the spinner and locks Play while the punch is on its way, then frees it', () => {
    const { container } = render(<SidebarClock />);
    const play = () => screen.getByRole('button', { name: 'Punch In' });
    expect(play().disabled).toBe(false);
    expect(container.querySelector('.sbtr-btn--play svg')).toBeTruthy();
    const idle = container.querySelector('.sbtr-btn--play').innerHTML;
    setHook({ busy: 'in' });
    expect(play().disabled).toBe(true);
    expect(container.querySelector('.sbtr-btn--play').innerHTML).not.toBe(idle);   // the spinner, not the Play glyph
    setHook({ busy: '' });
    expect(play().disabled).toBe(false);
    expect(container.querySelector('.sbtr-btn--play').innerHTML).toBe(idle);
  });

  it('shows why a punch failed as soon as the hook says so, and clears it with the hook', () => {
    render(<SidebarClock />);
    expect(screen.queryByText('Share a screen to clock in.')).toBeNull();
    setHook({ note: { ok: false, text: 'Share a screen to clock in.' } });
    expect(screen.getByText('Share a screen to clock in.')).toBeTruthy();
    // A success is not an alert on the chip.
    setHook({ note: { ok: true, text: 'Punched in at 9:00 AM.' } });
    expect(screen.queryByText('Share a screen to clock in.')).toBeNull();
    expect(screen.queryByText('Punched in at 9:00 AM.')).toBeNull();
  });
});
