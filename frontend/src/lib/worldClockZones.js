// World Clock zones shown in the Dashboard greeting (DeskHome.jsx). Used to be
// two hardcoded spans (California/India); Neil asked for it to be a pickable
// option in My Profile, with Texas added as a choice, and to allow up to 3
// zones shown at once.
//
// Same singleton + localStorage + event pattern as lib/displayTz.js's
// timecard zone switcher - a module cache keeps DeskGreeting reactive to a
// change made in My Profile without threading a prop through App.jsx.
import { useState, useEffect } from 'react';

export const ZONE_OPTIONS = [
  { key: 'pacific',  label: 'California', tz: 'America/Los_Angeles' },
  { key: 'mountain', label: 'Mountain',    tz: 'America/Denver' },
  { key: 'central',  label: 'Texas',       tz: 'America/Chicago' },
  { key: 'eastern',  label: 'Eastern',     tz: 'America/New_York' },
  { key: 'india',    label: 'India',       tz: 'Asia/Kolkata' },
];

export const MAX_ZONES = 3;
const STORAGE_KEY = 'nexus:worldClockZones';
const EVENT = 'nexus:world-clock-zones';
const DEFAULT_KEYS = ['pacific', 'india']; // matches the greeting's old hardcoded pair

function readStored() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(raw)) {
      const valid = raw.filter((k) => ZONE_OPTIONS.some((o) => o.key === k)).slice(0, MAX_ZONES);
      if (valid.length) return valid;
    }
  } catch { /* SSR / private mode */ }
  return DEFAULT_KEYS;
}

let _current = readStored();

export function currentZoneKeys() { return _current; }

export function setZoneKeys(keys) {
  const next = keys.filter((k) => ZONE_OPTIONS.some((o) => o.key === k)).slice(0, MAX_ZONES);
  _current = next.length ? next : DEFAULT_KEYS;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_current)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Subscribe to the current world-clock zone selection; re-renders on change. */
export function useWorldClockZones() {
  const [keys, setKeys] = useState(_current);
  useEffect(() => {
    const on = () => setKeys(_current);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return keys.map((k) => ZONE_OPTIONS.find((o) => o.key === k)).filter(Boolean);
}
