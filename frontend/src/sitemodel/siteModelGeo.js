// Pure geography helpers for the realistic site model (Oct 20 2026): the
// model's local frame <-> latitude / longitude, web-mercator tile math, the
// Terrarium elevation encoding, the "keep the lot flat" blend and the muted
// status tints. No three.js and no DOM here, so all of it is unit-tested.
//
// The model frame (backend/site_models/build/build_site_model.py ll_to_uv):
// E / N meters from (lon0, lat0), then turned so +u runs along the site axis
// (bearingDeg clockwise from north). World: x = u, y = up, z = -v.

/** The frame's conversions: ll -> uv, uv -> ll, and the compass in world axes. */
export function geoFrame(frame) {
  const f = frame || {};
  const lat0 = f.lat0 ?? 0, lon0 = f.lon0 ?? 0;
  const mLon = f.mPerDegLon || 111320 * Math.cos((lat0 * Math.PI) / 180) || 1, mLat = f.mPerDegLat || 110900;
  const b = ((f.bearingDeg || 0) * Math.PI) / 180; const su = Math.sin(b), cu = Math.cos(b);
  return {
    lat0, lon0, su, cu,
    llToUv(lon, lat) { const E = (lon - lon0) * mLon, N = (lat - lat0) * mLat; return [E * su + N * cu, -E * cu + N * su]; },
    uvToLl(u, v) { const E = u * su - v * cu, N = u * cu + v * su; return [lon0 + E / mLon, lat0 + N / mLat]; },
    /** world x/z of a unit step east and north */
    east: [su, cu], north: [cu, -su],
  };
}

const R2D = 180 / Math.PI;
/** Fractional web-mercator tile coordinates of a point at zoom z. */
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z; const r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
}
export function tileToLonLat(x, y, z) {
  const n = 2 ** z; return [(x / n) * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * R2D];
}
/** Ground meters covered by one tile at this latitude and zoom. */
export const tileMeters = (lat, z) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

/** The whole tiles covering a lon/lat box (inclusive ranges), clamped to the world. */
export function tileRange(west, south, east, north, z) {
  const a = lonLatToTile(west, north, z), b = lonLatToTile(east, south, z); const max = 2 ** z - 1;
  const c = (x) => Math.max(0, Math.min(max, Math.floor(x)));
  return { z, x0: c(a[0]), y0: c(a[1]), x1: c(b[0]), y1: c(b[1]) };
}

/** Terrarium PNG pixel -> meters above sea level (AWS Terrain Tiles). */
export const decodeTerrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;

/** smoothstep */
const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Convex hull of [u, v] points (monotone chain), counter-clockwise. */
export function convexHull(points) {
  const p = points.filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1])).slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = []; for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  const up = []; for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Distance from a point to a polygon's outline, 0 inside it. */
export function distanceOutside(poly, u, v) {
  if (!poly || poly.length < 3) return Infinity;
  let inside = false, best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if ((b[1] > v) !== (a[1] > v) && u < ((a[0] - b[0]) * (v - b[1])) / (a[1] - b[1]) + b[0]) inside = !inside;
    const dx = b[0] - a[0], dy = b[1] - a[1]; const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((u - a[0]) * dx + (v - a[1]) * dy) / l2));
    best = Math.min(best, Math.hypot(u - (a[0] + t * dx), v - (a[1] + t * dy)));
  }
  return inside ? 0 : best;
}

/** How much of the lot's flat grade wins at `d` meters outside the developed
 *  area: 1 inside it and a short apron, easing to 0 (real terrain) beyond. */
export const flattenWeight = (d, apron = 12, blend = 70) => 1 - ss(apron, apron + blend, d);

/** The developed area of a model: the hull of every pad, zone, building, unit and gate. */
export function developedHull(model) {
  const pts = [];
  (model.pads || (model.pad ? [model.pad] : [])).forEach((p) => (p || []).forEach((q) => pts.push(q)));
  (model.zones || []).forEach((z) => (z.polys && z.polys.length ? z.polys : [z.uv]).forEach((p) => (p || []).forEach((q) => pts.push(q))));
  (model.buildings || []).forEach((b) => { pts.push([b.u[0], b.v[0]], [b.u[1], b.v[0]], [b.u[1], b.v[1]], [b.u[0], b.v[1]]); });
  (model.units || []).forEach((x) => { pts.push([x.u, x.v], [x.u + x.wu, x.v + x.dv]); });
  (model.gates || []).forEach((g) => pts.push(g.uv));
  return convexHull(pts);
}

/** A status color as a muted, translucent-friendly tint: pulled ~30% toward its
 *  own gray so a lot of 500 stalls reads calm over the photo, hue unchanged. */
export function mutedTint(hex, k = 0.3) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const m = (c) => Math.round(c + (y - c) * k);
  return (m(r) << 16) | (m(g) << 8) | m(b);
}

/** Sun direction (unit vector, world axes) for an azimuth (degrees clockwise
 *  from north) and altitude above the horizon, in the model frame. */
export function sunDirection(frame, azimuthDeg, altitudeDeg) {
  const g = geoFrame(frame); const a = (azimuthDeg * Math.PI) / 180, h = (altitudeDeg * Math.PI) / 180;
  const hx = g.north[0] * Math.cos(a) + g.east[0] * Math.sin(a), hz = g.north[1] * Math.cos(a) + g.east[1] * Math.sin(a);
  return [hx * Math.cos(h), Math.sin(h), hz * Math.cos(h)];
}

/** Row-major 3x3 rotation from local east / north / up meters to the model's
 *  world axes (x = u, y = up, z = -v) - for laying a globe tileset under the model. */
export function enuToWorld(frame) {
  const g = geoFrame(frame);
  return [g.su, g.cu, 0, 0, 0, 1, g.cu, -g.su, 0];
}

/** The kind of 3D object a unit is drawn as in the realistic look. */
export function unitForm(u, buildings) {
  if (u.k === 'park') return 'stall';
  if (buildings && buildings[u.b]) return 'interior';
  return Math.min(u.wu || 0, u.dv || 0) >= 1.5 ? 'container' : 'stall';
}

/** Hash a unit name to one of n buckets (container paint colors). */
export function nameBucket(name, n) { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % n; }
