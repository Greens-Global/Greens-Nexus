// The shift track's arithmetic (Neil, 11/02/2026, mock
// https://claude.ai/artifact/PwncxMck8YaSkFkQ8hmTHE section 1): where "now"
// sits between today's expected start and end, and the one line under the
// bar. Pure - every clock surface (the Workday Time Clock card, My Time, the
// sidebar chip and the phone sheet, the dashboard header chip) reads it, so
// they never disagree; components/ShiftTrack.jsx draws it.
//
// `shift` is the status payload's `todayShift` (GET /timeclock/status, from
// backend shift_expect.py - a published placement, else the usual-hours
// preset). No shift = null = no track: never a made-up 8-hour bar.
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
//     worked this shift, end ahead    'stopped'  gray, paused where it stopped
//     not clocked in yet              'upcoming' / 'started'  gray
//     not clocked in, end passed      null - nothing to show

// Server timestamps in the time clock are UTC, sometimes without a zone marker.
const utc = (s) => new Date(/Z|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`);
const MIN = 60000;
// A clock-in this long before the expected start still belongs to the shift.
const EARLY_WINDOW_MS = 6 * 60 * MIN;

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
 * The track for one moment. `state` is the clock's ('in' | 'break' | 'out' |
 * 'exempt' | 'unknown'); `workedMin` today's worked minutes (for "Shift
 * complete - 8h 28m worked"); `worked` whether this shift was clocked into.
 * Returns null (draw nothing) or
 *   { kind, state: 'live'|'done'|'idle', value 0..1, marker, start, end,
 *     leftMin, overMin, workedMin }
 */
export function shiftTrack({ shift, state, now = new Date(), workedMin = 0, worked = false, stale = false }) {
  if (stale || !['in', 'break', 'out'].includes(state)) return null;
  const span = shiftSpan(shift);
  if (!span) return null;
  const t = now.getTime(), s = span.start.getTime(), e = span.end.getTime();
  // Rounded so a surface that publishes on change (the sidebar's store)
  // moves every half minute or so on a full shift, not on every tick.
  const pos = Math.round(Math.min(1, Math.max(0, (t - s) / (e - s))) * 1000) / 1000;
  const leftMin = Math.max(0, Math.ceil((e - t) / MIN));
  const overMin = Math.max(0, Math.floor((t - e) / MIN));
  const base = { start: span.start, end: span.end, leftMin, overMin, workedMin: Math.max(0, workedMin || 0) };
  if (state === 'in' || state === 'break') {
    const onBreak = state === 'break';
    if (t < s) return { ...base, kind: onBreak ? 'break' : 'early', state: 'live', value: 0, marker: true, before: true };
    if (t >= e) return { ...base, kind: onBreak ? 'break' : 'over', state: 'live', value: 1, marker: false, past: true };
    return { ...base, kind: onBreak ? 'break' : 'mid', state: 'live', value: pos, marker: true };
  }
  if (worked) {
    if (t >= e) return { ...base, kind: 'done', state: 'done', value: 1, marker: false };
    return { ...base, kind: 'stopped', state: 'idle', value: pos, marker: false };
  }
  if (t >= e) return null;
  if (t < s) return { ...base, kind: 'upcoming', state: 'idle', value: 0, marker: false };
  return { ...base, kind: 'started', state: 'idle', value: pos, marker: true };
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
    case 'done': return { strong: 'Shift complete', rest: track.workedMin ? ` - ${fmtSpan(track.workedMin)} worked` : '' };
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
