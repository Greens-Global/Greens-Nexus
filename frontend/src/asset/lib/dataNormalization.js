// Data normalization for the asset workspace: two passes that run on every
// load from the server or the local cache.
//   - healPropTeam: migrates legacy "Project Team" snapshot field labels and
//     contacts to the current vocabulary.
//   - splitAddress: peels a "City, ST ZIP" tail (often doubled by the old
//     import) off the free-text address into city / state / zip / county, so
//     `address` is the street line everywhere.
//   - VNORM: the workspace-level normalizer (every property through
//     healPropTeam and splitAddress plus the stale-term renames) - the one
//     entry point useNexusStore calls.
// The seed-merge pass and the one-off overrides that used to live here were
// deleted on Oct 21 2026 with the bundled seed files: nothing imported them.

import { normLabel } from './format.js';

// ------------------------------------------------------------------------------------------
// healPropTeam
// ------------------------------------------------------------------------------------------

// Legacy "Project Team" snapshot field label -> current label(s) it should be split/renamed
// into. Some legacy labels expand into MULTIPLE current fields (e.g. one old combined
// "GC / CM" field becomes two distinct fields today) - when that happens the old field's
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

  // Drop the defunct "Service & Maintenance" snapshot group entirely - superseded by the
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
 * current in-memory state - both the initial load reconcile AND the background server-pull path.
 * Missing it on one path means data arriving via that path silently keeps stale labels/legacy
 * Project Team fields. (See "Two Load Paths" - localStorage-driven load vs. server reconcile -
 * this normalizer belongs on both.)
 *
 * Idempotent and returns the original object unchanged if nothing needed normalizing.
 */
const ZIP_RE = /^\d{5}(?:-\d{4})?$/;
const STATE_ZIP_RE = /^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/;
// A bare two-letter segment is a state only when it IS one - "1600 Pennsylvania
// Ave, NW" keeps its quadrant, "..., UK" keeps its country.
const US_STATES = new Set(('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR GU VI AS MP').split(' '));
const isState = (seg) => US_STATES.has(seg.toUpperCase());
const US_COUNTRY = /^(us|usa|united states|united states of america)$/i;
const isForeign = (country) => !!String(country || '').trim() && !US_COUNTRY.test(String(country).trim());
// Not a city: a unit / building / lot line sitting before the state.
const UNIT_RE = /^(suite|ste\.?|unit|apt\.?|bldg\.?|building|floor|fl\.?|lot|#)\b/i;
const sameCity = (segment, city) => {
  const t = segment.toLowerCase();
  const c = String(city || '').toLowerCase().replace(/^\s*(city|town)\s+of\s+/, '').trim();
  return !!c && (t === c || t === `city of ${c}` || t === `town of ${c}`);
};

/**
 * Splits a free-text address into its street line and city / state / zip / county.
 * The old imports stored "123 Main St, Escondido, CA 92026, Escondido, CA, 92026"
 * in `address` with the city, state and zip ALSO in their own fields, so the
 * street showed the tail twice. Segments are peeled from the end while they are
 * a zip, a state (with or without its zip), the known city, or a county; a
 * segment just before a state is taken as the city when none is known. Returns
 * the row itself (`===`) when nothing changes, so VNORM can skip it.
 */
export function splitAddress(property) {
  const address = String(property?.address ?? '');
  if (!address.includes(',') || isForeign(property.country)) return property;
  const segments = address.split(',').map((x) => x.trim()).filter(Boolean);
  let city = String(property.city || '').trim();
  let state = String(property.state || '').trim();
  let zip = String(property.zip || '').trim();
  let county = String(property.county || '').trim();
  let end = segments.length;
  const peek = () => (end > 0 ? segments[end - 1] : '');
  for (;;) {
    const seg = peek();
    if (!seg || end <= 1 && !city && !state) break;
    let m;
    if (US_COUNTRY.test(seg)) { end--; continue; }
    if (ZIP_RE.test(seg)) { zip ||= seg; end--; continue; }
    if ((m = seg.match(STATE_ZIP_RE)) && isState(m[1])) { state ||= m[1].toUpperCase(); zip ||= m[2]; end--; continue; }
    if (isState(seg) && (!state || seg.toUpperCase() === state.toUpperCase())) { state ||= seg.toUpperCase(); end--; continue; }
    // The city is eaten down to an empty street only for a plain "City, ST" -
    // "Escondido, Escondido, CA" keeps its first segment as the street.
    if (sameCity(seg, city) && (end > 1 || segments.length <= 2)) { end--; continue; }
    if (/^county\s+of\s+/i.test(seg) || /\bcounty$/i.test(seg)) { county ||= seg.replace(/^county\s+of\s+/i, '').replace(/\s+county$/i, ''); end--; continue; }
    // The segment right before a state is the city when the row has none yet -
    // never the first segment (that is the street) and never a unit line.
    if (!city && state && end > 1 && end < segments.length && !/\d/.test(seg) && !UNIT_RE.test(seg)) { city = seg; end--; continue; }
    // A plain "City, ST" line with no city on the row: the first segment IS the city.
    if (!city && state && end === 1 && segments.length === 2 && !/\d/.test(seg) && !UNIT_RE.test(seg)) { city = seg; end--; continue; }
    break;
  }
  const street = segments.slice(0, end).join(', ').replace(/^(\d+[a-z]?),\s+/i, '$1 ');
  if (street === address && city === (property.city || '') && state === (property.state || '')
      && zip === (property.zip || '') && county === (property.county || '')) return property;
  // The free-text line as it was typed or imported is kept once, so nothing
  // is lost if the split ever reads a line wrong.
  const next = { ...property, address: street };
  if (street !== address && !property.addressRaw) next.addressRaw = address;
  if (city !== (property.city || '')) next.city = city;
  if (state !== (property.state || '')) next.state = state;
  if (zip !== (property.zip || '')) next.zip = zip;
  if (county !== (property.county || '')) next.county = county;
  return next;
}

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
    const healed = splitAddress(healPropTeam(base));
    if (healed !== base || propertyChanged) {
      stateChanged = true;
      return healed;
    }
    return property;
  });
  return stateChanged ? { ...state, properties } : state;
}
