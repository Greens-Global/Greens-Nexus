// Tab navigation config for the asset detail page.
//
// TAB_LIST order matters: it's the literal left-to-right tab order. Property-only tabs
// (maintenance, inspections, warranties, documents, utilities, ahj, vendors, permit, timeline)
// and vehicle/equipment-only tabs (vservice, odometer, vdocs) are filtered per-asset-kind at
// render time - see visibleTabsFor() below.
export const TAB_LIST = [
  ['portfolio', 'Portfolio'],
  ['property', 'Overview'],
  ['vservice', 'Service & Maintenance'],
  ['odometer', 'Odometer'],
  ['maintenance', 'Maintenance'],
  ['inspections', 'Inspections'],
  ['warranties', 'Warranties'],
  ['documents', 'Plans & Docs'],
  ['vdocs', 'Documents'],
  ['utilities', 'Utilities'],
  ['ahj', 'AHJ'],
  ['vendors', 'Vendors'],
  ['permit', 'Permits'],
  ['timeline', 'Timeline'],
];

const VEHICLE_ONLY_TABS = ['vservice', 'odometer', 'vdocs'];

/** Real-estate assets see every tab except the vehicle-only ones (and vice versa). */
export function visibleTabsFor(assetKind) {
  return TAB_LIST.filter(([key]) => key !== 'portfolio' && (
    assetKind === 'property' ? !VEHICLE_ONLY_TABS.includes(key) : VEHICLE_ONLY_TABS.concat('property').includes(key)
  ));
}

/** Which tabs share ONE search/filter box (e.g. timeline+permit are two views of one query). */
export const SHARED_FILTER_GROUPS = { timeline: ['timeline'], permit: ['permit'] };

/** Maps an activity-log entry's `section` back to the tab key it should deep-link to. */
export const LOG_SECTION_TO_TAB = {
  Property: 'property',
  Warranties: 'warranties',
  Inspections: 'inspections',
  'Plans & Documents': 'documents',
  'Authorities Having Jurisdiction': 'ahj',
  Utilities: 'utilities',
  Vendors: 'vendors',
  Timeline: 'timeline',
  Permit: 'permit',
  Linking: 'property',
};

/** Undo support: maps a spec-sheet field LABEL back to its top-level record KEY, so an
 *  "edited" log entry can be reverted. Only fields that live on the top-level record (not
 *  free-text-only snapshot fields) are undo-able. */
export const UNDOABLE_FIELD_KEYS = {
  'Project Name': 'name',
  'Property Address': 'address',
  'Ownership Entity': 'entity',
  City: 'city',
  County: 'county',
  State: 'state',
  Zip: 'zip',
  Country: 'country',
  APN: 'apn',
  'Google Maps Link': 'mapUrl',
  'Development Stage': 'devStage',
  'Lot Size (SF / Acres)': 'acreage',
  'Lot Size Unit': 'acreageUnit',
  'Existing Building SF': 'nrsf',
  'Year Built': 'yearBuilt',
  Zoning: 'zoning',
  'Flood Zone': 'floodZone',
  Private: 'private',
};

/** Stage badge tone. Compound stages ("Stabilized - Renovation") use the base stage's tone. */
export function stageTone(stage) {
  const base = stage.split(/\s+[-–-]+\s+/)[0].trim();
  if (base === 'On Hold') return 'red';
  if (base === 'Stabilized') return 'green';
  if (base === 'Lease-Up') return 'gold';
  if (base === 'Construction') return 'orange';
  if (base === 'Construction Drawings' || base === 'Entitlement') return 'blue';
  if (base === 'In Escrow') return 'purple';
  return 'gold';
}

/** Generic status-word tone (Complete/In Progress/Pending/other), used by the Timeline tab. */
export function wordStatusTone(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('complete')) return 'green';
  if (s.includes('progress')) return 'blue';
  if (s.includes('pending')) return 'gold';
  return 'mut';
}
