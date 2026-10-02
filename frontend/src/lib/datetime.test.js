import { describe, it, expect } from 'vitest';
import { formatRangeShort, weekOfYear } from './datetime';

describe('formatRangeShort (the Schedule date block, 10/02)', () => {
  it('names both months across a month boundary', () => {
    expect(formatRangeShort('2026-09-28', '2026-10-04')).toBe('Sep 28 - Oct 4');
  });
  it('says the month once when both ends share it', () => {
    expect(formatRangeShort('2026-10-05', '2026-10-11')).toBe('Oct 5 - 11');
  });
  it('reads a single day as one date', () => {
    expect(formatRangeShort('2026-10-02', '2026-10-02')).toBe('Oct 2');
    expect(formatRangeShort('2026-10-02')).toBe('Oct 2');
  });
  it('says both years when the range crosses one', () => {
    expect(formatRangeShort('2026-12-28', '2027-01-03')).toBe('Dec 28, 2026 - Jan 3, 2027');
  });
  it('takes Dates, and never rolls a bare date back a day', () => {
    expect(formatRangeShort(new Date(2026, 9, 5), new Date(2026, 9, 11))).toBe('Oct 5 - 11');
    expect(formatRangeShort('2026-11-01', '2026-11-01')).toBe('Nov 1');
  });
  it('returns the fallback for nothing', () => {
    expect(formatRangeShort('', '')).toBe('');
    expect(formatRangeShort(null, null, '-')).toBe('-');
  });
});

describe('weekOfYear (ISO weeks)', () => {
  it('numbers the week of a date', () => {
    expect(weekOfYear('2026-09-28')).toBe(40);
    expect(weekOfYear('2026-10-04')).toBe(40);
    expect(weekOfYear('2026-10-05')).toBe(41);
  });
  it('puts the first days of January in the last week of the year before when needed', () => {
    expect(weekOfYear('2027-01-01')).toBe(53);   // a Friday: still 2026's week 53
    expect(weekOfYear('2026-01-01')).toBe(1);    // a Thursday: week 1
    expect(weekOfYear('2025-12-29')).toBe(1);
  });
});

describe('wallClock (Oct 2 - punches on the employee clock)', () => {
  it('reads a naive-UTC punch on the device offset, with its own date', async () => {
    const { wallClock } = await import('./datetime');
    // 2:30 AM IST on Oct 2 = 21:00 UTC on Oct 1; IST offset is -330.
    expect(wallClock('2026-10-01T21:00:00', -330)).toEqual({ time: '2:30 AM', date: '2026-10-02', zone: 'GMT+5:30' });
    // 10:00 PM PDT on Oct 1 = 05:00 UTC on Oct 2; PDT offset is 420.
    expect(wallClock('2026-10-02T05:00:00', 420)).toEqual({ time: '10:00 PM', date: '2026-10-01', zone: 'GMT-7' });
    expect(wallClock('', 0)).toBeNull();
  });
  it('marks an after-midnight clock-out with its date in the Work Log', async () => {
    const { punchTime } = await import('../components/WorkLogDrawer');
    const tz = new Date().getTimezoneOffset();
    expect(punchTime('2026-10-01T21:00:00', -330, '2026-10-01')).toMatch(/^2:30 AM, Oct 2/);
    // Same zone as the viewer: no zone tag.
    expect(punchTime('2026-10-01T21:00:00', tz, '2026-10-01')).not.toMatch(/GMT/);
  });
});
