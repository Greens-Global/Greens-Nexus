import { describe, it, expect, afterEach, vi } from 'vitest';
import { todayISO, addDays, taskStats, matchesFilter, EMPTY_FILTER, groupAddDefaults } from './lib';

// "Today" is the viewer's LOCAL calendar day (Oct 21 2026). It used to be
// new Date().toISOString().slice(0, 10) - the UTC day - so at 9 PM in
// California a task due today was already "overdue", and at 2 AM in India a
// task due yesterday was not.

const ORIGINAL_TZ = process.env.TZ;
const at = (tz, utc) => { process.env.TZ = tz; vi.useFakeTimers(); vi.setSystemTime(new Date(utc)); };

afterEach(() => { vi.useRealTimers(); process.env.TZ = ORIGINAL_TZ; });

describe('local today', () => {
  it('9 PM US Pacific: a task due today is due today, not overdue', () => {
    at('America/Los_Angeles', '2026-10-22T04:00:00Z');   // Oct 21, 9:00 PM PDT
    expect(new Date().getHours()).toBe(21);               // the zone really applied
    expect(todayISO()).toBe('2026-10-21');
    const task = { id: 'a', dueOn: '2026-10-21', completed: false };
    expect(taskStats([task]).overdue).toBe(0);
    expect(matchesFilter(task, { ...EMPTY_FILTER, due: 'overdue' })).toBe(false);
    expect(matchesFilter(task, { ...EMPTY_FILTER, due: 'today' })).toBe(true);
  });

  it('2 AM India: today is already the new day and yesterday is overdue', () => {
    at('Asia/Kolkata', '2026-10-21T20:30:00Z');           // Oct 22, 2:00 AM IST
    expect(todayISO()).toBe('2026-10-22');
    const dueToday = { id: 'a', dueOn: '2026-10-22', completed: false };
    const dueYesterday = { id: 'b', dueOn: '2026-10-21', completed: false };
    expect(taskStats([dueToday, dueYesterday]).overdue).toBe(1);
    expect(matchesFilter(dueToday, { ...EMPTY_FILTER, due: 'today' })).toBe(true);
    expect(matchesFilter(dueYesterday, { ...EMPTY_FILTER, due: 'overdue' })).toBe(true);
  });

  it('"Due this week" and the date-group defaults count from the local day', () => {
    at('America/Los_Angeles', '2026-10-22T04:00:00Z');
    expect(matchesFilter({ id: 'a', dueOn: '2026-10-28' }, { ...EMPTY_FILTER, due: 'week' })).toBe(true);
    expect(matchesFilter({ id: 'a', dueOn: '2026-10-29' }, { ...EMPTY_FILTER, due: 'week' })).toBe(false);
    expect(groupAddDefaults('date', 'today')).toEqual({ dueOn: '2026-10-21' });
    expect(groupAddDefaults('date', 'week')).toEqual({ dueOn: '2026-10-28' });
  });

  it('addDays steps whole calendar days, across a DST change and east of UTC', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');  // clocks fall back Nov 1
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');  // clocks spring forward Mar 8
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    process.env.TZ = 'Asia/Kolkata';
    expect(addDays('2026-10-21', 1)).toBe('2026-10-22');
    expect(addDays('2026-10-21', -21)).toBe('2026-09-30');
  });
});
