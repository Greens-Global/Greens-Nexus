import { describe, it, expect } from 'vitest';
import { paidMinutes, unpaidMinutes, unpaidLabel, planMinutes, fmtHrs, hrsNumber, weekStartOf, viewDays, dayHeading, timeOffOn, timeOffWhen, isAllDayOff, dayFullyOff, shiftState, orderGroups, alpha, isoDate } from './shiftLib';
import { formatHHMM, formatWeekday, formatMonthYear, formatMonthDay } from '../../lib/datetime';

// One rule for hours, time off and dates across every Shifts screen (Oct 2026).

describe('hours', () => {
  it('takes unpaid activities off the span, else the plain break', () => {
    expect(paidMinutes({ start: '09:00', end: '17:00' })).toBe(480);
    expect(paidMinutes({ start: '09:00', end: '17:00', breakMin: 30 })).toBe(450);
    expect(paidMinutes({ start: '09:00', end: '17:00', breakMin: 30, activities: [{ start: '12:00', end: '13:00', label: 'Lunch', paid: false }] })).toBe(420);   // the activities win
    expect(paidMinutes({ start: '09:00', end: '17:00', activities: [{ start: '12:00', end: '13:00', label: 'Training', paid: true }] })).toBe(480);
    expect(paidMinutes({ start: '22:00', end: '06:00' })).toBe(480);                 // overnight
    expect(paidMinutes({ start: '10:00', end: '10:00' })).toBe(0);                   // never 24 h
    expect(paidMinutes({ start: '09:00', end: '17:00', breakMin: 30, paidMin: 465 })).toBe(465);   // the server's figure wins
    expect(unpaidMinutes({ activities: [{ start: '12:00', end: '12:30', paid: false }, { start: '15:00', end: '15:15', paid: false }] })).toBe(45);
  });
  it('counts every spot of an open shift', () => {
    expect(planMinutes({ start: '09:00', end: '17:00', email: '', openSlots: 3 })).toBe(1440);
    expect(planMinutes({ start: '09:00', end: '17:00', email: 'a@x.com', openSlots: 3 })).toBe(480);
  });
  it('prints two decimals and Hrs', () => {
    expect(fmtHrs(465)).toBe('7.75 Hrs');
    expect(fmtHrs(450)).toBe('7.5 Hrs');
    expect(fmtHrs(480)).toBe('8 Hrs');
    expect(hrsNumber(470)).toBe(7.83);
  });
  it('says what the block says under the time', () => {
    expect(unpaidLabel({ activities: [{ start: '12:00', end: '12:30', label: 'Lunch', paid: false }] })).toBe('Lunch 30m');
    expect(unpaidLabel({ activities: [{ start: '12:00', end: '13:00', label: 'Lunch', paid: false }, { start: '15:00', end: '15:15', label: 'Tea', paid: false }] })).toBe('Lunch 1h +1');
    expect(unpaidLabel({ breakMin: 45 })).toBe('Break 45m');
    expect(unpaidLabel({ breakMin: 0 })).toBe('');
  });
});

describe('dates', () => {
  it('starts the week on Monday or Sunday', () => {
    const wed = new Date(2026, 8, 30);   // Wed Sep 30 2026
    expect(isoDate(weekStartOf(wed))).toBe('2026-09-28');
    expect(isoDate(weekStartOf(wed, 'sunday'))).toBe('2026-09-27');
    expect(viewDays('week', wed, 'sunday').map(isoDate)).toEqual(['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']);
    expect(viewDays('twoweeks', wed).length).toBe(14);
    expect(viewDays('month', wed).length).toBe(30);
    expect(viewDays('day', wed).length).toBe(1);
  });
  it('heads a day with its month', () => {
    expect(dayHeading(new Date(2026, 8, 29))).toBe('Tue Sep 29');
    expect(formatWeekday('2026-09-29')).toBe('Tuesday');
    expect(formatMonthYear('2026-09-29')).toBe('September 2026');
    expect(formatMonthDay('2026-10-01')).toBe('Oct 1');
    expect(formatHHMM('08:30')).toBe('8:30 AM');
    expect(formatHHMM('17:05')).toBe('5:05 PM');
    expect(formatHHMM('00:00')).toBe('12:00 AM');
    expect(formatHHMM('')).toBe('');
    expect(formatHHMM('nope', '-')).toBe('-');
  });
});

describe('time off', () => {
  const list = [{ email: 'Amy@x.com', startDate: '2026-09-28', endDate: '2026-09-29', status: 'approved' },
    { email: 'amy@x.com', startDate: '2026-09-29', endDate: '2026-09-29', startTime: '14:00', endTime: '16:00', status: 'pending' }];
  it('finds every entry on a day, partial days with their hours', () => {
    const on = timeOffOn(list, 'amy@x.com', '2026-09-29');
    expect(on.length).toBe(2);
    expect(isAllDayOff(on[0])).toBe(true);
    expect(timeOffWhen(on[0])).toBe('All Day');
    expect(timeOffWhen(on[1])).toBe('2:00 PM - 4:00 PM');
    expect(isAllDayOff({ startTime: '09:00', endTime: '13:00', allDay: true })).toBe(true);   // the API's word wins
    expect(dayFullyOff(on)).toBe(true);
    expect(dayFullyOff([on[1]])).toBe(false);                                                 // an appointment is not a day off
    expect(timeOffOn(list, 'bob@x.com', '2026-09-29')).toEqual([]);
  });
});

describe('state and groups', () => {
  it('names the unshared states', () => {
    expect(shiftState({ published: false }).tag).toBe('Draft');
    expect(shiftState({ hasChanges: true }).tag).toBe('Edited');
    expect(shiftState({ pendingDelete: true }).tag).toBe('Removing');
    expect(shiftState({ published: true }).text).toBe('Shared');
  });
  it('orders groups by sortOrder then name, and tints a color', () => {
    expect(orderGroups([{ name: 'B', sortOrder: 1 }, { name: 'A', sortOrder: 1 }, { name: 'C', sortOrder: 0 }]).map((g) => g.name)).toEqual(['C', 'A', 'B']);
    expect(alpha('#2563eb', 0.2)).toBe('rgba(37,99,235,0.2)');
    expect(alpha('bad', 0.2)).toBe('rgba(100,116,139,0.2)');
  });
});
