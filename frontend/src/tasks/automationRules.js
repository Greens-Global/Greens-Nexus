// Task Module - automation rules vocabulary (backend task_automation.py).
// Pure: the option lists the Manage > Automation Rules editor offers and the
// one-line summaries the rule list and the Runs panel print. Kept out of
// ManageView.jsx so the wording is testable without rendering the screen.

export const TRIGGER_TYPES = [
  { value: 'created', label: 'When a task is created', valueKind: 'none' },
  { value: 'status_changed', label: 'When status changes', valueKind: 'status' },
  { value: 'priority_changed', label: 'When priority changes', valueKind: 'priority' },
  { value: 'assignee_changed', label: 'When someone is assigned', valueKind: 'person' },
  { value: 'moved_to_project', label: 'When moved to a project', valueKind: 'project' },
  { value: 'completed_early', label: 'When completed before its due date', valueKind: 'none' },
  { value: 'due_date_arrives', label: 'When the due date arrives', valueKind: 'days' },
];

export const ACTION_TYPES = [
  { value: 'set_status', label: 'Set status', valueKind: 'status' },
  { value: 'set_priority', label: 'Set priority', valueKind: 'priority' },
  { value: 'assign_to', label: 'Assign to', valueKind: 'person' },
  { value: 'add_assignee', label: 'Add assignee', valueKind: 'person' },
  { value: 'add_follower', label: 'Add collaborator', valueKind: 'person' },
  { value: 'set_due_in_days', label: 'Set due date to N days from today', valueKind: 'days' },
  { value: 'shift_due_days', label: 'Move due date by N days', valueKind: 'days' },
  { value: 'add_tag', label: 'Add tag', valueKind: 'text' },
  { value: 'add_comment', label: 'Add comment', valueKind: 'comment' },
  { value: 'set_milestone', label: 'Mark as milestone', valueKind: 'none' },
];

export const CONDITION_FIELDS = [
  { value: 'project', label: 'Project', valueKind: 'project' },
  { value: 'status', label: 'Status', valueKind: 'status' },
  { value: 'priority', label: 'Priority', valueKind: 'priority' },
  { value: 'assignee', label: 'Assignee', valueKind: 'person' },
  { value: 'team', label: 'Team', valueKind: 'team' },
  { value: 'tag', label: 'Tag', valueKind: 'text' },
];

export const CONDITION_OPS = [
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
];

export const MAX_CONDITIONS = 10;
export const MAX_ACTIONS = 6;

// Placeholders add_comment fills in server-side.
export const COMMENT_PLACEHOLDERS = ['{title}', '{assignee}', '{due}', '{priority}', '{status}', '{project}'];

const blankRule = () => ({
  name: '', enabled: true,
  trigger: { type: 'status_changed', value: '' },
  conditions: [],
  actions: [{ type: 'set_priority', value: 'high' }],
});

export function ruleDraft(rule) {
  if (!rule) return blankRule();
  return {
    name: rule.name || '',
    enabled: rule.enabled !== false,
    trigger: { type: rule.trigger?.type || 'status_changed', value: rule.trigger?.value ?? '' },
    conditions: (rule.conditions || []).map((c) => ({ field: c.field, op: c.op || 'is', value: c.value ?? '' })),
    actions: (rule.actions || []).length
      ? rule.actions.map((a) => ({ type: a.type, value: a.value ?? '' }))
      : blankRule().actions,
  };
}

export const defaultActionValue = (type) => ({
  set_status: 'in_progress', set_priority: 'high', set_due_in_days: 7, shift_due_days: 1,
}[type] ?? '');

/** The first thing the editor refuses, as a sentence, or '' when the draft is saveable. */
export function ruleProblem(draft) {
  if (!draft.name.trim()) return 'Give the rule a name.';
  if (draft.trigger.type === 'due_date_arrives' && !Number.isInteger(Number(draft.trigger.value || 0))) {
    return 'Days before or after the due date must be a whole number.';
  }
  if (!draft.actions.length) return 'Add at least one action.';
  if (draft.actions.length > MAX_ACTIONS) return `At most ${MAX_ACTIONS} actions.`;
  if (draft.conditions.length > MAX_CONDITIONS) return `At most ${MAX_CONDITIONS} conditions.`;
  for (const c of draft.conditions) {
    if (!String(c.value ?? '').trim()) return 'Every condition needs a value.';
  }
  for (const a of draft.actions) {
    const kind = ACTION_TYPES.find((x) => x.value === a.type)?.valueKind;
    if (kind === 'none') continue;
    if (kind === 'days') {
      if (!Number.isInteger(Number(a.value))) return 'Days must be a whole number.';
    } else if (kind === 'person') {
      if (!String(a.value || '').includes('@')) return 'Pick a person for the assign action.';
    } else if (!String(a.value ?? '').trim()) {
      return 'Every action needs a value.';
    }
  }
  return '';
}

// Day offsets read as plain English: -2 -> "2 days before", 0 -> "on", 3 -> "3 days after".
export function describeDays(value) {
  const n = Number(value || 0);
  if (!n) return 'on the due date';
  const abs = Math.abs(n);
  return `${abs} day${abs === 1 ? '' : 's'} ${n < 0 ? 'before' : 'after'} the due date`;
}

/**
 * ctx: { statusLabel(id), projectName(id), teamName(id), personName(email), priorityLabel(key) }
 * Every lookup falls back to the raw value, so a deleted status or project
 * still reads rather than printing "undefined".
 */
function valueText(kind, value, ctx) {
  const v = value ?? '';
  if (kind === 'status') return ctx.statusLabel?.(v) || v;
  if (kind === 'priority') return ctx.priorityLabel?.(v) || v;
  if (kind === 'project') return ctx.projectName?.(v) || v;
  if (kind === 'team') return ctx.teamName?.(v) || v;
  if (kind === 'person') return ctx.personName?.(v) || v;
  return String(v);
}

export function describeTrigger(trigger = {}, ctx = {}) {
  const t = TRIGGER_TYPES.find((x) => x.value === trigger.type);
  if (!t) return trigger.type || 'Trigger';
  const v = trigger.value;
  if (t.valueKind === 'none') return t.label;
  if (t.valueKind === 'days') {
    const d = describeDays(v);
    return d === 'on the due date' ? 'On the due date' : `When it is ${d}`;
  }
  if (v === '' || v === null || v === undefined) {
    return { status_changed: 'When status changes', priority_changed: 'When priority changes',
      assignee_changed: 'When anyone is assigned', moved_to_project: 'When moved to any project' }[t.value] || t.label;
  }
  const to = { status_changed: 'to', priority_changed: 'to', assignee_changed: 'to', moved_to_project: 'to' }[t.value] || '';
  return `${t.label} ${to} ${valueText(t.valueKind, v, ctx)}`.replace(/\s+/g, ' ').trim();
}

export function describeCondition(c = {}, ctx = {}) {
  const f = CONDITION_FIELDS.find((x) => x.value === c.field);
  const op = CONDITION_OPS.find((x) => x.value === (c.op || 'is'))?.label || 'is';
  if (!f) return '';
  if (f.value === 'tag') return `tag ${op === 'is' ? 'includes' : 'does not include'} ${c.value}`;
  return `${f.label.toLowerCase()} ${op} ${valueText(f.valueKind, c.value, ctx)}`;
}

export function describeAction(a = {}, ctx = {}) {
  const t = ACTION_TYPES.find((x) => x.value === a.type);
  if (!t) return a.type || '';
  const v = a.value;
  switch (t.value) {
    case 'set_status': return `set status to ${valueText('status', v, ctx)}`;
    case 'set_priority': return `set priority to ${valueText('priority', v, ctx)}`;
    case 'assign_to': return `assign to ${valueText('person', v, ctx)}`;
    case 'add_assignee': return `add ${valueText('person', v, ctx)} as assignee`;
    case 'add_follower': return `add ${valueText('person', v, ctx)} as collaborator`;
    case 'set_due_in_days': { const n = Number(v || 0); return n === 0 ? 'set due date to today' : `set due date to ${n} day${Math.abs(n) === 1 ? '' : 's'} from today`; }
    case 'shift_due_days': { const n = Number(v || 0); return `move due date ${n < 0 ? 'earlier' : 'later'} by ${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'}`; }
    case 'add_tag': return `add tag ${v}`;
    case 'add_comment': return 'add a comment';
    case 'set_milestone': return 'mark as milestone';
    default: return t.label.toLowerCase();
  }
}

/** "When status changes to In Progress · only if project is Ops → set priority to High, assign to Sam Lee" */
export function describeRule(rule = {}, ctx = {}) {
  const parts = [describeTrigger(rule.trigger, ctx)];
  const conds = (rule.conditions || []).map((c) => describeCondition(c, ctx)).filter(Boolean);
  if (conds.length) parts.push(`only if ${conds.join(' and ')}`);
  const acts = (rule.actions || []).map((a) => describeAction(a, ctx)).filter(Boolean);
  return `${parts.join(' · ')} → ${acts.join(', ') || '-'}`;
}
