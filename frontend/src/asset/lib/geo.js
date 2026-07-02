// Geocoding + map-link helpers shared by PortfolioMap (portfolio-wide pin map) and
// PropertyMapLink (per-asset embedded map preview).
//
// Geocoding uses Nominatim, OpenStreetMap's free geocoding API. Nominatim's usage policy
// caps unauthenticated callers at ~1 request/second and asks that callers not hammer it —
// see https://operations.osmfoundation.org/policies/nominatim/. That's the reason for the
// cache + the serialized/delayed request queue below. Do NOT remove or shorten the delay,
// and do NOT parallelize geocode() calls, or the app risks getting IP-blocked by Nominatim.

const GEOCODE_CACHE_KEY = 'nexus_geo_v1';
const GEOCODE_REQUEST_DELAY_MS = 1150; // keeps us under Nominatim's ~1 req/sec fair-use limit

function readGeocodeCache() {
  try {
    return JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeGeocodeCacheEntry(query, coord) {
  try {
    const cache = readGeocodeCache();
    // Cache miss/no-result is stored as the literal string 'null' (not JSON null) so that
    // `query in cache` still reliably distinguishes "never looked up" from "looked up, no match".
    cache[query] = coord || 'null';
    localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage full/unavailable — cache write is best-effort only.
  }
}

// Module-level promise chain: every geocode() call tacks itself onto the tail of this chain,
// so requests to Nominatim always run one-at-a-time, each waiting GEOCODE_REQUEST_DELAY_MS
// after the previous one settles before firing. This is what actually enforces the rate
// limit — it's shared across every caller/component instance in the app, not per-component.
let geocodeQueueTail = Promise.resolve();

/**
 * Geocode a free-text address via Nominatim, returning `[lat, lng]` or `null` if no match.
 * Results are cached in localStorage (key: "nexus_geo_v1", `{ [query]: [lat,lng] | 'null' }')
 * forever — repeat lookups for the same query string return instantly from cache and never
 * hit the network. Cache misses are queued and rate-limited (see module comment above).
 */
export function geocode(query) {
  const cache = readGeocodeCache();
  if (query in cache) {
    return Promise.resolve(cache[query] === 'null' ? null : cache[query]);
  }

  const request = geocodeQueueTail
    .then(() => new Promise((resolve) => setTimeout(resolve, GEOCODE_REQUEST_DELAY_MS)))
    .then(() =>
      fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query), {
        headers: { Accept: 'application/json' },
      })
        .then((r) => r.json())
        .then((results) => {
          const coord = results && results[0] ? [+results[0].lat, +results[0].lon] : null;
          writeGeocodeCacheEntry(query, coord);
          return coord;
        })
        .catch(() => null)
    );

  // Chain the *next* request off this one regardless of success/failure, so one failed
  // lookup can't wedge the whole queue.
  geocodeQueueTail = request.catch(() => {});
  return request;
}

/**
 * Pull `[lat, lng]` straight out of a pasted Google Maps URL, without hitting the network.
 * Handles both the "@lat,lng,zoom" form (from the address bar of an open map view) and the
 * "?q=lat,lng" / "?query=lat,lng" / "?ll=lat,lng" / "?destination=lat,lng" query-param forms.
 * Returns null if the URL doesn't contain recognizable coordinates (e.g. it's a place-name
 * or share-link URL instead) — callers should fall back to geocode() in that case.
 */
export function coordFromUrl(url) {
  if (!url) return null;
  const s = String(url);

  const atMatch = s.match(/@(-?\d[\d.]*),(-?\d[\d.]*)/);
  if (atMatch) return [+atMatch[1], +atMatch[2]];

  const paramMatch = s.match(/[?&](?:q|query|ll|destination)=(-?\d[\d.]+)(?:,|%2C)(-?\d[\d.]+)/);
  if (paramMatch) return [+paramMatch[1], +paramMatch[2]];

  return null;
}
