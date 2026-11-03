// Items phase 4 (QR tags + phone scan, Neil 11/02/2026) - the item's own link.
//
// Every item has a stable address: /itemmanagement/item/<id>. It is what a
// printed QR tag carries (on the app's own origin, nothing else in it: the
// link needs a sign-in and the server walls the item, so no secret token is
// needed) and what the address bar reads while the item is open. Inside the
// app it travels as the Items sub "item/<id>" - App.jsx's parsePath turns the
// two path segments into that one sub, and the address writer turns it back
// into the same path, so the link survives a refresh, Back and a share.
// Old links keep working: "/inventory/item/<id>" (the view's old address)
// and a bell's "item:<id>" sub land on the same item.
//
// Pure functions only (no React, no DOM beyond window.location as a default).
// The address-bar half (two path segments -> one sub) is itemLinkSub in
// lib/routes.js, which App.jsx already loads - first paint stays as it was.

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
 *   { kind: 'item', id }    - a Nexus item link on THIS app's origin
 *   { kind: 'foreign', url } - some other link (another site, or a Nexus page that is not an item)
 *   { kind: 'code', code }   - plain text: a serial, an old tag, an item id
 *   { kind: 'empty' }
 */
export function parseScannedCode(text, origin = (typeof window !== 'undefined' ? window.location.origin : '')) {
  const raw = String(text ?? '').trim();
  if (!raw) return { kind: 'empty' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw); } catch { return { kind: 'foreign', url: raw }; }
    const sameOrigin = origin && u.origin === new URL(origin).origin;
    const m = PATH_RE.exec(u.pathname);
    if (sameOrigin && m) {
      let id = m[1];
      try { id = decodeURIComponent(id); } catch { /* keep the raw segment */ }
      return { kind: 'item', id };
    }
    return { kind: 'foreign', url: raw };
  }
  return { kind: 'code', code: raw };
}
