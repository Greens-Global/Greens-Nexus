// The type scale (Neil, 11/12/2026). Every text size in Nexus is one of
// these - the code had 43 different inline sizes, half a pixel apart in
// places (12 / 12.5 / 13 / 13.5), which reads as noise, not hierarchy.
//
// In JSX:  style={{ fontSize: FS.body }}      In CSS:  font-size: var(--fs-body);
// (the --fs-* tokens in style.css carry the same numbers).
//
// `npm run lint` runs scripts/check-type.mjs, which fails a NEW size that is
// not on this scale; code written before the scale is in its baseline and may
// only go down. Old screens move over ONE MODULE AT A TIME, each looked at by
// a person (Neil, 11/12/2026) - SNAP says where an old size lands.
//
// A size that must stay off the scale (the 16px phone form fields that stop
// iOS zooming the page, a wall clock, a hero number) carries `type-ok: <why>`
// in a comment on the same line. A file that builds a PRINTED page (an A4
// report) carries `type-ok-file: <why>` once - paper has its own sizes.

export const FS = Object.freeze({
  meta:    11,   // timestamps, counts, fine print
  label:   12,   // labels, table cells, chips, status pills
  body:    13,   // body text, list rows, form fields, drawers
  read:    14,   // long reading only: KB pages, Notes, announcements
  title:   15,   // card titles
  section: 18,   // section headings
  page:    24,   // page titles, greetings
  figure:  32,   // big numbers
});

// The sizes allowed in px. 0 hides text (an icon-only control) and is not a size.
export const TYPE_SCALE = Object.freeze([0, ...Object.values(FS)]);

// Where an old off-scale size lands when its module is moved over. Neil,
// 11/12/2026: 12.5 rounds UP to body (13). 16 goes to title or section by
// what the text IS - look at it; 16 on a phone form field stays (type-ok).
export const SNAP = Object.freeze({
  7.5: 11, 8: 11, 8.5: 11, 9: 11, 9.5: 11, 10: 11, 10.5: 11,
  11.5: 12, 12.2: 12,
  12.5: 13, 13.5: 13,
  14.5: 15, 15.5: 15,
  16: 15, 16.5: 18, 17: 18, 19: 18, 20: 18,
  21: 24, 22: 24, 23: 24, 25: 24, 26: 24, 27: 24,
  28: 32, 30: 32, 34: 32,
});

export const onScale = (px) => TYPE_SCALE.includes(px);

// Where a size lands: SNAP for the sizes the code used, else (a rem that is
// 12.48px) the SNAP of its nearest half pixel, else the nearest scale size.
export function snapFor(px) {
  if (onScale(px)) return px;
  const half = Math.round(px * 2) / 2;
  if (SNAP[px] ?? SNAP[half]) return SNAP[px] ?? SNAP[half];
  if (onScale(half)) return half;
  return TYPE_SCALE.slice(1).reduce((a, b) => (Math.abs(b - px) < Math.abs(a - px) ? b : a));
}
