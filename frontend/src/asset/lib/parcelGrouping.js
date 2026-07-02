// Pure helpers for the parcel-linking / asset-group model.
//
// A "group" is a set of property records linked together by a `parentId` pointer:
//   - The group's anchor (the record other members point AT) has `parentId` falsy ('').
//   - Every other member has `parentId === anchor.id`.
//   - `parcelOrder` (number) controls display order within the group; treated as the
//     member's array index when null/undefined (new/never-reordered members).
//   - `primary` (boolean) marks a parcel as primary. Multiple members CAN be primary at
//     once — see ParcelManager.jsx for why that's intentional, not a bug.
//
// The anchor is just "whichever member currently has no parentId" — it is NOT a
// permanently-designated parent. Unlinking the anchor promotes the remaining member with
// the lowest parcelOrder to be the new anchor (see the caller-side unlinkParcel logic
// this module supports). Treat `groupAnchorOf`'s result as a transient lookup, not identity.

import { normLabel } from './format.js';

/**
 * Mutable singleton the currently-mounted ParcelManager registers a "reveal" callback into,
 * so a "Link this asset to a parcel or group" button elsewhere in the detail view (for a
 * standalone, ungrouped asset — where ParcelManager renders nothing by default) can force
 * the collapsed panel open. Same pattern as editGuard.js. Call `parcelReveal.show?.()` from
 * that button; ParcelManager overwrites `.show` on every render while mounted.
 */
export const parcelReveal = { show: null };

/**
 * The anchor (lead) record of the group `p` belongs to: `p` itself if it has no parentId,
 * otherwise the record in `all` whose id matches `p.parentId` (falling back to `p` if that
 * record can't be found, e.g. stale/broken link).
 */
export function groupAnchorOf(p, all) {
  return p && p.parentId ? (all.find((x) => x.id === p.parentId) || p) : p;
}

/**
 * All members of `p`'s group (anchor first conceptually, but returned in `parcelOrder`
 * order), including `p` itself. Excludes soft-deleted records. Members with no explicit
 * `parcelOrder` fall back to their position in the underlying (anchor-first) list.
 */
export function groupMembersOf(p, all) {
  const anchor = groupAnchorOf(p, all);
  const members = [anchor, ...all.filter((x) => x.parentId === anchor.id && !x.deleted)];
  return members
    .map((m, i) => [m, m.parcelOrder == null ? i : m.parcelOrder])
    .sort((a, b) => a[1] - b[1])
    .map((x) => x[0]);
}

/** Raw "Lot Size" value for a single parcel, read from its free-text snapshot. '' if unset. */
export function parcelLot(p) {
  let value = '';
  (p.snapshot || []).forEach((group) => {
    (group.fields || []).forEach((f) => {
      if (normLabel(f.label) === 'lot size' && f.value != null && String(f.value).trim() !== '') {
        value = String(f.value);
      }
    });
  });
  return value;
}

/**
 * A single parcel's acreage, parsed from its "Lot Size" snapshot field. Converts sqft to
 * acres when the value looks like square feet ("sf"/"sq"/"ft"). 0 if unparseable/unset.
 * Note: this is per-parcel, not a group sum — callers sum across `groupMembersOf(...)`
 * themselves when they need a group total (see AssemblageParcels / ParcelManager).
 */
export function parcelAcres(p) {
  const lot = parcelLot(p);
  if (!lot) return 0;
  const match = lot.replace(/,/g, '').match(/([\d.]+)/);
  if (!match) return 0;
  const n = parseFloat(match[1]);
  if (!isFinite(n)) return 0;
  return /sf|sq|ft/i.test(lot) ? n / 43560 : n;
}
