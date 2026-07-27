// PT — the property spec-sheet schema. Drives both the grouped read-only display and the
// inline "Edit Details" form for real-estate assets. Order here is display order.
//
// Field shape: { label, key?, type?, dev?, cls?, contact?, team? }
//   - key:     when present, this field maps to a top-level property record field (p[key]).
//              When absent, the field's value only lives in the free-text snapshot group
//              (label-keyed, via normLabel() matching) — see snapMap()/normLabel in ./format.js.
//   - type:    'date' | 'money' | 'pct' | 'num' | 'stage' — drives input control + formatting.
//   - dev:     hidden once the asset's devStage normalizes to "Stabilized", unless actively editing.
//   - cls:     gates the field/group to specific asset classes (e.g. 'storage', 'income',
//              'selfstorage') — see okC() classification in this file.
//   - team:    marks the "Project Team" group, whose fields render as contact cards (ContactCell)
//              instead of plain text when filled in.
//   - contact: this individual field is a contact (name/company) eligible for the ContactCell
//              expand-to-phone/email treatment.
//   - unitKey/unitLabel: pairs this field with a companion unit-picker field (see Lot Size
//              below) — unitKey is the companion's top-level record key, unitLabel its PT
//              field label, so AssetDetailForm can render/save it inline as a dropdown.
//   - hidden:  a real PT field (persists, undoes) that never renders its own row — it's
//              folded into another field's row via that field's unitKey/unitLabel.

export const PT = [
  {
    group: 'Project Details',
    fields: [
      { label: 'Project Name', key: 'name' },
      { label: 'Property Address', key: 'address' },
      { label: 'Ownership Entity', key: 'entity' },
      { label: 'City', key: 'city' },
      { label: 'County', key: 'county' },
      { label: 'State', key: 'state' },
      { label: 'Zip', key: 'zip' },
      { label: 'Country', key: 'country' },
      { label: 'APN', key: 'apn' },
      { label: 'Google Maps Link', key: 'mapUrl' },
      { label: 'Legal Description' },
      { label: 'Current Use' },
      { label: 'Proposed Use', dev: true },
      { label: 'Development Stage', type: 'stage', dev: true },
    ],
  },
  {
    group: 'Unit Mix',
    cls: 'storage',
    fields: [
      { label: 'Climate-Controlled Units', type: 'num', key: 'unitsClimate', cls: 'selfstorage' },
      { label: 'Non-Climate Units', type: 'num', key: 'unitsNonClimate', cls: 'selfstorage' },
      { label: 'Vehicle Storage Spaces', type: 'num', key: 'unitsRV', cls: 'storage' },
      { label: 'Total Storage Units', type: 'num', key: 'unitsTotal', cls: 'storage' },
      { label: 'Residential Units', type: 'num', key: 'unitsResidential', cls: 'storage' },
      { label: 'Commercial Units', type: 'num', key: 'unitsCommercial', cls: 'storage' },
      { label: 'Mailbox Units', type: 'num', key: 'unitsMailbox', cls: 'storage' },
      { label: 'Other Units', type: 'num', key: 'unitsOther', cls: 'storage' },
    ],
  },
  {
    group: 'Financial & Investment',
    fields: [
      { label: 'Acquisition Date', type: 'date' },
      { label: 'Acquisition Price', type: 'money' },
      { label: 'Total Cost Basis', type: 'money' },
      { label: 'Current / Appraised Value', type: 'money' },
      { label: 'Valuation Date', type: 'date' },
      { label: 'Going-in Cap Rate', type: 'pct' },
      { label: 'Current Cap Rate', type: 'pct' },
      { label: 'NOI (In-Place)', type: 'money' },
      { label: 'NOI (Pro Forma)', type: 'money' },
      { label: 'Occupancy %', type: 'pct' },
      { label: 'Hold Strategy' },
      { label: 'Target Hold (yrs)' },
      { label: 'Projected IRR', type: 'pct' },
      { label: 'Equity Multiple' },
    ],
  },
  {
    group: 'Financing & Debt',
    fields: [
      { label: 'Lender' },
      { label: 'Loan Number' },
      { label: 'Original Balance', type: 'money' },
      { label: 'Current Balance', type: 'money' },
      { label: 'Interest Rate', type: 'pct' },
      { label: 'Rate Type' },
      { label: 'Maturity Date', type: 'date' },
      { label: 'Amortization' },
      { label: 'LTV', type: 'pct' },
      { label: 'DSCR' },
      { label: 'Recourse' },
      { label: 'Prepay / Lockout' },
    ],
  },
  {
    group: 'Leasing & Tenancy',
    cls: 'income',
    fields: [
      { label: 'Tenant' },
      { label: 'Lease Structure' },
      { label: 'Commencement', type: 'date' },
      { label: 'Expiration', type: 'date' },
      { label: 'Base Rent (Annual)', type: 'money' },
      { label: 'Rent PSF' },
      { label: 'Escalations' },
      { label: 'Renewal Options' },
      { label: 'Guarantor' },
      { label: 'WALT (yrs)' },
      { label: 'Leased Occupancy', type: 'pct' },
    ],
  },
  {
    group: 'Insurance',
    fields: [
      { label: 'Carrier' },
      { label: 'Policy Number' },
      { label: 'Coverage' },
      { label: 'Policy Expiration', type: 'date' },
      { label: 'Agent / Broker' },
      { label: 'Agent Phone' },
    ],
  },
  {
    group: 'Property Tax',
    fields: [
      { label: 'Tax / Parcel Account' },
      { label: 'Assessed Value', type: 'money' },
      { label: 'Annual Tax', type: 'money' },
      { label: 'Tax Rate' },
      { label: 'Due Dates', type: 'dates' },
    ],
  },
  {
    group: 'Project Team',
    team: true,
    fields: [
      { label: 'PM / Asset Manager', key: 'manager', contact: true },
      { label: 'Developer / Sponsor', contact: true },
      { label: 'Seller (If Applicable)' },
      { label: 'General Contractor', contact: true },
      { label: 'Construction Manager', contact: true },
      { label: 'Project Manager (If Applicable)', contact: true },
      { label: 'Architect', contact: true },
      { label: 'Civil Engineer', contact: true },
      { label: 'Structural Engineer', contact: true },
      { label: 'MEP Engineer', contact: true },
      { label: 'Land Use Attorney', contact: true },
      { label: 'Title Officer', contact: true },
      { label: 'Escrow Company', contact: true },
    ],
  },
  {
    group: 'Site Data',
    fields: [
      { label: 'Lot Size (SF / Acres)', key: 'acreage', unitKey: 'acreageUnit', unitLabel: 'Lot Size Unit' },
      // Companion to the field above — the SF/Acres picker. A real PT field (so it persists
      // and undoes like any other), but `hidden` keeps it out of its own row: AssetDetailForm
      // renders it as a dropdown alongside the Lot Size input instead.
      { label: 'Lot Size Unit', key: 'acreageUnit', hidden: true },
      { label: 'Dimensions' },
      { label: 'Topography' },
      { label: 'Access Points' },
      { label: 'Street Frontage' },
      { label: 'Easements / Encroachments' },
      { label: 'Flood Zone', key: 'floodZone' },
      { label: 'Soils / Geotech Notes' },
    ],
    // Note: this group used to be dev-gated (hidden once Stabilized) — that hid it on most of
    // the portfolio since most storage assets are Stabilized. Fixed: lot size/easements/flood
    // zone stay useful reference info after stabilization, so no `dev` flag here.
  },
  {
    group: 'Zoning + Land Use',
    dev: true,
    fields: [
      { label: 'Jurisdiction' },
      { label: 'General Plan' },
      { label: 'Zoning', key: 'zoning' },
      { label: 'Overlays / Specific Plan' },
      { label: 'Height / FAR Limits' },
      { label: 'Setbacks (F/S/R)' },
      { label: 'Parking Required' },
      { label: 'Design Review / CUP / Variance' },
    ],
  },
  {
    group: 'Existing Improvements',
    fields: [
      { label: 'Existing Structures' },
      { label: 'Existing Building SF', key: 'nrsf' },
      { label: 'Year Built', key: 'yearBuilt' },
      { label: 'Occupancy (Vacant/Tenant)' },
      { label: 'Demo Needed', dev: true },
      { label: 'Known Issues / Violations' },
    ],
  },
];

// Options for PROPERTY_WIZARD_FIELDS' Asset Type / Development Stage selects.
export const ASSET_TYPE_OPTIONS = ['Self-Storage', 'Vehicle Storage', 'Retail', 'Office / Medical', 'Residential', 'Mixed-Use', 'Land', 'Vehicle', 'Heavy Equipment', 'Other'];
export const DEV_STAGE_OPTIONS = ['In Escrow', 'Entitlement', 'Construction Drawings', 'Construction', 'Lease-Up', 'Stabilized', 'Stabilized — Renovation', 'Stabilized — Expansion', 'Stabilized — Capital Improvement', 'Stabilized — Repositioning', 'Stabilized — Re-Tenanting', 'On Hold'];

// PROPERTY_WIZARD_FIELDS — the FLAT schema used by the Add Asset wizard's guided property form
// (step 1 when Asset class = Property). Unlike PT above (a grouped display/inline-edit schema
// where most fields live only in the free-text snapshot), every field here has a `k` and maps
// directly to a top-level field on the new property record — same flat shape as
// VEHICLE_FIELDS/EQUIPMENT_FIELDS in vehicleFields.js, so the wizard can treat all three asset
// classes uniformly. On save, AddAssetModal converts this flat data into PT's grouped snapshot
// shape via buildAssetSnapshot().
export const PROPERTY_WIZARD_FIELDS = [
  { sec: 'Identity & Ownership' },
  { k: 'name', label: 'Property / Parcel Name', req: true },
  { k: 'parentId', label: 'Role — leave blank for a PRIMARY asset, or pick the primary to make this a SECONDARY linked under it', type: 'select', dynamic: 'primaries' },
  { k: 'parcelRole', label: 'Parcel Role (E.g. Vehicle Yard, Detention, Outparcel)' },
  { k: 'entity', label: 'Operating Entity' },
  { k: 'builder', label: 'Builder (GC)' },
  { k: 'manager', label: 'PM / Asset Manager' },
  { k: 'address', label: 'Street Address', req: true },
  { k: 'city', label: 'City' },
  { k: 'state', label: 'State' },
  { k: 'zip', label: 'ZIP' },
  { k: 'county', label: 'County' },
  { k: 'apn', label: 'APN' },
  { k: 'legalDesc', label: 'Legal Description', full: true },

  { sec: 'Building & Site' },
  { k: 'assetType', label: 'Asset Type', type: 'select', options: ASSET_TYPE_OPTIONS },
  { k: 'devStage', label: 'Development Stage', type: 'select', options: DEV_STAGE_OPTIONS },
  { k: 'yearBuilt', label: 'Year Built' },
  { k: 'constructionType', label: 'Construction Type' },
  { k: 'stories', label: 'Stories', type: 'number' },
  { k: 'nrsf', label: 'NRSF', type: 'number' },
  { k: 'gsf', label: 'GSF', type: 'number' },
  { k: 'acreage', label: 'Acreage', type: 'number' },
  { k: 'zoning', label: 'Zoning / Land Use' },
  { k: 'floodZone', label: 'Flood Zone' },
  { k: 'sprinklered', label: 'Sprinklered' },
  { k: 'alarmMonitored', label: 'Alarm Monitored' },

  { sec: 'Placed in Service' },
  { k: 'placedInService', label: 'Placed-in-service Date', type: 'date' },
  { k: 'coNumber', label: 'CO Number' },
  { k: 'coDate', label: 'CO Date', type: 'date' },

  { sec: 'Unit Mix' },
  { k: 'unitsNonClimate', label: 'Non-climate Units', type: 'number' },
  { k: 'unitsClimate', label: 'Climate Units', type: 'number' },
  { k: 'unitsRV', label: 'Vehicle Spaces', type: 'number' },
  { k: 'unitsTotal', label: 'Total Units', type: 'number' },
  { k: 'unitsResidential', label: 'Residential Units', type: 'number' },
  { k: 'unitsCommercial', label: 'Commercial Units', type: 'number' },
  { k: 'unitsMailbox', label: 'Mailbox Units', type: 'number' },
  { k: 'unitsOther', label: 'Other Units', type: 'number' },

  { sec: 'Insurance' },
  { k: 'insCarrier', label: 'Carrier' },
  { k: 'insPolicy', label: 'Policy #' },
  { k: 'insExpiration', label: 'Policy Expiration', type: 'date' },
  { k: 'insAgent', label: 'Agent / Broker' },
  { k: 'insPhone', label: 'Agent Phone' },

  { sec: 'Property Tax' },
  { k: 'taxId', label: 'Tax Account #' },
  { k: 'taxAnnual', label: 'Annual Tax ($)', type: 'number' },
  { k: 'taxDue', label: 'Due Dates', type: 'dates' },

  { sec: 'Notes' },
  { k: 'notes', label: 'Notes', type: 'textarea', full: true },
];
