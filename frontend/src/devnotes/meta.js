// Build Mode vocabulary (Oct 24 2026). One pin is a "Pin", a group is a
// "Build Session"; the words below are the only status / kind / priority
// labels anywhere in the module (Title Case, like every other status label).

export const KINDS = [
  { id: 'bug',      label: 'Bug',      color: '#ef4444' },
  { id: 'change',   label: 'Change',   color: '#2563eb' },
  { id: 'question', label: 'Question', color: '#7c3aed' },
  { id: 'edit',     label: 'Edit',     color: '#0d9488' },
];
export const KIND_META = Object.fromEntries(KINDS.map((k) => [k.id, k]));

export const PRIORITIES = [
  { id: 'blocking', label: 'Blocking',     color: '#dc2626' },
  { id: 'normal',   label: 'Normal',       color: '#64748b' },
  { id: 'nice',     label: 'Nice To Have', color: '#0891b2' },
];
export const PRIORITY_META = Object.fromEntries(PRIORITIES.map((p) => [p.id, p]));

// Pin status -> label and color. `pulse` = Claude Code is on it right now;
// `faded` = nothing left to do here.
export const STATUS_META = {
  open:        { label: 'Open',           color: '#64748b' },
  dispatched:  { label: 'Sent',           color: '#2563eb', pulse: true },
  building:    { label: 'Building',       color: '#2563eb', pulse: true },
  needs_input: { label: 'Needs Input',    color: '#d97706' },
  pr_open:     { label: 'PR Open',        color: '#7c3aed' },
  fixed:       { label: 'Fixed - Verify', color: '#16a34a' },
  done:        { label: 'Done',           color: '#94a3b8', faded: true },
  dismissed:   { label: 'Dismissed',      color: '#94a3b8', faded: true },
};
export const statusMeta = (s) => STATUS_META[s] || { label: s || 'Open', color: '#64748b' };

export const SESSION_STATUS = {
  collecting: { label: 'Collecting',     color: '#64748b' },
  sent:       { label: 'Sent',           color: '#2563eb' },
  building:   { label: 'Building',       color: '#2563eb' },
  pr_open:    { label: 'PR Open',        color: '#7c3aed' },
  fixed:      { label: 'Fixed - Verify', color: '#16a34a' },
  done:       { label: 'Done',           color: '#94a3b8' },
};
export const sessionMeta = (s) => SESSION_STATUS[s] || { label: s || 'Collecting', color: '#64748b' };

// Markup swatches: the strip's Color button cycles through these.
export const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#111827', '#ffffff'];

// The tools of the strip, in order, with their one-key shortcuts.
export const TOOLS = [
  { id: 'pin',       label: 'Pin',       key: 'P' },
  { id: 'edit',      label: 'Edit',      key: 'E' },
  { id: 'rect',      label: 'Rect',      key: 'R' },
  { id: 'arrow',     label: 'Arrow',     key: 'A' },
  { id: 'path',      label: 'Draw',      key: 'D' },
  { id: 'highlight', label: 'Highlight', key: 'H' },
  { id: 'text',      label: 'Text',      key: 'T' },
  { id: 'redact',    label: 'Redact',    key: 'X' },
];
export const MARKUP_TOOLS = new Set(['rect', 'arrow', 'path', 'highlight', 'text', 'redact']);

export function initialsOf(email = '') {
  const local = String(email).split('@')[0] || '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const two = parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return (two || '?').toUpperCase();
}

export function firstNameOf(email = '') {
  const local = String(email).split('@')[0] || '';
  const first = local.split(/[._-]+/)[0] || local;
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : email;
}

export const WATCHER_COMMAND = 'python3 tools/build_notes/watch.py';
