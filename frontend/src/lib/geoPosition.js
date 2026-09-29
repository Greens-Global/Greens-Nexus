// One-shot position for a punch, with a hard timeout: never keep the user
// waiting on GPS. `maxMs` caps how long the punch waits on geolocation before
// firing without it. Clock-OUT (and breaks) pass a short budget: a lost punch
// (tab closed during the wait) is the whole "logout not recorded" bug, and the
// punch actually landing matters more than its fix. Clock-IN keeps the full
// budget for an accurate geofence check.
//
// Shared by the Time Clock page and the floating timer. The floating timer
// used to punch with no position at all, so every break and punch-out made
// from it read "Location off" on the timecard (Charmi, Sep 29).
export const PUNCH_GEO_MS = { in: 9000, other: 2500 };

export const getPosition = (maxMs = PUNCH_GEO_MS.in) => new Promise((resolve) => {
  if (typeof navigator === 'undefined' || !navigator.geolocation) { resolve(null); return; }
  const done = (v) => { clearTimeout(timer); resolve(v); };
  const timer = setTimeout(() => resolve(null), maxMs);
  navigator.geolocation.getCurrentPosition(
    (pos) => done({ lat: String(pos.coords.latitude), lng: String(pos.coords.longitude),
                    accuracy_m: Math.round(pos.coords.accuracy || 0) }),
    () => done(null),
    { enableHighAccuracy: true, timeout: Math.max(1000, maxMs - 1000), maximumAge: 30000 },
  );
});

/** The position budget for a punch of this kind. */
export const punchPosition = (kind) => getPosition(kind === 'in' ? PUNCH_GEO_MS.in : PUNCH_GEO_MS.other);
