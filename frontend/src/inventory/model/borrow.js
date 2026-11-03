// Item Management - what Borrow lists (Items redesign, Neil 11/02/2026).
// Only items people can actually borrow: temporary (checkout) items whose type
// is Borrowable, never one marked lost or retired. Items out on loan still
// show (with when they are back) after the ones free right now.
import { isTypeBorrowable } from './useTypeSettings';

export function borrowableItems(items = [], byName = new Map()) {
  return items.filter(i => (i.ownershipType || 'transient') === 'transient'
    && i.opStatus !== 'lost' && i.opStatus !== 'retired' && i.status !== 'retired'
    && isTypeBorrowable(byName, i.itemType));
}

/** Free to request right now (no live request on it). */
export function isFreeToBorrow(item, liveItemIds = new Set()) {
  return item.status === 'available' && !item.hasActiveRequest && !liveItemIds.has(item.id) && item.opStatus !== 'in_repair';
}

/** [{ type, count }] - only the borrowable types that have items, A to Z. */
export function borrowTypeOptions(list = []) {
  const counts = new Map();
  for (const i of list) {
    const t = (i.itemType || 'Other').trim() || 'Other';
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => a.type.localeCompare(b.type));
}

/** Search + type + location, then free items first, A to Z within each. */
export function filterBorrow(list, { q = '', type = 'All', location = 'All', liveItemIds = new Set() } = {}) {
  const needle = q.trim().toLowerCase();
  return list.filter(i => (type === 'All' || (i.itemType || 'Other') === type)
    && (location === 'All' || (i.location || '') === location)
    && (!needle || [i.name, i.make, i.model, i.serialNumber, i.location].some(v => String(v || '').toLowerCase().includes(needle))))
    .sort((a, b) => (isFreeToBorrow(b, liveItemIds) - isFreeToBorrow(a, liveItemIds)) || String(a.name).localeCompare(String(b.name)));
}
