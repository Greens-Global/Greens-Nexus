import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ShiftTrack from './ShiftTrack';
import ClockChip from './ClockChip';
import { SessionChip } from '../dashboard/SessionChip';
import { shiftTrack } from '../lib/shiftTrack';

// Today's shift as a track on the clock surfaces (Neil, 11/02/2026): the
// Workday card's full track, the sidebar chip's slim one, the header pill's
// hairline - orange (live) while clocked in, green once done, nothing with
// no shift today.
afterEach(cleanup);

// 9:00 AM - 5:00 PM local, so formatTime prints the scheduled times.
const local = (h, m = 0) => new Date(2026, 10, 2, h, m);
const SHIFT = { startUtc: local(9).toISOString(), endUtc: local(17).toISOString() };
const track = (state, h, m = 0, extra = {}) => shiftTrack({ shift: SHIFT, state, now: local(h, m), ...extra });
const bar = () => screen.getByRole('progressbar', { name: "Today's shift" });

describe('<ShiftTrack />', () => {
  it('nothing at all with no track', () => {
    expect(render(<ShiftTrack track={null} />).container.innerHTML).toBe('');
  });

  it('mid shift: live, the times at the ends, a marker at now, the time left', () => {
    const { container } = render(<ShiftTrack track={track('in', 12, 44)} />);
    expect(container.querySelector('.nx-track').className).toContain('is-live');
    expect(container.querySelector('.nx-track-ends').textContent).toBe('9:00 AM5:00 PM');
    expect(container.querySelector('.nx-track-marker')).toBeTruthy();
    expect(container.querySelector('.nx-track-note').textContent).toBe("4h 16m left in today's shift");
    expect(container.querySelector('.nx-track-note b').textContent).toBe('4h 16m left');
    expect(bar().getAttribute('aria-valuetext')).toBe("4h 16m left in today's shift (9:00 AM to 5:00 PM)");
  });

  it('on a break the line says so; past the end it fills, stays live and says how far past', () => {
    render(<ShiftTrack track={track('break', 12, 44)} />);
    expect(screen.getByText('On break')).toBeTruthy();
    cleanup();
    const { container } = render(<ShiftTrack track={track('in', 18, 5)} />);
    expect(container.querySelector('.nx-track').className).toContain('is-live');
    expect(container.querySelector('.nx-track-fill').style.width).toBe('100%');
    expect(container.querySelector('.nx-track-marker')).toBeNull();
    expect(container.querySelector('.nx-track-note b').textContent).toBe('1h 05m past your shift end');
  });

  it('a finished shift is green with no marker', () => {
    const { container } = render(<ShiftTrack track={track('out', 17, 30, { worked: true, workedMin: 508 })} />);
    expect(container.querySelector('.nx-track').className).toContain('is-done');
    expect(container.querySelector('.nx-track-marker')).toBeNull();
    expect(container.querySelector('.nx-track-note').textContent).toBe('Shift complete - 8h 28m worked');
  });

  it('slim: no ends and no line, the line moves to the title', () => {
    const { container } = render(<ShiftTrack track={track('in', 12, 44)} size="sm" ends={false} note={false} />);
    expect(container.querySelector('.nx-track').className).toContain('is-sm');
    expect(container.querySelector('.nx-track-ends')).toBeNull();
    expect(container.querySelector('.nx-track-note')).toBeNull();
    expect(container.firstChild.getAttribute('title')).toBe("4h 16m left in today's shift");
  });
});

describe('the sidebar clock chip', () => {
  const actions = { toggleBreak: () => {}, punchOut: () => {}, openClock: () => {} };
  const vm = (extra) => ({ state: 'in', timer: '3:44', todayMin: 224, sinceLabel: 'since 9:00 AM', capture: null, actions, ...extra });

  it('carries a slim live track under its head while clocked in', () => {
    const { container } = render(<ClockChip vm={vm({ track: track('in', 12, 44) })} />);
    const t = container.querySelector('.sbclock-track .nx-track');
    expect(t.className).toContain('is-live');
    expect(t.className).toContain('is-sm');
    expect(container.querySelector('.sbclock-track .nx-track-marker')).toBeTruthy();
    // the head keeps its two lines and the transport is still there
    expect(screen.getByText('since 9:00 AM')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Punch Out' })).toBeTruthy();
  });

  it('no shift today: no track; the folded rail never draws one', () => {
    const { container } = render(<ClockChip vm={vm({ track: null })} />);
    expect(container.querySelector('.nx-track')).toBeNull();
    cleanup();
    const rail = render(<ClockChip vm={vm({ track: track('in', 12, 44) })} variant="rail" />);
    expect(rail.container.querySelector('.nx-track')).toBeNull();
  });
});

describe('the dashboard header chip', () => {
  const mine = (state, t) => ({ state, exempt: false, todayMin: 224, track: t });

  it('clocked in: a hairline live track along the pill, its words in the title', () => {
    render(<SessionChip mine={mine('in', track('in', 12, 44))} onOpen={() => {}} />);
    const chip = screen.getByRole('button', { name: /Clocked In/ });
    expect(chip.className).toContain('has-track');
    expect(chip.querySelector('.dk-session-track .nx-track').className).toContain('is-live');
    expect(chip.querySelector('.nx-track-marker')).toBeNull();
    expect(chip.getAttribute('title')).toBe("Open Time Clock - 4h 16m left in today's shift");
    expect(chip.textContent).toBe('Clocked In · 3:44');
  });

  it('done: green; no shift: no track and the plain title', () => {
    render(<SessionChip mine={mine('out', track('out', 17, 30, { worked: true, workedMin: 480 }))} onOpen={() => {}} />);
    expect(screen.getByRole('button').querySelector('.nx-track').className).toContain('is-done');
    cleanup();
    render(<SessionChip mine={mine('in', null)} onOpen={() => {}} />);
    const chip = screen.getByRole('button');
    expect(chip.querySelector('.nx-track')).toBeNull();
    expect(chip.getAttribute('title')).toBe('Open Time Clock');
  });
});
