import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ClockChip from './ClockChip';

// The time clock chip (Oct 14 2026): the sidebar's and the phone sheet's one
// drawing of a live shift. Every capsule function has a control here.

afterEach(cleanup);

const actions = () => ({ toggleBreak: vi.fn(), punchOut: vi.fn(), toggleCapture: vi.fn(), addScreen: vi.fn(), openClock: vi.fn() });
const working = (extra = {}) => ({ state: 'in', timer: '2:10', sinceLabel: 'since 7:52 AM', lost: false, busy: false, breakBusy: false, capture: null, actions: actions(), ...extra });

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
    expect(screen.queryByText(/Capture/)).toBeNull();                      // the browser is not the capturer
  });

  it('on break: amber state with End Break as the primary', () => {
    const vm = working({ state: 'break', timer: '0:14' });
    const { container } = render(<ClockChip vm={vm} />);
    expect(container.querySelector('.sbclock--break')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /End Break/ }));
    expect(vm.actions.toggleBreak).toHaveBeenCalledTimes(1);
  });

  it('capture: off, recording with another-screen, paused for break', () => {
    const vm = working({ capture: { screens: 0, paused: false, intervalMin: 5, randomize: false } });
    const r = render(<ClockChip vm={vm} />);
    fireEvent.click(screen.getByRole('button', { name: /Capture off/ }));
    expect(vm.actions.toggleCapture).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Capture another screen' })).toBeNull();
    r.unmount();
    const vm2 = working({ capture: { screens: 2, paused: false, intervalMin: 5, randomize: true } });
    const r2 = render(<ClockChip vm={vm2} />);
    expect(screen.getByRole('button', { name: /Recording · 2 screens/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Capture another screen' }));
    expect(vm2.actions.addScreen).toHaveBeenCalledTimes(1);
    r2.unmount();
    render(<ClockChip vm={working({ state: 'break', timer: '0:03', capture: { screens: 1, paused: true, intervalMin: 5, randomize: false } })} />);
    expect(screen.getByRole('button', { name: /Paused for break/ })).toBeTruthy();
  });

  it('a parked punch: the warning line and Retry', () => {
    render(<ClockChip vm={working({ lost: true })} />);
    expect(screen.getByText(/A punch has not recorded/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
  });

  it('the rail tile names the state in its label and opens the clock', () => {
    const vm = working({ capture: { screens: 1, paused: false, intervalMin: 5, randomize: false } });
    render(<ClockChip vm={vm} variant="tile" />);
    const tile = screen.getByRole('button', { name: /Working · 2:10 · recording/ });
    fireEvent.click(tile);
    expect(vm.actions.openClock).toHaveBeenCalledTimes(1);
  });

  it('onAfterAction fires after a punch (the phone sheet closes itself)', () => {
    const vm = working();
    const after = vi.fn();
    render(<ClockChip vm={vm} onAfterAction={after} />);
    fireEvent.click(screen.getByRole('button', { name: /Punch Out/ }));
    expect(after).toHaveBeenCalledTimes(1);
  });
});
