import { describe, it, expect } from 'vitest';
import { yearsOf, inPeriod } from './timeOffFilter';

// Year / Month period filter (Neil, Oct 21): a request is in a period when
// its startDate..endDate range overlaps it.
const one = { startDate: '2026-10-10', endDate: '2026-10-10' };
const straddle = { startDate: '2025-12-29', endDate: '2026-01-02' };
const long = { startDate: '2024-11-01', endDate: '2026-02-01' };

describe('timeOffFilter period helpers', () => {
  it('yearsOf lists every touched year, newest first, without duplicates', () => {
    expect(yearsOf([one, straddle])).toEqual(['2026', '2025']);
    expect(yearsOf([])).toEqual([]);
  });

  it('inPeriod overlaps on year, month of year, and month alone', () => {
    expect(inPeriod(one, '', '')).toBe(true);
    expect(inPeriod(one, '2026', '')).toBe(true);
    expect(inPeriod(one, '2025', '')).toBe(false);
    expect(inPeriod(straddle, '2025', '')).toBe(true);
    expect(inPeriod(straddle, '2026', '01')).toBe(true);
    expect(inPeriod(straddle, '2026', '02')).toBe(false);
    expect(inPeriod(straddle, '', '12')).toBe(true);
    expect(inPeriod(one, '', '12')).toBe(false);
    expect(inPeriod(long, '', '06')).toBe(true);     // a year in the middle
    expect(inPeriod({ startDate: '2026-03-05' }, '2026', '03')).toBe(true);   // no endDate = one day
    expect(inPeriod({}, '2026', '')).toBe(false);
  });
});
