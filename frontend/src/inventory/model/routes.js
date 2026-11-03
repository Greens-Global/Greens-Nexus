// Item Management - the tabs and their addresses (Items redesign, Neil 11/02/2026).
//
// One module, no chooser and no Manage mode: access decides which tabs show.
//   My Stuff   everyone - what you hold and what waits on you
//   Borrow     everyone - the borrowable catalog and the cart
//   Requests   items managers and allocators - approve, hand over, returns
//   Inventory  items admins - the table, Who Has What and Activity
//
// The sub in the address bar is  <tab>[:<view>][@<itemId>]
//   mystuff            borrow            requests:handover
//   inventory:whohas   inventory@<id>    (the item record open over a tab)
// Every pre-redesign sub (bells, emails, approvals, bookmarks) still lands -
// LEGACY below - and a tab the person may not open falls back to one they can.

export const ITEMS_TABS = [
  { key: 'mystuff',   label: 'My Stuff' },
  { key: 'borrow',    label: 'Borrow' },
  { key: 'requests',  label: 'Requests' },
  { key: 'inventory', label: 'Inventory' },
];

// Requests queues, in order. 'assignments' is the permanent-item queue.
export const REQUEST_QUEUES = ['approve', 'handover', 'returns', 'overdue', 'inuse', 'assignments', 'done'];
export const INVENTORY_VIEWS = ['table', 'whohas', 'activity'];

// Old subs -> the new address. Keep every key: the server still writes some
// of them into bells, reminders and the Approvals inbox.
const LEGACY = {
  myitems: 'mystuff',
  permanent: 'mystuff',
  'active-checkouts': 'mystuff',
  catalog: 'borrow',
  manage: 'inventory',
  checkouts: 'requests',
  handover: 'requests:handover',
  'assignment-returns': 'requests:returns',
  'checkouts-completed': 'requests:done',
  whohasit: 'inventory:whohas',
  audit: 'inventory:activity',
};

const TAB_KEYS = new Set(ITEMS_TABS.map((t) => t.key));

/** '<tab>[:<view>][@<itemId>]' (or an old sub) -> { tab, view, itemId }. */
export function parseItemsSub(sub) {
  const raw = String(sub || '').trim();
  const at = raw.indexOf('@');
  const base = at >= 0 ? raw.slice(0, at) : raw;
  const itemId = at >= 0 ? raw.slice(at + 1) : '';
  const mapped = LEGACY[base] || base;
  const [tab, ...rest] = mapped.split(':');
  const view = rest.join(':');
  return { tab: TAB_KEYS.has(tab) ? tab : '', view, itemId, legacy: !!LEGACY[base] };
}

/** The new sub for an old one ('checkouts' -> 'requests', 'catalog@x' ->
 *  'borrow@x'), or null when `sub` is not an old Items sub. */
export function legacyItemsSub(sub) {
  const raw = String(sub || '');
  const at = raw.indexOf('@');
  const base = at >= 0 ? raw.slice(0, at) : raw;
  if (!LEGACY[base]) return null;
  return `${LEGACY[base]}${at >= 0 ? raw.slice(at) : ''}`;
}

/** { tab, view, itemId } -> the sub string (view and item optional). */
export function itemsSub({ tab, view = '', itemId = '' }) {
  return `${tab || 'mystuff'}${view ? `:${view}` : ''}${itemId ? `@${itemId}` : ''}`;
}

/** The tabs this person sees, in order. */
export function tabsFor({ isManager = false, isAllocator = false } = {}) {
  return ITEMS_TABS.filter((t) =>
    t.key === 'mystuff' || t.key === 'borrow'
    || (t.key === 'requests' && (isManager || isAllocator))
    || (t.key === 'inventory' && isManager));
}

/** The tab to show for a parsed sub: the one asked for when this person may
 *  open it, else the nearest they can (Requests -> My Stuff, Inventory ->
 *  Borrow), else My Stuff. */
export function resolveTab(parsed, access) {
  const allowed = new Set(tabsFor(access).map((t) => t.key));
  const want = parsed?.tab || 'mystuff';
  if (allowed.has(want)) return want;
  if (want === 'inventory') return 'borrow';
  return 'mystuff';
}
