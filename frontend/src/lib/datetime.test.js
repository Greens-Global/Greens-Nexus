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

describe("Typing a punch time on the employee's clock (People > Time, Oct 20)", () => {
  const LA = 'America/Los_Angeles', IN = 'Asia/Kolkata';
  it('reads the zone offset in getTimezoneOffset terms, DST-correct', async () => {
    const { zoneOffsetMin } = await import('./datetime');
    expect(zoneOffsetMin(LA, '2026-10-17T15:30:00')).toBe(420);   // PDT
    expect(zoneOffsetMin(LA, '2026-12-01T15:30:00')).toBe(480);   // PST
    expect(zoneOffsetMin(IN, '2026-10-17T15:30:00')).toBe(-330);
    // Either side of the spring-forward instant (03/08/2026 10:00 UTC) and the fall-back one (11/01/2026 09:00 UTC).
    expect(zoneOffsetMin(LA, '2026-03-08T09:59:00')).toBe(480);
    expect(zoneOffsetMin(LA, '2026-03-08T10:00:00')).toBe(420);
    expect(zoneOffsetMin(LA, '2026-11-01T08:59:00')).toBe(420);
    expect(zoneOffsetMin(LA, '2026-11-01T09:00:00')).toBe(480);
  });
  it('shows a stored UTC instant as the zone-local input value', async () => {
    const { zonedInputValue } = await import('./datetime');
    expect(zonedInputValue('2026-10-17T15:30:00', LA)).toBe('2026-10-17T08:30');
    expect(zonedInputValue('2026-10-17T15:30:00', IN)).toBe('2026-10-17T21:00');
    expect(zonedInputValue('2026-12-01T17:00:00', LA)).toBe('2026-12-01T09:00');
    expect(zonedInputValue('2026-10-18T05:00:00Z', LA)).toBe('2026-10-17T22:00');
    expect(zonedInputValue('', LA)).toBe('');
  });
  it('converts a zone-local input to UTC across DST', async () => {
    const { zonedInputToUtc } = await import('./datetime');
    expect(zonedInputToUtc('2026-10-17T09:00', LA)).toBe('2026-10-17T16:00:00');
    expect(zonedInputToUtc('2026-12-01T09:00', LA)).toBe('2026-12-01T17:00:00');
    expect(zonedInputToUtc('2026-10-17T09:00', IN)).toBe('2026-10-17T03:30:00');
    // Spring forward: 1:30 AM is PST, 3:30 AM is PDT, 2:30 AM never happened (saved as 3:30 AM PDT).
    expect(zonedInputToUtc('2026-03-08T01:30', LA)).toBe('2026-03-08T09:30:00');
    expect(zonedInputToUtc('2026-03-08T03:30', LA)).toBe('2026-03-08T10:30:00');
    expect(zonedInputToUtc('2026-03-08T02:30', LA)).toBe('2026-03-08T10:30:00');
    // Fall back: 1:30 AM happens twice - the first (PDT) one; 2:30 AM is PST.
    expect(zonedInputToUtc('2026-11-01T01:30', LA)).toBe('2026-11-01T08:30:00');
    expect(zonedInputToUtc('2026-11-01T02:30', LA)).toBe('2026-11-01T10:30:00');
    expect(zonedInputToUtc('', LA)).toBe('');
  });
  it('round-trips every hour across both DST changes', async () => {
    const { zonedInputToUtc, zonedInputValue } = await import('./datetime');
    for (const day of ['2026-03-07', '2026-03-08', '2026-10-31', '2026-11-01', '2026-11-02']) {
      for (let h = 0; h < 24; h += 1) {
        const v = `${day}T${String(h).padStart(2, '0')}:15`;
        if (v === '2026-03-08T02:15') continue;   // the gap
        expect(zonedInputValue(zonedInputToUtc(v, LA), LA)).toBe(v);
        expect(zonedInputValue(zonedInputToUtc(v, IN), IN)).toBe(v);
      }
    }
  });
  it("falls back to the viewer's zone without a zone", async () => {
    const { zonedInputToUtc, zonedInputValue } = await import('./datetime');
    const v = '2026-10-17T09:00';
    expect(zonedInputToUtc(v, '')).toBe(new Date(2026, 9, 17, 9, 0).toISOString().slice(0, 19));
    expect(zonedInputValue(zonedInputToUtc(v, 'Not/AZone'), '')).toBe(v);
  });
});
