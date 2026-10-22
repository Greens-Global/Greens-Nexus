// The sentences Manage > Automation Rules prints for a rule, and what the
// editor refuses to save. Pure helpers (automationRules.js); the engine is
// backend/task_automation.py (test_task_automation.py).
import { describe, it, expect } from 'vitest';
import {
  describeRule, describeTrigger, describeAction, describeCondition, describeDays, ruleProblem, ruleDraft,
  rulePayload, defaultActionValue, defaultTriggerValue, fieldOptions, newActionKey,
} from './automationRules';

const ctx = {
  statusLabel: (id) => ({ in_progress: 'In Progress', completed: 'Completed' }[id] || id),
  priorityLabel: (k) => ({ high: 'High', urgent: 'Urgent' }[k] || k),
  projectName: (id) => ({ p1: 'Ops', p2: 'Finance' }[id] || id),
  teamName: (id) => id,
  personName: (e) => ({ 'sam@greensglobal.com': 'Sam Lee' }[e] || e),
  fieldName: (id) => ({ budget: 'Budget Status', signed: 'Signed' }[id] || id),
  fieldOptionLabel: (fid, v) => ({ over: 'Over', ok: 'OK' }[v] || v),
  sectionName: (id) => ({ s1: 'Ready' }[id] || id),
};

describe('describeRule', () => {
  it('reads trigger, conditions and actions as one line', () => {
    const rule = {
      trigger: { type: 'status_changed', value: 'in_progress' },
      conditions: [{ field: 'project', op: 'is', value: 'p1' }, { field: 'tag', op: 'is_not', value: 'blocked' }],
      actions: [{ type: 'set_priority', value: 'high' }, { type: 'assign_to', value: 'sam@greensglobal.com' }],
    };
    expect(describeRule(rule, ctx)).toBe(
      'When status changes to In Progress · only if project is Ops and tag does not include blocked → set priority to High, assign to Sam Lee',
    );
  });

  it('says "any" when a trigger has no value', () => {
    expect(describeTrigger({ type: 'status_changed', value: '' }, ctx)).toBe('When status changes');
    expect(describeTrigger({ type: 'assignee_changed' }, ctx)).toBe('When anyone is assigned');
  });

  it('spells out day offsets', () => {
    expect(describeDays(0)).toBe('on the due date');
    expect(describeDays(-2)).toBe('2 days before the due date');
    expect(describeDays(1)).toBe('1 day after the due date');
    expect(describeTrigger({ type: 'due_date_arrives', value: -2 }, ctx)).toBe('When it is 2 days before the due date');
    expect(describeTrigger({ type: 'due_date_arrives', value: 0 }, ctx)).toBe('On the due date');
  });

  it('falls back to the raw value for a deleted status or project', () => {
    expect(describeAction({ type: 'set_status', value: 'gone-id' }, ctx)).toBe('set status to gone-id');
  });

  it('describes due-date actions in plain words', () => {
    expect(describeAction({ type: 'set_due_in_days', value: 7 }, ctx)).toBe('set due date to 7 days from today');
    expect(describeAction({ type: 'shift_due_days', value: -3 }, ctx)).toBe('move due date earlier by 3 days');
  });
});

describe('ruleProblem', () => {
  const ok = () => ({ ...ruleDraft(null), name: 'Rule' });

  it('accepts the default draft once named', () => {
    expect(ruleProblem(ok())).toBe('');
  });

  it('needs a name', () => {
    expect(ruleProblem(ruleDraft(null))).toMatch(/name/);
  });

  it('needs at least one action', () => {
    expect(ruleProblem({ ...ok(), actions: [] })).toMatch(/action/);
  });

  it('needs a person for assign actions', () => {
    expect(ruleProblem({ ...ok(), actions: [{ type: 'assign_to', value: '' }] })).toMatch(/person/);
  });

  it('needs whole days', () => {
    expect(ruleProblem({ ...ok(), actions: [{ type: 'shift_due_days', value: 'soon' }] })).toMatch(/whole number/);
  });

  it('needs a value on every condition', () => {
    expect(ruleProblem({ ...ok(), conditions: [{ field: 'project', op: 'is', value: '' }] })).toMatch(/condition/);
  });
});

// The Monday-recipe triggers and actions (Oct 22 2026).
describe('custom field, due date, create, move, email and field summaries', () => {
  it('reads a custom field trigger with and without a target value', () => {
    expect(describeTrigger({ type: 'custom_field_changed', value: { fieldId: 'budget', to: 'over' } }, ctx))
      .toBe('When Budget Status changes to Over');
    expect(describeTrigger({ type: 'custom_field_changed', value: { fieldId: 'budget', to: '' } }, ctx))
      .toBe('When Budget Status changes');
    expect(describeTrigger({ type: 'custom_field_changed', value: { fieldId: 'signed', to: 'checked' } }, ctx))
      .toBe('When Signed changes to Checked');
    expect(describeTrigger({ type: 'due_date_changed', value: '' }, ctx)).toBe('When the due date changes');
  });

  it('reads the email recipe as Neil wrote it', () => {
    const rule = {
      trigger: { type: 'custom_field_changed', value: { fieldId: 'budget', to: 'over' } },
      conditions: [],
      actions: [{ type: 'send_email', value: { to: 'assignees', subject: 'x', body: 'y' } }],
    };
    expect(describeRule(rule, ctx)).toBe('When Budget Status changes to Over → send an email to the assignees');
    expect(describeAction({ type: 'send_email', value: { to: 'sam@greensglobal.com' } }, ctx)).toBe('send an email to Sam Lee');
    expect(describeAction({ type: 'send_email', value: { to: 'project_owner' } }, ctx)).toBe('send an email to the project owner');
  });

  it('describes created tasks, moves and field writes', () => {
    expect(describeAction({ type: 'create_task', value: { title: 'Follow up: {title}', projectId: 'p2', assignee: '{assignee}' } }, ctx))
      .toBe('create task "Follow up: {title}" in Finance for the same assignees');
    expect(describeAction({ type: 'create_task', value: { title: 'Photos', asSubtask: true, assignee: 'sam@greensglobal.com' } }, ctx))
      .toBe('create task "Photos" as a subtask for Sam Lee');
    expect(describeAction({ type: 'move_to_project', value: { projectId: 'p1', sectionId: 's1' } }, ctx)).toBe('move to Ops (Ready)');
    expect(describeAction({ type: 'set_custom_field', value: { fieldId: 'budget', value: 'ok' } }, ctx)).toBe('set Budget Status to OK');
    expect(describeAction({ type: 'set_custom_field', value: { fieldId: 'budget', value: '' } }, ctx)).toBe('clear Budget Status');
  });

  it('reads a custom field condition', () => {
    expect(describeCondition({ field: 'custom_field', fieldId: 'budget', op: 'is_not', value: 'over' }, ctx))
      .toBe('Budget Status is not Over');
  });

  it('normalizes field options of both shapes', () => {
    expect(fieldOptions({ options: ['A', { id: 'b', label: 'B' }] })).toEqual([{ id: 'A', label: 'A' }, { id: 'b', label: 'B' }]);
    expect(fieldOptions(undefined)).toEqual([]);
  });
});

describe('ruleProblem for the new triggers and actions', () => {
  const named = (patch) => ({ ...ruleDraft(null), name: 'Rule', ...patch });

  it('needs a field for a custom field trigger and condition', () => {
    expect(ruleProblem(named({ trigger: { type: 'custom_field_changed', value: defaultTriggerValue('custom_field_changed') } })))
      .toMatch(/custom field/);
    expect(ruleProblem(named({ conditions: [{ field: 'custom_field', op: 'is', value: 'x', fieldId: '' }] }))).toMatch(/custom field/);
    expect(ruleProblem(named({ conditions: [{ field: 'custom_field', op: 'is', value: '', fieldId: 'budget' }] }))).toMatch(/condition/);
  });

  it('checks a create task action', () => {
    const create = (v) => named({ actions: [{ type: 'create_task', value: { ...defaultActionValue('create_task'), ...v } }] });
    expect(ruleProblem(create({}))).toBe('');
    expect(ruleProblem(create({ title: ' ' }))).toMatch(/title/);
    expect(ruleProblem(create({ dueInDays: 'soon' }))).toMatch(/whole number/);
    expect(ruleProblem(create({ assignee: 'sam' }))).toMatch(/person/);
  });

  it('checks move, email and field actions', () => {
    expect(ruleProblem(named({ actions: [{ type: 'move_to_project', value: defaultActionValue('move_to_project') }] }))).toMatch(/project/);
    const email = (v) => named({ actions: [{ type: 'send_email', value: { ...defaultActionValue('send_email'), body: 'Hi', ...v } }] });
    expect(ruleProblem(email({}))).toBe('');
    expect(ruleProblem(email({ to: '' }))).toMatch(/who the email goes to/);
    expect(ruleProblem(email({ to: 'sam@greensglobal.com' }))).toBe('');
    expect(ruleProblem(email({ subject: '' }))).toMatch(/subject/);
    expect(ruleProblem(email({ body: '' }))).toMatch(/message/);
    expect(ruleProblem(named({ actions: [{ type: 'set_custom_field', value: defaultActionValue('set_custom_field') }] }))).toMatch(/custom field/);
  });
});

describe('rulePayload', () => {
  it('shapes the object values the API takes', () => {
    const draft = {
      name: ' Hand off ', enabled: true,
      trigger: { type: 'custom_field_changed', value: { fieldId: 'budget', to: 'over' } },
      conditions: [{ field: 'custom_field', fieldId: 'signed', op: 'is', value: 'checked' }, { field: 'tag', op: 'is', value: 'x', fieldId: 'stale' }],
      actions: [
        { type: 'create_task', value: { title: ' Next ', projectId: 'p2', asSubtask: true, assignee: '{assignee}', dueInDays: '3', priority: '' } },
        { type: 'set_due_in_days', value: '7' },
        { type: 'set_milestone', value: 'x' },
      ],
    };
    const out = rulePayload(draft);
    expect(out.name).toBe('Hand off');
    expect(out.trigger).toEqual({ type: 'custom_field_changed', value: { fieldId: 'budget', to: 'over' } });
    expect(out.conditions).toEqual([
      { field: 'custom_field', fieldId: 'signed', op: 'is', value: 'checked' },
      { field: 'tag', op: 'is', value: 'x' },
    ]);
    // A subtask lives in its parent's project, so no project is sent.
    expect(out.actions[0].value).toEqual({ title: 'Next', projectId: '', asSubtask: true, assignee: '{assignee}', dueInDays: 3, priority: '' });
    expect(out.actions[1].value).toBe(7);
    expect(out.actions[2].value).toBe('');
    expect(rulePayload({ ...draft, trigger: { type: 'due_date_changed', value: 'junk' } }).trigger.value).toBe('');
  });

  it('gives every action row a stable key that is never sent', () => {
    const d = ruleDraft({ name: 'r', trigger: { type: 'created' }, actions: [{ type: 'set_milestone' }, { type: 'add_tag', value: 'x' }] });
    expect(d.actions.map((a) => a.key)).toEqual(['a0', 'a1']);
    expect(JSON.stringify(ruleDraft(null))).toBe(JSON.stringify(ruleDraft(null)));   // the dirty check compares these
    expect(newActionKey()).not.toBe(newActionKey());
    expect(rulePayload({ ...d, name: 'r' }).actions.every((a) => !('key' in a))).toBe(true);
  });

  it('copies object values into the draft so edits never touch the listed rule', () => {
    const rule = { name: 'r', trigger: { type: 'created' }, actions: [{ type: 'send_email', value: { to: 'creator', subject: 's', body: 'b' } }] };
    const d = ruleDraft(rule);
    d.actions[0].value.subject = 'changed';
    expect(rule.actions[0].value.subject).toBe('s');
  });
});
