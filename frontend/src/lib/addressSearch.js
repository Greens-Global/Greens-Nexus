// Address search for work sites (Pranshu, Sep 30): a site is set by picking a
// searched ADDRESS, never by placing a pin, so its geofence sits where the
// address is. Up to five matches come back and the person picks one - taking
// the first hit on their behalf is how a site ended up in the wrong place.
//
// Nominatim (OpenStreetMap) for now; Google Places can replace searchAddresses
// once Nexus has a Maps key - callers only see { address, lat, lng, exact }.
//
// Nominatim's usage policy: at most ~1 request/second, no search-as-you-type.
// Requests run one at a time on this queue with a delay between them, and the
// caller searches only on Enter / the Search button.
// https://operations.osmfoundation.org/policies/nominatim/

const DELAY_MS = 1150;
let tail = Promise.resolve();

const ABBREVIATIONS = [
  [/\bhwy\b\.?/gi, 'Highway'], [/\bblvd\b\.?/gi, 'Boulevard'], [/\bpkwy\b\.?/gi, 'Parkway'],
  [/\bave\b\.?/gi, 'Avenue'], [/\bst\b\.?(?=\s*,|$)/gi, 'Street'], [/\brd\b\.?/gi, 'Road'],
  [/\bdr\b\.?/gi, 'Drive'], [/\bln\b\.?/gi, 'Lane'], [/\bct\b\.?/gi, 'Court'],
];

// OpenStreetMap spells suffixes out ("Highway", not "Hwy") and can file an
// address under a hamlet instead of the mailing city, so a miss retries with
// suffixes expanded, then without the city.
function variants(query) {
  const expanded = ABBREVIATIONS.reduce((s, [re, full]) => s.replace(re, full), query);
  const parts = expanded.split(',').map((p) => p.trim()).filter(Boolean);
  const noCity = parts.length >= 3 ? [parts[0], ...parts.slice(2)].join(', ') : '';
  return [...new Set([query, expanded, noCity].filter(Boolean))];
}

function searchOnce(query) {
  const step = tail
    .then(() => new Promise((r) => setTimeout(r, DELAY_MS)))
    .then(() => fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&q='
      + encodeURIComponent(query), { headers: { Accept: 'application/json' } }))
    .then((r) => (r.ok ? r.json() : []));
  tail = step.catch(() => {});
  return step;
}

/** One match: exact = a street address with a house number, not just a road,
 *  town or area - an inexact match puts the geofence somewhere near, not at. */
export function toMatch(hit) {
  return {
    address: hit.display_name || '',
    lat: Number(hit.lat),
    lng: Number(hit.lon),
    exact: !!hit.address?.house_number || ['building', 'house'].includes(hit.addresstype),
  };
}

/** Up to five matches for a typed address, best first; [] when nothing matches.
 *  Throws on a network failure so the caller can say so instead of "no match". */
export async function searchAddresses(query) {
  const q = (query || '').trim();
  if (!q) return [];
  for (const v of variants(q)) {
    const hits = await searchOnce(v);
    if (Array.isArray(hits) && hits.length) return hits.map(toMatch).filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng));
  }
  return [];
}
