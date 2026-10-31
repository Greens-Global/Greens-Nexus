// The canvas viewport math (Blueprint, 10/30/2026). Pure: a view is
// { x, y, s } - the sheet's offset inside the visible box, in screen pixels,
// and its scale. The box is the sheet element's DOMRect ({ left, top,
// width, height }). Nothing here reads the DOM, so the drag, zoom and fit
// rules are tested without a browser.

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2;
export const ZOOM_STEP = 1.2;

export const clampZoom = (s) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s));

/** Zoom by `factor` keeping the sheet point under (px, py) (box-relative) still. */
export function zoomAt(view, factor, px, py) {
  const ns = clampZoom(view.s * factor);
  const k = ns / view.s;
  return { s: ns, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

/** The whole sheet (w x h) inside the box, never above 100%. */
export function fitView(sheet, box, pad = 40) {
  if (!box || !box.width || !box.height || !sheet || !sheet.w || !sheet.h) return { x: 0, y: 0, s: 1 };
  const s = clampZoom(Math.min((box.width - pad) / sheet.w, (box.height - pad) / sheet.h, 1));
  return { s, x: (box.width - sheet.w * s) / 2, y: Math.max(20, (box.height - sheet.h * s) / 2) };
}

/**
 * Where the canvas opens: reading size, the trigger's column centered at the
 * top of the box (Fit shows the whole sheet on request). With no box (jsdom,
 * a hidden tab) the identity view.
 */
export function openingView(sheet, box, trigger, scale = 0.85) {
  if (!box || !box.width || !trigger) return { x: 0, y: 0, s: 1 };
  const s = clampZoom(scale);
  const cx = trigger.x + trigger.w / 2;
  return { s, x: box.width / 2 - cx * s, y: 28 - (trigger.y - 60) * s };
}

/** A screen point to sheet pixels. */
export function toWorld(view, box, cx, cy) {
  return { x: (cx - (box?.left || 0) - view.x) / view.s, y: (cy - (box?.top || 0) - view.y) / view.s };
}

/** A sheet point to screen pixels. */
export function toScreen(view, box, wx, wy) {
  return { x: (box?.left || 0) + view.x + wx * view.s, y: (box?.top || 0) + view.y + wy * view.s };
}

/** Pan by a screen delta. */
export function panBy(view, dx, dy) {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

/** The grid background's size and position for a view (24px minor, 120px major squares). */
export function gridStyle(view) {
  const g = 24 * view.s; const G = 120 * view.s;
  return { backgroundSize: `${G}px ${G}px, ${G}px ${G}px, ${g}px ${g}px, ${g}px ${g}px`, backgroundPosition: `${view.x}px ${view.y}px` };
}
