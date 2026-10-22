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

// A bulk edit writes its rows a few milliseconds apart. A run is one
// person's rows within this long of the run's FIRST (newest) row - never
// chained on from row to row, so steady editing does not snowball into one.
const BULK_WINDOW_MS = 2000;
const BULK_TYPES = new Set(['field_changed', 'status_changed', 'assignee_changed', 'completed']);

const changeKey = (c) => (c?.field === 'customField' ? `cf:${c.fieldId}` : c?.field || '?');

/** For the workspace Activity Log (Oct 22 2026 review): one person's bulk edit
 *  across SEVERAL tasks reads as one line, which the log can expand -
 *  `{ type: 'bulk_changed', detail, tasks: [{ entityId, entityTitle }] }`.
 *  Only a same-shape run folds: every task in it changed the same set of
 *  fields ("changed Priority on 500 tasks"), or every task in it was
 *  completed ("completed 500 tasks" - the Start Date a completion stamps
 *  rides along). Two hand edits to different fields stay two lines. Rows
 *  newest first in (after groupFieldChanges), the same order out; anything
 *  that does not fold passes through untouched. */
export function foldBulkChanges(rows, customFields = []) {
  const out = [];
  let run = [];
  const flush = () => {
    const byTask = new Map();
    for (const r of run) {
      const g = byTask.get(r.entityId) || { entityId: r.entityId, entityTitle: r.entityTitle || '', completed: false, keys: new Set(), changes: [] };
      if (r.type === 'completed') g.completed = true;
      for (const c of (r.changes || [r.change])) {
        if (r.type !== 'completed') g.keys.add(changeKey(c));
        if (c) g.changes.push(c);
      }
      byTask.set(r.entityId, g);
    }
    const groups = [...byTask.values()];
    const shape = (g) => (g.completed ? 'completed' : [...g.keys].sort().join('|'));
    if (groups.length >= 2 && groups.every((g) => shape(g) === shape(groups[0]))) {
      const first = groups[0];
      const detail = first.completed
        ? `completed ${groups.length} tasks`
        : `changed ${joinFieldNames(first.changes.map((c) => historyFieldName(c, customFields)))} on ${groups.length} tasks`;
      out.push({ ...run[0], id: `bulk-${run[0].id}`, type: 'bulk_changed', change: null,
        changes: groups.flatMap((g) => g.changes), detail, entityTitle: '',
        tasks: groups.map(({ entityId, entityTitle }) => ({ entityId, entityTitle })) });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const r of rows || []) {
    const foldable = !!r && BULK_TYPES.has(r.type) && (r.entityKind || 'task') === 'task';
    const head = run[0];
    if (foldable && head && head.actorId === r.actorId
        && Math.abs(Date.parse(head.at) - Date.parse(r.at)) <= BULK_WINDOW_MS) {
      run.push(r);
      continue;
    }
    flush();
    if (foldable) run.push(r); else out.push(r);
  }
  flush();
  return out;
}
