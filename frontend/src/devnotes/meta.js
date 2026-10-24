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

// Build Mode v2 labels that sit on top of the status (the status itself does
// not change): a pin held for the owner of its area, a pin Ready To Check on
// its local preview (between PR Open's violet and Fixed's green - the marker
// carries the gradient, `ready`), and a pin checked there that waits to merge.
export const READY_META = { label: 'Ready To Check', color: '#0d9488', ready: true };
export const CHECKED_META = { label: 'PR Open - Checked', color: '#059669' };
export const HELD_COLOR = '#d97706';

const isReady = (pin) => (pin.readyToCheck != null
  ? !!pin.readyToCheck
  : pin.status === 'pr_open' && !!pin.preview?.url && pin.previewVerdict !== 'accepted');

/** The label a pin shows everywhere (marker, thread, Queue row). */
export function pinMeta(pin) {
  if (!pin) return statusMeta('open');
  if (pin.held && pin.status === 'open') {
    return { label: `Waits For ${pin.ownerName || firstNameOf(pin.ownerEmail) || 'Owner'}`, color: HELD_COLOR, held: true };
  }
  if (isReady(pin)) return READY_META;
  if (pin.status === 'pr_open' && pin.previewVerdict === 'accepted') return CHECKED_META;
  return statusMeta(pin.status);
}
export const pinReady = (pin) => !!pin && isReady(pin);

/** A local preview link (the server allows only these; never an outside link). */
export const isLocalPreview = (url) => /^http:\/\/(localhost|127\.0\.0\.1):\d+(\/|$)/.test(String(url || ''));

/** What the viewer may do on a v2 pin: release a held pin (the owner or a
 *  Global Admin), judge a preview (the author or a Global Admin). */
export function pinRights(pin, me = {}) {
  const email = String(me.email || '').toLowerCase();
  const is = (who) => !!email && email === String(who || '').toLowerCase();
  return {
    release: !!pin?.held && (!!me.isAdmin || is(pin.ownerEmail)),
    verdict: !!me.isAdmin || is(pin?.createdBy),
  };
}


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
