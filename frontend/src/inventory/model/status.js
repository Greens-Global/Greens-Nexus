// Item Management - Item types, item / operational / checkout status labels and the display status rule.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { Package, CheckCircle, Clock, XCircle, RotateCcw, Camera, Car, Wrench, Key, Monitor, Box } from 'lucide-react';
import { cleanField } from './fields';

// ── Constants ─────────────────────────────────────────────────────────────────
// Controlled item types - mirror _ITEM_TYPES in backend/routers/items.py. Add/edit
// is dropdown-only; unrecognised types on import are saved as "Other" (Neil).
export const ITEM_TYPES = ['Computer', 'Peripheral', 'Networking', 'Server', 'Storage', 'IP Camera', 'Devices', 'Tools', 'Equipment', 'Vehicles', 'Furniture', 'Keys', 'Other'];

// Canonicalise a free-typed item type: case-insensitive + singular→plural
// ("device" → "Devices"). Unknown types (e.g. "IP Camera") are kept as-is so
// imported types stay first-class. Mirrors _normalize_type on the backend.
const _TYPE_CANON = ITEM_TYPES.reduce((m, t) => {
  m[t.toLowerCase()] = t;
  if (t.endsWith('s')) m[t.slice(0, -1).toLowerCase()] = t;
  return m;
}, {});
export function normalizeType(raw) {
  const s = cleanField(raw);
  if (!s) return 'Other';
  return _TYPE_CANON[s.toLowerCase()] || s;
}

const TYPE_DEFAULT_OWNER = {
  Devices:   'IT',
  Tools:     'Construction (MCD)',
  Vehicles:  'Construction',
  Equipment: '',
  Keys:      'Operations (Oversite)',
  Other:     '',
};

export const TYPE_META = {
  Devices:   { Icon: Monitor,  color: 'hsl(var(--color-blue))',   bg: 'hsla(var(--color-blue),0.12)'   },
  Tools:     { Icon: Wrench,   color: 'hsl(var(--color-orange))', bg: 'hsla(var(--color-orange),0.12)' },
  Vehicles:  { Icon: Car,      color: 'hsl(var(--color-green))',  bg: 'hsla(var(--color-green),0.12)'  },
  Equipment: { Icon: Box,      color: 'hsl(var(--color-purple))', bg: 'hsla(var(--color-purple),0.12)' },
  Keys:      { Icon: Key,      color: 'hsl(var(--color-red))',    bg: 'hsla(var(--color-red),0.12)'    },
  Other:     { Icon: Package,  color: 'var(--muted)',             bg: 'var(--mist)'                    },
};

export const STATUS_META = {
  available:            { label: 'Available',          bg: 'hsla(var(--color-green),0.12)',  fg: 'hsl(var(--color-green))'  },
  unassigned:           { label: 'Unassigned',         bg: 'hsla(var(--color-purple),0.12)', fg: 'hsl(var(--color-purple))' },
  location_assigned:    { label: 'Assigned · Location', bg: 'hsla(var(--color-blue),0.12)',  fg: 'hsl(var(--color-blue))'   },
  checked_out:          { label: 'Checked Out',        bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))' },
  // Display-only: a merely-pending (not yet allocated) request - the list view
  // must read "Under review" like the tile view, not "Checked out" (P4 status coherence).
  under_review:         { label: 'Requested',          bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))' },
  permanently_assigned: { label: 'Assigned',          bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))'   },
  retired:              { label: 'Retired',             bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))'    },
};

// Operational status (Neil) - condition/deployment state of a unit, SEPARATE from
// the lifecycle `status` above (which checkouts/assignments drive automatically).
// '' = unset. Mirror _OP_STATUSES in backend/routers/items.py if you change this.
export const OP_STATUSES = ['deployed', 'in_storage', 'in_repair', 'needs_replacement', 'retired', 'lost'];
// Recycle bin retention - keep in sync with _RECYCLE_BIN_DAYS in routers/items.py.
export const RECYCLE_BIN_DAYS = 30;
export const OP_STATUS_META = {
  deployed:          { label: 'Deployed',          bg:'hsla(var(--color-green),0.12)',  fg:'hsl(var(--color-green))'  },
  in_storage:        { label: 'In Storage',        bg:'hsla(var(--color-blue),0.12)',   fg:'hsl(var(--color-blue))'   },
  in_repair:         { label: 'In Repair',         bg:'hsla(var(--color-orange),0.12)', fg:'hsl(var(--color-orange))' },
  needs_replacement: { label: 'Needs Replacement', bg:'hsla(var(--color-red),0.12)',    fg:'hsl(var(--color-red))'    },
  // "Written off" (not "Retired") so the op-status column doesn't clash with the
  // lifecycle "Retired" in the adjacent column (P4 copy). Backend value stays 'retired'.
  retired:           { label: 'Written Off',       bg:'var(--mist)',                    fg:'var(--muted)'             },
  lost:              { label: 'Lost',              bg:'hsla(var(--color-red),0.12)',    fg:'hsl(var(--color-red))'    },
};
// Op statuses declared AGAINST a person (lost/retired): they show a "Declared by"
// person field, notify that person, and group on the Who-Has-It board as
// Person → Status → Item. Mirror _OP_STATUS_PERSON in backend/routers/items.py.
export const OP_STATUS_PERSON = new Set(['lost', 'retired']);

// Display status: a permanent item that nobody holds is "Unassigned", not
// "Available" - green Available implies it could be checked out, which
// permanent items can't be. A permanent item placed at a location with no
// person holding it counts as assigned to that location (Neil, Jul 17), so
// batch "assign to location" visibly lands instead of still reading Unassigned.
export function displayStatus(item) {
  if (item.ownershipType === 'permanent' && item.status === 'available') {
    return (!item.assignedToEmail && item.location) ? 'location_assigned' : 'unassigned';
  }
  return item.status;
}

export const CHECKOUT_STATUS_META = {
  pending:         { label: 'Requested',          bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))', Icon: Clock },
  approved:        { label: 'Approved',           bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))',   Icon: Package },
  pending_receipt: { label: 'Handed Over',        bg: 'hsla(var(--color-purple),0.12)', fg: 'hsl(var(--color-purple))', Icon: Camera },
  allocated:       { label: 'In Use',             bg: 'hsla(var(--color-green),0.12)',  fg: 'hsl(var(--color-green))',  Icon: CheckCircle },
  rejected:        { label: 'Rejected',           bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))',    Icon: XCircle },
  returned:        { label: 'Returned',           bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))',   Icon: RotateCcw },
  cancelled:       { label: 'Canceled',           bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))',    Icon: XCircle },
};

// Manager-facing variant: at pending_receipt the ball is in the EMPLOYEE's court -
// "Confirm Receipt" (the employee's call to action) would read as the manager's job.
export const MANAGER_CHECKOUT_STATUS_META = {
  ...CHECKOUT_STATUS_META,
  pending_receipt: { label: 'Handed Over', bg: 'hsla(var(--color-purple),0.12)', fg: 'hsl(var(--color-purple))', Icon: Clock },
};

export const DEPARTMENTS = ['All', 'IT', 'Construction', 'Operations', 'Accounting', 'Facilities', 'Marketing', 'HR'];
