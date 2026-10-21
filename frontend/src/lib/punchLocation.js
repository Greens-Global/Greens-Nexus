// Location on a punch (Visesh, Oct 20 2026; Neil, Oct 21 2026).
//
// A punch is NEVER held up for a location: whatever the quick attempt finds
// is what the punch sends. A clock-in that lands with none raises the red
// Needs Attention bar (components/LocationNoticeBar.jsx) with Turn On and
// Skip - Turn On asks for the location and puts it on that punch, Skip tells
// the manager. A punch without one records and the Time Sheet says why:
//   - "Location Off": the browser has location blocked for Nexus, or the
//     person chose Skip;
//   - "No Location": no fix (timed out, no GPS).
// Every punch surface (Time Clock page, the floating timer, the Punch tile)
// runs through askPunchPosition so they all behave the same.
import { getPosition } from './geoPosition';
import { dialog } from '../ui/dialog';

// The budget for Turn On - long enough for a desktop's Wi-Fi fix or a
// phone's GPS to settle.
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

/** The steps for turning location on, worded for whether the browser has it
 *  blocked or just never answered in time. */
export function locationHelpText(permission = '') {
  const lead = permission === 'denied'
    ? 'Location is turned off for Nexus in this browser.'
    : 'Nexus could not get your location.';
  const steps = permission === 'denied'
    ? [
      '1. Click the lock or site settings icon at the left of the address bar (on a phone, open the site settings for Nexus in your browser).',
      '2. Set Location to Allow.',
      '3. Click Try Again.',
    ]
    : [
      '1. If your browser asks to use your location, click Allow.',
      '2. Make sure Location Services are on for this browser in your device settings. Indoors, moving near a window can help.',
      '3. Click Try Again.',
    ];
  return [lead, '', ...steps].join('\n');
}

/**
 * The position a punch sends. `first` is a position or the promise of one
 * (the surface's usual quick attempt). Never asks and never waits longer.
 * Resolves { pos, locationOff } - pos null = punch without a location;
 * locationOff = the browser has location blocked (shown as "Location Off").
 */
export async function askPunchPosition(first) {
  const pos = await first;
  if (pos) return { pos, locationOff: false };
  return { pos: null, locationOff: (await locationPermission()) === 'denied' };
}

/**
 * Turn On on the location bar: ask the browser for the location (its own
 * Allow prompt when it has not been answered yet); when that finds nothing or
 * location is blocked, show the steps to allow it, with Try Again. Resolves
 * the position, or null when the person clicks Not Now.
 */
export async function turnOnLocation() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
  for (;;) {
    if ((await locationPermission()) !== 'denied') {
      const pos = await getPosition(LOCATION_RETRY_MS);
      if (pos) return pos;
    }
    const again = await dialog.confirm(locationHelpText(await locationPermission()), {
      title: 'Turn On Location', confirmText: 'Try Again', cancelText: 'Not Now',
    });
    if (!again) return null;
  }
}
