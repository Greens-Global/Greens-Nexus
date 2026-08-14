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
  return new Date(iso + 'Z').toLocaleTimeString('en-US', {
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

/** Wall time in the current display zone -> stored UTC "YYYY-MM-DDTHH:MM:SS". */
export function inputToUtcTz(v) {
  if (!v) return '';
  const asIfUtc = new Date((v.length === 16 ? v + ':00' : v) + 'Z');
  let real = new Date(asIfUtc.getTime() - offsetMin(asIfUtc, _current.tz) * 60000);
  real = new Date(asIfUtc.getTime() - offsetMin(real, _current.tz) * 60000);  // DST re-check
  return real.toISOString().slice(0, 19);
}
