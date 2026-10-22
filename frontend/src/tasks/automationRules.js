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
  // Oct 22 2026 (the Monday recipes): value {fieldId, to} - to blank = any change.
  { value: 'custom_field_changed', label: 'When a custom field changes', valueKind: 'field_change' },
  { value: 'due_date_changed', label: 'When the due date changes', valueKind: 'none' },
];

export const ACTION_TYPES = [
  { value: 'set_status', label: 'Set Status', valueKind: 'status' },
  { value: 'set_priority', label: 'Set Priority', valueKind: 'priority' },
  { value: 'assign_to', label: 'Assign To', valueKind: 'person' },
  { value: 'add_assignee', label: 'Add Assignee', valueKind: 'person' },
  { value: 'add_follower', label: 'Add Collaborator', valueKind: 'person' },
  { value: 'set_due_in_days', label: 'Set Due Date to N Days From Today', valueKind: 'days' },
  { value: 'shift_due_days', label: 'Move Due Date by N Days', valueKind: 'days' },
  { value: 'add_tag', label: 'Add Tag', valueKind: 'text' },
  { value: 'add_comment', label: 'Add Comment', valueKind: 'comment' },
  { value: 'set_milestone', label: 'Mark as Milestone', valueKind: 'none' },
  // Object-valued (Oct 22 2026) - see defaultActionValue for their shapes.
  { value: 'create_task', label: 'Create Task', valueKind: 'create_task' },
  { value: 'move_to_project', label: 'Move to Project', valueKind: 'move' },
  { value: 'send_email', label: 'Send Email', valueKind: 'email' },
  { value: 'set_custom_field', label: 'Set Custom Field', valueKind: 'field_set' },
];

export const CONDITION_FIELDS = [
  { value: 'project', label: 'Project', valueKind: 'project' },
  { value: 'status', label: 'Status', valueKind: 'status' },
  { value: 'priority', label: 'Priority', valueKind: 'priority' },
  { value: 'assignee', label: 'Assignee', valueKind: 'person' },
  { value: 'team', label: 'Team', valueKind: 'team' },
  { value: 'tag', label: 'Tag', valueKind: 'text' },
  // Carries `fieldId` beside `value`.
  { value: 'custom_field', label: 'Custom Field', valueKind: 'field_value' },
];

export const CONDITION_OPS = [
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
];

// Who a Send Email action writes to. 'person' is the editor's choice for "a
// specific person" - what is stored is that person's email.
export const EMAIL_TO = [
  { value: 'assignees', label: 'The Assignees', words: 'the assignees' },
  { value: 'creator', label: 'The Creator', words: 'the creator' },
  { value: 'followers', label: 'The Collaborators', words: 'the collaborators' },
  { value: 'project_owner', label: 'The Project Owner', words: 'the project owner' },
  { value: 'person', label: 'A Specific Person', words: '' },
];
const EMAIL_TO_KEYS = EMAIL_TO.filter((x) => x.value !== 'person').map((x) => x.value);

export const MAX_CONDITIONS = 10;
export const MAX_ACTIONS = 6;
export const MAX_TITLE = 200;
export const MAX_SUBJECT = 200;
export const MAX_BODY = 5000;

// Placeholders the server fills in (comments, created task titles, emails).
export const COMMENT_PLACEHOLDERS = ['{title}', '{assignee}', '{due}', '{priority}', '{status}', '{project}'];

const OBJECT_ACTIONS = ['create_task', 'move_to_project', 'send_email', 'set_custom_field'];

const blankRule = () => ({
  name: '', enabled: true,
  trigger: { type: 'status_changed', value: '' },
  conditions: [],
  actions: [{ type: 'set_priority', value: 'high' }],
});

// An object value is copied so editing the draft never writes through to the
// rule the list is still showing.
const copyValue = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : (v ?? ''));

export function ruleDraft(rule) {
  if (!rule) return blankRule();
  return {
    name: rule.name || '',
    enabled: rule.enabled !== false,
    trigger: { type: rule.trigger?.type || 'status_changed', value: copyValue(rule.trigger?.value) },
    conditions: (rule.conditions || []).map((c) => ({
      field: c.field, op: c.op || 'is', value: c.value ?? '',
      ...(c.field === 'custom_field' ? { fieldId: c.fieldId || '' } : {}),
    })),
    actions: (rule.actions || []).length
      ? rule.actions.map((a) => ({ type: a.type, value: copyValue(a.value) }))
      : blankRule().actions,
  };
}

export const defaultTriggerValue = (type) => {
  if (type === 'due_date_arrives') return 0;
  if (type === 'custom_field_changed') return { fieldId: '', to: '' };
  return '';
};

export const defaultActionValue = (type) => {
  switch (type) {
    case 'create_task': return { title: 'Follow up: {title}', projectId: '', asSubtask: false, assignee: '{assignee}', dueInDays: '', priority: '' };
    case 'move_to_project': return { projectId: '', sectionId: '' };
    case 'send_email': return { to: 'assignees', subject: '{title} - {status}', body: '' };
    case 'set_custom_field': return { fieldId: '', value: '' };
    default:
      return { set_status: 'in_progress', set_priority: 'high', set_due_in_days: 7, shift_due_days: 1 }[type] ?? '';
  }
};

const isWholeNumber = (v) => v !== '' && v !== null && v !== undefined && Number.isInteger(Number(v));
const blank = (v) => !String(v ?? '').trim();

function actionProblem(a) {
  const v = a.value && typeof a.value === 'object' ? a.value : {};
  if (a.type === 'create_task') {
    if (blank(v.title)) return 'Give the new task a title.';
    if (String(v.title).length > MAX_TITLE) return `The new task's title can be at most ${MAX_TITLE} characters.`;
    if (!blank(v.dueInDays) && !isWholeNumber(v.dueInDays)) return 'Days must be a whole number.';
    if (v.assignee && v.assignee !== '{assignee}' && !String(v.assignee).includes('@')) return 'Pick a person for the new task.';
    return '';
  }
  if (a.type === 'move_to_project') return blank(v.projectId) ? 'Pick the project to move the task to.' : '';
  if (a.type === 'send_email') {
    if (!EMAIL_TO_KEYS.includes(v.to) && !String(v.to || '').includes('@')) return 'Pick who the email goes to.';
    if (blank(v.subject)) return 'Give the email a subject.';
    if (String(v.subject).length > MAX_SUBJECT) return `The subject can be at most ${MAX_SUBJECT} characters.`;
    if (blank(v.body)) return 'Write the email message.';
    if (String(v.body).length > MAX_BODY) return `The message can be at most ${MAX_BODY} characters.`;
    return '';
  }
  if (a.type === 'set_custom_field') return blank(v.fieldId) ? 'Pick the custom field to set.' : '';
  return '';
}

/** The first thing the editor refuses, as a sentence, or '' when the draft is saveable. */
export function ruleProblem(draft) {
  if (!draft.name.trim()) return 'Give the rule a name.';
  if (draft.trigger.type === 'due_date_arrives' && !Number.isInteger(Number(draft.trigger.value || 0))) {
    return 'Days before or after the due date must be a whole number.';
  }
  if (draft.trigger.type === 'custom_field_changed' && blank(draft.trigger.value?.fieldId)) {
    return 'Pick the custom field the rule watches.';
  }
  if (!draft.actions.length) return 'Add at least one action.';
  if (draft.actions.length > MAX_ACTIONS) return `At most ${MAX_ACTIONS} actions.`;
  if (draft.conditions.length > MAX_CONDITIONS) return `At most ${MAX_CONDITIONS} conditions.`;
  for (const c of draft.conditions) {
    if (c.field === 'custom_field' && blank(c.fieldId)) return 'Pick a custom field for every custom field condition.';
    if (!String(c.value ?? '').trim()) return 'Every condition needs a value.';
  }
  for (const a of draft.actions) {
    if (OBJECT_ACTIONS.includes(a.type)) {
      const problem = actionProblem(a);
      if (problem) return problem;
      continue;
    }
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

/** The body the API takes for a draft (what RuleModal saves). */
export function rulePayload(draft) {
  const triggerDef = TRIGGER_TYPES.find((t) => t.value === draft.trigger.type) || TRIGGER_TYPES[0];
  let triggerValue = draft.trigger.value;
  if (triggerDef.valueKind === 'none') triggerValue = '';
  else if (triggerDef.valueKind === 'field_change') {
    triggerValue = { fieldId: draft.trigger.value?.fieldId || '', to: draft.trigger.value?.to ?? '' };
  }
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    trigger: { type: draft.trigger.type, value: triggerValue },
    conditions: draft.conditions.map((c) => ({
      field: c.field, op: c.op, value: c.value,
      ...(c.field === 'custom_field' ? { fieldId: c.fieldId || '' } : {}),
    })),
    actions: draft.actions.map((a) => {
      const kind = ACTION_TYPES.find((x) => x.value === a.type)?.valueKind;
      const v = a.value && typeof a.value === 'object' ? a.value : {};
      if (a.type === 'create_task') {
        return { type: a.type, value: {
          title: String(v.title || '').trim(),
          projectId: v.asSubtask ? '' : (v.projectId || ''),
          asSubtask: !!v.asSubtask,
          assignee: v.assignee || '',
          dueInDays: blank(v.dueInDays) ? '' : Number(v.dueInDays),
          priority: v.priority || '',
        } };
      }
      if (a.type === 'move_to_project') return { type: a.type, value: { projectId: v.projectId || '', sectionId: v.sectionId || '' } };
      if (a.type === 'send_email') return { type: a.type, value: { to: v.to || '', subject: String(v.subject || '').trim(), body: v.body || '' } };
      if (a.type === 'set_custom_field') return { type: a.type, value: { fieldId: v.fieldId || '', value: v.value ?? '' } };
      return { type: a.type, value: kind === 'none' ? '' : kind === 'days' ? Number(a.value) : a.value };
    }),
  };
}

// Day offsets read as plain English: -2 -> "2 days before", 0 -> "on", 3 -> "3 days after".
export function describeDays(value) {
  const n = Number(value || 0);
  if (!n) return 'on the due date';
  const abs = Math.abs(n);
  return `${abs} day${abs === 1 ? '' : 's'} ${n < 0 ? 'before' : 'after'} the due date`;
}

/** A custom field's options as [{id, label}] - older fields store plain strings. */
export function fieldOptions(field) {
  return (field?.options || []).map((o) => (typeof o === 'string'
    ? { id: o, label: o }
    : { id: o.id ?? o.label, label: o.label ?? o.id })).filter((o) => o.id);
}

/**
 * ctx: { statusLabel(id), projectName(id), teamName(id), personName(email), priorityLabel(key),
 *        fieldName(id), fieldOptionLabel(fieldId, value), sectionName(id) }
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

const fieldText = (fieldId, ctx) => ctx.fieldName?.(fieldId) || fieldId || 'a custom field';

/** A custom field value in words: option labels, Checked / Unchecked, people's names. */
export function fieldValueText(fieldId, value, ctx = {}) {
  if (value === true || value === 'checked') return 'Checked';
  if (value === false || value === 'unchecked') return 'Unchecked';
  const v = String(value ?? '');
  if (v.includes('@')) return ctx.personName?.(v) || v;
  return ctx.fieldOptionLabel?.(fieldId, v) || v;
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
  if (t.valueKind === 'field_change') {
    const field = fieldText(v?.fieldId, ctx);
    const to = v?.to;
    return to === '' || to === null || to === undefined
      ? `When ${field} changes`
      : `When ${field} changes to ${fieldValueText(v.fieldId, to, ctx)}`;
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
  if (f.value === 'custom_field') return `${fieldText(c.fieldId, ctx)} ${op} ${fieldValueText(c.fieldId, c.value, ctx)}`;
  return `${f.label.toLowerCase()} ${op} ${valueText(f.valueKind, c.value, ctx)}`;
}

function emailToText(to, ctx) {
  const known = EMAIL_TO.find((x) => x.value === to && x.words);
  if (known) return known.words;
  return valueText('person', to, ctx) || 'nobody yet';
}

export function describeAction(a = {}, ctx = {}) {
  const t = ACTION_TYPES.find((x) => x.value === a.type);
  if (!t) return a.type || '';
  const v = a.value;
  const o = v && typeof v === 'object' ? v : {};
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
    case 'create_task': {
      const where = o.asSubtask ? ' as a subtask' : o.projectId ? ` in ${valueText('project', o.projectId, ctx)}` : '';
      const who = o.assignee === '{assignee}' ? ' for the same assignees'
        : o.assignee ? ` for ${valueText('person', o.assignee, ctx)}` : '';
      return `create task "${o.title || ''}"${where}${who}`;
    }
    case 'move_to_project': {
      const section = o.sectionId ? ` (${ctx.sectionName?.(o.sectionId) || o.sectionId})` : '';
      return `move to ${valueText('project', o.projectId, ctx)}${section}`;
    }
    case 'send_email': return `send an email to ${emailToText(o.to, ctx)}`;
    case 'set_custom_field': {
      const field = fieldText(o.fieldId, ctx);
      return o.value === '' || o.value === null || o.value === undefined
        ? `clear ${field}` : `set ${field} to ${fieldValueText(o.fieldId, o.value, ctx)}`;
    }
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
