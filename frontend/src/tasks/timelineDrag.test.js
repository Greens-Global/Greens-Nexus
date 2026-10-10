import { describe, it, expect } from 'vitest';
import { daysFromPixels, dragModeAt, dragDates, describeMove, addDays } from './timelineDrag';

describe('timeline drag arithmetic', () => {
  it('snaps pixels to whole days', () => {
    expect(daysFromPixels(0)).toBe(0);
    expect(daysFromPixels(12)).toBe(0);
    expect(daysFromPixels(13)).toBe(1);
    expect(daysFromPixels(-40)).toBe(-2);
  });

  it('picks the drag mode from where the bar was grabbed', () => {
    expect(dragModeAt(3, 200)).toBe('start');
    expect(dragModeAt(100, 200)).toBe('move');
    expect(dragModeAt(196, 200)).toBe('end');
    expect(dragModeAt(2, 20)).toBe('move');   // a one-day bar has no edges to grab
  });

  it('moves both dates together and keeps a missing one missing', () => {
    expect(dragDates({ startOn: '2026-10-01', dueOn: '2026-10-03' }, 'move', 2)).toEqual({ startOn: '2026-10-03', dueOn: '2026-10-05' });
    expect(dragDates({ dueOn: '2026-10-03' }, 'move', -1)).toEqual({ startOn: '', dueOn: '2026-10-02' });
    expect(dragDates({ startOn: '2026-10-01', dueOn: '2026-10-03' }, 'move', 0)).toBeNull();
    expect(dragDates({}, 'move', 3)).toBeNull();
  });

  it('a start edge never passes the end, an end edge never precedes the start', () => {
    expect(dragDates({ startOn: '2026-10-01', dueOn: '2026-10-03' }, 'start', 5)).toEqual({ startOn: '2026-10-03', dueOn: '2026-10-03' });
    expect(dragDates({ startOn: '2026-10-01', dueOn: '2026-10-03' }, 'end', -5)).toEqual({ startOn: '2026-10-01', dueOn: '2026-10-01' });
    expect(dragDates({ startOn: '2026-10-01', dueOn: '2026-10-03' }, 'start', -2)).toEqual({ startOn: '2026-09-29', dueOn: '2026-10-03' });
  });

  it('dragging the start edge of a due-only task gives it a start date', () => {
    expect(dragDates({ dueOn: '2026-10-03' }, 'start', -2)).toEqual({ startOn: '2026-10-01', dueOn: '2026-10-03' });
    expect(dragDates({ dueOn: '2026-10-03' }, 'start', 2)).toEqual({ startOn: '2026-10-03', dueOn: '2026-10-03' });
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('describes the move for the notice', () => {
    const fmt = (iso) => iso;
    expect(describeMove('Pour slab', { startOn: '2026-10-12', dueOn: '2026-10-15' }, 2, 1, fmt))
      .toBe('Moved "Pour slab" to 2026-10-12 - 2026-10-15 · 2 dependent tasks moved · 1 not moved (no access)');
    expect(describeMove('Inspect', { startOn: '', dueOn: '2026-10-15' }, 0, 0, fmt)).toBe('Moved "Inspect" to 2026-10-15');
  });
});
