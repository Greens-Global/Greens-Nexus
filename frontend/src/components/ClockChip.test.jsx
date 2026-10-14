import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import ClockChip from './ClockChip';

// The time clock chip (Oct 14 2026): a dial and a transport - Play, Pause,
// Stop, always all three - used by the sidebar and the phone sheet. Every
// capsule function has a control here; off the clock, Play is Punch In.

afterEach(cleanup);

const actions = () => ({ punchIn: vi.fn(), toggleBreak: vi.fn(), punchOut: vi.fn(), startCapture: vi.fn(), stopCapture: vi.fn(), openClock: vi.fn() });
const working = (extra = {}) => ({ state: 'in', timer: '2:10', todayMin: 130, sinceLabel: 'since 7:52 AM', lost: false, note: '', busy: false, breakBusy: false, capture: null, actions: actions(), ...extra });
const btn = (name) => screen.getByRole('button', { name });

describe('ClockChip', () => {
  it('draws nothing without a known state', () => {
    expect(render(<ClockChip vm={{ state: 'unknown' }} />).container.innerHTML).toBe('');
    expect(render(<ClockChip vm={null} />).container.innerHTML).toBe('');
  });

  it('clocked in: Play is lit and inert, Pause starts a break, Stop punches out; the dial is green', () => {
    const vm = working();
    const { container } = render(<ClockChip vm={vm} />);
    expect(screen.getByText('Clocked In', { selector: '.sbclock-state' })).toBeTruthy();
    expect(screen.getByText('2:10')).toBeTruthy();
    expect(container.querySelector('.sbring--in .sbring-arc')).toBeTruthy();
    expect(container.querySelector('.sbring-ticks line')).toBeTruthy();
    expect(btn('Clocked In').getAttribute('aria-pressed')).toBe('true');
    expect(btn('Clocked In').getAttribute('aria-disabled')).toBe('true');   // inert, but still hoverable for its tooltip
    fireEvent.click(btn('Start Break'));
    expect(vm.actions.toggleBreak).toHaveBeenCalledTimes(1);
    fireEvent.click(btn('Punch Out'));
    expect(vm.actions.punchOut).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('.sbclock-head'));
    expect(vm.actions.openClock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.sbtr-lit').style.getPropertyValue('--sb-lit')).toBe('0');
  });

  it('on break: Pause is lit, Play resumes and the outline has slid to Pause; amber dial', () => {
    const vm = working({ state: 'break', timer: '0:14' });
    const { container } = render(<ClockChip vm={vm} />);
    expect(container.querySelector('.sbclock--break .sbring--break')).toBeTruthy();
    expect(btn('On Break').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.sbtr-lit').style.getPropertyValue('--sb-lit')).toBe('1');
    fireEvent.click(btn('Resume'));
    expect(vm.actions.toggleBreak).toHaveBeenCalledTimes(1);
  });

  it('off the clock: a red dial, Play is Punch In, Pause and Stop are dim', () => {
    const vm = { state: 'out', sinceLabel: 'Last clocked out at 4:30 PM', busy: false, actions: { punchIn: vi.fn(), openClock: vi.fn() } };
    const { container } = render(<ClockChip vm={vm} />);
    expect(screen.getByText('Clocked Out', { selector: '.sbclock-state' })).toBeTruthy();
    expect(container.querySelector('.sbring--out')).toBeTruthy();
    fireEvent.click(btn('Punch In'));
    expect(vm.actions.punchIn).toHaveBeenCalledTimes(1);
    expect(btn('Start Break').getAttribute('aria-disabled')).toBe('true');
    expect(btn('Punch Out').getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByText('2:10')).toBeNull();
  });

  it('a break starting lifts the coffee cup; a resume sweeps the dial', () => {
    const { container, rerender } = render(<ClockChip vm={working()} />);
    expect(container.querySelector('.sbtr-coffee')).toBeNull();
    rerender(<ClockChip vm={working({ state: 'break', timer: '0:00' })} />);
    expect(container.querySelector('.sbtr-coffee')).toBeTruthy();
    rerender(<ClockChip vm={working()} />);
    expect(container.querySelector('.sbring-sweep')).toBeTruthy();
  });

  it('tooltips name the action and what it does', () => {
    render(<ClockChip vm={working()} />);
    const tips = screen.getAllByRole('tooltip').map((t) => t.textContent);
    expect(tips).toEqual(['Clocked InYou are on the clock', 'Start BreakYour working time pauses', 'Punch OutEnds your shift']);
  });

  it('shows the engine\'s note (a declined screen share) as its own line under the head', () => {
    render(<ClockChip vm={working({ note: 'Share your screen to end your break - choose a screen when your browser asks, then tap again.' })} />);
    expect(screen.getByRole('status').textContent).toMatch(/Share your screen/);
    expect(screen.getByText('since 7:52 AM')).toBeTruthy();
  });

  it('a parked punch: the warning line and Retry; the rail dial carries the alert', () => {
    const r = render(<ClockChip vm={working({ lost: true })} />);
    expect(screen.getByText(/A punch has not recorded/)).toBeTruthy();
    expect(btn('Retry Punch Out')).toBeTruthy();
    r.unmount();
    const { container } = render(<ClockChip vm={working({ lost: true })} variant="rail" />);
    expect(container.querySelector('.sbring-alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: /A punch has not recorded/ })).toBeTruthy();
  });

  it('folded rail: the dial opens the clock and the transport works without expanding', () => {
    const vm = working();
    const { container } = render(<ClockChip vm={vm} variant="rail" />);
    fireEvent.click(screen.getByRole('button', { name: /Clocked In · 2:10/ }));
    expect(vm.actions.openClock).toHaveBeenCalledTimes(1);
    fireEvent.click(btn('Start Break'));
    expect(vm.actions.toggleBreak).toHaveBeenCalledTimes(1);
    fireEvent.click(btn('Punch Out'));
    expect(vm.actions.punchOut).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.sbclock-rail .sbtr')).toBeTruthy();
  });

  it('a dropped share in the rail: the dial carries the alert, a red share circle opens the picker, the dial still opens the clock', () => {
    const vm = working({ capture: { screens: 0, paused: false, needed: true } });
    const { container } = render(<ClockChip vm={vm} variant="rail" />);
    expect(container.querySelector('.sbring-alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Share your screen again' }));
    expect(vm.actions.startCapture).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Screen sharing stopped/ }));
    expect(vm.actions.openClock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.sbclock-rail .sbtt[title]')).toBeTruthy();   // the rail uses native titles (ours would clip)
  });

  it('onAfterAction fires once the punch resolved, and not when the engine blocked it', async () => {
    const vm = working();
    vm.actions.punchOut = vi.fn(async () => true);
    const after = vi.fn();
    render(<ClockChip vm={vm} onAfterAction={after} />);
    fireEvent.click(btn('Punch Out'));
    await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(1));
    cleanup();
    const vm2 = working();
    vm2.actions.toggleBreak = vi.fn(async () => false);                    // a declined screen share
    const after2 = vi.fn();
    render(<ClockChip vm={vm2} onAfterAction={after2} />);
    fireEvent.click(btn('Start Break'));
    await new Promise((res) => setTimeout(res, 0));
    expect(after2).not.toHaveBeenCalled();
  });

  it('monitoring icons: share / stop, another screen, paused', () => {
    const vm = working({ capture: { screens: 0, paused: false, needed: true } });
    const r = render(<ClockChip vm={vm} />);
    const mon = screen.getByRole('group', { name: 'Screen capture' });
    fireEvent.click(within(mon).getByRole('button', { name: /Screen sharing stopped/ }));
    expect(vm.actions.startCapture).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toMatch(/Screen sharing stopped/);
    r.unmount();
    const vm1 = working({ capture: { screens: 2, paused: false, needed: false } });
    const r1 = render(<ClockChip vm={vm1} />);
    fireEvent.click(btn('Capture another screen'));
    expect(vm1.actions.startCapture).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Recording - stop capture/ }));
    expect(vm1.actions.stopCapture).toHaveBeenCalledTimes(1);
    r1.unmount();
    render(<ClockChip vm={working({ state: 'break', timer: '0:03', capture: { screens: 1, paused: true, needed: false } })} />);
    expect(screen.getByRole('button', { name: /Capture paused/ })).toBeTruthy();
  });

  it('the dial fills toward today\'s shift, with a tick per hour of it; 8h without a shift', () => {
    const { container, rerender } = render(<ClockChip vm={working({ todayMin: 120, targetMin: 240 })} />);
    expect(container.querySelectorAll('.sbring-ticks line').length).toBe(4);
    const arc = container.querySelector('.sbring-arc');
    const c = Number(arc.getAttribute('stroke-dasharray'));
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(c / 2, 2);          // half of a 4h shift
    rerender(<ClockChip vm={working({ todayMin: 120 })} />);
    expect(container.querySelectorAll('.sbring-ticks line').length).toBe(8);
    expect(Number(container.querySelector('.sbring-arc').getAttribute('stroke-dashoffset'))).toBeCloseTo(c * 0.75, 2);   // a quarter of 8h
  });

  it('a second, unshared screen is flagged like a dropped share, and the row reads Recording', () => {
    const vm = working({ capture: { screens: 1, expected: 2, paused: false, needed: false, missing: true } });
    const { container } = render(<ClockChip vm={vm} />);
    const line = screen.getByRole('status');
    expect(line.textContent).toMatch(/Second screen not shared/);
    fireEvent.click(line);                                                    // the line itself opens the picker
    expect(vm.actions.startCapture).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.sbclock-mon-label').textContent).toBe('Recording1 of 2');
    expect(container.querySelector('.sbclock-mon-add.is-needed')).toBeTruthy();
    cleanup();
    render(<ClockChip vm={working({ capture: { screens: 1, expected: 1, paused: false, needed: false, missing: false } })} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.querySelector('.sbclock-mon-label').textContent).toBe('Recording1 screen');
  });

  it('leaving: the arc drains to zero and the chip is inert', () => {
    const { container } = render(<ClockChip vm={working()} leaving />);
    expect(container.querySelector('.sbclock.is-leaving')).toBeTruthy();
    const arc = container.querySelector('.sbring-arc');
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(Number(arc.getAttribute('stroke-dasharray')), 3);
  });
});
