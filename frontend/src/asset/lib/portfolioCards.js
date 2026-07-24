// Formatting/derivation helpers for the Portfolio page (search, filters, tile/list cards).
//
// IMPORTANT — shared with the Manage page: categoryOf/assetTypeOf/assetRegionOf/cityRegion/
// assetRank/searchHaystack/stageColor/ASSET_CATEGORIES below are RE-EXPORTED from
// assetMetrics.js, not redefined here. Both this page and the Manage page's Data Completeness
// filters derive from the exact same underlying minified functions (ft/P/vt/cityRegion/
// assetRank/stHay/Ft in the original bundle) — assetMetrics.js ported them first, so this file
// imports rather than re-implements them to avoid two copies drifting apart. Only the
// aliases differ (deriveCategory/deriveType/stateAbbrev/stateSearchHaystack/stageTone/
// CATEGORIES below are just Portfolio-page-flavored names for the same functions).
//
// Two derivations matter most here and are easy to get subtly wrong if re-derived from
// scratch, so read the comments on assetTypeOf() (assetMetrics.js) and typeLabel() (below)
// before changing them:
//   - categoryOf()/assetTypeOf() decide which filter bucket an asset falls into.
//   - typeLabel() is the free-text "Type" string actually shown on cards/rows, and contains a
//     real bug-fix (dash normalization) that must be preserved exactly.

import { Warehouse, Truck, Store, Stethoscope, House, Building, Trees, Car, Wrench, Building2 } from 'lucide-react';
import { toNumber, formatNumber, acresOf } from './format.js';
import {
  categoryOf, assetTypeOf, assetRegionOf, cityRegion, assetRank, searchHaystack, stageColor,
  ASSET_CATEGORIES,
} from './assetMetrics.js';

// Re-exported under Portfolio-page-local names (see file header note) so call sites here read
// naturally; all are the exact same functions as assetMetrics.js's.
export const CATEGORIES = ASSET_CATEGORIES;
export const deriveCategory = categoryOf;
export const deriveType = assetTypeOf;
export const stateAbbrev = assetRegionOf;
export const stateSearchHaystack = searchHaystack;
export const stageTone = stageColor;
export { cityRegion, assetRank };

/** Type filter options, in display order (matches deriveType()'s possible outputs). */
export const TYPES = [
  'Self-Storage', 'Vehicle Storage', 'Retail', 'Office / Medical', 'Residential',
  'Mixed-Use', 'Land', 'Vehicle', 'Heavy Equipment', 'Other',
];

/** Reads a value out of an asset's free-text snapshot by label (case-insensitive, exact match). */
function snapValue(asset, label) {
  for (const group of asset.snapshot || []) {
    for (const field of group.fields || []) {
      if ((field.label || '').trim().toLowerCase() === label.toLowerCase()) return field.value || '';
    }
  }
  return '';
}

// Type -> representative lucide icon component, used for the tile-card photo watermark/badge
// and the list-row leading icon. Falls back to Building2 (a generic building glyph) for any
// Type not in this table (in practice just 'Other').
const TYPE_ICON = {
  'Self-Storage': Warehouse,
  'Vehicle Storage': Truck,
  Retail: Store,
  'Office / Medical': Stethoscope,
  Residential: House,
  'Mixed-Use': Building,
  Land: Trees,
  Vehicle: Car,
  'Heavy Equipment': Wrench,
  Other: Building2,
};

/** The lucide icon component representing an asset's derived Type (see deriveType()). */
export function typeIcon(asset) {
  return TYPE_ICON[deriveType(asset)] || Building2;
}

// Type -> short generic fallback description, used by typeLabel() when nothing more specific
// (an explicit `type`, or a Proposed/Current Use snapshot value) is available.
const TYPE_FALLBACK_DESC = {
  'Self-Storage': 'Self-storage facility',
  'Vehicle Storage': 'Vehicle storage facility',
  Retail: 'Retail building',
  'Office / Medical': 'Office building',
  Residential: 'Residential',
  'Mixed-Use': 'Mixed-use',
  Land: 'Land',
  Other: '',
};

/**
 * The free-text "Type" label actually displayed on cards/rows (e.g. "Commercial — Self-Storage
 * Facility"). Prefers, in order: the asset's explicit `type`, its Proposed Use snapshot value,
 * its Current Use snapshot value, a generic fallback description for its derived Type bucket
 * (see TYPE_FALLBACK_DESC), then `parcelRole`.
 *
 * BUG FIX — dash normalization: some records store this as "Category - Subtype" with a plain
 * hyphen, others with an em dash ("Category — Subtype"); visually/when sorting these read as
 * different groups even though they mean the same thing. Normalize any leading
 * "<Category> <hyphen-or-en-dash>" prefix to "<Category> — " (em dash) so a plain hyphen and an
 * em dash always group and sort identically. Preserve this exactly — it's a real fix, not
 * decoration.
 */
export function typeLabel(asset) {
  const raw = (
    asset.type ||
    snapValue(asset, 'Proposed Use') ||
    snapValue(asset, 'Current Use') ||
    TYPE_FALLBACK_DESC[deriveType(asset)] ||
    asset.parcelRole ||
    ''
  ).trim();
  return raw.replace(/^(Commercial|Residential|Industrial|Vehicles|Heavy Equipment)\s*[-–]\s*/, '$1 — ');
}

// ---------------------------------------------------------------------------------------------
// Tile-card stat grid
// ---------------------------------------------------------------------------------------------

const stat = (v, l) => ({ v, l });

/**
 * The (up to 4) value/label stat pairs shown in a tile card's bottom stat grid, chosen by the
 * asset's derived Type (see deriveType()) — different asset types care about different metrics
 * (a self-storage facility shows unit counts, a hotel shows stories/year built, a vehicle shows
 * make/model/trim/color, etc). Falls back to a generic Acres/NRSF/Stories/Built grid for
 * anything unmatched.
 */
export function tileStats(asset) {
  const acresNum = acresOf(asset.acreage, asset.acreageUnit);
  const acres = acresNum ? acresNum.toFixed(2) : '—';
  const nrsf = formatNumber(asset.nrsf);
  const stories = asset.stories ? String(asset.stories) : '—';
  const built = asset.yearBuilt ? String(asset.yearBuilt) : '—';
  const storageUnits = toNumber(asset.unitsNonClimate) + toNumber(asset.unitsClimate);
  const storageUnitsFmt = storageUnits ? formatNumber(storageUnits) : '—';
  const vehicleSpaces = toNumber(asset.unitsRV) ? formatNumber(asset.unitsRV) : '—';
  const totalUnits = toNumber(asset.unitsTotal) ? formatNumber(asset.unitsTotal) : '—';
  const haystack = `${asset.type || ''} ${asset.parcelRole || ''} ${typeLabel(asset)}`.toLowerCase();
  const type = deriveType(asset);

  if (type === 'Vehicle') {
    return [
      stat(asset.make || asset.makeModel || '—', 'Make'),
      stat(asset.model || '—', 'Model'),
      stat(asset.trim || '—', 'Trim'),
      stat(asset.color || '—', 'Color'),
    ];
  }
  if (type === 'Heavy Equipment') {
    return [
      stat(asset.color || '—', 'Color'),
      stat(asset.hours ? formatNumber(asset.hours) + ' hrs' : '—', 'Hours'),
      stat([asset.make, asset.model, asset.trim].filter(Boolean).join(' ') || asset.makeModel || asset.parcelRole || '—', 'Make / Model'),
      stat(asset.devStage || '—', 'Status'),
    ];
  }
  if (type === 'Self-Storage' || /self.?storage|mini.?storage/.test(haystack)) {
    // Whichever of vehicle-storage/climate-storage is larger gets shown first.
    const vehicleFirst = toNumber(asset.unitsRV) > storageUnits;
    return [
      stat(acres, 'Acres'),
      stat(nrsf, 'NRSF'),
      ...(vehicleFirst
        ? [stat(vehicleSpaces, 'Vehicle'), stat(storageUnitsFmt, 'Storage')]
        : [stat(storageUnitsFmt, 'Storage'), stat(vehicleSpaces, 'Vehicle')]),
      stat(totalUnits, 'Total'),
    ];
  }
  if (type === 'Vehicle Storage' || /\brv\b|boat/.test(haystack)) {
    return [stat(acres, 'Acres'), stat(nrsf, 'NRSF'), stat(vehicleSpaces, 'Spaces'), stat(totalUnits, 'Total')];
  }
  if (/hotel|hospitality|motel|\binn\b/.test(haystack) || type === 'Office / Medical') {
    return [stat(nrsf, 'RSF'), stat(stories, 'Stories'), stat(built, 'Built'), stat(acres, 'Acres')];
  }
  if (type === 'Retail') {
    return [stat(nrsf, 'GLA'), stat(acres, 'Acres'), stat(stories, 'Stories'), stat(built, 'Built')];
  }
  if (type === 'Residential') {
    return [stat(nrsf, 'SF'), stat(acres, 'Acres'), stat(stories, 'Stories'), stat(built, 'Built')];
  }
  if (type === 'Mixed-Use') {
    return [stat(nrsf, 'NRSF'), stat(totalUnits === '—' ? storageUnitsFmt : totalUnits, 'Units'), stat(acres, 'Acres'), stat(stories, 'Stories')];
  }
  if (type === 'Land' || /vacant|land/.test(haystack)) {
    return [stat(acres, 'Acres'), stat(asset.zoning || '—', 'Zoning'), stat(asset.floodZone || '—', 'Flood')];
  }
  return [stat(acres, 'Acres'), stat(nrsf, 'NRSF'), stat(stories, 'Stories'), stat(built, 'Built')];
}

// ---------------------------------------------------------------------------------------------
// Location formatters (Portfolio-specific — not shared with the Manage page)
// ---------------------------------------------------------------------------------------------

/**
 * Full mailing-address display formatter: "<street line>, <City>, <ST Zip>" — e.g.
 * "123 Main St, Springfield, IL 62701". Used on the asset detail header, not on portfolio
 * cards/rows (those use the more compact cityRegion() re-exported above), but lives alongside
 * it since both parse the same free-text `address` field.
 *
 * The street line is derived by taking the free-text `address`, splitting on commas, and
 * dropping any comma-separated segment that's redundant with the city/state/zip we already know
 * (a "County of X" segment, a bare "ST 12345" segment, or a segment that duplicates the known
 * city/state/zip) — what's left is assumed to be the street line. If the city appears verbatim
 * as one of the address segments, only the segments BEFORE it are considered (so a trailing
 * "City, ST Zip" tail baked into the address isn't misread as part of the street).
 */
export function streetCityStateZip(asset) {
  const city = String(asset.city || '').replace(/^\s*(city|town|county)\s+of\s+/i, '').trim();
  let state = String(asset.state || '').trim();
  let zip = String(asset.zip || '').trim();
  const cityLower = city.toLowerCase();
  const address = String(asset.address || '').trim();

  // Zip/state aren't set directly on the record — try to pull both out of the free-text address.
  if (!zip) {
    const m = address.match(/\b([A-Za-z]{2})[\s,]+(\d{5})(?:-\d{4})?\b/);
    if (m) {
      zip = m[2];
      state ||= m[1].toUpperCase();
    }
  }

  // True for an address segment that's redundant with info we already have (a county-of prefix,
  // a bare county name, a bare "ST 12345" token, or a duplicate of the known state/zip/city) —
  // these get filtered out of the street line rather than treated as part of the street address.
  const isRedundantSegment = (segment) => {
    const t = segment.toLowerCase();
    return !!(
      /^county\s+of\s+/i.test(segment) ||
      /\bcounty$/i.test(segment) ||
      /^[A-Za-z]{2}\s+\d{5}(-\d{4})?$/.test(segment) ||
      (state && t === state.toLowerCase()) ||
      (zip && t === zip) ||
      (cityLower && (t === cityLower || t === `city of ${cityLower}` || t === `town of ${cityLower}`))
    );
  };

  const segments = address.split(',').map((s) => s.trim()).filter(Boolean);
  // If the city shows up verbatim as its own segment, only look at segments before it for the
  // street line (anything after is the city/state/zip tail, already accounted for separately).
  const cityIdx = segments.findIndex((s) => {
    const t = s.toLowerCase();
    return cityLower && (t === cityLower || t === `city of ${cityLower}` || t === `town of ${cityLower}`);
  });
  const streetSegments = cityIdx >= 0 ? segments.slice(0, cityIdx) : segments;
  const streetLine = streetSegments
    .filter((s) => !isRedundantSegment(s))
    .join(', ')
    // "123, Main St" -> "123 Main St" (a stray comma right after a leading house number).
    .replace(/^(\d+[a-z]?),\s+/i, '$1 ')
    .trim();

  const stateZip = [state, zip].filter(Boolean).join(' ');
  const full = [streetLine, city, stateZip].filter(Boolean).join(', ');
  return full || streetLine;
}

/** County display name — appends " County" unless the value already ends with it. */
export function countyLabel(county) {
  const t = String(county ?? '').trim();
  if (!t) return '';
  return /county$/i.test(t) ? t : t + ' County';
}

// ---------------------------------------------------------------------------------------------
// Title Case label formatter
// ---------------------------------------------------------------------------------------------

// Lowercase minor words (articles/prepositions/conjunctions) that stay lowercase mid-string.
const MINOR_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'for', 'and', 'or', 'vs', 'on', 'at', 'by', 'per', 'with', 'from']);
// Lowercase acronyms/units/abbreviations that should NEVER be capitalized (kept exactly as typed).
const KEEP_LOWER = new Set([
  'mi', 'hrs', 'hr', 'yrs', 'yr', 'mo', 'ft', 'sf', 'gla', 'nrsf', 'gsf', 'walt', 'ahj', 'coi',
  'co', 'cup', 'rv', 'url', 'id', 'apn', 'psf', 'mep', 'gc', 'cm', 'pm', 'ev', 'hvac', 'usd',
  'llc', 'qsr', 'ach',
]);

/**
 * Title-cases a label word-by-word: capitalizes each significant word, leaves minor words
 * (a/an/the/of/...) lowercase except when they're the first word, leaves already-mixed-case
 * words (acronyms like "HVAC", "LLC") untouched, and always lowercases known
 * abbreviations/units (KEEP_LOWER) regardless of position. Preserves leading punctuation and any
 * trailing punctuation/suffix attached to a word (e.g. "sf," or "(net)").
 */
export function tcLabel(str) {
  str = String(str || '');
  if (!str) return str;
  return str
    .split(' ')
    .map((word, i) => {
      if (/^[&/+]+$/.test(word)) return word;
      const lead = (word.match(/^[^A-Za-z]*/) || [''])[0];
      const rest = word.slice(lead.length);
      if (!rest) return word;
      const m = rest.match(/^([A-Za-z][A-Za-z'.-]*)(.*)$/);
      if (!m) return word;
      const [, core, trail] = m;
      const lower = core.toLowerCase();
      if (KEEP_LOWER.has(lower)) return lead + core + trail;
      if (/[A-Z]/.test(core.slice(1))) return lead + core + trail; // already mixed-case (acronym) — leave as-is
      if (i > 0 && MINOR_WORDS.has(lower)) return lead + lower + trail;
      return lead + core.charAt(0).toUpperCase() + core.slice(1) + trail;
    })
    .join(' ');
}
