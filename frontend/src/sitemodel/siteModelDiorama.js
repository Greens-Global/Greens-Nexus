// Illustrated ("diorama") look for the site model viewer (Neil, Oct 11 2026).
// The satellite look shows the property as it is photographed; this one draws
// it as a miniature: the parcels as a floating board with an earth edge,
// paving and gravel in flat colors, toy trees around the boundary and small
// vehicles driving the aisles. Geometry is the same to-scale model, so a unit
// found here is in the same spot as on the satellite look.
//
// Everything here is decoration except the board (`ground`, used for pin
// placement). The viewer owns units, buildings, labels, picking and camera.
import * as THREE from 'three';

export const DIORAMA = {
  sky: 0xf3ecdc, fog: 0xf3ecdc, floor: 0xeadfc8, grass: 0x9cc47f, field: 0xd3d9ad, hedge: 0x5f9455, earth: 0xc79a6c, earthDark: 0xa97c52,
  asphalt: 0x8e97a4, gravel: 0xd8ccb0, stripe: 0xffffff,
  wall: 0xf7f0e2, door: 0x3f8f5f, edge: 0x6b6355,
  roofs: [0x6fae86, 0xe58f6b, 0x7fa3c9, 0xe9c46a, 0xb59ad6],
  neutral: 0xf0e4c8, neutralPark: 0xc9d1db,
  cars: [0xe76f51, 0x2a9d8f, 0xf4a261, 0x457b9d, 0xffffff, 0xe9c46a, 0x6d597a],
};

const BOARD_DEPTH = 6;

function inPoly(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
function signedArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; }
// Small deterministic random, so a property looks the same on every visit.
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; }; }
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/** Offsets a closed polygon inward by `d` meters (miter joins, clamped). Fine for the
 * mostly-convex lots and pads here; a route that ends up crossing a building is dropped. */
function inset(poly, d) {
  const ccw = signedArea(poly) > 0; const n = poly.length; const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n], p1 = poly[i], p2 = poly[(i + 1) % n];
    const e1 = [p1[0] - p0[0], p1[1] - p0[1]], e2 = [p2[0] - p1[0], p2[1] - p1[1]];
    const l1 = Math.hypot(...e1) || 1, l2 = Math.hypot(...e2) || 1;
    // inward normals (left of the edge for a counter-clockwise ring)
    const n1 = ccw ? [-e1[1] / l1, e1[0] / l1] : [e1[1] / l1, -e1[0] / l1];
    const n2 = ccw ? [-e2[1] / l2, e2[0] / l2] : [e2[1] / l2, -e2[0] / l2];
    const bx = n1[0] + n2[0], by = n1[1] + n2[1]; const bl = Math.hypot(bx, by) || 1;
    const cos = Math.max(0.35, (bx / bl) * n1[0] + (by / bl) * n1[1]);
    out.push([p1[0] + (bx / bl) * (d / cos), p1[1] + (by / bl) * (d / cos)]);
  }
  return out;
}
function dropShortEdges(poly, min) { const out = []; poly.forEach((p) => { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= min) out.push(p); }); if (out.length > 2) { const a = out[0], z = out[out.length - 1]; if (Math.hypot(a[0] - z[0], a[1] - z[1]) < min) out.pop(); } return out; }

/** Sutherland-Hodgman clip of a polygon to an axis-aligned rectangle. */
function clipRect(poly, r) {
  const edges = [[(p) => p[0] >= r.u0, (a, b) => { const k = (r.u0 - a[0]) / (b[0] - a[0]); return [r.u0, a[1] + (b[1] - a[1]) * k]; }],
    [(p) => p[0] <= r.u1, (a, b) => { const k = (r.u1 - a[0]) / (b[0] - a[0]); return [r.u1, a[1] + (b[1] - a[1]) * k]; }],
    [(p) => p[1] >= r.v0, (a, b) => { const k = (r.v0 - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * k, r.v0]; }],
    [(p) => p[1] <= r.v1, (a, b) => { const k = (r.v1 - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * k, r.v1]; }]];
  let out = poly;
  edges.forEach(([inside, cut]) => {
    const src = out; out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i], b = src[(i + 1) % src.length];
      if (inside(b)) { if (!inside(a)) out.push(cut(a, b)); out.push(b); } else if (inside(a)) out.push(cut(a, b));
    }
  });
  return out;
}
function nearPoly(pt, poly, d) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]; const dx = b[0] - a[0], dy = b[1] - a[1]; const l2 = dx * dx + dy * dy || 1;
    const k = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / l2));
    if (Math.hypot(a[0] + dx * k - pt[0], a[1] + dy * k - pt[1]) < d) return true;
  }
  return false;
}
function rectHits(rects, u, v, pad = 0) { return rects.some((r) => u > r.u0 - pad && u < r.u1 + pad && v > r.v0 - pad && v < r.v1 + pad); }

function makeCar(color, kind) {
  const g = new THREE.Group(); const body = new THREE.MeshLambertMaterial({ color }); const glass = new THREE.MeshLambertMaterial({ color: 0x2b3440 });
  const wheel = new THREE.MeshLambertMaterial({ color: 0x2a2a2a });
  const dims = kind === 'rv' ? [9, 3.1, 2.5] : kind === 'truck' ? [6, 2.2, 2.2] : [4.4, 1.2, 1.9];
  const b = new THREE.Mesh(new THREE.BoxGeometry(dims[0], dims[1], dims[2]), kind === 'rv' ? new THREE.MeshLambertMaterial({ color: 0xfbf8f1 }) : body);
  b.position.y = dims[1] / 2 + 0.45; b.castShadow = true; g.add(b);
  if (kind === 'rv') {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(dims[0] + 0.02, 0.35, dims[2] + 0.02), body); stripe.position.y = 1.7; g.add(stripe);
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, dims[2] * 0.8), glass); win.position.set(dims[0] / 2, 2.5, 0); g.add(win);
  } else if (kind === 'truck') {
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.3, dims[2]), body); cab.position.set(dims[0] / 2 - 0.9, dims[1] + 1.1, 0); cab.castShadow = true; g.add(cab);
    b.material = new THREE.MeshLambertMaterial({ color: 0xf4efe4 });
  } else {
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.85, 1.7), glass); cab.position.set(-0.2, dims[1] + 0.85, 0); cab.castShadow = true; g.add(cab);
  }
  const wg = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 10);
  [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sx, sz]) => { const w = new THREE.Mesh(wg, wheel); w.rotation.x = Math.PI / 2; w.position.set(sx * (dims[0] / 2 - 0.9), 0.42, sz * (dims[2] / 2)); g.add(w); });
  return g;
}

function routeLength(pts) { let L = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); } return L; }
function pointAt(pts, s) {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (s <= l) { const k = l ? s / l : 0; return { u: a[0] + (b[0] - a[0]) * k, v: a[1] + (b[1] - a[1]) * k, h: Math.atan2(b[1] - a[1], b[0] - a[0]) }; }
    s -= l;
  }
  return { u: pts[0][0], v: pts[0][1], h: 0 };
}

/**
 * Adds the illustrated scenery to `scene`. Returns { ground, update(dt), setParked(units, owner), dispose }.
 * `W(u, v, y)` is the viewer's frame-to-world helper.
 */
export function buildDiorama(scene, model, W) {
  const root = new THREE.Group(); scene.add(root);
  const seed = hashStr((model.property && model.property.id) || 'site'); const rand = rng(seed);
  const parcels = model.parcels ? model.parcels.map((p) => p.uv).filter((p) => p && p.length > 2) : model.parcel ? [model.parcel] : [];
  const pads = (model.pads || (model.pad ? [model.pad] : [])).filter((p) => p && p.length > 2);
  const zones = model.zones || [];
  const rects = (model.buildings || []).map((b) => ({ u0: b.u[0], u1: b.u[1], v0: b.v[0], v1: b.v[1] }));
  const toShape = (pts) => { const s = new THREE.Shape(); pts.forEach((p, i) => (i ? s.lineTo(p[0], p[1]) : s.moveTo(p[0], p[1]))); return s; };
  const flat = (pts, color, y) => { const m = new THREE.Mesh(new THREE.ShapeGeometry(toShape(pts)), new THREE.MeshLambertMaterial({ color })); m.rotation.x = -Math.PI / 2; m.position.y = y; m.receiveShadow = true; root.add(m); return m; };

  // ---- the board: a rounded tile around the developed area, floating over the floor.
  // Inside the parcel is lawn; beyond it (the neighbors) a paler field, so the
  // property line reads without a drawn boundary running off the board.
  const dev = []; pads.forEach((p) => p.forEach((q) => dev.push(q))); zones.forEach((z) => (z.polys && z.polys.length ? z.polys : [z.uv]).forEach((p) => (p || []).forEach((q) => dev.push(q))));
  rects.forEach((r) => { dev.push([r.u0, r.v0]); dev.push([r.u1, r.v1]); }); (model.gates || []).forEach((g) => dev.push(g.uv));
  if (!dev.length) parcels.forEach((p) => p.forEach((q) => dev.push(q)));
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity; dev.forEach(([u, v]) => { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); });
  const M = Math.max(16, 0.07 * Math.max(u1 - u0, v1 - v0)); u0 -= M; u1 += M; v0 -= M; v1 += M;
  const tile = { u0, u1, v0, v1 }; const R = Math.min(14, M * 0.6);
  const tileShape = new THREE.Shape();
  tileShape.moveTo(u0 + R, v0); tileShape.lineTo(u1 - R, v0); tileShape.quadraticCurveTo(u1, v0, u1, v0 + R); tileShape.lineTo(u1, v1 - R); tileShape.quadraticCurveTo(u1, v1, u1 - R, v1);
  tileShape.lineTo(u0 + R, v1); tileShape.quadraticCurveTo(u0, v1, u0, v1 - R); tileShape.lineTo(u0, v0 + R); tileShape.quadraticCurveTo(u0, v0, u0 + R, v0);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), new THREE.MeshLambertMaterial({ color: DIORAMA.floor }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -BOARD_DEPTH - 3; floor.receiveShadow = true; root.add(floor);
  const geo = new THREE.ExtrudeGeometry(tileShape, { depth: BOARD_DEPTH, bevelEnabled: true, bevelThickness: 0.8, bevelSize: 0.8, bevelSegments: 2, curveSegments: 8 });
  const board = new THREE.Mesh(geo, [new THREE.MeshLambertMaterial({ color: DIORAMA.field }), new THREE.MeshLambertMaterial({ color: DIORAMA.earth })]);
  board.rotation.x = -Math.PI / 2; board.position.y = -BOARD_DEPTH - 0.8 - 0.1; board.castShadow = true; board.receiveShadow = true; root.add(board);
  // two strata lines down the earth edge
  [0.35, 0.7].forEach((k) => { const pts = tileShape.getSpacedPoints(120).map((q) => W(q.x, q.y, -BOARD_DEPTH * k)); root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: DIORAMA.earthDark }))); });
  const pavedAll = pads.concat(zones.flatMap((z) => (z.polys && z.polys.length ? z.polys : [z.uv]).filter((p) => p && p.length > 2))); const hedgeBits = [];
  const lawns = parcels.map((p) => clipRect(p, tile)).filter((p) => p.length > 2);
  lawns.forEach((p) => {
    flat(p, DIORAMA.grass, -0.06);
    // a low hedge along the property line, inside the tile
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length]; const onEdge = (q) => Math.abs(q[0] - u0) < 0.01 || Math.abs(q[0] - u1) < 0.01 || Math.abs(q[1] - v0) < 0.01 || Math.abs(q[1] - v1) < 0.01;
      if (onEdge(a) && onEdge(b) && (Math.abs(a[0] - b[0]) < 0.01 || Math.abs(a[1] - b[1]) < 0.01)) continue;   // the tile's own edge, not the property line
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1) continue;
      // in 4 m pieces, leaving gaps where the line crosses paving or a lot
      const n = Math.ceil(L / 4); const h = Math.atan2(b[1] - a[1], b[0] - a[0]);
      for (let k = 0; k < n; k++) {
        const m0 = (k + 0.5) / n; const mid = [a[0] + (b[0] - a[0]) * m0, a[1] + (b[1] - a[1]) * m0];
        if (pavedAll.some((q) => inPoly(mid, q)) || rectHits(rects, mid[0], mid[1], 1)) continue;
        hedgeBits.push({ u: mid[0], v: mid[1], h, len: L / n });
      }
    }
  });
  if (hedgeBits.length) {
    const hm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.9, 0.9), new THREE.MeshLambertMaterial({ color: DIORAMA.hedge }), hedgeBits.length);
    const m4 = new THREE.Matrix4(); const q = new THREE.Quaternion(); const up = new THREE.Vector3(0, 1, 0);
    hedgeBits.forEach((b, i) => { m4.compose(W(b.u, b.v, 0.4), q.setFromAxisAngle(up, b.h), new THREE.Vector3(b.len, 1, 1)); hm.setMatrixAt(i, m4); });
    hm.castShadow = true; hm.receiveShadow = true; root.add(hm);
  }
  const boardTop = [floor, board];

  // ---- paving: pads are asphalt, RV lots gravel, with a white edge stripe ----
  pads.forEach((p) => { const c = clipRect(p, tile); if (c.length > 2) flat(c, DIORAMA.asphalt, 0.01); });
  zones.forEach((z) => {
    if (z.kind === 'canopy') return;
    (z.polys && z.polys.length ? z.polys : [z.uv]).filter((p) => p && p.length > 2).forEach((p) => {
      flat(p, DIORAMA.gravel, 0.025);
      const ring = new THREE.BufferGeometry().setFromPoints(p.concat([p[0]]).map((q) => W(q[0], q[1], 0.06)));
      root.add(new THREE.Line(ring, new THREE.LineBasicMaterial({ color: DIORAMA.stripe })));
    });
  });

  // ---- trees: scattered over the unpaved board, thicker on the neighbors' side ----
  const paved = pads.concat(zones.flatMap((z) => (z.polys && z.polys.length ? z.polys : [z.uv]).filter((p) => p && p.length > 2)));
  const gatesUv = (model.gates || []).map((g) => g.uv);
  const treeSpots = []; const step = Math.max(7, (u1 - u0 + v1 - v0) / 90);
  for (let u = u0 + 3; u < u1 - 3; u += step) for (let v = v0 + 3; v < v1 - 3; v += step) {
    const pt = [u + (rand() - 0.5) * step * 0.9, v + (rand() - 0.5) * step * 0.9];
    if (pt[0] < u0 + 2 || pt[0] > u1 - 2 || pt[1] < v0 + 2 || pt[1] > v1 - 2) continue;
    const ownLand = lawns.some((p) => inPoly(pt, p));
    if (rand() > (ownLand ? 0.22 : 0.42)) continue;
    if (paved.some((q) => inPoly(pt, q) || nearPoly(pt, q, 3)) || rectHits(rects, pt[0], pt[1], 3) || gatesUv.some((g) => Math.hypot(g[0] - pt[0], g[1] - pt[1]) < 12)) continue;
    treeSpots.push(pt);
  }
  if (treeSpots.length) {
    const n = Math.min(treeSpots.length, 900);
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.35, 2.2, 6), new THREE.MeshLambertMaterial({ color: 0x8a6142 }), n);
    const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), n);
    const greens = [0x5f9e5a, 0x74b06a, 0x4f8a52, 0x8cbf6d, 0x6aa86b, 0xa3c46a].map((c) => new THREE.Color(c));
    const m4 = new THREE.Matrix4(); const q = new THREE.Quaternion(); const sc = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const [u, v] = treeSpots[i]; const s = 1.6 + rand() * 1.8;
      m4.compose(W(u, v, 1.1), q.identity(), sc.set(1, 1, 1)); trunk.setMatrixAt(i, m4);
      q.setFromEuler(new THREE.Euler(rand(), rand() * 6, rand())); m4.compose(W(u, v, 2.2 + s * 0.8), q, sc.set(s, s * 1.15, s)); crown.setMatrixAt(i, m4);
      crown.setColorAt(i, greens[Math.floor(rand() * greens.length)]);
    }
    trunk.castShadow = crown.castShadow = true; root.add(trunk); root.add(crown);
  }

  // ---- gates: two posts and a striped arm that lifts now and then ----
  const arms = [];
  (model.gates || []).forEach((g) => {
    const post = new THREE.MeshLambertMaterial({ color: 0x3b3f45 });
    [-3.2, 3.2].forEach((o) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.6, 0.6), post); m.position.copy(W(g.uv[0] + o, g.uv[1], 0.8)); m.castShadow = true; root.add(m); });
    const pivot = new THREE.Group(); pivot.position.copy(W(g.uv[0] - 3.2, g.uv[1], 1.4)); root.add(pivot);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.22, 0.22), new THREE.MeshLambertMaterial({ color: 0xd94b3d })); arm.position.x = 3.2; arm.castShadow = true; pivot.add(arm);
    for (let i = 0; i < 3; i++) { const w = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.24, 0.24), new THREE.MeshLambertMaterial({ color: 0xffffff })); w.position.x = 1 + i * 2; pivot.add(w); }
    arms.push({ pivot, phase: rand() * 10 });
  });

  // ---- traffic: a loop around each building where the aisle is clear, and a perimeter loop per lot ----
  const routes = [];
  const clear = (pts, ownIdx) => pts.every((p, i) => {
    const q = pts[(i + 1) % pts.length];
    for (let k = 0; k <= 8; k++) { const u = p[0] + (q[0] - p[0]) * k / 8, v = p[1] + (q[1] - p[1]) * k / 8; if (rects.some((r, j) => j !== ownIdx && u > r.u0 - 0.8 && u < r.u1 + 0.8 && v > r.v0 - 0.8 && v < r.v1 + 0.8)) return false; }
    return true;
  });
  rects.forEach((r, idx) => {
    if ((r.u1 - r.u0) * (r.v1 - r.v0) < 120) return;
    for (const o of [4.5, 3.6, 3]) {
      const pts = [[r.u0 - o, r.v0 - o], [r.u1 + o, r.v0 - o], [r.u1 + o, r.v1 + o], [r.u0 - o, r.v1 + o]];
      if (clear(pts, idx) && pts.every((p) => (pads.length ? pads : parcels).some((pp) => inPoly(p, pp)))) { routes.push({ pts, y: 0.05 }); break; }
    }
  });
  zones.filter((z) => z.kind !== 'canopy').forEach((z) => {
    (z.polys && z.polys.length ? z.polys : [z.uv]).filter((p) => p && p.length > 2).forEach((p) => {
      const pts = dropShortEdges(inset(p, 3), 4);
      if (pts.length > 2 && routeLength(pts) > 60 && pts.every((q) => inPoly(q, p)) && clear(pts, -1)) routes.push({ pts, y: 0.07, lot: true });
    });
  });
  const cars = [];
  const maxCars = 9; let ci = 0;
  routes.sort((a, b) => routeLength(b.pts) - routeLength(a.pts));
  routes.forEach((r) => {
    const L = routeLength(r.pts); const count = Math.max(1, Math.min(3, Math.round(L / 220)));
    for (let k = 0; k < count && cars.length < maxCars; k++) {
      const kind = r.lot ? (rand() < 0.6 ? 'rv' : 'truck') : (rand() < 0.25 ? 'truck' : 'car');
      const mesh = makeCar(DIORAMA.cars[ci++ % DIORAMA.cars.length], kind); root.add(mesh);
      // stop-and-go: each vehicle pauses for a few seconds at one corner, like someone at their unit
      cars.push({ mesh, r, L, s: (L * (k + rand() * 0.5)) / count, speed: r.lot ? 5 : 3.6, dir: rand() < 0.5 ? 1 : -1, wait: 0, heading: null, stopAt: Math.floor(rand() * r.pts.length) });
    }
  });

  // ---- parked vehicles on leased stalls (owner view only: the public model carries no occupancy) ----
  const parked = new THREE.Group(); root.add(parked);
  function setParked(units, owner) {
    while (parked.children.length) { const c = parked.children[0]; parked.remove(c); c.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()); }); }
    if (!owner) return;
    const pr = rng(seed ^ 0x9e3779b9);
    (units || []).filter((u) => u.k === 'park' && u.l === 1 && u.wu * u.dv > 12).slice(0, 400).forEach((u) => {
      const long = Math.max(u.wu, u.dv); const kind = long >= 11 ? 'rv' : long >= 7 ? 'truck' : 'car';
      const m = makeCar(DIORAMA.cars[Math.floor(pr() * DIORAMA.cars.length)], kind);
      const s = Math.min(1, (long - 0.8) / (kind === 'rv' ? 9 : kind === 'truck' ? 6 : 4.4));
      m.scale.setScalar(s); m.position.copy(W(u.u + u.wu / 2, u.v + u.dv / 2, 0.08)); m.rotation.y = u.wu >= u.dv ? 0 : Math.PI / 2;
      m.traverse((o) => { o.castShadow = false; }); parked.add(m);
    });
  }

  let t = 0;
  function update(dt) {
    t += dt;
    cars.forEach((c) => {
      if (c.wait > 0) { c.wait -= dt; return; }
      const before = c.s; c.s = (c.s + c.dir * c.speed * dt + c.L) % c.L;
      // corner index crossed?
      let acc = 0; const pts = c.r.pts;
      for (let i = 0; i < pts.length; i++) { acc += Math.hypot(pts[(i + 1) % pts.length][0] - pts[i][0], pts[(i + 1) % pts.length][1] - pts[i][1]); if (i === c.stopAt && ((before < acc && c.s >= acc && c.dir > 0) || (before > acc && c.s <= acc && c.dir < 0))) { c.wait = 3 + (c.mesh.id % 4); c.stopAt = (c.stopAt + 2) % pts.length; } }
      const p = pointAt(pts, c.s); const want = p.h + (c.dir < 0 ? Math.PI : 0);
      if (c.heading === null) c.heading = want;
      let d = want - c.heading; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      c.heading += d * Math.min(1, dt * 6);
      // keep to the right-hand side of the aisle
      const off = 1.4 * c.dir; const nu = -Math.sin(p.h) * off, nv = Math.cos(p.h) * off;
      c.mesh.position.copy(W(p.u - nu, p.v - nv, c.r.y)); c.mesh.rotation.y = c.heading;
    });
    arms.forEach((a) => { const k = (t + a.phase) % 14; const lift = k < 1 ? k : k < 4 ? 1 : k < 5 ? 5 - k : 0; a.pivot.rotation.z = lift * 1.35; });
  }

  update(0);   // place every vehicle, so a still frame (reduced motion) still shows traffic

  return {
    tile,
    ground: boardTop,
    update,
    setParked,
    hasTraffic: cars.length > 0,
    dispose() { scene.remove(root); root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); }); }); },
  };
}
