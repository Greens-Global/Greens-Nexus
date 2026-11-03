import { describe, it, expect } from 'vitest';
import { shiftTrack, trackNote, trackNoteText, fmtSpan, shiftSpan, clockedInForShift, pickShift, trackFor, shiftsOf } from './shiftTrack';

// The shift track's math (Neil, 11/02/2026): where now sits between today's
// expected start and end, the state's color and the line under the bar.
// Shift 9:00 AM - 5:00 PM UTC (480 minutes); times written in UTC.
const SHIFT = { start: '09:00', end: '17:00', startUtc: '2026-11-02T09:00:00Z', endUtc: '2026-11-02T17:00:00Z', source: 'scheduled' };
const at = (hhmm) => new Date(`2026-11-02T${hhmm}:00Z`);
const fmt = (d) => d.toISOString().slice(11, 16);   // a stand-in for formatTime
const t = (state, hhmm, extra = {}) => shiftTrack({ shift: SHIFT, state, now: at(hhmm), ...extra });

describe('shiftTrack', () => {
  it('no shift today, or one that cannot be drawn: no track - never a made-up bar', () => {
    expect(shiftTrack({ shift: null, state: 'in', now: at('10:00') })).toBeNull();
    expect(shiftTrack({ shift: undefined, state: 'out', now: at('10:00') })).toBeNull();
    expect(shiftTrack({ shift: { ...SHIFT, endUtc: '' }, state: 'in', now: at('10:00') })).toBeNull();
    expect(shiftTrack({ shift: { ...SHIFT, endUtc: SHIFT.startUtc }, state: 'in', now: at('10:00') })).toBeNull();
    expect(shiftTrack({ shift: { ...SHIFT, startUtc: 'nope' }, state: 'in', now: at('10:00') })).toBeNull();
  });

  it('exempt, unknown and a stale open shift draw nothing', () => {
    expect(t('exempt', '10:00')).toBeNull();
    expect(t('unknown', '10:00')).toBeNull();
    expect(t('in', '10:00', { stale: true })).toBeNull();
  });

  it('before the start, clocked in early: live, empty, the start named', () => {
    const tr = t('in', '08:40');
    expect(tr).toMatchObject({ kind: 'early', state: 'live', value: 0, marker: true });
    expect(trackNoteText(tr, fmt)).toBe('Your shift starts at 09:00');
  });

  it('mid shift: live, the position of now, the time left', () => {
    const tr = t('in', '12:44');
    expect(tr).toMatchObject({ kind: 'mid', state: 'live', marker: true, leftMin: 256 });
    expect(tr.value).toBeCloseTo(224 / 480, 3);
    expect(trackNote(tr, fmt)).toEqual({ strong: '4h 16m left', rest: " in today's shift" });
  });

  it('on a break: the track keeps its place and the line says On break', () => {
    const working = t('in', '12:44'), resting = t('break', '12:44');
    expect(resting).toMatchObject({ kind: 'break', state: 'live', marker: true });
    expect(resting.value).toBe(working.value);
    expect(trackNoteText(resting, fmt)).toBe("On break · 4h 16m left in today's shift");
    expect(trackNoteText(t('break', '08:30'), fmt)).toBe('On break · your shift starts at 09:00');
    expect(trackNoteText(t('break', '17:20'), fmt)).toBe('On break · 20m past your shift end');
  });

  it('past the end, still clocked in: full, still live (overtime is not an error), time past the end', () => {
    const tr = t('in', '18:05');
    expect(tr).toMatchObject({ kind: 'over', state: 'live', value: 1, marker: false, overMin: 65 });
    expect(trackNote(tr, fmt)).toEqual({ strong: '1h 05m past your shift end', rest: '' });
    expect(trackNoteText(t('in', '17:00'), fmt)).toBe('Your shift just ended');
  });

  it('clocked out after working the shift: green and full once it is over, paused gray before', () => {
    const done = t('out', '17:30', { worked: true });
    expect(done).toMatchObject({ kind: 'done', state: 'done', value: 1, marker: false });
    expect(trackNoteText(done, fmt)).toBe('Shift complete');   // no worked figure: the Time Sheet rounds
    const stopped = t('out', '16:20', { worked: true });
    expect(stopped).toMatchObject({ kind: 'stopped', state: 'idle', marker: false, leftMin: 40 });
    expect(trackNoteText(stopped, fmt)).toBe("Clocked out · 40m left in today's shift");
  });

  it('not clocked in yet: gray, the start named; after the end with no clock-in: nothing', () => {
    expect(t('out', '07:00')).toMatchObject({ kind: 'upcoming', state: 'idle', value: 0 });
    expect(trackNoteText(t('out', '07:00'), fmt)).toBe('Your shift starts at 09:00');
    expect(t('out', '10:00')).toMatchObject({ kind: 'started', state: 'idle', value: 0.125 });
    expect(trackNoteText(t('out', '10:00'), fmt)).toBe('Your shift started at 09:00');
    expect(t('out', '17:01')).toBeNull();
  });

  it('an overnight shift runs across midnight', () => {
    const night = { startUtc: '2026-11-02T22:00:00Z', endUtc: '2026-11-03T06:00:00Z' };
    const tr = shiftTrack({ shift: night, state: 'in', now: new Date('2026-11-03T02:00:00Z') });
    expect(tr.value).toBe(0.5);
    expect(trackNoteText(tr, fmt)).toBe("4h 00m left in today's shift");
  });
});

describe('review fixes (11/02/2026)', () => {
  it('clocked out before the shift started (in early, out again): the start, not the hours left', () => {
    const tr = t('out', '08:00', { worked: true });
    expect(tr).toMatchObject({ kind: 'upcoming', state: 'idle', value: 0 });
    expect(trackNoteText(tr, fmt)).toBe('Your shift starts at 09:00');
  });

  const sp = (s, e, date = '2026-11-02') => ({ startUtc: `${s}Z`, endUtc: `${e}Z`, date });
  const AM = sp('2026-11-02T08:00:00', '2026-11-02T12:00:00');
  const PM = sp('2026-11-02T16:00:00', '2026-11-02T20:00:00');
  const inAt = (iso) => ({ d: { punches: [{ kind: 'in', at: iso }] } });

  it('pickShift: running, then one starting within four hours, then the last ended, then the next', () => {
    expect(pickShift([AM, PM], at('09:00'), { state: 'in' })).toBe(AM);
    expect(pickShift([PM, AM], at('17:00'), { state: 'in' })).toBe(PM);
    expect(pickShift([AM, PM], at('13:00'), { state: 'out' })).toBe(PM);
    expect(pickShift([AM, PM], at('21:00'), { state: 'in' })).toBe(PM);
    expect(pickShift([AM], at('03:00'), { state: 'out' })).toBe(AM);
    expect(pickShift([], at('09:00'), { state: 'in' })).toBeNull();
    expect(pickShift([{ startUtc: 'x' }], at('09:00'), { state: 'in' })).toBeNull();
  });

  it('a split shift: the second placement reads as its own shift, not "past your shift end"', () => {
    const status = { todayShifts: [AM, PM], days: inAt('2026-11-02T15:55:00') };
    const tr = trackFor({ status, state: 'in', now: at('17:00') });
    expect(tr.start.toISOString()).toBe('2026-11-02T16:00:00.000Z');
    expect(trackNoteText(tr, fmt)).toBe("3h 00m left in today's shift");
  });

  it("an overnight shift: still drawn at 00:30 for a late person, and Shift complete after the 06:00 clock-out", () => {
    const night = sp('2026-11-01T22:00:00', '2026-11-02T06:00:00', '2026-11-01');
    const tonight = sp('2026-11-02T22:00:00', '2026-11-03T06:00:00');
    expect(trackFor({ status: { todayShifts: [night], days: {} }, state: 'out', now: new Date('2026-11-02T00:30:00Z') }))
      .toMatchObject({ kind: 'started', state: 'idle' });
    const done = trackFor({ status: { todayShifts: [night, tonight], days: inAt('2026-11-01T21:58:00') }, state: 'out', now: at('06:05') });
    expect(done).toMatchObject({ kind: 'done', state: 'done' });
    expect(done.end.toISOString()).toBe('2026-11-02T06:00:00.000Z');
  });

  it('clocking in at 23:50 for a midnight shift picks the upcoming one, not the one that ended', () => {
    const day = sp('2026-11-02T14:00:00', '2026-11-02T18:00:00');
    const midnight = sp('2026-11-03T00:00:00', '2026-11-03T08:00:00', '2026-11-03');
    const tr = trackFor({ status: { todayShifts: [day, midnight], days: {} }, state: 'in', now: at('23:50') });
    expect(tr).toMatchObject({ kind: 'early', state: 'live' });
    expect(tr.start.toISOString()).toBe('2026-11-03T00:00:00.000Z');
  });

  it('trackFor falls back to the single todayShift, and draws nothing without one', () => {
    expect(shiftsOf({ todayShift: SHIFT })).toEqual([SHIFT]);
    expect(shiftsOf({ todayShifts: [], todayShift: null })).toEqual([]);
    expect(trackFor({ status: { todayShift: SHIFT }, state: 'in', now: at('12:44') })).toMatchObject({ kind: 'mid' });
    expect(trackFor({ status: {}, state: 'in', now: at('12:44') })).toBeNull();
    expect(trackFor({ status: { todayShift: SHIFT }, state: 'unknown', now: at('12:44') })).toBeNull();
  });
});

describe('helpers', () => {
  it('fmtSpan pads the minutes once there are hours', () => {
    expect(fmtSpan(256)).toBe('4h 16m');
    expect(fmtSpan(65)).toBe('1h 05m');
    expect(fmtSpan(45)).toBe('45m');
    expect(fmtSpan(-3)).toBe('0m');
  });

  it('shiftSpan reads stamps with or without a zone', () => {
    expect(shiftSpan({ startUtc: '2026-11-02T09:00:00', endUtc: '2026-11-02T17:00:00Z' }).start.toISOString()).toBe('2026-11-02T09:00:00.000Z');
  });

  it('clockedInForShift: a clock-in from a few hours before the start up to the end belongs to it', () => {
    const span = shiftSpan(SHIFT);
    const days = (at) => ({ d: { punches: [{ kind: 'in', at }] } });
    expect(clockedInForShift(days('2026-11-02T08:50:00'), span)).toBe(true);
    expect(clockedInForShift(days('2026-11-02T13:00:00'), span)).toBe(true);
    expect(clockedInForShift(days('2026-11-01T20:00:00'), span)).toBe(false);
    expect(clockedInForShift(days('2026-11-02T17:30:00'), span)).toBe(false);
    expect(clockedInForShift({ d: { punches: [{ kind: 'out', at: '2026-11-02T12:00:00' }] } }, span)).toBe(false);
    expect(clockedInForShift({}, null)).toBe(false);
  });
});
