// World Clock zones shown in the Dashboard greeting (DeskHome.jsx). Started as
// two hardcoded spans (California/India); Neil asked for it to be a pickable
// option in My Profile. A first pass offered a curated 15-city checklist -
// Pranshu, Sep 1: "why such long list, make it a drop down and all over world
// time zone" - which briefly pulled in the browser's ENTIRE IANA tz database
// (~400 zones: Intl.supportedValuesOf('timeZone')). That went too far the
// other way (Pranshu, Sep 4, looking at "Marshall Islands Time - Majuro" /
// "Wallis & Futuna Time - Wallis" in the list: "we should only get all the
// world standard time zone") - most of those 400 are tiny stations that
// duplicate a handful of UTC offsets, not zones anyone recognizes or is
// choosing between. ALL_ZONES is now a curated one-representative-per-
// standard-offset list instead - the same ~35 zones Outlook/Google
// Calendar/Slack's own time zone pickers offer, ordered west to east by UTC
// offset (a half-hour/45-minute offset sorts after the whole-hour one it
// shares a leading digit with).
//
// Same singleton + localStorage + event pattern as lib/displayTz.js's
// timecard zone switcher - a module cache keeps DeskGreeting reactive to a
// change made in My Profile without threading a prop through App.jsx.
import { useState, useEffect } from 'react';

// The short keys from the very first curated list, mapped to their real IANA
// zone - so anyone who already picked from that list keeps their selection
// once storage switches to raw tz identifiers.
const LEGACY_KEY_TZ = {
  pacific: 'America/Los_Angeles', mountain: 'America/Denver', central: 'America/Chicago',
  eastern: 'America/New_York', saopaulo: 'America/Sao_Paulo', london: 'Europe/London',
  paris: 'Europe/Paris', dubai: 'Asia/Dubai', india: 'Asia/Kolkata', singapore: 'Asia/Singapore',
  hongkong: 'Asia/Hong_Kong', shanghai: 'Asia/Shanghai', tokyo: 'Asia/Tokyo', sydney: 'Australia/Sydney',
  auckland: 'Pacific/Auckland',
};

// Normalizes (and validates) a tz string to the exact spelling THIS engine's
// own Intl data uses - not just any valid IANA name. Needed because an
// engine's Intl implementation can canonicalize a zone to a different alias
// than the one written in source (this build's ICU data turns "Asia/Kolkata"
// into "Asia/Calcutta", "Asia/Kathmandu" into "Asia/Katmandu", etc. - same
// zone, different string). A raw validity check would keep the un-canonical
// spelling and silently mismatch every <option value> built from it, so a
// stored selection like India (GMT+5:30) showed live in the Dashboard
// greeting (zoneLabel only needs a valid tz, which either spelling is) but
// showed "None" in the picker's own <select> (whose <option value> couldn't
// match the differently-spelled stored value) - Pranshu, Sep 4. Returns null
// for a string that isn't a real zone at all.
function canonicalTz(tz) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone; }
  catch { return null; }
}

// Curated one-representative-per-standard-offset list; RAW spellings here are
// just the readable/preferred IANA names for editing this file - every one
// is run through canonicalTz below before becoming ALL_ZONES, so the actual
// values used for <option>s (and everywhere else) always match whatever this
// engine's Intl will canonicalize a stored selection to. That's what closes
// the Kolkata/Calcutta-style mismatch above for good, regardless of which
// spelling happens to be written here.
const RAW_ZONES = [
  'Pacific/Midway',        // UTC-11  Samoa
  'Pacific/Honolulu',      // UTC-10  Hawaii
  'America/Anchorage',     // UTC-9   Alaska
  'America/Los_Angeles',   // UTC-8   Pacific
  'America/Denver',        // UTC-7   Mountain
  'America/Chicago',       // UTC-6   Central
  'America/New_York',      // UTC-5   Eastern
  'America/Halifax',       // UTC-4   Atlantic
  'America/Sao_Paulo',     // UTC-3   Brasilia
  'Atlantic/Azores',       // UTC-1
  'UTC',                   // UTC+0
  'Europe/London',         // UTC+0 / +1 GMT / BST
  'Europe/Paris',          // UTC+1   Central European
  'Europe/Athens',         // UTC+2   Eastern European
  'Africa/Cairo',          // UTC+2
  'Europe/Moscow',         // UTC+3
  'Asia/Tehran',           // UTC+3:30
  'Asia/Dubai',            // UTC+4
  'Asia/Kabul',            // UTC+4:30
  'Asia/Karachi',          // UTC+5
  'Asia/Kolkata',          // UTC+5:30  India
  'Asia/Kathmandu',        // UTC+5:45
  'Asia/Dhaka',            // UTC+6
  'Asia/Yangon',           // UTC+6:30
  'Asia/Bangkok',          // UTC+7
  'Asia/Shanghai',         // UTC+8
  'Asia/Singapore',        // UTC+8
  'Asia/Tokyo',            // UTC+9
  'Asia/Seoul',            // UTC+9
  'Australia/Adelaide',    // UTC+9:30
  'Australia/Sydney',      // UTC+10
  'Pacific/Guadalcanal',   // UTC+11
  'Pacific/Auckland',      // UTC+12
  'Pacific/Tongatapu',     // UTC+13
  'Pacific/Kiritimati',    // UTC+14
];
export const ALL_ZONES = (() => {
  const seen = new Set();
  const out = [];
  for (const tz of RAW_ZONES) {
    const canon = canonicalTz(tz) || tz;
    if (seen.has(canon)) continue;   // two raw spellings canonicalizing to the same zone
    seen.add(canon);
    out.push(canon);
  }
  return out;
})();

function cityOf(tz) {
  const parts = tz.split('/');
  return parts[parts.length - 1].replace(/_/g, ' ');
}

// Country for each curated zone (Pranshu, Sep 5 - supersedes the offset-only
// chip from Sep 4). IANA tz ids carry no country field to read this from
// (they're just a city keyed to a DST history), and several ALL_ZONES entries
// share one country (the four US zones), so this has to be a hand-maintained
// table - add a line here whenever a zone is added to RAW_ZONES above.
// Keyed by the RAW spelling for readability, then run through canonicalTz
// below into TZ_COUNTRY_CANON - same reason ALL_ZONES does this (this
// engine's ICU renames e.g. "Asia/Kolkata" to "Asia/Calcutta"), so a raw-keyed
// lookup missed every zone whose canonical spelling differs from the one
// written here and silently fell back to the bare city name, no country at
// all (confirmed live: "Calcutta" with no "India -", Sep 5).
const TZ_COUNTRY_RAW = {
  'Pacific/Midway': 'United States', 'Pacific/Honolulu': 'United States',
  'America/Anchorage': 'United States', 'America/Los_Angeles': 'United States',
  'America/Denver': 'United States', 'America/Chicago': 'United States',
  'America/New_York': 'United States', 'America/Halifax': 'Canada',
  'America/Sao_Paulo': 'Brazil', 'Atlantic/Azores': 'Portugal', 'UTC': 'UTC',
  'Europe/London': 'United Kingdom', 'Europe/Paris': 'France',
  'Europe/Athens': 'Greece', 'Africa/Cairo': 'Egypt', 'Europe/Moscow': 'Russia',
  'Asia/Tehran': 'Iran', 'Asia/Dubai': 'United Arab Emirates', 'Asia/Kabul': 'Afghanistan',
  'Asia/Karachi': 'Pakistan', 'Asia/Kolkata': 'India', 'Asia/Kathmandu': 'Nepal',
  'Asia/Dhaka': 'Bangladesh', 'Asia/Yangon': 'Myanmar', 'Asia/Bangkok': 'Thailand',
  'Asia/Shanghai': 'China', 'Asia/Singapore': 'Singapore', 'Asia/Tokyo': 'Japan',
  'Asia/Seoul': 'South Korea', 'Australia/Adelaide': 'Australia', 'Australia/Sydney': 'Australia',
  'Pacific/Guadalcanal': 'Solomon Islands', 'Pacific/Auckland': 'New Zealand',
  'Pacific/Tongatapu': 'Tonga', 'Pacific/Kiritimati': 'Kiribati',
};
const TZ_COUNTRY = (() => {
  const out = {};
  for (const [raw, country] of Object.entries(TZ_COUNTRY_RAW)) {
    out[canonicalTz(raw) || raw] = country;
  }
  return out;
})();

// "Country - City" - for the Dashboard greeting's inline chip. City stays on
// as the disambiguator for the four US zones (all "United States" alone would
// be indistinguishable); country is looked up by TZ_COUNTRY rather than
// derived from the tz string.
export function zoneLabel(tz) {
  const country = TZ_COUNTRY[tz];
  const city = cityOf(tz);
  if (!country) return city;             // zone not in the curated table
  if (country === city || country === 'UTC') return country;
  return `${country} - ${city}`;
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
