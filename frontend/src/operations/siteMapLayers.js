// Operations > Site Map layers (Neil, Oct 20 2026): each layer colors the units
// by one question and says how in its legend. Pure - the map, the 2D plan and
// the tests all read the same answers.
//
//   occupancy    leased / vacant / out of service, from the Cubby rent roll
//   days         how long a vacant unit has sat empty (last move-out in Cubby)
//   market       our rate (rent if leased, street if vacant) against the median
//                of competitors' rates for that size (Market Rates' numbers)
//   maintenance  units with open maintenance items or tickets

export const LAYERS = [
  { key: 'occupancy', label: 'Occupancy' },
  { key: 'days', label: 'Days Vacant' },
  { key: 'market', label: 'Market' },
  { key: 'maintenance', label: 'Maintenance' },
];

export const OCC = { leased: '#5fae7d', vacant: '#e0b45a', bad: '#d65a4c' };
export const QUIET = '#cfcac0';          // a unit the layer says nothing about
export const UNKNOWN = '#a9b4c2';
export const MARKET = { under: '#2563eb', at: '#9ca3af', over: '#d97706' };
export const MAINT = { urgent: '#dc2626', open: '#f59e0b' };
// Days vacant: pale yellow (just emptied) to deep red (half a year or more).
export const DAYS_STOPS = [[0, '#fde68a'], [60, '#f59e0b'], [120, '#ea580c'], [180, '#991b1b']];

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbToHex = (c) => '#' + c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');

export function daysColor(days) {
  const d = Math.max(0, days);
  for (let i = 1; i < DAYS_STOPS.length; i++) {
    const [d1, c1] = DAYS_STOPS[i]; const [d0, c0] = DAYS_STOPS[i - 1];
    if (d <= d1) { const k = (d - d0) / (d1 - d0); const a = hexToRgb(c0), b = hexToRgb(c1); return rgbToHex(a.map((x, j) => x + (b[j] - x) * k)); }
  }
  return DAYS_STOPS[DAYS_STOPS.length - 1][1];
}

/** Occupancy of a unit: the rent roll's word when there is one, else the model's
 *  live flags. A lease wins over the rentability flag - Cubby marks a leased
 *  unit unrentable with the reason ACTIVE_LEASE, which is not out of service. */
export function occupancyOf(u, fact) {
  if (fact) return fact.status === 'rented' ? 'leased' : fact.status === 'vacant' ? 'vacant' : 'bad';
  if (u.l === 1) return 'leased';
  return u.r === 0 ? 'bad' : 'vacant';
}

/** Days a unit has been empty: Cubby's last move-out when known, else the model's own count. */
export function daysVacantOf(u, fact) {
  if (fact && typeof fact.daysVacant === 'number') return fact.daysVacant;
  if (fact && fact.status !== 'vacant') return null;
  if (u.l === 1) return null;
  return typeof u.dvac === 'number' ? u.dvac : null;
}

const PRIORITY_URGENT = new Set(['urgent', 'critical', 'high', 'emergency']);

/** { unitName: color } for every unit the layer has something to say about. */
export function layerColors(layer, units, facts = {}, maint = null) {
  const out = {};
  (units || []).forEach((u) => {
    if (u.n[0] === 'M' && !facts[u.n]) return;     // rental mailboxes keep the default look
    const f = facts[u.n];
    if (layer === 'occupancy') out[u.n] = OCC[occupancyOf(u, f)];
    else if (layer === 'days') {
      const occ = occupancyOf(u, f);
      if (occ !== 'vacant') out[u.n] = QUIET;
      else { const d = daysVacantOf(u, f); out[u.n] = d == null ? UNKNOWN : daysColor(d); }
    } else if (layer === 'market') out[u.n] = f && f.market ? MARKET[f.market] : QUIET;
    else if (layer === 'maintenance') {
      const items = (maint && maint.units && maint.units[u.n]) || [];
      out[u.n] = !items.length ? QUIET : items.some((x) => PRIORITY_URGENT.has(String(x.priority || '').toLowerCase())) ? MAINT.urgent : MAINT.open;
    }
  });
  return out;
}

/** Counts per layer value, for the legend. The same units the Inventory tiles
 *  count (storage, still in Cubby - mailboxes have their own occupancy), so the
 *  legend and the tiles always agree (Oct 20 2026). */
export function layerCounts(layer, units, facts = {}, maint = null) {
  const c = {};
  (units || []).forEach((u) => {
    if (u.n[0] === 'M' || u.gone) return;
    const f = facts[u.n]; let k;
    if (layer === 'occupancy') k = occupancyOf(u, f);
    else if (layer === 'days') { if (occupancyOf(u, f) !== 'vacant') return; const d = daysVacantOf(u, f); k = d == null ? 'unknown' : d >= 180 ? '180+' : d >= 120 ? '120-179' : d >= 60 ? '60-119' : '0-59'; }
    else if (layer === 'market') k = f && f.market ? f.market : 'none';
    else if (layer === 'maintenance') k = (maint && maint.units && maint.units[u.n] && maint.units[u.n].length) ? 'open' : 'none';
    c[k] = (c[k] || 0) + 1;
  });
  return c;
}

const money = (cents) => (cents || cents === 0 ? `$${Math.round(cents / 100).toLocaleString('en-US')}` : '-');

/** The one-line fact the hover tooltip shows for a unit on this layer. */
export function hoverFact(layer, u, facts = {}, maint = null) {
  const f = facts[u.n];
  if (layer === 'occupancy') { const o = occupancyOf(u, f); return o === 'leased' ? (f && f.rent ? `Leased at ${money(f.rent)}/mo` : 'Leased') : o === 'vacant' ? (f && f.street ? `Vacant, street ${money(f.street)}/mo` : 'Vacant') : 'Out of Service'; }
  if (layer === 'days') { if (occupancyOf(u, f) !== 'vacant') return 'Not vacant'; const d = daysVacantOf(u, f); return d == null ? 'Vacant, days not known' : `Vacant ${d} day${d === 1 ? '' : 's'}`; }
  if (layer === 'market') {
    if (!f || !f.market) return f && f.marketCount ? 'Not enough competitor rates for this size' : 'No competitor rate for this size';
    const pct = f.marketPct || 0;
    return `${money(f.rate)} vs market ${money(f.marketMedian)} (${f.market === 'at' ? 'at market' : `${Math.abs(pct)}% ${f.market}`})`;
  }
  if (layer === 'maintenance') { const items = (maint && maint.units && maint.units[u.n]) || []; return items.length ? `${items.length} open item${items.length === 1 ? '' : 's'}: ${items[0].title || ''}` : 'No open items'; }
  return '';
}
