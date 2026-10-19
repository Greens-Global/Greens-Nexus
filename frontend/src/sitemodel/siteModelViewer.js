// Site model viewer core (Neil, Oct 11 2026) - framework-free three.js scene
// for one property's to-scale site model (backend/site_models/<id>.json).
//
// World frame: x = u (along the site axis, southeast), y = up, z = -v (so the
// northeast side of the site is away from a camera parked at theta 0). One
// world unit is one meter. The React wrappers (SiteModelPanel.jsx) own every
// piece of DOM except the canvas; this module only draws, picks and animates.
import * as THREE from 'three';
import { buildDiorama, DIORAMA } from './siteModelDiorama.js';
import { planRoute } from './siteModelRoute.js';

const KIND_COLORS = {
  neutral: 0xd9d0bb, neutralPark: 0xc7c1b2, ok: 0x5fae7d, warn: 0xe0b45a, bad: 0xd65a4c, sel: 0xff7a00,
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function textSprite(text, opts = {}) {
  const size = opts.size || 64; const pad = 12;
  const font = `${opts.weight || 600} ${size}px ${opts.mono ? 'ui-monospace, Menlo, monospace' : 'Inter, system-ui, sans-serif'}`;
  const cv = document.createElement('canvas'); const ctx = cv.getContext('2d');
  ctx.font = font; const tw = ctx.measureText(text).width; cv.width = Math.ceil(tw + pad * 2); cv.height = size + pad * 2;
  ctx.font = font; ctx.textBaseline = 'middle';
  if (opts.bg) { ctx.fillStyle = opts.bg; roundRect(ctx, 0, 0, cv.width, cv.height, 14); ctx.fill(); }
  ctx.fillStyle = opts.color || '#1d1f1a'; ctx.fillText(text, pad, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter; tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: opts.depthTest !== false }));
  const h = opts.worldHeight || 6; sp.scale.set(h * cv.width / cv.height, h, 1); return sp;
}

function solarTexture(light) {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 32; const x = cv.getContext('2d');
  x.fillStyle = light ? '#e4ebf2' : '#243247'; x.fillRect(0, 0, 64, 32); x.fillStyle = light ? '#5b7fae' : '#1b2638';
  for (let i = 0; i < 64; i += 8) for (let j = 0; j < 32; j += 16) x.fillRect(i + 1, j + 1, 6, 14);
  x.strokeStyle = light ? '#e4ebf2' : '#4e6a9a'; x.lineWidth = 1;
  for (let i = 0; i < 64; i += 8) { x.beginPath(); x.moveTo(i + 0.5, 0); x.lineTo(i + 0.5, 32); x.stroke(); }
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(40, 8); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** Ribbed-metal texture for the illustrated look's walls and roofs (repeat it along the face). */
function ribTexture(color, dark, light) {
  const cv = document.createElement('canvas'); cv.width = 32; cv.height = 8; const x = cv.getContext('2d');
  x.fillStyle = color; x.fillRect(0, 0, 32, 8); x.fillStyle = dark; x.fillRect(0, 0, 3, 8); x.fillStyle = light; x.fillRect(3, 0, 2, 8);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** A roll-up door: pale steel with horizontal slats, so a drive-up row reads as doors. */
function doorTexture() {
  const cv = document.createElement('canvas'); cv.width = 8; cv.height = 32; const x = cv.getContext('2d');
  x.fillStyle = '#8d939a'; x.fillRect(0, 0, 8, 32); x.fillStyle = '#6c7279';
  for (let j = 0; j < 32; j += 4) x.fillRect(0, j, 8, 1);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** A soft dark pad under a building - contact shadow / ambient occlusion where walls meet the ground. */
function contactTexture() {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64; const x = cv.getContext('2d');
  const g = x.createRadialGradient(32, 32, 8, 32, 32, 32); g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.6, 'rgba(0,0,0,0.28)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(cv); return t;
}

/** The route ribbon: a bright band with white chevrons pointing along it (the texture scrolls, so they move). */
function routeTexture() {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 32; const x = cv.getContext('2d');
  x.fillStyle = '#1a73e8'; x.fillRect(0, 0, 64, 32); x.fillStyle = 'rgba(255,255,255,0.95)';
  x.beginPath(); x.moveTo(18, 6); x.lineTo(34, 16); x.lineTo(18, 26); x.lineTo(26, 16); x.closePath(); x.fill();
  const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

/** Mix a 0xRRGGBB color toward `to` by k (0 = unchanged). */
export function mixHex(from, to, k) {
  const f = (c, sh) => (c >> sh) & 255; const m = (sh) => Math.round(f(from, sh) + (f(to, sh) - f(from, sh)) * k);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

/** The color a unit is drawn in, before focus dimming: a layer's color when one
 *  is set (owners only - customers never see occupancy), else the occupancy palette. */
export function baseUnitColor(u, mode, colors, neutral = KIND_COLORS.neutral, neutralPark = KIND_COLORS.neutralPark) {
  if (mode === 'customer') return u.k === 'park' ? neutralPark : neutral;
  if (colors && colors[u.n] != null) return typeof colors[u.n] === 'string' ? parseInt(colors[u.n].replace('#', ''), 16) : colors[u.n];
  if (u.r === 0) return KIND_COLORS.bad; if (u.l === 1) return KIND_COLORS.ok; return KIND_COLORS.warn;
}

/** Frees the GPU side of a scene object (geometry, material, texture) and its children. */
function disposeObject(o) {
  o.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    const mats = Array.isArray(c.material) ? c.material : c.material ? [c.material] : [];
    mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
  });
}
function clearGroup(g) { while (g.children.length) { const c = g.children[0]; g.remove(c); disposeObject(c); } }

function centroid(pts) {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; const c = p[0] * q[1] - q[0] * p[1]; a += c; x += (p[0] + q[0]) * c; y += (p[1] + q[1]) * c; }
  a *= 0.5; return a ? [x / (6 * a), y / (6 * a)] : [pts[0][0], pts[0][1]];
}

/**
 * Mounts the viewer into `container` (a positioned block element) and returns a
 * small control surface. `images` = { detail, wide } URLs of the satellite
 * imagery the model's `image` / `imageWide` corners describe. `style` is
 * 'satellite' (the photo under the model) or 'illustrated' (a miniature board
 * with trees and traffic, siteModelDiorama.js); both draw the same geometry.
 */
export function createSiteModelViewer(container, model, options = {}) {
  const opts = { mode: 'customer', style: 'satellite', images: {}, onSelectUnit: null, onSelectBuilding: null, onPlacePin: null, onHover: null, ...options };
  const state = { mode: opts.mode, selected: null, xray: false, level: 0, placing: false, pins: [], markers: {}, colors: opts.colors || null, explode: false, routeFor: null, focusDim: opts.focusDim };
  const units = model.units || []; const byName = {}; units.forEach((u) => { byName[u.n] = u; });
  const buildings = {}; (model.buildings || []).forEach((b) => { buildings[b.id] = b; });
  const W = (u, v, y) => new THREE.Vector3(u, y || 0, -v);
  const illus = opts.style === 'illustrated';
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const el = renderer.domElement; el.style.display = 'block'; el.style.width = '100%'; el.style.height = '100%'; el.style.touchAction = 'none';
  container.appendChild(el);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(illus ? DIORAMA.sky : opts.background || '#dfe6e9');
  // The illustrated look uses a long lens (flatter, toy-like) and cool, even light.
  const camera = new THREE.PerspectiveCamera(illus ? 30 : 45, 1, 1, 6000);
  scene.add(new THREE.HemisphereLight(0xffffff, illus ? 0xcfd6e0 : 0x777766, illus ? 1.35 : 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, illus ? 1.75 : 1.6); sun.position.set(-160, 260, 120); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -260, right: 260, top: 260, bottom: -260, near: 50, far: 700 }); sun.shadow.bias = -0.0008;
  scene.add(sun); scene.add(sun.target);

  const mat = {
    wall: new THREE.MeshLambertMaterial({ color: illus ? DIORAMA.wall : 0xe9e6dd }),
    roofWhite: new THREE.MeshLambertMaterial({ color: 0xf4f2ec }),
    roofSolar: new THREE.MeshLambertMaterial({ map: solarTexture(illus) }),
    roofRed: new THREE.MeshLambertMaterial({ color: 0xb8553b }),
    edge: new THREE.LineBasicMaterial({ color: illus ? DIORAMA.edge : 0x55584f }),
    parcel: new THREE.LineBasicMaterial({ color: 0x1f6f4a }),
    pad: new THREE.MeshBasicMaterial({ color: 0x8a8f94, transparent: true, opacity: 0.28, depthWrite: false }),
    zone: new THREE.MeshBasicMaterial({ color: 0xd9b36a, transparent: true, opacity: 0.22, depthWrite: false }),
    zoneLine: new THREE.LineBasicMaterial({ color: 0xa87a1d }),
    canopy: new THREE.MeshLambertMaterial({ color: 0xf4f2ec, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    door: illus ? new THREE.MeshLambertMaterial({ color: DIORAMA.door }) : new THREE.MeshBasicMaterial({ color: 0x5a5d55 }),
    pin: { maintenance: new THREE.MeshLambertMaterial({ color: 0xe03a2f }), inspection: new THREE.MeshLambertMaterial({ color: 0x2f6fe0 }), note: new THREE.MeshLambertMaterial({ color: 0x8a5fd0 }) },
    marker: new THREE.MeshLambertMaterial({ color: 0xe03a2f, emissive: 0x330000 }),
  };
  Object.keys(KIND_COLORS).forEach((k) => { mat[k] = new THREE.MeshLambertMaterial({ color: KIND_COLORS[k] }); });
  if (illus) { mat.neutral.color.set(DIORAMA.neutral); mat.neutralPark.color.set(DIORAMA.neutralPark); }
  mat.sel.emissive = new THREE.Color(0x663300);
  // Gate, building and lot names keep one on-screen size at every zoom and never
  // pile on top of each other: each frame the most important label wins a spot.
  const screenLabels = [];
  function screenLabel(sp, px, prio) {
    sp.material.sizeAttenuation = false; sp.material.depthTest = false; sp.renderOrder = 10;
    sp.userData.px = px; sp.userData.aspect = sp.scale.x / sp.scale.y; sp.userData.prio = prio; screenLabels.push(sp);
  }

  // ---- ground ----
  const base = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800), new THREE.MeshLambertMaterial({ color: 0x9aa18f }));
  base.rotation.x = -Math.PI / 2; base.position.y = -0.3; base.receiveShadow = true;
  const diorama = illus ? buildDiorama(scene, model, W) : null;
  if (!illus) scene.add(base);
  const groundHits = diorama ? diorama.ground : [base];
  const loader = new THREE.TextureLoader();
  function quad(corners, src, y, fallback) {
    const g = new THREE.BufferGeometry(); const pos = []; corners.forEach((p) => pos.push(p[0], y, -p[1]));
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    g.setIndex([0, 2, 1, 0, 3, 2]); g.computeVertexNormals();
    const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
    if (src) loader.load(src, (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); m.map = t; m.needsUpdate = true; }, undefined, () => m.color.set(fallback));
    else m.color.set(fallback);
    const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; scene.add(mesh);
  }
  if (!illus && model.imageWide && model.imageWide.uv) quad(model.imageWide.uv, opts.images.wide, -0.12, 0xa3a898);
  if (!illus && model.image && model.image.uv) quad(model.image.uv, opts.images.detail, -0.05, 0xb8b4a8);

  function flatPoly(pts, material, y) { const s = new THREE.Shape(); pts.forEach((p, i) => (i ? s.lineTo(p[0], p[1]) : s.moveTo(p[0], p[1]))); const m = new THREE.Mesh(new THREE.ShapeGeometry(s), material); m.rotation.x = -Math.PI / 2; m.position.y = y; return m; }
  function lineLoop(pts, material, y) { const g = new THREE.BufferGeometry().setFromPoints(pts.concat([pts[0]]).map((p) => W(p[0], p[1], y))); return new THREE.Line(g, material); }
  const pads = model.pads || (model.pad ? [model.pad] : []);
  const parcels = model.parcels ? model.parcels.map((p) => p.uv) : model.parcel ? [model.parcel] : [];
  // The illustrated board paints its own paving and parcel edge.
  if (!illus) pads.forEach((p) => { if (p && p.length > 2) scene.add(flatPoly(p, mat.pad, 0.02)); });
  if (!illus) parcels.forEach((p) => { if (p && p.length > 2) scene.add(lineLoop(p, mat.parcel, 0.4)); });
  (model.zones || []).forEach((z) => {
    const polys = (z.polys && z.polys.length ? z.polys : [z.uv]).filter((p) => p && p.length > 2);
    if (!polys.length) return;
    if (z.kind === 'canopy') {
      // A roof over open stalls: a translucent slab on posts, so the stalls under it stay visible.
      polys.forEach((p) => { const slab = flatPoly(p, mat.canopy, 4.2); scene.add(slab); scene.add(lineLoop(p, mat.edge, 4.2)); p.forEach((c) => { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 4.2, 6), mat.door); post.position.copy(W(c[0], c[1], 2.1)); scene.add(post); }); });
    } else {
      if (!illus) polys.forEach((p) => { scene.add(flatPoly(p, mat.zone, 0.04)); scene.add(lineLoop(p, mat.zoneLine, 0.1)); });
    }
    const c = centroid(polys[0]); const l = textSprite(z.name, { size: 48, bg: 'rgba(255,255,255,0.8)', worldHeight: 4 }); l.position.copy(W(c[0], c[1], z.kind === 'canopy' ? 7 : 4)); scene.add(l); screenLabel(l, 17, 1);
  });
  (model.gates || []).forEach((g) => { const l = textSprite(g.name, { size: 48, bg: 'rgba(31,111,74,0.9)', color: '#fff', worldHeight: 4 }); l.position.copy(W(g.uv[0], g.uv[1], illus ? 4.5 : 3)); scene.add(l); screenLabel(l, 20, 9); if (illus) return; const post = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 2.5, 8), new THREE.MeshLambertMaterial({ color: 0x1f6f4a })); post.position.copy(W(g.uv[0], g.uv[1], 1.25)); scene.add(post); });

  // ---- buildings ----
  const shells = [];
  (model.buildings || []).forEach((b, bi) => {
    const L = b.u[1] - b.u[0], Wd = b.v[1] - b.v[0];
    let roof = b.roof === 'solar' ? mat.roofSolar : b.roof === 'red' ? mat.roofRed : mat.roofWhite;
    let mats = [mat.wall, mat.wall, roof, mat.wall, mat.wall, mat.wall].map((m) => m.clone());
    if (illus) {
      // Ribbed metal in the brand green, the office white with a green roof.
      // Box faces: +x / -x are the ends (Wd wide), +z / -z the long sides (L wide).
      const office = b.kind === 'office' || b.roof === 'red';
      const wc = office ? '#f6f8fa' : '#2f855a', wd = office ? '#dfe4ea' : '#25704a', wl = office ? '#ffffff' : '#3d9c6b';
      const wall = (w) => { const t = ribTexture(wc, wd, wl); t.repeat.set(Math.max(1, w / 1.2), 1); return new THREE.MeshLambertMaterial({ map: t }); };
      if (b.roof === 'solar') roof = mat.roofSolar.clone();
      else { const t = ribTexture(office ? '#2f855a' : '#3d9c6b', office ? '#25704a' : '#2f855a', office ? '#3d9c6b' : '#52b07f'); t.repeat.set(Math.max(1, L / 1.4), 1); roof = new THREE.MeshLambertMaterial({ map: t }); }
      mats = [wall(Wd), wall(Wd), roof, mat.wall.clone(), wall(L), wall(L)];
    }
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(L, b.height, Wd), mats); mesh.userData.index = bi;
    mesh.position.copy(W((b.u[0] + b.u[1]) / 2, (b.v[0] + b.v[1]) / 2, b.height / 2));
    mesh.userData.building = b; mesh.castShadow = true; scene.add(mesh); shells.push(mesh);
    if (illus) {   // a roof cap with a small overhang reads as a toy building from far away
      const cap = new THREE.Mesh(new THREE.BoxGeometry(L + 0.8, 0.45, Wd + 0.8), roof); cap.position.copy(W((b.u[0] + b.u[1]) / 2, (b.v[0] + b.v[1]) / 2, b.height + 0.22)); cap.castShadow = true; scene.add(cap); mesh.userData.cap = cap;
    }
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), mat.edge); edges.position.copy(mesh.position); scene.add(edges);
    for (let f = 2; f <= b.floors; f++) { const y = b.height * (f - 1) / b.floors; scene.add(lineLoop([[b.u[0], b.v[0]], [b.u[1], b.v[0]], [b.u[1], b.v[1]], [b.u[0], b.v[1]]], mat.edge, y)); }
    const short = b.letters && b.letters.length && b.letters.length <= 2 && b.letters.every((l) => l.length <= 2);
    const label = textSprite(short ? b.letters.join(' / ') : b.name, { size: 72, bg: 'rgba(255,255,255,0.85)', worldHeight: short ? 7 : 4 });
    label.position.copy(W((b.u[0] + b.u[1]) / 2, (b.v[0] + b.v[1]) / 2, b.height + 5)); scene.add(label); screenLabel(label, short ? 24 : 17, 3 + Math.min(4, (L * Wd) / 2000));
    if (!illus) { const ao = new THREE.Mesh(new THREE.PlaneGeometry(L + 6, Wd + 6), new THREE.MeshBasicMaterial({ map: contactTexture(), transparent: true, depthWrite: false })); ao.rotation.x = -Math.PI / 2; ao.position.copy(W((b.u[0] + b.u[1]) / 2, (b.v[0] + b.v[1]) / 2, 0.06)); scene.add(ao); }
  });

  // ---- units ----
  // Instanced (Oct 20 2026): one draw call for every unit box and one for every
  // door instead of a mesh each (~1,800 at Escondido), so the model stays smooth
  // on a phone. Each unit keeps a record - where it sits, how tall, shown or not -
  // and a color that eases toward its target, so a layer switch fades, not snaps.
  const cellGeo = new THREE.BoxGeometry(1, 1, 1);
  const N = Math.max(1, units.length);
  const unitInst = new THREE.InstancedMesh(cellGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), N);
  unitInst.castShadow = !illus; unitInst.receiveShadow = true; unitInst.frustumCulled = false;
  const doorInst = new THREE.InstancedMesh(cellGeo, illus ? mat.door : new THREE.MeshLambertMaterial({ map: doorTexture() }), N);
  doorInst.frustumCulled = false; doorInst.count = 0;
  const recs = []; const recOf = {}; const ZERO = new THREE.Vector3(0, 0, 0); const UP = new THREE.Vector3(0, 1, 0);
  const tmpM = new THREE.Matrix4(); const tmpQ = new THREE.Quaternion(); const tmpV = new THREE.Vector3(); const tmpC = new THREE.Color();
  let doorCount = 0;
  units.forEach((u, i) => {
    const b = buildings[u.b]; const fh = b ? b.height / b.floors : 0; const baseY = (u.f - 1) * fh;
    const h = u.k === 'park' ? 0.12 : Math.min(2.2, Math.max(0.6, fh ? fh * 0.6 : 0.6));
    const pos = W(u.u + u.wu / 2, u.v + u.dv / 2, baseY + h / 2 + 0.03);
    const scale = new THREE.Vector3(Math.max(0.3, u.wu - 0.12), h, Math.max(0.3, u.dv - 0.12));
    // An angled stall from the as-built plans turns about its center (rot:
    // degrees counter-clockwise in u,v; W maps u,v to x,-z, so that is rotation.y).
    const rot = u.rot ? (u.rot * Math.PI) / 180 : 0;
    const r = { u, i, pos, scale, rot, h, door: null, visible: true, lift: 0 };
    if (u.k !== 'park' && b) {
      let dpos, dscale;
      if (u.door === 'w' || u.door === 'e') {   // rows that run across the frame: the door is on a u face
        dscale = new THREE.Vector3(0.25, h + 0.02, Math.max(0.3, u.dv - 0.3));
        dpos = W(u.door === 'e' ? u.u + u.wu - 0.12 : u.u + 0.12, u.v + u.dv / 2, baseY + h / 2 + 0.03);
      } else {
        dscale = new THREE.Vector3(Math.max(0.3, u.wu - 0.3), h + 0.02, 0.25);
        const vz = u.door === 'ne' ? u.v + u.dv - 0.12 : u.v + 0.12; dpos = W(u.u + u.wu / 2, vz, baseY + h / 2 + 0.03);
      }
      if (rot) {   // keep the door on its face of the turned unit
        const c = W(u.u + u.wu / 2, u.v + u.dv / 2, 0);
        dpos = c.clone().add(dpos.clone().sub(c).applyAxisAngle(UP, rot)).setY(baseY + h / 2 + 0.03);
      }
      r.door = { pos: dpos, scale: dscale, at: doorCount++ };
    }
    recs.push(r); recOf[u.n] = r;
  });
  doorInst.count = doorCount;
  // Floors lift apart under See Inside with All Levels (an exploded view), so
  // the upper floor no longer hides the one below.
  const EXPLODE = 2.6;
  const yOff = (r) => (state.explode && buildings[r.u.b] && buildings[r.u.b].floors > 1 ? (r.u.f - 1) * EXPLODE : 0) + r.lift;
  function placeInstance(r) {
    tmpQ.setFromAxisAngle(UP, r.rot); tmpV.copy(r.pos); tmpV.y += yOff(r);
    tmpM.compose(tmpV, tmpQ, r.visible ? r.scale : ZERO); unitInst.setMatrixAt(r.i, tmpM);
    if (r.door) { tmpV.copy(r.door.pos); tmpV.y += yOff(r); tmpM.compose(tmpV, tmpQ, r.visible ? r.door.scale : ZERO); doorInst.setMatrixAt(r.door.at, tmpM); }
  }
  recs.forEach(placeInstance);
  unitInst.instanceMatrix.needsUpdate = true; doorInst.instanceMatrix.needsUpdate = true;
  unitInst.computeBoundingSphere(); unitInst.computeBoundingBox();
  scene.add(unitInst); scene.add(doorInst);
  const colCur = new Float32Array(N * 3); const colTo = new Float32Array(N * 3); let colorsMoving = false;
  recs.forEach((r) => unitInst.setColorAt(r.i, tmpC.setHex(KIND_COLORS.neutral)));
  /** Where a unit's box sits now (exploded floors included). */
  const unitTop = (r) => new THREE.Vector3(r.pos.x, r.pos.y + yOff(r) + r.h / 2, r.pos.z);

  // ---- north arrow + 50 ft bar ----
  if (model.gates && model.gates.length && model.frame && model.frame.north) {
    const g = model.gates[0].uv; const n = model.frame.north; const at = [g[0] + 30, g[1] + 2];
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(1.6, 7, 12), new THREE.MeshLambertMaterial({ color: 0x1f6f4a }));
    arrow.position.copy(W(at[0], at[1], 0.6)); arrow.lookAt(W(at[0] + n[0] * 10, at[1] + n[1] * 10, 0.6)); arrow.rotateX(Math.PI / 2); scene.add(arrow);
    const nl = textSprite('N', { size: 64, bg: 'rgba(255,255,255,0.85)', worldHeight: 3 }); nl.position.copy(W(at[0] + n[0] * 6, at[1] + n[1] * 6, 3)); scene.add(nl);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(15.24, 0.5, 1.2), new THREE.MeshLambertMaterial({ color: 0x1d1f1a })); bar.position.copy(W(at[0] + 8, at[1] - 8, 0.3)); scene.add(bar);
    const sl = textSprite('50 ft', { size: 48, bg: 'rgba(255,255,255,0.85)', worldHeight: 2.6 }); sl.position.copy(W(at[0] + 8, at[1] - 8, 2.2)); scene.add(sl);
  }

  // ---- selection furniture ----
  const beacon = new THREE.Group(); scene.add(beacon);
  const unitLabels = new THREE.Group(); scene.add(unitLabels); let labelsFor = null;
  const pinGroup = new THREE.Group(); scene.add(pinGroup);
  const markerGroup = new THREE.Group(); scene.add(markerGroup);
  const routeGroup = new THREE.Group(); scene.add(routeGroup); let route = null; let routeTex = null; let routeReveal = null;
  // The chosen unit is drawn on its own, raised a little above its row and glowing.
  const selMesh = new THREE.Mesh(cellGeo, mat.sel); selMesh.visible = false; selMesh.castShadow = !illus; scene.add(selMesh);
  const selDoor = new THREE.Mesh(cellGeo, doorInst.material); selDoor.visible = false; scene.add(selDoor);
  let selLift = 0;

  // Unit numbers: only on the chosen building's chosen floor, and only close up (see the loop).
  function showUnitLabels(bid, level) {
    const key = bid ? `${bid}:${level}:${state.explode ? 1 : 0}` : null;
    if (labelsFor === key) return; labelsFor = key;
    clearGroup(unitLabels);
    if (!bid) return;
    const b = buildings[bid]; const multi = b && b.floors > 1;
    recs.filter((r) => r.u.b === bid && (!multi || r.u.f === (level || 1))).forEach((r) => { const x = r.u; const sp = textSprite(x.n, { size: 40, mono: true, weight: 500, bg: 'rgba(255,255,255,0.82)', worldHeight: Math.min(1.6, Math.max(0.9, x.wu * 0.45)) }); sp.position.copy(unitTop(r)); sp.position.y += 0.6; sp.userData.unit = x; unitLabels.add(sp); });
  }
  function updateBeacon() {
    clearGroup(beacon);
    if (!state.selected) return; const u = byName[state.selected]; const p = unitTop(recOf[u.n]); p.y -= recOf[u.n].h / 2;
    if (illus) {   // a map pin over the unit, like a pin on a delivery map; sized to the zoom in the loop
      const pin = new THREE.Group(); pin.position.set(p.x, p.y + 0.12, p.z); pin.userData.pin = true; beacon.add(pin);
      const pinMat = new THREE.MeshLambertMaterial({ color: 0xff7a00 }); const top = 9;
      const head = new THREE.Mesh(new THREE.SphereGeometry(2.2, 20, 14), pinMat); head.position.set(0, top + 2.2, 0); pin.add(head);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.95, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffffff })); dot.position.set(0, top + 2.4, 0); pin.add(dot);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(1.75, 4.6, 20), pinMat); tip.position.set(0, top - 0.7, 0); tip.rotation.x = Math.PI; pin.add(tip);
      const lab = textSprite(u.n, { size: 64, mono: true, bg: 'rgba(255,255,255,0.97)', color: '#1d1f1a', worldHeight: 3.6, depthTest: false }); lab.position.set(0, top + 7.6, 0); pin.add(lab);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.4, 32), new THREE.MeshBasicMaterial({ color: 0xff7a00, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, p.y + 0.12, p.z); ring.userData.pulse = true; beacon.add(ring);
      return;
    }
    const top = p.y + 28; const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, top - p.y, 6), new THREE.MeshBasicMaterial({ color: 0xff7a00 })); pole.position.set(p.x, (top + p.y) / 2, p.z); beacon.add(pole);
    const lab = textSprite(u.n, { size: 64, mono: true, bg: 'rgba(255,122,0,0.95)', color: '#fff', worldHeight: 5, depthTest: false }); lab.position.set(p.x, top + 3, p.z); beacon.add(lab);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.4, 2.2, 32), new THREE.MeshBasicMaterial({ color: 0xff7a00, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, p.y + 0.1, p.z); ring.userData.pulse = true; beacon.add(ring);
  }
  function renderPins() {
    clearGroup(pinGroup);
    if (state.mode !== 'owner') return;
    state.pins.forEach((p) => {
      const m = mat.pin[p.category] || mat.pin.maintenance; const y = p.y || 0;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.1, 3.2, 10), m); cone.position.copy(W(p.u, p.v, y + 1.6)); cone.rotation.x = Math.PI; pinGroup.add(cone);
      const head = new THREE.Mesh(new THREE.SphereGeometry(1.2, 10, 8), m); head.position.copy(W(p.u, p.v, y + 4)); pinGroup.add(head);
      const l = textSprite((p.unit ? p.unit + ' · ' : '') + p.title, { size: 44, bg: p.status === 'done' ? 'rgba(90,93,85,0.8)' : 'rgba(29,31,26,0.85)', color: '#fff', worldHeight: 2.8, depthTest: false }); l.position.copy(W(p.u, p.v, y + 7)); pinGroup.add(l);
    });
  }
  function renderMarkers() {
    clearGroup(markerGroup);
    if (state.mode !== 'owner') return;
    Object.keys(state.markers).forEach((n) => { const r = recOf[n]; if (!r || !r.visible) return; const p = unitTop(r); const s = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), mat.marker); s.position.set(p.x, p.y + 1.4, p.z); s.userData.unit = byName[n]; markerGroup.add(s); const l = textSprite(String(state.markers[n]), { size: 40, bg: 'rgba(224,58,47,0.95)', color: '#fff', worldHeight: 1.8, depthTest: false }); l.position.set(p.x, p.y + 3.2, p.z); markerGroup.add(l); });
  }

  // "How to Get There" drawn on the ground: a ribbon from the gate to the unit
  // that draws itself in, then keeps its chevrons moving toward the unit; a disc
  // marks each step of the route card (flyToStep moves the camera to one).
  function renderRoute() {
    clearGroup(routeGroup); route = null; routeTex = null;
    if (!state.selected || opts.route === false) return;
    const u = byName[state.selected]; const plan = planRoute(model, u, routeSteps(model, u));
    if (!plan || plan.points.length < 2) return;
    route = plan; const pts = plan.points; const y = illus ? 0.32 : 0.26; const half = 0.85;
    const pos = []; const uv = []; const idx = []; let dist = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1]; const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 0.01) continue;
      const nx = -(b[1] - a[1]) / len * half, ny = (b[0] - a[0]) / len * half; const base = pos.length / 3;
      [[a[0] + nx, a[1] + ny], [a[0] - nx, a[1] - ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny]].forEach((q) => pos.push(q[0], y, -q[1]));
      uv.push(dist / 2.4, 1, dist / 2.4, 0, (dist + len) / 2.4, 1, (dist + len) / 2.4, 0); dist += len;
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    routeTex = routeTexture();
    const ribbon = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: routeTex, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
    ribbon.renderOrder = 5; routeGroup.add(ribbon);
    routeReveal = { mesh: ribbon, total: idx.length, t0: performance.now() };
    if (reduceMotion) { routeReveal = null; } else g.setDrawRange(0, 0);
    // joints: round caps so the turns read as one line
    for (let i = 1; i < pts.length - 1; i++) { const d = new THREE.Mesh(new THREE.CircleGeometry(half, 16), ribbon.material); d.rotation.x = -Math.PI / 2; d.position.copy(W(pts[i][0], pts[i][1], y)); d.renderOrder = 5; routeGroup.add(d); }
    plan.stops.forEach((s, i) => {
      const end = !!s.end; const disc = new THREE.Mesh(new THREE.CylinderGeometry(end ? 1.5 : 1.25, end ? 1.5 : 1.25, 0.35, 24), new THREE.MeshLambertMaterial({ color: end ? 0xff7a00 : 0x1a73e8 }));
      disc.position.copy(W(s.uv[0], s.uv[1], y + 0.18)); routeGroup.add(disc);
      const l = textSprite(String(i + 1), { size: 48, bg: end ? 'rgba(255,122,0,0.95)' : 'rgba(26,115,232,0.95)', color: '#fff', worldHeight: 2.2, depthTest: false });
      l.position.copy(W(s.uv[0], s.uv[1], y + 2.6)); l.renderOrder = 11; routeGroup.add(l);
    });
  }

  function restyle(snap = false) {
    const xray = state.xray || state.mode === 'owner';
    const selB = state.selected ? byName[state.selected].b : null;
    const explode = !!state.xray && !state.level;
    const moved = explode !== state.explode; state.explode = explode;
    shells.forEach((m) => { const b = m.userData.building; const open = xray || selB === b.id || (state.level && b.floors > 1); m.material.forEach((mm) => { mm.transparent = open; mm.opacity = open ? 0.16 : 1; mm.depthWrite = !open; }); if (m.userData.cap) m.userData.cap.visible = !open; });
    const focus = state.selected && state.focusDim !== false;
    const neutral = mat.neutral.color.getHex(), neutralPark = mat.neutralPark.color.getHex();
    recs.forEach((r) => {
      const u = r.u; const b = buildings[u.b]; const multi = b && b.floors > 1;
      // A chosen level cuts away the floors above it; the floors below stay, dimmed.
      const lvlOk = !state.level || !multi || u.f <= state.level;
      const show = lvlOk && (!b || u.f === 1 || xray || selB === u.b || (multi && !!state.level)) && state.selected !== u.n;
      if (show !== r.visible || moved) { r.visible = show; placeInstance(r); }
      let c = baseUnitColor(u, state.mode, state.colors, neutral, neutralPark);
      if (multi && state.level && u.f < state.level) c = mixHex(c, 0xcfccc4, 0.6);
      if (focus && state.selected !== u.n) c = mixHex(c, u.b === selB ? 0xd8d5cc : 0xbdbab2, u.b === selB ? 0.35 : 0.55);
      tmpC.setHex(c); colTo[r.i * 3] = tmpC.r; colTo[r.i * 3 + 1] = tmpC.g; colTo[r.i * 3 + 2] = tmpC.b;
    });
    unitInst.instanceMatrix.needsUpdate = true; doorInst.instanceMatrix.needsUpdate = true;
    if (snap || reduceMotion) { colCur.set(colTo); pushColors(); } else colorsMoving = true;
    const sel = state.selected ? recOf[state.selected] : null;
    if (sel) {
      const b = buildings[sel.u.b]; const lvlOk = !state.level || !b || b.floors === 1 || sel.u.f <= state.level;
      selMesh.visible = lvlOk; selMesh.quaternion.setFromAxisAngle(UP, sel.rot); selMesh.scale.copy(sel.scale).multiplyScalar(1.04);
      selDoor.visible = lvlOk && !!sel.door; if (sel.door) { selDoor.scale.copy(sel.door.scale); selDoor.quaternion.copy(selMesh.quaternion); }
      selLift = 0;
    } else { selMesh.visible = false; selDoor.visible = false; }
    placeSelected();
    unitLabels.children.forEach((sp) => { sp.visible = !!recOf[sp.userData.unit.n]?.visible || sp.userData.unit.n === state.selected; });
    showUnitLabels(selB, state.level || (state.selected ? byName[state.selected].f : 0)); updateBeacon(); renderMarkers();
    if (state.routeFor !== state.selected) { state.routeFor = state.selected; renderRoute(); }
  }
  function pushColors() { for (let i = 0; i < recs.length; i++) { tmpC.setRGB(colCur[i * 3], colCur[i * 3 + 1], colCur[i * 3 + 2]); unitInst.setColorAt(i, tmpC); } if (unitInst.instanceColor) unitInst.instanceColor.needsUpdate = true; }
  function placeSelected() {
    const sel = state.selected ? recOf[state.selected] : null; if (!sel) return;
    const lift = Math.min(1.4, sel.h * 0.6) * selLift;
    selMesh.position.copy(sel.pos); selMesh.position.y += yOff(sel) + lift;
    if (sel.door) { selDoor.position.copy(sel.door.pos); selDoor.position.y += yOff(sel) + lift; }
  }
  // Every 120 ms: size the screen labels for this viewport and hide the ones a
  // more important label already covers.
  const projV = new THREE.Vector3(); let lastDeclutter = 0;
  const sortedLabels = () => screenLabels.slice().sort((a, b) => b.userData.prio - a.userData.prio);
  let labelOrder = null;
  function declutter(now) {
    if (now - lastDeclutter < 120) return; lastDeclutter = now;
    const H = el.clientHeight || 1, Wpx = el.clientWidth || 1; const k = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / H;
    labelOrder = labelOrder || sortedLabels(); const placed = [];
    for (const sp of labelOrder) {
      const px = sp.userData.px; sp.scale.set(px * sp.userData.aspect * k, px * k, 1);
      projV.copy(sp.position).project(camera);
      if (projV.z > 1 || Math.abs(projV.x) > 1.05 || Math.abs(projV.y) > 1.05) { sp.visible = false; continue; }
      const x = (projV.x + 1) / 2 * Wpx, y = (1 - projV.y) / 2 * H, w = px * sp.userData.aspect / 2 + 3, h = px / 2 + 2;
      const hit = placed.some((q) => Math.abs(q[0] - x) < q[2] + w && Math.abs(q[1] - y) < q[3] + h);
      sp.visible = !hit; if (!hit) placed.push([x, y, w, h]);
    }
    // unit numbers only once the camera is close enough to read them
    unitLabels.visible = ctrl.radius < 140;
  }

  // ---- camera ----
  // Framed on the developed area (pads, else parcels, else buildings), so a
  // 390 m RV lot and a 160 m yard both open filling the stage.
  const bounds = diorama ? (() => { const t = diorama.tile; return { cu: (t.u0 + t.u1) / 2, cv: (t.v0 + t.v1) / 2, r: Math.max(140, Math.hypot(t.u1 - t.u0, t.v1 - t.v0) * 1.25) }; })() : (() => {
    const pts = []; (pads.length ? pads : parcels).forEach((p) => p.forEach((q) => pts.push(q)));
    (model.buildings || []).forEach((b) => { pts.push([b.u[0], b.v[0]]); pts.push([b.u[1], b.v[1]]); });
    // And every unit (Oct 14 2026): a site whose paved-area outline covers
    // only the office yard (Fairfield) framed its whole stall lot off-screen.
    (model.units || []).forEach((x) => { pts.push([x.u, x.v]); pts.push([x.u + x.wu, x.v + x.dv]); });
    if (!pts.length) return { cu: 50, cv: 0, r: 320 };
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    pts.forEach(([u, v]) => { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); });
    return { cu: (u0 + u1) / 2, cv: (v0 + v1) / 2, r: Math.max(120, Math.hypot(u1 - u0, v1 - v0) * 0.95) };
  })();
  const ctrl = { target: W(bounds.cu, bounds.cv, 0), theta: illus ? -0.6 : 0, phi: illus ? 0.72 : 0.9, radius: bounds.r, min: 10, max: Math.max(1200, bounds.r * 3) };
  if (illus) scene.fog = new THREE.Fog(DIORAMA.fog, bounds.r * 1.8, bounds.r * 6);   // the far floor fades into the sky
  // A big board needs the sun pulled back, or the far corners fall outside the shadow box.
  const sunK = illus ? Math.max(1, bounds.r / 220) : 1;
  sun.target.position.copy(ctrl.target); sun.position.copy(ctrl.target.clone().add(new THREE.Vector3(-160, 260, 120).multiplyScalar(sunK)));
  Object.assign(sun.shadow.camera, { left: -bounds.r, right: bounds.r, top: bounds.r, bottom: -bounds.r, far: illus ? 330 * sunK + bounds.r * 1.6 : 700 }); sun.shadow.camera.updateProjectionMatrix();
  function applyCamera() {
    ctrl.phi = Math.max(0.08, Math.min(1.45, ctrl.phi)); ctrl.radius = Math.max(ctrl.min, Math.min(ctrl.max, ctrl.radius));
    camera.position.set(Math.sin(ctrl.theta) * Math.cos(ctrl.phi), Math.sin(ctrl.phi), Math.cos(ctrl.theta) * Math.cos(ctrl.phi)).multiplyScalar(ctrl.radius).add(ctrl.target); camera.lookAt(ctrl.target);
  }
  let anim = null; let idle = illus && !reduceMotion;
  function flyTo(target, theta, phi, radius, ms = 1100) {
    const from = { t: ctrl.target.clone(), theta: ctrl.theta, phi: ctrl.phi, r: ctrl.radius }; const t0 = performance.now();
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ms = 0;
    // the short way round, never a full spin
    const dTheta = Math.atan2(Math.sin(theta - from.theta), Math.cos(theta - from.theta)); theta = from.theta + dTheta;
    anim = (now) => { const k = ms ? Math.min(1, (now - t0) / ms) : 1; const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; ctrl.target.lerpVectors(from.t, target, e); ctrl.theta = from.theta + (theta - from.theta) * e; ctrl.phi = from.phi + (phi - from.phi) * e; ctrl.radius = from.r + (radius - from.r) * e; applyCamera(); if (k >= 1) anim = null; };
  }
  const gate0 = model.gates && model.gates.length ? model.gates[0].uv : null;
  const VIEWS = {
    overview: () => flyTo(W(bounds.cu, bounds.cv, 0), illus ? -0.6 : 0, illus ? 0.72 : 0.9, bounds.r),
    plan: () => flyTo(W(bounds.cu, bounds.cv, 0), 0, 1.45, bounds.r * 0.95),
    // Stand just outside the gate and look across the site.
    gate: () => { const g = gate0 || [bounds.cu, bounds.cv]; const theta = Math.atan2(g[0] - bounds.cu, -(g[1] - bounds.cv)); flyTo(W(g[0], g[1], 0), theta, 0.22, Math.max(90, bounds.r * 0.4)); },
  };
  let drag = null; const touches = new Map();
  function pan(dx, dy) { const s = ctrl.radius * 0.0016; const right = new THREE.Vector3(Math.cos(ctrl.theta), 0, -Math.sin(ctrl.theta)); const fwd = new THREE.Vector3(-Math.sin(ctrl.theta), 0, -Math.cos(ctrl.theta)); ctrl.target.addScaledVector(right, -dx * s).addScaledVector(fwd, -dy * s); }
  const onDown = (e) => { idle = false; el.setPointerCapture(e.pointerId); touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, button: e.button, moved: false, dist: null }; };
  const onMove = (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag) { hover(e); return; }
    if (touches.size === 2) { const pts = [...touches.values()]; const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y); const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2; if (drag.dist) { ctrl.radius *= drag.dist / d; pan(cx - drag.cx, cy - drag.cy); } drag.dist = d; drag.cx = cx; drag.cy = cy; drag.moved = true; applyCamera(); return; }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
    if (drag.button === 2 || e.shiftKey) pan(dx, dy); else { ctrl.theta -= dx * 0.006; ctrl.phi += dy * 0.006; }
    applyCamera();
  };
  const onUp = (e) => { touches.delete(e.pointerId); if (drag && !drag.moved && drag.button === 0) click(e); if (touches.size === 0) drag = null; else drag.dist = null; };
  const onWheel = (e) => { idle = false; e.preventDefault(); ctrl.radius *= Math.exp(e.deltaY * 0.0012); applyCamera(); };
  const onCtx = (e) => e.preventDefault();
  el.addEventListener('pointerdown', onDown); el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onUp);
  el.addEventListener('wheel', onWheel, { passive: false }); el.addEventListener('contextmenu', onCtx);

  // ---- picking ----
  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
  function cast(e, list) { const r = el.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); return ray.intersectObjects(list, false); }
  const pickList = () => (selMesh.visible ? [unitInst, selMesh] : [unitInst]);
  selMesh.userData.selected = true;
  /** The unit a ray hit: an instance id, or the raised selected box. */
  const unitOfHit = (h) => (!h ? null : h.object === selMesh ? byName[state.selected] : h.object === unitInst && recs[h.instanceId] && recs[h.instanceId].visible ? recs[h.instanceId].u : null);
  const firstUnit = (hits) => { for (const h of hits) { const u = unitOfHit(h); if (u) return { h, u }; } return null; };
  let hovered = null; let lastHoverAt = 0;
  function hover(e) {
    if (e.pointerType === 'touch') return;
    const now = performance.now(); if (now - lastHoverAt < 40) return; lastHoverAt = now;   // ~25 raycasts/s is plenty
    const hit = firstUnit(cast(e, pickList())); const r = el.getBoundingClientRect();
    el.style.cursor = hit ? 'pointer' : state.placing ? 'crosshair' : '';
    const unit = hit ? hit.u : null;
    if (unit === hovered) return;            // the React side re-renders only when the hovered unit changes
    hovered = unit;
    if (opts.onHover) opts.onHover(unit, { x: e.clientX - r.left, y: e.clientY - r.top });
  }
  function click(e) {
    if (state.placing) {
      const hits = cast(e, pickList().concat(shells, groundHits)); const uh = firstUnit(hits);
      const hit = uh ? uh.h : hits.find((h) => h.object !== unitInst && h.object !== selMesh);
      if (hit && opts.onPlacePin) { const u = uh ? uh.u : null; const b = hit.object.userData.building; opts.onPlacePin({ u: +hit.point.x.toFixed(2), v: +(-hit.point.z).toFixed(2), y: +hit.point.y.toFixed(2), unit: u ? u.n : '', building: u ? u.b : b ? b.id : '' }); }
      return;
    }
    const hit = firstUnit(cast(e, pickList()));
    if (hit) { selectUnit(hit.u.n, true); return; }
    const s = cast(e, shells)[0];
    if (s) { state.selected = null; state.level = 0; restyle(); const b = s.object.userData.building; flyTo(W((b.u[0] + b.u[1]) / 2, (b.v[0] + b.v[1]) / 2, 0), ctrl.theta, 0.8, Math.max(70, (b.u[1] - b.u[0]) * 0.9)); if (opts.onSelectBuilding) opts.onSelectBuilding(b); if (opts.onSelectUnit) opts.onSelectUnit(null); }
  }
  /** Frame the whole route, gate to unit (the customer page opens on this). */
  function fitRoute() {
    if (!route) return;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    route.points.forEach(([pu, pv]) => { u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); v0 = Math.min(v0, pv); v1 = Math.max(v1, pv); });
    // look from the gate's side toward the unit
    const g = route.points[0], e = route.points[route.points.length - 1];
    const theta = Math.atan2(g[0] - e[0], -(g[1] - e[1]));
    flyTo(W((u0 + u1) / 2, (v0 + v1) / 2, 0), theta, 0.85, Math.max(60, Math.hypot(u1 - u0, v1 - v0) * 1.15));
  }
  function selectUnit(name, fly = true) {
    const u = byName[name]; if (!u) return false;
    idle = false; state.selected = name; const b = buildings[u.b]; if (b && b.floors > 1) state.level = u.f; restyle();
    // keep the person's heading, so a click does not swing the whole site round
    if (fly && opts.fitRoute && route) fitRoute();
    else if (fly) flyTo(W(u.u + u.wu / 2, u.v + u.dv / 2, 0), ctrl.theta, 0.95, b ? Math.max(48, Math.min(80, (b.u[1] - b.u[0]) * 0.4)) : 70);
    if (opts.onSelectUnit) opts.onSelectUnit(u);
    return true;
  }

  // ---- loop ----
  let raf = 0; let alive = true; let last = 0;
  function resize() { const r = container.getBoundingClientRect(); if (!r.width || !r.height) return; renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null; if (ro) ro.observe(container); else window.addEventListener('resize', resize);
  function loop(now) {
    if (!alive) return; raf = requestAnimationFrame(loop); const dt = last ? Math.min(0.1, (now - last) / 1000) : 0; last = now;
    if (diorama) {
      if (!reduceMotion) diorama.update(dt);
      // the pin bobs and keeps a readable size from any distance; the ring under it pulses
      const sz = Math.max(1, Math.min(6, ctrl.radius / 110));
      beacon.children.forEach((c) => {
        if (c.userData.pin) { c.scale.setScalar(sz); c.position.y = (c.userData.y0 ??= c.position.y) + (reduceMotion ? 0 : Math.sin(now / 380) * 0.6 * sz); }
        if (c.userData.pulse) { const k = reduceMotion ? 0.3 : (now / 1400) % 1; c.scale.setScalar(sz * (1 + k * 2.2)); c.material.opacity = 0.5 * (1 - k); }
      });
    }
    // The illustrated look turns slowly until the first touch, like a model on a turntable.
    if (idle && !anim) { ctrl.theta += dt * 0.05; applyCamera(); }
    if (anim) anim(now); if (state.selected) mat.sel.emissive.setHex(0x663300).multiplyScalar(0.5 + 0.5 * Math.sin(now / 400));
    if (!illus) beacon.children.forEach((c) => { if (c.userData.pulse) { const k = reduceMotion ? 0.3 : (now / 1400) % 1; c.scale.setScalar(1 + k * 2.2); c.material.opacity = 0.5 * (1 - k); } });
    if (colorsMoving) {   // ease every unit's color toward its target (a layer switch fades in ~1/4 s)
      const a = 1 - Math.exp(-dt * 12); let still = true;
      for (let i = 0; i < colCur.length; i++) { const d = colTo[i] - colCur[i]; if (Math.abs(d) > 0.002) { colCur[i] += d * a; still = false; } else colCur[i] = colTo[i]; }
      pushColors(); if (still) colorsMoving = false;
    }
    if (state.selected && selLift < 1) { selLift = reduceMotion ? 1 : Math.min(1, selLift + dt * 3); placeSelected(); }
    if (routeTex && !reduceMotion) routeTex.offset.x -= dt * 0.9;
    if (routeReveal) { const k = Math.min(1, (now - routeReveal.t0) / 1400); const n = Math.floor(routeReveal.total * k / 6) * 6; routeReveal.mesh.geometry.setDrawRange(0, k >= 1 ? Infinity : n); if (k >= 1) routeReveal = null; }
    declutter(now);
    renderer.render(scene, camera); }
  if (diorama) diorama.setParked(units, state.mode === 'owner');
  resize(); applyCamera(); restyle(true); raf = requestAnimationFrame(loop);

  return {
    selectUnit,
    clearSelection() { state.selected = null; restyle(); if (opts.onSelectUnit) opts.onSelectUnit(null); },
    /** Layer colors: { unitName: 0xRRGGBB | '#rrggbb' }; units not in the map keep the occupancy colors. null = occupancy. */
    setUnitColors(map) { state.colors = map || null; restyle(); },
    /** The route on the ground for the chosen unit: { points, stops, length } or null. */
    getRoute() { return route; },
    flyToStep(i) { const s = route && route.stops[i]; if (!s) return; idle = false; flyTo(W(s.uv[0], s.uv[1], 0), ctrl.theta, s.end ? 0.9 : 0.75, s.end ? 45 : i === 0 ? 70 : 55); },
    fitRoute() { idle = false; fitRoute(); },
    resetView() { state.selected = null; state.level = 0; restyle(); VIEWS.overview(); if (opts.onSelectUnit) opts.onSelectUnit(null); },
    setMode(m) { state.mode = m; state.placing = false; restyle(); renderPins(); renderMarkers(); if (diorama) diorama.setParked(units, m === 'owner'); },
    setXray(v) { state.xray = !!v; restyle(); },
    setLevel(n) { state.level = n | 0; restyle(); },
    setPins(arr) { state.pins = arr || []; renderPins(); },
    setMarkers(map) { state.markers = map || {}; renderMarkers(); },
    setPlacing(v) { state.placing = !!v; el.style.cursor = v ? 'crosshair' : ''; },
    setBackground(c) { scene.background = new THREE.Color(c); },
    view(name) { if (VIEWS[name]) VIEWS[name](); },
    flyToPin(p) { flyTo(W(p.u, p.v, p.y || 0), ctrl.theta, 0.7, 50); },
    getState() { return { ...state }; },
    destroy() {
      alive = false; cancelAnimationFrame(raf); if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
      el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onUp); el.removeEventListener('wheel', onWheel); el.removeEventListener('contextmenu', onCtx);
      if (diorama) diorama.dispose(); scene.traverse((o) => { if (o !== scene) disposeObject(o); }); scene.clear();
      // dispose() alone keeps the WebGL context: every look switch builds a new renderer, and
      // browsers drop the oldest context past ~16 - release it now.
      renderer.dispose(); renderer.forceContextLoss(); if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}

/** Plain-language type label for a unit row of the model. */
export function unitKindLabel(u) {
  if (u.k === 'park') return 'RV / Vehicle Parking';
  if (u.n[0] === 'M') return 'Rental Mailbox';
  let s = { cc: 'Climate Controlled', ccdu: 'Climate Controlled, Drive-Up', du: 'Drive-Up', in: 'Indoor' }[u.k] || 'Storage';
  if (u.veh) s += ', Vehicle'; if (u.pw) s += ', Power';
  return s;
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/** Compass name of a door side: `ne` faces +v, `sw` faces -v, `e` faces +u, `w` faces -u, in the model's frame. */
export function doorSideName(model, door) {
  const b = (model.frame && model.frame.bearingDeg) || 0;   // bearing of +u, clockwise from north
  const off = { e: 0, ne: -90, w: 180, sw: 90 }[door];
  if (off === undefined) return '';
  return COMPASS[Math.round((((b + off) % 360) + 360) % 360 / 45) % 8] + ' side';
}

/** Step-by-step walking directions from the main gate to a unit. */
export function unitDirections(model, u) {
  const b = (model.buildings || []).find((x) => x.id === u.b); const z = (model.zones || []).find((x) => x.id === u.b);
  const gate = (model.gates && model.gates[0] && model.gates[0].name) || 'gate';
  const steps = ['Enter through the ' + gate + ' and check in at the office if it is your first visit.'];
  if (z) { steps.push('Drive to the ' + z.name + '.'); steps.push('Stall ' + u.n + ' is marked on the model; stalls are numbered in order along each row.'); return steps; }
  if (!b) return steps;
  steps.push('Head to ' + b.name + (b.note ? ': ' + b.note.split('.')[0].toLowerCase() + '.' : '.'));
  const side = doorSideName(model, u.door);
  if (u.k === 'du' || u.k === 'ccdu') steps.push('Your door is on the outside wall' + (side ? ', ' + side : '') + '. Pull up to the roll-up door.');
  else if (u.n[0] === 'M') steps.push('Mailboxes are inside the lobby.');
  else steps.push('Go inside' + (u.f > 1 ? ', take the elevator or stairs to Level ' + u.f : '') + ' and follow the hallway; ' + u.n + ' is on the hallway' + (side ? ' nearer the ' + side + '.' : '.'));
  return steps;
}

/** The steps from the gate to a unit, for the route tracker. */
export function routeSteps(model, u) {
  const gate = (model.gates && model.gates[0] && model.gates[0].name) || 'Gate';
  const b = (model.buildings || []).find((x) => x.id === u.b); const z = (model.zones || []).find((x) => x.id === u.b);
  const steps = [{ label: gate, sub: 'Start here' }];
  if (z) steps.push({ label: z.name, sub: 'Lot' });
  else if (b) steps.push({ label: b.name, sub: u.k === 'du' || u.k === 'ccdu' ? 'Drive up' : 'Go inside' });
  if (b && b.floors > 1) steps.push({ label: `Level ${u.f}`, sub: u.f > 1 ? 'Elevator or stairs' : 'Ground floor' });
  steps.push({ label: u.n, sub: u.w && u.d ? `${u.w} × ${u.d} ft` : 'Your unit', end: true });
  return steps;
}

/** Cubby's unrentable reason codes (REPAIRS_REQUIRED, OTHER) as Title Case words. */
export function reasonLabel(why) {
  return String(why || '').toLowerCase().split(/[_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}
