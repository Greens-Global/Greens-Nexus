import { describe, it, expect } from 'vitest';
import { daysOverdue, STALE_DAYS } from './lib';

// Long overdue (Neil, 11/21/2026): the days an open task is past its due date.
describe('daysOverdue', () => {
  it('counts whole days past the due date, on the day given', () => {
    expect(STALE_DAYS).toBe(90);
    expect(daysOverdue({ dueOn: '2026-11-20' }, '2026-11-21')).toBe(1);
    expect(daysOverdue({ dueOn: '2025-11-21' }, '2026-11-21')).toBe(365);
    expect(daysOverdue({ dueOn: '2026-08-23' }, '2026-11-21')).toBe(90);
    // Across a daylight-saving change the day is 23 or 25 hours long.
    expect(daysOverdue({ dueOn: '2026-03-07' }, '2026-03-09')).toBe(2);
    expect(daysOverdue({ dueOn: '2026-10-31' }, '2026-11-02')).toBe(2);
    // A due date kept with a time is still its day.
    expect(daysOverdue({ dueOn: '2026-11-19T17:00:00' }, '2026-11-21')).toBe(2);
  });

  it('is 0 for today, the future, no date, and finished work', () => {
    expect(daysOverdue({ dueOn: '2026-11-21' }, '2026-11-21')).toBe(0);
    expect(daysOverdue({ dueOn: '2026-12-01' }, '2026-11-21')).toBe(0);
    expect(daysOverdue({ dueOn: '' }, '2026-11-21')).toBe(0);
    expect(daysOverdue({ dueOn: '2020-01-01', completed: true }, '2026-11-21')).toBe(0);
    expect(daysOverdue(null, '2026-11-21')).toBe(0);
  });
});
