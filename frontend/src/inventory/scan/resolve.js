// Items phase 4 - what a scanned or typed code turns into.
//
// The screen already holds every item the person may see (GET /items is
// walled), so a code is matched there first - instant, and it works on a
// weak signal. Only a miss asks the server (GET /items/by-code), which also
// knows the hand-typed serial forms ("gg 42") and answers 404 for an item
// outside the person's companies. A Nexus item link that the server will not
// show is "denied" (the tag is real, the person is not on its side of the
// wall); any other miss is "unknown".

import { parseScannedCode } from './itemLink';

export function compactCode(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The item in `items` a parsed code names, or null. */
export function findLocalItem(items, parsed) {
  const list = Array.isArray(items) ? items : [];
  if (!parsed) return null;
  if (parsed.kind === 'item') return list.find((i) => i.id === parsed.id) || null;
  if (parsed.kind !== 'code') return null;
  const raw = parsed.code.trim();
  const lower = raw.toLowerCase();
  const key = compactCode(raw);
  return list.find((i) => i.id === raw)
    || list.find((i) => (i.serialNumber || '').toLowerCase() === lower)
    || (key.length >= 3 ? list.find((i) => i.serialNumber && compactCode(i.serialNumber) === key) : null)
    || null;
}

/**
 * Resolve a scanned or typed code.
 *   { status: 'found', item, via: 'local' | 'server' }
 *   { status: 'denied', id }        - a Nexus item link the person may not see
 *   { status: 'unknown', code }     - no item matches
 *   { status: 'foreign', url }      - a link that is not a Nexus item tag
 *   { status: 'empty' }
 *   { status: 'error', message }    - the server could not be asked
 */
export async function resolveScannedCode(text, { items = [], origin, fetchByCode } = {}) {
  const parsed = parseScannedCode(text, origin);
  if (parsed.kind === 'empty') return { status: 'empty' };
  if (parsed.kind === 'foreign') return { status: 'foreign', url: parsed.url };
  const local = findLocalItem(items, parsed);
  if (local) return { status: 'found', item: local, via: 'local' };
  if (!fetchByCode) return parsed.kind === 'item' ? { status: 'denied', id: parsed.id } : { status: 'unknown', code: parsed.code };
  try {
    const item = await fetchByCode(parsed.kind === 'item' ? parsed.id : parsed.code);
    if (item && item.id) return { status: 'found', item, via: 'server' };
  } catch (e) {
    if (e?.status !== 404) return { status: 'error', message: e?.message || 'Nexus could not be reached - try again.' };
  }
  return parsed.kind === 'item' ? { status: 'denied', id: parsed.id } : { status: 'unknown', code: parsed.code };
}

/** Items whose serial or name contains what was typed (the manual fallback's list). */
export function searchItems(items, query, limit = 8) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const key = compactCode(q);
  const hits = [];
  for (const i of Array.isArray(items) ? items : []) {
    const serial = (i.serialNumber || '').toLowerCase();
    const name = (i.name || '').toLowerCase();
    let rank = -1;
    if (serial && serial === q) rank = 0;
    else if (serial && key && compactCode(serial).includes(key)) rank = 1;
    else if (name.startsWith(q)) rank = 2;
    else if (name.includes(q)) rank = 3;
    if (rank >= 0) hits.push([rank, i]);
  }
  // Serial matches read in serial order, name matches in name order.
  const key2 = (h) => String(h[0] <= 1 ? h[1].serialNumber : h[1].name || '');
  hits.sort((a, b) => a[0] - b[0] || key2(a).localeCompare(key2(b)));
  return hits.slice(0, limit).map((h) => h[1]);
}
