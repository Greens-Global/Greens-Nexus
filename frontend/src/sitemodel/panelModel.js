// The site model side panel's pure answers (Visesh, Oct 20 2026: "the tenant
// data is going too unlooked"): the occupancy bar's buckets, the dimming that
// a click on a bar segment lays over the map, the one-line summary the KPI
// block folds into while a unit is open, and Needs Attention's reason groups.
import { reasonLabel } from './siteModelViewer.js';

export const OCC_COLORS = { leased: '#5fae7d', vacant: '#e0b45a', bad: '#d65a4c' };
export const DIM_COLOR = '#d9d6cf';
const OCC_LABELS = { leased: 'Leased', vacant: 'Vacant', bad: 'Out of Service' };

/** The units the counts are about: storage still in Cubby (mailboxes count apart). */
export const countedUnits = (units) => (units || []).filter((x) => x.n[0] !== 'M' && !x.gone);

/** [{ key, label, color, count, units: [names] }] for leased / vacant / out of service. */
export function occupancyBuckets(units, statusFn) {
  const by = { leased: [], vacant: [], bad: [] };
  countedUnits(units).forEach((u) => { const k = statusFn(u); if (by[k]) by[k].push(u.n); });
  return ['leased', 'vacant', 'bad'].map((k) => ({ key: k, label: OCC_LABELS[k], color: OCC_COLORS[k], count: by[k].length, units: by[k] }));
}

/** The map's colors while one bucket is picked: its units keep their color,
 *  every other unit goes quiet. `base` is the layer's colors (null = occupancy). */
export function focusColors(units, bucket, base, statusFn) {
  if (!bucket) return base;
  const keep = new Set(bucket.units);
  const out = {};
  (units || []).forEach((u) => {
    out[u.n] = keep.has(u.n) ? ((base && base[u.n]) || OCC_COLORS[statusFn(u)] || DIM_COLOR) : DIM_COLOR;
  });
  return out;
}

export const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '0%');

/** $173k, $4.2k, $950 - for the one-line summary (cents in). */
export function shortMoney(cents) {
  const d = Math.round((cents || 0) / 100);
  if (Math.abs(d) >= 1e6) return `$${(d / 1e6).toFixed(d >= 1e7 ? 0 : 1)}M`;
  if (Math.abs(d) >= 10000) return `$${Math.round(d / 1000)}k`;
  if (Math.abs(d) >= 1000) return `$${(d / 1000).toFixed(1)}k`;
  return `$${d}`;
}

/** "807 Units · 95.9% Leased · $173k Rent Roll · $4.2k Past Due" */
export function summaryLine(total, leased, kpis) {
  const parts = [`${total} Units`, `${pct(leased, total)} Leased`];
  if (kpis) {
    parts.push(`${shortMoney(kpis.rentRoll)} Rent Roll`);
    if (kpis.pastDue) parts.push(`${shortMoney(kpis.pastDue)} Past Due`);
  }
  return parts.join(' · ');
}

/** Cubby's reason for an unrentable unit as the group it belongs in. OTHER
 *  says nothing by itself: the note names it (air duct, a business class
 *  agreement), and OTHER with no note is "No Reason Given". */
export function reasonGroup(why, note) {
  const w = String(why || '').toUpperCase(); const n = String(note || '').trim();
  if (w && w !== 'OTHER') return reasonLabel(w);
  if (!w && !n) return 'Out of Service';
  if (!n) return 'No Reason Given';
  if (/not\s+physical/i.test(n)) return /business\s+class/i.test(n) ? 'Not Physical (Business Class Agreement)' : 'Not Physical';
  if (/air\s*duct/i.test(n)) return 'Air Duct';
  const head = n.split(/\s+-\s+|[.;:(]/)[0].trim().replace(/\bunits\b/i, 'unit');
  return head ? head.split(/\s+/).map((x) => x[0].toUpperCase() + x.slice(1).toLowerCase()).join(' ').slice(0, 40) : 'No Reason Given';
}

/** Needs Attention: [{ label, units }] biggest group first, the vague ones last. */
export function attentionGroups(bad) {
  const by = new Map();
  (bad || []).forEach((u) => { const k = reasonGroup(u.why, u.note); if (!by.has(k)) by.set(k, []); by.get(k).push(u); });
  const last = (k) => (k === 'No Reason Given' ? 2 : k === 'Out of Service' ? 1 : 0);
  return [...by.entries()].map(([label, units]) => ({ label, units }))
    .sort((a, b) => last(a.label) - last(b.label) || b.units.length - a.units.length || a.label.localeCompare(b.label));
}
