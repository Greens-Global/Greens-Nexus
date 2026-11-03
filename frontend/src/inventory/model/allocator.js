// Item Management - Who should hand an item over: department allocator hints.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).

// ── Cart Drawer ────────────────────────────────────────────────────────────────
// Item type → department fallback for the approver suggestion when a restored
// cart entry doesn't carry its department.
export const TYPE_DEPT_FALLBACK = {
  Tools: 'construction', Vehicles: 'construction',
  Devices: 'it', Keys: 'operations', Equipment: 'operations',
};

// ── Approve Modal (manager picks allocator) - supports single or batch ────────
// Default allocator by department - the person who usually hands over that
// department's items (Neil: Construction → Sahil, Operations → Valinda).
// Matched by first name against the allocators list so it survives email changes.
const DEPT_ALLOCATOR_HINTS = {
  construction: ['sahil'],
  operations:   ['valinda'],
  it:           ['visesh'],
};

export function suggestAllocator(items, allocators) {
  if (!items.length || !allocators.length) return null;
  // Majority department across the cart decides the default
  const counts = {};
  for (const co of items) {
    const d = (co.department || '').toLowerCase().trim();
    if (d) counts[d] = (counts[d] || 0) + 1;
  }
  const majority = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!majority) return null;
  const hints = DEPT_ALLOCATOR_HINTS[majority];
  if (!hints) return null;
  for (const hint of hints) {
    const match = allocators.find(a =>
      (a.name || '').toLowerCase().includes(hint) || (a.email || '').toLowerCase().includes(hint)
    );
    if (match) return { ...match, majorityDept: majority };
  }
  return null;
}
