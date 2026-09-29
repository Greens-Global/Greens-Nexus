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
//
// A desktop's Wi-Fi fix often takes longer than the short out budget, so a
// clock-out that shared its location at clock-in still read "Out: location
// off" (Amy, Sep 29). While someone is clocked in the floating timer keeps a
// recent fix warm (keepPositionWarm), and a short-budget punch whose fresh fix
// does not arrive in time uses that one if it is recent enough.
export const PUNCH_GEO_MS = { in: 9000, other: 2500 };
const FALLBACK_MAX_AGE_MS = 15 * 60 * 1000;   // a fix older than this is not "where they are"
const STORE_KEY = 'nexus:last-geo-fix';

let lastFix = null;   // { pos, at }

function remember(pos) {
  lastFix = { pos, at: Date.now() };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(lastFix)); } catch { /* storage blocked */ }
}

function recentFix(maxAgeMs) {
  let fix = lastFix;
  if (!fix) {
    try { fix = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { fix = null; }
  }
  return fix && fix.pos && Date.now() - fix.at <= maxAgeMs ? fix.pos : null;
}

export const getPosition = (maxMs = PUNCH_GEO_MS.in, { fallbackMaxAgeMs = 0 } = {}) => new Promise((resolve) => {
  if (typeof navigator === 'undefined' || !navigator.geolocation) { resolve(null); return; }
  const miss = () => resolve(fallbackMaxAgeMs ? recentFix(fallbackMaxAgeMs) : null);
  const done = (v) => { clearTimeout(timer); if (v) { remember(v); resolve(v); } else miss(); };
  const timer = setTimeout(miss, maxMs);
  navigator.geolocation.getCurrentPosition(
    (pos) => done({ lat: String(pos.coords.latitude), lng: String(pos.coords.longitude),
                    accuracy_m: Math.round(pos.coords.accuracy || 0) }),
    () => done(null),
    { enableHighAccuracy: true, timeout: Math.max(1000, maxMs - 1000), maximumAge: 30000 },
  );
});

/** The position for a punch of this kind. Short-budget punches (out, breaks)
 *  fall back to a fix from the last 15 minutes. */
export const punchPosition = (kind) => (kind === 'in'
  ? getPosition(PUNCH_GEO_MS.in)
  : getPosition(PUNCH_GEO_MS.other, { fallbackMaxAgeMs: FALLBACK_MAX_AGE_MS }));

/** While clocked in: refresh the remembered fix every few minutes, only when
 *  location is ALREADY allowed (never raises a permission prompt) and the tab
 *  is visible. Returns a stop function. */
export function keepPositionWarm(everyMs = 5 * 60 * 1000) {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return () => {};
  let stopped = false;
  const refresh = async () => {
    if (stopped || document.visibilityState !== 'visible') return;
    try {
      const st = await navigator.permissions?.query({ name: 'geolocation' });
      if (st && st.state !== 'granted') return;
    } catch { return; }   // no Permissions API: don't risk a prompt
    getPosition(20000);
  };
  refresh();
  const id = setInterval(refresh, everyMs);
  return () => { stopped = true; clearInterval(id); };
}
