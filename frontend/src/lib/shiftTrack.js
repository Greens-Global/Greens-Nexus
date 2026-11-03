// The shift track's arithmetic (Neil, 11/02/2026, mock
// https://claude.ai/artifact/PwncxMck8YaSkFkQ8hmTHE section 1): which of the
// day's shifts to draw, where "now" sits between its start and end, and the
// one line under the bar. Pure - every clock surface (the Workday Time Clock
// card, My Time, the sidebar chip and the phone sheet, the dashboard header
// chip) reads it through `trackFor`, so they never disagree;
// components/ShiftTrack.jsx draws it.
//
// The shifts are the status payload's `todayShifts` (GET /timeclock/status,
// backend today_shift.py over shift_expect - a published placement, else the
// usual-hours preset): the workday's own (each placement of a split shift),
// the day before's overnight one while it is recent, and the day after's
// when it is about to start. No shift = null = no track: never a made-up
// 8-hour bar.
//
//   clocked in / on a break   live (the live accent, orange)
//     before the start        'early'  empty, "Your shift starts at 9:00 AM"
//     between                 'mid'    "4h 16m left in today's shift"
//     on a break              'break'  same position, "On break · ..."
//     past the end            'over'   full, "1h 05m past your shift end" -
//                                       still live ink, never red: overtime
//                                       is not an error (the planner's rules
//                                       WARN, never block)
//   clocked out
//     worked this shift, end passed   'done'     full, green, "Shift complete"
//                                     (no worked figure: the Time Sheet's
//                                     rounding and auto-lunch would differ)
//     worked this shift, end ahead    'stopped'  gray, paused where it stopped
//     before its start (worked or not) 'upcoming' gray, the start named
//     not clocked in, after the start 'started'  gray
//     not clocked in, end passed      null - nothing to show

// Server timestamps in the time clock are UTC, sometimes without a zone marker.
const utc = (s) => new Date(/Z|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`);
const MIN = 60000;
const HOUR = 60 * MIN;
// A clock-in this long before the expected start still belongs to the shift.
const EARLY_WINDOW_MS = 6 * HOUR;
// An upcoming shift this close wins over one that already ended (a split
// shift's second half, a midnight shift about to start).
const NEXT_WINDOW_MS = 4 * HOUR;

// Minutes as "4h 16m" (minutes padded once there are hours), "45m" under an hour.
export function fmtSpan(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

// The expected shift as two Dates, or null when it cannot be drawn.
export function shiftSpan(shift) {
  if (!shift?.startUtc || !shift?.endUtc) return null;
  const start = utc(shift.startUtc), end = utc(shift.endUtc);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;
  return { start, end };
}

// Whether a clock-in in the punches belongs to this shift: one from a few
// hours before its start up to its end.
export function clockedInForShift(days, span) {
  if (!span) return false;
  const from = span.start.getTime() - EARLY_WINDOW_MS, to = span.end.getTime();
  return Object.values(days || {}).some((d) => (d?.punches || []).some((p) => {
    if (p?.kind !== 'in' || !p.at || p.voided) return false;
    const t = utc(p.at).getTime();
    return t >= from && t <= to;
  }));
}

/**
 * The shift to draw at `now`: the one running; else one starting within
 * four hours; else the last that ended - while clocked in the latest one
 * (time past its end), while clocked out the latest one that was clocked
 * into ("Shift complete"); else the next; else the last. The same order as
 * the server's today_shift.pick, plus the clock state.
 */
export function pickShift(shifts, now = new Date(), { state, days } = {}) {
  const list = (shifts || []).map((x) => ({ x, span: shiftSpan(x) })).filter((o) => o.span)
    .sort((a, b) => a.span.start - b.span.start);
  if (!list.length) return null;
  const t = now.getTime();
  const running = list.filter((o) => o.span.start.getTime() <= t && t < o.span.end.getTime());
  if (running.length) return running[running.length - 1].x;
  const upcoming = list.filter((o) => o.span.start.getTime() > t);
  if (upcoming.length && upcoming[0].span.start.getTime() - t <= NEXT_WINDOW_MS) return upcoming[0].x;
  const ended = list.filter((o) => o.span.end.getTime() <= t).sort((a, b) => b.span.end - a.span.end);
  const live = state === 'in' || state === 'break';
  const recent = live ? ended[0] : ended.find((o) => clockedInForShift(days, o.span));
  if (recent) return recent.x;
  return (upcoming[0] || ended[0])?.x || null;
}

// The shifts a status payload offers: todayShifts, else the single todayShift
// (an API from before the list).
export function shiftsOf(status) {
  if (Array.isArray(status?.todayShifts) && status.todayShifts.length) return status.todayShifts;
  return status?.todayShift ? [status.todayShift] : [];
}

/**
 * The track for one moment. `state` is the clock's ('in' | 'break' | 'out' |
 * 'exempt' | 'unknown'); `worked` whether this shift was clocked into.
 * Returns null (draw nothing) or
 *   { kind, state: 'live'|'done'|'idle', value 0..1, marker, start, end,
 *     leftMin, overMin }
 */
export function shiftTrack({ shift, state, now = new Date(), worked = false, stale = false }) {
  if (stale || !['in', 'break', 'out'].includes(state)) return null;
  const span = shiftSpan(shift);
  if (!span) return null;
  const t = now.getTime(), s = span.start.getTime(), e = span.end.getTime();
  // Rounded so a surface that publishes on change (the sidebar's store)
  // moves every half minute or so on a full shift, not on every tick.
  const pos = Math.round(Math.min(1, Math.max(0, (t - s) / (e - s))) * 1000) / 1000;
  const leftMin = Math.max(0, Math.ceil((e - t) / MIN));
  const overMin = Math.max(0, Math.floor((t - e) / MIN));
  const base = { start: span.start, end: span.end, leftMin, overMin };
  if (state === 'in' || state === 'break') {
    const onBreak = state === 'break';
    if (t < s) return { ...base, kind: onBreak ? 'break' : 'early', state: 'live', value: 0, marker: true, before: true };
    if (t >= e) return { ...base, kind: onBreak ? 'break' : 'over', state: 'live', value: 1, marker: false, past: true };
    return { ...base, kind: onBreak ? 'break' : 'mid', state: 'live', value: pos, marker: true };
  }
  // Off the clock before the start - never clocked in, or in early and out
  // again - the start is the news, not the hours left.
  if (t < s) return { ...base, kind: 'upcoming', state: 'idle', value: 0, marker: false };
  if (worked) {
    if (t >= e) return { ...base, kind: 'done', state: 'done', value: 1, marker: false };
    return { ...base, kind: 'stopped', state: 'idle', value: pos, marker: false };
  }
  if (t >= e) return null;
  return { ...base, kind: 'started', state: 'idle', value: pos, marker: true };
}

/**
 * The one call every surface makes: pick the shift from the status payload
 * and frame it at `now`. `state` / `stale` are the clock's (deriveMyTime's).
 */
export function trackFor({ status, state, now = new Date(), stale = false }) {
  if (stale || !['in', 'break', 'out'].includes(state)) return null;
  const days = status?.days;
  const shift = pickShift(shiftsOf(status), now, { state, days });
  if (!shift) return null;
  const worked = state === 'out' && clockedInForShift(days, shiftSpan(shift));
  return shiftTrack({ shift, state, now, worked, stale });
}

/**
 * The line under the bar as { strong, rest } - `strong` takes the state's ink
 * (ProgressTrack's <b>), `rest` stays muted. `fmtTime` formats a Date
 * (lib/datetime formatTime, passed in so this file stays pure).
 */
export function trackNote(track, fmtTime) {
  if (!track) return null;
  const at = (d) => (fmtTime ? fmtTime(d) : '');
  const left = `${fmtSpan(track.leftMin)} left`;
  const past = track.overMin >= 1 ? `${fmtSpan(track.overMin)} past your shift end` : 'Your shift just ended';
  switch (track.kind) {
    case 'early': return { strong: `Your shift starts at ${at(track.start)}`, rest: '' };
    case 'mid': return { strong: left, rest: " in today's shift" };
    case 'break':
      return { strong: 'On break', rest: track.before ? ` · your shift starts at ${at(track.start)}`
        : track.past ? ` · ${past.charAt(0).toLowerCase()}${past.slice(1)}`
          : ` · ${left} in today's shift` };
    case 'over': return { strong: past, rest: '' };
    case 'done': return { strong: 'Shift complete', rest: '' };
    case 'stopped': return { strong: 'Clocked out', rest: ` · ${left} in today's shift` };
    case 'upcoming': return { strong: `Your shift starts at ${at(track.start)}`, rest: '' };
    case 'started': return { strong: `Your shift started at ${at(track.start)}`, rest: '' };
    default: return null;
  }
}

export const trackNoteText = (track, fmtTime) => {
  const n = trackNote(track, fmtTime);
  return n ? `${n.strong}${n.rest}` : '';
};
