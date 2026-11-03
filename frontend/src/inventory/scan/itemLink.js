// Items phase 4 (QR tags + phone scan, Neil 11/02/2026) - the item's own link.
//
// Every item has a stable address: /itemmanagement/item/<id>. It is what a
// printed QR tag carries (on the app's PUBLIC address - POST /items/tags
// sends it, so a tag printed from a preview or a local tab still points at
// Nexus - and nothing else in it: the link needs a sign-in and the server
// walls the item, so no secret token is needed) and what the address bar
// reads while the item is open. Inside the
// app it travels as the Items sub "item/<id>" - App.jsx's parsePath turns the
// two path segments into that one sub, and the address writer turns it back
// into the same path, so the link survives a refresh, Back and a share.
// Old links keep working: "/inventory/item/<id>" (the view's old address)
// and a bell's "item:<id>" sub land on the same item.
//
// Pure functions only (no React, no DOM beyond window.location as a default).
// The address-bar half (two path segments -> one sub) is itemLinkSub in
// lib/routes.js, which App.jsx already loads - first paint stays as it was.

import { parsePlacePath } from '../../maintenance/placeLink';

export const ITEM_PATH_SEGMENT = 'itemmanagement';
const SUB_RE = /^item[/:](.+)$/;

/** The Items sub for one item ("item/<id>"). */
export function itemSub(id) {
  return `item/${encodeURIComponent(String(id || ''))}`;
}

/** The path for one item ("/itemmanagement/item/<id>"). */
export function itemPath(id) {
  return `/${ITEM_PATH_SEGMENT}/${itemSub(id)}`;
}

/** The full link a QR tag carries: the item's path on this app's origin. */
export function itemUrl(id, origin = (typeof window !== 'undefined' ? window.location.origin : '')) {
  return `${String(origin || '').replace(/\/+$/, '')}${itemPath(id)}`;
}

/** The item id an Items sub names ("item/<id>" or a bell's "item:<id>"), else null. */
export function parseItemSub(sub) {
  const m = SUB_RE.exec(String(sub || ''));
  if (!m) return null;
  const raw = m[1].split('/')[0];
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

// The item part of a Nexus item link's path, whichever alias it was printed with.
const PATH_RE = /^\/(?:itemmanagement|inventory)\/item[/:]([^/?#]+)\/?$/i;

/**
 * What a scanned or typed code means, before anything is looked up:
 *   { kind: 'item', id }    - a Nexus item link (/itemmanagement/item/<id>) on ANY host
 *   { kind: 'foreign', url } - some other link (a page that is not an item link)
 *   { kind: 'code', code }   - plain text: a serial, an old tag, an item id
 *   { kind: 'empty' }
 * Any host is safe (review M1, 11/02/2026): a tag printed on dev, a preview
 * or the prod address must all scan, and the app never opens the scanned
 * URL - only the id travels, through the walled GET /items/by-code.
 */
export function parseScannedCode(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { kind: 'empty' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw); } catch { return { kind: 'foreign', url: raw }; }
    const m = /^https?:$/i.test(u.protocol) ? PATH_RE.exec(u.pathname) : null;
    if (m) {
      let id = m[1];
      try { id = decodeURIComponent(id); } catch { /* keep the raw segment */ }
      return { kind: 'item', id };
    }
    // A site or equipment tag (Scan to Request, 11/03/2026) - the same one
    // scanner opens the place's sheet instead of an item.
    const place = /^https?:$/i.test(u.protocol) ? parsePlacePath(u.pathname) : null;
    if (place) return { kind: 'place', ...place };
    return { kind: 'foreign', url: raw };
  }
  return { kind: 'code', code: raw };
}
