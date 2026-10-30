import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import { formatTime } from '../../lib/datetime';
import { ShiftBlock } from './ShiftBlock';

// The calm block (Neil, Oct 30 2026): a type-colored dot, the time and the
// type's code; a second line ONLY for words that need saying - an unshared
// change ("New", "Edited · was ...", "Removed"), an attendance exception
// ("Late 14m", "No-Show", "On Now"), a rule flag ("Overtime"). No fill, no
// bar, no badge. The clock's story stays on hover and in the accessible name.

const shift = { id: 's1', email: 'amy@x.com', date: '2026-10-12', start: '08:00', end: '17:00', code: 'GST', shiftName: 'General Shift', color: '#2563eb', published: true };
const at = (iso) => formatTime(new Date(`${iso}Z`));
const word = () => document.querySelector('[data-actual]');
const block = () => document.querySelector('[data-shift="s1"]');
const words = () => document.querySelector('[data-shift-words]');

describe('ShiftBlock', () => {
  it('reads a dot, the time and the type code - nothing else for a plain shared shift', () => {
    const { unmount } = render(<ShiftBlock shift={shift} onOpen={() => {}} />);
    expect(word()).toBeNull();
    expect(words()).toBeNull();
    expect(block().textContent).toBe('8:00a - 5:00p' + 'GST');
    expect(block().querySelector('[data-type-dot]').style.background).toBe('rgb(37, 99, 235)');
    expect(block().querySelector('[data-type-code]').style.color).toBe('rgb(37, 99, 235)');
    // No tint: the block sits on the card.
    expect(block().style.background).toBe('var(--card)');
    unmount();
    render(<ShiftBlock shift={shift} onOpen={() => {}} actual={{ status: 'upcoming' }} />);
    expect(word()).toBeNull();
    expect(block().getAttribute('aria-label')).toBe('Shift 8:00 AM - 5:00 PM GST General Shift');
  });
  it('shows a label only when it differs from the type name, and +1 for an overnight end', () => {
    const { rerender } = render(<ShiftBlock shift={{ ...shift, label: 'General Shift' }} onOpen={() => {}} />);
    expect(words()).toBeNull();
    rerender(<ShiftBlock shift={{ ...shift, label: 'Front desk' }} onOpen={() => {}} />);
    expect(words().textContent).toBe('Front desk');
    rerender(<ShiftBlock shift={{ ...shift, start: '22:00', end: '06:30' }} onOpen={() => {}} />);
    expect(block().querySelector('[data-shift-time]').textContent).toContain('10:00p - 6:30a +1');
  });
  it('says New, Edited (with what the team sees) or Removed on a dashed block while unshared', () => {
    const { rerender } = render(<ShiftBlock shift={{ ...shift, published: false }} onOpen={() => {}} />);
    expect(words().textContent).toBe('New');
    expect(block().style.borderStyle || block().style.border).toContain('dashed');
    rerender(<ShiftBlock shift={{ ...shift, hasChanges: true, was: { start: '08:00', end: '16:30', label: '' } }} onOpen={() => {}} />);
    expect(words().textContent).toBe('Edited · was 8:00a - 4:30p');
    expect(block().getAttribute('data-unshared')).toBe('edited');
    // An edit that kept the hours (a note, a label) says Edited alone.
    rerender(<ShiftBlock shift={{ ...shift, hasChanges: true, was: { start: '08:00', end: '17:00', label: 'x' } }} onOpen={() => {}} />);
    expect(words().textContent).toBe('Edited');
    rerender(<ShiftBlock shift={{ ...shift, pendingDelete: true }} onOpen={() => {}} />);
    expect(words().textContent).toBe('Removed');
    expect(block().getAttribute('aria-label')).toContain(', Removing');
    rerender(<ShiftBlock shift={shift} onOpen={() => {}} />);
    expect(block().style.border).toContain('solid');
    expect(block().getAttribute('data-unshared')).toBeNull();
  });
  it('names rule flags in words, one per kind, and keeps every sentence in the accessible name', () => {
    const conflicts = ['42h scheduled this week (over 40h is overtime)', 'Outside availability: Tue unavailable', 'Only 9h 30m rest before this shift (10h minimum).'];
    const { rerender } = render(<ShiftBlock shift={{ ...shift, conflicts }} onOpen={() => {}} />);
    expect([...block().querySelectorAll('[data-flag]')].map((n) => n.textContent)).toEqual(['Overtime', 'Unavailable Tue']);
    expect(words().textContent).toBe('Overtime · Unavailable Tue · +1');
    expect(block().getAttribute('aria-label')).toContain('3 warnings: 42h scheduled this week');
    expect(block().hasAttribute('data-conflict')).toBe(true);
    rerender(<ShiftBlock shift={{ ...shift, conflicts }} showConflicts={false} onOpen={() => {}} />);
    expect(block().querySelector('[data-flag]')).toBeNull();
  });
  it.each([
    ['on_time', null, 'On Time'],
    ['late', 'Late 14m', 'Late'],
    ['left_early', 'Left Early 1h', 'Left Early'],
    ['no_show', 'No-Show', 'No-Show'],
    ['excused', null, 'Excused'],
    ['exempt', null, 'Exempt'],
  ])('shows attendance only as an exception word (%s)', (status, shown, name) => {
    render(<ShiftBlock shift={shift} onOpen={() => {}} actual={{ shiftId: 's1', status, lateMin: 14, earlyMin: 60 }} />);
    expect(block().getAttribute('aria-label')).toBe(`Shift 8:00 AM - 5:00 PM GST General Shift, ${name}`);
    if (shown) {
      expect(word().getAttribute('data-actual')).toBe(status);
      expect(word().textContent).toBe(shown);
    } else {
      expect(word()).toBeNull();
      expect(block().textContent).toBe('8:00a - 5:00pGST');
    }
    expect(document.querySelector('[data-actual-sheet]')).toBeNull();
  });
  it('opens a readable sheet on a tap when asked (My Shifts) or on a touch screen, never on a mouse', () => {
    const a = { shiftId: 's1', status: 'late', firstIn: '2026-10-12T15:04:00', lastOut: '2026-10-12T23:37:00', lateMin: 4, earlyMin: 23 };
    const { unmount } = render(<ShiftBlock shift={shift} onOpen={() => {}} actual={a} tapActual />);
    fireEvent.click(word());
    const sheet = document.querySelector('[data-actual-sheet]');
    expect(sheet.getAttribute('data-actual-sheet')).toBe('late');
    expect(sheet.textContent).toContain('Late');
    expect(sheet.textContent).toContain(`Clocked in ${at('2026-10-12T15:04:00')} (4 min late)`);
    expect(sheet.textContent).toContain(`Clocked out ${at('2026-10-12T23:37:00')} (23 min early)`);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(document.querySelector('[data-actual-sheet]')).toBeNull();
    fireEvent.click(word());
    expect(document.querySelector('[data-actual-sheet]')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('[data-actual-sheet]')).toBeNull();
    unmount();
    // A mouse: the hover title does the job; the word is not a button.
    render(<ShiftBlock shift={shift} onOpen={() => {}} actual={a} />);
    fireEvent.click(word());
    expect(document.querySelector('[data-actual-sheet]')).toBeNull();
    document.body.innerHTML = '';
    // A touch screen (pointer: coarse): tappable without being asked.
    const mm = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({ matches: /pointer: coarse/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
    render(<ShiftBlock shift={shift} onOpen={() => {}} actual={a} />);
    fireEvent.click(word());
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
  it('says On Now in green while the shift runs - never the type color', () => {
    render(<ShiftBlock shift={{ ...shift, color: '#f59e0b' }} onOpen={() => {}} actual={{ shiftId: 's1', status: 'in_progress', firstIn: '2026-10-12T15:04:00' }} />);
    expect(word().textContent).toBe('On Now');
    expect(word().style.color).toBe('hsl(var(--color-green))');
    expect(block().getAttribute('title')).toContain(`In progress since ${at('2026-10-12T15:04:00')}`);
    expect(block().getAttribute('aria-label')).toBe('Shift 8:00 AM - 5:00 PM GST General Shift, In Progress');
  });
});
