// Items phase 4 - the three things any screen may ask of the scan module.
// Each one is a window event the mounted ItemScanHost answers, so a caller
// (the Items header, a Manage toolbar, the redesign's Inventory tab, a bell)
// needs no handle on the host and no props threaded through.

import { itemSub } from './itemLink';

export const ITEM_SCAN_EVENT = 'nexus:items-scan';          // open the scanner
export const ITEM_TAGS_EVENT = 'nexus:items-print-tags';    // detail: { items: [{ id, name?, serialNumber? }] }

/**
 * Open one item. It is a real navigation (the address becomes the item's own
 * link, so Back closes it and the address can be shared): Items' host reads
 * the "item/<id>" sub and opens the item - or a calm "no access" state when
 * the server walls it off.
 */
export function openItemById(id) {
  if (!id) return;
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'inventory', sub: itemSub(id) } }));
}

/** Open the camera scanner (the host lazy-loads it on first use). */
export function openItemScanner() {
  window.dispatchEvent(new CustomEvent(ITEM_SCAN_EVENT));
}

/** Open the print-ready tag sheet for these items (objects with an id, or bare ids). */
export function printItemTags(items) {
  const list = (items || []).map((i) => (typeof i === 'string' ? { id: i } : i)).filter((i) => i && i.id);
  if (!list.length) return;
  window.dispatchEvent(new CustomEvent(ITEM_TAGS_EVENT, { detail: { items: list } }));
}
