// Location on a punch (Visesh, Oct 20 2026 - replaces the one-day "Require
// Location to Punch" switch).
//
// A punch is NEVER refused for want of a location. But the person is always
// asked to share it: when the punch has no fix, Nexus asks them to turn
// location on, with Try Again and Punch Without Location. A punch that goes
// without one records and the Time Sheet says why:
//   - "Location Off": the browser has location blocked for Nexus;
//   - "No Location": no fix (timed out, no GPS, the person skipped it).
// Every punch surface (Time Clock page, the floating timer, the Punch tile)
// runs through askPunchPosition so they all behave the same.
import { getPosition } from './geoPosition';
import { dialog } from '../ui/dialog';

// The retry budget after a first attempt came back empty - long enough for a
// desktop's Wi-Fi fix or a phone's GPS to settle.
export const LOCATION_RETRY_MS = 20000;

/** The browser's geolocation permission: 'granted' | 'denied' | 'prompt' | ''
 *  ('' = no Permissions API, unknown). Never raises a prompt. */
export async function locationPermission() {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return '';
    const st = await navigator.permissions.query({ name: 'geolocation' });
    return st?.state || '';
  } catch { return ''; }
}

/** The ask, worded for whether the browser has location blocked or just
 *  never answered in time. */
export function locationHelpText(permission = '') {
  const unsupported = typeof navigator !== 'undefined' && !navigator.geolocation;
  if (unsupported) {
    return 'This browser cannot share a location. You can still punch - it will show No Location on your Time Sheet.';
  }
  const lead = permission === 'denied'
    ? 'Location is turned off for Nexus in this browser. Please share your location so your punch shows where you were.'
    : 'Nexus could not get your location. Please share your location so your punch shows where you were.';
  const steps = permission === 'denied'
    ? [
      '1. Click the lock or site settings icon at the left of the address bar.',
      '2. Set Location to Allow.',
      '3. Click Try Again.',
    ]
    : [
      '1. If your browser asks to use your location, click Allow.',
      '2. Make sure Location Services are on for this browser in your device settings. Indoors, moving near a window can help.',
      '3. Click Try Again.',
    ];
  return [
    lead, '', ...steps, '',
    `You can also punch without it - it will show ${permission === 'denied' ? 'Location Off' : 'No Location'} on your Time Sheet.`,
  ].join('\n');
}

/**
 * The position a punch sends. `first` is a position or the promise of one
 * (the surface's usual quick attempt). With no fix the person is asked to
 * share their location: Try Again tries once more with a longer timeout (and
 * asks again if that misses too); Punch Without Location goes ahead.
 * Resolves { pos, locationOff } - pos null = punch without a location;
 * locationOff = the browser has location blocked (shown as "Location Off").
 * Never blocks the punch.
 */
export async function askPunchPosition(first) {
  let pos = await first;
  while (!pos) {
    const permission = await locationPermission();
    const unsupported = typeof navigator !== 'undefined' && !navigator.geolocation;
    const again = !unsupported && await dialog.confirm(locationHelpText(permission), {
      title: 'Share Your Location', confirmText: 'Try Again', cancelText: 'Punch Without Location',
    });
    if (!again) return { pos: null, locationOff: permission === 'denied' };
    pos = await getPosition(LOCATION_RETRY_MS);
  }
  return { pos, locationOff: false };
}
