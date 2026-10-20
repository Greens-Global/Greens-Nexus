import { describe, it, expect } from 'vitest';
import { fromPageRange, hourLabel, periodName, rangeWords, resolvePeriod, scheduleWords, todayIso } from './reportPeriod';

// Tuesday, 10/20/2026.
const TODAY = '2026-10-20';
const r = (mode, unit, today = TODAY) => resolvePeriod({ mode, unit }, today);

describe('report periods', () => {
  it('current runs from the start of the unit to today', () => {
    expect(r('current', 'day')).toEqual({ from: '2026-10-20', to: '2026-10-20' });
    expect(r('current', 'week')).toEqual({ from: '2026-10-19', to: '2026-10-20' });      // Monday
    expect(r('current', 'month')).toEqual({ from: '2026-10-01', to: '2026-10-20' });
    expect(r('current', 'quarter')).toEqual({ from: '2026-10-01', to: '2026-10-20' });
    expect(r('current', 'year')).toEqual({ from: '2026-01-01', to: '2026-10-20' });
  });

  it('previous is the whole unit before', () => {
    expect(r('previous', 'day')).toEqual({ from: '2026-10-19', to: '2026-10-19' });
    expect(r('previous', 'week')).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(r('previous', 'month')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(r('previous', 'quarter')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(r('previous', 'year')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('handles the edges: Sunday, January, March 1st, leap years', () => {
    expect(r('current', 'week', '2026-10-25')).toEqual({ from: '2026-10-19', to: '2026-10-25' });   // Sunday ends the week
    expect(r('previous', 'month', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(r('previous', 'quarter', '2026-02-10')).toEqual({ from: '2025-10-01', to: '2025-12-31' });
    expect(r('previous', 'day', '2028-03-01')).toEqual({ from: '2028-02-29', to: '2028-02-29' });
    expect(r('previous', 'week', '2026-01-01')).toEqual({ from: '2025-12-22', to: '2025-12-28' });
  });

  it('manual keeps the dates, in order', () => {
    expect(resolvePeriod({ mode: 'manual', from: '2026-10-09', to: '2026-10-01' }, TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-09' });
    expect(resolvePeriod({ mode: 'manual' }, TODAY)).toEqual({ from: TODAY, to: TODAY });
  });

  it('reads in plain words, US dates', () => {
    expect(periodName({ mode: 'previous', unit: 'quarter' })).toBe('Previous Quarter');
    expect(periodName({ mode: 'manual' })).toBe('Custom Dates');
    expect(rangeWords({ from: '2026-10-01', to: '2026-10-20' })).toBe('10/01/2026 - 10/20/2026');
    expect(rangeWords({ from: '2026-10-20', to: '2026-10-20' })).toBe('10/20/2026');
    expect(todayIso('2026-10-20')).toBe('2026-10-20');
    expect(todayIso('')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('starts from the page period', () => {
    expect(fromPageRange({ key: 'last-month' })).toEqual({ mode: 'previous', unit: 'month' });
    expect(fromPageRange({ key: 'last-30', from: '2026-09-21', to: '2026-10-20' })).toMatchObject({ mode: 'manual', from: '2026-09-21' });
  });

  it('describes a schedule', () => {
    expect(hourLabel(0)).toBe('12:00 AM');
    expect(hourLabel(13)).toBe('1:00 PM');
    expect(scheduleWords({ frequency: 'weekly', day: 0, hour: 8 })).toBe('Every Monday at 8:00 AM');
    expect(scheduleWords({ frequency: 'monthly', day: 2, hour: 9 })).toBe('Monthly on the 2nd at 9:00 AM');
    expect(scheduleWords({ frequency: 'daily', hour: 7, includeWeekends: false })).toBe('Every weekday at 7:00 AM');
    expect(scheduleWords({ frequency: 'daily', hour: 12, includeWeekends: true })).toBe('Every day at 12:00 PM');
  });
});
