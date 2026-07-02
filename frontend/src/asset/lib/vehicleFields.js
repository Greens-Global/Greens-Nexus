// Vehicle and Equipment spec-sheet schemas. Unlike properties (PT, which reads/writes through
// a `snapshot` group array keyed by label), vehicles and equipment are FLAT — every field here
// maps directly to a top-level field on the asset record via `k`. `{ sec: 'Group Name' }` entries
// are section-header markers, not fields.
//
// Field shape: { k, label, type?, options?, req?, full? }
//   - type:    'date' | 'number' | 'select' | 'textarea' (default: plain text)
//   - options: choices for type:'select'
//   - req:     required in the Add/Edit form
//   - full:    spans both columns in the 2-column edit grid

export const VEHICLE_FIELDS = [
  { sec: 'Vehicle' },
  { k: 'name', label: 'Asset Name / Unit #', req: true },
  { k: 'make', label: 'Make' },
  { k: 'model', label: 'Model' },
  { k: 'trim', label: 'Trim' },
  { k: 'yearBuilt', label: 'Model Year' },
  { k: 'vin', label: 'VIN' },
  { k: 'plate', label: 'License Plate' },
  { k: 'color', label: 'Color' },
  { k: 'odometer', label: 'Odometer (mi)', type: 'number' },
  { k: 'devStage', label: 'Status', type: 'select', options: ['In Service', 'In Repair', 'Out of Service', 'Retired'] },

  { sec: 'Ownership' },
  { k: 'entity', label: 'Owner / Entity' },
  { k: 'manager', label: 'Assigned to / Operator' },
  { k: 'address', label: 'Home Base / Location', full: true },

  { sec: 'Registration & Title' },
  { k: 'regNumber', label: 'Registration #' },
  { k: 'regExpiration', label: 'Registration Expiration', type: 'date' },
  { k: 'titleNumber', label: 'Title #' },

  // Note: there used to be a "Service & Maintenance" section here (serviceIntervalMi,
  // nextServiceMi, lastServiceDate, nextServiceDate) — removed as dead/redundant. Real service
  // tracking lives exclusively in the Service & Maintenance TAB (see vservice collection +
  // RecommendedMaintenance), not in the Overview spec sheet.

  { sec: 'Insurance & Coverage' },
  { k: 'insCarrier', label: 'Carrier' },
  { k: 'insPolicy', label: 'Policy #' },
  { k: 'insExpiration', label: 'Policy Expiration', type: 'date' },
  { k: 'insAgent', label: 'Agent / Broker' },
  { k: 'insPhone', label: 'Agent Phone' },

  { sec: 'Notes' },
  { k: 'notes', label: 'Notes', type: 'textarea', full: true },
];

export const EQUIPMENT_FIELDS = [
  { sec: 'Equipment' },
  { k: 'name', label: 'Asset Name / Unit #', req: true },
  { k: 'make', label: 'Make' },
  { k: 'model', label: 'Model' },
  { k: 'trim', label: 'Trim' },
  { k: 'yearBuilt', label: 'Year' },
  { k: 'equipType', label: 'Equipment Type' },
  { k: 'serialNumber', label: 'Serial #' },
  { k: 'hours', label: 'Hour Meter', type: 'number' },
  { k: 'devStage', label: 'Status', type: 'select', options: ['In Service', 'In Repair', 'Out of Service', 'Retired'] },

  { sec: 'Ownership' },
  { k: 'entity', label: 'Owner / Entity' },
  { k: 'manager', label: 'Assigned to / Operator' },
  { k: 'address', label: 'Home Base / Location', full: true },

  { sec: 'Insurance & Coverage' },
  { k: 'insCarrier', label: 'Carrier' },
  { k: 'insPolicy', label: 'Policy #' },
  { k: 'insExpiration', label: 'Policy Expiration', type: 'date' },
  { k: 'insAgent', label: 'Agent / Broker' },
  { k: 'insPhone', label: 'Agent Phone' },

  { sec: 'Notes' },
  { k: 'notes', label: 'Notes', type: 'textarea', full: true },
];

export const ASSET_SCHEMAS = { vehicle: VEHICLE_FIELDS, equipment: EQUIPMENT_FIELDS };

/** property (implicit default) | vehicle | equipment */
export function inferAssetKind(p) {
  if (!p) return 'property';
  if (p.kind) return p.kind;
  const a = String(p.assetType || '').toLowerCase();
  if (/vehicle/.test(a)) return 'vehicle';
  if (/equipment/.test(a)) return 'equipment';
  return 'property';
}

/**
 * Converts a flat `{sec,...}`-marked field schema (VEHICLE_FIELDS, EQUIPMENT_FIELDS, or
 * propertyFields.js's PROPERTY_WIZARD_FIELDS) plus a matching flat values object into the
 * grouped snapshot shape (`[{group, fields: [{label, value}]}]`) used elsewhere in the app for
 * display (e.g. PT-style rendering). Each `sec` marker starts a new group; fields before the
 * first `sec` fall into a generic "Details" group. Empty groups are dropped.
 *
 * Used by AddAssetModal when creating a new asset, so newly-created vehicles/equipment/
 * properties get a snapshot immediately, consistent with how existing assets are displayed.
 */
export function buildAssetSnapshot(schema, values) {
  const groups = [];
  let current = null;
  for (const f of schema) {
    if (f.sec) {
      current = { group: f.sec, fields: [] };
      groups.push(current);
      continue;
    }
    if (!current) {
      current = { group: 'Details', fields: [] };
      groups.push(current);
    }
    current.fields.push({ label: f.label, value: values[f.k] ?? '' });
  }
  return groups.filter((g) => g.fields.length);
}
