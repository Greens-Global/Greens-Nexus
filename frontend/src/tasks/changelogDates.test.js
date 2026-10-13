// Pacific time, where the bug lived: on a US evening the UTC date is already
// tomorrow. Set before anything reads the clock (Vitest runs each file in its
// own process, so this does not leak into other files).
process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect } from 'vitest';
import { formatDateTime, localDayKey, relativeDayLabel, isWithinDays } from './changelogDates';

// 5:45 PM Monday Oct 12 2026 in California is 00:45 Tuesday Oct 13 in UTC.
const NOW = new Date('2026-10-13T00:50:00Z');
const MERGED = '2026-10-13T00:45:00+00:00';      // an automatic update, a UTC instant
const TYPED = '2026-10-12T17:30';                // a hand-written one, local wall time

describe("What's New dates", () => {
  it('reads a UTC release time as the local time it was', () => {
    expect(localDayKey(MERGED)).toBe('2026-10-12');
    expect(formatDateTime(MERGED)).toBe('10/12/2026, 5:45 PM');
  });

  it('still reads a hand-written local time as written', () => {
    expect(localDayKey(TYPED)).toBe('2026-10-12');
    expect(formatDateTime(TYPED)).toBe('10/12/2026, 5:30 PM');
  });

  it("counts an evening merge as today, not as a future day outside the week", () => {
    expect(relativeDayLabel(MERGED, NOW)).toBe('Today');
    expect(isWithinDays(MERGED, 7, NOW)).toBe(true);
    expect(isWithinDays('2026-10-05T12:00:00Z', 7, NOW)).toBe(false);   // eight days back
  });
});
