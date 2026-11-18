import { describe, it, expect } from 'vitest';
import {
  weekdaysBetween, parseIsoDay, leaveRequestDays, approvedLeaveDays, tenureLabel, openShiftMinutes, clockToday,
} from './workdayStats';

const d = parseIsoDay;

describe('leave days', () => {
  it('counts Mon-Fri only', () => {
    // Fri 09/25/2026 - Mon 09/28/2026 = 2 working days, not 4 calendar days
    expect(weekdaysBetween(d('2026-09-25'), d('2026-09-28'))).toBe(2);
    expect(leaveRequestDays({ startDate: '2026-09-25', endDate: '2026-09-28' })).toBe(2);
    // a full Mon-Fri week plus the weekend after it
    expect(leaveRequestDays({ startDate: '2026-09-21', endDate: '2026-09-27' })).toBe(5);
    // 11/16 - 11/30/2026 with Thanksgiving and Black Friday off: 9, not 11
    // (a holiday outside the range or on a weekend changes nothing)
    expect(leaveRequestDays({ startDate: '2026-11-16', endDate: '2026-11-30',
      holidays: ['2026-11-26', '2026-11-27', '2026-11-28', '2026-12-25'] })).toBe(9);
  });

  it('counts a single weekday as one day and a weekend day as zero', () => {
    expect(leaveRequestDays({ startDate: '2026-09-30', endDate: '2026-09-30' })).toBe(1);
    expect(leaveRequestDays({ startDate: '2026-09-26', endDate: '2026-09-26' })).toBe(0);
  });

  it('counts a partial day as its share of 8 hours', () => {
    expect(leaveRequestDays({ startDate: '2026-09-30', endDate: '2026-09-30', startTime: '09:00', endTime: '11:00' })).toBe(0.25);
  });

  it('never counts one day as more than a day (Sep 30: 8:30 AM - 5:30 PM sick read 1.13)', () => {
    // A single-day window the length of a whole shift, lunch included, is ONE day.
    expect(leaveRequestDays({ startDate: '2026-09-22', endDate: '2026-09-22', startTime: '08:30', endTime: '17:30' })).toBe(1);
    expect(leaveRequestDays({ startDate: '2026-09-22', endDate: '2026-09-22', startTime: '07:00', endTime: '17:00' })).toBe(1);
  });

  it('clips a request that crosses New Year to the asked year', () => {
    const r = { startDate: '2025-12-29', endDate: '2026-01-02' };   // Mon - Fri
    expect(leaveRequestDays(r, 2025)).toBe(3);
    expect(leaveRequestDays(r, 2026)).toBe(2);
    expect(leaveRequestDays(r, 2027)).toBe(0);
  });

  it('sums approved requests only', () => {
    const rows = [
      { status: 'approved', startDate: '2026-09-25', endDate: '2026-09-28' },
      { status: 'approved', startDate: '2026-03-02', endDate: '2026-03-02', startTime: '13:00', endTime: '17:00' },
      { status: 'pending', startDate: '2026-10-05', endDate: '2026-10-09' },
      { status: 'rejected', startDate: '2026-04-06', endDate: '2026-04-10' },
      { status: 'cancelled', startDate: '2026-05-04', endDate: '2026-05-08' },
      { status: 'approved', startDate: '2025-06-02', endDate: '2025-06-06' },
    ];
    expect(approvedLeaveDays(rows, 2026)).toBe(2.5);
    expect(approvedLeaveDays(rows, 2025)).toBe(5);
    expect(approvedLeaveDays([], 2026)).toBe(0);
  });

  it('ignores rows with no usable dates', () => {
    expect(leaveRequestDays({ startDate: '', endDate: '' })).toBe(0);
    expect(leaveRequestDays({ startDate: 'garbage' })).toBe(0);
  });
});

describe('tenureLabel', () => {
  const now = new Date(2026, 8, 30);   // 09/30/2026
  it('returns null without a usable start date', () => {
    expect(tenureLabel('', now)).toBe(null);
    expect(tenureLabel(null, now)).toBe(null);
    expect(tenureLabel('2026-10-15', now)).toBe(null);   // not started yet
  });
  it('uses days, then whole months, then years', () => {
    expect(tenureLabel('2026-09-20', now)).toBe('10d');
    expect(tenureLabel('2026-02-28', now)).toBe('7mo');
    expect(tenureLabel('2015-12-09', now)).toBe('10.8y');
    expect(tenureLabel('2024-09-30', now)).toBe('2.0y');
  });
});

describe('openShiftMinutes', () => {
  const at = (h, m = 0) => new Date(2026, 8, 30, h, m).toISOString();
  const now = new Date(2026, 8, 30, 12, 0).getTime();
  it('counts a shift that is still open, minus closed breaks', () => {
    const days = { '2026-09-30': { punches: [
      { kind: 'in', at: at(8) }, { kind: 'break_start', at: at(10) }, { kind: 'break_end', at: at(10, 30) },
    ] } };
    expect(openShiftMinutes(days, now)).toBe(210);
  });
  it('stops the clock at an open break', () => {
    const days = { '2026-09-30': { punches: [{ kind: 'in', at: at(8) }, { kind: 'break_start', at: at(11) }] } };
    expect(openShiftMinutes(days, now)).toBe(180);
  });
  it('is zero once the shift is closed', () => {
    const days = { '2026-09-30': { punches: [{ kind: 'in', at: at(8) }, { kind: 'out', at: at(11) }] } };
    expect(openShiftMinutes(days, now)).toBe(0);
    expect(openShiftMinutes({}, now)).toBe(0);
  });
  it('reads a zone-less punch time as UTC, the way the server sends it', () => {
    const inAt = new Date(now - 90 * 60000).toISOString().slice(0, 19);   // no 'Z'
    expect(openShiftMinutes({ d: { punches: [{ kind: 'in', at: inAt }] } }, now)).toBe(90);
  });
  it('ignores a shift open past the 16-hour guard (missed clock-out)', () => {
    const days = { '2026-09-29': { punches: [{ kind: 'in', at: new Date(2026, 8, 29, 6).toISOString() }] } };
    expect(openShiftMinutes(days, now)).toBe(0);
  });
});

// The Workday clock card's Today view (11/17/2026).
describe('clockToday', () => {
  const utc = (d, h, m = 0) => new Date(Date.UTC(2026, 10, d, h, m)).toISOString().slice(0, 19);   // zone-less, like the server
  const at = (d, h, m = 0) => Date.UTC(2026, 10, d, h, m);

  it('keeps the running shift through a break - 4h 00m does not drop to 0 and jump back', () => {
    const days = { '2026-11-17': { workedMin: 0, punches: [{ kind: 'in', at: utc(17, 8) }, { kind: 'break_start', at: utc(17, 12) }] } };
    const args = { days, todayKey: '2026-11-17', clockedIn: true, sessionDay: '2026-11-17', sessionInAt: utc(17, 8) };
    // Twenty minutes into the break: still the four hours worked before it.
    const onBreak = clockToday({ ...args, now: at(17, 12, 20) });
    expect(onBreak.liveMin).toBe(240);
    expect(onBreak.workedToday).toBe(240);
    // Back from the break, the same number carries on (the break is not counted).
    const back = { '2026-11-17': { workedMin: 0, punches: [...days['2026-11-17'].punches, { kind: 'break_end', at: utc(17, 12, 30) }] } };
    expect(clockToday({ ...args, days: back, now: at(17, 12, 40) }).workedToday).toBe(250);
  });

  it('adds the running shift to the segments already closed today', () => {
    const days = { '2026-11-17': { workedMin: 180, punches: [
      { kind: 'in', at: utc(17, 8) }, { kind: 'out', at: utc(17, 11) }, { kind: 'in', at: utc(17, 12) }] } };
    const r = clockToday({ days, todayKey: '2026-11-17', clockedIn: true, sessionDay: '2026-11-17', sessionInAt: utc(17, 12), now: at(17, 13) });
    expect(r.workedToday).toBe(240);
    expect(r.overnight).toBe(false);
    expect(r.firstInAt).toBe(utc(17, 8));
    expect(r.punches).toHaveLength(3);
  });

  it('shows a shift from before midnight on Today: its time, its clock-in and its punches', () => {
    const days = {
      '2026-11-16': { workedMin: 480, punches: [
        { kind: 'in', at: utc(16, 8) }, { kind: 'out', at: utc(16, 16) },      // an earlier, closed shift that day
        { kind: 'in', at: utc(16, 22) }] },                                    // the one still running
      '2026-11-17': { workedMin: 0, punches: [{ kind: 'break_start', at: utc(17, 1) }, { kind: 'break_end', at: utc(17, 1, 30) }] },
    };
    const r = clockToday({ days, todayKey: '2026-11-17', clockedIn: true, sessionDay: '2026-11-16', sessionInAt: utc(16, 22), now: at(17, 2) });
    expect(r.overnight).toBe(true);
    expect(r.workedToday).toBe(210);                 // 10:00 PM to 2:00 AM, less the 30-minute break
    expect(r.firstInAt).toBe(utc(16, 22));
    expect(r.punches.map(p => p.kind)).toEqual(['in', 'break_start', 'break_end']);   // not the closed morning shift
  });

  it('is plain when off the clock: nothing live, today only', () => {
    const days = { '2026-11-16': { workedMin: 480, punches: [{ kind: 'in', at: utc(16, 8) }, { kind: 'out', at: utc(16, 16) }] } };
    const r = clockToday({ days, todayKey: '2026-11-17', clockedIn: false, now: at(17, 9) });
    expect(r).toEqual({ liveMin: 0, overnight: false, workedToday: 0, firstInAt: '', punches: [] });
    expect(clockToday({ days: {}, todayKey: '2026-11-17', clockedIn: true, now: at(17, 9) }).workedToday).toBe(0);
  });
});
