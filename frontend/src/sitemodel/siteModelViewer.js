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
import { createRealGround, createSky, ATMOSPHERE } from './siteModelGround.js';
import { sunDirection, mutedTint, unitForm, nameBucket, unplacedZoneIds } from './siteModelGeo.js';
import { createMarkup } from './siteModelMarkup.js';

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
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: opts.depthTest !== false, toneMapped: false }));
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
  x.fillStyle = '#2f7de1'; x.fillRect(0, 0, 64, 32); x.fillStyle = 'rgba(255,255,255,0.7)';
  x.beginPath(); x.moveTo(24, 10); x.lineTo(34, 16); x.lineTo(24, 22); x.lineTo(28, 16); x.closePath(); x.fill();
  const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

/** Corrugated steel for containers: pale ribs with soft dark grooves; the
 *  instance color paints it (rust red, blue, green, beige...). */
function corrugatedTexture() {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 8; const x = cv.getContext('2d');
  const g = x.createLinearGradient(0, 0, 8, 0); g.addColorStop(0, '#9a9a9a'); g.addColorStop(0.25, '#f2f2f2'); g.addColorStop(0.55, '#d4d4d4'); g.addColorStop(0.8, '#8c8c8c'); g.addColorStop(1, '#9a9a9a');
  x.fillStyle = g; for (let i = 0; i < 64; i += 8) { x.save(); x.translate(i, 0); x.fillRect(0, 0, 8, 8); x.restore(); }
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 1); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

/** Standing-seam metal roof (canopies, building roofs): light galvanized steel, one seam per texel row of 16. */
function seamTexture(base = '#d5d8da', seam = '#aeb3b6', hi = '#eef0f1') {
  const cv = document.createElement('canvas'); cv.width = 16; cv.height = 4; const x = cv.getContext('2d');
  x.fillStyle = base; x.fillRect(0, 0, 16, 4); x.fillStyle = seam; x.fillRect(0, 0, 1, 4); x.fillStyle = hi; x.fillRect(1, 0, 1, 4);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

/** A soft round shadow (pin) or a white dot (pin head): radial gradients on a small canvas. */
function radialTexture(inner, outer) {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64; const x = cv.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, inner); g.addColorStop(0.55, inner.replace(/[\d.]+\)$/, (a) => `${parseFloat(a) * 0.6})`)); g.addColorStop(1, outer);
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** The map pin's outline (radius, height) for a lathe: a round head on a tapered stem, tip at 0, top at 1. */
function pinProfile() {
  const pts = [new THREE.Vector2(0, 0)]; const cy = 0.68, r = 0.32;
  const a0 = Math.atan2(0.529 - cy, 0.282);   // where the stem's straight side meets the head
  for (let i = 0; i <= 18; i++) { const a = a0 + ((Math.PI / 2 - a0) * i) / 18; pts.push(new THREE.Vector2(Math.max(0.0001, r * Math.cos(a)), cy + r * Math.sin(a))); }
  return pts;
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
  if (u.l === 1) return KIND_COLORS.ok; if (u.r === 0) return KIND_COLORS.bad; return KIND_COLORS.warn;
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
  // Units the build parked off the lot because no plan shows them ("Unmapped Stalls").
  const unplacedZones = unplacedZoneIds(model);
  const W = (u, v, y) => new THREE.Vector3(u, y || 0, -v);
  const illus = opts.style === 'illustrated';
  // The realistic looks (Oct 20 2026): 'satellite' = real terrain + imagery
  // (siteModelGround.js); 'photoreal' = Google's 3D mesh (siteModelPhotoreal.js),
  // falling back to the satellite ground when it cannot load at this site.
  // Satellite keeps the production look (Visesh, Oct 20 2026: "the one in asset
  // management is so much better"): solid, fully saturated status blocks, see-
  // through building shells, the same lights. It only gains the real terrain,
  // sky and haze around the lot (`terrain`), which stays flat at y = 0 so the
  // blocks sit exactly where they always have. The realistic styling (`real`:
  // tone mapping, stall paint, containers, markers) belongs to Realistic 3D.
  const terrain = !illus; const real = opts.style === 'photoreal'; let photo = real;
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, real ? 2 : terrain ? 1.75 : 2));   // Realistic 3D: the screen's full resolution
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Realistic 3D shows Google's photos as captured: no tone mapping (ACES washed
  // them out and tinted the shadows blue - Visesh, Oct 20).
  if (real) { renderer.toneMapping = THREE.NoToneMapping; }
  const el = renderer.domElement; el.style.display = 'block'; el.style.width = '100%'; el.style.height = '100%'; el.style.touchAction = 'none';
  container.appendChild(el);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(illus ? DIORAMA.sky : terrain ? ATMOSPHERE.haze : opts.background || '#dfe6e9');
  // The illustrated look uses a long lens (flatter, toy-like) and cool, even light.
  const camera = new THREE.PerspectiveCamera(illus ? 30 : 45, 1, 1, terrain ? 40000 : 6000);
  // Realistic light: a late-morning Southern California sun (south-southeast,
  // ~44 degrees up), a sky-blue fill from above and warm bounce from the ground.
  const sunDir = terrain ? sunDirection(model.frame, 152, 44) : null;
  scene.add(real ? new THREE.HemisphereLight(0xdfe9f6, 0x8f8470, 1.15) : new THREE.HemisphereLight(0xffffff, illus ? 0xcfd6e0 : 0x777766, illus ? 1.35 : 1.1));
  const sun = new THREE.DirectionalLight(real ? 0xfff1df : 0xffffff, illus ? 1.75 : real ? 2.1 : 1.6); sun.position.set(-160, 260, 120); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -260, right: 260, top: 260, bottom: -260, near: 50, far: 700 }); sun.shadow.bias = -0.0008;
  if (real) { sun.shadow.normalBias = 0.04; sun.shadow.radius = 3; }
  scene.add(sun); scene.add(sun.target);
  let sky = null;
  if (terrain) { sky = createSky(sunDir); scene.add(sky); scene.fog = new THREE.FogExp2(ATMOSPHERE.haze, 0.00021); }

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
  if (real) {
    // Painted stucco / metal instead of flat clay: matte walls, seamed metal roofs, quiet edges.
    mat.wall = new THREE.MeshStandardMaterial({ color: 0xe2ddd2, roughness: 0.92, metalness: 0 });
    const roofTex = seamTexture(); roofTex.repeat.set(1, 1);
    mat.roofWhite = new THREE.MeshStandardMaterial({ color: 0xffffff, map: roofTex, roughness: 0.55, metalness: 0.25 });
    mat.roofRed = new THREE.MeshStandardMaterial({ color: 0xa4513b, roughness: 0.8 });
    mat.roofSolar = new THREE.MeshStandardMaterial({ map: solarTexture(false), roughness: 0.35, metalness: 0.3 });
    mat.edge = new THREE.LineBasicMaterial({ color: 0x3f423c, transparent: true, opacity: 0.35 });
    mat.parcel = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.38, toneMapped: false });
    mat.door = new THREE.MeshStandardMaterial({ color: 0x8b9096, roughness: 0.6, metalness: 0.5 });
    mat.sel = new THREE.MeshLambertMaterial({ color: 0xff7a00, emissive: 0x663300, transparent: true, opacity: 0.72 });
  }
  const tmpM0 = new THREE.Matrix4();
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
  if (!illus && !real) scene.add(base);
  const groundHits = diorama ? diorama.ground : [base];
  // Real terrain + imagery (or, under the Google mesh, an invisible plane at the
  // lot's grade so a pin can still be dropped on open ground).
  let ground = null; let photoreal = null; const lotCenter = (() => { const h = []; units.forEach((x) => h.push([x.u + x.wu / 2, x.v + x.dv / 2])); if (!h.length) return [0, 0]; let su = 0, sv = 0; h.forEach((q) => { su += q[0]; sv += q[1]; }); return [su / h.length, sv / h.length]; })();
  function startGround() {
    if (ground) return;
    ground = createRealGround(scene, model, { renderer, images: opts.images || {}, center: lotCenter, onChange: () => drapeParcels() });
    groundHits.length = 0; groundHits.push(ground.mesh);
  }
  if (terrain) {
    base.visible = false; base.position.y = 0; base.material.colorWrite = false; base.material.depthWrite = false; scene.add(base);
    if (photo) {
      import('./siteModelPhotoreal.js').then((m) => m.attachPhotoreal({ scene, camera, renderer, model, center: lotCenter,
        probes: units.filter((x, i) => x.k === 'park' && i % 37 === 0).slice(0, 8).map((x) => [x.u + x.wu / 2, x.v + x.dv / 2]),
        onFail: (e) => fallBack(e) }))
        .then((h) => { if (!alive) { h.dispose(); return; } photoreal = h; })
        .catch((e) => fallBack(e));
    } else startGround();
  }
  /** Google's mesh is unavailable here (no key, no coverage, offline): the satellite ground. */
  function fallBack(e) {
    if (!alive || !photo) return; console.warn('[site-model] photorealistic tiles unavailable, using satellite terrain', e);
    if (photoreal) { photoreal.dispose(); photoreal = null; }
    photo = false; startGround(); applyPhotoMode(); if (opts.onPhotorealFallback) opts.onPhotorealFallback();
  }
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
  // The flat photo planes are the old satellite look; the realistic ground drapes the same photos.
  if (!illus && !terrain && model.imageWide && model.imageWide.uv) quad(model.imageWide.uv, opts.images.wide, -0.12, 0xa3a898);
  if (!illus && !terrain && model.image && model.image.uv) quad(model.image.uv, opts.images.detail, -0.05, 0xb8b4a8);

  function flatPoly(pts, material, y) { const s = new THREE.Shape(); pts.forEach((p, i) => (i ? s.lineTo(p[0], p[1]) : s.moveTo(p[0], p[1]))); const m = new THREE.Mesh(new THREE.ShapeGeometry(s), material); m.rotation.x = -Math.PI / 2; m.position.y = y; return m; }
  function lineLoop(pts, material, y) { const g = new THREE.BufferGeometry().setFromPoints(pts.concat([pts[0]]).map((p) => W(p[0], p[1], y))); return new THREE.Line(g, material); }
  const pads = model.pads || (model.pad ? [model.pad] : []);
  const parcels = model.parcels ? model.parcels.map((p) => p.uv) : model.parcel ? [model.parcel] : [];
  // The illustrated board paints its own paving and parcel edge.
  if (!illus && !real) pads.forEach((p) => { if (p && p.length > 2) scene.add(flatPoly(p, mat.pad, 0.02)); });
  if (!illus && !terrain) parcels.forEach((p) => { if (p && p.length > 2) scene.add(lineLoop(p, mat.parcel, 0.4)); });
  // Realistic: the property line follows the ground (a thin white line), redrawn once the hills arrive.
  const parcelLines = new THREE.Group(); if (terrain) scene.add(parcelLines);
  parcelLines.userData.photoHide = true;
  // Realistic 3D (Google's mesh): labels stand on the real surface, sampled under
  // each one (see sampleSurface); `y0` is where they sit in the other looks.
  const anchors = [];
  const anchor = (obj, u, v, dy) => { anchors.push({ obj, dy, y0: obj.position.y, s: { u, v, sy: null } }); };
  function drapeParcels() {
    if (!terrain) return; clearGroup(parcelLines);
    parcels.forEach((p) => {
      if (!p || p.length < 3) return; const pts = [];
      p.concat([p[0]]).forEach((q, i, arr) => {
        if (!i) return; const a = arr[i - 1]; const n = Math.max(1, Math.ceil(Math.hypot(q[0] - a[0], q[1] - a[1]) / 6));
        for (let k = 0; k <= n; k++) { const u = a[0] + ((q[0] - a[0]) * k) / n, v = a[1] + ((q[1] - a[1]) * k) / n; pts.push(W(u, v, (ground ? ground.heightAt(u, v) : 0) + 0.35)); }
      });
      parcelLines.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat.parcel));
    });
  }
  drapeParcels();
  (model.zones || []).forEach((z) => {
    const polys = (z.polys && z.polys.length ? z.polys : [z.uv]).filter((p) => p && p.length > 2);
    if (!polys.length) return;
    if (z.kind === 'canopy' && real) {
      // A covered RV shelter: a seamed steel roof on posts (the stalls under it
      // still show through a little), casting a real shadow on the lot.
      const H = 5.2; const tex = seamTexture('#e4e7e9', '#aab0b4', '#f7f8f9'); tex.repeat.set(1 / 0.9, 1);
      const roof = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0.35, transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: true });
      const postGeo = new THREE.CylinderGeometry(0.11, 0.11, H, 8); const posts = [];
      polys.forEach((p) => {
        const slab = flatPoly(p, roof, H); slab.castShadow = true; slab.userData.canopy = true; scene.add(slab); const rim = lineLoop(p, mat.edge, H); rim.userData.canopy = true; scene.add(rim);
        p.forEach((c, i) => { const d = p[(i + 1) % p.length]; const n = Math.max(1, Math.round(Math.hypot(d[0] - c[0], d[1] - c[1]) / 7)); for (let k = 0; k < n; k++) posts.push([c[0] + ((d[0] - c[0]) * k) / n, c[1] + ((d[1] - c[1]) * k) / n]); });
      });
      const inst = new THREE.InstancedMesh(postGeo, mat.door, posts.length); inst.castShadow = true;
      posts.forEach((q, i) => { tmpM0.makeTranslation(q[0], H / 2, -q[1]); inst.setMatrixAt(i, tmpM0); }); inst.userData.canopyPosts = true; scene.add(inst);
    } else if (z.kind === 'canopy') {
      // A roof over open stalls: a translucent slab on posts, so the stalls under it stay visible.
      polys.forEach((p) => { const slab = flatPoly(p, mat.canopy, 4.2); scene.add(slab); scene.add(lineLoop(p, mat.edge, 4.2)); p.forEach((c) => { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 4.2, 6), mat.door); post.position.copy(W(c[0], c[1], 2.1)); scene.add(post); }); });
    } else {
      if (!illus && !real) polys.forEach((p) => { scene.add(flatPoly(p, mat.zone, 0.04)); scene.add(lineLoop(p, mat.zoneLine, 0.1)); });
    }
    const c = centroid(polys[0]); const l = textSprite(z.name, { size: 48, bg: 'rgba(255,255,255,0.8)', worldHeight: 4 }); l.position.copy(W(c[0], c[1], z.kind === 'canopy' ? 7 : 4)); scene.add(l); screenLabel(l, 17, 1);
    // Unmapped units have no real place: under Google's mesh their label (and they) are not drawn.
    if (unplacedZones.has(z.id)) l.userData.photoHide = true; else anchor(l, c[0], c[1], z.kind === 'canopy' ? 2.5 : 4);
  });
  (model.gates || []).forEach((g) => { const l = textSprite(g.name, { size: 48, bg: 'rgba(31,111,74,0.9)', color: '#fff', worldHeight: 4 }); l.position.copy(W(g.uv[0], g.uv[1], illus ? 4.5 : 3)); scene.add(l); screenLabel(l, 20, 9); anchor(l, g.uv[0], g.uv[1], 3); if (illus) return; const post = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 2.5, 8), new THREE.MeshLambertMaterial({ color: 0x1f6f4a })); post.position.copy(W(g.uv[0], g.uv[1], 1.25)); post.userData.photoHide = true; scene.add(post); });

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
    if (real) {
      // Walls: pale ribbed metal panels. Roof: the building's own roof from the
      // satellite photo (solar arrays, vents and all), lit like a real surface.
      const wall = (w) => { const t = ribTexture('#dcd6c9', '#c3bdb0', '#e9e5db'); t.repeat.set(Math.max(1, w / 0.9), 1); t.anisotropy = 8; return new THREE.MeshStandardMaterial({ map: t, roughness: 0.85, metalness: 0.08 }); };
      const top = ground ? ground.drape(new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 }), 'roof') : mats[2];
      mats = [wall(Wd), wall(Wd), top, mat.wall.clone(), wall(L), wall(L)];
    }
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(L, b.height, Wd), mats); mesh.userData.index = bi;
    mesh.position.copy(W((b.u[0] + b.u[1]) / 2, (b.v[0] + b.v[1]) / 2, b.height / 2));
    mesh.userData.building = b; mesh.castShadow = true; scene.add(mesh); shells.push(mesh);
    if (illus) {   // a roof cap with a small overhang reads as a toy building from far away
      const cap = new THREE.Mesh(new THREE.BoxGeometry(L + 0.8, 0.45, Wd + 0.8), roof); cap.position.copy(W((b.u[0] + b.u[1]) / 2, (b.v[0] + b.v[1]) / 2, b.height + 0.22)); cap.castShadow = true; scene.add(cap); mesh.userData.cap = cap;
    }
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), mat.edge); edges.position.copy(mesh.position); scene.add(edges); mesh.userData.edges = edges;
    for (let f = 2; f <= b.floors; f++) { const y = b.height * (f - 1) / b.floors; scene.add(lineLoop([[b.u[0], b.v[0]], [b.u[1], b.v[0]], [b.u[1], b.v[1]], [b.u[0], b.v[1]]], mat.edge, y)); }
    const short = b.letters && b.letters.length && b.letters.length <= 2 && b.letters.every((l) => l.length <= 2);
    const label = textSprite(short ? b.letters.join(' / ') : b.name, { size: 72, bg: 'rgba(255,255,255,0.85)', worldHeight: short ? 7 : 4 });
    label.position.copy(W((b.u[0] + b.u[1]) / 2, (b.v[0] + b.v[1]) / 2, b.height + 5)); scene.add(label); screenLabel(label, short ? 24 : 17, 3 + Math.min(4, (L * Wd) / 2000));
    if (!illus && !real) { const ao = new THREE.Mesh(new THREE.PlaneGeometry(L + 6, Wd + 6), new THREE.MeshBasicMaterial({ map: contactTexture(), transparent: true, depthWrite: false })); ao.rotation.x = -Math.PI / 2; ao.position.copy(W((b.u[0] + b.u[1]) / 2, (b.v[0] + b.v[1]) / 2, 0.06)); scene.add(ao); }
    anchor(label, (b.u[0] + b.u[1]) / 2, (b.v[0] + b.v[1]) / 2, 5);
  });

  // ---- units ----
  // Instanced (Oct 20 2026): one draw call for every unit box and one for every
  // door instead of a mesh each (~1,800 at Escondido), so the model stays smooth
  // on a phone. Each unit keeps a record - where it sits, how tall, shown or not -
  // and a color that eases toward its target, so a layer switch fades, not snaps.
  const cellGeo = new THREE.BoxGeometry(1, 1, 1);
  const N = Math.max(1, units.length);
  const unitInst = new THREE.InstancedMesh(cellGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), N);
  unitInst.castShadow = !illus; unitInst.receiveShadow = !real; unitInst.frustumCulled = false;
  const doorInst = new THREE.InstancedMesh(cellGeo, illus ? mat.door : new THREE.MeshLambertMaterial({ map: doorTexture() }), N);
  doorInst.frustumCulled = false; doorInst.count = 0;
  const recs = []; const recOf = {}; const ZERO = new THREE.Vector3(0, 0, 0); const UP = new THREE.Vector3(0, 1, 0);
  const tmpM = new THREE.Matrix4(); const tmpQ = new THREE.Quaternion(); const tmpV = new THREE.Vector3(); const tmpC = new THREE.Color(); const tmpS = new THREE.Vector3();
  let doorCount = 0;
  units.forEach((u, i) => {
    const b = buildings[u.b]; const fh = b ? b.height / b.floors : 0; const baseY = (u.f - 1) * fh;
    // Parking stalls are painted slabs lying on the ground; storage units are boxes.
    // Realistic: an open stall is paint on the ground, a container is a real 8.5 ft box.
    const form = real ? unitForm(u, buildings) : null;
    const h = form === 'stall' ? 0.08 : form === 'container' ? 2.59 : u.k === 'park' ? 0.12 : Math.min(2.2, Math.max(0.6, fh ? fh * 0.6 : 0.6));
    const pos = W(u.u + u.wu / 2, u.v + u.dv / 2, baseY + h / 2 + (form === 'stall' ? 0.01 : 0.03));
    const scale = new THREE.Vector3(Math.max(0.3, u.wu - 0.12), h, Math.max(0.3, u.dv - 0.12));
    // An angled stall from the as-built plans turns about its center (rot:
    // degrees counter-clockwise in u,v; W maps u,v to x,-z, so that is rotation.y).
    const rot = u.rot ? (u.rot * Math.PI) / 180 : 0;
    const r = { u, i, pos, scale, rot, h, door: null, visible: true, ours: true, lift: 0, form, vis: null, unplaced: unplacedZones.has(u.b), s: { u: pos.x, v: -pos.z, sy: null } };
    if (u.k !== 'park' && b) {
      let dpos, dscale;
      if (u.door === 'w' || u.door === 'e') {   // rows that run across the frame: the door is on a u face
        dscale = new THREE.Vector3(0.25, h + 0.02, Math.max(0.3, u.dv - 0.3));
        dpos = W(u.door === 'e' ? u.u + u.wu - 0.12 : u.u + 0.12, u.v + u.dv / 2, baseY + h / 2 + 0.03);
      } else {
        dscale = new THREE.Vector3(Math.max(0.3, u.wu - 0.3), h + 0.02, 0.25);
        const vz = u.door === 'ne' ? u.v + u.dv - 0.12 : u.v + 0.12; dpos = W(u.u + u.wu / 2, vz, baseY + h / 2 + 0.03);
      }
      if (real && (u.k === 'du' || u.k === 'ccdu') && u.f === 1) {
        // A drive-up door is a roll-up door on the outside wall: just proud of the
        // unit's face and door-height, so the building rows read as real doors.
        const dh = Math.min(2.6, fh * 0.75 || 2.4); const across = u.door === 'w' || u.door === 'e';
        dscale = across ? new THREE.Vector3(0.06, dh, Math.max(0.3, u.dv - 0.5)) : new THREE.Vector3(Math.max(0.3, u.wu - 0.5), dh, 0.06);
        const out = 0.07;
        dpos = across ? W(u.door === 'e' ? u.u + u.wu + out : u.u - out, u.v + u.dv / 2, dh / 2) : W(u.u + u.wu / 2, u.door === 'ne' ? u.v + u.dv + out : u.v - out, dh / 2);
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
  // Realistic looks draw each unit by what it is; unitInst stays as the (hidden)
  // picking proxy so hover, click and selection work exactly as before.
  //   stall     - a translucent, muted status tint over the photo + crisp white lines
  //   container - corrugated steel in a real paint color, a status-tinted roof
  //   interior  - a unit inside a building: a muted status box (seen with See Inside)
  const vis = {};
  if (real) {
    unitInst.visible = false;
    const groups = { stall: [], container: [], interior: [] }; recs.forEach((r) => groups[r.form].push(r));
    const flat = new THREE.PlaneGeometry(1, 1); flat.rotateX(-Math.PI / 2); flat.translate(0, 0.5, 0);
    const mk = (geo, material, list, key) => { const m = new THREE.InstancedMesh(geo, material, Math.max(1, list.length)); m.count = list.length; m.frustumCulled = false; list.forEach((r, k) => { r.vis = r.vis || {}; r.vis[key] = k; }); scene.add(m); return m; };
    vis.tint = mk(flat, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }), groups.stall, 'tint');
    vis.tint.renderOrder = 2;
    vis.box = mk(cellGeo, new THREE.MeshStandardMaterial({ map: corrugatedTexture(), roughness: 0.62, metalness: 0.35 }), groups.container, 'box');
    vis.box.castShadow = true; vis.box.receiveShadow = true;
    vis.roof = mk(cellGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), groups.container, 'roof');
    vis.inner = mk(cellGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), groups.interior, 'inner');
    vis.inner.castShadow = true;
    // Shipping-container paints, weathered: rust red, ocean blue, olive, sand, gray, white.
    const PAINT = [0x8a3f2e, 0x2f4d6b, 0x55684a, 0xb3a17f, 0x7d8285, 0xc8c4b8, 0x9b5a2e];
    groups.container.forEach((r) => vis.box.setColorAt(r.vis.box, tmpC.setHex(PAINT[nameBucket(r.u.n, PAINT.length)])));
    if (vis.box.instanceColor) vis.box.instanceColor.needsUpdate = true;
    // Painted stall lines: one merged mesh of thin strips along every stall's edges.
    const lp = []; const li = []; const half = 0.06;
    groups.stall.forEach((r) => {
      const c = Math.cos(r.rot), sn = Math.sin(r.rot); const hx = r.scale.x / 2 + 0.06, hz = r.scale.z / 2 + 0.06;
      const corner = (a, b) => [r.pos.x + a * c + b * sn, -a * sn + b * c + r.pos.z];
      const cs = [corner(-hx, -hz), corner(hx, -hz), corner(hx, hz), corner(-hx, hz)];
      for (let e = 0; e < 4; e++) {
        const a = cs[e], b = cs[(e + 1) % 4]; const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; const nx = (-(b[1] - a[1]) / len) * half, nz = ((b[0] - a[0]) / len) * half;
        const o = lp.length / 3; [[a[0] + nx, a[1] + nz], [a[0] - nx, a[1] - nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz]].forEach((q) => lp.push(q[0], 0.06, q[1]));
        li.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
      }
    });
    if (lp.length) {
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3)); lg.setIndex(li);
      const lines = new THREE.Mesh(lg, new THREE.MeshBasicMaterial({ color: 0xf4f3ee, transparent: true, opacity: 0.78, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }));
      lines.renderOrder = 3; scene.add(lines); vis.lines = lines;
    }
  }
  // Floors lift apart under See Inside with All Levels (an exploded view), so
  // the upper floor no longer hides the one below.
  const EXPLODE = 2.6;
  const yOff = (r) => (state.explode && buildings[r.u.b] && buildings[r.u.b].floors > 1 ? (r.u.f - 1) * EXPLODE : 0) + r.lift;
  function placeInstance(r) {
    tmpQ.setFromAxisAngle(UP, r.rot); tmpV.copy(r.pos); tmpV.y += yOff(r);
    tmpM.compose(tmpV, tmpQ, r.visible ? r.scale : ZERO); unitInst.setMatrixAt(r.i, tmpM);
    // Our own boxes and doors (r.ours): under Google's mesh only inside an opened building.
    if (r.vis || r.door) { tmpM.compose(tmpV, tmpQ, r.visible && r.ours ? r.scale : ZERO); }
    if (r.vis) {
      if (r.vis.tint != null) vis.tint.setMatrixAt(r.vis.tint, tmpM);
      if (r.vis.box != null) vis.box.setMatrixAt(r.vis.box, tmpM);
      if (r.vis.inner != null) vis.inner.setMatrixAt(r.vis.inner, tmpM);
      if (r.vis.roof != null) { tmpV.y += r.h / 2 + 0.025; tmpS.set(r.scale.x * 0.985, 0.04, r.scale.z * 0.97); tmpM.compose(tmpV, tmpQ, r.visible && r.ours ? tmpS : ZERO); vis.roof.setMatrixAt(r.vis.roof, tmpM); }
    }
    if (r.door) { tmpV.copy(r.door.pos); tmpV.y += yOff(r); tmpM.compose(tmpV, tmpQ, r.visible && r.ours ? r.door.scale : ZERO); doorInst.setMatrixAt(r.door.at, tmpM); }
  }
  const matricesChanged = () => { unitInst.instanceMatrix.needsUpdate = true; doorInst.instanceMatrix.needsUpdate = true; ['tint', 'box', 'roof', 'inner'].forEach((k) => { if (vis[k]) vis[k].instanceMatrix.needsUpdate = true; }); };
  recs.forEach(placeInstance);
  matricesChanged();
  unitInst.computeBoundingSphere(); unitInst.computeBoundingBox();
  scene.add(unitInst); scene.add(doorInst);
  const colCur = new Float32Array(N * 3); const colTo = new Float32Array(N * 3); let colorsMoving = false;
  recs.forEach((r) => unitInst.setColorAt(r.i, tmpC.setHex(KIND_COLORS.neutral)));
  /** Where a unit's box sits now (exploded floors included). */
  const unitTop = (r) => (onMesh(r) ? new THREE.Vector3(r.pos.x, r.s.sy + photoreal.offsetY() + 1.2, r.pos.z) : new THREE.Vector3(r.pos.x, r.pos.y + yOff(r) + r.h / 2, r.pos.z));
  /** Under Google's mesh, a unit not drawn by us (not in an opened building) stands on the sampled surface. */
  const onMesh = (r) => !!(photo && photoreal && r.s.sy != null && !(r.form === 'interior' && r.open));

  // Realistic 3D (Google's mesh, Oct 20 2026): the mesh already shows the real
  // RVs, shelters, containers and buildings, so none of ours are drawn. Each
  // unit is a small round status marker - a white puck with the legend color on
  // top and a soft dark halo - standing on the real surface under the unit's
  // center (sampled from the mesh, sampleSurface), a readable size at any zoom.
  // Unmapped units (no known position) get none. Picking uses the puck.
  const mk = { recs: [], group: new THREE.Group(), base: null, top: null, halo: null };
  if (real) {
    mk.recs = recs.filter((r) => !r.unplaced);
    const n = Math.max(1, mk.recs.length);
    const puck = new THREE.CylinderGeometry(1, 1, 0.34, 28); puck.translate(0, 0.17, 0);
    const face = new THREE.CircleGeometry(0.74, 28); face.rotateX(-Math.PI / 2); face.translate(0, 0.35, 0);
    const ring = new THREE.RingGeometry(0.96, 1.32, 28); ring.rotateX(-Math.PI / 2); ring.translate(0, 0.02, 0);
    const inst = (g, m) => { const x = new THREE.InstancedMesh(g, m, n); x.count = mk.recs.length; x.frustumCulled = false; mk.group.add(x); return x; };
    mk.halo = inst(ring, new THREE.MeshBasicMaterial({ color: 0x14160f, transparent: true, opacity: 0.32, depthWrite: false, toneMapped: false }));
    mk.base = inst(puck, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    mk.top = inst(face, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    mk.halo.renderOrder = 3; mk.base.renderOrder = 4; mk.top.renderOrder = 5;
    mk.recs.forEach((r, k) => { r.mi = k; mk.top.setColorAt(k, tmpC.setHex(KIND_COLORS.neutral)); });
    mk.group.visible = false; scene.add(mk.group);
  }
  const markerQ = new THREE.Quaternion(); const markerP = new THREE.Vector3(); const markerS = new THREE.Vector3();
  /** Size and stand every marker for this frame: ~1.4 m across, never under ~11 px or over ~40 px on screen. */
  function placeMarkers() {
    if (!mk.base) return;
    const off = photoreal ? photoreal.offsetY() : 0; const k = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / (el.clientHeight || 1);
    mk.recs.forEach((r, i) => {
      const y = r.s.sy;
      if (!r.mshow || y == null) { tmpM.compose(ZERO, markerQ, ZERO); }
      else {
        markerP.set(r.pos.x, y + off + 0.04, r.pos.z); const mpp = camera.position.distanceTo(markerP) * k;
        let sc = Math.min(Math.max(0.7, 5.5 * mpp), 20 * mpp); if (hovered && hovered.n === r.u.n) sc *= 1.35;
        tmpM.compose(markerP, markerQ, markerS.set(sc, sc, sc));
      }
      mk.halo.setMatrixAt(i, tmpM); mk.base.setMatrixAt(i, tmpM); mk.top.setMatrixAt(i, tmpM);
    });
    [mk.halo, mk.base, mk.top].forEach((m) => { m.instanceMatrix.needsUpdate = true; });
  }

  /** Switches between Google's mesh and our own drawing of the site (also back, when the mesh cannot load). */
  function applyPhotoMode() {
    if (!real) return;
    [vis.box, vis.tint, vis.roof, vis.lines].forEach((m) => { if (m) m.visible = !photo; });
    scene.traverse((c) => { if (c.userData.canopy || c.userData.canopyPosts || c.userData.photoHide) c.visible = !photo; });
    mk.group.visible = photo;
    anchors.forEach((a) => { if (!photo) a.obj.position.y = a.y0; });
    scene.fog.density = photo ? 0.00012 : 0.00021;
    restyle(true);
  }

  // The north arrow + 50 ft bar on the ground were dropped (Oct 20): the
  // on-map compass (SiteModelCompass.jsx) shows true north and sat on the stalls.

  // ---- selection furniture ----
  const beacon = new THREE.Group(); scene.add(beacon);
  const unitLabels = new THREE.Group(); scene.add(unitLabels); let labelsFor = null;
  const pinGroup = new THREE.Group(); scene.add(pinGroup);
  const markerGroup = new THREE.Group(); scene.add(markerGroup);
  const routeGroup = new THREE.Group(); scene.add(routeGroup); let route = null; let routeTex = null; let routeReveal = null;
  // The chosen unit is drawn on its own, raised a little above its row and glowing.
  const selMesh = new THREE.Mesh(cellGeo, mat.sel); selMesh.visible = false; selMesh.castShadow = !illus; scene.add(selMesh);
  const selDoor = new THREE.Mesh(cellGeo, doorInst.material); selDoor.visible = false; scene.add(selDoor);
  // Realistic: the chosen unit gets a crisp white outline, the hovered one a lighter one.
  const edgeGeo = new THREE.EdgesGeometry(cellGeo); let hoverBox = null;
  if (real) {
    const o = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: 0xffffff, toneMapped: false })); o.scale.setScalar(1.01); o.renderOrder = 6; selMesh.add(o);
    hoverBox = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, toneMapped: false })); hoverBox.visible = false; hoverBox.renderOrder = 7; scene.add(hoverBox);
  }
  function showHover(unit) {
    if (!hoverBox) return; const r = unit && recOf[unit.n];
    if (photo && r && r.mshow) { hoverBox.visible = false; return; }   // the marker itself grows (placeMarkers)
    if (!r || unit.n === state.selected || !r.visible) { hoverBox.visible = false; return; }
    hoverBox.visible = true; hoverBox.position.copy(r.pos); hoverBox.position.y += yOff(r); hoverBox.quaternion.setFromAxisAngle(UP, r.rot);
    hoverBox.scale.set(r.scale.x + 0.15, Math.max(0.12, r.h + 0.06), r.scale.z + 0.15);
  }
  let selLift = 0;

  // Unit numbers (Oct 20 review): the chosen unit's nearest neighbors on its
  // floor, and the rest of its building / lot only once the camera is close.
  // Screen-size, and run through the same overlap check as the building names
  // (see declutter), so they never pile up. The chosen unit's own number is on its pin.
  const NEAR_M = 14; let unitLabelList = []; const labelCache = new Map();   // unit name -> its number sprite, made once
  // Every unit's number, all buildings and lots (Visesh, Oct 20: "why are the
  // unit numbers not visible always?"). In a building with floors only one
  // floor is labeled: the level picked, else the chosen unit's floor, else the
  // top floor - so L1 and L2 numbers never stack. Readable size (16 px); the
  // declutter pass shows as many as fit without overlapping, nearest the
  // chosen unit / the view's center first.
  function showUnitLabels(bid, level) {
    const sel = state.selected ? recOf[state.selected] : null;
    const key = `${state.level || 0}:${state.explode ? 1 : 0}:${state.selected || ''}:${bid || ''}`;
    if (labelsFor === key) return; labelsFor = key;
    while (unitLabels.children.length) unitLabels.remove(unitLabels.children[0]);   // kept in labelCache, not disposed
    unitLabelList = [];
    const topFloor = {};
    for (const r of recs) { const bb = buildings[r.u.b]; if (bb && bb.floors > 1) topFloor[r.u.b] = Math.max(topFloor[r.u.b] || 1, r.u.f || 1); }
    const floorFor = (bId) => {
      const bb = buildings[bId]; if (!bb || bb.floors <= 1) return null;
      if (state.level) return state.level;
      if (sel && sel.u.b === bId) return sel.u.f || 1;
      if (bid === bId && level) return level;
      return topFloor[bId] || 1;
    };
    const c = sel ? sel.pos : ctrl.target;
    const dist = (r) => Math.hypot(r.pos.x - c.x, r.pos.z - c.z);
    const rows = recs.filter((r) => r !== sel && (floorFor(r.u.b) == null || (r.u.f || 1) === floorFor(r.u.b))).sort((x, y) => dist(x) - dist(y));
    rows.forEach((r) => {
      const x = r.u; let sp = labelCache.get(x.n);
      if (!sp) {
        sp = textSprite(x.n, { size: 48, mono: true, weight: 700, bg: 'rgba(255,255,255,0.96)', color: '#1d1f1a' });
        sp.material.sizeAttenuation = false; sp.material.depthTest = false; sp.renderOrder = 9;
        sp.userData.unit = x; sp.userData.px = 16; sp.userData.aspect = sp.scale.x / sp.scale.y; labelCache.set(x.n, sp);
      }
      sp.position.copy(unitTop(r)); sp.position.y += 0.4; sp.visible = false;   // the next declutter pass sizes and shows it
      sp.userData.near = !!sel && dist(r) <= NEAR_M;
      unitLabels.add(sp); unitLabelList.push(sp);
    });
  }
  let pinLabel = null; let pinGeo = null; let dotTex = null; let shadowTex = null;
  /** A thin flat outline of a unit's footprint at height y (drawn over the mesh). */
  function footprintOutline(r, y) {
    const c = Math.cos(r.rot), sn = Math.sin(r.rot); const hx = r.scale.x / 2 + 0.1, hz = r.scale.z / 2 + 0.1; const half = 0.08;
    const cs = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([a, b]) => [r.pos.x + a * c + b * sn, r.pos.z - a * sn + b * c]);
    const pos = []; const idx = [];
    for (let e = 0; e < 4; e++) {
      const a = cs[e], b = cs[(e + 1) % 4]; const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; const nx = (-(b[1] - a[1]) / len) * half, nz = ((b[0] - a[0]) / len) * half;
      const o = pos.length / 3; [[a[0] + nx, a[1] + nz], [a[0] - nx, a[1] - nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz]].forEach((q) => pos.push(q[0], y, q[1]));
      idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff7a00, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    m.renderOrder = 8; return m;
  }
  function updateBeacon() {
    clearGroup(beacon); pinLabel = null;
    if (!state.selected) return; const u = byName[state.selected]; const p = unitTop(recOf[u.n]); p.y -= recOf[u.n].h / 2;
    if (real) {
      // A slim map pin that keeps one size on screen (~40 px, scaled in the loop):
      // a lathe-turned head and stem, a white eye, the unit chip above and a soft
      // shadow on the ground under it. It stands on the unit (a container's roof).
      const r = recOf[u.n];
      // Under Google's mesh the pin stands on the real surface (an RV's roof, a
      // shelter roof, the lot) and a thin orange outline marks the footprint there.
      const mesh = onMesh(r); const top = mesh ? r.s.sy + photoreal.offsetY() : p.y + r.h + Math.min(0.6, r.h * 0.3);
      if (mesh) beacon.add(footprintOutline(r, top + 0.12));
      const pin = new THREE.Group(); pin.position.set(p.x, top + 0.05, p.z); pin.userData.pin = true; pin.userData.real = true; beacon.add(pin);
      const body = new THREE.Mesh(pinGeo || (pinGeo = new THREE.LatheGeometry(pinProfile(), 36)), new THREE.MeshStandardMaterial({ color: 0xec5f17, roughness: 0.42, metalness: 0.05, emissive: 0x401400 }));
      body.castShadow = false; pin.add(body);
      const eye = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex || (dotTex = radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)')), depthTest: false, toneMapped: false }));
      eye.scale.setScalar(0.3); eye.position.set(0, 0.68, 0); eye.renderOrder = 13; pin.add(eye);
      const lab = textSprite(u.n, { size: 64, mono: true, bg: 'rgba(255,255,255,0.96)', color: '#1d1f1a', worldHeight: 0.42, depthTest: false }); lab.position.set(0, 1.36, 0); lab.renderOrder = 12; pin.add(lab); pinLabel = lab;
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTex || (shadowTex = radialTexture('rgba(0,0,0,0.5)', 'rgba(0,0,0,0)')), transparent: true, depthWrite: false, toneMapped: false }));
      shadow.rotation.x = -Math.PI / 2; shadow.position.set(p.x, (mesh ? top : p.y + r.h) + 0.08, p.z); shadow.userData.shadow = true; shadow.renderOrder = 4; beacon.add(shadow);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 48), new THREE.MeshBasicMaterial({ color: 0xff7a00, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, (mesh ? top : p.y + r.h) + 0.1, p.z); ring.userData.pulse = true; beacon.add(ring);
      return;
    }
    if (!illus) {   // satellite (production look): a tall orange pole with the unit number on top
      const top = p.y + 28; const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, top - p.y, 6), new THREE.MeshBasicMaterial({ color: 0xff7a00 })); pole.position.set(p.x, (top + p.y) / 2, p.z); beacon.add(pole);
      const lab = textSprite(u.n, { size: 64, mono: true, bg: 'rgba(255,122,0,0.95)', color: '#fff', worldHeight: 5, depthTest: false }); lab.position.set(p.x, top + 3, p.z); lab.renderOrder = 12; beacon.add(lab); pinLabel = lab;
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.4, 2.2, 32), new THREE.MeshBasicMaterial({ color: 0xff7a00, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, p.y + 0.1, p.z); ring.userData.pulse = true; beacon.add(ring);
      return;
    }
    {   // a map pin over the unit, like a pin on a delivery map; sized to the zoom in the loop
      const pin = new THREE.Group(); pin.position.set(p.x, p.y + 0.12, p.z); pin.userData.pin = true; beacon.add(pin);
      const pinMat = new THREE.MeshLambertMaterial({ color: 0xff7a00 }); const top = 9;
      const head = new THREE.Mesh(new THREE.SphereGeometry(2.2, 20, 14), pinMat); head.position.set(0, top + 2.2, 0); pin.add(head);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.95, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffffff })); dot.position.set(0, top + 2.4, 0); pin.add(dot);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(1.75, 4.6, 20), pinMat); tip.position.set(0, top - 0.7, 0); tip.rotation.x = Math.PI; pin.add(tip);
      const lab = textSprite(u.n, { size: 64, mono: true, bg: 'rgba(255,255,255,0.97)', color: '#1d1f1a', worldHeight: 3.6, depthTest: false }); lab.position.set(0, top + 7.6, 0); lab.renderOrder = 12; pin.add(lab); pinLabel = lab;
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.4, 32), new THREE.MeshBasicMaterial({ color: 0xff7a00, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, p.y + 0.12, p.z); ring.userData.pulse = true; beacon.add(ring);
    }
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
  // Needs Attention badges (Oct 20 2026): a marker given as an object ({ label,
  // bg }) is a warning badge - a white-ringed disc with "!" that keeps one size
  // on screen (declutter sizes it) and draws over everything. Numbers stay the
  // ticket-count spheres.
  const badgeList = [];
  function badgeSprite(m) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64; const x = cv.getContext('2d');
    x.beginPath(); x.arc(32, 32, 29, 0, Math.PI * 2); x.fillStyle = '#fff'; x.fill();
    x.beginPath(); x.arc(32, 32, 24, 0, Math.PI * 2); x.fillStyle = m.bg || '#c43d2f'; x.fill();
    x.fillStyle = '#fff'; x.font = '800 34px Inter, system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(m.label || '!', 32, 34);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, sizeAttenuation: false, toneMapped: false }));
    sp.renderOrder = 12; sp.center.set(0.5, 0); sp.userData.px = m.px || 22; sp.userData.aspect = 1;
    const k = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / (el.clientHeight || 1); sp.scale.set(sp.userData.px * k, sp.userData.px * k, 1);
    return sp;
  }
  function renderMarkers() {
    clearGroup(markerGroup); badgeList.length = 0;
    if (state.mode !== 'owner') return;
    Object.keys(state.markers).forEach((n) => { const r = recOf[n]; const m = state.markers[n];
      if (r && m && typeof m === 'object') {
        // A badge stands at its own floor's height, shown whether or not the
        // building is open; a single-level view shows that level's badges only.
        const u = byName[n]; const bd = buildings[u.b]; const multi = !!bd && bd.floors > 1;
        if (state.level && multi && u.f !== state.level) return;
        const top = unitTop(r); let at = top;
        // All Levels: a lower-level unit has a floor above it - its badge moves just
        // outside the nearest wall, with a leader line, so it never reads as the unit above.
        if (multi && !state.level && u.f < bd.floors) {
          const cu = u.u + u.wu / 2, cv = u.v + u.dv / 2, out = 3;
          const spot = [[cu - bd.u[0], bd.u[0] - out, cv], [bd.u[1] - cu, bd.u[1] + out, cv], [cv - bd.v[0], cu, bd.v[0] - out], [bd.v[1] - cv, cu, bd.v[1] + out]].sort((a, c) => a[0] - c[0])[0];
          at = W(spot[1], spot[2], top.y);
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([top, at]), new THREE.LineBasicMaterial({ color: 0xc43d2f, depthTest: false, transparent: true, opacity: 0.9 }));
          line.renderOrder = 11; markerGroup.add(line);
        }
        const b = badgeSprite(m); b.position.set(at.x, at.y + 0.6, at.z); b.userData.unit = u; markerGroup.add(b); badgeList.push(b); return;
      }
      if (!r || !r.visible) return; const p = unitTop(r);
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), mat.marker); s.position.set(p.x, p.y + 1.4, p.z); s.userData.unit = byName[n]; markerGroup.add(s); const l = textSprite(String(state.markers[n]), { size: 40, bg: 'rgba(224,58,47,0.95)', color: '#fff', worldHeight: 1.8, depthTest: false }); l.position.set(p.x, p.y + 3.2, p.z); markerGroup.add(l); });
  }

  // "How to Get There" drawn on the ground: a ribbon from the gate to the unit
  // that draws itself in, then keeps its chevrons moving toward the unit; a disc
  // marks each step of the route card (flyToStep moves the camera to one).
  function renderRoute() {
    clearGroup(routeGroup); route = null; routeTex = null;
    if (!state.selected || opts.route === false) return;
    const u = byName[state.selected]; const plan = planRoute(model, u, routeSteps(model, u));
    if (!plan || plan.points.length < 2) return;
    route = plan; const pts = plan.points; const y = illus ? 0.32 : 0.2; const half = 0.55;
    // Under Google's mesh the lot is not flat at y = 0: the ribbon follows the real
    // surface, sampled every ~3 m along it (and draws over the mesh).
    const onReal = photo && photoreal; const off = onReal ? photoreal.offsetY() : 0;
    const yAt = (q) => { if (!onReal) return y; const h = photoreal.surfaceAt(q[0], q[1]); return (h == null ? 0 : h + off) + 0.25; };
    const line = [];
    pts.forEach((q, i) => {
      if (onReal && i) { const a = pts[i - 1]; const n = Math.ceil(Math.hypot(q[0] - a[0], q[1] - a[1]) / 3); for (let k = 1; k < n; k++) line.push([a[0] + ((q[0] - a[0]) * k) / n, a[1] + ((q[1] - a[1]) * k) / n]); }
      line.push(q);
    });
    const ly = line.map(yAt);
    const pos = []; const uv = []; const idx = []; let dist = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1]; const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 0.01) continue;
      const nx = -(b[1] - a[1]) / len * half, ny = (b[0] - a[0]) / len * half; const base = pos.length / 3;
      [[a[0] + nx, a[1] + ny, ly[i]], [a[0] - nx, a[1] - ny, ly[i]], [b[0] + nx, b[1] + ny, ly[i + 1]], [b[0] - nx, b[1] - ny, ly[i + 1]]].forEach((q) => pos.push(q[0], q[2], -q[1]));
      uv.push(dist / 2.4, 1, dist / 2.4, 0, (dist + len) / 2.4, 1, (dist + len) / 2.4, 0); dist += len;
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    routeTex = routeTexture();
    // Under Google's mesh the lot is not flat at y = 0: the ribbon draws over it.
    const ribbon = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: routeTex, transparent: true, opacity: 0.8, depthWrite: false, depthTest: !photo, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
    ribbon.renderOrder = 5; routeGroup.add(ribbon);
    routeReveal = { mesh: ribbon, total: idx.length, t0: performance.now() };
    if (reduceMotion) { routeReveal = null; } else g.setDrawRange(0, 0);
    // joints: round caps so the turns read as one line
    for (let i = 1; i < pts.length - 1; i++) { const d = new THREE.Mesh(new THREE.CircleGeometry(half, 16), ribbon.material); d.rotation.x = -Math.PI / 2; d.position.copy(W(pts[i][0], pts[i][1], yAt(pts[i]))); d.renderOrder = 5; routeGroup.add(d); }
    plan.stops.forEach((s, i) => {
      // The unit itself already carries the orange pin: only the stops before it get a marker.
      if (s.end) return;
      // Realistic: the slim pin is short - a stop right beside the unit would cover it.
      if (real && i > 0 && Math.hypot(s.uv[0] - (u.u + u.wu / 2), s.uv[1] - (u.v + u.dv / 2)) < 12) return;
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.2, 24), new THREE.MeshLambertMaterial({ color: 0x2f7de1 }));
      const sy = yAt(s.uv) - y; disc.position.copy(W(s.uv[0], s.uv[1], sy + y + 0.1)); routeGroup.add(disc);
      const l = textSprite(String(i + 1), { size: 48, bg: 'rgba(47,125,225,0.95)', color: '#fff', worldHeight: 1.8, depthTest: false });
      l.position.copy(W(s.uv[0], s.uv[1], sy + y + 1.8)); l.renderOrder = 11; routeGroup.add(l);
    });
  }

  function restyle(snap = false) {
    // See Inside is the only switch that opens every building (Oct 20: staff
    // views used to start see-through, so the button looked dead).
    // Staff (owner) views see into every building, as in production; See Inside
    // then lifts the floors apart. Under Google's mesh See Inside is the switch.
    const xray = state.xray || (state.mode === 'owner' && !photo);
    const selB = state.selected ? byName[state.selected].b : null;
    const explode = !!state.xray && !state.level;
    const moved = explode !== state.explode; state.explode = explode;
    const openB = {};
    shells.forEach((m) => {
      const b = m.userData.building; const open = xray || selB === b.id || (state.level && b.floors > 1); openB[b.id] = !!open;
      m.material.forEach((mm) => { mm.transparent = open; mm.opacity = open ? 0.16 : 1; mm.depthWrite = !open; }); if (m.userData.cap) m.userData.cap.visible = !open;
      // Under Google's mesh the real building is already there: our shell shows only when opened.
      m.visible = !photo || !!open; if (m.userData.edges) m.userData.edges.visible = m.visible;
    });
    // The before look kept every color crisp with the chosen unit in orange (Oct 20 review): dimming is opt-in.
    const focus = state.selected && state.focusDim === true;
    const neutral = mat.neutral.color.getHex(), neutralPark = mat.neutralPark.color.getHex();
    recs.forEach((r) => {
      const u = r.u; const b = buildings[u.b]; const multi = b && b.floors > 1;
      // A chosen level cuts away the floors above it; the floors below stay, dimmed.
      const lvlOk = !state.level || !multi || u.f <= state.level;
      const show = lvlOk && (!b || u.f === 1 || xray || selB === u.b || (multi && !!state.level)) && state.selected !== u.n;
      // Under Google's mesh our own unit boxes show only inside an opened building; the rest are markers.
      r.open = !!openB[u.b]; const ours = !photo || (r.form === 'interior' && r.open);
      if (show !== r.visible || ours !== r.ours || moved) { r.visible = show; r.ours = ours; placeInstance(r); }
      r.mshow = photo && show && !ours && !r.unplaced;
      let c = baseUnitColor(u, state.mode, state.colors, neutral, neutralPark);
      if (r.mi != null) {   // the marker wears the legend's own color (no photo muting)
        let mc = c; if (multi && state.level && u.f < state.level) mc = mixHex(mc, 0xcfccc4, 0.6);
        if (focus && state.selected !== u.n) mc = mixHex(mc, u.b === selB ? 0xd8d5cc : 0xbdbab2, u.b === selB ? 0.35 : 0.55);
        mk.top.setColorAt(r.mi, tmpC.setHex(mc));
      }
      if (real) c = mutedTint(c, 0.28);   // same hue as the legend, calmer over the photo
      if (multi && state.level && u.f < state.level) c = mixHex(c, 0xcfccc4, 0.6);
      if (focus && state.selected !== u.n) c = mixHex(c, u.b === selB ? 0xd8d5cc : 0xbdbab2, u.b === selB ? 0.35 : 0.55);
      tmpC.setHex(c); colTo[r.i * 3] = tmpC.r; colTo[r.i * 3 + 1] = tmpC.g; colTo[r.i * 3 + 2] = tmpC.b;
    });
    matricesChanged();
    if (mk.top && mk.top.instanceColor) mk.top.instanceColor.needsUpdate = true;
    if (vis.tint) vis.tint.material.opacity = state.mode === 'customer' ? 0.22 : photo ? 0.5 : 0.4;
    if (snap || reduceMotion) { colCur.set(colTo); pushColors(); } else colorsMoving = true;
    const sel = state.selected ? recOf[state.selected] : null;
    if (sel) {
      const b = buildings[sel.u.b]; const lvlOk = !state.level || !b || b.floors === 1 || sel.u.f <= state.level;
      // Under Google's mesh the chosen stall / container is the pin and its outline, not a box.
      selMesh.visible = lvlOk && (!photo || (sel.form === 'interior' && !!openB[sel.u.b])); selMesh.quaternion.setFromAxisAngle(UP, sel.rot); selMesh.scale.copy(sel.scale).multiplyScalar(1.04);
      selDoor.visible = selMesh.visible && !!sel.door; if (sel.door) { selDoor.scale.copy(sel.door.scale); selDoor.quaternion.copy(selMesh.quaternion); }
      selLift = 0;
    } else { selMesh.visible = false; selDoor.visible = false; }
    placeSelected();
    showUnitLabels(selB, state.level || (state.selected ? byName[state.selected].f : 0)); updateBeacon(); renderMarkers();
    if (state.routeFor !== state.selected) { state.routeFor = state.selected; renderRoute(); }
  }
  function pushColors() {
    for (let i = 0; i < recs.length; i++) {
      tmpC.setRGB(colCur[i * 3], colCur[i * 3 + 1], colCur[i * 3 + 2]); const v = recs[i].vis;
      if (!v) unitInst.setColorAt(i, tmpC);
      else if (v.tint != null) vis.tint.setColorAt(v.tint, tmpC); else if (v.roof != null) vis.roof.setColorAt(v.roof, tmpC); else if (v.inner != null) vis.inner.setColorAt(v.inner, tmpC);
    }
    [unitInst, vis.tint, vis.roof, vis.inner].forEach((m) => { if (m && m.instanceColor) m.instanceColor.needsUpdate = true; });
  }
  function placeSelected() {
    const sel = state.selected ? recOf[state.selected] : null; if (!sel) return;
    const lift = (real ? Math.min(0.6, sel.h * 0.3) : Math.min(1.4, sel.h * 0.6)) * selLift;
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
    for (const b of badgeList) b.scale.set(b.userData.px * k, b.userData.px * k, 1);
    labelOrder = labelOrder || sortedLabels(); const placed = [];
    if (pinLabel) {   // the chosen unit's pin label wins its spot: no unit number drawn over it
      pinLabel.getWorldPosition(projV); const d = camera.position.distanceTo(projV); const s = pinLabel.getWorldScale(tmpV);
      projV.project(camera);
      if (projV.z <= 1) { const ph = s.y / (d * k); placed.push([(projV.x + 1) / 2 * Wpx, (1 - projV.y) / 2 * H, (ph * s.x / s.y) / 2 + 4, ph / 2 + 4]); }
    }
    // Unit numbers nearest the view's center (or the chosen unit) get the room first.
    const focus = state.selected && recOf[state.selected] ? recOf[state.selected].pos : ctrl.target;
    unitLabelList.sort((a, b) => Math.hypot(a.position.x - focus.x, a.position.z - focus.z) - Math.hypot(b.position.x - focus.x, b.position.z - focus.z));
    for (const sp of [...labelOrder, ...unitLabelList]) {
      if (photo && sp.userData.photoHide) { sp.visible = false; continue; }
      if (sp.userData.unit) {   // a unit number: neighbors from mid zoom, the whole row only close up
        const rec = recOf[sp.userData.unit.n];
        // Whenever there is room on screen (the overlap check below), at any zoom.
        if (!rec || !rec.visible) { sp.visible = false; continue; }
      }
      const px = sp.userData.px; sp.scale.set(px * sp.userData.aspect * k, px * k, 1);
      projV.copy(sp.position).project(camera);
      if (projV.z > 1 || Math.abs(projV.x) > 1.05 || Math.abs(projV.y) > 1.05) { sp.visible = false; continue; }
      const x = (projV.x + 1) / 2 * Wpx, y = (1 - projV.y) / 2 * H, w = px * sp.userData.aspect / 2 + 3, h = px / 2 + 2;
      const hit = placed.some((q) => Math.abs(q[0] - x) < q[2] + w && Math.abs(q[1] - y) < q[3] + h);
      sp.visible = !hit; if (!hit) placed.push([x, y, w, h]);
    }
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
  const ctrl = { target: W(bounds.cu, bounds.cv, 0), theta: illus ? -0.6 : 0, phi: illus ? 0.72 : real ? 0.62 : 0.9, radius: real ? bounds.r * 0.92 : bounds.r, min: 10, max: Math.max(1200, bounds.r * 3) };
  if (illus) scene.fog = new THREE.Fog(DIORAMA.fog, bounds.r * 1.8, bounds.r * 6);   // the far floor fades into the sky
  // A big board needs the sun pulled back, or the far corners fall outside the shadow box.
  const sunK = illus ? Math.max(1, bounds.r / 220) : 1;
  sun.target.position.copy(ctrl.target); sun.position.copy(ctrl.target.clone().add(new THREE.Vector3(-160, 260, 120).multiplyScalar(sunK)));
  Object.assign(sun.shadow.camera, { left: -bounds.r, right: bounds.r, top: bounds.r, bottom: -bounds.r, far: illus ? 330 * sunK + bounds.r * 1.6 : 700 }); sun.shadow.camera.updateProjectionMatrix();
  if (real) {   // the real sun angle; one shadow box sized to the lot
    const half = Math.max(80, bounds.r * 0.62); sun.position.copy(ctrl.target).addScaledVector(new THREE.Vector3(...sunDir), 500);
    Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 100, far: 1000 }); sun.shadow.camera.updateProjectionMatrix();
  }
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
    overview: () => flyTo(W(bounds.cu, bounds.cv, 0), illus ? -0.6 : 0, illus ? 0.72 : real ? 0.62 : 0.9, real ? bounds.r * 0.92 : bounds.r),
    plan: () => flyTo(W(bounds.cu, bounds.cv, 0), 0, 1.45, bounds.r * 0.95),
    // Stand just outside the gate and look across the site.
    gate: () => { const g = gate0 || [bounds.cu, bounds.cv]; const theta = Math.atan2(g[0] - bounds.cu, -(g[1] - bounds.cv)); flyTo(W(g[0], g[1], 0), theta, 0.22, Math.max(90, bounds.r * 0.4)); },
  };
  // True north's bearing in the plan (clockwise from +v); 0 when the model does not say.
  const NORTH = model.frame && model.frame.north ? Math.atan2(model.frame.north[0], model.frame.north[1]) : 0;
  let drag = null; const touches = new Map();
  function pan(dx, dy) { const s = ctrl.radius * 0.0016; const right = new THREE.Vector3(Math.cos(ctrl.theta), 0, -Math.sin(ctrl.theta)); const fwd = new THREE.Vector3(-Math.sin(ctrl.theta), 0, -Math.cos(ctrl.theta)); ctrl.target.addScaledVector(right, -dx * s).addScaledVector(fwd, dy * s); }   // grab the ground: it follows the mouse, like Google Maps
  const onDown = (e) => { idle = false; el.setPointerCapture(e.pointerId); touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Mark an Issue: one finger / the mouse draws; a second finger cancels the stroke and moves the map.
    if (markup.active()) { if (touches.size === 1 && markup.down(e)) { drag = null; return; } markup.cancelStroke(); }
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, button: e.button, moved: false, dist: null }; };
  const onMove = (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (markup.move(e)) return;
    if (!drag) { hover(e); return; }
    // Two fingers: pinch to zoom, twist to turn, move together to tilt.
    if (touches.size === 2) { const pts = [...touches.values()]; const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y); const a = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x); const cy = (pts[0].y + pts[1].y) / 2; if (drag.dist) { ctrl.radius *= drag.dist / d; let da = a - drag.a; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI; ctrl.theta -= da; ctrl.phi += (cy - drag.cy) * 0.006; } drag.dist = d; drag.a = a; drag.cy = cy; drag.moved = true; applyCamera(); return; }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
    // Google Maps style (Visesh, Oct 20 "unable to move around the map"): a
    // plain drag moves the map; right-drag or Ctrl / Shift + drag turns and tilts.
    if (drag.button === 2 || e.ctrlKey || e.shiftKey || e.metaKey) { ctrl.theta -= dx * 0.006; ctrl.phi += dy * 0.006; } else pan(dx, dy);
    applyCamera();
  };
  const onUp = (e) => { touches.delete(e.pointerId); if (markup.up(e)) return; if (drag && !drag.moved && drag.button === 0) click(e); if (touches.size === 0) drag = null; else drag.dist = null; };
  const onWheel = (e) => { idle = false; e.preventDefault(); ctrl.radius *= Math.exp(e.deltaY * 0.0012); applyCamera(); };
  const onCtx = (e) => e.preventDefault();
  el.addEventListener('pointerdown', onDown); el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onUp);
  el.addEventListener('wheel', onWheel, { passive: false }); el.addEventListener('contextmenu', onCtx);

  // ---- picking ----
  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
  function cast(e, list) { const r = el.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); return ray.intersectObjects(list, false); }
  const pickList = () => {
    const list = photo && mk.base ? [mk.base] : [unitInst];
    if (photo && mk.base) mk.base.computeBoundingSphere();   // the markers move and resize every frame
    return selMesh.visible ? list.concat(selMesh) : list;
  };
  selMesh.userData.selected = true;
  /** The unit a ray hit: an instance id, or the raised selected box. */
  const unitOfHit = (h) => {
    if (!h) return null; if (h.object === selMesh) return byName[state.selected];
    if (h.object.isSprite) return h.object.userData.unit || null;
    const r = h.object === unitInst ? recs[h.instanceId] : h.object === mk.base ? mk.recs[h.instanceId] : null;
    return r && (h.object === mk.base ? r.mshow : r.visible) ? r.u : null;
  };
  const firstUnit = (hits) => { for (const h of hits) { const u = unitOfHit(h); if (u) return { h, u }; } return null; };
  // A Needs Attention badge draws over everything, so it is hit first: it picks its own unit, never the one behind it.
  const pickHit = (e) => (badgeList.length && firstUnit(cast(e, badgeList))) || firstUnit(cast(e, pickList()));
  // Mark an Issue (siteModelMarkup.js): where a stroke starts - a unit, a building or the ground.
  const markup = createMarkup({
    scene, camera, el, onMark: (m) => { if (opts.onMark) opts.onMark(m); },
    rayFor: (e) => { cast(e, []); return ray.ray; },
    start: (e) => {
      const hits = cast(e, pickList().concat(shells, groundHits)); const uh = firstUnit(hits);
      const h = uh ? uh.h : hits.find((x) => x.object !== unitInst && x.object !== selMesh); if (!h) return null;
      const b = h.object.userData.building;
      return { u: +h.point.x.toFixed(2), v: +(-h.point.z).toFixed(2), y: +h.point.y.toFixed(2), unit: uh ? uh.u.n : '', building: uh ? uh.u.b : b ? b.id : '' };
    },
  });
  const spotAt = (e) => { if (!markup.badges.length) return null; const h = cast(e, markup.badges)[0]; return h ? h.object.userData.spot : null; };
  let hoveredSpot = null;
  let hovered = null; let lastHoverAt = 0;
  function hover(e) {
    if (e.pointerType === 'touch') return;
    const now = performance.now(); if (now - lastHoverAt < 40) return; lastHoverAt = now;   // ~25 raycasts/s is plenty
    const r = el.getBoundingClientRect();
    // Marking: nothing under the pen lights up (Visesh, Oct 20 - a unit looked selected while drawing).
    if (markup.active()) {
      el.style.cursor = 'crosshair';
      if (hovered) { hovered = null; showHover(null); if (opts.onHover) opts.onHover(null); }
      if (hoveredSpot) { hoveredSpot = null; if (opts.onHoverSpot) opts.onHoverSpot(null); }
      return;
    }
    // An open ticket's spot first: its badge draws over everything.
    const sp = spotAt(e);
    if (sp !== hoveredSpot) { hoveredSpot = sp; if (opts.onHoverSpot) opts.onHoverSpot(sp, { x: e.clientX - r.left, y: e.clientY - r.top }); }
    if (sp) { el.style.cursor = 'pointer'; if (hovered) { hovered = null; showHover(null); if (opts.onHover) opts.onHover(null); } return; }
    const hit = pickHit(e);
    el.style.cursor = hit ? 'pointer' : state.placing || markup.active() ? 'crosshair' : '';
    const unit = hit ? hit.u : null;
    if (unit === hovered) return;            // the React side re-renders only when the hovered unit changes
    hovered = unit; showHover(unit);
    if (opts.onHover) opts.onHover(unit, { x: e.clientX - r.left, y: e.clientY - r.top });
  }
  function click(e) {
    if (state.placing) {
      const hits = cast(e, pickList().concat(shells, groundHits)); const uh = firstUnit(hits);
      const hit = uh ? uh.h : hits.find((h) => h.object !== unitInst && h.object !== selMesh);
      if (hit && opts.onPlacePin) {
        const u = uh ? uh.u : null; const b = hit.object.userData.building;
        // Under Google's mesh the pin goes on the real surface at that spot.
        let y = hit.point.y; if (photo && photoreal && !b) { const sy = photoreal.surfaceAt(hit.point.x, -hit.point.z); if (sy != null) y = sy + photoreal.offsetY(); }
        opts.onPlacePin({ u: +hit.point.x.toFixed(2), v: +(-hit.point.z).toFixed(2), y: +y.toFixed(2), unit: u ? u.n : '', building: u ? u.b : b ? b.id : '' });
      }
      return;
    }
    const sp = spotAt(e);
    if (sp) { if (opts.onPickSpot) opts.onPickSpot(sp); return; }
    const hit = pickHit(e);
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
    if (diorama && !reduceMotion) diorama.update(dt);
    {   // the pin bobs and keeps a readable size from any distance; the ring under it pulses
      const sz = illus ? Math.max(1, Math.min(6, ctrl.radius / 110)) : 1;   // satellite: the pole keeps its size
      const pin = real && beacon.children.find((c) => c.userData.real);
      if (pin) {
        const px = camera.position.distanceTo(pin.position) * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / (el.clientHeight || 1);
        const s = Math.max(0.9, px * 46);
        beacon.children.forEach((c) => {
          if (c.userData.pin) c.scale.setScalar(s);
          if (c.userData.shadow) c.scale.setScalar(s * 0.5);
          if (c.userData.pulse) { const k = reduceMotion ? 0.3 : (now / 1600) % 1; c.scale.setScalar(s * (0.6 + k * 1.4)); c.material.opacity = 0.45 * (1 - k); }
        });
      } else beacon.children.forEach((c) => {
        if (c.userData.pin) { c.scale.setScalar(sz); c.position.y = (c.userData.y0 ??= c.position.y) + (reduceMotion ? 0 : Math.sin(now / 380) * 0.6 * sz); }
        if (c.userData.pulse) { const k = reduceMotion ? 0.3 : (now / 1400) % 1; c.scale.setScalar(sz * (1 + k * 2.2)); c.material.opacity = 0.5 * (1 - k); }
      });
    }
    // The illustrated look turns slowly until the first touch, like a model on a turntable.
    if (idle && !anim) { ctrl.theta += dt * 0.05; applyCamera(); }
    if (anim) anim(now); if (state.selected) mat.sel.emissive.setHex(0x663300).multiplyScalar(0.5 + 0.5 * Math.sin(now / 400));
    if (colorsMoving) {   // ease every unit's color toward its target (a layer switch fades in ~1/4 s)
      const a = 1 - Math.exp(-dt * 12); let still = true;
      for (let i = 0; i < colCur.length; i++) { const d = colTo[i] - colCur[i]; if (Math.abs(d) > 0.002) { colCur[i] += d * a; still = false; } else colCur[i] = colTo[i]; }
      pushColors(); if (still) colorsMoving = false;
    }
    if (state.selected && selLift < 1) { selLift = reduceMotion ? 1 : Math.min(1, selLift + dt * 3); placeSelected(); }
    if (routeTex && !reduceMotion) routeTex.offset.x -= dt * 0.5;
    if (routeReveal) { const k = Math.min(1, (now - routeReveal.t0) / 1400); const n = Math.floor(routeReveal.total * k / 6) * 6; routeReveal.mesh.geometry.setDrawRange(0, k >= 1 ? Infinity : n); if (k >= 1) routeReveal = null; }
    declutter(now);
    if (terrain) {
      // Clip planes follow the zoom: close to the ground for detail, far enough for the horizon.
      const near = Math.max(0.3, Math.min(8, ctrl.radius * 0.006)); if (Math.abs(near - camera.near) > 0.05) { camera.near = near; camera.updateProjectionMatrix(); }
      if (sky) sky.position.copy(camera.position);
      if (photoreal) { photoreal.update(now); if (photo) { sampleSurface(now); placeMarkers(); } if (now - lastCredit > 1000) { lastCredit = now; const c = photoreal.attribution(); if (c !== credit) { credit = c; if (opts.onAttribution) opts.onAttribution(c); } } }
    }
    renderer.render(scene, camera); markup.paint(); }
  let lastCredit = 0; let credit = '';

  // The real surface under every marker and label, from Google's mesh: rays
  // straight down, a few milliseconds' worth a frame, cached per unit. A pass
  // runs again whenever the mesh changes (tiles load or refine), so the heights
  // sharpen as the finer tiles arrive and then it goes quiet.
  const surfList = mk.recs.map((r) => r.s).concat(anchors.map((a) => a.s));
  const surf = { ver: -1, i: 0, running: false, again: false, changed: false, at: 0, off: 0 };
  function sampleSurface(now) {
    const v = photoreal.version();
    if (v !== surf.ver) { surf.ver = v; if (surf.running) surf.again = true; else { surf.running = true; surf.i = 0; } }
    if (surf.running) {
      const t0 = performance.now(); let n = 0;
      while (surf.i < surfList.length && (n < 8 || performance.now() - t0 < 3)) {
        const t = surfList[surf.i++]; n++; const y = photoreal.surfaceAt(t.u, t.v);
        if (y != null && (t.sy == null || Math.abs(y - t.sy) > 0.03)) { t.sy = y; surf.changed = true; }
      }
      if (surf.i >= surfList.length) { if (surf.again) { surf.again = false; surf.i = 0; } else surf.running = false; }
    }
    const off = photoreal.offsetY(); if (Math.abs(off - surf.off) > 0.02) { surf.off = off; surf.changed = true; }
    // Labels, the chosen unit's pin and the Needs Attention badges follow (at most twice a second).
    if (surf.changed && now - surf.at > 500) {
      surf.changed = false; surf.at = now;
      anchors.forEach((a) => { if (a.s.sy != null) a.obj.position.y = a.s.sy + off + a.dy; });
      unitLabelList.forEach((sp) => { const r = recOf[sp.userData.unit.n]; if (r) { sp.position.copy(unitTop(r)); sp.position.y += 0.4; } });
      if (state.selected) updateBeacon();
      if (Object.keys(state.markers).length) renderMarkers();
    }
  }
  if (diorama) diorama.setParked(units, state.mode === 'owner');
  resize(); applyCamera(); restyle(true); if (photo) applyPhotoMode(); raf = requestAnimationFrame(loop);

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
    // Mark an Issue: 'circle' | 'free' turns marking on, null off; the open tickets' spots; fly to one.
    setMarking(shape) {
      markup.setShape(shape); el.style.cursor = shape ? 'crosshair' : '';
      // A chosen unit's raised orange block would read as part of the mark: let it go.
      if (shape && state.selected) { state.selected = null; restyle(); if (opts.onSelectUnit) opts.onSelectUnit(null); }
    },
    clearMark() { markup.clearDraft(); },
    setSpots(list) { markup.setSpots(list); },
    focusSpot(s) { if (!s) return; idle = false; flyTo(W(s.u, s.v, s.y || 0), ctrl.theta, 0.95, Math.max(60, (s.r || 0) * 8)); },
    /** The view as a JPEG data URL (rendered now, so the drawing buffer still holds it), or ''. */
    snapshot(maxW = 1280) {
      try {
        renderer.render(scene, camera);
        const k = Math.min(1, maxW / (el.width || 1)); const cv = document.createElement('canvas');
        cv.width = Math.round(el.width * k); cv.height = Math.round(el.height * k);
        markup.paint(); const x = cv.getContext('2d');
        x.drawImage(el, 0, 0, cv.width, cv.height); x.drawImage(markup.ink, 0, 0, cv.width, cv.height);   // the ink on top
        return cv.toDataURL('image/jpeg', 0.82);
      } catch { return ''; }
    },
    view(name) { if (VIEWS[name]) VIEWS[name](); },
    flyToPin(p) { flyTo(W(p.u, p.v, p.y || 0), ctrl.theta, 0.7, 50); },
    getState() { return { ...state }; },
    // Compass and tilt (Visesh, Oct 20): heading = the camera's turn (0 = north up), tilt = how far it looks down.
    // heading = how far true north is turned from screen-up (radians, clockwise).
    // The plan's axes are not true north (frame.north, e.g. ~50 deg at Escondido),
    // so north's bearing in the plan is added to the camera's turn.
    getCamera() { return { heading: ctrl.theta + NORTH, tilt: ctrl.phi }; },
    turnBy(rad) { idle = false; anim = null; ctrl.theta += rad; applyCamera(); },
    tiltBy(rad) { idle = false; anim = null; ctrl.phi += rad; applyCamera(); },
    faceNorth() { idle = false; flyTo(ctrl.target.clone(), -NORTH, ctrl.phi, ctrl.radius, 500); },
    /** Top-down (2D) and back to the usual 3D angle. */
    toggleTilt() { idle = false; const flat = ctrl.phi > 1.3; flyTo(ctrl.target.clone(), ctrl.theta, flat ? (illus ? 0.72 : real ? 0.62 : 0.9) : 1.45, ctrl.radius, 500); return !flat; },
    destroy() {
      alive = false; cancelAnimationFrame(raf); markup.dispose(); if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
      el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onUp); el.removeEventListener('wheel', onWheel); el.removeEventListener('contextmenu', onCtx);
      labelCache.forEach((sp) => disposeObject(sp)); labelCache.clear(); if (diorama) diorama.dispose(); if (ground) ground.dispose(); if (photoreal) photoreal.dispose(); edgeGeo.dispose(); if (pinGeo) pinGeo.dispose(); scene.traverse((o) => { if (o !== scene) disposeObject(o); }); scene.clear();
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
