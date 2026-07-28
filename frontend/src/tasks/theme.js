// Task Module - design token bridge (ported from the export's index.css nx-* theme).
// Nexus uses inline styles, so we expose the palette as a JS object + style helpers.
// STRUCTURAL tokens (surfaces/text/borders) point at theme-aware CSS variables
// (defined in style.css :root / [data-theme="dark"]) so the whole module adapts to
// dark mode. ACCENT colours stay literal hex - they read on both themes and are
// alpha-composited in a few places (e.g. `${NX.blue}1a`), which requires a real hex.

export const NX = {
  canvas:   'var(--nx-canvas)',
  surface:  'var(--nx-surface)',
  surface2: 'var(--nx-surface2)',
  ink:      'var(--nx-ink)',
  dim:      'var(--nx-dim)',
  faint:    'var(--nx-faint)',
  border:   'var(--nx-border)',
  border2:  'var(--nx-border2)',
  hover:    'var(--nx-hover)',
  primary:  'var(--nx-primary)',
  blue:     '#2563eb',
  green:    '#16a34a',
  amber:    '#d97706',
  red:      '#dc2626',
  purple:   '#7c3aed',
  teal:     '#0d9488',
  pink:     '#db2777',
};

export const FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// Status + priority metadata. Tints are translucent rgba (not opaque pastels) so
// chips look native over both the light card and the dark card. Colours stay hex
// so they can also be used as SVG fills/strokes (custom-chart donut/line).
// Palette tuned to monday.com's board colors (Jul 25): working-orange /
// done-green / stuck-red family - brighter, reads well as SOLID cell fills.
export const STATUS_META = {
  not_started: { label: 'Not Started', color: '#c4c4c4', tint: 'rgba(196,196,196,0.25)' },
  recurring:   { label: 'Recurring',   color: '#0d9488', tint: 'rgba(13,148,136,0.15)' },
  in_progress: { label: 'In Progress', color: '#fdab3d', tint: 'rgba(253,171,61,0.18)' },
  completed:   { label: 'Completed',   color: '#00c875', tint: 'rgba(0,200,117,0.16)' },
};
export const STATUS_ORDER = ['not_started', 'in_progress', 'completed', 'recurring'];

export const PRIORITY_META = {
  low:    { label: 'Low',    color: '#579bfc', tint: 'rgba(87,155,252,0.16)' },
  medium: { label: 'Medium', color: '#5559df', tint: 'rgba(85,89,223,0.15)' },
  high:   { label: 'High',   color: '#a25ddc', tint: 'rgba(162,93,220,0.16)' },
  urgent: { label: 'Urgent', color: '#e2445c', tint: 'rgba(226,68,92,0.15)' },
};
export const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'];

// Deterministic color for a department/avatar from a string key.
const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#0d9488', '#d97706', '#db2777', '#16a34a', '#dc2626', '#5b6472'];
export function colorForKey(key = '') {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initialsOf(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

// ── Reusable inline-style fragments ──────────────────────────────────────────
export const card = {
  background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12,
};
export const chip = (color, tint) => ({
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px',
  borderRadius: 999, fontSize: 12, fontWeight: 600, color, background: tint,
  whiteSpace: 'nowrap',
});
export function statusChip(status) {
  const m = STATUS_META[status] || { label: status, color: NX.dim, tint: NX.border2 };
  return { ...chip(m.color, m.tint), label: m.label };
}
export function priorityChip(priority) {
  const m = PRIORITY_META[priority] || { label: priority, color: NX.dim, tint: NX.border2 };
  return { ...chip(m.color, m.tint), label: m.label };
}
// Toolbar control sizing. The search input and the buttons beside it are styled
// from different bases (input vs button metrics), so without shared numbers they
// drift - the buttons used to sit ~4px shorter than the search bar. Kept out of
// btn() itself, which also dresses tiny icon-only buttons that must stay small.
// Deliberately compact: at full button size a row of six outlined controls reads
// as a wall of boxes next to the list it sits above.
export const CONTROL_H = 24;
export const CONTROL_FS = 12;      // label size that fits CONTROL_H comfortably
export const CONTROL_ICON = 13;

export const btn = (variant = 'ghost') => {
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px',
    borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    fontFamily: FONT, transition: 'background 0.13s, opacity 0.13s', lineHeight: 1,
    boxSizing: 'border-box',   // so an explicit height means that height
  };
  if (variant === 'primary') return { ...base, background: NX.primary, color: '#fff', border: `1px solid ${NX.primary}` };
  if (variant === 'outline') return { ...base, background: NX.surface, color: NX.ink, border: `1px solid ${NX.border}` };
  return { ...base, background: 'transparent', color: NX.dim, border: '1px solid transparent' };
};
export const input = {
  width: '100%', padding: '8px 11px', borderRadius: 8, border: `1px solid ${NX.border}`,
  fontSize: 14, fontFamily: FONT, color: NX.ink, background: NX.surface, outline: 'none',
  boxSizing: 'border-box',
};
