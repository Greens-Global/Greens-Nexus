// Mark an Issue on the Map (Charmi, Oct 20 2026): "go to the map and
// physically mark it out saying fix right here". The drawing half of the
// site model viewer, kept apart from siteModelViewer.js, which only forwards
// its pointer events here while marking is on.
//
//   click / tap          a point (r = 0)
//   drag                 a circle from where the drag started (its center)
//   drag, Outline shape  a free-hand outline; its center and radius are worked out
//   two fingers          still move the map (a second finger cancels the stroke)
//
// While drawing, a translucent amber disc (or fill) with a crisp darker edge.
// The finished mark stays on the map until clearDraft(). Open tickets' spots
// (setSpots) draw the same way, lighter, with a badge to hover and click.
import * as THREE from 'three';

const AMBER = 0xf59e0b; const EDGE = 0xb45309; const RED = 0xc43d2f;
const LIFT = 0.25;   // over the surface, so the fill never fights the ground

function ringGeo(r) { const w = Math.max(0.22, Math.min(1.2, r * 0.05)); return new THREE.RingGeometry(Math.max(0.01, r - w), r, 96); }
function flat(geo, material) { const m = new THREE.Mesh(geo, material); m.rotation.x = -Math.PI / 2; m.renderOrder = 9; return m; }
const fillMat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });

/** A mark as a Group: the disc or outline fill plus its edge, in the model's u / v frame. */
export function markShape(m, { fill = AMBER, edge = EDGE, opacity = 0.3 } = {}) {
  const g = new THREE.Group(); const y = (m.y || 0) + LIFT;
  const pts = m.outline && m.outline.length > 2 ? m.outline : null;
  if (pts) {
    // Shape points (u, v) land on world (u, -v) once the mesh is laid flat.
    const shape = new THREE.Shape(pts.map(([u, v]) => new THREE.Vector2(u, v)));
    const f = flat(new THREE.ShapeGeometry(shape), fillMat(fill, opacity)); f.position.y = y; g.add(f);
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts.map(([u, v]) => new THREE.Vector3(u, y + 0.02, -v))),
      new THREE.LineBasicMaterial({ color: edge, depthTest: false, transparent: true, toneMapped: false }));
    line.renderOrder = 10; g.add(line);
    return g;
  }
  const r = Math.max(1.2, m.r || 0);
  const d = flat(new THREE.CircleGeometry(r, 64), fillMat(fill, opacity)); d.position.set(m.u, y, -m.v); g.add(d);
  const e = flat(ringGeo(r), fillMat(edge, 0.95)); e.position.set(m.u, y + 0.02, -m.v); e.renderOrder = 10; g.add(e);
  return g;
}

/** The finished stroke as a mark: center, radius and (free-hand) outline. */
export function finishStroke(start, pts, shape) {
  if (shape === 'free' && pts.length > 2) {
    let su = 0, sv = 0; pts.forEach(([u, v]) => { su += u; sv += v; });
    const cu = su / pts.length, cv = sv / pts.length;
    const r = Math.max(...pts.map(([u, v]) => Math.hypot(u - cu, v - cv)));
    if (r >= 1) {
      // Thin to at most 200 points (the server's limit), keeping the shape.
      const step = Math.ceil(pts.length / 200);
      const outline = pts.filter((_, i) => i % step === 0).map(([u, v]) => [+u.toFixed(2), +v.toFixed(2)]);
      return { u: +cu.toFixed(2), v: +cv.toFixed(2), r: +r.toFixed(2), outline };
    }
  }
  const end = pts[pts.length - 1] || [start.u, start.v];
  const r = Math.hypot(end[0] - start.u, end[1] - start.v);
  return { u: start.u, v: start.v, r: r >= 1 ? +r.toFixed(2) : 0, outline: [] };
}

export function createMarkup({ scene, camera, el, start: pickStart, rayFor, onMark }) {
  const draftGroup = new THREE.Group(); const spotGroup = new THREE.Group(); scene.add(draftGroup); scene.add(spotGroup);
  let shape = null; let stroke = null; const badges = [];
  const plane = new THREE.Plane(); const hitPt = new THREE.Vector3();
  const clear = (g) => { while (g.children.length) { const c = g.children[0]; g.remove(c); c.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); } };
  const draw = (m) => { clear(draftGroup); draftGroup.add(markShape(m)); };
  function groundAt(e) {
    const ray = rayFor(e); if (!ray || !ray.intersectPlane(plane, hitPt)) return null;
    return [hitPt.x, -hitPt.z];
  }
  function down(e) {
    if (!shape || e.button !== 0 || !e.isPrimary) return false;
    const s = pickStart(e); if (!s) return false;
    plane.set(new THREE.Vector3(0, 1, 0), -s.y);
    stroke = { id: e.pointerId, start: s, pts: [[s.u, s.v]], sx: e.clientX, sy: e.clientY, moved: false };
    clear(draftGroup); return true;
  }
  function move(e) {
    if (!stroke || e.pointerId !== stroke.id) return false;
    if (Math.hypot(e.clientX - stroke.sx, e.clientY - stroke.sy) > 6) stroke.moved = true;
    const p = groundAt(e); if (!p) return true;
    const last = stroke.pts[stroke.pts.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.35) stroke.pts.push(p);
    if (stroke.moved) {
      const s = stroke.start;
      draw(shape === 'free' ? { y: s.y, outline: stroke.pts, u: s.u, v: s.v } : { y: s.y, u: s.u, v: s.v, r: Math.hypot(p[0] - s.u, p[1] - s.v) });
    }
    return true;
  }
  function up(e) {
    if (!stroke || e.pointerId !== stroke.id) return false;
    move(e);   // the release point counts, even when no move event came before it
    const s = stroke.start; const m = stroke.moved ? finishStroke(s, stroke.pts, shape) : { u: s.u, v: s.v, r: 0, outline: [] };
    stroke = null;
    const mark = { ...m, y: s.y, unit: s.unit || '', building: s.building || '' };
    draw(mark);
    if (onMark) onMark(mark);
    return true;
  }
  function cancelStroke() { if (stroke) { stroke = null; clear(draftGroup); } }

  // ---- open tickets' spots ----
  function badge(spot) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64; const x = cv.getContext('2d');
    const hot = spot.priority === 'urgent' || spot.priority === 'high';
    x.beginPath(); x.arc(32, 32, 29, 0, Math.PI * 2); x.fillStyle = '#fff'; x.fill();
    x.beginPath(); x.arc(32, 32, 24, 0, Math.PI * 2); x.fillStyle = hot ? '#c43d2f' : '#d97706'; x.fill();
    // a "fix here" target - a white ring and dot - reads at any size
    x.strokeStyle = '#fff'; x.lineWidth = 5; x.beginPath(); x.arc(32, 32, 10, 0, Math.PI * 2); x.stroke();
    x.fillStyle = '#fff'; x.beginPath(); x.arc(32, 32, 4, 0, Math.PI * 2); x.fill();
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, sizeAttenuation: false, toneMapped: false }));
    sp.renderOrder = 13; sp.center.set(0.5, 0.15);
    const k = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / (el.clientHeight || 1); sp.scale.set(26 * k, 26 * k, 1);
    sp.position.set(spot.u, (spot.y || 0) + 1, -spot.v); sp.userData.spot = spot;
    return sp;
  }
  function setSpots(list) {
    clear(spotGroup); badges.length = 0;
    (list || []).forEach((s) => {
      const hot = s.priority === 'urgent' || s.priority === 'high';
      if (s.r > 0 || (s.outline && s.outline.length > 2)) spotGroup.add(markShape(s, { fill: hot ? RED : AMBER, edge: hot ? 0x8f2318 : EDGE, opacity: 0.2 }));
      const b = badge(s); spotGroup.add(b); badges.push(b);
    });
  }

  return {
    down, move, up, cancelStroke, setSpots,
    /** null = off; 'circle' | 'free' = marking with that shape. */
    setShape(v) { shape = v || null; if (!shape) stroke = null; },
    active() { return !!shape; },
    drawing() { return !!stroke; },
    clearDraft() { stroke = null; clear(draftGroup); },
    badges,
    dispose() { clear(draftGroup); clear(spotGroup); scene.remove(draftGroup); scene.remove(spotGroup); },
  };
}
