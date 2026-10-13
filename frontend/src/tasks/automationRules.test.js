// The sentences Manage > Automation Rules prints for a rule, and what the
// editor refuses to save. Pure helpers (automationRules.js); the engine is
// backend/task_automation.py (test_task_automation.py).
import { describe, it, expect } from 'vitest';
import { describeRule, describeTrigger, describeAction, describeDays, ruleProblem, ruleDraft } from './automationRules';

const ctx = {
  statusLabel: (id) => ({ in_progress: 'In Progress', completed: 'Completed' }[id] || id),
  priorityLabel: (k) => ({ high: 'High', urgent: 'Urgent' }[k] || k),
  projectName: (id) => ({ p1: 'Ops' }[id] || id),
  teamName: (id) => id,
  personName: (e) => ({ 'sam@greensglobal.com': 'Sam Lee' }[e] || e),
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
