import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
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
    ['on_time', 'hsl(var(--color-green))', 'On Time', '\u2713'],
    ['late', 'hsl(var(--color-orange))', 'Late', 'L'],
    ['left_early', 'hsl(var(--color-orange))', 'Left Early', 'E'],
    ['no_show', 'hsl(var(--color-red))', 'No-Show', 'N'],
    ['excused', 'var(--muted)', 'Excused', ''],
    ['exempt', 'var(--muted)', 'Exempt', ''],
  ])('colors the bar for %s, names the status and adds the letter badge', (status, color, word, letter) => {
    render(<ShiftBlock shift={shift} onOpen={() => {}} actual={{ shiftId: 's1', status }} />);
    const b = bar();
    expect(b.getAttribute('data-actual')).toBe(status);
    expect(b.style.background).toBe(color);
    expect(b.style.height).toBe('3px');
    expect(b.style.animation).toBe('');
    expect(block().getAttribute('aria-label')).toBe(`Shift 8:00 AM - 5:00 PM GST, ${word}`);
    // Still one line: the bar and a one-letter badge (not a color) are the only additions.
    expect(block().textContent).toBe(`8:00a - 5:00pGST${letter}`);
    const badge = block().querySelector('[data-actual-badge]');
    if (letter) { expect(badge.getAttribute('data-actual-badge')).toBe(status); expect(badge.style.color).toBe(color); } else expect(badge).toBeNull();
    expect(document.querySelector('[data-actual-sheet]')).toBeNull();
  });
  it('opens a readable sheet on a tap when asked (My Shifts) or on a touch screen, never on a mouse', () => {
    const a = { shiftId: 's1', status: 'late', firstIn: '2026-10-12T15:04:00', lastOut: '2026-10-12T23:37:00', lateMin: 4, earlyMin: 23 };
    const { unmount } = render(<ShiftBlock shift={shift} onOpen={() => {}} actual={a} tapActual />);
    expect(bar().style.height).toBe('6px');   // a finger-sized bar
    fireEvent.click(block().querySelector('[data-actual-badge]'));
    const sheet = document.querySelector('[data-actual-sheet]');
    expect(sheet.getAttribute('data-actual-sheet')).toBe('late');
    expect(sheet.textContent).toContain('Late');
    expect(sheet.textContent).toContain(`Clocked in ${at('2026-10-12T15:04:00')} (4 min late)`);
    expect(sheet.textContent).toContain(`Clocked out ${at('2026-10-12T23:37:00')} (23 min early)`);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(document.querySelector('[data-actual-sheet]')).toBeNull();
    fireEvent.click(bar());
    expect(document.querySelector('[data-actual-sheet]')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('[data-actual-sheet]')).toBeNull();
    unmount();
    // A mouse: the hover title does the job; the badge is not a button.
    render(<ShiftBlock shift={shift} onOpen={() => {}} actual={a} />);
    fireEvent.click(block().querySelector('[data-actual-badge]'));
    expect(document.querySelector('[data-actual-sheet]')).toBeNull();
    expect(bar().style.height).toBe('3px');
    document.body.innerHTML = '';
    // A touch screen (pointer: coarse): tappable without being asked.
    const mm = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({ matches: /pointer: coarse/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
    render(<ShiftBlock shift={shift} onOpen={() => {}} actual={a} />);
    fireEvent.click(block().querySelector('[data-actual-badge]'));
    expect(document.querySelector('[data-actual-sheet]')).toBeTruthy();
    mm.mockRestore();
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
    rerender(<ShiftBlock shift={shift} onOpen={() => {}} actual={{ status: 'excused', excuse: 'time_off' }} />);
    expect(block().getAttribute('title')).toContain('Excused: approved time off');
    rerender(<ShiftBlock shift={shift} onOpen={() => {}} actual={{ status: 'excused', excuse: 'sick' }} />);
    expect(block().getAttribute('title')).toContain('Excused: sick leave');
    // Shared over approved time off and judged anyway (Oct 15): the hover says so.
    rerender(<ShiftBlock shift={shift} onOpen={() => {}} actual={{ status: 'no_show', over: 'time_off' }} />);
    expect(block().getAttribute('title')).toContain('No clock-in (no-show)\nScheduled over approved time off');
    // A reader who is not a manager gets the word only.
    rerender(<ShiftBlock shift={shift} onOpen={() => {}} actual={{ status: 'late', private: true, over: 'holiday' }} />);
    expect(block().getAttribute('title')).toContain('Late\nScheduled over a company holiday');
    expect(block().getAttribute('title')).not.toContain('Clocked');
  });
  it('breathes in the block\'s own color while the shift is in progress', () => {
    render(<ShiftBlock shift={shift} onOpen={() => {}} actual={{ shiftId: 's1', status: 'in_progress', firstIn: '2026-10-12T15:04:00' }} />);
    expect(bar().style.background).toBe('rgb(37, 99, 235)');
    expect(bar().style.animation).toContain('pulse');
    expect(block().getAttribute('title')).toContain(`In progress since ${at('2026-10-12T15:04:00')}`);
    expect(block().getAttribute('aria-label')).toBe('Shift 8:00 AM - 5:00 PM GST, In Progress');
  });
});
