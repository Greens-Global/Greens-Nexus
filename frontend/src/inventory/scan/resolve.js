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

// The printed serial typed by hand: "gg 42", "GG00042" and "42" all mean
// GG-00042 - tried BEFORE the loose match (review L6), as the server does.
const GG_RE = /^(?:gg)?\s*-?\s*0*(\d{1,9})$/i;
export function ggSerial(raw) {
  const m = GG_RE.exec(String(raw || '').trim());
  return m ? `GG-${m[1].padStart(5, '0')}` : '';
}

export function compactCode(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Every item in `items` a parsed code names: one for an exact match, several
 *  only when a loose serial (other spacing or dashes) fits more than one. */
export function findLocalItems(items, parsed) {
  const list = Array.isArray(items) ? items : [];
  if (!parsed) return [];
  const one = (i) => (i ? [i] : []);
  if (parsed.kind === 'item') return one(list.find((i) => i.id === parsed.id));
  if (parsed.kind !== 'code') return [];
  const raw = parsed.code.trim();
  const lower = raw.toLowerCase();
  const exact = list.find((i) => i.id === raw) || list.find((i) => (i.serialNumber || '').toLowerCase() === lower);
  if (exact) return [exact];
  const gg = ggSerial(raw).toLowerCase();
  const expanded = gg ? list.find((i) => (i.serialNumber || '').toLowerCase() === gg) : null;
  if (expanded) return [expanded];
  const key = compactCode(raw);
  return key.length >= 3 ? list.filter((i) => i.serialNumber && compactCode(i.serialNumber) === key) : [];
}

/** The ONE item in `items` a parsed code names, or null (none, or several). */
export function findLocalItem(items, parsed) {
  const hits = findLocalItems(items, parsed);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Resolve a scanned or typed code.
 *   { status: 'found', item, via: 'local' | 'server' }
 *   { status: 'denied', id }        - a Nexus item link the person may not see
 *   { status: 'unknown', code }     - no item matches
 *   { status: 'several', items }    - a loose serial that fits more than one item: pick one
 *   { status: 'foreign', url }      - a link that is not a Nexus item tag
 *   { status: 'empty' }
 *   { status: 'error', message }    - the server could not be asked
 */
export async function resolveScannedCode(text, { items = [], fetchByCode } = {}) {
  const parsed = parseScannedCode(text);
  if (parsed.kind === 'empty') return { status: 'empty' };
  if (parsed.kind === 'foreign') return { status: 'foreign', url: parsed.url };
  const local = findLocalItems(items, parsed);
  if (local.length === 1) return { status: 'found', item: local[0], via: 'local' };
  if (local.length > 1) return { status: 'several', items: local, code: parsed.code };
  if (!fetchByCode) return parsed.kind === 'item' ? { status: 'denied', id: parsed.id } : { status: 'unknown', code: parsed.code };
  try {
    const item = await fetchByCode(parsed.kind === 'item' ? parsed.id : parsed.code);
    if (item && item.id) return { status: 'found', item, via: 'server' };
  } catch (e) {
    // 409: the server's loose match fit several items (GET /items/by-code).
    if (e?.status === 409) {
      const choices = Array.isArray(e?.body?.choices) ? e.body.choices : [];
      if (choices.length) return { status: 'several', items: choices, code: parsed.code };
    }
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
