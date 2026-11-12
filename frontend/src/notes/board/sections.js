// Sections on a Board (Neil, 11/12/2026): a section is the engine's frame -
// named, and whatever sits on it moves with it - brought up to the main bar
// and made the ONE way a board groups things. Templates already lay out
// named frames and Present already reads one slide per frame; from here Sort
// puts stickies INTO sections (stickies.js), a new sticky lands in the
// section under it, and Wrap Up reads each section as a heading (wrapUp.js).
// Engine-free: plain elements, like a sticky or a comment pin.
//
// What makes something a member of a section is its `frameId` - the engine
// moves members with their frame and clips them to it. A thing drawn before
// this (a sticky tapped onto a template's column) carries no frameId, so the
// readers here also count what sits INSIDE a section's box.

const live = (els) => (els || []).filter((e) => e && !e.isDeleted);
export const isSection = (e) => !!e && !e.isDeleted && e.type === 'frame';
const centerOf = (e) => ({ x: e.x + (e.width || 0) / 2, y: e.y + (e.height || 0) / 2 });
const holds = (f, p) => p.x >= f.x && p.x <= f.x + f.width && p.y >= f.y && p.y <= f.y + f.height;

/** The live sections, in reading order (as Present reads them - scene.js presentSlides). */
export function sections(elements) {
  const frames = live(elements).filter(isSection).sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const rows = [];
  for (const f of frames) {
    const row = rows[rows.length - 1];
    if (row && f.y - row[0].y < Math.max(1, row[0].height) / 2) row.push(f); else rows.push([f]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x));
}

/** The section a board point is in: the last-drawn one holding it, else ''. */
export function sectionAt(elements, point) {
  const hit = live(elements).filter((e) => isSection(e) && holds(e, point));
  return hit.length ? hit[hit.length - 1].id : '';
}

/** Which section an element belongs to: its frame, else the section its
 *  middle sits in (a thing placed before sections carried their members). */
export function sectionOf(elements, e, frames = null) {
  const all = frames || live(elements).filter(isSection);
  if (e.frameId && all.some((f) => f.id === e.frameId)) return e.frameId;
  const c = centerOf(e);
  const hit = all.filter((f) => f.id !== e.id && holds(f, c));
  return hit.length ? hit[hit.length - 1].id : '';
}

export const sectionName = (f) => String(f?.name || '').trim() || 'Section';

const EDGE = 12;   // how far inside a section's edge a new thing lands

/**
 * Where a new box (a sticky) lands when it is put at (x, y): inside the
 * section under its middle, moved in from the edge so the section never cuts
 * it off (the engine clips what a section holds - seen in a real browser: a
 * sticky tapped near an edge joined the section and lost its side). A
 * section too small to hold it does not take it. Returns { x, y, frameId }.
 */
export function placeInSection(elements, { x, y, width, height }) {
  const id = sectionAt(elements, { x: x + width / 2, y: y + height / 2 });
  const f = id ? (elements || []).find((e) => e.id === id) : null;
  if (!f || f.width < width + EDGE * 2 || f.height < height + EDGE * 2) return { x, y, frameId: null };
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  return {
    x: clamp(x, f.x + EDGE, f.x + f.width - width - EDGE),
    y: clamp(y, f.y + EDGE, f.y + f.height - height - EDGE),
    frameId: f.id,
  };
}
