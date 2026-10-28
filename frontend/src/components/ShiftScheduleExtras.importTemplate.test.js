// The Import template (Neil, Oct 28 2026) must read straight back in: its
// header row and example rows go through the same parser Import uses.
import { describe, it, expect } from 'vitest';
import { IMPORT_COLUMNS, importTemplateRows } from './ShiftScheduleExtras';
import { parseScheduleSheet } from './shiftScheduleLib';

describe('Import template', () => {
  it('round-trips through the importer with US dates and 12-hour times', () => {
    const employees = [{ email: 'amy@x.com', name: 'Amy Adams' }, { email: 'bob@x.com', name: 'Bob Brown' }];
    const rows = importTemplateRows(employees, new Date(2026, 9, 28));   // a Wednesday
    expect(rows[0][0]).toBe('11/02/2026');                               // next Monday, MM/DD/YYYY
    const parsed = parseScheduleSheet([IMPORT_COLUMNS, ...rows], employees);
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows.map((r) => [r.email, r.date, r.start, r.end])).toEqual([
      ['amy@x.com', '2026-11-02', '09:00', '17:30'],
      ['bob@x.com', '2026-11-03', '06:30', '14:30'],
    ]);
  });
});
