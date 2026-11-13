// Item Management - Activity log: event labels, field diffs, the global feed and its undo rules.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { Package, Plus, CheckCircle, RotateCcw, AlertCircle, UploadCloud, Pencil, Trash2, History, ShoppingCart, User } from 'lucide-react';
import { formatDate, formatDateTime, formatTime, formatWeekday } from '../../lib/datetime';

// ── Audit helpers ─────────────────────────────────────────────────────────────
export function formatAuditDetails(action, rawDetails) {
  let d = {};
  try { d = JSON.parse(rawDetails || '{}'); } catch { return rawDetails || '-'; }
  const a = (action || '').toLowerCase();
  const skip = new Set(['path', 'status', 'method']);   // never the HTTP method (phone review, 11/13/2026)

  // Everything important is **bold** (rendered via the notification bold parser)
  const money = v => '$' + Math.round(Number(v) || 0).toLocaleString('en-US');

  if (a.includes('checkout') || a.includes('checked out')) {
    const parts = [];
    if (d.item_name) parts.push(`**${d.item_name}**`);
    if (d.item_type) parts.push(`(${d.item_type})`);
    if (d.days)      parts.push(`for **${d.days} day${d.days !== 1 ? 's' : ''}**`);
    if (Number(d.asset_value) > 0) parts.push(`· worth **${money(d.asset_value)}**`);
    if (d.reason)    parts.push(`- "${d.reason}"`);
    if (d.department) parts.push(`[${d.department}]`);
    return parts.length ? parts.join(' ') : '-';
  }
  if (a.includes('deleted item cart') || (a.includes('cart') && a.includes('delet'))) {
    return 'Removed item from cart';
  }
  if (a.includes('added item') || a.includes('deleted item') || a.includes('imported')) {
    const parts = [];
    if (d.name || d.item_name) parts.push(`**${d.name || d.item_name}**`);
    if (d.item_type)  parts.push(`(${d.item_type})`);
    if (d.make || d.model) parts.push([d.make, d.model].filter(Boolean).join(' '));
    if (Number(d.asset_value) > 0) parts.push(`· worth **${money(d.asset_value)}**`);
    if (d.location)   parts.push(`@ ${d.location}`);
    if (d.ownership_type) parts.push(d.ownership_type === 'permanent' ? '· permanent' : '· temporary');
    return parts.length ? parts.join(' ') : '-';
  }
  if (a.includes('approved')) {
    const parts = [];
    if (d.item_name) parts.push(`**${d.item_name}**`);
    if (d.allocator_name) parts.push(`→ assigned to **${d.allocator_name}**`);
    return parts.length ? parts.join(' ') : '-';
  }
  if (a.includes('rejected')) {
    const parts = [];
    if (d.item_name) parts.push(`**${d.item_name}**`);
    if (d.reason)    parts.push(`Reason: "${d.reason}"`);
    return parts.join(' - ') || '-';
  }
  if (a.includes('return')) {
    return d.item_name ? `**${d.item_name}** returned${d.condition_note ? ` - ${d.condition_note}` : ''}` : '-';
  }
  if (a.includes('allocated') || a.includes('hand over')) {
    return d.item_name ? `**${d.item_name}** handed over${d.requested_by ? ` to **${d.requested_by}**` : ''}` : '-';
  }

  // Generic fallback - drop path/status, render remaining keys with bold values
  const entries = Object.entries(d).filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && v !== '');
  return entries.length ? entries.map(([k, v]) => `${k.replace(/_/g, ' ')}: **${v}**`).join(' · ') : '-';
}

export function orderActivitySummary(orderItems) {
  const first = orderItems[0];
  const returned  = orderItems.filter(c => c.status === 'returned');
  const rejected  = orderItems.filter(c => c.status === 'rejected');
  const cancelled = orderItems.filter(c => c.status === 'cancelled');

  const fmtFull = iso => formatDate(iso) + ' at ' + formatTime(iso);
  const duration = (fromIso, toIso) => {
    const ms = new Date(toIso) - new Date(fromIso);
    if (ms <= 0) return null;
    const totalMins = Math.round(ms / 60000);
    const days  = Math.floor(totalMins / 1440);
    const hours = Math.floor((totalMins % 1440) / 60);
    const mins  = totalMins % 60;
    const parts = [];
    if (days)  parts.push(`${days} day${days  !== 1 ? 's' : ''}`);
    if (hours) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
    if (!days && !hours && mins) parts.push(`${mins} minute${mins !== 1 ? 's' : ''}`);
    return parts.join(' and ') || null;
  };

  const who    = first.requestedBy;
  const items  = orderItems.length > 1 ? `${orderItems.length} items` : first.itemName;
  const them   = orderItems.length > 1 ? 'them' : 'it';

  if (cancelled.length === orderItems.length) {
    return `${who} cancelled their request for ${items} on ${fmtFull(first.createdAt)}.`;
  }
  if (rejected.length === orderItems.length) {
    const reason = rejected[0].rejectReason;
    return `${who} requested ${items} on ${fmtFull(first.createdAt)} - request was rejected${reason ? ` ("${reason}")` : ''}.`;
  }
  if (returned.length > 0) {
    const allocator = returned[0].assignedAllocatorName || 'the allocator';
    const returnTs  = returned[0].returnedAt;
    const dur       = returnTs ? duration(first.createdAt, returnTs) : null;
    return `${who} checked out ${items} on ${fmtFull(first.createdAt)} and returned ${them} to ${allocator}${returnTs ? ` on ${fmtFull(returnTs)}` : ''}${dur ? ` for a total of ${dur}` : ''}.`;
  }
  return null;
}

// ── Audit Log Panel ───────────────────────────────────────────────────────────
// Audit rows are stored as NAIVE UTC (no timezone suffix) - parsing them raw
// makes JS treat them as local time, which is the "wrong timestamps" Sai saw.
// Force the UTC parse, then show it in the VIEWER's own zone, US format
// (Items redesign, 11/02/2026 - it was always California time).
export const auditDate = (iso) => new Date(/[zZ]$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z');
export function fmtAuditStamp(iso) {
  if (!iso) return '';
  return formatDateTime(auditDate(iso));
}

// Audit rows store raw emails and full checkout IDs - display friendly forms:
// "Visesh Lodha" instead of the address, "Req #F1AC60E7" instead of
// ICHK-CAF2CE90-F1AC60E7 (Visesh: make the log human-understandable).
export function auditName(email) {
  const local = (email || '').split('@')[0];
  return local.split(/[._]/).filter(Boolean).map(p => p[0].toUpperCase() + p.slice(1)).join(' ') || email || '-';
}

// Icon + tone + plain-English verb for an audit action, so the log reads like a
// story instead of a code dump.
export function auditEventMeta(action) {
  const a = (action || '').toLowerCase();
  if (a.includes('imported'))                              return { Icon: UploadCloud, tone: 'green',  verb: 'Imported' };
  if (a.includes('added'))                                 return { Icon: Plus,        tone: 'green',  verb: 'Added' };
  if (a.includes('deleted'))                               return { Icon: Trash2,      tone: 'red',    verb: 'Deleted' };
  if (a.includes('checked out') || a.includes('checkout')) return { Icon: ShoppingCart, tone: 'orange', verb: 'Checked out' };
  if (a.includes('return'))                                return { Icon: RotateCcw,   tone: 'green',  verb: 'Returned' };
  if (a.includes('restore'))                               return { Icon: RotateCcw,   tone: 'green',  verb: 'Restored' };
  if (a.includes('assign'))                                return { Icon: User,        tone: 'blue',   verb: 'Assigned' };
  if (a.includes('allocat') || a.includes('hand'))         return { Icon: Package,     tone: 'blue',   verb: 'Handed over' };
  if (a.includes('approved'))                              return { Icon: CheckCircle, tone: 'green',  verb: 'Approved' };
  if (a.includes('rejected'))                              return { Icon: AlertCircle, tone: 'red',    verb: 'Rejected' };
  if (a.includes('updated') || a.includes('edited'))       return { Icon: Pencil,      tone: 'blue',   verb: 'Updated' };
  return { Icon: History, tone: 'muted', verb: action || 'Event' };
}
export const _auditFg = tone => tone === 'muted' ? 'var(--muted)' : `hsl(var(--color-${tone}))`;
export const _auditBg = tone => tone === 'muted' ? 'var(--mist)'  : `hsla(var(--color-${tone}),0.12)`;

// Fields tracked for the "what changed" diff, with friendly labels.
const _AUDIT_FIELDS = [
  ['name', 'Name'], ['serial_number', 'Serial'], ['item_type', 'Type'], ['make', 'Make'],
  ['model', 'Model'], ['year', 'Year'], ['department', 'Department'], ['location', 'Location'],
  ['default_owner', 'Default owner'], ['ownership_type', 'Ownership'], ['status', 'Lifecycle'],
  ['op_status', 'Op status'], ['op_status_person_name', 'Declared by'], ['asset_value', 'Asset value'],
  ['photo_url', 'Photo'],
];
// Walk an item's events oldest→newest and tag each with the fields that CHANGED
// against the running snapshot, so the timeline can show green (new) / red (old)
// instead of a flat dump of the current values.
export function buildAuditDiffs(rows) {
  const prev = {};
  let firstFieldEvent = true;
  return rows.map(r => {
    let d = {}; try { d = JSON.parse(r.details || '{}'); } catch { /* ignore */ }
    const a = (r.action || '').toLowerCase();
    const fieldEvent = a.includes('added') || a.includes('updated') || a.includes('edited') || a.includes('imported');
    const isAdd = a.includes('added') || a.includes('imported');
    let changes = null, baseline = false;
    if (fieldEvent) {
      changes = [];
      // The first field-event we see is the baseline snapshot - we have no prior
      // state to diff against, so don't paint the whole thing as "changed". An
      // actual Add stays green (those values really were set on creation).
      baseline = firstFieldEvent && !isAdd;
      for (const [f, label] of _AUDIT_FIELDS) {
        if (!(f in d)) continue;
        const to = String(d[f] ?? '');
        const from = (f in prev) ? String(prev[f] ?? '') : null;
        if (from === null) { if (to && to !== '0') changes.push({ field: f, label, from: null, to }); }
        else if (from !== to) changes.push({ field: f, label, from, to });
        prev[f] = to;
      }
      firstFieldEvent = false;
    }
    return { row: r, changes, baseline, isAdd: fieldEvent ? isAdd : false };
  });
}

// ── Activity feed helpers ─────────────────────────────────────────────────────
// Day bucket for grouping: YYYY-MM-DD on the viewer's own calendar (the same
// zone the times render in), which sorts and compares as text.
const pad2 = (n) => String(n).padStart(2, '0');
const localKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export function auditDayKey(iso) {
  if (!iso) return '';
  return localKey(auditDate(iso));
}
export function auditDayLabel(key) {
  if (!key) return '';
  const todayKey = localKey(new Date());
  const yKey = localKey(new Date(Date.now() - 86400000));
  if (key === todayKey) return 'Today';
  if (key === yKey)     return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  return `${formatWeekday(day, 'short')}, ${formatDate(day)}`;
}
export function auditTime(iso) {
  if (!iso) return '';
  return formatTime(auditDate(iso));
}
export function auditInitials(email) {
  return (email || '?').split(/[\s@._]+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase() || '?';
}
export const EMPTY = '∅';

// Walk EVERY item's events oldest→newest, keeping a per-item running snapshot so
// each edit can be shown as "old → new" (the backend only records new values).
// Returns newest-first, each entry tagged with field changes, baseline flag, and
// the undo "reason" carried on reverse entries.
export function buildGlobalFeed(rows) {
  const asc  = [...rows].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  const snap = {};   // resource_id → { field: value }
  const seen = {};   // resource_id → have we set a baseline yet?
  const out = asc.map(r => {
    let d = {}; try { d = JSON.parse(r.details || '{}'); } catch { /* ignore */ }
    const a = (r.action || '').toLowerCase();
    const rid = r.resource_id || '';
    const fieldEvent = a.includes('added') || a.includes('updated') || a.includes('edited') || a.includes('imported');
    const isAdd = a.includes('added') || a.includes('imported');
    let changes = null, baseline = false;
    if (fieldEvent && rid) {
      const s = snap[rid] || (snap[rid] = {});
      baseline = !seen[rid] && !isAdd;
      changes = [];
      for (const [f, label] of _AUDIT_FIELDS) {
        if (!(f in d)) continue;
        const to = String(d[f] ?? '');
        const from = (f in s) ? String(s[f] ?? '') : null;
        if (from === null) { if (to && to !== '0') changes.push({ field:f, label, from:null, to }); }
        else if (from !== to) changes.push({ field:f, label, from, to });
        s[f] = to;
      }
      seen[rid] = true;
    } else if (fieldEvent) {
      // Bulk add/edit (no single resource_id) - show the submitted values flat.
      changes = [];
      for (const [f, label] of _AUDIT_FIELDS) {
        if (!(f in d)) continue;
        const to = String(d[f] ?? '');
        if (to && to !== '0') changes.push({ field:f, label, from:null, to });
      }
    }
    return { row:r, details:d, changes, baseline, isAdd, reason: d.reason || '' };
  });
  return out.reverse();
}

// Which entries can be undone, and the reverse payload to send. Edits restore the
// reconstructed previous values; single-item adds delete; single-item deletes
// restore. Bulk ops and the baseline (no known "before") are not undoable.
export function feedUndoInfo(entry) {
  const r = entry.row;
  if (r.undone_at) return null;
  const rid = r.resource_id || '';
  if (!rid) return null;
  const a = (r.action || '').toLowerCase();
  if (a.startsWith('added item'))   return { kind:'add', confirm:'Undo this? The item will be moved to the Recycle Bin.' };
  if (a.startsWith('deleted item')) return { kind:'del', confirm:'Undo this? The item will be restored from the Recycle Bin.' };
  if (a.startsWith('updated item')) {
    if (entry.baseline || !entry.changes) return null;
    const fields = {};
    for (const c of entry.changes) if (c.from !== null) fields[c.field] = c.from;
    if (!Object.keys(fields).length) return null;
    return { kind:'edit', confirm:'Undo this? The previous value(s) will be put back.', fields };
  }
  return null;
}

// "make, model and location" / "make, model, year and 2 others"
function humanList(arr, max = 4) {
  if (arr.length <= 1) return arr[0] || '';
  if (arr.length > max) {
    const extra = arr.length - max;
    return `${arr.slice(0, max).join(', ')} and ${extra} other${extra !== 1 ? 's' : ''}`;
  }
  return `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
}
const _q = (v) => `“${v}”`;

// One-line plain-English summary for the collapsed card - written like a sentence
// a non-technical user can read. The full field/value detail (with the red→green
// animation) lives behind "Show details". Returns null for non-field events so
// the caller falls back to the humanised details text.
export function feedSummary(entry) {
  const ch = entry.changes;
  if (ch) {
    const n = ch.length;
    // An item created with its values set.
    if (entry.isAdd) return n ? `Added to Items with ${n} detail${n !== 1 ? 's' : ''} filled in.` : 'Added to Items.';
    // A photo change is the action people recognise - always name it, even on a
    // first record (don't bury it under a generic "first record" message).
    const photo = ch.find(c => c.field === 'photo_url');
    if (photo) {
      const verb = photo.to === '' ? 'Removed the photo'
        : (entry.baseline || photo.from == null || photo.from === '') ? 'Added the photo'
        : 'Updated the photo';
      const others = ch.filter(c => c.field !== 'photo_url');
      if (!others.length || entry.baseline) return verb + '.';
      return `${verb}, and ${others.length === 1 ? `changed the ${others[0].label.toLowerCase()}` : `updated ${others.length} other fields`}.`;
    }
    if (entry.baseline) return `This is the first record we have for this item - here’s what it looked like (${n} detail${n !== 1 ? 's' : ''}).`;
    if (n === 0)        return 'Saved with no changes.';
    if (n === 1) {
      const c = ch[0];
      const label = c.label.toLowerCase();
      if (c.to === '')      return `Cleared the ${label}${c.from ? ` (was ${_q(c.from)})` : ''}.`;
      if (c.from == null || c.from === '') return `Set the ${label} to ${_q(c.to)}.`;
      return `Changed the ${label} from ${_q(c.from)} to ${_q(c.to)}.`;
    }
    return `Changed ${humanList(ch.map(c => c.label.toLowerCase()))}.`;
  }
  const a = (entry.row.action || '').toLowerCase();
  if (a.startsWith('deleted item'))  return 'Moved to the Recycle Bin.';
  if (a.startsWith('restored item')) return 'Restored from the Recycle Bin.';
  return null;
}
