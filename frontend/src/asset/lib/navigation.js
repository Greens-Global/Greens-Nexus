// Tab navigation config for the asset detail page.
//
// TAB_LIST is the label lookup for every view key the detail page can hold; the
// strip itself is stripTabsFor() and the record collections RECORD_VIEWS below.
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

// The detail page's strip (Neil, Oct 21 2026): Overview, Maintenance, Records,
// Timeline for a property; Overview, Records for a vehicle or equipment. The
// record collections - seven identical tables for a property, three for a
// vehicle - live under ONE Records tab with a segmented control; `view` still
// holds the collection key, so every deep link (bells, Critical Items, the
// Activity Log's "Go to") lands on the right table unchanged.
export const RECORD_VIEWS = {
  property: ['warranties', 'inspections', 'documents', 'utilities', 'ahj', 'vendors', 'permit'],
  vehicle: ['vservice', 'odometer', 'vdocs'],
};
export function recordViewsFor(assetKind) {
  return assetKind === 'property' ? RECORD_VIEWS.property : RECORD_VIEWS.vehicle;
}
export function stripTabsFor(assetKind) {
  return assetKind === 'property'
    ? [['property', 'Overview'], ['maintenance', 'Maintenance'], ['records', 'Records'], ['timeline', 'Timeline']]
    : [['property', 'Overview'], ['records', 'Records']];
}
/** A record collection's segment label: short, Title Case. */
export function recordLabel(key) {
  return { vservice: 'Service', vdocs: 'Documents', permit: 'Permits' }[key] || (TAB_LIST.find(([k]) => k === key) || [])[1] || key;
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
  Maintenance: 'maintenance',
  'Service & Maintenance': 'vservice',
  'Odometer Log': 'odometer',
  Documents: 'vdocs',
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
