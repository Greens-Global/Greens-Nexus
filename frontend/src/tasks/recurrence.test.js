import { describe, it, expect } from 'vitest';
import {
  nextDue, upcomingDates, firstDueOnOrAfter, ruleFromDate, recurrenceLabel, monthRuleOf, yearRuleOf, clampDays,
} from './recurrence';

// The editors preview a rule's dates with nextDue, so it must agree with the
// server's _next_due. These are the SAME cases as backend
// test_task_recurrence.py's NextDueTests - change one, change both.
describe('nextDue matches the server', () => {
  const cases = [
    ['2026-08-27', { freq: 'daily' }, '2026-08-28'],
    ['2026-08-27', { freq: 'monthly', dayOfMonth: 5 }, '2026-09-05'],
    ['2026-08-27', { freq: 'yearly' }, '2027-08-27'],
    ['2026-08-27', { freq: 'custom', unit: 'week', interval: 2, daysOfWeek: [1, 3] }, '2026-09-07'],
    ['2026-08-27', { freq: 'custom', unit: 'month', interval: 3, dayOfMonth: 1 }, '2026-11-01'],
    ['2026-08-27', { freq: 'custom', unit: 'year', interval: 2 }, '2028-08-27'],
    ['2026-10-01', { freq: 'monthly', weekOfMonth: 4, weekday: 5 }, '2026-10-23'],
    ['2026-10-23', { freq: 'monthly', weekOfMonth: 4, weekday: 5 }, '2026-11-27'],
    ['2026-10-23', { freq: 'monthly', weekOfMonth: 3, weekday: 3 }, '2026-11-18'],
    ['2026-10-23', { freq: 'monthly', weekOfMonth: -1, weekday: 5 }, '2026-10-30'],
    ['2026-10-30', { freq: 'monthly', weekOfMonth: -1, weekday: 5 }, '2026-11-27'],
    ['2026-10-30', { freq: 'monthly', weekOfMonth: 5, weekday: 5 }, '2026-11-27'],
    ['2026-10-13', { freq: 'custom', unit: 'month', interval: 2, weekOfMonth: 2, weekday: 2 }, '2026-12-08'],
    ['2026-01-31', { freq: 'monthly', dayOfMonth: -1 }, '2026-02-28'],
    ['2026-02-28', { freq: 'monthly', dayOfMonth: -1 }, '2026-03-31'],
    ['2026-03-01', { freq: 'yearly', weekOfMonth: 4, weekday: 4, monthOfYear: 11 }, '2026-11-26'],
    ['2026-11-26', { freq: 'yearly', weekOfMonth: 4, weekday: 4, monthOfYear: 11 }, '2027-11-25'],
  ];
  it.each(cases)('after %s, %j -> %s', (from, rule, want) => {
    expect(nextDue(from, rule)).toBe(want);
  });

  it('has no calendar date for Periodically', () => {
    expect(nextDue('2026-10-01', { freq: 'periodic', daysAfterCompletion: 30 })).toBe('');
  });
});

describe('upcomingDates', () => {
  it('lists the next few 4th Fridays', () => {
    expect(upcomingDates({ freq: 'monthly', weekOfMonth: 4, weekday: 5 }, '2026-10-23', 3))
      .toEqual(['2026-11-27', '2026-12-25', '2027-01-22']);
  });

  it('stops at the end date and the occurrence count', () => {
    const r = { freq: 'monthly', weekOfMonth: 4, weekday: 5 };
    expect(upcomingDates({ ...r, until: '2026-12-01' }, '2026-10-23', 3)).toEqual(['2026-11-27']);
    expect(upcomingDates({ ...r, count: 2 }, '2026-10-23', 3)).toEqual(['2026-11-27']);
  });
});

describe('firstDueOnOrAfter - filling in an empty Due Date', () => {
  it('lands on the first matching day, today included', () => {
    expect(firstDueOnOrAfter({ freq: 'monthly', weekOfMonth: 4, weekday: 5 }, '2026-10-13')).toBe('2026-10-23');
    expect(firstDueOnOrAfter({ freq: 'monthly', weekOfMonth: 2, weekday: 2 }, '2026-10-13')).toBe('2026-10-13');
    expect(firstDueOnOrAfter({ freq: 'monthly', dayOfMonth: 5 }, '2026-10-13')).toBe('2026-11-05');
    expect(firstDueOnOrAfter({ freq: 'monthly', dayOfMonth: -1 }, '2026-10-13')).toBe('2026-10-31');
    expect(firstDueOnOrAfter({ freq: 'weekly', daysOfWeek: [1] }, '2026-10-13')).toBe('2026-10-19');
  });

  it('leaves it alone for a rule that names no day', () => {
    expect(firstDueOnOrAfter({ freq: 'daily' }, '2026-10-13')).toBe('');
    expect(firstDueOnOrAfter({ freq: 'periodic', daysAfterCompletion: 7 }, '2026-10-13')).toBe('');
    expect(firstDueOnOrAfter({ freq: 'yearly' }, '2026-10-13')).toBe('');
  });
});

describe('ruleFromDate', () => {
  it('reads a due date as the day it is', () => {
    expect(ruleFromDate('2026-10-23')).toEqual({ dayOfMonth: 23, weekOfMonth: 4, weekday: 5, monthOfYear: 10 });
    // A 5th weekday reads as the last one - a 5th only exists some months.
    expect(ruleFromDate('2026-10-30').weekOfMonth).toBe(-1);
  });
});

describe('recurrenceLabel', () => {
  it('says the day a rule names', () => {
    expect(recurrenceLabel({ freq: 'monthly', weekOfMonth: 4, weekday: 5 })).toBe('Every month on the 4th Friday');
    expect(recurrenceLabel({ freq: 'monthly', weekOfMonth: -1, weekday: 3 })).toBe('Every month on the last Wednesday');
    expect(recurrenceLabel({ freq: 'monthly', dayOfMonth: -1 })).toBe('Every month on the last day');
    expect(recurrenceLabel({ freq: 'monthly', dayOfMonth: 15 })).toBe('Every month on day 15');
    expect(recurrenceLabel({ freq: 'yearly', weekOfMonth: 4, weekday: 4, monthOfYear: 11 }))
      .toBe('Every year on the 4th Thursday of November');
    expect(recurrenceLabel({ freq: 'custom', unit: 'month', interval: 2, weekOfMonth: 2, weekday: 2 }))
      .toBe('Every 2 months on the 2nd Tuesday');
    expect(recurrenceLabel({ freq: 'periodic', daysAfterCompletion: 240 })).toBe('240 days after completion');
  });

  it('shows an end date in US format', () => {
    expect(recurrenceLabel({ freq: 'daily', until: '2026-12-31' })).toBe('Every day until 12/31/2026');
  });
});

describe('editor helpers', () => {
  it('splits a rule into the parts the controls hold', () => {
    expect(monthRuleOf({ freq: 'monthly', weekOfMonth: 4, weekday: 5 })).toEqual({ weekOfMonth: 4, weekday: 5 });
    expect(monthRuleOf({ freq: 'monthly', dayOfMonth: 9 })).toEqual({ dayOfMonth: 9 });
    expect(monthRuleOf(null)).toEqual({ dayOfMonth: 1 });
    expect(yearRuleOf({ freq: 'yearly' })).toEqual({});
    expect(yearRuleOf({ freq: 'yearly', weekOfMonth: 4, weekday: 4, monthOfYear: 11 }))
      .toEqual({ weekOfMonth: 4, weekday: 4, monthOfYear: 11 });
  });

  it('keeps a typed day count whole and in range', () => {
    expect(clampDays('240')).toBe(240);
    expect(clampDays('0')).toBe(1);
    expect(clampDays('99999')).toBe(3650);
    expect(clampDays('')).toBe(1);
  });
});
