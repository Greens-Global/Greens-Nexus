import { describe, it, expect } from 'vitest';
import { formToRegular, formToSpecial, hoursProblem, regularToForm, specialToForm } from './hours';

// The listing form must hand Google back exactly the hours it means to, and
// must refuse to touch shapes it cannot show (split / overnight / 24-hour
// spans, multi-day holidays) rather than flatten them on save.

describe('Google hours <-> form', () => {
  const regular = { periods: [
    { openDay: 'MONDAY', openTime: { hours: 9, minutes: 30 }, closeDay: 'MONDAY', closeTime: { hours: 17 } },
    { openDay: 'SATURDAY', openTime: {}, closeDay: 'SATURDAY', closeTime: { hours: 12 } },
  ] };

  it('round-trips simple hours without changing them', () => {
    const { days, complex } = regularToForm(regular);
    expect(complex).toBe(false);
    expect(days[0]).toEqual({ day: 'MONDAY', closed: false, open: '09:30', close: '17:00' });
    expect(days[1].closed).toBe(true);
    expect(days[5]).toEqual({ day: 'SATURDAY', closed: false, open: '00:00', close: '12:00' });
    expect(formToRegular(days)).toEqual(regular);
  });

  it('marks split, overnight and 24-hour spans as not editable here', () => {
    const split = { periods: [regular.periods[0], { ...regular.periods[0], openTime: { hours: 18 }, closeTime: { hours: 20 } }] };
    const overnight = { periods: [{ openDay: 'FRIDAY', openTime: { hours: 18 }, closeDay: 'SATURDAY', closeTime: { hours: 2 } }] };
    const allDay = { periods: [{ openDay: 'MONDAY', openTime: {}, closeDay: 'MONDAY', closeTime: { hours: 24 } }] };
    for (const h of [split, overnight, allDay]) expect(regularToForm(h).complex).toBe(true);
  });

  it('round-trips holidays and flags multi-day ones', () => {
    const special = { specialHourPeriods: [
      { startDate: { year: 2026, month: 12, day: 25 }, closed: true },
      { startDate: { year: 2026, month: 12, day: 24 }, openTime: { hours: 9 }, endDate: { year: 2026, month: 12, day: 24 }, closeTime: { hours: 13 } },
    ] };
    const { rows, complex } = specialToForm(special);
    expect(complex).toBe(false);
    expect(rows[0]).toMatchObject({ date: '2026-12-25', closed: true });
    expect(formToSpecial(rows)).toEqual(special);
    const multi = { specialHourPeriods: [{ startDate: { year: 2026, month: 12, day: 24 }, endDate: { year: 2026, month: 12, day: 26 }, closed: true }] };
    expect(specialToForm(multi).complex).toBe(true);
  });

  it('refuses a day that closes before it opens, and a holiday with no date', () => {
    const { days } = regularToForm(regular);
    expect(hoursProblem(days, [])).toBe('');
    expect(hoursProblem([{ ...days[0], open: '18:00', close: '09:00' }], [])).toMatch(/Monday closes before it opens/);
    expect(hoursProblem([], [{ date: '', closed: true }])).toMatch(/needs a date/);
  });
});
