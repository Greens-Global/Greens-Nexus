// Task Module — design token bridge (ported from the export's index.css nx-* theme).
// The export used TailwindCSS v4 utilities against these tokens; Nexus uses inline
// styles, so we expose them as a JS object + small style helpers, keeping the exact
// hex values so the module looks identical to the standalone export.

export const NX = {
  canvas:   '#f4f5f7',
  surface:  '#ffffff',
  surface2: '#fafbfc',
  ink:      '#1a1d24',
  dim:      '#5b6472',
  faint:    '#8b93a1',
  border:   '#e6e8ec',
  border2:  '#eef0f3',
  hover:    '#f0f2f5',
  primary:  '#111827',
  blue:     '#2563eb',
  green:    '#16a34a',
  amber:    '#d97706',
  red:      '#dc2626',
  purple:   '#7c3aed',
  teal:     '#0d9488',
  pink:     '#db2777',
};

export const FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// Status + priority metadata (verbatim from constants/taskMeta.ts).
export const STATUS_META = {
  not_started: { label: 'Not Started', color: '#5b6472', tint: '#eef0f3' },
  recurring:   { label: 'Recurring',   color: '#0d9488', tint: '#dcf5f1' },
  in_progress: { label: 'In Progress', color: '#2563eb', tint: '#e0eafe' },
  completed:   { label: 'Completed',   color: '#16a34a', tint: '#e3f5ea' },
};
export const STATUS_ORDER = ['not_started', 'recurring', 'in_progress', 'completed'];

export const PRIORITY_META = {
  none:   { label: 'None',   color: '#8b93a1', tint: '#f0f2f5' },
  low:    { label: 'Low',    color: '#5b6472', tint: '#eef0f3' },
  medium: { label: 'Medium', color: '#2563eb', tint: '#e0eafe' },
  high:   { label: 'High',   color: '#d97706', tint: '#fdefd7' },
  urgent: { label: 'Urgent', color: '#dc2626', tint: '#fde5e5' },
};
export const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low', 'none'];

// Dependency types (verbatim from constants/taskMeta.ts).
export const DEPENDENCY_TYPE_META = {
  FS: { label: 'Finish to start' },
  FF: { label: 'Finish to finish' },
  SS: { label: 'Start to start' },
  SF: { label: 'Start to finish' },
};
export const DEPENDENCY_TYPE_ORDER = ['FS', 'FF', 'SS', 'SF'];

// Task access levels (verbatim from constants/taskMeta.ts).
export const ACCESS_LEVEL_META = {
  org: {
    label: 'Greens Global',
    description: 'Any organization member can find and access this task, unless restricted by an admin.',
  },
  restricted: {
    label: 'Members of this task and connected projects',
    description: 'Members invited to this task and members of connected projects can find and access this task.',
  },
};
export const ACCESS_LEVEL_ORDER = ['org', 'restricted'];

// Project health status (from projects/projectMeta.ts) — distinct from task workflow status.
export const PROJECT_STATUS_META = {
  on_track: { label: 'On track', color: '#16a34a' },
  at_risk:  { label: 'At risk',  color: '#d97706' },
  off_track:{ label: 'Off track', color: '#dc2626' },
  complete: { label: 'Complete', color: '#2563eb' },
};
export const PROJECT_STATUS_ORDER = ['on_track', 'at_risk', 'off_track', 'complete'];

// Option palette for custom-field select/status values (from AddColumnMenu.tsx).
export const FIELD_PALETTE = ['#4573fa', '#8b6bf0', '#14a76c', '#e8a33d', '#e0844e', '#e8384f', '#29a8ab'];

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
export const btn = (variant = 'ghost') => {
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px',
    borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    fontFamily: FONT, transition: 'background 0.13s, opacity 0.13s', lineHeight: 1,
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
