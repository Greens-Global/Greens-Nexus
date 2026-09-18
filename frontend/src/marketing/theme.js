// Marketing module - design-token bridge (ported 1:1 from the standalone
// "Marketing Module Nexus" export). The export was styled with TailwindCSS v4
// utilities; Nexus uses inline styles, so we expose the exact Tailwind default
// palette as a JS object and every ported component translates its classes to
// inline styles against these hex values - keeping the look identical.
//
// Dark mode (Sep 19, Pranshu: "audit whole NEXUS... colours are still not
// accurate", after this module turned out to have ZERO dark-mode wiring at
// all - every value below was a literal hex with no theme awareness, unlike
// the rest of the app's --wk-*/--nx-* token layers). Every token here is now
// a CSS custom property (defined in style.css's :root / [data-theme="dark"],
// prefixed --mkt-) instead of a literal hex, so the whole module adapts the
// same way Tasks (theme.js's NX) already does. Light-mode values are
// byte-identical to the originals - this is a zero-regression change for
// anyone who never leaves light mode. Dark values follow Tailwind's own
// documented dark-mode convention (swap a 600/700 text/icon shade for the
// 400/300 of the same hue) for the saturated accents, and low-alpha
// translucent tints (matching the pattern theme.js's own STATUS_META/
// PRIORITY_META already use) for the pale *50/*100/*200 backgrounds - a
// translucent tint composites correctly over either card colour, so it
// needs no dark override of its own; only the CSS var itself changes.
export const C = {
  white: 'var(--mkt-white)',
  black: 'var(--mkt-black)',
  gray50:  'var(--mkt-gray50)',  gray100: 'var(--mkt-gray100)', gray200: 'var(--mkt-gray200)',
  gray300: 'var(--mkt-gray300)', gray400: 'var(--mkt-gray400)', gray500: 'var(--mkt-gray500)',
  gray600: 'var(--mkt-gray600)', gray700: 'var(--mkt-gray700)', gray800: 'var(--mkt-gray800)',
  gray900: 'var(--mkt-gray900)',
  emerald50: 'var(--mkt-emerald50)', emerald100: 'var(--mkt-emerald100)',
  emerald400: 'var(--mkt-emerald400)', emerald500: 'var(--mkt-emerald500)',
  emerald600: 'var(--mkt-emerald600)', emerald700: 'var(--mkt-emerald700)',
  blue50: 'var(--mkt-blue50)', blue100: 'var(--mkt-blue100)', blue200: 'var(--mkt-blue200)',
  blue500: 'var(--mkt-blue500)', blue600: 'var(--mkt-blue600)', blue700: 'var(--mkt-blue700)',
  amber50: 'var(--mkt-amber50)', amber100: 'var(--mkt-amber100)', amber200: 'var(--mkt-amber200)',
  amber500: 'var(--mkt-amber500)', amber600: 'var(--mkt-amber600)', amber700: 'var(--mkt-amber700)',
  purple50: 'var(--mkt-purple50)', purple100: 'var(--mkt-purple100)', purple200: 'var(--mkt-purple200)',
  purple500: 'var(--mkt-purple500)', purple600: 'var(--mkt-purple600)', purple700: 'var(--mkt-purple700)',
  red50: 'var(--mkt-red50)', red100: 'var(--mkt-red100)',
  red500: 'var(--mkt-red500)', red600: 'var(--mkt-red600)', red700: 'var(--mkt-red700)',
  orange50: 'var(--mkt-orange50)', orange100: 'var(--mkt-orange100)',
  orange500: 'var(--mkt-orange500)', orange600: 'var(--mkt-orange600)',
  teal50: 'var(--mkt-teal50)', teal500: 'var(--mkt-teal500)', teal600: 'var(--mkt-teal600)',
  pink50: 'var(--mkt-pink50)', pink500: 'var(--mkt-pink500)', pink600: 'var(--mkt-pink600)',
  indigo50: 'var(--mkt-indigo50)', indigo500: 'var(--mkt-indigo500)', indigo600: 'var(--mkt-indigo600)',
  // cyan wasn't in the original palette - KpiCards.jsx had it inlined as a
  // literal '#06b6d4'/'#ecfeff' pair, which meant it silently skipped every
  // fix pass that only touched named C.* tokens. Named here now instead.
  cyan50: 'var(--mkt-cyan50)', cyan500: 'var(--mkt-cyan500)',
};

export const FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// rgba helper for the export's translucent utilities (bg-black/30, bg-gray-50/60…).
// Accepts a literal hex OR (now that every C.* token is a CSS var/rgba string,
// not a hex) any valid CSS color - var()/rgba() inputs go through color-mix()
// instead of hex math, so the result still tracks the CURRENT theme's value
// of that variable rather than freezing whatever it resolved to once. This
// codebase already relies on color-mix() elsewhere (style.css), so it's a
// safe baseline here too.
export function alpha(color, a) {
  if (color.startsWith('#')) {
    const h = color.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`;
}

// Reusable primitives matching the export's most common class clusters, so the
// ported components stay terse. All optional - components may also inline directly.
export const card = {
  background: C.white,
  border: `1px solid ${C.gray200}`,
  borderRadius: 12,
  boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)',   // shadow-sm
};
export const cardPad = { ...card, padding: 16 };
export const shadowMd = '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)';
export const shadowLg = '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)';

// A neutral hover/press tint for table rows and list items (Sep 19) - was
// `alpha(C.gray50, 0.6)`/`alpha(C.gray50, 0.8)` inlined per call site, which
// worked in light mode (a near-white hex at 60-80% alpha reads as a faint
// grey wash on a white card) but painted a near-opaque pale patch over a
// dark card - one of the more visible "stray light-mode leftover" bugs.
// A single named token, themed like every other structural neutral here.
export const HOVER_TINT = 'var(--mkt-hover)';

// Chart palette used across recharts components in the export.
export const CHART = {
  blue: C.blue600, emerald: C.emerald500, amber: C.amber500, purple: C.purple500,
  red: C.red500, orange: C.orange500, teal: C.teal500, gray: C.gray400,
  grid: C.gray100, axis: C.gray400,
};
