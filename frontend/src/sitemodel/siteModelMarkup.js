// Mark an Issue on the Map (Charmi, Oct 20 2026): "go to the map and
// physically mark it out saying fix right here". The drawing half of the
// site model viewer, kept apart from siteModelViewer.js, which only forwards
// its pointer events here while marking is on.
//
// Visesh, Oct 20 2026: "a chalkout should be just like a pen draw or pencil
// draw ... the circle has to draw from the cursor". So marks are INK, not 3D
// shapes: a 2D canvas laid over the map draws every mark as a thin line
// (round caps and joins, lightly smoothed), re-projected from the ground each
// frame so it stays put as the map moves. Nothing is extruded or raised.
//
//   pen (default)   follows the pointer exactly while drawing; stored as points
//                   on the ground; closed when its ends meet, open otherwise
//   circle          press and cursor are opposite ends of the diameter, so the
//                   edge stays under the cursor
//   pin / a click   a point (r = 0)
//   two fingers     still move the map (a second finger cancels the stroke)
import * as THREE from 'three';

const INK = '#c43d2f'; const INK_HOT = '#9f1d14';
const LINE_PX = 3;

/** The finished stroke as a mark: center, radius and (pen) outline, in ground meters. */
export function finishStroke(start, pts, tool) {
  if (tool === 'pen' && pts.length > 2) {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    pts.forEach(([u, v]) => { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); });
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const r = Math.max(...pts.map(([u, v]) => Math.hypot(u - cu, v - cv)));
    if (r >= 0.75) {
      // Thin to at most 200 points (the server's limit), keeping the last one.
      const step = Math.ceil(pts.length / 199);
      const kept = pts.filter((_, i) => i % step === 0);
      if (kept[kept.length - 1] !== pts[pts.length - 1]) kept.push(pts[pts.length - 1]);
      return { u: +cu.toFixed(2), v: +cv.toFixed(2), r: +r.toFixed(2), outline: kept.map(([u, v]) => [+u.toFixed(2), +v.toFixed(2)]) };
    }
  }
  if (tool === 'circle') {
    const end = pts[pts.length - 1] || [start.u, start.v];
    const d = Math.hypot(end[0] - start.u, end[1] - start.v);
    if (d >= 1) return { u: +((start.u + end[0]) / 2).toFixed(2), v: +((start.v + end[1]) / 2).toFixed(2), r: +(d / 2).toFixed(2), outline: [] };
  }
  return { u: start.u, v: start.v, r: 0, outline: [] };
}

/** Does a pen outline close on itself (its ends meet)? */
export function isClosed(outline) {
  if (!outline || outline.length < 3) return false;
  let len = 0; for (let i = 1; i < outline.length; i++) len += Math.hypot(outline[i][0] - outline[i - 1][0], outline[i][1] - outline[i - 1][1]);
  const a = outline[0], b = outline[outline.length - 1];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= Math.max(1.5, len * 0.12);
}

/** A smooth path through screen points: straight to the first midpoint, then curves through each point. */
function inkPath(x, p, closed) {
  x.beginPath(); if (!p.length) return;
  x.moveTo(p[0][0], p[0][1]);
  if (p.length < 3) { p.slice(1).forEach((q) => x.lineTo(q[0], q[1])); if (closed) x.closePath(); return; }
  for (let i = 1; i < p.length - 1; i++) { const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2; x.quadraticCurveTo(p[i][0], p[i][1], mx, my); }
  x.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
  if (closed) x.closePath();
}

export function createMarkup({ scene, camera, el, start: pickStart, rayFor, onMark }) {
  const spotGroup = new THREE.Group(); scene.add(spotGroup);
  let tool = null; let stroke = null; let draft = null; let spots = []; const badges = [];
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); const hitPt = new THREE.Vector3(); const pv = new THREE.Vector3();
  // The ink layer: a 2D canvas over the WebGL one, never in the way of the pointer.
  const ink = document.createElement('canvas');
  ink.className = 'sm-ink'; ink.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1';
  if (el.parentNode) el.parentNode.insertBefore(ink, el.nextSibling);
  const clearSpots = () => { while (spotGroup.children.length) { const c = spotGroup.children[0]; spotGroup.remove(c); if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); } } };
  function groundAt(e) {
    const ray = rayFor(e); if (!ray || !ray.intersectPlane(plane, hitPt)) return null;
    return [hitPt.x, -hitPt.z];
  }
  function down(e) {
    if (!tool || e.button !== 0 || !e.isPrimary) return false;
    const s = pickStart(e); if (!s) return false;
    // Marks lie on the ground: the press keeps the unit or building it landed on,
    // but its point is where the ray meets the ground, never a roof.
    const g = groundAt(e) || [s.u, s.v];
    const r = el.getBoundingClientRect();
    stroke = { id: e.pointerId, start: { ...s, u: +g[0].toFixed(2), v: +g[1].toFixed(2), y: 0 }, pts: [g], screen: [[e.clientX - r.left, e.clientY - r.top]], sx: e.clientX, sy: e.clientY, moved: false };
    draft = null; return true;
  }
  function move(e) {
    if (!stroke || e.pointerId !== stroke.id) return false;
    if (Math.hypot(e.clientX - stroke.sx, e.clientY - stroke.sy) > 6) stroke.moved = true;
    const r = el.getBoundingClientRect(); const sp = [e.clientX - r.left, e.clientY - r.top];
    const lastS = stroke.screen[stroke.screen.length - 1];
    if (Math.hypot(sp[0] - lastS[0], sp[1] - lastS[1]) >= 1.5) stroke.screen.push(sp);
    const p = groundAt(e); if (!p) return true;
    const last = stroke.pts[stroke.pts.length - 1];
    if (tool === 'circle') stroke.pts = [stroke.pts[0], p];
    else if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.15) stroke.pts.push(p);
    return true;
  }
  function up(e) {
    if (!stroke || e.pointerId !== stroke.id) return false;
    move(e);   // the release point counts, even when no move event came before it
    const s = stroke.start;
    const m = stroke.moved && tool !== 'pin' ? finishStroke(s, stroke.pts, tool) : { u: s.u, v: s.v, r: 0, outline: [] };
    stroke = null;
    draft = { ...m, y: 0, unit: s.unit || '', building: s.building || '' };
    if (onMark) onMark(draft);
    return true;
  }
  function cancelStroke() { stroke = null; }

  // ---- painting the ink, every frame ----
  function toScreen(u, v, w, h) {
    pv.set(u, 0, -v).project(camera);
    if (pv.z > 1 || pv.z < -1) return null;
    return [(pv.x + 1) / 2 * w, (1 - pv.y) / 2 * h];
  }
  function paintMark(x, m, w, h, color, width) {
    let pts; let closed;
    if (m.outline && m.outline.length > 2) { pts = m.outline; closed = isClosed(m.outline); }
    else if (m.r > 0) { pts = Array.from({ length: 72 }, (_, i) => [m.u + m.r * Math.cos(i / 72 * Math.PI * 2), m.v + m.r * Math.sin(i / 72 * Math.PI * 2)]); closed = true; }
    else {   // a pin: a small ring on the ground
      const c = toScreen(m.u, m.v, w, h); if (!c) return;
      x.beginPath(); x.arc(c[0], c[1], 7, 0, Math.PI * 2); x.fillStyle = 'rgba(196,61,47,0.12)'; x.fill(); x.lineWidth = width; x.strokeStyle = color; x.stroke();
      return;
    }
    const sp = pts.map(([u, v]) => toScreen(u, v, w, h)); if (sp.some((q) => !q)) return;
    inkPath(x, sp, closed);
    if (closed) { x.fillStyle = 'rgba(196,61,47,0.07)'; x.fill(); }
    x.lineWidth = width; x.strokeStyle = color; x.stroke();
  }
  function paint() {
    const dpr = window.devicePixelRatio || 1; const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    if (ink.width !== Math.round(w * dpr) || ink.height !== Math.round(h * dpr)) { ink.width = Math.round(w * dpr); ink.height = Math.round(h * dpr); }
    const x = ink.getContext('2d'); if (!x) return;
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
    x.lineCap = 'round'; x.lineJoin = 'round';
    spots.forEach((s) => paintMark(x, s, w, h, s.priority === 'urgent' || s.priority === 'high' ? INK_HOT : INK, 2.5));
    if (stroke && stroke.moved && tool === 'pen') {
      // Exactly where the pointer went: the screen points as drawn.
      inkPath(x, stroke.screen, false); x.lineWidth = LINE_PX; x.strokeStyle = INK; x.stroke();
    } else if (stroke && stroke.moved && tool === 'circle' && stroke.pts.length > 1) {
      const m = finishStroke(stroke.start, stroke.pts, 'circle'); if (m.r > 0) paintMark(x, m, w, h, INK, LINE_PX);
    } else if (draft) paintMark(x, draft, w, h, INK, LINE_PX);
  }

  // ---- open tickets' spots: a badge to hover and click (the ink draws their shape) ----
  function badge(spot) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64; const x = cv.getContext('2d');
    const hot = spot.priority === 'urgent' || spot.priority === 'high';
    x.beginPath(); x.arc(32, 32, 29, 0, Math.PI * 2); x.fillStyle = '#fff'; x.fill();
    x.beginPath(); x.arc(32, 32, 24, 0, Math.PI * 2); x.fillStyle = hot ? INK_HOT : INK; x.fill();
    // a "fix here" target - a white ring and dot - reads at any size
    x.strokeStyle = '#fff'; x.lineWidth = 5; x.beginPath(); x.arc(32, 32, 10, 0, Math.PI * 2); x.stroke();
    x.fillStyle = '#fff'; x.beginPath(); x.arc(32, 32, 4, 0, Math.PI * 2); x.fill();
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, sizeAttenuation: false, toneMapped: false }));
    sp.renderOrder = 13; sp.center.set(0.5, 0.15);
    const k = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / (el.clientHeight || 1); sp.scale.set(24 * k, 24 * k, 1);
    sp.position.set(spot.u, 0.5, -spot.v); sp.userData.spot = spot;
    return sp;
  }
  function setSpots(list) {
    clearSpots(); badges.length = 0; spots = list || [];
    spots.forEach((s) => { const b = badge(s); spotGroup.add(b); badges.push(b); });
  }

  return {
    down, move, up, cancelStroke, setSpots, paint, ink,
    /** null = off; 'pen' | 'circle' | 'pin' = marking with that tool. */
    setShape(v) { tool = v || null; if (!tool) stroke = null; },
    active() { return !!tool; },
    drawing() { return !!stroke; },
    clearDraft() { stroke = null; draft = null; },
    badges,
    dispose() { clearSpots(); scene.remove(spotGroup); if (ink.parentNode) ink.parentNode.removeChild(ink); },
  };
}
