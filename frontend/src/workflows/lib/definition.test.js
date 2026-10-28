// The workflow definition helpers are pure: every edit returns a new object
// and leaves the old one alone, and `problems` mirrors the Publish checks.
import { describe, it, expect } from 'vitest';
import {
  emptyDefinition, newStep, insertStep, removeStep, moveStep, toggleStep, updateStep,
  pathOf, lanesOf, countSteps, problems, templatePaths, unknownTemplatePaths, normalizeDefinition,
} from './definition';

const catalog = {
  entities: [{
    key: 'employee', label: 'Person', module: 'hr',
    fields: [
      { key: 'name', label: 'Name', type: 'text', visibility: 'all' },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }], visibility: 'all' },
      { key: 'start_date', label: 'Start Date', type: 'date', visibility: 'all' },
    ],
    dates: [{ key: 'start_date', label: 'Start Date', yearly: false }],
    people: [{ key: 'self', label: 'The Person' }, { key: 'manager', label: 'Their Manager' }],
  }],
  events: [{ key: 'hr.employee.status_changed', entity: 'employee', label: 'Status Changes', module: 'hr', group: 'People', changes: ['status'], volume: 'normal' }],
  actions: [{
    key: 'notify', label: 'Send A Notification', module: 'core', needsPerson: true, adminOnly: false,
    params: [
      { key: 'to', label: 'To', type: 'recipients', required: true },
      { key: 'title', label: 'Title', type: 'template', required: true, max: 120 },
      { key: 'body', label: 'Message', type: 'template', required: false },
    ],
  }],
  listSources: [{ key: 'direct_reports', label: 'Direct Reports', entity: 'employee', module: 'hr', params: [] }],
  operators: { text: [{ key: 'is', label: 'is' }] },
  filters: [{ key: 'us_date', label: 'As A Date' }],
  newSince: [],
};

const notifyDef = catalog.actions[0];

function sample() {
  let d = emptyDefinition({ kind: 'event', event: 'hr.employee.status_changed', filters: [] });
  const step = newStep('action', notifyDef);
  step.params = { to: [{ kind: 'manager' }], title: 'Hello {{ subject.name }}', body: '' };
  d = insertStep(d, ['steps'], step);
  return d;
}

describe('newStep', () => {
  it('gives every step its own id and seeds the params', () => {
    const a = newStep('action', notifyDef);
    const b = newStep('action', notifyDef);
    expect(a.id).not.toBe(b.id);
    expect(a.params).toEqual({ to: [], title: '', body: '' });
    expect(a.enabled).toBe(true);
    const ap = newStep('approval');
    expect(ap.params.options).toEqual(['Approve', 'Decline']);
    expect(Object.keys(ap.branches)).toEqual(['Approve', 'Decline', 'expired']);
    expect(lanesOf(ap).map((l) => l.label)).toEqual(['Approve', 'Decline', 'If Nobody Answers']);
  });
});

describe('lane edits are pure', () => {
  it('insert, move, toggle and remove return new objects and keep the old one', () => {
    const d0 = sample();
    const first = d0.steps[0];
    const wait = newStep('wait');
    const d1 = insertStep(d0, ['steps'], wait, 0);
    expect(d0.steps).toHaveLength(1);
    expect(d1.steps.map((s) => s.kind)).toEqual(['wait', 'action']);
    expect(d1).not.toBe(d0);
    expect(d1.settings).toBe(d0.settings);          // untouched branches are shared, not copied

    const d2 = moveStep(d1, ['steps'], 0, 1);
    expect(d2.steps.map((s) => s.kind)).toEqual(['action', 'wait']);
    expect(d1.steps.map((s) => s.kind)).toEqual(['wait', 'action']);

    const d3 = toggleStep(d2, ['steps'], 1);
    expect(d3.steps[1].enabled).toBe(false);
    expect(d2.steps[1].enabled).toBe(true);
    expect(toggleStep(d3, ['steps'], 1).steps[1].enabled).toBe(true);

    const d4 = removeStep(d3, ['steps'], 1);
    expect(d4.steps).toHaveLength(1);
    expect(d4.steps[0]).toBe(first);
    expect(d3.steps).toHaveLength(2);

    expect(moveStep(d4, ['steps'], 0, 5)).toBe(d4);  // out of range: the same object back
  });

  it('edits inside a branch lane and finds the step again', () => {
    const d0 = sample();
    const iff = newStep('if');
    const d1 = insertStep(d0, ['steps'], iff);
    const stop = newStep('stop');
    const d2 = insertStep(d1, ['steps', 1, 'then'], stop);
    expect(d2.steps[1].then).toEqual([stop]);
    expect(d1.steps[1].then).toEqual([]);
    expect(pathOf(d2, stop.id)).toEqual({ lanePath: ['steps', 1, 'then'], index: 0 });
    expect(countSteps(d2)).toBe(3);
    const d3 = updateStep(d2, ['steps', 1, 'then'], 0, { enabled: false });
    expect(d3.steps[1].then[0].enabled).toBe(false);
    expect(d2.steps[1].then[0].enabled).toBe(true);
    expect(pathOf(d3, 'nope')).toBeNull();
  });
});

describe('templatePaths', () => {
  it('offers the subject fields, the event changes and the context', () => {
    const paths = templatePaths(catalog.entities[0], catalog.events[0]).map((p) => p.path);
    expect(paths).toContain('subject.name');
    expect(paths).toContain('subject.link');
    expect(paths).toContain('change.status.from');
    expect(paths).toContain('change.status.to');
    expect(paths).toContain('actor.name');
    expect(paths).toContain('today');
    expect(unknownTemplatePaths('{{ subject.name | upper }} {{ subject.pay }} {{ item.name }}', paths, ['item'])).toEqual(['subject.pay']);
  });
});

describe('problems', () => {
  it('is clean for a complete workflow', () => {
    expect(problems(sample(), catalog)).toEqual([]);
  });

  it('names a missing required param', () => {
    const d = sample();
    d.steps[0].params.to = [];
    const list = problems(d, catalog);
    expect(list).toEqual([{ path: 'steps.0.to', message: 'To is required' }]);
  });

  it('names a missing approval branch', () => {
    let d = sample();
    const ap = newStep('approval');
    ap.params.approvers = [{ kind: 'manager' }];
    ap.params.question = 'OK to proceed?';
    ap.params.options = ['Approve', 'Decline', 'Hold'];
    d = insertStep(d, ['steps'], ap);
    const list = problems(d, catalog);
    expect(list.map((p) => p.message)).toEqual(['Ask For Approval has no branch for "Hold"']);
  });

  it('names an unknown template path', () => {
    const d = sample();
    d.steps[0].params.title = 'Pay is {{ subject.pay }}';
    const list = problems(d, catalog);
    expect(list).toEqual([{ path: 'steps.0.title', message: '"{{ subject.pay }}" is not a field of Person' }]);
  });

  it('skips a skipped step and reports the trigger', () => {
    const d = sample();
    d.steps[0].params.to = [];
    d.steps[0].enabled = false;
    d.trigger = { kind: 'event', event: '', filters: [] };
    expect(problems(d, catalog)).toEqual([{ path: 'trigger', message: 'Choose what starts this workflow' }]);
  });
});

describe('normalizeDefinition', () => {
  it('fills what a partial draft is missing', () => {
    const d = normalizeDefinition({ trigger: { kind: 'manual', entity: 'employee' } });
    expect(d.v).toBe(1);
    expect(d.conditions).toEqual([]);
    expect(d.steps).toEqual([]);
    expect(d.settings.maxRunsPerHour).toBe(100);
    expect(d.settings.faultSteps).toEqual([]);
  });
});
