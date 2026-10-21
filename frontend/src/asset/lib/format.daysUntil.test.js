import { describe, it, expect, vi, afterEach } from 'vitest';
import { daysUntil } from './format.js';

// Both ends are local calendar days: a bare date is the day it names, whatever
// the hour here. `new Date('YYYY-MM-DD')` (UTC midnight) made yesterday read
// as today until 5 PM Pacific.
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('daysUntil', () => {
  afterEach(() => vi.useRealTimers());
  for (const hour of [0, 10, 17, 23]) {
    it(`counts local days at ${hour}:00`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 9, 21, hour, 30));
      const today = new Date(2026, 9, 21);
      const shift = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return ymd(d); };
      expect(daysUntil(shift(0))).toBe(0);
      expect(daysUntil(shift(1))).toBe(1);
      expect(daysUntil(shift(-1))).toBe(-1);
      expect(daysUntil(shift(30))).toBe(30);
      expect(daysUntil(shift(0) + 'T23:59:00Z')).toBe(0);   // a full ISO stamp counts its date
    });
  }
  it('is null for nothing or nonsense', () => {
    expect(daysUntil('')).toBeNull();
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil('next week')).toBeNull();
  });
});
