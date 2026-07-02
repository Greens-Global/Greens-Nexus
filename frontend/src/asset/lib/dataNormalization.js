// Data migration / self-healing normalization for asset records.
//
// Four independent passes, all safe to re-run on every load (idempotent — running twice
// produces the same result as running once):
//   - healPropTeam: migrates legacy "Project Team" snapshot field labels/contacts to current
//     naming.
//   - VNORM: module-level normalizer applied whenever we accept a state blob from the server
//     during sync (renames a stale vocabulary term + re-runs healPropTeam).
//   - mergeSeed: reconciles a user's STORED property record with the current SEED record on
//     every load. This is the most important invariant in the whole data layer — see the long
//     comment on mergeSeed() below before touching it.
//   - AO: applies a small number of hardcoded one-off corrections (STAGE_OVERRIDE/TYPE_OVERRIDE)
//     to specific assets by id, plus flags officer-residence assets as private.
//
// All four operate on plain data objects and are pure (no mutation of their inputs) — each
// returns either the original reference unchanged (when nothing needed fixing, so callers can
// cheaply skip re-renders via `!==` checks) or a new object.

import { normLabel } from './format.js';

// ------------------------------------------------------------------------------------------
// healPropTeam
// ------------------------------------------------------------------------------------------

// Legacy "Project Team" snapshot field label -> current label(s) it should be split/renamed
// into. Some legacy labels expand into MULTIPLE current fields (e.g. one old combined
// "GC / CM" field becomes two distinct fields today) — when that happens the old field's
// stored contact info (keyed by normalized label in `p.contacts`) is copied onto every new
// label it expands into, so nobody's saved phone/email gets silently dropped by the split.
const PROJECT_TEAM_RELABEL = [
  ['civil', ['Civil Engineer']],
  ['structural', ['Structural Engineer']],
  ['mep', ['MEP Engineer']],
  ['gc / cm', ['General Contractor', 'Construction Manager']],
  ['title / escrow', ['Title Officer', 'Escrow Company']],
];

/**
 * Migrates a single property record's legacy Project Team field labels/contacts to current
 * naming, and drops a defunct "Service & Maintenance" snapshot group (that data now lives
 * exclusively in the dedicated Service & Maintenance tab, not the free-text snapshot).
 *
 * Idempotent: if a record has already been healed (no legacy labels present, no defunct group),
 * it's returned unchanged (`===` the input) so callers can skip re-renders / avoid marking data
 * as dirty.
 */
export function healPropTeam(property) {
  let changed = false;
  let contacts = property.contacts ? { ...property.contacts } : property.contacts;

  const snapshot = (property.snapshot || []).map((group) => {
    const newFields = [];
    let groupChanged = false;
    (group.fields || []).forEach((field) => {
      const normalized = normLabel(field.label);
      const hit = PROJECT_TEAM_RELABEL.find((m) => m[0] === normalized);
      if (hit) {
        const [, newLabels] = hit;
        newLabels.forEach((label) => newFields.push({ ...field, label }));
        groupChanged = true;
        // Carry forward any saved contact info (phone/email) from the old label onto every
        // new label it split into, then remove the old (now-orphaned) contact entry.
        if (contacts && contacts[normalized] !== undefined) {
          newLabels.forEach((label) => (contacts[normLabel(label)] = contacts[normalized]));
          delete contacts[normalized];
        }
      } else {
        newFields.push(field);
      }
    });
    // One-off group rename: "Assignment & Ownership" -> "Ownership".
    const newGroupName = group.group === 'Assignment & Ownership' ? 'Ownership' : group.group;
    if (newGroupName !== group.group) changed = true;
    if (groupChanged) changed = true;
    return groupChanged || newGroupName !== group.group
      ? { ...group, group: newGroupName, fields: groupChanged ? newFields : group.fields }
      : group;
  });

  // Drop the defunct "Service & Maintenance" snapshot group entirely — superseded by the
  // dedicated Service & Maintenance tab (vservice collection).
  let finalSnapshot = snapshot;
  if (snapshot.some((g) => g.group === 'Service & Maintenance')) {
    changed = true;
    finalSnapshot = snapshot.filter((g) => g.group !== 'Service & Maintenance');
  }

  return changed ? { ...property, snapshot: finalSnapshot, contacts } : property;
}

// ------------------------------------------------------------------------------------------
// VNORM
// ------------------------------------------------------------------------------------------

// Legacy vocabulary rename applied everywhere a string might carry it: property `type`,
// `parcelRole`, and every snapshot field label/value. "RV" was renamed to "Vehicle" across the
// product (RV Storage -> Vehicle Storage, etc.) to better reflect that these spaces also hold
// boats, trailers, and other non-RV vehicles.
function renameRvToVehicle(value) {
  return typeof value === 'string'
    ? value
        .replace(/\bRV Storage\b/g, 'Vehicle Storage')
        .replace(/\bRV & /g, 'Vehicle & ')
        .replace(/\bRV Parking\b/g, 'Vehicle Parking')
    : value;
}

/**
 * Module-level data normalizer applied to a full state object whenever it's accepted from the
 * server during sync (see sync.js's wireBackgroundSync / the hydrate-on-load reconcile). Renames
 * the legacy RV->Vehicle vocabulary across every property's type/parcelRole/snapshot, then runs
 * healPropTeam on each.
 *
 * IMPORTANT: this must be applied on every path that can bring in "live" data from outside the
 * current in-memory state — both the initial load reconcile AND the background server-pull path.
 * Missing it on one path means data arriving via that path silently keeps stale labels/legacy
 * Project Team fields. (See "Two Load Paths" — localStorage-driven load vs. server reconcile —
 * this normalizer belongs on both.)
 *
 * Idempotent and returns the original object unchanged if nothing needed normalizing.
 */
export function VNORM(state) {
  if (!state || !Array.isArray(state.properties)) return state;
  let stateChanged = false;
  const properties = state.properties.map((property) => {
    let propertyChanged = false;
    const newType = renameRvToVehicle(property.type);
    const newParcelRole = renameRvToVehicle(property.parcelRole);
    if (newType !== property.type || newParcelRole !== property.parcelRole) propertyChanged = true;

    const snapshot = (property.snapshot || []).map((group) => ({
      ...group,
      fields: (group.fields || []).map((field) => {
        const newLabel = renameRvToVehicle(field.label);
        const newValue = renameRvToVehicle(field.value);
        if (newLabel !== field.label || newValue !== field.value) {
          propertyChanged = true;
          return { ...field, label: newLabel, value: newValue };
        }
        return field;
      }),
    }));

    const base = propertyChanged ? { ...property, type: newType, parcelRole: newParcelRole, snapshot } : property;
    const healed = healPropTeam(base);
    if (healed !== base || propertyChanged) {
      stateChanged = true;
      return healed;
    }
    return property;
  });
  return stateChanged ? { ...state, properties } : state;
}

// ------------------------------------------------------------------------------------------
// mergeSeed
// ------------------------------------------------------------------------------------------

/**
 * Reconciles a user's STORED property record (`stored`) with the current SEED record
 * (`seed`) for the same asset, on every load. This is the single most important data-safety
 * invariant in the app — see README "Data model notes": structure/labels always come from the
 * seed (so shipping an improved seed — new fields, renamed groups, reordered sections —
 * propagates to every existing user's data), while user-ENTERED VALUES ARE NEVER LOST, even
 * when the seed's shape around them changes.
 *
 * Do NOT reintroduce a "touched -> skip all updates" bypass here. An earlier version of this
 * migration had a fast path that, once a user had edited a record at all, stopped applying seed
 * updates to it entirely — the intent was "don't stomp on user edits," but the actual effect was
 * that ANY edit (even to one unrelated field) froze that asset's structure at whatever seed
 * version existed when the user first touched it, silently hiding every subsequent seed
 * improvement (new fields, corrected labels, newly-added groups) from that asset forever. The
 * field-level merge below is the fix: it propagates seed structure unconditionally while still
 * protecting every individual user-entered value, so there is no reason to skip anything at the
 * record level.
 *
 * Precedence, precisely:
 *   1. Snapshot (the free-text grouped field data): walk the SEED's groups/fields — this fixes
 *      the group order, the set of groups/fields that exist, and every field's LABEL to whatever
 *      the seed currently says. For each seed field, look up whether the user's stored data has
 *      a non-empty value for a field with the same normalized label anywhere in their snapshot;
 *      if so, that stored value overwrites the seed's value for that field. If the user never
 *      entered anything for that field (or it's a brand-new field the seed just added), the
 *      seed's own (placeholder/default) value is kept. Net effect: seed controls WHAT fields
 *      exist and their labels/order; the user's entered VALUES win wherever they exist.
 *   2. Top-level record fields (name, address, entity, notes, etc.): start from the seed, then
 *      spread the user's stored record OVER it — so stored top-level values win by default
 *      (a user-renamed asset stays renamed, an edited address stays edited).
 *   3. EXCEPT: `kind`, `assetType`, `make`, `model`, `trim` are force-reset to the SEED's values
 *      every time, even though step 2 would otherwise let stored values win. These are asset
 *      CLASSIFICATION fields (is this a property/vehicle/equipment, and which schema applies) —
 *      they're deliberately not user-editable data, so the seed is always authoritative for them.
 *      This guards against a stored record's classification drifting out of sync with the seed
 *      (e.g. if a seed correction reclassifies an asset) and silently applying the wrong field
 *      schema forever.
 *
 * `stored.snapshot`'s OWN group structure is discarded in favor of the seed's — only its field
 * VALUES are harvested (into a flat normalized-label -> value map) before being discarded. This
 * is what makes the whole thing seed-structure-authoritative: even if the user's stored snapshot
 * has stale groups/labels/order from an old seed version, only the values survive.
 */
export function mergeSeed(stored, seed) {
  // Harvest every non-empty value out of the stored snapshot, keyed by normalized label. This
  // is a flat map, so it doesn't matter which GROUP a value lived in on either side — only the
  // label match matters. (This is also why a seed relabel that changes normLabel()'s output,
  // e.g. a real rename rather than a formatting tweak, will NOT carry the old value forward —
  // matching is intentionally label-based, not id-based, because these are free-text fields
  // with no stable key.)
  const storedValues = {};
  (stored.snapshot || []).forEach((group) =>
    (group.fields || []).forEach((field) => {
      const v = field.value == null ? '' : String(field.value);
      if (v.trim() !== '') storedValues[normLabel(field.label)] = field.value;
    })
  );

  // Walk the SEED's structure; overlay the user's stored value wherever one exists for that label.
  const snapshot = (seed.snapshot || []).map((group) => ({
    ...group,
    fields: (group.fields || []).map((field) => {
      const key = normLabel(field.label);
      return key in storedValues ? { ...field, value: storedValues[key] } : field;
    }),
  }));

  return {
    ...seed,
    ...stored,
    // Classification fields are always seed-authoritative — see precedence note above.
    kind: seed.kind,
    assetType: seed.assetType,
    make: seed.make,
    model: seed.model,
    trim: seed.trim,
    snapshot,
  };
}

// ------------------------------------------------------------------------------------------
// AO — hardcoded seed corrections for specific assets
// ------------------------------------------------------------------------------------------

// Development-stage corrections for specific assets, keyed by asset id. These override whatever
// devStage the seed/stored record otherwise carries — used when the seed's generic stage data is
// known to be wrong/stale for a specific asset and re-deriving it isn't practical, so it's
// hardcoded here instead.
export const STAGE_OVERRIDE = {
  'greens-georgetown': 'Stabilized',
  'greens-austin': 'Stabilized',
  'greens-lakeside': 'Entitlement',
  'greens-rainbow': 'Construction',
  'greens-escondido-north': 'Entitlement',
  'greens-escondido-south': 'Stabilized',
  'greens-sachse': 'Stabilized',
  'greens-valley-center-north': 'Construction Drawings',
  'valley-center-east': 'Entitlement',
  'greens-valley-center-south': 'Stabilized',
  'greens-family-918-el-camino': 'Stabilized',
  'gurudev-family-910-el-camino': 'Stabilized',
  'rjk-residence': 'Stabilized',
  'greens-fairfield': 'Construction Drawings',
  'innopolis-genome-valley': 'Construction',
  'greens-heritage-square': 'Construction',
  'greens-storage-menifee': 'Construction',
  'quality-inn-washington-ut': 'Stabilized',
  'chipotle-chicago': 'Stabilized',
  'mattress-firm-chicago': 'Stabilized',
  'ramky-selenium-hyderabad': 'Stabilized',
  'greens-storage-murrieta': 'Stabilized',
  'greens-towers-hyderabad': 'Stabilized',
  'wells-fargo-san-antonio': 'Stabilized',
};

// Asset-type ("Current Use" / "Proposed Use") corrections for specific assets, keyed by id.
// Unlike STAGE_OVERRIDE, this also has to rewrite the snapshot's "Current Use"/"Proposed Use"
// field VALUES to match (see AO() below) so the grouped display and the top-level `type` field
// don't disagree with each other.
export const TYPE_OVERRIDE = {
  'greens-austin': 'Self-Storage Facility',
  'greens-georgetown': 'Self-Storage Facility',
  'greens-sachse': 'Self-Storage Facility',
  'greens-escondido-north': 'Self-Storage & Vehicle Storage Facility',
  'greens-escondido-south': 'Self-Storage & Vehicle Storage Facility',
  'greens-rainbow': 'Self-Storage & Vehicle Storage Facility',
  'greens-valley-center-north': 'Self-Storage & Vehicle Storage Facility',
  'greens-valley-center-south': 'Self-Storage & Vehicle Storage Facility',
  'valley-center-east': 'Self-Storage & Vehicle Storage Facility',
  'greens-storage-murrieta': 'Self-Storage & Vehicle Storage Facility',
  'greens-fairfield': 'Self-Storage & Vehicle Storage Facility',
};

// Officer-residence assets: private-flagged and gated from non-officers regardless of what the
// `private` flag on the stored/seed record says (belt-and-suspenders — see AO() below, which
// ORs this in rather than replacing the existing flag, so a record explicitly marked private for
// some other reason stays private too).
export const PRIVATE_IDS = new Set(['rjk-residence', 'nrk-ank-residence', 'spd-csd-residence']);

/**
 * Applies the hardcoded STAGE_OVERRIDE / TYPE_OVERRIDE seed corrections and the officer-residence
 * private flag to a single asset record, by id. Pure — returns a new object only when an
 * override actually applies to this record's id; otherwise returns the input unchanged.
 */
export function AO(record) {
  const stageOverride = STAGE_OVERRIDE[record.id];
  const typeOverride = TYPE_OVERRIDE[record.id];
  let out = record;

  if (stageOverride) out = { ...out, devStage: stageOverride };

  if (typeOverride) {
    // Keep the snapshot's "Current Use" / "Proposed Use" field values in sync with the
    // top-level `type` override, so the Project Details group doesn't show a stale value.
    const snapshot = (out.snapshot || []).map((group) => ({
      ...group,
      fields: (group.fields || []).map((field) => {
        const label = String(field.label || '').toLowerCase();
        return label.startsWith('current use') || label.startsWith('proposed use')
          ? { ...field, value: typeOverride }
          : field;
      }),
    }));
    out = { ...out, type: typeOverride, snapshot };
  }

  out = { ...out, private: !!record.private || PRIVATE_IDS.has(record.id) };
  return out;
}
