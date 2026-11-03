// Items phase 4 - the printed tag sheets, in inches on US Letter.
//
// Two stock sizes, both standard label sheets an office already buys:
//   address - 2.625" x 1", 3 x 10 = 30 a sheet (the Avery 5160 / 8160 grid)
//   square  - 2" x 2",     3 x 4  = 12 a sheet (the Avery 22806 grid)
// The margins and gaps add up to exactly 8.5" x 11", so the print lines up
// with the die cuts when the browser prints at 100% with no margins.

export const PAGE = { w: 8.5, h: 11 };

export const TAG_LAYOUTS = {
  address: { key: 'address', label: '2.625" x 1" Labels', hint: '30 a sheet, Avery 5160 size', cols: 3, rows: 10, w: 2.625, h: 1, top: 0.5, left: 0.1875, gapX: 0.125, gapY: 0 },
  square:  { key: 'square',  label: '2" x 2" Labels',     hint: '12 a sheet, Avery 22806 size', cols: 3, rows: 4, w: 2, h: 2, top: 0.625, left: 0.625, gapX: 0.625, gapY: 0.5833 },
};
export const DEFAULT_LAYOUT = 'address';

export function layoutOf(key) {
  return TAG_LAYOUTS[key] || TAG_LAYOUTS[DEFAULT_LAYOUT];
}

export function perPage(key) {
  const l = layoutOf(key);
  return l.cols * l.rows;
}

/**
 * Lay the tags out on sheets. `startAt` (1-based) skips the labels already
 * peeled off a part-used first sheet; those slots come back as null.
 * Returns [[tag | null, ...perPage], ...]; no tags = no sheets.
 */
export function paginateTags(tags, key, startAt = 1) {
  const list = Array.isArray(tags) ? tags : [];
  if (!list.length) return [];
  const n = perPage(key);
  const skip = Math.min(Math.max(1, Math.floor(Number(startAt) || 1)), n) - 1;
  const slots = [...Array(skip).fill(null), ...list];
  const pages = [];
  for (let i = 0; i < slots.length; i += n) {
    const page = slots.slice(i, i + n);
    while (page.length < n) page.push(null);
    pages.push(page);
  }
  return pages;
}
