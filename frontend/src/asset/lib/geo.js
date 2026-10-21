// Map helpers for the portfolio map and the per-asset map card.
//
// Geocoding moved to the server on Oct 21 2026 (backend/asset_geocode.py):
// each asset's address is looked up once there and the point lives on the
// asset as `geo: { lat, lng, for }`. The browser no longer calls Nominatim -
// it was a policy violation and sent the portfolio's addresses from every
// viewer's machine. What is left here is pure: a point from a pasted Google
// Maps link, and the one rule for where an asset's pin comes from.

import { snapMap } from './format.js';

/**
 * Where an asset's pin comes from: a coordinate in its Google Maps link first
 * (exact, the person chose it), else the server's geocoded point, else null.
 * `[lat, lng]`.
 */
export function pinFor(asset) {
  const linked = coordFromUrl(asset?.mapUrl || snapMap(asset || {})['google maps link']);
  if (linked) return linked;
  const geo = asset?.geo;
  if (geo && typeof geo.lat === 'number' && typeof geo.lng === 'number') return [geo.lat, geo.lng];
  return null;
}

/** Does the asset have anything the server could place (a street or a city)? */
export function hasAddress(asset) {
  return !!(asset?.address || asset?.city);
}

/**
 * Pull `[lat, lng]` straight out of a pasted Google Maps URL, without hitting the network.
 * Handles both the "@lat,lng,zoom" form (from the address bar of an open map view) and the
 * "?q=lat,lng" / "?query=lat,lng" / "?ll=lat,lng" / "?destination=lat,lng" query-param forms.
 * Returns null if the URL doesn't contain recognizable coordinates (e.g. it's a place-name
 * or share-link URL instead) - callers should fall back to geocode() in that case.
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
