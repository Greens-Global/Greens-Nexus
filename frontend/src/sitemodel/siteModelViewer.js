// Site model viewer core (Neil, Oct 11 2026) - framework-free three.js scene
// for one property's to-scale site model (backend/site_models/<id>.json).
//
// World frame: x = u (along the site axis, southeast), y = up, z = -v (so the
// northeast side of the site is away from a camera parked at theta 0). One
// world unit is one meter. The React wrappers (SiteModelPanel.jsx) own every
// piece of DOM except the canvas; this module only draws, picks and animates.
import * as THREE from 'three';

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

function solarTexture() {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 32; const x = cv.getContext('2d');
  x.fillStyle = '#243247'; x.fillRect(0, 0, 64, 32); x.fillStyle = '#1b2638';
  for (let i = 0; i < 64; i += 8) for (let j = 0; j < 32; j += 16) x.fillRect(i + 1, j + 1, 6, 14);
  x.strokeStyle = '#4e6a9a'; x.lineWidth = 1;
  for (let i = 0; i < 64; i += 8) { x.beginPath(); x.moveTo(i + 0.5, 0); x.lineTo(i + 0.5, 32); x.stroke(); }
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(40, 8); t.colorSpace = THREE.SRGBColorSpace; return t;
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
 * imagery the model's `image` / `imageWide` corners describe.
 */
export function createSiteModelViewer(container, model, options = {}) {
  const opts = { mode: 'customer', images: {}, onSelectUnit: null, onSelectBuilding: null, onPlacePin: null, onHover: null, ...options };
  const state = { mode: opts.mode, selected: null, xray: false, level: 0, placing: false, pins: [], markers: {} };
  const units = model.units || []; const byName = {}; units.forEach((u) => { byName[u.n] = u; });
  const buildings = {}; (model.buildings || []).forEach((b) => { buildings[b.id] = b; });
  const W = (u, v, y) => new THREE.Vector3(u, y || 0, -v);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const el = renderer.domElement; el.style.display = 'block'; el.style.width = '100%'; el.style.height = '100%'; el.style.touchAction = 'none';
  container.appendChild(el);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(opts.background || '#dfe6e9');
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 4000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x777766, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-160, 260, 120); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -260, right: 260, top: 260, bottom: -260, near: 50, far: 700 }); sun.shadow.bias = -0.0008;
  scene.add(sun); scene.add(sun.target);

  const mat = {
    wall: new THREE.MeshLambertMaterial({ color: 0xe9e6dd }),
    roofWhite: new THREE.MeshLambertMaterial({ color: 0xf4f2ec }),
    roofSolar: new THREE.MeshLambertMaterial({ map: solarTexture() }),
    roofRed: new THREE.MeshLambertMaterial({ color: 0xb8553b }),
    edge: new THREE.LineBasicMaterial({ color: 0x55584f }),
    parcel: new THREE.LineBasicMaterial({ color: 0x1f6f4a }),
    pad: new THREE.MeshBasicMaterial({ color: 0x8a8f94, transparent: true, opacity: 0.28, depthWrite: false }),
    zone: new THREE.MeshBasicMaterial({ color: 0xd9b36a, transparent: true, opacity: 0.22, depthWrite: false }),
    zoneLine: new THREE.LineBasicMaterial({ color: 0xa87a1d }),
    door: new THREE.MeshBasicMaterial({ color: 0x5a5d55 }),
    pin: { maintenance: new THREE.MeshLambertMaterial({ color: 0xe03a2f }), inspection: new THREE.MeshLambertMaterial({ color: 0x2f6fe0 }), note: new THREE.MeshLambertMaterial({ color: 0x8a5fd0 }) },
    marker: new THREE.MeshLambertMaterial({ color: 0xe03a2f, emissive: 0x330000 }),
  };
  Object.keys(KIND_COLORS).forEach((k) => { mat[k] = new THREE.MeshLambertMaterial({ color: KIND_COLORS[k] }); });
  mat.sel.emissive = new THREE.Color(0x663300);

  // ---- ground ----
  const base = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800), new THREE.MeshLambertMaterial({ color: 0x9aa18f }));
  base.rotation.x = -Math.PI / 2; base.position.y = -0.3; base.receiveShadow = true; scene.add(base);
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
  if (model.imageWide && model.imageWide.uv) quad(model.imageWide.uv, opts.images.wide, -0.12, 0xa3a898);
  if (model.image && model.image.uv) quad(model.image.uv, opts.images.detail, -0.05, 0xb8b4a8);

  function flatPoly(pts, material, y) { const s = new THREE.Shape(); pts.forEach((p, i) => (i ? s.lineTo(p[0], p[1]) : s.moveTo(p[0], p[1]))); const m = new THREE.Mesh(new THREE.ShapeGeometry(s), material); m.rotation.x = -Math.PI / 2; m.position.y = y; return m; }
  function lineLoop(pts, material, y) { const g = new THREE.BufferGeometry().setFromPoints(pts.concat([pts[0]]).map((p) => W(p[0], p[1], y))); return new THREE.Line(g, material); }
  if (model.pad) scene.add(flatPoly(model.pad, mat.pad, 0.02));
  if (model.parcel) scene.add(lineLoop(model.parcel, mat.parcel, 0.4));
  (model.zones || []).forEach((z) => { scene.add(flatPoly(z.uv, mat.zone, 0.04)); scene.add(lineLoop(z.uv, mat.zoneLine, 0.1)); const c = centroid(z.uv); const l = textSprite(z.name, { size: 48, bg: 'rgba(255,255,255,0.8)', worldHeight: 4 }); l.position.copy(W(c[0], c[1], 4)); scene.add(l); });
  (model.gates || []).forEach((g) => { const l = textSprite(g.name, { size: 48, bg: 'rgba(31,111,74,0.9)', color: '#fff', worldHeight: 4 }); l.position.copy(W(g.uv[0], g.uv[1], 3)); scene.add(l); const post = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 2.5, 8), new THREE.MeshLambertMaterial({ color: 0x1f6f4a })); post.position.copy(W(g.uv[0], g.uv[1], 1.25)); scene.add(post); });

  // ---- buildings ----
  const shells = [];
  (model.buildings || []).forEach((b) => {
    const L = b.u[1] - b.u[0], Wd = b.v[1] - b.v[0];
    const roof = b.roof === 'solar' ? mat.roofSolar : b.roof === 'red' ? mat.roofRed : mat.roofWhite;
    const mats = [mat.wall, mat.wall, roof, mat.wall, mat.wall, mat.wall].map((m) => m.clone());
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(L, b.height, Wd), mats);
    mesh.position.copy(W((b.u[0] + b.u[1]) / 2, (b.v[0] + b.v[1]) / 2, b.height / 2));
    mesh.userData.building = b; mesh.castShadow = true; scene.add(mesh); shells.push(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), mat.edge); edges.position.copy(mesh.position); scene.add(edges);
    for (let f = 2; f <= b.floors; f++) { const y = b.height * (f - 1) / b.floors; scene.add(lineLoop([[b.u[0], b.v[0]], [b.u[1], b.v[0]], [b.u[1], b.v[1]], [b.u[0], b.v[1]]], mat.edge, y)); }
    const label = textSprite(b.letters.join(' / '), { size: 72, bg: 'rgba(255,255,255,0.85)', worldHeight: 7 });
    label.position.copy(W((b.u[0] + b.u[1]) / 2, (b.v[0] + b.v[1]) / 2, b.height + 5)); scene.add(label);
  });

  // ---- units ----
  const cellGeo = new THREE.BoxGeometry(1, 1, 1); const unitMeshes = []; const meshOf = {};
  units.forEach((u) => {
    const b = buildings[u.b]; const fh = b ? b.height / b.floors : 0; const baseY = (u.f - 1) * fh;
    const h = u.k === 'park' ? 0.12 : Math.min(2.2, Math.max(0.6, fh ? fh * 0.6 : 0.6));
    const m = new THREE.Mesh(cellGeo, mat.neutral);
    m.scale.set(Math.max(0.3, u.wu - 0.12), h, Math.max(0.3, u.dv - 0.12));
    m.position.copy(W(u.u + u.wu / 2, u.v + u.dv / 2, baseY + h / 2 + 0.03));
    m.userData.unit = u; scene.add(m); unitMeshes.push(m); meshOf[u.n] = { mesh: m };
    if (u.k !== 'park' && b) {
      const d = new THREE.Mesh(cellGeo, mat.door); d.scale.set(Math.max(0.3, u.wu - 0.3), h + 0.02, 0.25);
      const vz = u.door === 'ne' ? u.v + u.dv - 0.12 : u.v + 0.12; d.position.copy(W(u.u + u.wu / 2, vz, baseY + h / 2 + 0.03)); scene.add(d); meshOf[u.n].door = d;
    }
  });

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

  function showUnitLabels(bid) {
    if (labelsFor === bid) return; labelsFor = bid;
    clearGroup(unitLabels);
    if (!bid) return;
    units.filter((x) => x.b === bid).forEach((x) => { const m = meshOf[x.n].mesh; const sp = textSprite(x.n, { size: 40, mono: true, weight: 500, bg: 'rgba(255,255,255,0.75)', worldHeight: Math.min(1.6, Math.max(0.9, x.wu * 0.45)) }); sp.position.copy(m.position.clone().setY(m.position.y + m.scale.y / 2 + 0.6)); sp.userData.unit = x; unitLabels.add(sp); });
  }
  function updateBeacon() {
    clearGroup(beacon);
    if (!state.selected) return; const u = byName[state.selected]; const p = meshOf[u.n].mesh.position;
    const top = p.y + 28; const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, top - p.y, 6), new THREE.MeshBasicMaterial({ color: 0xff7a00 })); pole.position.set(p.x, (top + p.y) / 2, p.z); beacon.add(pole);
    const lab = textSprite(u.n, { size: 64, mono: true, bg: 'rgba(255,122,0,0.95)', color: '#fff', worldHeight: 5, depthTest: false }); lab.position.set(p.x, top + 3, p.z); beacon.add(lab);
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
    Object.keys(state.markers).forEach((n) => { const e = meshOf[n]; if (!e) return; const p = e.mesh.position; const s = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), mat.marker); s.position.set(p.x, p.y + e.mesh.scale.y / 2 + 1.4, p.z); s.userData.unit = byName[n]; markerGroup.add(s); const l = textSprite(String(state.markers[n]), { size: 40, bg: 'rgba(224,58,47,0.95)', color: '#fff', worldHeight: 1.8, depthTest: false }); l.position.set(p.x, p.y + e.mesh.scale.y / 2 + 3.2, p.z); markerGroup.add(l); });
  }
  function unitMaterial(u) {
    if (state.selected === u.n) return mat.sel;
    if (state.mode === 'customer') return u.k === 'park' ? mat.neutralPark : mat.neutral;
    if (u.r === 0) return mat.bad; if (u.l === 1) return mat.ok; return mat.warn;
  }
  function restyle() {
    const xray = state.xray || state.mode === 'owner';
    const selB = state.selected ? byName[state.selected].b : null;
    shells.forEach((m) => { const open = xray || selB === m.userData.building.id; m.material.forEach((mm) => { mm.transparent = open; mm.opacity = open ? 0.16 : 1; mm.depthWrite = !open; }); });
    units.forEach((u) => { const b = buildings[u.b]; const e = meshOf[u.n]; const lvlOk = !state.level || !b || b.floors === 1 || u.f === state.level; const show = lvlOk && (!b || u.f === 1 || xray || selB === u.b); e.mesh.visible = show; if (e.door) e.door.visible = show; e.mesh.material = unitMaterial(u); });
    unitLabels.children.forEach((sp) => { sp.visible = meshOf[sp.userData.unit.n].mesh.visible; });
    showUnitLabels(selB); updateBeacon();
  }

  // ---- camera ----
  const ctrl = { target: new THREE.Vector3(50, 0, 30), theta: 0, phi: 0.9, radius: 320, min: 10, max: 1200 };
  function applyCamera() {
    ctrl.phi = Math.max(0.08, Math.min(1.45, ctrl.phi)); ctrl.radius = Math.max(ctrl.min, Math.min(ctrl.max, ctrl.radius));
    camera.position.set(Math.sin(ctrl.theta) * Math.cos(ctrl.phi), Math.sin(ctrl.phi), Math.cos(ctrl.theta) * Math.cos(ctrl.phi)).multiplyScalar(ctrl.radius).add(ctrl.target); camera.lookAt(ctrl.target);
  }
  let anim = null;
  function flyTo(target, theta, phi, radius, ms = 800) {
    const from = { t: ctrl.target.clone(), theta: ctrl.theta, phi: ctrl.phi, r: ctrl.radius }; const t0 = performance.now();
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ms = 0;
    anim = (now) => { const k = ms ? Math.min(1, (now - t0) / ms) : 1; const e = k < 0.5 ? 2 * k * k : -1 + (4 - 2 * k) * k; ctrl.target.lerpVectors(from.t, target, e); ctrl.theta = from.theta + (theta - from.theta) * e; ctrl.phi = from.phi + (phi - from.phi) * e; ctrl.radius = from.r + (radius - from.r) * e; applyCamera(); if (k >= 1) anim = null; };
  }
  const VIEWS = {
    overview: () => flyTo(new THREE.Vector3(50, 0, 30), 0, 0.9, 320),
    plan: () => flyTo(new THREE.Vector3(50, 0, 30), 0, 1.45, 300),
    gate: () => flyTo(W(55, -25, 0), Math.PI, 0.22, 125),
  };
  let drag = null; const touches = new Map();
  function pan(dx, dy) { const s = ctrl.radius * 0.0016; const right = new THREE.Vector3(Math.cos(ctrl.theta), 0, -Math.sin(ctrl.theta)); const fwd = new THREE.Vector3(-Math.sin(ctrl.theta), 0, -Math.cos(ctrl.theta)); ctrl.target.addScaledVector(right, -dx * s).addScaledVector(fwd, -dy * s); }
  const onDown = (e) => { el.setPointerCapture(e.pointerId); touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, button: e.button, moved: false, dist: null }; };
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
  const onWheel = (e) => { e.preventDefault(); ctrl.radius *= Math.exp(e.deltaY * 0.0012); applyCamera(); };
  const onCtx = (e) => e.preventDefault();
  el.addEventListener('pointerdown', onDown); el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onUp);
  el.addEventListener('wheel', onWheel, { passive: false }); el.addEventListener('contextmenu', onCtx);

  // ---- picking ----
  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
  function cast(e, list) { const r = el.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); return ray.intersectObjects(list, false); }
  const visibleUnits = () => unitMeshes.filter((m) => m.visible);
  let hovered = null; let lastHoverAt = 0;
  function hover(e) {
    if (e.pointerType === 'touch') return;
    const now = performance.now(); if (now - lastHoverAt < 40) return; lastHoverAt = now;   // ~25 raycasts/s is plenty
    const hit = cast(e, visibleUnits())[0]; const r = el.getBoundingClientRect();
    el.style.cursor = hit ? 'pointer' : state.placing ? 'crosshair' : '';
    const unit = hit ? hit.object.userData.unit : null;
    if (unit === hovered) return;            // the React side re-renders only when the hovered unit changes
    hovered = unit;
    if (opts.onHover) opts.onHover(unit, { x: e.clientX - r.left, y: e.clientY - r.top });
  }
  function click(e) {
    if (state.placing) {
      const hit = cast(e, visibleUnits().concat(shells, [base]))[0];
      if (hit && opts.onPlacePin) { const u = hit.object.userData.unit; const b = hit.object.userData.building; opts.onPlacePin({ u: +hit.point.x.toFixed(2), v: +(-hit.point.z).toFixed(2), y: +hit.point.y.toFixed(2), unit: u ? u.n : '', building: u ? u.b : b ? b.id : '' }); }
      return;
    }
    const hit = cast(e, visibleUnits())[0];
    if (hit) { selectUnit(hit.object.userData.unit.n, false); return; }
    const s = cast(e, shells)[0];
    if (s) { state.selected = null; state.level = 0; restyle(); const b = s.object.userData.building; flyTo(W((b.u[0] + b.u[1]) / 2, (b.v[0] + b.v[1]) / 2, 0), 0, 0.8, Math.max(70, (b.u[1] - b.u[0]) * 0.9)); if (opts.onSelectBuilding) opts.onSelectBuilding(b); if (opts.onSelectUnit) opts.onSelectUnit(null); }
  }
  function selectUnit(name, fly = true) {
    const u = byName[name]; if (!u) return false;
    state.selected = name; const b = buildings[u.b]; if (b && b.floors > 1) state.level = u.f; restyle();
    if (fly) flyTo(W(u.u + u.wu / 2, u.v + u.dv / 2, 0), 0.15, 0.95, b ? Math.max(48, Math.min(80, (b.u[1] - b.u[0]) * 0.4)) : 70);
    if (opts.onSelectUnit) opts.onSelectUnit(u);
    return true;
  }

  // ---- loop ----
  let raf = 0; let alive = true;
  function resize() { const r = container.getBoundingClientRect(); if (!r.width || !r.height) return; renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null; if (ro) ro.observe(container); else window.addEventListener('resize', resize);
  function loop(now) { if (!alive) return; raf = requestAnimationFrame(loop); if (anim) anim(now); if (state.selected) mat.sel.emissive.setHex(0x663300).multiplyScalar(0.5 + 0.5 * Math.sin(now / 400)); renderer.render(scene, camera); }
  resize(); applyCamera(); restyle(); raf = requestAnimationFrame(loop);

  return {
    selectUnit,
    clearSelection() { state.selected = null; restyle(); if (opts.onSelectUnit) opts.onSelectUnit(null); },
    setMode(m) { state.mode = m; state.placing = false; restyle(); renderPins(); renderMarkers(); },
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
      scene.traverse((o) => { if (o !== scene) disposeObject(o); }); scene.clear();
      renderer.dispose(); if (el.parentNode) el.parentNode.removeChild(el);
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

const SIDE = { ne: 'northeast side, toward Centre City Pkwy', sw: 'southwest side, toward I-15' };

/** Step-by-step walking directions from the main gate to a unit. */
export function unitDirections(model, u) {
  const b = (model.buildings || []).find((x) => x.id === u.b); const z = (model.zones || []).find((x) => x.id === u.b);
  const steps = ['Enter through the Main Gate and check in at the office if it is your first visit.'];
  if (z) { steps.push('Drive to the ' + z.name + '.'); steps.push('Stall ' + u.n + ' is marked on the model; stalls are numbered in order along each row.'); return steps; }
  if (!b) return steps;
  steps.push('Head to ' + b.name + (b.note ? ': ' + b.note.split('.')[0].toLowerCase() + '.' : '.'));
  if (u.k === 'du' || u.k === 'ccdu') steps.push('Your door is on the outside wall, ' + (SIDE[u.door] || '') + '. Pull up to the roll-up door.');
  else if (u.n[0] === 'M') steps.push('Mailboxes are inside the lobby.');
  else steps.push('Go inside' + (u.f > 1 ? ', take the elevator or stairs to Level ' + u.f : '') + ' and follow the hallway; ' + u.n + ' is on the hallway ' + (u.door === 'ne' ? 'nearer the parkway side.' : 'nearer the freeway side.'));
  return steps;
}
