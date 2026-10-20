import { describe, it, expect } from 'vitest';
import { checkLongShift, checkTypedPunches } from './longShift';

// The same cases as backend/test_time_charmi_oct21.py - the two must agree.
describe('checkLongShift (AM / PM guard, Charmi Oct 21)', () => {
  it('flags PM typed for AM and offers the flip', () => {
    const w = checkLongShift([{ kind: 'in', at: '2026-10-13T08:30' }], 'out', '2026-10-13T21:40');
    expect(w.minutes).toBe(13 * 60 + 10);
    expect(w.message).toBe('This makes the shift 13 hr 10 min long (8:30 AM to 9:40 PM). Did you mean 9:40 AM? '
      + 'Check AM / PM. For a time after midnight, pick the next day.');
    expect(w.suggest).toBe('2026-10-13T09:40');
    expect(w.suggestText).toBe('9:40 AM');
  });

  it("handles SwipeClock's 5:40 AM the next day", () => {
    const w = checkLongShift([{ kind: 'in', at: '2026-10-13T09:00' }], 'out', '2026-10-14T05:40');
    expect(w.message).toContain('(9:00 AM to 5:40 AM the next day)');
    expect(w.suggest).toBe('2026-10-13T17:40');
  });

  it('leaves overnight and normal shifts alone', () => {
    expect(checkLongShift([{ kind: 'in', at: '2026-10-13T22:00' }], 'out', '2026-10-14T06:00')).toBeNull();
    expect(checkLongShift([{ kind: 'in', at: '2026-10-13T08:00' }], 'out', '2026-10-13T19:00')).toBeNull();
    expect(checkLongShift([], 'in', '2026-10-13T08:00')).toBeNull();
    expect(checkLongShift([{ kind: 'in', at: '2026-10-13T08:00' }], 'out', '2026-10-13T07:00')).toBeNull();
  });

  it('gives no suggestion for a real long shift', () => {
    const w = checkLongShift([{ kind: 'in', at: '2026-10-13T07:00' }], 'out', '2026-10-13T19:00');
    expect(w.message.startsWith('This makes the shift 12 hr long (7:00 AM to 7:00 PM).')).toBe(true);
    expect(w.message).not.toContain('Did you mean');
    expect(w.suggest).toBe('');
  });

  it('judges a break against the shift clock-in', () => {
    const w = checkLongShift([{ kind: 'in', at: '2026-10-13T08:00' }], 'break_start', '2026-10-13T20:30');
    expect(w.suggestText).toBe('8:30 AM');
  });
});

describe('checkTypedPunches', () => {
  it('points at the punch whose flip fixes the pair', () => {
    const w = checkTypedPunches([], [{ kind: 'in', at: '2026-10-13T08:30' }, { kind: 'out', at: '2026-10-13T21:40' }]);
    expect(w.index).toBe(1);
    expect(w.suggest).toBe('2026-10-13T09:40');
  });
  it('is null for a normal pair', () => {
    expect(checkTypedPunches([], [{ kind: 'in', at: '2026-10-13T08:30' }, { kind: 'out', at: '2026-10-13T17:00' }])).toBeNull();
  });
});
