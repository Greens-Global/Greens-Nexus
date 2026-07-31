// Portfolio-wide roll-up stats, used in the main portfolio header strip (e.g. "12 assets · 3
// warranties active · 2 expiring soon"). Reads straight off the raw data store (properties +
// its child collections), not off any single asset.
//
// Also home to the per-asset compliance-signal helpers that back the Health Status strip
// (HealthStrip) on each asset detail page: snapMap (free-text snapshot -> label-keyed lookup),
// assetSignals (Insurance/Inspections/Permits/Debt for properties, Insurance/Registration/
// Service/Odometer for vehicles/equipment), freshTs/freshMeta (last-touched recency),
// assetCompleteness (Manage-page completeness %), and assetRank (default portfolio sort order).
//
// Also home to the Manage page's Data Completeness filter helpers: stageColor, assetTypeOf,
// assetRegionOf, categoryOf, cityRegion, searchHaystack.

import { daysUntil, formatDate, normLabel, toNumber, acresOf } from './format.js';
import { inferAssetKind, ASSET_SCHEMAS } from './vehicleFields.js';
import { baseStage } from './stages.js';

/**
 * Compute portfolio-wide summary stats from the full data store.
 * `store` shape: { properties, warranties, inspections, vendors, ahj, ... } - each a flat array.
 *
 * Returns:
 *   assets    - total property/asset count
 *   parcels   - same as assets today (kept distinct in case parcel grouping diverges later)
 *   warr      - warranties still active (expiration is today or in the future; expired excluded)
 *   insp      - inspections due within 60 days (includes overdue, since there's no lower bound)
 *   exp       - items expiring soon across warranties/vendors/AHJ (0–90 days out, inclusive)
 *   nrsf      - portfolio total building SF (sum of properties[].nrsf)
 *   units     - portfolio total unit count (sum of properties[].unitsTotal)
 *   acreage   - portfolio total acreage (sum of properties[].acreage)
 */
export function portfolioStats(store) {
  const activeWarranties = store.warranties.filter((w) => {
    const d = daysUntil(w.expiration);
    return d != null && d >= 0;
  }).length;

  const inspectionsDueSoon = store.inspections.filter((i) => {
    const d = daysUntil(i.nextDue);
    return d != null && d <= 60;
  }).length;

  const expiringSoon = [
    ...store.warranties.map((w) => daysUntil(w.expiration)),
    ...store.vendors.map((v) => daysUntil(v.coiExpiration)),
    ...store.ahj.map((a) => daysUntil(a.renewalDate)),
  ].filter((d) => d != null && d >= 0 && d <= 90).length;

  const sumField = (key) => store.properties.reduce((sum, p) => sum + toNumber(p[key]), 0);

  return {
    assets: store.properties.length,
    parcels: store.properties.length,
    warr: activeWarranties,
    insp: inspectionsDueSoon,
    exp: expiringSoon,
    nrsf: sumField('nrsf'),
    units: sumField('unitsTotal'),
    // Not sumField('acreage') - a property entered in SF must convert to acres first, or its
    // raw square-footage number would blow up the portfolio total.
    acreage: store.properties.reduce((sum, p) => sum + acresOf(p.acreage, p.acreageUnit), 0),
  };
}

// ------------------------------------------------------------------------------------------
// snapMap
// ------------------------------------------------------------------------------------------

/**
 * Flattens a property's grouped free-text `snapshot` (array of {group, fields:[{label,value}]})
 * into a single normalized-label -> value lookup map. This is how code reads an individual
 * snapshot field's value without caring which group it's displayed under (e.g. "Policy
 * Expiration" regardless of whether it's under Insurance or some renamed/reordered group).
 * Later duplicate labels win (object key overwrite) - snapshots are not expected to have
 * duplicate labels, but if they did, the last one in array order wins.
 */
export function snapMap(property) {
  const map = {};
  (property.snapshot || []).forEach((group) =>
    (group.fields || []).forEach((field) => {
      map[normLabel(field.label)] = field.value;
    })
  );
  return map;
}

// ------------------------------------------------------------------------------------------
// freshTs / freshMeta - "data freshness" (time since last edit)
// ------------------------------------------------------------------------------------------

/**
 * Latest activity-log timestamp for a given asset id, or null if the asset has no log entries.
 * `logs` is the app-wide flat activity/audit log array; each entry carries a `propertyId` FK.
 */
export function freshTs(logs, id) {
  let latest = null;
  for (const entry of logs || []) {
    if (entry.propertyId === id && (!latest || entry.ts > latest)) latest = entry.ts;
  }
  return latest;
}

/**
 * Turns a freshTs() timestamp into a display-ready { txt, tone } pair for a "last updated" chip.
 * Tone thresholds: fresh (<=30 days) = green, aging (<=120 days) = gold/amber, stale (>120 days)
 * or never-updated = muted grey.
 */
export function freshMeta(ts) {
  if (!ts) return { txt: 'Not yet updated', tone: 'mut' };
  const days = Math.floor((Date.now() - new Date(ts).getTime()) / 864e5);
  const tone = days <= 30 ? 'green' : days <= 120 ? 'gold' : 'mut';
  const rel = days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 30 ? days + 'd ago' : formatDate(ts);
  return { txt: 'Updated ' + rel, tone };
}

// ------------------------------------------------------------------------------------------
// assetSignals - per-asset health signal chips
// ------------------------------------------------------------------------------------------

/**
 * Computes the small set of "health signal" chips shown on an asset card/header, each shaped
 * { l: label, v: display value, t: tone } where tone is one of 'ok' | 'warn' | 'bad' | 'info' | 'mut'.
 *
 * Vehicles/equipment get a DIFFERENT signal set than properties (Insurance/Registration/Service/
 * Odometer vs. Insurance/Inspections/Permits/Debt) - the two branches are NOT the same logic with
 * different field names, they check different things entirely (e.g. vehicles have no concept of
 * "Permits" or "Debt/Loan maturity"; properties have no odometer).
 *
 * NOTE the threshold asymmetry: the vehicle/equipment branch flags insurance/registration as
 * "warn" inside 60 days of expiration, while the property branch uses a 90-day warn window for
 * insurance. This mirrors the original app exactly - it was not unified. Concretely: an asset
 * 75 days from insurance expiration shows "warn" (75d to renewal) if it's a property (75<=90),
 * but "ok" (Active) if it's a vehicle (75>60). Flagged here in case this divergence was
 * unintentional and worth unifying during handoff.
 */
export function assetSignals(asset, store) {
  if (inferAssetKind(asset) !== 'property') {
    // --- Vehicle / equipment signals: Insurance, Registration, Service, Odometer ---
    const snap = snapMap(asset);
    const signals = [];

    const insExpiration = snap['policy expiration'] || asset.insExpiration;
    const insDays = daysUntil(insExpiration);
    signals.push(
      insDays == null
        ? { l: 'Insurance', v: 'Not on file', t: 'mut' }
        : insDays < 0
        ? { l: 'Insurance', v: 'Lapsed', t: 'bad' }
        : insDays <= 60
        ? { l: 'Insurance', v: insDays + 'd to renewal', t: 'warn' }
        : { l: 'Insurance', v: 'Active', t: 'ok' }
    );

    const regExpiration = snap['registration expiration'];
    const regDays = daysUntil(regExpiration);
    signals.push(
      regDays == null
        ? { l: 'Registration', v: 'Not on file', t: 'mut' }
        : regDays < 0
        ? { l: 'Registration', v: 'Expired', t: 'bad' }
        : regDays <= 60
        ? { l: 'Registration', v: regDays + 'd left', t: 'warn' }
        : { l: 'Registration', v: 'Current', t: 'ok' }
    );

    const serviceRecords = (store.vservice || []).filter((x) => x.propertyId === asset.id);
    const nextServiceDue = snap['next service due'];
    const serviceDays = daysUntil(nextServiceDue);
    signals.push(
      serviceDays == null
        ? serviceRecords.length
          ? { l: 'Service', v: serviceRecords.length + ' on file', t: 'info' }
          : { l: 'Service', v: 'None logged', t: 'mut' }
        : serviceDays < 0
        ? { l: 'Service', v: 'Overdue', t: 'bad' }
        : serviceDays <= 30
        ? { l: 'Service', v: 'Due ' + serviceDays + 'd', t: 'warn' }
        : { l: 'Service', v: 'Current', t: 'ok' }
    );

    const odometerReadings = (store.odometer || []).filter((x) => x.propertyId === asset.id);
    const lastReadingDate = odometerReadings.map((x) => x.date).filter(Boolean).sort().pop();
    const daysSinceReading = lastReadingDate
      ? Math.floor((Date.now() - new Date(lastReadingDate).getTime()) / 864e5)
      : null;
    signals.push(
      daysSinceReading == null
        ? { l: 'Odometer', v: 'No reading', t: 'mut' }
        : daysSinceReading > 365
        ? { l: 'Odometer', v: 'Reading due', t: 'warn' } // required once a year
        : { l: 'Odometer', v: 'Current', t: 'ok' }
    );

    return signals;
  }

  // --- Property signals: Insurance, Inspections, Permits, Debt ---
  const signals = [];
  const snap = snapMap(asset);

  const insExpiration = asset.insExpiration || snap['policy expiration'];
  const insDays = daysUntil(insExpiration);
  signals.push(
    insDays == null
      ? { l: 'Insurance', v: 'Not on file', t: 'mut' }
      : insDays < 0
      ? { l: 'Insurance', v: 'Lapsed', t: 'bad' }
      : insDays <= 90
      ? { l: 'Insurance', v: insDays + 'd to renewal', t: 'warn' }
      : { l: 'Insurance', v: 'Active', t: 'ok' }
  );

  const inspections = (store.inspections || []).filter((x) => x.propertyId === asset.id);
  const dueDays = inspections.map((x) => daysUntil(x.nextDue)).filter((x) => x != null);
  const nearestDue = dueDays.length ? Math.min.apply(null, dueDays) : null;
  signals.push(
    !inspections.length
      ? { l: 'Inspections', v: 'None scheduled', t: 'mut' }
      : nearestDue == null
      ? { l: 'Inspections', v: inspections.length + ' on file', t: 'info' }
      : nearestDue < 0
      ? { l: 'Inspections', v: 'Overdue', t: 'bad' }
      : nearestDue <= 30
      ? { l: 'Inspections', v: 'Due ' + nearestDue + 'd', t: 'warn' }
      : { l: 'Inspections', v: 'Current', t: 'ok' }
  );

  const permits = asset.permits || [];
  // "In process" detection is a loose regex over the whole permit record's JSON - catches any
  // status-like field (whatever it's called) containing one of these words, rather than relying
  // on a single known status field name/shape.
  const inProcessCount = permits.filter((x) =>
    /open|process|in review|pending|violation|submitted|out to applicant/i.test(JSON.stringify(x).toLowerCase())
  ).length;
  signals.push(
    !permits.length
      ? { l: 'Permits', v: 'None tracked', t: 'mut' }
      : inProcessCount
      ? { l: 'Permits', v: inProcessCount + ' in process', t: 'info' }
      : { l: 'Permits', v: permits.length + ' on file', t: 'ok' }
  );

  const maturityDate = snap['maturity date'];
  const maturityDays = daysUntil(maturityDate);
  signals.push(
    !maturityDate
      ? { l: 'Debt', v: 'None recorded', t: 'mut' }
      : maturityDays < 0
      ? { l: 'Debt', v: 'Matured', t: 'bad' }
      : { l: 'Debt', v: 'Matures ' + formatDate(maturityDate), t: maturityDays <= 180 ? 'warn' : 'ok' }
  );

  return signals;
}

// ------------------------------------------------------------------------------------------
// assetCompleteness - completeness % calculator for the Manage page
// ------------------------------------------------------------------------------------------

/**
 * Returns { pct, missing } - a completeness percentage (0-100, rounded) and the list of missing
 * field labels, used by the Manage page to show data-quality progress per asset.
 *
 * Vehicles/equipment: checks every non-section-header field in that kind's flat ASSET_SCHEMAS
 * entry (VEHICLE_FIELDS/EQUIPMENT_FIELDS) for a non-empty top-level value, plus a synthetic
 * "Photos" check (images array non-empty or a single `image` set).
 *
 * Properties: checks a fixed curated list of the fields considered essential - NOT every PT
 * field (there are dozens; most are optional/situational). The essential list differs for
 * assembled/grouped parcels (`p.assembled && p.parentId` - a secondary parcel folded into an
 * assemblage) vs. standalone properties: an assembled parcel is checked for its own
 * address/city/state/zip/APN/lot-size/acquisition/zoning (things that are genuinely per-parcel),
 * while a standalone property is instead checked for entity/manager/insurance-carrier/map-link -
 * fields that make sense to require once per asset rather than once per parcel-in-a-group.
 */
export function assetCompleteness(property) {
  if (inferAssetKind(property) !== 'property') {
    const schema = ASSET_SCHEMAS[inferAssetKind(property)] || [];
    const fields = schema.filter((f) => !f.sec); // drop { sec: '...' } section-header markers
    const missing = fields.filter((f) => !String(property[f.k] || '').trim()).map((f) => f.label);
    const hasPhoto = (property.images && property.images.length) || property.image;
    if (!hasPhoto) missing.push('Photos');
    const total = fields.length + 1; // +1 for the synthetic Photos check
    const filled = total - missing.length;
    return { pct: Math.round((filled / total) * 100), missing };
  }

  const snap = snapMap(property);
  const snapVal = (label) => String(snap[normLabel(label)] || '').trim();

  const isAssembledSecondaryParcel = property.assembled && property.parentId;
  const CHECK = isAssembledSecondaryParcel
    ? [
        ['Property Address', property.address],
        ['City', property.city],
        ['State', property.state],
        ['Zip', property.zip],
        ['APN', snapVal('APN')],
        ['Lot Size', snapVal('Lot Size')],
        ['Acquisition Date', snapVal('Acquisition Date')],
        ['Acquisition Price', snapVal('Acquisition Price')],
        ['Zoning', snapVal('Zoning')],
      ]
    : [
        ['Property Address', property.address],
        ['City', property.city],
        ['State', property.state],
        ['Zip', property.zip],
        ['Acquisition Date', snapVal('Acquisition Date')],
        ['Acquisition Price', snapVal('Acquisition Price')],
        ['Ownership Entity', property.entity || snapVal('Ownership Entity')],
        ['PM / Asset Manager', property.manager || snapVal('PM / Asset Manager')],
        ['Insurance Carrier', snapVal('Carrier') || snapVal('Insurance Carrier')],
        ['Google Maps Link', property.mapUrl || snapVal('Google Maps Link')],
      ];

  const missing = CHECK.filter((c) => !String(c[1] || '').trim()).map((c) => c[0]);
  const hasPhoto = (property.images && property.images.length) || property.image;
  if (!hasPhoto) missing.push('Photos');
  const total = CHECK.length + 1;
  const filled = total - missing.length;
  return { pct: Math.round((filled / total) * 100), missing };
}

// ------------------------------------------------------------------------------------------
// assetRank - default portfolio sort order
// ------------------------------------------------------------------------------------------

/**
 * Returns a bucket number (0-6, lower sorts first) used as the default portfolio sort key.
 * Business priority order, lowest (most important to see first) to highest:
 *   0. Self-storage properties in California
 *   1. Self-storage properties in Texas
 *   2. Any other property in California
 *   3. Any other property anywhere else in the USA
 *   4. Properties in India
 *   5. Private (officer residence) properties
 *   6. Vehicles / equipment (always last, regardless of anything else)
 *
 * Note the check ORDER matters and is NOT purely "most specific wins": a private property in
 * California that also happens to read as self-storage would still land in bucket 5 (private),
 * NOT bucket 0 - `p.private` is checked before the storage/state logic. Similarly, an India
 * property is bucketed by country/address text match BEFORE the storage/CA/TX checks, so a
 * (hypothetical) self-storage facility in India sorts into bucket 4, not bucket 0/1. Vehicles/
 * equipment short-circuit to bucket 6 before any of this even runs. Within a bucket, ties are
 * broken by whatever secondary sort the caller applies (assetRank only assigns the bucket, it
 * does not sort within it - check the call site's sort comparator for tie-breaking behavior).
 */
export function assetRank(property) {
  if (inferAssetKind(property) !== 'property') return 6;
  if (property.private) return 5;

  const searchText = `${property.type || ''} ${property.name || ''}`.toLowerCase();
  const isStorage = /storage/.test(searchText);
  const state = String(property.state || '').trim().toUpperCase();
  const isIndia = /india/i.test(`${property.country || ''} ${property.address || ''}`);

  if (isIndia) return 4;
  if (isStorage && state === 'CA') return 0;
  if (isStorage && state === 'TX') return 1;
  if (state === 'CA') return 2;
  return 3;
}

// ------------------------------------------------------------------------------------------
// Manage page - Data Completeness tab filter helpers
// ------------------------------------------------------------------------------------------

/** devStage's base value (see baseStage in ./stages.js) -> tone color for the stage badge/bar. */
export function stageColor(devStage) {
  const stage = baseStage(devStage);
  if (stage === 'On Hold') return 'red';
  if (stage === 'Stabilized') return 'green';
  if (stage === 'Lease-Up') return 'gold';
  if (stage === 'Construction') return 'orange';
  if (stage === 'Construction Drawings' || stage === 'Entitlement') return 'blue';
  if (stage === 'In Escrow') return 'purple';
  return 'gold';
}

// Reads a snapshot field's value by label, independent of which group it lives under.
function snapField(property, label) {
  for (const group of property.snapshot || []) {
    for (const field of group.fields || []) {
      if ((field.label || '').trim().toLowerCase() === label.toLowerCase()) return field.value || '';
    }
  }
  return '';
}

/**
 * "Asset Type" for the Manage page filter dropdown - a human-readable use classification
 * (Office / Medical, Retail, Self-Storage, Vehicle Storage, Mixed-Use, Residential, Land,
 * Other), inferred from `assetType` if set, else from the snapshot's Proposed Use / Current
 * Use free-text fields via keyword matching. Proposed Use wins over Current Use when both
 * would classify (e.g. a self-storage facility under construction that's currently vacant land).
 */
export function assetTypeOf(property) {
  if (property.assetType) return property.assetType === 'RV Storage' ? 'Vehicle Storage' : property.assetType;

  const classify = (raw) => {
    const text = (raw || '').toLowerCase();
    if (!text.trim()) return '';
    if (/office|medical/.test(text)) return 'Office / Medical';
    if (/retail|taco|drive/.test(text)) return 'Retail';
    if (/\brv\b|vehicle stor/.test(text)) return 'Vehicle Storage';
    if (/storage|mini storage/.test(text)) return 'Self-Storage';
    if (/residential|single family|dwelling/.test(text) && /commerc/.test(text)) return 'Mixed-Use';
    if (/residential|single family|dwelling/.test(text)) return 'Residential';
    if (/commerc/.test(text)) return 'Retail';
    if (/vacant|land|stock pil|parking/.test(text)) return 'Land';
    return 'Other';
  };

  return classify(snapField(property, 'Proposed Use')) || classify(snapField(property, 'Current Use')) || '';
}

/** "Region" for the Manage page filter dropdown - the 2-letter state code (or full value if the
 *  state field isn't a recognized 2-letter code), falling back to parsing a state code out of
 *  the free-text address ("..., CA 92024" style). */
export function assetRegionOf(property) {
  const state = String(property.state || '').trim();
  if (state) return state.length === 2 ? state.toUpperCase() : state;
  const match = String(property.address || '').match(/,\s*([A-Za-z]{2})\s+\d{5}/);
  return match ? match[1].toUpperCase() : '';
}

/** Broad top-level options for the "All Categories" filter dropdown. */
export const ASSET_CATEGORIES = ['Commercial', 'Residential', 'Industrial', 'Vehicles', 'Heavy Equipment'];

/**
 * "Category" for the Manage page filter dropdown - one of ASSET_CATEGORIES. Vehicles/equipment
 * are classified straight from their kind; properties are classified by keyword-matching a blob
 * built from type/parcelRole/Proposed Use/Current Use/name. Residential only wins over Commercial
 * when residential-ish keywords match AND no commercial-ish keyword also matches (a property that
 * mentions both, e.g. "mixed-use residential over retail," is filed under Commercial).
 */
export function categoryOf(asset) {
  if (/vehicle/i.test(asset.assetType || asset.kind || '')) return 'Vehicles';
  if (/equipment/i.test(asset.assetType || asset.kind || '')) return 'Heavy Equipment';

  const text = `${asset.type || ''} ${asset.parcelRole || ''} ${snapField(asset, 'Proposed Use')} ${snapField(asset, 'Current Use')} ${asset.name || ''}`.toLowerCase();
  if (/industrial|warehouse|distribution|manufactur/.test(text)) return 'Industrial';

  const looksResidential = /residential|single family|dwelling|residence|\bhome\b|apartment|duplex|\bfamily\b/.test(text);
  const looksCommercial = /commerc|commeric|retail|office|medical|storage|\brv\b|hospitality|hotel|motel|\binn\b|restaurant|mixed.?use|bank/.test(text);
  return looksResidential && !looksCommercial ? 'Residential' : 'Commercial';
}

/**
 * "City, State" (or "City, State, India" for Indian properties) display string for an asset,
 * parsed out of the free-text address when the structured city/state fields are blank. Strips
 * "City/Town/County of" prefixes. This is best-effort text parsing, not a geocoder - it looks
 * for a 2-letter state code or 5-digit zip token in the comma-split address parts to figure out
 * which segment is the city.
 */
export function cityRegion(asset) {
  const clean = (s) => String(s || '').replace(/^\s*(city|town|county)\s+of\s+/i, '').trim();
  const address = String(asset.address || '').trim();
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  const isIndia = /\bindia\b/i.test(address);
  let city = clean(asset.city);
  let state = (s => (s.length === 2 ? s.toUpperCase() : s))(String(asset.state || '').trim());

  if (isIndia) {
    const idx = parts.findIndex((p) => /india/i.test(p));
    if (!city) city = idx > 0 ? parts[idx - 1] : parts[0] || '';
    return [clean(city), state, 'India'].filter(Boolean).join(', ');
  }

  if (!state) {
    const m = address.match(/\b([A-Za-z]{2})\b(?:[ ,]+\d{5}(?:-\d{4})?)?\s*$/);
    if (m) state = m[1].toUpperCase();
  }
  if (!city) {
    const idx = parts.findIndex((p) => /^[A-Za-z]{2}(?:[ ,]+\d{5}(?:-\d{4})?)?$/.test(p) || /^\d{5}(?:-\d{4})?$/.test(p));
    city = idx > 0 ? parts[idx - 1] : parts.length >= 2 ? parts[parts.length - 2] : parts[0] || '';
  }
  return [clean(city), state].filter(Boolean).join(', ');
}

// 2-letter state/territory code -> full name, used by searchHaystack() to widen search matching
// so "Texas" and "TX" both find the same assets.
export const US_ST = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'Washington DC',
};

/**
 * Builds a space-joined "search haystack" of state name/abbreviation variants for an asset, so
 * a free-text search for "Texas" also matches assets whose state field just says "TX" (and vice
 * versa). Includes any 2-letter state codes found loose in the address text too (e.g. a
 * "..., CA 92024" address contributes both "CA" and "California").
 */
export function searchHaystack(asset) {
  const out = [];
  const state = String(asset.state || '').trim();
  if (state) {
    out.push(state);
    const upper = state.toUpperCase();
    if (US_ST[upper]) out.push(US_ST[upper]);
    const reverseMatch = Object.keys(US_ST).find((code) => US_ST[code].toLowerCase() === state.toLowerCase());
    if (reverseMatch) out.push(reverseMatch);
  }
  const codesInAddress = String(asset.address || '').match(/\b[A-Z]{2}\b/g);
  if (codesInAddress) {
    codesInAddress.forEach((code) => {
      if (US_ST[code]) { out.push(US_ST[code]); out.push(code); }
    });
  }
  return out.join(' ');
}
