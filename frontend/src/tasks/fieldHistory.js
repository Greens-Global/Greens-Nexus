// Field history (Neil, Oct 22 2026): "who changed this field, when, from what
// to what". The server (backend/task_history.py) stores each change with RAW
// values - status / option / project / section ids, emails, ISO dates - plus
// `labels`, the names (and option colors) the ids had when the change was
// made. These helpers turn one side of a change into what a person reads:
// current names first (a renamed option reads as it is called now), then the
// stored name, then "Removed Option" and friends for something long gone.
import { fmtDate, fmtHours } from './lib';
import { PRIORITY_META } from './theme';

// The fields a drawer row can show history for, with the name the popover
// heads its list with. A custom field uses its own name.
export const HISTORY_FIELD_LABELS = {
  title: 'Title', status: 'Status', priority: 'Priority', dueOn: 'Due Date', startOn: 'Start Date',
  assigneeIds: 'Assignees', projectId: 'Project', projectIds: 'Also In', sectionId: 'Section', tags: 'Labels',
  estimateHours: 'Estimate', isMilestone: 'Milestone', approvalStatus: 'Approval',
};

const APPROVAL = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', changes_requested: 'Changes Requested' };
const titleCase = (s) => String(s || '').split(/[_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

const STORED_KINDS = new Set(['text', 'number', 'date', 'checkbox', 'select', 'multiselect', 'people']);
const isBlank = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const asList = (v) => (Array.isArray(v) ? v : [v]);

/** One side of a change as display parts: [{ text, color?, empty? }]. A part
 *  with a color renders as a soft label; `empty` is the "Empty" placeholder.
 *  `ctx`: { nameOf, statusMeta, projectName, customFields }. */
export function historyValueParts(entry, side, ctx = {}) {
  const v = entry?.[side];
  if (isBlank(v)) return [{ text: 'Empty', empty: true }];
  const labels = entry.labels || {};
  const stored = (id) => labels[id] || null;
  const nameOf = ctx.nameOf || ((e) => e);
  switch (entry.field) {
    case 'status': {
      const meta = (ctx.statusMeta || {})[v];
      const s = stored(v);
      return [{ text: meta?.label || s?.label || 'Removed Status', color: meta?.color || s?.color || '#64748b' }];
    }
    case 'priority': {
      const m = PRIORITY_META[v];
      return [{ text: m?.label || titleCase(v), color: m?.color || '#64748b' }];
    }
    case 'dueOn':
    case 'startOn':
      return [{ text: fmtDate(v) }];
    case 'assigneeIds':
      return asList(v).map((e) => ({ text: nameOf(e) || e }));
    case 'projectId':
    case 'projectIds':
      return asList(v).map((id) => ({ text: (ctx.projectName && ctx.projectName(id)) || stored(id)?.label || 'Private Project' }));
    case 'sectionId':
      return [{ text: stored(v)?.label || 'Removed Section' }];
    case 'tags':
      return asList(v).map((t) => ({ text: String(t) }));
    case 'estimateHours':
      return [{ text: fmtHours(v) }];
    case 'isMilestone':
      return [{ text: v ? 'Yes' : 'No' }];
    case 'approvalStatus':
      return [{ text: APPROVAL[v] || titleCase(v) }];
    case 'customField':
      return customParts(entry, v, ctx);
    default:
      return [{ text: String(v) }];
  }
}

function customParts(entry, v, ctx) {
  const field = (ctx.customFields || []).find((f) => f.id === entry.fieldId) || null;
  // `kind` on a history entry; an activity row's change carries it as `type`.
  const kind = entry.kind || (STORED_KINDS.has(entry.type) ? entry.type : '') || field?.type || 'text';
  const labels = entry.labels || {};
  if (kind === 'select' || kind === 'multiselect') {
    return asList(v).map((id) => {
      const live = (field?.options || []).find((o) => (o?.id ?? o) === id || (o?.label ?? o) === id);
      const label = (live && (live.label ?? live)) || labels[id]?.label;
      return { text: label || 'Removed Option', color: (live && live.color) || labels[id]?.color || '#64748b' };
    });
  }
  if (kind === 'people') return asList(v).map((e) => ({ text: (ctx.nameOf && ctx.nameOf(e)) || e }));
  if (kind === 'date') return [{ text: fmtDate(v) }];
  if (kind === 'checkbox') return [{ text: v ? 'Checked' : 'Unchecked' }];
  if (kind === 'number') return [{ text: String(v) }];
  return [{ text: String(v) }];
}

/** The name a change's field goes by: a custom field's current name, else
 *  the one stored with the change ("Removed Field" when neither). */
export function historyFieldName(entry, customFields = []) {
  if (entry?.field === 'customField') {
    const f = customFields.find((x) => x.id === entry.fieldId);
    return f?.name || entry.label || 'Removed Field';
  }
  return HISTORY_FIELD_LABELS[entry?.field] || entry?.label || 'Field';
}

/** "Priority", "Priority and Status", "Priority, Status and 2 more". */
export function joinFieldNames(names) {
  const list = [...new Set(names.filter(Boolean))];
  if (list.length <= 1) return list[0] || 'a field';
  if (list.length <= 3) return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`;
}

// One person's field edits on one task inside this window are ONE save.
const SAVE_WINDOW_MS = 5000;

/** Fold each save's "field_changed" rows into one line for a feed: rows newest
 *  first in, the same order out, where a run of field rows by one person on
 *  one task within a few seconds becomes a single row
 *  `{ ...newest, detail: 'changed Priority and Start Date', changes: [...] }`.
 *  Every other row passes through untouched. */
export function groupFieldChanges(rows, customFields = []) {
  const out = [];
  for (const r of rows || []) {
    const prev = out[out.length - 1];
    if (r?.type === 'field_changed' && prev?.type === 'field_changed' && prev.actorId === r.actorId
        && prev.entityId === r.entityId
        && Math.abs(Date.parse(prev._lastAt || prev.at) - Date.parse(r.at)) <= SAVE_WINDOW_MS) {
      prev.changes.push(r.change);
      prev._lastAt = r.at;
      prev.detail = `changed ${joinFieldNames(prev.changes.map((c) => c && historyFieldName(c, customFields)))}`;
      continue;
    }
    if (r?.type === 'field_changed') {
      const name = r.change ? historyFieldName(r.change, customFields) : '';
      out.push({ ...r, changes: [r.change], detail: name ? `changed ${name}` : (r.detail || 'changed a field') });
    } else {
      out.push(r);
    }
  }
  return out.map(({ _lastAt, ...r }) => r);   // eslint-disable-line no-unused-vars
}

// A bulk edit writes its rows a few milliseconds apart; a gap longer than this
// between one person's rows ends the run.
const BULK_GAP_MS = 2000;
const BULK_TYPES = new Set(['field_changed', 'status_changed', 'assignee_changed']);

/** For the workspace Activity Log (Oct 22 2026 review): one person's field
 *  changes across SEVERAL tasks in one go - a bulk edit of 500 tasks - read as
 *  one line, `{ type: 'bulk_changed', detail: 'changed Priority on 500 tasks',
 *  tasks: [{ entityId, entityTitle }] }`, which the log can expand. Rows newest
 *  first in (after groupFieldChanges), the same order out; a run on a single
 *  task, and every other row, passes through untouched. */
export function foldBulkChanges(rows, customFields = []) {
  const out = [];
  let run = [];
  const flush = () => {
    const tasks = [];
    const seen = new Set();
    for (const r of run) {
      if (!seen.has(r.entityId)) { seen.add(r.entityId); tasks.push({ entityId: r.entityId, entityTitle: r.entityTitle || '' }); }
    }
    if (tasks.length >= 2) {
      const changes = run.flatMap((r) => r.changes || [r.change]).filter(Boolean);
      const names = joinFieldNames(changes.map((c) => historyFieldName(c, customFields)));
      out.push({ ...run[0], id: `bulk-${run[0].id}`, type: 'bulk_changed', change: null, changes,
        detail: `changed ${names} on ${tasks.length} tasks`, entityTitle: '', tasks });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const r of rows || []) {
    const foldable = !!r && BULK_TYPES.has(r.type) && (r.entityKind || 'task') === 'task';
    const last = run[run.length - 1];
    if (foldable && last && last.actorId === r.actorId
        && Math.abs(Date.parse(last.at) - Date.parse(r.at)) <= BULK_GAP_MS) {
      run.push(r);
      continue;
    }
    flush();
    if (foldable) run.push(r); else out.push(r);
  }
  flush();
  return out;
}
