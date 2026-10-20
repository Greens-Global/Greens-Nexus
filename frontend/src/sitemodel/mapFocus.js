// Mark an Issue on the Map (Oct 20 2026): a ticket's Open on Map hands its
// spot to the site map it opens, and the words for a spot's shape. Tiny on
// purpose: the ticket drawer and the ticket form import it.

// ── Open on Map: a ticket's spot, waiting for its site map to open ──────────
let pending = null;
export const FOCUS_EVENT = 'nexus:map-spot-focus';

/** Remember the spot and tell a site map already on screen to fly to it. */
export function requestMapFocus(spot) {
  pending = spot ? { ...spot } : null;
  if (spot) window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: pending }));
}

/** The waiting spot if it is on this model, left waiting (a viewer that is
 *  torn down straight away - React's dev double mount - must not use it up). */
export function peekMapFocus(modelId) {
  return pending && modelId && pending.modelId === modelId ? pending : null;
}

/** The waiting spot if it is on this model (taken once), else null. */
export function takeMapFocus(modelId) {
  if (!pending || !modelId || pending.modelId !== modelId) return null;
  const s = pending; pending = null; return s;
}

/** "Circle, about 40 ft across" / "Drawn with the pen" / "Pin". */
export function shapeWord(spot) {
  if (spot?.outline?.length > 2) return 'Drawn with the pen';
  if (spot?.r > 0) return `Circle, about ${Math.max(1, Math.round(spot.r * 2 * 3.281))} ft across`;
  return 'Pin';
}
