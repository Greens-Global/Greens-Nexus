import { describe, it, expect } from 'vitest';
import { parseScheduleSheet, sheetDate, sheetTime, availText, shiftPhase } from './shiftScheduleLib';
import { zoneClock } from '../lib/datetime';

// Spreadsheet import parsing (Sep 29): the columns Export writes come back in.

describe('sheetDate / sheetTime', () => {
  it('reads US, ISO and Excel serial dates', () => {
    expect(sheetDate('11/16/2026')).toBe('2026-11-16');
    expect(sheetDate('2026-11-16')).toBe('2026-11-16');
    expect(sheetDate(46342)).toBe('2026-11-16');
    expect(sheetDate('16.11.2026')).toBe('');
  });

  it('reads 12-hour, 24-hour and Excel fraction times', () => {
    expect(sheetTime('9:00 AM')).toBe('09:00');
    expect(sheetTime('12:30 pm')).toBe('12:30');
    expect(sheetTime('12 AM')).toBe('00:00');
    expect(sheetTime('5p')).toBe('17:00');
    expect(sheetTime('17:45')).toBe('17:45');
    expect(sheetTime(0.375)).toBe('09:00');
    expect(sheetTime('')).toBe('');
    expect(sheetTime('13:00 PM')).toBeNull();
    expect(sheetTime('noon')).toBeNull();
  });
});

describe('parseScheduleSheet', () => {
  const people = [{ email: 'amy@x.com', name: 'Amy Adams' }];

  it('turns rows into shifts and explains the rest', () => {
    const { rows, problems } = parseScheduleSheet([
      ['Date', 'Employee', 'Email', 'Start', 'End', 'Unpaid Break (min)', 'Label', 'Open Spots'],
      ['11/16/2026', '', 'AMY@x.com', '9:00 AM', '5:00 PM', 30, 'Front', ''],
      ['11/16/2026', 'Amy Adams', '', '1:00 PM', '9:00 PM', '', '', ''],
      ['11/17/2026', 'Open shift', '', '6:00 AM', '2:00 PM', '', '', 2],
      ['', '', '', '', '', '', '', ''],
      ['11/17/2026', 'Zed', '', '9:00 AM', '5:00 PM', '', '', ''],
      ['11/17/2026', 'Amy Adams', '', 'soon', '5:00 PM', '', '', ''],
    ], people);
    expect(rows).toEqual([
      { row: 2, email: 'amy@x.com', date: '2026-11-16', start: '09:00', end: '17:00', shift: '', label: 'Front', note: '', break_min: 30, open_slots: null },
      { row: 3, email: 'amy@x.com', date: '2026-11-16', start: '13:00', end: '21:00', shift: '', label: '', note: '', break_min: null, open_slots: null },
      { row: 4, email: '', date: '2026-11-17', start: '06:00', end: '14:00', shift: '', label: '', note: '', break_min: null, open_slots: 2 },
    ]);
    expect(problems).toEqual(['Row 6: no one called "Zed" is on the schedule.', "Row 7: a time can't be read."]);
  });

  it('needs a Date column and someone to schedule', () => {
    expect(parseScheduleSheet([['Start', 'End']]).problems).toEqual(['The first row needs a Date column and an Email or Employee column.']);
  });
});

describe('availText', () => {
  it('summarizes the week', () => {
    expect(availText([{ weekday: 6, kind: 'available', start: '10:00', end: '14:30' }])).toBe('Sun 10:00 AM - 2:30 PM');
  });
});

// On shift now, judged on the SHIFT's clock (Sep 29 audit): the viewer's own
// clock used to decide it, so a shift kept in another zone read wrong.
describe('shiftPhase / zoneClock', () => {
  const day = { start: '09:00', end: '17:00' };
  const night = { start: '18:30', end: '02:30' };

  it('places a day shift before, during and after', () => {
    expect(shiftPhase(day, '2026-09-30', { date: '2026-09-30', minutes: 8 * 60 })).toBe('ahead');
    expect(shiftPhase(day, '2026-09-30', { date: '2026-09-30', minutes: 9 * 60 })).toBe('on');
    expect(shiftPhase(day, '2026-09-30', { date: '2026-09-30', minutes: 17 * 60 })).toBe('over');
    expect(shiftPhase(day, '2026-10-01', { date: '2026-09-30', minutes: 12 * 60 })).toBe('ahead');
    expect(shiftPhase(day, '2026-09-29', { date: '2026-09-30', minutes: 12 * 60 })).toBe('over');
  });

  it('keeps an overnight shift on until it ends the next morning', () => {
    expect(shiftPhase(night, '2026-09-30', { date: '2026-09-30', minutes: 60 })).toBe('ahead');       // 1:00 AM, before tonight's
    expect(shiftPhase(night, '2026-09-30', { date: '2026-09-30', minutes: 23 * 60 })).toBe('on');
    expect(shiftPhase(night, '2026-09-30', { date: '2026-10-01', minutes: 60 })).toBe('on');          // 1:00 AM the morning after
    expect(shiftPhase(night, '2026-09-30', { date: '2026-10-01', minutes: 3 * 60 })).toBe('over');
    expect(shiftPhase(night, '2026-09-30', { date: '2026-10-02', minutes: 60 })).toBe('over');
  });

  it('reads the clock in the zone it is given', () => {
    const at = new Date('2026-09-30T00:35:00Z');
    expect(zoneClock('Asia/Kolkata', at)).toEqual({ date: '2026-09-30', minutes: 6 * 60 + 5 });
    expect(zoneClock('America/Los_Angeles', at)).toEqual({ date: '2026-09-29', minutes: 17 * 60 + 35 });
    expect(zoneClock('UTC', new Date('2026-09-30T00:00:00Z'))).toEqual({ date: '2026-09-30', minutes: 0 });
  });
});
