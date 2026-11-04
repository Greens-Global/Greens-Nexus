// Open one request in Approvals from another screen (the Shift Planner's
// requests strip, 11/04/2026): the row's key waits here for one visit, and
// Approvals reviews that row once its list has loaded. Memory only - never
// storage - so a stale key cannot follow anyone around.
let pending = null;   // { key, at }
const TTL_MS = 60_000;

export function openApproval(rowKey, group = '') {
  pending = rowKey ? { key: rowKey, at: Date.now() } : null;
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'dashboard', sub: group ? `approvals:${group}` : 'approvals' } }));
}

// The waiting key when `has(key)` - the loaded list holds it - then gone.
// A key the list does not hold (decided meanwhile) is dropped once stale.
export function takeApprovalFocus(has) {
  if (!pending) return '';
  if (Date.now() - pending.at > TTL_MS) { pending = null; return ''; }
  if (!has(pending.key)) return '';
  const { key } = pending;
  pending = null;
  return key;
}
