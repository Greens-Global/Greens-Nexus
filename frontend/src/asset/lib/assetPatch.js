// One-asset patches from outside the spec sheet (Dates' Mark Paid / Mark Renewed, the register's
// bulk Set Company / Set Asset Manager / Set Stage - Neil, 11/17/2026): the top-level keys AND the
// snapshot values that show them, so the spec sheet and the lists never disagree. Snapshot keys
// stay as they are; a value with no slot yet goes into the group PT puts it in.
import { PT } from './propertyFields.js';
import { ASSET_SCHEMAS, inferAssetKind } from './vehicleFields.js';
import { normLabel } from './format.js';

const STAGE_FIELD = (() => { for (const g of PT) for (const f of g.fields) if (f.type === 'stage') return { label: f.label, group: g.group }; return { label: 'Development Stage', group: '' }; })();
const SNAP_SKIP = new Set(['company', 'egnyte']);

/** Where a top-level key lives in an asset's snapshot: { label, group } (group '' = flat). */
function snapshotSlot(kind, key) {
  if (kind === 'property') {
    if (key === 'devStage') return STAGE_FIELD;
    for (const g of PT) for (const f of g.fields) if (f.key === key && !SNAP_SKIP.has(f.type)) return { label: f.label, group: g.group };
    return null;
  }
  const f = (ASSET_SCHEMAS[kind] || []).find((x) => x.k === key);
  return f ? { label: f.label, group: '' } : null;
}

/** An asset with `patch` on its top-level keys AND the matching snapshot values. */
export function patchAssetRow(asset, patch) {
  const kind = inferAssetKind(asset);
  const snapshot = (asset.snapshot || []).map((g) => ({ ...g, fields: [...(g.fields || [])] }));
  Object.entries(patch).forEach(([key, value]) => {
    const slot = snapshotSlot(kind, key);
    if (!slot) return;
    let hit = false;
    snapshot.forEach((g) => g.fields.forEach((f, i) => { if (normLabel(f.label) === normLabel(slot.label)) { g.fields[i] = { ...f, value }; hit = true; } }));
    if (!hit && slot.group) {
      const g = snapshot.find((x) => x.group === slot.group);
      if (g) g.fields.push({ label: slot.label, value });
      else snapshot.push({ group: slot.group, fields: [{ label: slot.label, value }] });
    }
  });
  return { ...asset, ...patch, snapshot };
}

