// Item Management - Column sorting for the item lists.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { displayStatus } from './status';

// ── Sortable table headers (Catalog + Manage list views) ──────────────────────
// Click a column to sort asc, click again for desc, third click clears back to
// the default (available-first, then name). Shared by the employee catalog and
// the manager catalog/manage tables so the behaviour is identical (Neil, Jun 16).
const SORT_ACCESSORS = {
  name:     i => i.name || '',
  type:     i => i.itemType || '',
  make:     i => i.make || '',
  model:    i => i.model || '',
  location: i => i.location || '',
  status:   i => displayStatus(i) || i.status || '',
};

export function sortItemsBy(list, sortKey, sortDir) {
  // Default ordering when no column is chosen: available first, then alpha.
  if (!sortKey || !SORT_ACCESSORS[sortKey]) {
    return [...list].sort((a, b) => {
      const aA = a.status === 'available' ? 0 : 1, bA = b.status === 'available' ? 0 : 1;
      if (aA !== bA) return aA - bA;
      return (a.name || '').localeCompare(b.name || '');
    });
  }
  const get = SORT_ACCESSORS[sortKey];
  const sorted = [...list].sort((a, b) =>
    String(get(a)).localeCompare(String(get(b)), undefined, { numeric: true, sensitivity: 'base' }));
  return sortDir === 'desc' ? sorted.reverse() : sorted;
}

// Advance a column's sort: none → asc → desc → none.
export function nextSort(prev, colKey) {
  if (prev.key !== colKey) return { key: colKey, dir: 'asc' };
  if (prev.dir === 'asc')  return { key: colKey, dir: 'desc' };
  return { key: null, dir: 'asc' };
}
