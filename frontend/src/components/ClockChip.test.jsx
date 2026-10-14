import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ClockChip from './ClockChip';

// The time clock chip (Oct 14 2026): the sidebar's and the phone sheet's one
// drawing of a live shift. Every capsule function has a control here.

afterEach(cleanup);

const actions = () => ({ toggleBreak: vi.fn(), punchOut: vi.fn(), openClock: vi.fn() });
const working = (extra = {}) => ({ state: 'in', timer: '2:10', sinceLabel: 'since 7:52 AM', lost: false, note: '', busy: false, breakBusy: false, actions: actions(), ...extra });

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
    expect(screen.queryByText(/Capture|Recording/)).toBeNull();            // no monitoring controls on the chip
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

  it('onAfterAction fires after a punch (the phone sheet closes itself)', () => {
    const vm = working();
    const after = vi.fn();
    render(<ClockChip vm={vm} onAfterAction={after} />);
    fireEvent.click(screen.getByRole('button', { name: /Punch Out/ }));
    expect(after).toHaveBeenCalledTimes(1);
  });
});
