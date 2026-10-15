import { describe, it, expect } from 'vitest';
import { paidMinutes, unpaidMinutes, unpaidLabel, planMinutes, fmtHrs, hrsNumber, weekStartOf, viewDays, dayHeading, timeOffOn, timeOffWhen, isAllDayOff, dayFullyOff, shiftState, orderGroups, alpha, isoDate,
  actualLabel, actualColor, actualWord, actualFor, adherenceLine, hmText, punchTime, actualLetter, isRuleWarning } from './shiftLib';
import { formatHHMM, formatWeekday, formatMonthYear, formatMonthDay, formatTime } from '../../lib/datetime';

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

// Actuals (Phase 1, Oct 14): what the clock said against the schedule - the
// bar's color, the hover lines, which shift in a cell the result belongs
// to, and the week line for the people on screen.
describe('actuals', () => {
  const at = (iso) => formatTime(new Date(`${iso}Z`));   // a naive-UTC punch stamp on the viewer's clock
  it('says what the clock did, one line per fact, on the viewer\'s clock', () => {
    expect(actualLabel({ status: 'late', firstIn: '2026-10-12T15:04:00', lastOut: '2026-10-13T00:02:00', lateMin: 4, earlyMin: 0 }))
      .toBe(`Clocked in ${at('2026-10-12T15:04:00')} (4 min late)\nClocked out ${at('2026-10-13T00:02:00')}`);
    expect(actualLabel({ status: 'left_early', firstIn: '2026-10-12T15:00:00', lastOut: '2026-10-12T23:37:00', lateMin: 0, earlyMin: 23 }))
      .toBe(`Clocked in ${at('2026-10-12T15:00:00')}\nClocked out ${at('2026-10-12T23:37:00')} (23 min early)`);
    expect(actualLabel({ status: 'on_time', firstIn: '2026-10-12T15:00:00', lastOut: '' })).toBe(`Clocked in ${at('2026-10-12T15:00:00')}`);
    expect(actualLabel({ status: 'on_time' })).toBe('On Time');
    expect(actualLabel({ status: 'in_progress', firstIn: '2026-10-12T15:04:00' })).toBe(`In progress since ${at('2026-10-12T15:04:00')}`);
    expect(actualLabel({ status: 'no_show' })).toBe('No clock-in (no-show)');
    expect(actualLabel({ status: 'excused', excuse: 'time_off' })).toBe('Excused: approved time off');
    expect(actualLabel({ status: 'excused', excuse: 'weather' })).toBe('Excused: weather call');
    expect(actualLabel({ status: 'excused', excuse: 'vacation' })).toBe('Excused: vacation');
    expect(actualLabel({ status: 'excused', excuse: 'personal' })).toBe('Excused: personal time');
    expect(actualLabel({ status: 'no_show', over: 'time_off' })).toBe('No clock-in (no-show)\nScheduled over approved time off');
    expect(actualLabel({ status: 'on_time', firstIn: '2026-10-12T15:00:00', over: 'holiday' })).toBe(`Clocked in ${at('2026-10-12T15:00:00')}\nScheduled over a company holiday`);
    expect(actualLabel({ status: 'late', private: true })).toBe('Late');
    expect(actualLabel({ status: 'in_progress', private: true })).toBe('In Progress');
    expect([actualLetter('on_time'), actualLetter('late'), actualLetter('left_early'), actualLetter('no_show'), actualLetter('in_progress'), actualLetter('excused'), actualLetter('')])
      .toEqual(['\u2713', 'L', 'E', 'N', '', '', '']);
    expect(isRuleWarning('Only 8h 00m rest before this shift (10h minimum).')).toBe(true);
    expect(isRuleWarning('7th day in a row (6 is the most).')).toBe(true);
    expect(isRuleWarning('45h 00m scheduled this week (over 40h is overtime).')).toBe(true);
    expect(isRuleWarning('45h 00m scheduled this week (40h is the most).')).toBe(true);
    expect(isRuleWarning('On approved Vacation')).toBe(false);
    expect(isRuleWarning('Overlaps 2:00a - 6:00a')).toBe(false);
    expect(actualLabel({ status: 'exempt' })).toBe('Exempt');
    expect(actualLabel({ status: 'upcoming' })).toBe('');
    expect(actualLabel(null)).toBe('');
    expect(punchTime('2026-10-12T15:04:00')).toBe(at('2026-10-12T15:04:00'));
    expect(punchTime('')).toBe('');
  });
  it('reads the punches on the SHIFT\'s clock when the cell says its zone, the viewer\'s only without one', () => {
    // 3:34 UTC = 9:04 AM in Kolkata, whoever is looking - a Los Angeles manager sees the India crew's own hour.
    const india = { status: 'late', firstIn: '2026-10-12T03:34:00', lastOut: '2026-10-12T12:02:00', lateMin: 4, earlyMin: 0, tz: 'Asia/Kolkata' };
    expect(actualLabel(india)).toBe('Clocked in 9:04 AM (4 min late)\nClocked out 5:32 PM');
    expect(actualLabel({ status: 'in_progress', firstIn: '2026-10-12T03:34:00', tz: 'Asia/Kolkata' })).toBe('In progress since 9:04 AM');
    expect(punchTime('2026-10-12T03:34:00', 'America/Los_Angeles')).toBe('8:34 PM');   // the night before, there
    expect(punchTime('2026-10-12T03:34:00', 'Not/AZone')).toBe(at('2026-10-12T03:34:00'));   // an unknown zone: the viewer's clock
    expect(punchTime('2026-10-12T03:34:00', '')).toBe(at('2026-10-12T03:34:00'));
  });
  it('colors the bar by status, the block\'s own color while in progress, nothing before', () => {
    expect(actualColor('on_time')).toBe('hsl(var(--color-green))');
    expect(actualColor('late')).toBe('hsl(var(--color-orange))');
    expect(actualColor('left_early')).toBe('hsl(var(--color-orange))');
    expect(actualColor('no_show')).toBe('hsl(var(--color-red))');
    expect(actualColor('excused')).toBe('var(--muted)');
    expect(actualColor('exempt')).toBe('var(--muted)');
    expect(actualColor('in_progress', '#2563eb')).toBe('#2563eb');
    expect(actualColor('upcoming')).toBe('');
    expect(actualWord('left_early')).toBe('Left Early');
    expect(actualWord('no_show')).toBe('No-Show');
  });
  it('hands a cell\'s result to the shift it names, or the only shift there', () => {
    const cell = { shiftId: 's1', status: 'late' };
    expect(actualFor(cell, { id: 's1' })).toBe(cell);
    expect(actualFor(cell, { id: 's2' })).toBeNull();
    expect(actualFor(cell, { id: 's2' }, true)).toBe(cell);         // the only shift in the cell
    expect(actualFor({ status: 'late' }, { id: 's2' })).toEqual({ status: 'late' });   // no shiftId on the cell
    expect(actualFor({ shiftId: 's1', status: 'upcoming' }, { id: 's1' })).toBeNull();
    expect(actualFor(null, { id: 's1' })).toBeNull();
  });
  it('adds up the week line for the people shown, and knows when there is nothing to say', () => {
    const people = {
      'amy@x.com': { scheduledMin: 2400, workedMin: 2290, late: 2, noShow: 1, leftEarly: 0, onTime: 2 },
      'Bob@x.com': { scheduledMin: 2400, workedMin: 2415, late: 0, noShow: 0, leftEarly: 2, onTime: 3 },
      'cat@x.com': { scheduledMin: 480, workedMin: 480, late: 9, noShow: 9, leftEarly: 9, onTime: 0 },   // not on screen
    };
    const line = adherenceLine(people, ['amy@x.com', 'bob@x.com']);
    expect(line.text).toBe('Scheduled 80h 00m · Worked 78h 25m · 2 Late · 1 No-Show · 2 Left Early');
    expect(line.parts).toEqual(['Scheduled 80h 00m', 'Worked 78h 25m', '2 Late', '1 No-Show', '2 Left Early']);
    expect(line.people).toBe(2);
    expect(line.empty).toBe(false);
    expect(adherenceLine(people, ['amy@x.com']).text).toBe('Scheduled 40h 00m · Worked 38h 10m · 2 Late · 1 No-Show');
    const quiet = adherenceLine({ 'amy@x.com': { scheduledMin: 480, workedMin: 0, late: 0, noShow: 0, leftEarly: 0, onTime: 0 } }, ['amy@x.com']);
    expect(quiet.empty).toBe(true);
    expect(adherenceLine(people, ['nobody@x.com']).people).toBe(0);
    expect(adherenceLine(null, ['amy@x.com']).empty).toBe(true);
    expect(hmText(18750)).toBe('312h 30m');
    expect(hmText(5)).toBe('0h 05m');
  });
});
