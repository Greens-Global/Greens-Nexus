// Where a card (the composer, a pin's thread) sits next to the thing it is
// about: to the right of the rect when there is room, else to the left, else
// below; always inside the viewport. Phones get a bottom sheet instead
// (handled by the card's CSS - this returns null there).

export function placeCard(rect, size, vp, isMobile = false, gap = 12) {
  if (isMobile || !rect) return null;
  const w = size.w || 380;
  const h = size.h || Math.min(vp.h * 0.7, 560);
  const edge = 8;
  let left;
  if (rect.x + rect.w + gap + w <= vp.w - edge) left = rect.x + rect.w + gap;
  else if (rect.x - gap - w >= edge) left = rect.x - gap - w;
  else left = Math.max(edge, Math.min(vp.w - edge - w, rect.x));
  let top = rect.y;
  if (left === rect.x && rect.y + rect.h + gap + h <= vp.h - edge) top = rect.y + rect.h + gap;
  top = Math.max(edge, Math.min(vp.h - edge - h, top));
  return { left: Math.round(left), top: Math.round(top) };
}
