// The Calendar widget's day lists (11/17/2026), shared by the web's month +
// agenda and the phone's Outlook-style list (PhoneAgenda.jsx).
//
// Event times arrive in the caller's own zone, as wall-clock strings
// ("2026-11-18T10:30:00.0000000" - Graph's `Prefer: outlook.timezone`), so
// they are read as local times and never moved.

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// "2026-11-18T10:30:00.0000000" -> a local Date (null when unreadable).
export const localTime = (s) => {
  if (!s) return null;
  const d = new Date(String(s).slice(0, 19));
  return Number.isNaN(d.getTime()) ? null : d;
};
const nextKey = (key) => { const d = new Date(`${key}T00:00:00`); d.setDate(d.getDate() + 1); return dayKey(d); };

// Events by the days they fall on. An all-day event is on EVERY day it
// covers - a three-day trip shows on all three, not only the first (its end
// is the day after its last, Outlook's exclusive end). A timed event is on
// the day it starts.
export function eventsByDay(events = []) {
  const by = {};
  const add = (key, ev) => { (by[key] ||= []).push(ev); };
  for (const ev of events) {
    const start = (ev.start || '').slice(0, 10);
    if (!start) continue;
    if (!ev.isAllDay) { add(start, ev); continue; }
    const end = (ev.end || '').slice(0, 10);
    let key = start;
    // At most a quarter year of days - a runaway end never loops for long.
    for (let n = 0; n < 92; n++) {
      add(key, ev);
      key = nextKey(key);
      if (!end || key >= end) break;
    }
  }
  return by;
}

// All-day first, then by start time.
export const byStart = (a, b) => (Number(!!b.isAllDay) - Number(!!a.isAllDay)) || (a.start || '').localeCompare(b.start || '');

// What is still ahead today: an all-day item stays all day, a timed event
// leaves once it has ended.
export function stillAhead(list = [], nowMs = Date.now()) {
  return list.filter((ev) => {
    if (ev.isAllDay) return true;
    const end = localTime(ev.end) || localTime(ev.start);
    return !end || end.getTime() > nowMs;
  });
}

// "30 min", "1 hr", "1 hr 30 min", "2 hr" - how long it runs (Outlook's words).
export function durationText(start, end) {
  const a = localTime(start), b = localTime(end);
  if (!a || !b) return '';
  const min = Math.round((b - a) / 60000);
  if (min <= 0) return '';
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

// A Teams meeting you can join now: from ten minutes before it starts until
// it ends.
export const JOIN_EARLY_MS = 10 * 60 * 1000;
export function joinableNow(ev, nowMs = Date.now()) {
  if (!ev?.joinUrl || ev.isAllDay) return false;
  const a = localTime(ev.start), b = localTime(ev.end);
  if (!a) return false;
  return nowMs >= a.getTime() - JOIN_EARLY_MS && nowMs < (b ? b.getTime() : a.getTime() + 3600000);
}
