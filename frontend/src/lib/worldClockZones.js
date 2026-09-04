// World Clock zones shown in the Dashboard greeting (DeskHome.jsx). Started as
// two hardcoded spans (California/India); Neil asked for it to be a pickable
// option in My Profile. A first pass offered a curated 15-city checklist -
// Pranshu, Sep 1: "why such long list, make it a drop down and all over world
// time zone" - so this pulls the browser's own IANA tz database (every zone
// it knows, ~400) into three grouped-by-continent <select> dropdowns instead
// of a scrolling list of checkboxes.
//
// Same singleton + localStorage + event pattern as lib/displayTz.js's
// timecard zone switcher - a module cache keeps DeskGreeting reactive to a
// change made in My Profile without threading a prop through App.jsx.
import { useState, useEffect } from 'react';

// The short keys from the original curated list, mapped to their real IANA
// zone - so anyone who already picked from that list keeps their selection
// once storage switches to raw tz identifiers.
const LEGACY_KEY_TZ = {
  pacific: 'America/Los_Angeles', mountain: 'America/Denver', central: 'America/Chicago',
  eastern: 'America/New_York', saopaulo: 'America/Sao_Paulo', london: 'Europe/London',
  paris: 'Europe/Paris', dubai: 'Asia/Dubai', india: 'Asia/Kolkata', singapore: 'Asia/Singapore',
  hongkong: 'Asia/Hong_Kong', shanghai: 'Asia/Shanghai', tokyo: 'Asia/Tokyo', sydney: 'Australia/Sydney',
  auckland: 'Pacific/Auckland',
};

// Intl.supportedValuesOf ships in every browser Nexus targets (Chrome/Edge
// 99+, Firefox 93+, Safari 15.4+). The tiny legacy list is the fallback for
// the rare browser without it, so the picker never renders empty.
export const ALL_ZONES = (() => {
  try {
    const list = Intl.supportedValuesOf('timeZone');
    if (list?.length) return list;
  } catch { /* unsupported */ }
  return Object.values(LEGACY_KEY_TZ);
})();

// Normalizes (and validates) a tz string to the exact spelling THIS engine's
// own Intl data uses - not just any valid IANA name. Needed because a
// browser's supportedValuesOf() can use a different alias for the same zone
// than the LEGACY_KEY_TZ map does (this Chrome build's list has
// "Asia/Calcutta" where the legacy map points at "Asia/Kolkata" - same zone,
// different string). A raw validity check would keep "Asia/Kolkata" and
// silently mismatch every <option value="Asia/Calcutta"> in the dropdown,
// so the picker showed "None" for a genuinely selected zone. Returns null
// for a string that isn't a real zone at all.
function canonicalTz(tz) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone; }
  catch { return null; }
}

function cityOf(tz) {
  const parts = tz.split('/');
  return parts[parts.length - 1].replace(/_/g, ' ');
}

// Compact "City (Continent)" - stays short for the Dashboard greeting's
// inline chip, which has no room to wrap or truncate (dk-zones is a plain
// flex row alongside the session chip).
export function zoneLabel(tz) {
  const parts = tz.split('/');
  const city = cityOf(tz);
  return parts.length > 1 ? `${city} (${parts.slice(0, -1).join('/').replace(/_/g, ' ')})` : city;
}

// Full "(offset) Time Zone Name — City" for the picker itself (Pranshu,
// Sep 4: "i want a time zone option to be as a option not a county or
// state") - "City (Continent)" reads as a place, not a time zone. IANA zone
// ids are necessarily city-keyed (that's how the tz database tracks each
// region's own DST history), so the city can't be dropped entirely - it's
// kept as a small trailing disambiguator, since several IANA zones can
// share an identical offset + name at any given moment (they differ by
// historical DST rules) and would otherwise be indistinguishable in the
// list. Same convention most OS time zone pickers use
// ("(UTC-08:00) Pacific Time").
export function zoneOptionLabel(tz) {
  const now = new Date();
  const namePart = (type) => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: type })
        .formatToParts(now).find((p) => p.type === 'timeZoneName')?.value || '';
    } catch { return ''; }
  };
  const offset = namePart('shortOffset') || namePart('short');
  const name = namePart('long');
  if (!offset && !name) return zoneLabel(tz);   // Intl unsupported for this zone - last resort
  return `${offset ? `(${offset}) ` : ''}${name || cityOf(tz)} — ${cityOf(tz)}`;
}

// Grouped by continent/region (the tz's first path segment) for <optgroup> -
// reads as a real world clock picker instead of one flat alphabetical dump.
export const ZONE_GROUPS = (() => {
  const map = {};
  for (const tz of ALL_ZONES) (map[tz.split('/')[0]] ||= []).push(tz);
  return map;
})();

export const MAX_ZONES = 3;
const STORAGE_KEY = 'nexus:worldClockZones';
const EVENT = 'nexus:world-clock-zones';
const DEFAULT_TZS = ['America/Los_Angeles', 'Asia/Kolkata']; // matches the greeting's old hardcoded pair

function readStored() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(raw)) {
      const valid = raw.map((v) => canonicalTz(LEGACY_KEY_TZ[v] || v))
        .filter(Boolean).slice(0, MAX_ZONES);
      if (valid.length) return valid;
    }
  } catch { /* SSR / private mode */ }
  return DEFAULT_TZS.map(canonicalTz).filter(Boolean);
}

let _current = readStored();

export function currentZones() { return _current; }

export function setZones(tzs) {
  const next = tzs.map((tz) => tz && canonicalTz(tz)).filter(Boolean).slice(0, MAX_ZONES);
  _current = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_current)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Subscribe to the current world-clock zone selection; re-renders on change. */
export function useWorldClockZones() {
  const [zones, setZonesState] = useState(_current);
  useEffect(() => {
    const on = () => setZonesState(_current);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return zones.map((tz) => ({ tz, label: zoneLabel(tz) }));
}
