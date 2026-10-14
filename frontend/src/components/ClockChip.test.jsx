import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ClockChip from './ClockChip';

// The time clock chip (Oct 14 2026): the sidebar's and the phone sheet's one
// drawing of a live shift. Every capsule function has a control here.

afterEach(cleanup);

const actions = () => ({ toggleBreak: vi.fn(), punchOut: vi.fn(), startCapture: vi.fn(), stopCapture: vi.fn(), openClock: vi.fn() });
const working = (extra = {}) => ({ state: 'in', timer: '2:10', sinceLabel: 'since 7:52 AM', lost: false, note: '', busy: false, breakBusy: false, capture: null, actions: actions(), ...extra });

describe('ClockChip', () => {
  it('draws nothing without a live shift', () => {
    const { container } = render(<ClockChip vm={{ state: 'out' }} />);
    expect(container.innerHTML).toBe('');
    const r2 = render(<ClockChip vm={null} />);
    expect(r2.container.innerHTML).toBe('');
  });

  it('working: state, hours without seconds, Break and Punch Out wired to the engine', () => {
    const vm = working();
    const { container } = render(<ClockChip vm={vm} />);
    expect(screen.getByText('Working')).toBeTruthy();
    expect(screen.getByText('2:10')).toBeTruthy();
    expect(screen.getByText('since 7:52 AM')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Break/ }));
    expect(vm.actions.toggleBreak).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Punch Out/ }));
    expect(vm.actions.punchOut).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('.sbclock-head'));                // the whole state row opens the Time Clock
    expect(vm.actions.openClock).toHaveBeenCalledTimes(1);
  });

  it('on break: amber state with End Break as the primary', () => {
    const vm = working({ state: 'break', timer: '0:14' });
    const { container } = render(<ClockChip vm={vm} />);
    expect(container.querySelector('.sbclock--break')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /End Break/ }));
    expect(vm.actions.toggleBreak).toHaveBeenCalledTimes(1);
  });

  it('shows the engine\'s note (a declined screen share) in place of the since line', () => {
    render(<ClockChip vm={working({ note: 'Share your screen to end your break - choose a screen when your browser asks, then tap again.' })} />);
    expect(screen.getByRole('status').textContent).toMatch(/Share your screen/);
    expect(screen.queryByText('since 7:52 AM')).toBeNull();
  });

  it('a parked punch: the warning line and Retry, and the rail tile says so too', () => {
    const r = render(<ClockChip vm={working({ lost: true })} />);
    expect(screen.getByText(/A punch has not recorded/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
    r.unmount();
    const { container } = render(<ClockChip vm={working({ lost: true })} variant="rail" />);
    expect(container.querySelector('.sbclock-tile--lost')).toBeTruthy();
    expect(screen.getByRole('button', { name: /a punch has not recorded/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry Punch Out' })).toBeTruthy();
  });

  it('folded rail: state tile opens the clock, Break and Punch Out work without expanding', () => {
    const vm = working();
    render(<ClockChip vm={vm} variant="rail" />);
    fireEvent.click(screen.getByRole('button', { name: /Working · 2:10/ }));
    expect(vm.actions.openClock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Break' }));
    expect(vm.actions.toggleBreak).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Punch Out' }));
    expect(vm.actions.punchOut).toHaveBeenCalledTimes(1);
    const r2 = render(<ClockChip vm={working({ state: 'break', timer: '0:14' })} variant="rail" />);
    expect(screen.getByRole('button', { name: 'End Break' })).toBeTruthy();
    r2.unmount();
  });

  it('onAfterAction fires once the punch resolved, and not when the engine blocked it', async () => {
    const vm = working();
    vm.actions.punchOut = vi.fn(async () => true);
    const after = vi.fn();
    render(<ClockChip vm={vm} onAfterAction={after} />);
    fireEvent.click(screen.getByRole('button', { name: /Punch Out/ }));
    await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(1));
    cleanup();
    const vm2 = working();
    vm2.actions.toggleBreak = vi.fn(async () => false);                    // a declined screen share
    const after2 = vi.fn();
    render(<ClockChip vm={vm2} onAfterAction={after2} />);
    fireEvent.click(screen.getByRole('button', { name: /^Break$/ }));
    await new Promise((res) => setTimeout(res, 0));
    expect(after2).not.toHaveBeenCalled();
  });

  it('monitoring icons: share / stop, another screen, paused; the rail tile carries a note', () => {
    const vm = working({ capture: { screens: 0, paused: false, needed: true } });
    const r = render(<ClockChip vm={vm} />);
    fireEvent.click(screen.getByRole('button', { name: /Screen sharing stopped/ }));
    expect(vm.actions.startCapture).toHaveBeenCalledTimes(1);
    r.unmount();
    const vm1 = working({ capture: { screens: 2, paused: false, needed: false } });
    const r1 = render(<ClockChip vm={vm1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture another screen' }));
    expect(vm1.actions.startCapture).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Recording - stop capture/ }));
    expect(vm1.actions.stopCapture).toHaveBeenCalledTimes(1);
    r1.unmount();
    const r3 = render(<ClockChip vm={working({ state: 'break', timer: '0:03', capture: { screens: 1, paused: true, needed: false } })} />);
    expect(screen.getByRole('button', { name: /Capture paused/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Screen sharing stopped/ })).toBeNull();
    r3.unmount();
    render(<ClockChip vm={working()} />);
    expect(screen.queryByRole('group', { name: 'Screen capture' })).toBeNull();   // the browser is not the capturer
    const vm2 = working({ note: 'Share your screen to end your break - choose a screen when your browser asks, then tap again.' });
    const { container } = render(<ClockChip vm={vm2} variant="rail" />);
    expect(container.querySelector('.sbclock-tile--lost')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/Share your screen/);
  });
});
