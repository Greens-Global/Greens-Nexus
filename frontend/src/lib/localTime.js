// Is it a reasonable hour for this person? (11/13/2026)
//
// Greens has people in the United States and India. A person keeps their own
// time zone and working hours on their People record (My Profile > Date &
// Time; `timeZone`, `workStart`, `workEnd` on the directory rows - the zone
// is the one they set, else the one Nexus works out). This is the ONE rule
// that reads them, for the quiet line under an assignee field and on a
// contact card (components/LocalTimeHint.jsx):
//
//   hours set      outside them is "outside" (an end before the start is a
//                  day that runs past midnight - a night shift)
//   no hours set   9:00 PM to 7:00 AM on their clock is "night"
//   no zone known  nothing is said
//
// Never for yourself, and never for someone inside their hours.
import { formatTimeIn, zoneClock } from './datetime';
import { LOCAL_TZ, tzOffsetMinutes } from './worldClockZones';

export const NIGHT_START_MIN = 21 * 60;   // 9:00 PM
export const NIGHT_END_MIN = 7 * 60;      // 7:00 AM

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "09:30" -> 570; null for anything that is not a time of day. */
export function minutesOf(hhmm) {
  const m = HHMM.exec(String(hhmm || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function validZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { zoneOffset(tz, new Date()); return true; } catch { return false; }
}
function zoneOffset(tz, now) { return tzOffsetMinutes(tz, now); }

/** 'inside' | 'outside' | 'night' | 'day' | null (no zone known).
 *  'outside' needs working hours; 'night' / 'day' are the rule without them. */
export function hoursState(person, now = new Date()) {
  const tz = person?.timeZone;
  if (!validZone(tz)) return null;
  const at = zoneClock(tz, now).minutes;
  const start = minutesOf(person.workStart);
  const end = minutesOf(person.workEnd);
  if (start != null && end != null && start !== end) {
    const inside = start < end ? (at >= start && at < end) : (at >= start || at < end);
    return inside ? 'inside' : 'outside';
  }
  return at >= NIGHT_START_MIN || at < NIGHT_END_MIN ? 'night' : 'day';
}

/** True when the person's clock reads differently from the viewer's right
 *  now - by offset at this instant, not by zone name (Tijuana is on California's clock). */
export function differentClock(tz, now = new Date(), viewerZone = LOCAL_TZ) {
  try { return zoneOffset(tz, now) !== zoneOffset(viewerZone, now); } catch { return false; }
}

export function firstNameOf(person) {
  const first = String(person?.firstName || '').trim() || String(person?.name || '').trim().split(/\s+/)[0];
  return first || 'them';
}

const sameEmail = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

/** The people it is NOT a good hour for: outside their working hours, or -
 *  with none set - at night on a clock that is not the viewer's (the viewer
 *  can see it is night on their own). Never the viewer. */
export function afterHoursPeople(people, { me = '', now = new Date(), viewerZone = LOCAL_TZ } = {}) {
  const seen = new Set();
  return (people || []).filter((p) => {
    const email = String(p?.email || '').toLowerCase();
    if (!p || sameEmail(email, me) || (email && seen.has(email))) return false;
    if (email) seen.add(email);
    const state = hoursState(p, now);
    if (state === 'outside') return true;
    return state === 'night' && differentClock(p.timeZone, now, viewerZone);
  });
}

/** The one line, or '' for nothing:
 *    "It is 9:40 PM for Priya"                          one person, another clock
 *    "It is outside working hours for Priya"            one person, the viewer's clock
 *    "It is after hours for 2 of these people"          several
 *  `brief` drops the clock for a place that shows it already (a contact
 *  card's Local Time row): "Outside working hours" / "After hours". */
export function afterHoursLine(people, { me = '', now = new Date(), viewerZone = LOCAL_TZ, brief = false } = {}) {
  const late = afterHoursPeople(people, { me, now, viewerZone });
  if (!late.length) return '';
  if (late.length > 1) return `It is after hours for ${late.length} of these people`;
  const p = late[0];
  if (brief) return hoursState(p, now) === 'outside' ? 'Outside working hours' : 'After hours';
  if (differentClock(p.timeZone, now, viewerZone)) return `It is ${formatTimeIn(now, p.timeZone)} for ${firstNameOf(p)}`;
  return `It is outside working hours for ${firstNameOf(p)}`;
}
