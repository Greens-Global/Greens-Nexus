// Strips the "Z #Inactive " prefix Azure AD adds to disabled accounts.
// Safe to call on any string - returns it unchanged if the prefix isn't present.
export function cleanName(name) {
  if (!name) return name;
  return name.replace(/^Z\s*#Inactive\s*/i, '').trim();
}

// Turns a work email into a "First Last" display name
// (visesh.lodha@greensglobal.com → "Visesh Lodha"). A value that's already a name
// is returned unchanged. Use anywhere a person is shown to users - people must
// never be addressed by a raw email address.
export function emailToName(value) {
  const v = cleanName((value || '').trim());
  if (!v) return '-';
  if (!v.includes('@')) return v;
  return v.split('@')[0].split(/[._-]+/).filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ') || v;
}

// The CSS `zoom` in effect on <html> (TopHeader's readability control, which
// bakes in ZOOM_BASE = 1.1, so this is 1.1 by default and never 1 in practice).
//
// Zoom splits the page into two coordinate spaces. getBoundingClientRect(),
// innerWidth and innerHeight report the OUTER one; a CSS length written onto any
// element inside <html> - a portal into document.body included - is read in the
// INNER one and renders at length * zoom. So a panel positioned straight from a
// measured rect drifts by (zoom - 1) * distance-from-origin: invisible at the
// top-left, badly off at the bottom-right of a wide screen.
//
// Do the arithmetic in the outer space, then divide the final top/left/width by
// this before writing them as styles.
export function rootZoom() {
  const z = parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}
