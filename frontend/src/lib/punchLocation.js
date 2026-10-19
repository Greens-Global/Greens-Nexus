// Require Location to Punch (Neil's checklist, Oct 19 2026).
//
// A per-company switch (Global Settings > Shifts, `requireLocationToPunch`,
// off by default). When it is on, /timeclock/status says `locationRequired`
// and the server refuses a punch with no coordinates (400, code
// `location_required`). Every punch surface (Time Clock page, the floating
// timer, the Punch tile) runs through these helpers so none of them sends a
// location-less punch silently: a missed fix is retried once with a longer
// timeout, and if there is still none the person gets a blocking message that
// says how to turn location on.
import { getPosition } from './geoPosition';
import { dialog } from '../ui/dialog';

// The retry budget after a first attempt came back empty - long enough for a
// desktop's Wi-Fi fix or a phone's GPS to settle.
export const LOCATION_RETRY_MS = 20000;

export const LOCATION_NEXT_STEP = 'Turn on location for this site in your browser, then try again.';
export const LOCATION_SHORT = 'Location is required to punch.';

/** The browser's geolocation permission: 'granted' | 'denied' | 'prompt' | ''
 *  ('' = no Permissions API, unknown). Never raises a prompt. */
export async function locationPermission() {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return '';
    const st = await navigator.permissions.query({ name: 'geolocation' });
    return st?.state || '';
  } catch { return ''; }
}

/** Whether this punch must carry a location. Clock-out never does (Visesh,
 *  Oct 19): it always goes through and reads "No Location" on the Time Sheet. */
export const needsLocation = (status, kind) => !!status?.locationRequired && kind !== 'out';

/** True when the server refused a punch for want of a location. */
export const isLocationRequiredError = (e) => e?.detail?.code === 'location_required';

/** The how-to-enable steps, worded for whether the browser said no or just
 *  never answered in time. */
export function locationHelpText(permission = '') {
  const unsupported = typeof navigator !== 'undefined' && !navigator.geolocation;
  const lead = unsupported
    ? 'This browser cannot share a location, and your company requires one for every punch.'
    : permission === 'denied'
      ? 'Your browser is blocking location for Nexus, and your company requires a location for every punch.'
      : 'Nexus could not get your location in time, and your company requires a location for every punch.';
  return [
    lead,
    '',
    LOCATION_NEXT_STEP,
    '',
    '1. Click the lock or site settings icon at the left of the address bar.',
    '2. Set Location to Allow.',
    '3. Reload the page, then punch again.',
    '',
    'On a phone or laptop, also make sure Location Services are on for this browser in the device settings. Indoors, moving near a window can help.',
  ].join('\n');
}

/** The blocking message. Resolves once dismissed. */
export async function showLocationRequired(permission) {
  const state = permission ?? await locationPermission();
  return dialog.alert(locationHelpText(state), { title: 'Location Required', confirmText: 'OK' });
}

/**
 * The position a punch sends when its company requires one: `first` (a
 * position or the promise of one, from the surface's usual quick attempt),
 * else one more try with a longer timeout. null = still none - block.
 */
export async function requiredPunchPosition(first) {
  const pos = await first;
  if (pos) return pos;
  return getPosition(LOCATION_RETRY_MS);
}
