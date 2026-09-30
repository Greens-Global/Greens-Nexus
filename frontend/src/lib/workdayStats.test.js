import { describe, it, expect } from 'vitest';
import {
  weekdaysBetween, parseIsoDay, leaveRequestDays, approvedLeaveDays, tenureLabel, openShiftMinutes,
} from './workdayStats';

const d = parseIsoDay;

describe('leave days', () => {
  it('counts Mon-Fri only', () => {
    // Fri 09/25/2026 - Mon 09/28/2026 = 2 working days, not 4 calendar days
    expect(weekdaysBetween(d('2026-09-25'), d('2026-09-28'))).toBe(2);
    expect(leaveRequestDays({ startDate: '2026-09-25', endDate: '2026-09-28' })).toBe(2);
    // a full Mon-Fri week plus the weekend after it
    expect(leaveRequestDays({ startDate: '2026-09-21', endDate: '2026-09-27' })).toBe(5);
  });

  it('counts a single weekday as one day and a weekend day as zero', () => {
    expect(leaveRequestDays({ startDate: '2026-09-30', endDate: '2026-09-30' })).toBe(1);
    expect(leaveRequestDays({ startDate: '2026-09-26', endDate: '2026-09-26' })).toBe(0);
  });

  it('counts a partial day as its share of 8 hours', () => {
    expect(leaveRequestDays({ startDate: '2026-09-30', endDate: '2026-09-30', startTime: '09:00', endTime: '11:00' })).toBe(0.25);
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
  it('ignores a shift open past the 16-hour guard (missed clock-out)', () => {
    const days = { '2026-09-29': { punches: [{ kind: 'in', at: new Date(2026, 8, 29, 6).toISOString() }] } };
    expect(openShiftMinutes(days, now)).toBe(0);
  });
});
