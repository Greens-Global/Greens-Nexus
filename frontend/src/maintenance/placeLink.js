// Scan to Request (Construction plan phase 5, Neil 11/03/2026) - a place's
// own link. A site tag carries /tickets/place/<propertyId>; an equipment tag
// /tickets/place/<propertyId>/<assetId>. Like an item tag, the link needs a
// sign-in and the server walls the place (GET /maintenance/place/...), so no
// token rides in it. Inside the app it travels as the Tickets sub
// "place/<propertyId>[/<assetId>]" (lib/routes.js ticketPlaceSub turns the
// path into it, and the address writer turns it back into the same path).
//
// Pure functions only. The Items scanner recognizes these links too
// (inventory/scan/itemLink.js) - there is ONE scanner.

const PATH_RE = /^\/tickets\/place\/([^/?#]+)(?:\/([^/?#]+))?\/?$/i;
const SUB_RE = /^place\/([^/]+)(?:\/([^/]+))?$/;

const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export function placeSub(propertyId, assetId = '') {
  return `place/${encodeURIComponent(propertyId)}${assetId ? `/${encodeURIComponent(assetId)}` : ''}`;
}

export function placePath(propertyId, assetId = '') {
  return `/tickets/${placeSub(propertyId, assetId)}`;
}

export function placeUrl(propertyId, assetId = '', origin = '') {
  const base = String(origin || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/+$/, '');
  return `${base}${placePath(propertyId, assetId)}`;
}

/** { propertyId, assetId } for a path like /tickets/place/<p>[/<a>], else null. */
export function parsePlacePath(pathname) {
  const m = PATH_RE.exec(String(pathname || ''));
  return m ? { propertyId: dec(m[1]), assetId: m[2] ? dec(m[2]) : '' } : null;
}

/** { propertyId, assetId } for the Tickets sub "place/<p>[/<a>]", else null. */
export function parsePlaceSub(sub) {
  const m = SUB_RE.exec(String(sub || ''));
  return m ? { propertyId: dec(m[1]), assetId: m[2] ? dec(m[2]) : '' } : null;
}

/** Open a place's sheet from anywhere in the app. */
export function openPlace(propertyId, assetId = '') {
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tickets', sub: placeSub(propertyId, assetId) } }));
}
