// Screenshots for Pins (contract section 6, lib/screenshot.js).
//
// ONE getDisplayMedia tab stream per mode-on (preferCurrentTab, so Chrome
// offers this tab first); a frame is grabbed from a hidden <video> onto a
// canvas whenever a pin is saved. Declining the prompt = no images; every
// other part of a pin still works. Markup is burned into both shots; redact
// rectangles are pixelated BEFORE anything is uploaded and never stored as
// pixels anywhere.
import { store } from '../store';

let stream = null;
let video = null;
let status = 'idle';          // idle | live | off | unsupported

function setStatus(s) { status = s; store.set({ capture: s }); }
export const captureStatus = () => status;
/** The live tab stream (for the recorder to clone), or null. */
export const tabStream = () => (status === 'live' ? stream : null);

// One picker at a time: a start while another is still waiting on the picker
// joins it (StrictMode runs the mount effect twice), and a stop that arrives
// while the picker is open is remembered - the stream that then resolves is
// closed at once, never attached, never 'live'.
let pending = null;
let wantStop = false;

export function startTabCapture() {
  if (status === 'live' && stream) return Promise.resolve(true);
  if (pending) { wantStop = false; return pending; }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) { setStatus('unsupported'); return Promise.resolve(false); }
  wantStop = false;
  pending = (async () => {
    let s = null;
    try {
      s = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', frameRate: 5 },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
        monitorTypeSurfaces: 'exclude',
      });
    } catch { if (!wantStop) setStatus('off'); return false; }
    if (wantStop) {
      try { s.getTracks().forEach((t) => t.stop()); } catch { /* already stopped */ }
      return false;
    }
    stream = s;
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    video.srcObject = stream;
    document.body.appendChild(video);
    try { await video.play(); } catch { /* autoplay refused - readyState still advances */ }
    const track = stream.getVideoTracks()[0];
    // The browser's own "Stop sharing" ends the track: screenshots are off from here.
    track?.addEventListener('ended', () => { if (stream === s) stopTabCapture('off'); });
    setStatus('live');
    return true;
  })().finally(() => { pending = null; });
  return pending;
}

export function stopTabCapture(next = 'idle') {
  if (pending) wantStop = true;        // the picker is still open: close its stream when it lands
  try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* already stopped */ }
  stream = null;
  try { video?.remove(); } catch { /* detached */ }
  video = null;
  setStatus(next);
}

/** The current tab frame as a canvas (frame pixels), or null when capture is not live. */
export async function grabFrame() {
  if (status !== 'live' || !video) return null;
  for (let i = 0; i < 10 && (video.readyState < 2 || !video.videoWidth); i++) await new Promise((r) => setTimeout(r, 60));
  if (!video.videoWidth) return null;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return c;
}

// Build Mode's own layers (strip, composer, outlines, markup) must not be in
// the picture: hide them for the grab, then put them back. The attribute is
// read by style.css ([data-bm-shooting] [data-nx-devnotes] { visibility: hidden }).
export async function withUiHidden(fn) {
  const root = document.documentElement;
  root.setAttribute('data-bm-shooting', '1');
  try {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 180));   // tab capture lags the paint by a frame or two
    return await fn();
  } finally {
    root.removeAttribute('data-bm-shooting');
  }
}

// ── The picture without a prompt (Oct 26 2026) ─────────────────────────────
// A pin's screenshot no longer needs the "Share this tab" prompt (Pranshu:
// people who are not technical must not have to take screenshots). The area
// around the pinned element is drawn by the browser itself from a copy of the
// DOM (modern-screenshot -> SVG foreignObject): every CSS feature Nexus uses
// renders (color-mix and all), and scrolled panes keep their scroll (the
// library's restoreScrollPosition shifts the copy's children; the live page
// is never moved).
//
// Only the AREA is copied, never the whole page: copying means reading every
// element's computed style, and on Tickets that alone takes the browser 7 s
// (5,000 elements x ~350 properties). The copy starts at the smallest
// ancestor that holds the element plus AREA_PAD on each side and leaves out
// everything below or right of the area - dropping what comes after cannot
// move what is shown; what is above stays (a pane's scroll offset counts it).
// So a DOM picture gives the element shot (with context) and no full-page
// shot; the tab stream above still gives both when the person turns on
// Higher Quality Screenshots, and is what video uses.
// shortcut: cross-origin images that refuse a fetch show blank, <video> and
// <iframe> are left out - fine for a bug picture; Higher Quality covers them.

const TAB_CAPTURE_KEY = 'nexus:build-mode:tab-capture';
export const wantsTabCapture = () => { try { return localStorage.getItem(TAB_CAPTURE_KEY) === '1'; } catch { return false; } };
export const setWantsTabCapture = (on) => { try { localStorage.setItem(TAB_CAPTURE_KEY, on ? '1' : '0'); } catch { /* storage blocked */ } };

export const AREA_PAD = 96;              // CSS px of context around the element in a DOM picture
const AREA_SHOT_TIMEOUT_MS = 8000;
const isOurs = (node) => node instanceof Element && (node.hasAttribute('data-nx-devnotes') || node.tagName === 'VIDEO' || node.tagName === 'IFRAME');

/** The element's rect grown by `pad`, clamped to the viewport (viewport CSS px). */
export function areaAround(rect, vw, vh, pad = AREA_PAD) {
  const x = Math.max(0, Math.floor(rect.x - pad)), y = Math.max(0, Math.floor(rect.y - pad));
  return { x, y, w: Math.max(1, Math.min(vw, Math.ceil(rect.x + rect.w + pad)) - x), h: Math.max(1, Math.min(vh, Math.ceil(rect.y + rect.h + pad)) - y) };
}

const holds = (r, a) => r.left <= a.x + 1 && r.top <= a.y + 1 && r.right >= a.x + a.w - 1 && r.bottom >= a.y + a.h - 1;

/** The smallest ancestor of `start` (itself included) whose box holds the area; body at worst. */
export function areaRoot(start, area) {
  for (let el = start; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (holds(el.getBoundingClientRect(), area)) return el;
  }
  return document.body;
}

/** Entirely below or right of the area: left out of the copy. */
export function beyond(node, area) {
  if (!(node instanceof Element)) return false;
  const r = node.getBoundingClientRect();
  return (r.width > 0 || r.height > 0) && (r.top >= area.y + area.h || r.left >= area.x + area.w);
}

// Rows ABOVE the area cost as much to copy as visible ones (a list scrolled
// 900px: 10 s, past the time limit). They are left out too, and the list's
// copy gets that much top padding instead, so everything after sits exactly
// where it was and the library's scroll shift still lands right. Only for
// containers that stack children in one column - removing cards from a
// multi-column grid would reflow the rest into other columns.
function stacksVertically(cs) {
  if (/^(block|flow-root|list-item|table|table-row-group)$/.test(cs.display)) return true;
  if (/flex$/.test(cs.display)) return cs.flexDirection === 'column' && cs.flexWrap === 'nowrap';
  if (/grid$/.test(cs.display)) return cs.gridAutoFlow.startsWith('row') && cs.gridTemplateColumns.trim().split(/\s+/).length === 1;
  return false;
}

function cuttableAbove(el, area) {
  if (el.getBoundingClientRect().bottom > area.y) return false;
  const cs = getComputedStyle(el);
  return cs.display === 'none' || (cs.position !== 'absolute' && cs.position !== 'fixed'
    && (cs.getPropertyValue('float') || 'none') === 'none' && cs.display !== 'contents');
}

/** The leading children of one-column containers that end above the area:
 *  { cut: Set<Element>, undo }. Each such container is tagged data-bm-pad
 *  with the height its cut children took (their first box to the first
 *  kept child), for the copy's top padding. */
export function pruneAbove(root, area) {
  const cut = new Set();
  const tagged = [];
  for (const c of [root, ...root.querySelectorAll('*')]) {
    const kids = c.children;
    if (kids.length < 2 || kids[0].getBoundingClientRect().bottom > area.y) continue;
    if (!stacksVertically(getComputedStyle(c))) continue;
    let k = 0;
    while (k < kids.length && cuttableAbove(kids[k], area)) k++;
    if (k === 0 || k === kids.length) continue;
    const first = [...kids].slice(0, k).find((n) => n.getClientRects().length);
    const shift = first ? Math.round(kids[k].getBoundingClientRect().top - first.getBoundingClientRect().top) : 0;
    if (shift <= 0) continue;
    for (let i = 0; i < k; i++) cut.add(kids[i]);
    c.setAttribute('data-bm-pad', String(shift));
    tagged.push(c);
  }
  return { cut, undo: () => tagged.forEach((n) => n.removeAttribute('data-bm-pad')) };
}

/** On the copy: a tagged container takes its cut children's height as top padding. */
export function padCopy(node) {
  const pad = node.getAttribute?.('data-bm-pad');
  if (!pad) return;
  node.style.paddingTop = `calc(${node.style.paddingTop || '0px'} + ${pad}px)`;
  node.removeAttribute('data-bm-pad');
}

function opaqueBackground(el) {
  for (let n = el; n; n = n.parentElement) {
    const c = getComputedStyle(n).backgroundColor;
    if (c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c)) return c;
  }
  return '#ffffff';
}

/** The page's own element under the area's centre (our overlay is on top of it). */
function pageElementAt(area) {
  const pts = document.elementsFromPoint(area.x + area.w / 2, area.y + area.h / 2);
  return pts.find((n) => !n.closest('[data-nx-devnotes]')) || document.body;
}

/**
 * The area around `rect` (viewport CSS px) drawn from the DOM into a
 * viewport-sized canvas (device px, at most 2x) at its place - blank
 * elsewhere, so makeShots crops it like a tab frame. `el` = the picked
 * element (null for a dragged region). Null on failure or after 8 s.
 */
export async function grabAreaFrame(el, rect) {
  if (typeof document === 'undefined' || !rect) return null;
  const run = async () => {
    const { domToCanvas } = await import('modern-screenshot');
    const vw = window.innerWidth, vh = window.innerHeight;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const area = areaAround(rect, vw, vh);
    const start = el && el.isConnected && !isOurs(el) && !el.closest('[data-nx-devnotes]') ? el : pageElementAt(area);
    const root = areaRoot(start, area);
    const rr = root.getBoundingClientRect();
    const { cut, undo } = pruneAbove(root, area);
    let pic;
    try {
      pic = await domToCanvas(root, {
        scale,
        // Off by default in the library: without it a scrolled list is drawn from its top (wrong rows).
        features: { restoreScrollPosition: true },
        filter: (node) => !isOurs(node) && !cut.has(node) && !beyond(node, area),
        onCloneEachNode: padCopy,
        backgroundColor: opaqueBackground(root),
        timeout: AREA_SHOT_TIMEOUT_MS - 1000,
      });
    } finally { undo(); }
    const k = rr.width ? pic.width / rr.width : scale;     // the copy's own px per CSS px
    const frame = document.createElement('canvas');
    frame.width = Math.round(vw * scale); frame.height = Math.round(vh * scale);
    frame.getContext('2d').drawImage(pic, (area.x - rr.left) * k, (area.y - rr.top) * k, area.w * k, area.h * k,
      area.x * scale, area.y * scale, area.w * scale, area.h * scale);
    return frame;
  };
  try {
    return await Promise.race([run(), new Promise((r) => setTimeout(() => r(null), AREA_SHOT_TIMEOUT_MS))]);
  } catch { return null; }
}

/** The best picture there is: the shared tab when it is live (whole page),
 *  else the DOM picture of the area. `whole` = a full-page shot is possible. */
export async function grabBestFrame(el, rect) {
  if (status === 'live') {
    const f = await withUiHidden(() => grabFrame());
    if (f) return { frame: f, whole: true };
  }
  return { frame: await grabAreaFrame(el, rect), whole: false };
}

// ── Pure geometry and drawing (tested in screenshot.test.js) ────────────────

/** Frame pixels per viewport CSS pixel on each axis. */
export function frameScale(frameW, frameH, vpW, vpH) {
  return { sx: vpW ? frameW / vpW : 1, sy: vpH ? frameH / vpH : 1 };
}

/** The crop box (frame px) for a viewport rect with padding, clamped to the frame. */
export function cropRect(rect, scale, frame, pad = 24) {
  const x0 = Math.max(0, Math.floor((rect.x - pad) * scale.sx));
  const y0 = Math.max(0, Math.floor((rect.y - pad) * scale.sy));
  const x1 = Math.min(frame.w, Math.ceil((rect.x + rect.w + pad) * scale.sx));
  const y1 = Math.min(frame.h, Math.ceil((rect.y + rect.h + pad) * scale.sy));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

const sxy = (p, s, o) => ({ x: (p.x + (o?.dx || 0)) * s.sx, y: (p.y + (o?.dy || 0)) * s.sy });

/** Markup items moved by (dx, dy) - PAGE coordinates (how they are stored) to viewport ones at capture is shiftItems(items, -scrollX, -scrollY). */
export function shiftItems(items, dx, dy) {
  return (items || []).map((it) => {
    if (!it) return it;
    if (it.type === 'arrow') return { ...it, x1: it.x1 + dx, y1: it.y1 + dy, x2: it.x2 + dx, y2: it.y2 + dy };
    if (it.type === 'path') return { ...it, points: (it.points || []).map(([x, y]) => [x + dx, y + dy]) };
    return { ...it, x: it.x + dx, y: it.y + dy };
  });
}

/** Pixelate every redact rectangle in place (frame px) - the only trace left of what was under it. */
export function applyRedactions(ctx, canvas, items, scale, offset) {
  const redacts = (items || []).filter((i) => i.type === 'redact' && i.w > 0 && i.h > 0);
  if (!redacts.length) return 0;
  const block = Math.max(8, Math.round(12 * ((scale.sx + scale.sy) / 2)));
  for (const it of redacts) {
    const p = sxy(it, scale, offset);
    const x = Math.max(0, Math.floor(p.x)), y = Math.max(0, Math.floor(p.y));
    const w = Math.min(canvas.width - x, Math.ceil(it.w * scale.sx)), h = Math.min(canvas.height - y, Math.ceil(it.h * scale.sy));
    if (w <= 0 || h <= 0) continue;
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(w / block));
    small.height = Math.max(1, Math.round(h / block));
    const sctx = small.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(canvas, x, y, w, h, 0, 0, small.width, small.height);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(x, y, w, h);
    ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
    ctx.fillStyle = 'rgba(15,23,42,0.35)';
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
  return redacts.length;
}

/** Draw the markup items onto a frame-pixel context. `offset` shifts viewport coordinates first (dx, dy in CSS px). */
export function burnMarkup(ctx, items, scale = { sx: 1, sy: 1 }, offset = { dx: 0, dy: 0 }) {
  let drawn = 0;
  const lw = (w) => Math.max(1, (w || 3) * ((scale.sx + scale.sy) / 2));
  for (const it of items || []) {
    if (!it || it.type === 'redact') continue;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = it.color || '#ef4444';
    ctx.fillStyle = it.color || '#ef4444';
    ctx.lineWidth = lw(it.width);
    if (it.type === 'rect') {
      const p = sxy(it, scale, offset);
      ctx.strokeRect(p.x, p.y, it.w * scale.sx, it.h * scale.sy);
      drawn++;
    } else if (it.type === 'highlight') {
      const p = sxy(it, scale, offset);
      ctx.globalAlpha = 0.35;
      ctx.fillRect(p.x, p.y, it.w * scale.sx, it.h * scale.sy);
      drawn++;
    } else if (it.type === 'arrow') {
      const a = sxy({ x: it.x1, y: it.y1 }, scale, offset);
      const b = sxy({ x: it.x2, y: it.y2 }, scale, offset);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const head = 6 * ctx.lineWidth;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(ang - Math.PI / 7), b.y - head * Math.sin(ang - Math.PI / 7));
      ctx.lineTo(b.x - head * Math.cos(ang + Math.PI / 7), b.y - head * Math.sin(ang + Math.PI / 7));
      ctx.closePath(); ctx.fill();
      drawn++;
    } else if (it.type === 'path' && Array.isArray(it.points) && it.points.length) {
      ctx.beginPath();
      it.points.forEach(([x, y], i) => { const p = sxy({ x, y }, scale, offset); if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      ctx.stroke();
      drawn++;
    } else if (it.type === 'text' && it.text) {
      const p = sxy(it, scale, offset);
      const size = (it.size || 16) * scale.sy;
      ctx.font = `700 ${size}px Inter, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.lineWidth = Math.max(2, size / 5);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeText(it.text, p.x, p.y);
      ctx.fillStyle = it.color || '#111827';
      ctx.fillText(it.text, p.x, p.y);
      drawn++;
    }
    ctx.restore();
  }
  return drawn;
}

const toBlob = (canvas, type = 'image/png') => new Promise((resolve) => {
  if (!canvas.toBlob) { resolve(null); return; }
  canvas.toBlob((b) => resolve(b), type, 0.92);
});

/**
 * The two shots of a pin: the whole viewport and the target crop, both with
 * redactions applied and the markup burned in. `frame` is the grabbed canvas;
 * `rect` the target rect in viewport CSS px; `vp` = { w, h } of the viewport.
 * Returns { page: Blob|null, element: Blob|null }.
 */
/** Opaque black over every sensitive field (password, card, SSN...) - before markup, before upload. */
export function paintBoxes(ctx, boxes, scale) {
  let n = 0;
  for (const b of boxes || []) {
    if (!(b.w > 0 && b.h > 0)) continue;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(Math.floor(b.x * scale.sx) - 1, Math.floor(b.y * scale.sy) - 1, Math.ceil(b.w * scale.sx) + 2, Math.ceil(b.h * scale.sy) + 2);
    ctx.restore();
    n++;
  }
  return n;
}

export async function makeShots({ frame, rect, markup, vp, boxes = [], whole = true, pad = 24 }) {
  if (!frame) return { page: null, element: null };
  const scale = frameScale(frame.width, frame.height, vp.w, vp.h);
  const page = document.createElement('canvas');
  page.width = frame.width; page.height = frame.height;
  const ctx = page.getContext('2d');
  ctx.drawImage(frame, 0, 0);
  const items = markup?.items || [];
  paintBoxes(ctx, boxes, scale);
  applyRedactions(ctx, page, items, scale);
  burnMarkup(ctx, items, scale);
  let element = null;
  if (rect && rect.w > 0 && rect.h > 0) {
    const c = cropRect(rect, scale, { w: page.width, h: page.height }, pad);
    const el = document.createElement('canvas');
    el.width = c.w; el.height = c.h;
    el.getContext('2d').drawImage(page, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
    element = await toBlob(el);
  }
  // A DOM picture holds only the area around the element: no page shot from it.
  return { page: whole ? await toBlob(page) : null, element };
}

/** A small copy of a frame (for the contact sheet). */
export function thumbnail(frame, width = 320) {
  const ratio = frame.height / frame.width;
  const c = document.createElement('canvas');
  c.width = width; c.height = Math.round(width * ratio);
  c.getContext('2d').drawImage(frame, 0, 0, c.width, c.height);
  return c;
}
