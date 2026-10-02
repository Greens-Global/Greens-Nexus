// Distances in US units (Oct 2 - "we don't want it in km"). Locations, the
// geofence and GPS fixes are all measured in METERS on the server and in the
// database; this is only how they read on screen. One helper so every
// surface - timecard, punch map, locations, the clock - says it the same way.

const M_PER_FT = 0.3048;
const M_PER_MI = 1609.344;

export const metersToFeet = (m) => (Number(m) || 0) / M_PER_FT;
export const feetToMeters = (ft) => (Number(ft) || 0) * M_PER_FT;

// 3800 -> "2.4 mi", 150 -> "492 ft", 25000 -> "16 mi". Under 0.1 mi (about
// 530 ft) reads in feet, where a tenth of a mile is too coarse to be useful.
export function formatDistance(m) {
  const meters = Number(m);
  if (!Number.isFinite(meters) || meters < 0) return '';
  const mi = meters / M_PER_MI;
  if (mi >= 0.1) return `${mi >= 10 ? Math.round(mi).toLocaleString('en-US') : mi.toFixed(1)} mi`;
  return `${Math.round(meters / M_PER_FT).toLocaleString('en-US')} ft`;
}

// A GPS fix's accuracy: "±23 ft", "±1.2 mi".
export const formatAccuracy = (m) => {
  const d = formatDistance(m);
  return d ? `±${d}` : '';
};
