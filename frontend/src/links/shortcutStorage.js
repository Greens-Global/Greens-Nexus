// Per-browser link shortcuts (Recently Used) - shared between the Links tab
// (views/ExternalLinks.jsx) and the dashboard's Favorites widget
// (dashboard/widgets.jsx) so both read and write the SAME localStorage list.
//
// Deliberately NOT backend fields - these are per-browser shortcuts, same
// spirit as a browser bookmarks bar, so they stay snappy with zero API calls
// and never need a migration. Keyed by email so a shared kiosk PC doesn't
// bleed one person's shortcuts into another's session. Favorites used to
// live here too; they moved to the backend-persisted Link Views (Aug 14) so
// they follow the account. Recent stays local on purpose - an auto-derived,
// ephemeral trail (last 8 clicked), not something deliberately arranged.
export const RECENTS_MAX = 8;

export const lsKey = (email, kind) => `nexus:extlinks:${kind}:${(email || 'anon').toLowerCase()}`;

export function readIds(email, kind) {
  try { return JSON.parse(localStorage.getItem(lsKey(email, kind)) || '[]'); } catch { return []; }
}

export function writeIds(email, kind, ids) {
  try { localStorage.setItem(lsKey(email, kind), JSON.stringify(ids)); } catch { /* storage disabled/full - shortcuts just won't persist */ }
}

// Move `id` to the front of the Recently Used trail (Company Links only -
// Personal Links are never part of it, matching the Links tab).
export function pushRecentId(email, id) {
  const next = [id, ...readIds(email, 'recents').filter(x => x !== id)].slice(0, RECENTS_MAX);
  writeIds(email, 'recents', next);
  return next;
}
