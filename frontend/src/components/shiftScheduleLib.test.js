import { describe, it, expect } from 'vitest';
import { parseScheduleSheet, sheetDate, sheetTime, availText } from './shiftScheduleLib';

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
