// Ink to Shape for a Board (Neil, 11/10/2026): like Microsoft Whiteboard, a
// rough shape drawn with the pen becomes a clean one - a straight line, a
// rectangle, an ellipse, a diamond or a triangle. The pen is the fastest way
// to sketch on a phone or a tablet, and a tidy diagram should not need the
// shape tools. Engine-free: this module reads and writes plain element JSON
// (the shape templates.js builds), so the caller swaps the freedraw for the
// returned elements through the adapter and a new engine keeps the feature.
//
// Conservative on purpose: a wrong guess destroys the person's ink, so
// anything unsure (a scribble, a zigzag, an open curve, a word, a tiny dot)
// is left as it was drawn.

export const INK_MIN_POINTS = 8;
const MIN_SIZE = 16;          // px - the larger side of a stroke we will touch
const LINE_MIN = 24;          // px - a straight stroke shorter than this stays ink
const LINE_STRAIGHT = 0.92;   // chord / path length
const CLOSE_GAP = 0.25;       // start-end gap / bbox diagonal
const RING = 64;              // points a closed stroke is resampled to

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pathLength = (ps) => ps.reduce((s, p, i) => (i ? s + dist(ps[i - 1], p) : 0), 0);

function bbox(ps) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  ps.forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); });
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Signed shoelace area of a ring (the last point joins the first).
function area(ring) {
  let a = 0;
  ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; a += p[0] * q[1] - q[0] * p[1]; });
  return a / 2;
}

function hull(ps) {
  const s = [...ps].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const out = [];
    list.forEach((p) => { while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop(); out.push(p); });
    out.pop();
    return out;
  };
  return [...half(s), ...half([...s].reverse())];
}

// A moving average over 5 points takes out the pen's high-frequency wobble;
// the two ends stay where the pen put them down and lifted.
function smooth(ps) {
  return ps.map((p, i) => {
    if (!i || i === ps.length - 1) return p;
    let x = 0, y = 0, n = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(ps.length - 1, i + 2); j += 1) { x += ps[j][0]; y += ps[j][1]; n += 1; }
    return [x / n, y / n];
  });
}

// `n` points evenly spaced along the closed ring, so a slow stretch of the
// stroke (dense points) weighs no more than a fast one.
function resampleRing(ps, n) {
  const ring = [...ps, ps[0]];
  const step = pathLength(ring) / n;
  const out = [ring[0]];
  let need = step, i = 1, prev = ring[0];
  while (out.length < n && i < ring.length) {
    const d = dist(prev, ring[i]);
    if (d >= need && d > 0) {
      const t = need / d;
      prev = [prev[0] + (ring[i][0] - prev[0]) * t, prev[1] + (ring[i][1] - prev[1]) * t];
      out.push(prev);
      need = step;
    } else { need -= d; prev = ring[i]; i += 1; }
  }
  return out;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  if (!len2) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

// Douglas-Peucker on an open run; returns the kept indexes (ends included).
function dp(ps, eps, lo = 0, hi = ps.length - 1) {
  let best = -1, far = 0;
  for (let i = lo + 1; i < hi; i += 1) { const d = segDist(ps[i], ps[lo], ps[hi]); if (d > far) { far = d; best = i; } }
  if (far <= eps) return [lo, hi];
  return [...dp(ps, eps, lo, best).slice(0, -1), ...dp(ps, eps, best, hi)];
}

// Corners of a closed ring: split at the point farthest from the center and
// at the point farthest from that one, then simplify both halves.
function ringCorners(ring, eps) {
  const c = ring.reduce((s, p) => [s[0] + p[0] / ring.length, s[1] + p[1] / ring.length], [0, 0]);
  let a = 0;
  ring.forEach((p, i) => { if (dist(p, c) > dist(ring[a], c)) a = i; });
  const r = [...ring.slice(a), ...ring.slice(0, a)];
  let b = 0;
  r.forEach((p, i) => { if (dist(p, r[0]) > dist(r[b], r[0])) b = i; });
  const first = dp(r, eps, 0, b);
  const loop = [...r, r[0]];
  const second = dp(loop, eps, b, r.length);
  return [...first.slice(0, -1), ...second.slice(0, -1)].map((i) => loop[i]);
}

/**
 * What shape a freedraw stroke looks like, or null when it is not clearly
 * one. Coordinates are the board's; `points` (line and triangle only) are
 * relative to x, y like an element's.
 */
export function recognizeInk(freedraw) {
  const raw = freedraw?.points;
  if (!freedraw || freedraw.type !== 'freedraw' || !Array.isArray(raw) || raw.length < INK_MIN_POINTS) return null;
  if (freedraw.angle) return null;   // a rotated stroke - leave it alone
  const pts = smooth(raw.filter((p, i) => !i || p[0] !== raw[i - 1][0] || p[1] !== raw[i - 1][1])
    .map(([px, py]) => [freedraw.x + px, freedraw.y + py]));
  if (pts.length < INK_MIN_POINTS) return null;
  const box = bbox(pts);
  const diag = Math.hypot(box.width, box.height);
  if (Math.max(box.width, box.height) < MIN_SIZE) return null;
  const len = pathLength(pts);
  const start = pts[0], end = pts[pts.length - 1];
  const chord = dist(start, end);

  if (chord >= LINE_MIN && chord / len > LINE_STRAIGHT) {
    const wander = Math.max(...pts.map((p) => segDist(p, start, end)));
    if (wander > Math.max(3, chord * 0.08)) return null;
    const dx = end[0] - start[0], dy = end[1] - start[1];
    return { kind: 'line', x: start[0], y: start[1], width: Math.abs(dx), height: Math.abs(dy), points: [[0, 0], [dx, dy]] };
  }

  if (chord > diag * CLOSE_GAP) return null;                                 // open: an arc, a word, a spiral
  if (Math.min(box.width, box.height) < 12 || Math.min(box.width, box.height) / Math.max(box.width, box.height) < 0.15) return null;

  const ring = resampleRing(pts, RING);
  const shell = hull(ring);
  const inkArea = Math.abs(area(ring));
  const shellArea = Math.abs(area(shell));
  const shellLen = pathLength([...shell, shell[0]]);
  // Every shape we draw is convex and goes round once: a scribble, a figure 8
  // or a double loop fails one of these.
  if (!shellArea || inkArea / shellArea < 0.9) return null;
  const roundTrip = (len + chord) / shellLen;
  if (roundTrip < 0.9 || roundTrip > 1.3) return null;

  const fill = inkArea / (box.width * box.height);
  const rect = { x: box.x, y: box.y, width: box.width, height: box.height };

  if (fill >= 0.86) return { kind: 'rectangle', ...rect };

  if (fill >= 0.72 && fill <= 0.85) {
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const rs = ring.map(([x, y]) => Math.hypot((x - cx) / (box.width / 2), (y - cy) / (box.height / 2)));
    const mean = rs.reduce((s, r) => s + r, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((s, r) => s + (r - mean) ** 2, 0) / rs.length);
    // A real hexagon reads about 0.06 here, a hand ellipse under 0.03.
    if (mean >= 0.92 && mean <= 1.06 && sd <= 0.05 && rs.every((r) => Math.abs(r - mean) <= 0.15)) return { kind: 'ellipse', ...rect };
    return null;
  }

  if (fill < 0.38 || fill > 0.62) return null;
  const corners = ringCorners(ring, diag * 0.06);
  const polyArea = Math.abs(area(corners));
  if (polyArea < inkArea * 0.85 || polyArea > inkArea * 1.15) return null;  // the corners do not describe the ink

  if (corners.length === 4) {
    const mids = [[box.x + box.width / 2, box.y], [box.x + box.width, box.y + box.height / 2], [box.x + box.width / 2, box.y + box.height], [box.x, box.y + box.height / 2]];
    const used = new Set();
    const ok = corners.every(([x, y]) => {
      const m = mids.findIndex(([mx, my]) => Math.abs(x - mx) / box.width <= 0.12 && Math.abs(y - my) / box.height <= 0.12);
      if (m < 0 || used.has(m)) return false;
      used.add(m);
      return true;
    });
    return ok ? { kind: 'diamond', ...rect } : null;
  }

  if (corners.length === 3) {
    const tb = bbox(corners);
    return {
      kind: 'triangle', ...tb,
      points: [...corners, corners[0]].map(([x, y]) => [x - tb.x, y - tb.y]),
    };
  }
  return null;
}

const nonce = () => Math.floor(Math.random() * 0x7fffffff);

/**
 * The clean elements that replace a recognized stroke, in the ink's own
 * stroke color, width, opacity, roughness, group and frame. The caller marks
 * the freedraw deleted.
 */
export function shapeFromInk(freedraw, rec, { now = Date.now() } = {}) {
  if (!freedraw || !rec) return [];
  const type = rec.kind === 'triangle' ? 'line' : rec.kind;
  const el = {
    id: `ink${nonce().toString(36)}${now.toString(36)}`, type,
    x: rec.x, y: rec.y, width: rec.width, height: rec.height, angle: 0,
    strokeColor: freedraw.strokeColor, backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: freedraw.strokeWidth, strokeStyle: 'solid', roughness: freedraw.roughness ?? 0,
    opacity: freedraw.opacity ?? 100, groupIds: [...(freedraw.groupIds || [])], frameId: freedraw.frameId ?? null,
    roundness: type === 'rectangle' ? { type: 3 } : null,
    seed: nonce(), version: 1, versionNonce: nonce(), isDeleted: false, boundElements: null,
    updated: now, link: null, locked: false, customData: { nexusInk: true },
  };
  if (type === 'line') {
    Object.assign(el, {
      points: rec.points.map((p) => [...p]), lastCommittedPoint: null,
      startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null,
    });
  }
  return [el];
}
