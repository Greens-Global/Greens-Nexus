// EOD post: the tasks you closed during the shift you are ending get filled
// into the Completed section for you (Sagar, Sept 1 2026).
//
// The rule that matters is the WINDOW. A calendar day is wrong: close a task at
// 11:55pm and punch out at 2:30am and it is one shift across two dates, which
// is how the timeclock itself pairs punches. These pin that, plus whose tasks
// count and what happens when there is no punch history to go on.
import { describe, it, expect } from 'vitest';
import { completedSinceTitles, shiftStartFrom, eodWindowStart } from './BodModal';

const ME = 'sagar.shoundik@greensglobal.com';

// A local wall-clock instant as the API stores it (UTC ISO).
const iso = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

const task = (over = {}) => ({
  title: 'A task', assigneeId: ME, completed: true,
  completedAt: iso(2026, 9, 1, 14), ...over,
});

// /timeclock/status shape: days keyed by local date, each with its punches.
const status = (...punches) => ({
  days: punches.reduce((acc, p) => {
    const key = p.at.slice(0, 10);
    (acc[key] = acc[key] || { punches: [] }).punches.push(p);
    return acc;
  }, {}),
});

describe('shiftStartFrom', () => {
  it('finds the punch-in that opened an open shift', () => {
    const s = status({ kind: 'in', at: iso(2026, 8, 31, 18) });
    expect(shiftStartFrom(s)).toBe(iso(2026, 8, 31, 18));
  });

  it('does not let a break end the shift', () => {
    const s = status(
      { kind: 'in', at: iso(2026, 8, 31, 18) },
      { kind: 'break_start', at: iso(2026, 8, 31, 20) },
      { kind: 'break_end', at: iso(2026, 8, 31, 21) },
    );
    expect(shiftStartFrom(s)).toBe(iso(2026, 8, 31, 18));
  });

  it('still names the shift after the punch-out lands', () => {
    // The floating widget raises the modal AFTER the out punch is recorded.
    const s = status(
      { kind: 'in', at: iso(2026, 8, 31, 18) },
      { kind: 'out', at: iso(2026, 9, 1, 2, 30) },
    );
    expect(shiftStartFrom(s)).toBe(iso(2026, 8, 31, 18));
  });

  it('ignores yesterday\'s finished shift once a new one is open', () => {
    const s = status(
      { kind: 'in', at: iso(2026, 8, 30, 9) },
      { kind: 'out', at: iso(2026, 8, 30, 17) },
      { kind: 'in', at: iso(2026, 8, 31, 18) },
    );
    expect(shiftStartFrom(s)).toBe(iso(2026, 8, 31, 18));
  });

  it('returns nothing when there is no history at all', () => {
    expect(shiftStartFrom(null)).toBe('');
    expect(shiftStartFrom({})).toBe('');
    expect(shiftStartFrom({ days: {} })).toBe('');
  });
});

// The case that prompted the fix.
describe('the shift that runs past midnight', () => {
  const punchOut = new Date(2026, 8, 1, 2, 30);              // Sept 1, 2:30am
  const closedLastNight = iso(2026, 8, 31, 23, 55);          // Aug 31, 11:55pm
  const onShift = status({ kind: 'in', at: iso(2026, 8, 31, 18) });

  it('includes a task closed at 11:55pm when punching out at 2:30am', () => {
    const since = eodWindowStart(onShift, punchOut);
    expect(completedSinceTitles([task({ completedAt: closedLastNight })], ME, since))
      .toEqual(['A task']);
  });

  it('a midnight-only window would have dropped it - that is the bug', () => {
    const midnightOnly = new Date(2026, 8, 1).toISOString();
    expect(completedSinceTitles([task({ completedAt: closedLastNight })], ME, midnightOnly))
      .toEqual([]);
  });

  it('does not reach back into the shift before this one', () => {
    const twoShifts = status(
      { kind: 'in', at: iso(2026, 8, 30, 9) },
      { kind: 'out', at: iso(2026, 8, 30, 17) },
      { kind: 'in', at: iso(2026, 8, 31, 18) },
    );
    const since = eodWindowStart(twoShifts, punchOut);
    expect(completedSinceTitles([task({ completedAt: iso(2026, 8, 30, 15) })], ME, since))
      .toEqual([]);
  });
});

describe('eodWindowStart', () => {
  it('uses midnight when the shift started later that morning', () => {
    // Ticked something off at 8:50am, punched in at 9. It still counts.
    const now = new Date(2026, 8, 1, 17);
    const since = eodWindowStart(status({ kind: 'in', at: iso(2026, 9, 1, 9) }), now);
    expect(completedSinceTitles([task({ completedAt: iso(2026, 9, 1, 8, 50) })], ME, since))
      .toEqual(['A task']);
  });

  it('falls back to midnight when the punch history is missing', () => {
    const now = new Date(2026, 8, 1, 17);
    expect(eodWindowStart(null, now)).toBe(new Date(2026, 8, 1).toISOString());
    expect(eodWindowStart({ days: {} }, now)).toBe(new Date(2026, 8, 1).toISOString());
  });
});

describe('completedSinceTitles', () => {
  const since = iso(2026, 9, 1, 0);

  it('ignores tasks assigned to someone else', () => {
    expect(completedSinceTitles([task({ assigneeId: 'other@greensglobal.com' })], ME, since))
      .toEqual([]);
  });

  it('ignores tasks that are still open', () => {
    expect(completedSinceTitles([task({ completed: false })], ME, since)).toEqual([]);
  });

  it('never treats a task with no completion time as recent', () => {
    expect(completedSinceTitles([task({ completedAt: '' })], ME, since)).toEqual([]);
    expect(completedSinceTitles([task({ completedAt: null })], ME, since)).toEqual([]);
    expect(completedSinceTitles([task({ completedAt: 'not-a-date' })], ME, since)).toEqual([]);
  });

  it('matches the assignee case-insensitively', () => {
    expect(completedSinceTitles([task({ assigneeId: ME.toUpperCase() })], ME, since))
      .toEqual(['A task']);
    expect(completedSinceTitles([task()], ME.toUpperCase(), since)).toEqual(['A task']);
  });

  it('drops blank titles rather than posting empty lines', () => {
    expect(completedSinceTitles(
      [task({ title: '' }), task({ title: '   ' }), task({ title: ' Real ' })], ME, since))
      .toEqual(['Real']);
  });

  it('survives an empty, missing or malformed task list', () => {
    expect(completedSinceTitles([], ME, since)).toEqual([]);
    expect(completedSinceTitles(null, ME, since)).toEqual([]);
    expect(completedSinceTitles(undefined, ME, since)).toEqual([]);
  });

  it('returns nothing without a signed-in user or a window', () => {
    expect(completedSinceTitles([task()], '', since)).toEqual([]);
    expect(completedSinceTitles([task()], ME, '')).toEqual([]);
    expect(completedSinceTitles([task()], ME, 'not-a-date')).toEqual([]);
  });

  it('keeps the order the API gave them', () => {
    const rows = ['One', 'Two', 'Three'].map((title) => task({ title }));
    expect(completedSinceTitles(rows, ME, since)).toEqual(['One', 'Two', 'Three']);
  });
});
