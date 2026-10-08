import { describe, it, expect } from 'vitest';
import { rangeCaption, teamColor, TEAM_COLORS, conflictMap, coverageFor } from './shiftLib';

// 10/02: the date block caption, team colors, conflicts and coverage.

describe('rangeCaption', () => {
  const now = new Date(2026, 9, 2, 10, 0);   // Fri 10/02/2026
  it('reads a week as a compact title and a year · week · relative caption', () => {
    expect(rangeCaption('week', '2026-09-28', '2026-10-04', 'monday', now)).toMatchObject({ title: 'Sep 28 - Oct 4', caption: '2026 · Week 40 · This Week', exact: '09/28/2026 - 10/04/2026' });
    expect(rangeCaption('week', '2026-10-05', '2026-10-11', 'monday', now).caption).toBe('2026 · Week 41 · Next Week');
    expect(rangeCaption('week', '2026-09-21', '2026-09-27', 'monday', now).caption).toBe('2026 · Week 39 · Last Week');
    expect(rangeCaption('week', '2026-10-19', '2026-10-25', 'monday', now).caption).toBe('2026 · Week 43 · In 3 Weeks');
    expect(rangeCaption('week', '2026-09-07', '2026-09-13', 'monday', now).caption).toBe('2026 · Week 37 · 3 Weeks Ago');
  });
  it('reads a Sunday-first week by its ISO week', () => {
    expect(rangeCaption('week', '2026-09-27', '2026-10-03', 'sunday', now).caption).toBe('2026 · Week 40 · This Week');
  });
  it('reads two weeks, a day and a month', () => {
    expect(rangeCaption('twoweeks', '2026-09-28', '2026-10-11', 'monday', now).caption).toBe('2026 · Weeks 40 - 41 · This Week');
    expect(rangeCaption('day', '2026-10-02', '2026-10-02', 'monday', now)).toMatchObject({ title: 'Oct 2', caption: 'Friday · Today' });
    expect(rangeCaption('day', '2026-10-03', '2026-10-03', 'monday', now).caption).toBe('Saturday · Tomorrow');
    expect(rangeCaption('day', '2026-10-09', '2026-10-09', 'monday', now).caption).toBe('Friday · 2026');
    expect(rangeCaption('month', '2026-10-01', '2026-10-31', 'monday', now)).toMatchObject({ title: 'October 2026', caption: 'This Month' });
    expect(rangeCaption('month', '2026-12-01', '2026-12-31', 'monday', now).caption).toBe('In 2 Months');
  });
});

describe('teamColor', () => {
  it('gives eight teams eight different dots by their place, and an id a stable one', () => {
    expect(new Set(TEAM_COLORS.map((_, i) => teamColor('x', i))).size).toBe(8);
    expect(teamColor('g-1')).toBe(teamColor('g-1'));
    expect(TEAM_COLORS).toContain(teamColor('g-1'));
  });
});

describe('conflictMap', () => {
  const s = (over) => ({ id: 's', email: 'amy@x.com', date: '2026-10-03', start: '18:30', end: '02:30', published: true, ...over });
  const off = (over) => ({ email: 'amy@x.com', startDate: '2026-10-03', endDate: '2026-10-03', type: 'vacation', status: 'approved', ...over });

  it('marks both copies of a duplicate', () => {
    const m = conflictMap([s({ id: 'a' }), s({ id: 'b', published: false })]);
    expect(m.a).toEqual(['Duplicate of another shift']);
    expect(m.b).toEqual(['Duplicate of another shift']);
  });
  it('finds an overlap, overnight into the next day too; touching is fine', () => {
    const m = conflictMap([s({ id: 'night' }), s({ id: 'early', date: '2026-10-04', start: '01:00', end: '05:00', published: false })]);
    expect(m.night).toEqual(['Overlaps 1:00a - 5:00a draft']);
    expect(m.early).toEqual(['Overlaps 6:30p - 2:30a']);
    expect(conflictMap([s({ id: 'a', start: '09:00', end: '12:00' }), s({ id: 'b', start: '12:00', end: '15:00' })])).toEqual({});
  });
  it('flags approved time off - a whole day, an overlapping part of one, the next day of an overnight - and not a request', () => {
    expect(conflictMap([s({ id: 'a', start: '09:00', end: '17:00' })], [off()]).a).toEqual(['On approved Vacation']);
    expect(conflictMap([s({ id: 'a', start: '09:00', end: '17:00' })], [off({ startTime: '14:00', endTime: '16:00', allDay: false, type: 'medical' })]).a).toEqual(['On approved Medical']);
    expect(conflictMap([s({ id: 'a', start: '09:00', end: '12:00' })], [off({ startTime: '14:00', endTime: '16:00', allDay: false })])).toEqual({});
    expect(conflictMap([s({ id: 'a' })], [off({ startDate: '2026-10-04', endDate: '2026-10-04' })]).a).toEqual(['On approved Vacation']);
    expect(conflictMap([s({ id: 'a', start: '09:00', end: '17:00' })], [off({ status: 'pending' })])).toEqual({});
  });
  it('flags availability by the weekday', () => {
    const av = { 'amy@x.com': [{ weekday: 5, kind: 'unavailable' }, { weekday: 4, kind: 'available', start: '08:00', end: '12:00' }] };
    expect(conflictMap([s({ id: 'sat', start: '09:00', end: '12:00' })], [], av).sat).toEqual(['Outside availability: Sat unavailable']);
    expect(conflictMap([s({ id: 'fri', date: '2026-10-02', start: '09:00', end: '13:00' })], [], av).fri).toEqual(['Outside availability: Fri 8:00a - 12:00p']);
    expect(conflictMap([s({ id: 'fri', date: '2026-10-02', start: '09:00', end: '12:00' })], [], av)).toEqual({});
  });
  it('keeps the API sentences for what only the API sees; the short line replaces the API one of the same kind', () => {
    const m = conflictMap([s({ id: 'a', start: '09:00', end: '17:00', conflicts: ['Company holiday: Labor Day.', 'Overlaps another shift (8:00 PM - 11:00 PM on 10/02/2026).'] })]);
    expect(m.a).toEqual(['Company holiday: Labor Day.', 'Overlaps another shift (8:00 PM - 11:00 PM on 10/02/2026).']);
    const both = conflictMap([s({ id: 'a', start: '09:00', end: '17:00', conflicts: ['On approved time off that day (vacation).'] })], [off()]);
    expect(both.a).toEqual(['On approved Vacation']);
  });
  it('ignores open shifts and shifts on their way out', () => {
    expect(conflictMap([s({ id: 'a', email: '' }), s({ id: 'b', email: '' }), s({ id: 'c', pendingDelete: true }), s({ id: 'd' })])).toEqual({});
  });
});

describe('coverageFor', () => {
  const days = ['2026-09-28', '2026-09-29', '2026-10-03'];   // Mon, Tue, Sat
  const people = [{ email: 'a', name: 'Ann' }, { email: 'b', name: 'Ben' }, { email: 'c', name: 'Cal' }, { email: 'd', name: 'Dee' }];
  const weekdays = { id: 'p1', days: '1,2,3,4,5' };
  const weekend = { id: 'p2', days: '6,7' };
  const usual = { a: weekdays, b: weekdays, c: weekdays, d: weekend };
  const shift = (email, date, over = {}) => ({ id: `${email}${date}`, email, date, ...over });
  const byCellOf = (list) => list.reduce((m, x) => { (m[`${x.email}|${x.date}`] ||= []).push(x); return m; }, {});

  it('counts the people expected by their usual days (several shift types), minus a whole day off, against the people on', () => {
    const byCell = byCellOf([shift('a', '2026-09-28'), shift('b', '2026-09-28'), shift('b', '2026-09-28', { id: 'b2' }), shift('d', '2026-10-03'),
      shift('a', '2026-09-29', { pendingDelete: true })]);
    const offOn = (email, ds) => (email === 'c' && ds === '2026-09-29' ? [{ status: 'approved', allDay: true }] : []);
    const [mon, tue, sat] = coverageFor(people, days, { byCell, offOn, usualOf: (e) => usual[e] });
    expect(mon).toMatchObject({ expected: 3, on: 2, short: 1, tone: 'short1' });     // Ben counted once
    expect(mon.missing.map((m) => m.name)).toEqual(['Cal']);
    expect(tue).toMatchObject({ expected: 2, on: 0, short: 2, tone: 'short2' });     // Cal off; Ann's shift is being removed
    expect(tue.missing.map((m) => m.name)).toEqual(['Ann', 'Ben']);
    expect(tue.off.map((m) => m.name)).toEqual(['Cal']);
    expect(sat).toMatchObject({ expected: 1, on: 1, short: 0, tone: 'met' });
  });
  it('is blank with nobody expected and nobody on; a partial day off still expects them', () => {
    expect(coverageFor([{ email: 'x', name: 'X' }], ['2026-09-28'], { usualOf: () => null })[0].tone).toBe('none');
    const offOn = () => [{ status: 'approved', allDay: false, startTime: '14:00', endTime: '15:00' }];
    expect(coverageFor([people[0]], ['2026-09-28'], { offOn, usualOf: () => weekdays })[0]).toMatchObject({ expected: 1, short: 1 });
  });
});
