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

/** Held for the owner of its area, and still open (never sent). */
export const pinHeld = (p) => !!p?.held && p.status === 'open';
/** A human answered last and Claude Code has not picked it up again yet. */
export function pinAwaitsClaude(p) {
  if (p?.status !== 'building') return false;
  const t = Array.isArray(p.thread) ? p.thread : [];
  const last = t[t.length - 1];
  return !!last && last.kind === 'comment' && last.by !== 'claude';
}
/** Reopened on the preview and Claude Code has it again: building, and the
 *  author's note is no longer the last word waiting for it. A needs_input
 *  pin is never "on it" - it is waiting for the author. */
export const pinReopened = (p) => p?.previewVerdict === 'reopened' && p.status === 'building' && !pinAwaitsClaude(p);
/** Accepted on the preview; the PR has not merged yet. */
export const pinChecked = (p) => p?.previewVerdict === 'accepted' && p.status === 'pr_open';
export const pinReady = (pin) => !!pin && isReady(pin);

/** The label a pin shows everywhere (marker, thread, Queue row). */
export function pinMeta(pin) {
  if (!pin) return statusMeta('open');
  if (pinHeld(pin)) {
    return { label: `Waits For ${pin.ownerName || firstNameOf(pin.ownerEmail) || 'Owner'}`, color: HELD_COLOR, held: true };
  }
  if (isReady(pin)) return READY_META;
  if (pinChecked(pin)) return CHECKED_META;
  return statusMeta(pin.status);
}

/** A local preview link - the server's rule: http, localhost or 127.0.0.1,
 *  a port, no credentials. Never an outside link. */
export function isLocalPreview(url) {
  if (!url) return false;
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
      && !!u.port && !u.username && !u.password;
  } catch { return false; }
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

// The tools of the strip, in order, with their one-key shortcuts. Browse
// (Oct 25) lets clicks through to Nexus so a person can move to another
// module, open a record or a tab without turning the mode off.
export const TOOLS = [
  { id: 'browse',    label: 'Browse',    key: 'B' },
  { id: 'pin',       label: 'Pin',       key: 'P' },
  { id: 'edit',      label: 'Edit',      key: 'E' },
  { id: 'rect',      label: 'Rect',      key: 'R' },
  { id: 'arrow',     label: 'Arrow',     key: 'A' },
  { id: 'path',      label: 'Pen',       key: 'D' },   // "Draw" is the simple strip's fold
  { id: 'highlight', label: 'Highlight', key: 'H' },
  { id: 'text',      label: 'Text',      key: 'T' },
  { id: 'redact',    label: 'Redact',    key: 'X' },
];
export const MARKUP_TOOLS = new Set(['rect', 'arrow', 'path', 'highlight', 'text', 'redact']);
// The simple strip (Oct 26 2026, Pranshu: easier for people who are not
// technical): Browse and Comment up front; Edit and the markup tools fold
// under Draw. Settings > Show All Tools brings back the whole strip.
export const SIMPLE_TOOLS = new Set(['browse', 'pin']);

/** Bug / Change / Question from the words, until the person picks one. */
export function guessKind(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return 'bug';
  if (/\?\s*$/.test(t) || /^(how|what|why|where|when|who|which|is there|are there|can i|do i|does|should i)\b/.test(t)) return 'question';
  if (/\b(can we|could we|could you|please add|add an?|would be (nice|great|better)|should (be|have|show)|instead of|rename|move (it|this)|make (it|this)|change (it|this|the)|i wish|it would help)\b/.test(t)) return 'change';
  return 'bug';
}

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

// Send to Claude Code (on since Oct 27 2026 - the team's call; each pin goes
// to its sender's own Claude Code). Off: no Send To Claude Code or Save And
// Send, no Settings tab, no Connect card, and a stored Send Instantly is
// ignored - pins only save, and Done posts them to Teams. The switch takes
// ALL of it, the Settings tab included; the server's twin is CLAUDE_SEND_ON in
// backend/routers/dev_notes.py - flip both together.
export const CLAUDE_SEND_ON = true;
