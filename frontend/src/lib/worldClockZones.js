// World Clock zones shown in the Dashboard greeting (DeskHome.jsx). Used to be
// two hardcoded spans (California/India); Neil asked for it to be a pickable
// option in My Profile, with Texas added as a choice, and to allow up to 3
// zones shown at once. Follow-up (Sep 1): the original 5-option list read as
// US-only - broadened to a real world clock spanning every populated region.
// Existing keys (pacific/mountain/central/eastern/india) are never renamed or
// removed - people already have these saved in localStorage picks.
//
// Same singleton + localStorage + event pattern as lib/displayTz.js's
// timecard zone switcher - a module cache keeps DeskGreeting reactive to a
// change made in My Profile without threading a prop through App.jsx.
import { useState, useEffect } from 'react';

export const ZONE_OPTIONS = [
  { key: 'pacific',    label: 'California',    tz: 'America/Los_Angeles' },
  { key: 'mountain',   label: 'Mountain',       tz: 'America/Denver' },
  { key: 'central',    label: 'Texas',          tz: 'America/Chicago' },
  { key: 'eastern',    label: 'Eastern',        tz: 'America/New_York' },
  { key: 'saopaulo',   label: 'São Paulo',      tz: 'America/Sao_Paulo' },
  { key: 'london',     label: 'London',         tz: 'Europe/London' },
  { key: 'paris',      label: 'Paris',          tz: 'Europe/Paris' },
  { key: 'dubai',      label: 'Dubai',          tz: 'Asia/Dubai' },
  { key: 'india',      label: 'India',          tz: 'Asia/Kolkata' },
  { key: 'singapore',  label: 'Singapore',      tz: 'Asia/Singapore' },
  { key: 'hongkong',   label: 'Hong Kong',      tz: 'Asia/Hong_Kong' },
  { key: 'shanghai',   label: 'Shanghai',       tz: 'Asia/Shanghai' },
  { key: 'tokyo',      label: 'Tokyo',          tz: 'Asia/Tokyo' },
  { key: 'sydney',     label: 'Sydney',         tz: 'Australia/Sydney' },
  { key: 'auckland',   label: 'Auckland',       tz: 'Pacific/Auckland' },
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
