// Operations > Customer Map - trade area helpers (Oct 22 2026). Pure: no
// Leaflet, no DOM, so every rule here is unit-tested (tradeArea.test.js).
// The server (ops_customer_geo.build_map) sends customers already grouped by
// rounded point, facility, unit kind, tenure bucket and rent band - never an
// id, name or address - and computes the trade area figures itself. The
// screen only decodes the groups, picks the default view, bins them into
// hexagons / clusters at the current zoom and sums a hover.

export const MILES_PER_DEG_LAT = 69.05;

// ── Decoding the compact point rows ───────────────────────────────────────────
export function decodePoints(data) {
  const cols = data?.pointCols || [];
  const at = Object.fromEntries(cols.map((c, i) => [c, i]));
  return (data?.points || []).map((r) => ({
    lat: r[at.lat], lng: r[at.lng], fi: r[at.facility], zip: !!r[at.zip], kind: r[at.kind], tenure: r[at.tenure],
    band: r[at.band], count: r[at.count] || 0, rent: r[at.rent] || 0, miles: r[at.miles], closer: r[at.closer],
  }));
}

// ── Color By ──────────────────────────────────────────────────────────────────
// Storage / vehicle use the Operations series pair (ops.css --ops-s1 / s2);
// tenure is the past-due age ramp with the newest customers in a hot accent;
// rent band is its own one-hue ramp.
export const COLOR_BY = [
  { key: 'kind', label: 'Storage vs Vehicle/RV' },
  { key: 'tenure', label: 'Tenure' },
  { key: 'band', label: 'Rent Band' },
  { key: 'overlap', label: 'Closer to Another Store' },
];
const KIND_COLORS = ['#2a78d6', '#eb6834'];
const TENURE_COLORS = ['#e11d48', '#86b6ef', '#2a78d6', '#104281', '#9ca3af'];
const BAND_COLORS = ['#c4b5fd', '#8b5cf6', '#6d28d9', '#3b0764'];
const OVERLAP_COLORS = ['#e11d48', '#9ca3af'];
export const TENURE_LABELS = ['New (Last 90 Days)', '90 Days - 1 Year', '1-3 Years', '3+ Years', 'Move-In Unknown'];
export const KIND_LABELS = ['Self-Storage', 'Vehicle/RV'];

export const money = (v) => `$${Math.round(Number(v || 0)).toLocaleString('en-US')}`;
export const count = (v) => Number(v || 0).toLocaleString('en-US');
export const milesText = (v) => (v == null ? '-' : `${Number(v).toFixed(v < 10 ? 1 : 0)} mi`);

export function bandLabel(b) {
  if (!b) return '';
  return b.band === 3 ? `${money(b.min)}+` : b.band === 0 ? `Up to ${money(b.max)}` : `${money(b.min)}-${money(b.max)}`;
}

/** The category a point falls in for one Color By choice (an index). */
export function categoryOf(p, colorBy) {
  if (colorBy === 'tenure') return p.tenure;
  if (colorBy === 'band') return p.band;
  if (colorBy === 'overlap') return p.closer == null ? 1 : 0;
  return p.kind;
}

export function colorOf(colorBy, cat) {
  const list = colorBy === 'tenure' ? TENURE_COLORS : colorBy === 'band' ? BAND_COLORS
    : colorBy === 'overlap' ? OVERLAP_COLORS : KIND_COLORS;
  return list[cat] || '#9ca3af';
}

/** [{label, color, count}] for the legend - only categories on the map
 *  (plus every choice when nothing is there yet). */
export function legendFor(colorBy, points, rentBands = []) {
  const labels = colorBy === 'tenure' ? TENURE_LABELS
    : colorBy === 'band' ? [0, 1, 2, 3].map((i) => bandLabel(rentBands[i]) || `Band ${i + 1}`)
      : colorBy === 'overlap' ? ['Closer to Another Greens Store', 'Closest to Their Own Store'] : KIND_LABELS;
  const tally = labels.map(() => 0);
  for (const p of points) tally[categoryOf(p, colorBy)] = (tally[categoryOf(p, colorBy)] || 0) + p.count;
  return labels
    .map((label, i) => ({ label, color: colorOf(colorBy, i), count: tally[i] || 0 }))
    .filter((x, i) => x.count > 0 || (colorBy !== 'tenure' || i < 4));
}

// ── Hover summary (no personal data: sums over groups) ────────────────────────
export function summarize(points) {
  let n = 0; let rent = 0; let rentN = 0; let milesSum = 0; let milesN = 0; let fresh = 0; let vehicle = 0; let approx = 0;
  for (const p of points) {
    n += p.count;
    // A group under 3 customers carries no rent (privacy) - it is left out of the average.
    if (p.rent != null) { rent += p.rent; rentN += p.count; }
    if (p.miles != null) { milesSum += p.miles * p.count; milesN += p.count; }
    if (p.tenure === 0) fresh += p.count;
    if (p.kind === 1) vehicle += p.count;
    if (p.zip) approx += p.count;
  }
  return { count: n, avgRent: rentN ? rent / rentN : null, avgMiles: milesN ? milesSum / milesN : null, new90: fresh,
    vehicle, storage: n - vehicle, approx };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Tooltip HTML for a dot / hex / cluster. Numbers only, plus fixed words. */
export function summaryHtml(s, title) {
  const rows = [
    ['Average Rent', s.avgRent == null ? 'Fewer than 3 customers' : `${money(s.avgRent)}/mo`],
    ['Average Distance', milesText(s.avgMiles)],
    ['New in Last 90 Days', count(s.new90)],
    ['Self-Storage / Vehicle', `${count(s.storage)} / ${count(s.vehicle)}`],
  ];
  if (s.approx) rows.push(['Placed by ZIP Only', count(s.approx)]);
  return `<div class="cm-tip"><b>${esc(title || `${count(s.count)} ${s.count === 1 ? 'Customer' : 'Customers'}`)}</b>${
    rows.map(([l, v]) => `<div><span>${esc(l)}</span><span>${esc(v)}</span></div>`).join('')}</div>`;
}
export { esc as escapeHtml };

// ── Default view: the trade area, never every outlier ─────────────────────────
/** Weighted nearest-rank percentile of [{v, w}]. */
export function weightedPercentile(items, p) {
  const list = items.filter((x) => x.v != null && x.w > 0).sort((a, b) => a.v - b.v);
  const total = list.reduce((s, x) => s + x.w, 0);
  if (!total) return null;
  const need = Math.max(1, Math.ceil((p / 100) * total));
  let run = 0;
  for (const x of list) { run += x.w; if (run >= need) return x.v; }
  return list[list.length - 1].v;
}

/**
 * [[south, west], [north, east]] around where `share`% of each shown
 * facility's customers live (every facility's band when several are shown):
 * the points within that facility's percentile distance, plus the facility
 * itself, at least `minMiles` around it. Far-away customers never stretch it.
 * null when there is nothing to show.
 */
export function tradeBounds(points, facilities, greens, { share = 90, minMiles = 1.5, maxMiles = 50 } = {}) {
  let s = Infinity; let w = Infinity; let nth = -Infinity; let e = -Infinity;
  const grow = (lat, lng) => { s = Math.min(s, lat); nth = Math.max(nth, lat); w = Math.min(w, lng); e = Math.max(e, lng); };
  const indexOf = new Map((greens || []).map((g, i) => [g.id, i]));
  for (const f of facilities || []) {
    const fi = indexOf.get(f.id);
    const mine = points.filter((p) => p.fi === fi && p.miles != null);
    if (f.lat == null || f.lng == null) {
      for (const p of mine) grow(p.lat, p.lng);
      continue;
    }
    const radius = Math.min(maxMiles, weightedPercentile(mine.map((p) => ({ v: p.miles, w: p.count })), share) ?? 0);
    for (const p of mine) if (p.miles <= radius) grow(p.lat, p.lng);
    const pad = Math.max(minMiles, 0);
    const dLat = pad / MILES_PER_DEG_LAT;
    const dLng = pad / (MILES_PER_DEG_LAT * Math.cos((f.lat * Math.PI) / 180));
    grow(f.lat - dLat, f.lng - dLng); grow(f.lat + dLat, f.lng + dLng);
  }
  if (!Number.isFinite(s)) return null;
  return [[s, w], [nth, e]];
}

// ── Hex grid and clusters (screen pixels at the current zoom) ─────────────────
const SQRT3 = Math.sqrt(3);

/** Pointy-top hex bins of side `size` px. `project(p) -> {x, y}` (absolute
 *  pixels at the current zoom, so a pan never moves a hexagon). */
export function hexBin(points, project, size) {
  const bins = new Map();
  for (const p of points) {
    const { x, y } = project(p);
    const qf = ((SQRT3 / 3) * x - y / 3) / size;
    const rf = ((2 / 3) * y) / size;
    // cube rounding
    let q = Math.round(qf); let r = Math.round(rf); const sf = -qf - rf; const sr = Math.round(sf);
    const dq = Math.abs(q - qf); const dr = Math.abs(r - rf); const ds = Math.abs(sr - sf);
    if (dq > dr && dq > ds) q = -r - sr; else if (dr > ds) r = -q - sr;   // else s is the one off, q and r stand
    const key = `${q},${r}`;
    let b = bins.get(key);
    if (!b) {
      b = { q, r, cx: size * SQRT3 * (q + r / 2), cy: size * 1.5 * r, count: 0, members: [] };
      bins.set(key, b);
    }
    b.count += p.count;
    b.members.push(p);
  }
  return [...bins.values()];
}

export function hexCorners(cx, cy, size) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i - 30);
    return { x: cx + size * Math.cos(a), y: cy + size * Math.sin(a) };
  });
}

/** Up to five count classes (quantile breaks) for the hex shading. */
export const HEX_COLORS = ['#dbeafe', '#93c5fd', '#3b82f6', '#1d4ed8', '#172554'];
export function hexClasses(counts) {
  const sorted = [...counts].sort((a, b) => a - b);
  if (!sorted.length) return [];
  const breaks = [];
  for (let i = 1; i <= 5; i += 1) {
    const v = sorted[Math.min(sorted.length - 1, Math.ceil((i / 5) * sorted.length) - 1)];
    if (!breaks.length || v > breaks[breaks.length - 1]) breaks.push(v);
  }
  let lo = 1;
  return breaks.map((hi, i) => {
    const c = { min: lo, max: hi, color: HEX_COLORS[Math.min(HEX_COLORS.length - 1, i + (5 - breaks.length))] };
    lo = hi + 1;
    return c;
  });
}
export function hexColor(n, classes) {
  for (const c of classes) if (n <= c.max) return c.color;
  return classes.length ? classes[classes.length - 1].color : HEX_COLORS[0];
}

/**
 * Grid clusters of `cell` px. A cell whose customers all sit at one point is
 * a dot (`single`); one with several points is a count bubble at their
 * weighted center. `cell` 0 = no clustering (zoomed in).
 */
export function gridCluster(points, project, cell) {
  const cells = new Map();
  for (const p of points) {
    let key;
    if (cell > 0) {
      const { x, y } = project(p);
      key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    } else {
      key = `${p.lat},${p.lng}`;
    }
    let c = cells.get(key);
    if (!c) { c = { count: 0, lat: 0, lng: 0, members: [], spots: new Set() }; cells.set(key, c); }
    c.count += p.count;
    c.lat += p.lat * p.count;
    c.lng += p.lng * p.count;
    c.members.push(p);
    c.spots.add(`${p.lat},${p.lng}`);
  }
  return [...cells.values()].map((c) => ({
    lat: c.count ? c.lat / c.count : c.members[0].lat,
    lng: c.count ? c.lng / c.count : c.members[0].lng,
    count: c.count, members: c.members, single: c.spots.size === 1,
  }));
}

/** {category: customers} within a set of points, for one Color By choice. */
export function mixOf(points, colorBy) {
  const out = {};
  for (const p of points) { const k = categoryOf(p, colorBy); out[k] = (out[k] || 0) + p.count; }
  return out;
}

/** A conic-gradient for a cluster bubble: each category's share of the ring. */
export function mixGradient(mix, colorBy) {
  const total = Object.values(mix).reduce((s, v) => s + v, 0) || 1;
  let at = 0;
  const stops = Object.keys(mix).map(Number).sort((a, b) => a - b).map((k) => {
    const from = at; at += (mix[k] / total) * 360;
    return `${colorOf(colorBy, k)} ${from.toFixed(1)}deg ${at.toFixed(1)}deg`;
  });
  return `conic-gradient(${stops.join(', ')})`;
}

export function majority(mix) {
  let best = 0; let bestN = -1;
  for (const [k, v] of Object.entries(mix)) if (v > bestN) { best = Number(k); bestN = v; }
  return best;
}

/** Dot radius in px: grows with the customers at the point, gently. */
export const dotRadius = (n) => Math.min(20, 4 + Math.sqrt(Math.max(1, n)) * 2.1);

// ── Distance distribution ─────────────────────────────────────────────────────
export function bucketLabel(b) {
  return b.max == null ? `${b.min}+ mi` : `${b.min}-${b.max} mi`;
}

export const STATE_NAMES = { CA: 'California', TX: 'Texas', Other: 'Other Areas' };
