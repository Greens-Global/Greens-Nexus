// Timecard display timezone (California / India), with a top-right switcher.
//
// Punch times are stored UTC; the manager tallies Nexus against SwipeClock, whose
// site clock is California (Pacific). So the timecard DEFAULTS to California -
// India-based staff punches then read in Pacific, lining up 1:1 with SwipeClock -
// and a switcher flips the whole card to India (IST) local time when wanted.
//
// The choice is a single app-wide, localStorage-backed setting. A module cache
// (`_current`) lets the plain formatters (t12/t12s) stay tz-aware without
// threading a prop through every cell; components call useDisplayTz() so they
// re-render - and re-run those formatters - the moment the switch changes.
import { useState, useEffect } from 'react';

export const TZ_OPTIONS = [
  { key: 'california', label: 'California', tz: 'America/Los_Angeles', abbr: 'PT' },
  { key: 'india',      label: 'India',      tz: 'Asia/Kolkata',        abbr: 'IST' },
];
const STORAGE_KEY = 'nexus:timecardTz';
const EVENT = 'nexus:timecard-tz';

function readStored() {
  let v = '';
  try { v = localStorage.getItem(STORAGE_KEY) || ''; } catch { /* SSR / blocked */ }
  return TZ_OPTIONS.find((o) => o.key === v) || TZ_OPTIONS[0];   // default California
}

let _current = readStored();

export function currentTzOption() { return _current; }

export function setDisplayTz(key) {
  const next = TZ_OPTIONS.find((o) => o.key === key) || TZ_OPTIONS[0];
  if (next.key === _current.key) return;
  _current = next;
  try { localStorage.setItem(STORAGE_KEY, next.key); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** 'india' when this browser runs on India time, else 'california'. */
export function browserTzKey() {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    return /Kolkata|Calcutta/.test(z) ? 'india' : 'california';
  } catch { return 'california'; }
}

/** An employee's OWN timesheet reads in their own zone (Pranshu, Oct 13):
 *  India-based staff saw California times, so "5 PM yesterday" typed from
 *  India just after midnight was still in the future in California and the
 *  request was refused. While `on`, the card uses the browser's zone without
 *  touching the saved choice; leaving puts the saved choice back.
 *  `zoneKey` (Neil, Oct 18 2026): the EMPLOYEE's zone from the server, which
 *  wins over the browser - a California employee's card viewed from India
 *  (acting as them) showed AM punches. The browser is the fallback only. */
export function useOwnZone(on, zoneKey = '') {
  useEffect(() => {
    if (!on) return undefined;
    const own = TZ_OPTIONS.find((o) => o.key === (zoneKey || browserTzKey())) || TZ_OPTIONS[0];
    if (own.key !== _current.key) {
      _current = own;
      window.dispatchEvent(new CustomEvent(EVENT));
    }
    return () => {
      const saved = readStored();
      if (saved.key !== _current.key) {
        _current = saved;
        window.dispatchEvent(new CustomEvent(EVENT));
      }
    };
  }, [on, zoneKey]);
}

/** Subscribe a component to the current display timezone; re-renders on change. */
export function useDisplayTz() {
  const [opt, setOpt] = useState(_current);
  useEffect(() => {
    const on = () => setOpt(_current);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return opt;
}

/** h:mm[:ss] am/pm for a stored UTC punch (no 'Z' suffix), in the current zone. */
export function formatTimeTz(iso, { seconds = false } = {}) {
  if (!iso) return '';
  // Stored punch times are naive UTC; one that already carries a zone
  // ("...+00:00" / "...Z") must not get a second one ("Invalid Date").
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(iso);
  return new Date(zoned ? iso : iso + 'Z').toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}),
    hour12: true, timeZone: _current.tz,
  }).replace(' ', '').toLowerCase();
}

// ── Punch edit conversions (verified round-trip incl. DST, see tz_sim) ─────────
// The edit inputs (<input type="datetime-local">) must speak the SAME zone the
// timecard displays, or a manager edits a punch in a different zone than they
// read it. UTC offset (minutes) of an instant in an IANA zone:
function offsetMin(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}

/** Stored UTC punch -> "YYYY-MM-DDTHH:mm" wall time in the current display zone. */
export function utcToInputTz(iso) {
  if (!iso) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: _current.tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso + 'Z')).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** JS-style UTC offset (minutes, positive west - like getTimezoneOffset) of
 *  the current display zone at a typed wall time. A punch added from the card
 *  must be dated in the zone its time was typed in: sending the BROWSER's
 *  offset with a California time put a 5 PM clock-out on the next day for
 *  anyone browsing from India (Neil's call, Oct 13). */
export function tzOffsetForInput(v) {
  const utc = inputToUtcTz(v);
  if (!utc) return new Date().getTimezoneOffset();
  return -offsetMin(new Date(utc + 'Z'), _current.tz);
}

/** Wall time in the current display zone -> stored UTC "YYYY-MM-DDTHH:MM:SS". */
export function inputToUtcTz(v) {
  if (!v) return '';
  const asIfUtc = new Date((v.length === 16 ? v + ':00' : v) + 'Z');
  let real = new Date(asIfUtc.getTime() - offsetMin(asIfUtc, _current.tz) * 60000);
  real = new Date(asIfUtc.getTime() - offsetMin(real, _current.tz) * 60000);  // DST re-check
  return real.toISOString().slice(0, 19);
}
