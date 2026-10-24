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

export async function startTabCapture() {
  if (status === 'live' && stream) return true;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) { setStatus('unsupported'); return false; }
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: 5 },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
      monitorTypeSurfaces: 'exclude',
    });
  } catch { stream = null; setStatus('off'); return false; }
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
  track?.addEventListener('ended', () => stopTabCapture('off'));
  setStatus('live');
  return true;
}

export function stopTabCapture(next = 'idle') {
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

export async function makeShots({ frame, rect, markup, vp, boxes = [] }) {
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
    const c = cropRect(rect, scale, { w: page.width, h: page.height });
    const el = document.createElement('canvas');
    el.width = c.w; el.height = c.h;
    el.getContext('2d').drawImage(page, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
    element = await toBlob(el);
  }
  return { page: await toBlob(page), element };
}

/** A small copy of a frame (for the contact sheet). */
export function thumbnail(frame, width = 320) {
  const ratio = frame.height / frame.width;
  const c = document.createElement('canvas');
  c.width = width; c.height = Math.round(width * ratio);
  c.getContext('2d').drawImage(frame, 0, 0, c.width, c.height);
  return c;
}
