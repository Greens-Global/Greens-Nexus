import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { formatTime } from '../../lib/datetime';
import { ShiftBlock } from './ShiftBlock';

// Actuals on the block (Phase 1, Oct 14): ONE thin bar under the time line
// in the status color, the clock's story on hover, the status in the
// accessible name - and still one calm text line. Nothing for an upcoming
// shift or without actuals.

vi.mock('./motion', () => ({ useReducedMotion: () => false }));

const shift = { id: 's1', email: 'amy@x.com', date: '2026-10-12', start: '08:00', end: '17:00', code: 'GST', color: '#2563eb', published: true };
const at = (iso) => formatTime(new Date(`${iso}Z`));
const bar = () => document.querySelector('[data-actual]');
const block = () => document.querySelector('[data-shift="s1"]');

describe('ShiftBlock actuals', () => {
  it('draws no bar without actuals or before the shift', () => {
    const { unmount } = render(<ShiftBlock shift={shift} onOpen={() => {}} />);
    expect(bar()).toBeNull();
    expect(block().textContent).toBe('8:00a - 5:00pGST');
    unmount();
    render(<ShiftBlock shift={shift} onOpen={() => {}} actual={{ status: 'upcoming' }} />);
    expect(bar()).toBeNull();
    expect(block().getAttribute('aria-label')).toBe('Shift 8:00 AM - 5:00 PM GST');
  });
  it.each([
    ['on_time', 'hsl(var(--color-green))', 'On Time'],
    ['late', 'hsl(var(--color-orange))', 'Late'],
    ['left_early', 'hsl(var(--color-orange))', 'Left Early'],
    ['no_show', 'hsl(var(--color-red))', 'No-Show'],
    ['excused', 'var(--muted)', 'Excused'],
    ['exempt', 'var(--muted)', 'Exempt'],
  ])('colors the bar for %s and names the status', (status, color, word) => {
    render(<ShiftBlock shift={shift} onOpen={() => {}} actual={{ shiftId: 's1', status }} />);
    const b = bar();
    expect(b.getAttribute('data-actual')).toBe(status);
    expect(b.style.background).toBe(color);
    expect(b.style.height).toBe('3px');
    expect(b.style.animation).toBe('');
    expect(block().getAttribute('aria-label')).toBe(`Shift 8:00 AM - 5:00 PM GST, ${word}`);
    expect(block().textContent).toBe('8:00a - 5:00pGST');   // still one line: the bar is the only addition
  });
  it('tells the clock\'s story on hover', () => {
    const { rerender } = render(<ShiftBlock shift={shift} onOpen={() => {}} actual={{ shiftId: 's1', status: 'late', firstIn: '2026-10-12T15:04:00', lastOut: '2026-10-12T23:37:00', lateMin: 4, earlyMin: 23 }} />);
    expect(block().getAttribute('title')).toContain(`Clocked in ${at('2026-10-12T15:04:00')} (4 min late)`);
    expect(block().getAttribute('title')).toContain(`Clocked out ${at('2026-10-12T23:37:00')} (23 min early)`);
    // With the cell's zone, the hour is the shift's own, not the viewer's.
    rerender(<ShiftBlock shift={shift} onOpen={() => {}} actual={{ shiftId: 's1', status: 'late', firstIn: '2026-10-12T03:34:00', lateMin: 4, tz: 'Asia/Kolkata' }} />);
    expect(block().getAttribute('title')).toContain('Clocked in 9:04 AM (4 min late)');
    rerender(<ShiftBlock shift={shift} onOpen={() => {}} actual={{ status: 'no_show' }} />);
    expect(block().getAttribute('title')).toContain('No clock-in (no-show)');
    rerender(<ShiftBlock shift={shift} onOpen={() => {}} actual={{ status: 'excused', excuse: 'approved time off' }} />);
    expect(block().getAttribute('title')).toContain('Excused: approved time off');
  });
  it('breathes in the block\'s own color while the shift is in progress', () => {
    render(<ShiftBlock shift={shift} onOpen={() => {}} actual={{ shiftId: 's1', status: 'in_progress', firstIn: '2026-10-12T15:04:00' }} />);
    expect(bar().style.background).toBe('rgb(37, 99, 235)');
    expect(bar().style.animation).toContain('pulse');
    expect(block().getAttribute('title')).toContain(`In progress since ${at('2026-10-12T15:04:00')}`);
    expect(block().getAttribute('aria-label')).toBe('Shift 8:00 AM - 5:00 PM GST, In Progress');
  });
});
