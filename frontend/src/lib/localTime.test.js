import { describe, it, expect } from 'vitest';
import { hoursState, afterHoursPeople, afterHoursLine, minutesOf, differentClock, firstNameOf } from './localTime';

// 11/13/2026: 9:40 PM in India, 8:10 AM in California, 11:10 AM in New York.
const LATE_IN_INDIA = new Date('2026-11-13T16:10:00Z');
// 5:30 PM in India, 4:00 AM in California.
const EVENING_IN_INDIA = new Date('2026-11-13T12:00:00Z');
const LA = 'America/Los_Angeles';
const priya = (extra = {}) => ({ email: 'priya@example.com', name: 'Priya Patel', timeZone: 'Asia/Kolkata', workStart: '', workEnd: '', ...extra });
const sam = (extra = {}) => ({ email: 'sam@example.com', name: 'Sam Staff', timeZone: LA, workStart: '', workEnd: '', ...extra });
const line = (people, opts = {}) => afterHoursLine(people, { viewerZone: LA, now: LATE_IN_INDIA, ...opts });

describe('hoursState', () => {
  it('reads working hours on the person\'s own clock', () => {
    expect(hoursState(priya({ workStart: '13:00', workEnd: '22:00' }), LATE_IN_INDIA)).toBe('inside');
    expect(hoursState(priya({ workStart: '09:00', workEnd: '18:00' }), LATE_IN_INDIA)).toBe('outside');
    expect(hoursState(priya({ workStart: '09:00', workEnd: '18:00' }), EVENING_IN_INDIA)).toBe('inside');
  });

  it('a day that runs past midnight is a night shift', () => {
    const night = priya({ workStart: '22:00', workEnd: '06:00' });
    expect(hoursState(night, LATE_IN_INDIA)).toBe('outside');                              // 9:40 PM
    expect(hoursState(night, new Date('2026-11-13T17:30:00Z'))).toBe('inside');            // 11:00 PM
    expect(hoursState(night, new Date('2026-11-13T23:00:00Z'))).toBe('inside');            // 4:30 AM
  });

  it('with no hours set, 9:00 PM to 7:00 AM is night', () => {
    expect(hoursState(priya(), LATE_IN_INDIA)).toBe('night');
    expect(hoursState(priya(), EVENING_IN_INDIA)).toBe('day');
    expect(hoursState(priya(), new Date('2026-11-13T15:29:00Z'))).toBe('day');              // 8:59 PM
    expect(hoursState(priya(), new Date('2026-11-13T15:30:00Z'))).toBe('night');            // 9:00 PM
    expect(hoursState(priya(), new Date('2026-11-14T01:29:00Z'))).toBe('night');            // 6:59 AM
    expect(hoursState(priya(), new Date('2026-11-14T01:30:00Z'))).toBe('day');              // 7:00 AM
    // Half a pair is no pair.
    expect(hoursState(priya({ workStart: '09:00' }), LATE_IN_INDIA)).toBe('night');
  });

  it('says nothing without a zone it can read', () => {
    expect(hoursState(priya({ timeZone: '' }), LATE_IN_INDIA)).toBeNull();
    expect(hoursState(priya({ timeZone: 'Mars/Olympus' }), LATE_IN_INDIA)).toBeNull();
    expect(hoursState(null, LATE_IN_INDIA)).toBeNull();
  });
});

describe('afterHoursLine', () => {
  it('outside their hours: the time on their clock, with their first name', () => {
    expect(line([priya({ workStart: '09:00', workEnd: '18:00' })])).toMatch(/^It is 9:40\sPM for Priya$/);
    expect(line([priya({ firstName: 'Priyanka' })])).toMatch(/^It is 9:40\sPM for Priyanka$/);   // the night rule
  });

  it('inside their hours: nothing', () => {
    expect(line([priya({ workStart: '13:00', workEnd: '22:00' })])).toBe('');
    expect(line([priya()], { now: EVENING_IN_INDIA })).toBe('');
    expect(line([sam({ workStart: '08:00', workEnd: '17:00' })])).toBe('');                // same zone, in their hours
  });

  it('never for yourself', () => {
    expect(line([priya()], { me: 'PRIYA@example.com' })).toBe('');
  });

  it('someone on the viewer\'s own clock: only their working hours say anything', () => {
    // 4:00 AM in California for both: the viewer can see it is night.
    expect(line([sam()], { now: EVENING_IN_INDIA })).toBe('');
    expect(line([sam({ workStart: '09:00', workEnd: '17:00' })])).toBe('It is outside working hours for Sam');   // 8:10 AM
  });

  it('several people: one line, counted', () => {
    const people = [priya(), priya({ email: 'ravi@example.com', name: 'Ravi K' }), sam({ workStart: '08:00', workEnd: '17:00' })];
    expect(line(people)).toBe('It is after hours for 2 of these people');
    expect(afterHoursPeople(people, { viewerZone: LA, now: LATE_IN_INDIA }).map((p) => p.email)).toEqual(['priya@example.com', 'ravi@example.com']);
    // The same person twice counts once.
    expect(line([priya(), priya()])).toMatch(/for Priya$/);
  });

  it('brief leaves the clock out', () => {
    expect(line([priya({ workStart: '09:00', workEnd: '18:00' })], { brief: true })).toBe('Outside working hours');
    expect(line([priya()], { brief: true })).toBe('After hours');
  });

  it('nobody, or nobody with a zone: nothing', () => {
    expect(line([])).toBe('');
    expect(line(null)).toBe('');
    expect(line([priya({ timeZone: '' })])).toBe('');
  });
});

describe('helpers', () => {
  it('minutesOf reads HH:MM only', () => {
    expect(minutesOf('09:30')).toBe(570);
    expect(minutesOf('9:05')).toBe(545);
    expect(minutesOf('24:00')).toBeNull();
    expect(minutesOf('')).toBeNull();
    expect(minutesOf('9am')).toBeNull();
  });

  it('differentClock compares the offset at that instant, not the name', () => {
    expect(differentClock('America/Tijuana', LATE_IN_INDIA, LA)).toBe(false);
    expect(differentClock('Asia/Kolkata', LATE_IN_INDIA, LA)).toBe(true);
  });

  it('firstNameOf', () => {
    expect(firstNameOf({ name: 'Sagar Kumar Shoundik' })).toBe('Sagar');
    expect(firstNameOf({ firstName: 'Neil', name: 'N. Greens' })).toBe('Neil');
    expect(firstNameOf({})).toBe('them');
  });
});
