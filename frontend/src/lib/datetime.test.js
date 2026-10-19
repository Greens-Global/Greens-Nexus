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

describe("zonedDateTime (an approver reads the employee's clock, Oct 19)", () => {
  it("shows a Pacific employee's 8:30 AM to an approver in India, labeled", async () => {
    const { zonedDateTime } = await import('./datetime');
    // 8:30 AM PDT on 10/17 = 15:30 UTC (9:00 PM IST).
    expect(zonedDateTime('2026-10-17T15:30:00', 'America/Los_Angeles', 'Asia/Kolkata'))
      .toEqual({ date: '10/17/2026', time: '8:30 AM', zone: 'PT', differs: true, label: '8:30 AM PT' });
  });
  it('leaves the label off when the viewer shares the zone', async () => {
    const { zonedDateTime } = await import('./datetime');
    const r = zonedDateTime('2026-10-17T15:30:00', 'America/Los_Angeles', 'America/Los_Angeles');
    expect(r.differs).toBe(false);
    expect(r.label).toBe('8:30 AM');
  });
  it("rolls the date onto the employee's calendar", async () => {
    const { zonedDateTime } = await import('./datetime');
    // 10:00 PM PDT on 10/17 = 05:00 UTC on 10/18.
    const r = zonedDateTime('2026-10-18T05:00:00', 'America/Los_Angeles', 'Asia/Kolkata');
    expect(r.date).toBe('10/17/2026');
    expect(r.label).toBe('10:00 PM PT');
  });
  it("reads the viewer's clock, unlabeled, without a zone or with a bad one", async () => {
    const { zonedDateTime } = await import('./datetime');
    for (const tz of ['', 'Not/AZone']) {
      const r = zonedDateTime('2026-10-17T15:30:00', tz);
      expect(r.differs).toBe(false);
      expect(r.zone).toBe('');
    }
    expect(zonedDateTime('', 'America/Los_Angeles')).toBeNull();
  });
  it('formatDateTime and formatDate take an optional zone', async () => {
    const { formatDateTime, formatDate } = await import('./datetime');
    expect(formatDateTime('2026-10-17T15:30:00Z', '', 'Asia/Kolkata')).toBe('10/17/2026, 9:00 PM');
    expect(formatDate('2026-10-18T05:00:00Z', '', 'America/Los_Angeles')).toBe('10/17/2026');
  });
});
