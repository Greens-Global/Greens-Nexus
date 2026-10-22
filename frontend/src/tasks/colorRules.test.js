import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  PALETTE, BUILTIN_FIELDS, CF_OPS, OP_KIND, colorHex, conditionMatches, conditionProblem, ruleProblems,
  draftProblem, usableRules, firstMatch, colorMap, describeRule, describeCondition, starterRules, fieldChoices,
  blankRule, MAX_CONDITIONS,
} from './colorRules';
import { NX } from './theme';

// Conditional row colors (Neil, Oct 22 2026) - the evaluator. Dates are the
// viewer's LOCAL day; "today" is passed in, as the screens pass todayISO().

const TODAY = '2026-10-22';
const ME = 'me@greensglobal.com';
const fields = [
  { id: 'stage', name: 'Stage', type: 'select', options: [{ id: 'o-a', label: 'Alpha' }, { id: 'o-b', label: 'Beta' }] },
  { id: 'labels', name: 'Labels', type: 'multiselect', options: [{ id: 'l-x', label: 'X' }, { id: 'l-y', label: 'Y' }] },
  { id: 'cost', name: 'Cost', type: 'number' },
  { id: 'signed', name: 'Signed', type: 'checkbox' },
  { id: 'notes', name: 'Notes', type: 'text' },
  { id: 'review', name: 'Review', type: 'date' },
  { id: 'owners', name: 'Owners', type: 'people' },
];
const statusMeta = {
  not_started: { label: 'Not Started' }, in_progress: { label: 'In Progress' }, completed: { label: 'Completed' },
  'cs-hold': { label: 'On Hold' },
};
const ctx = {
  today: TODAY, me: ME, statusMeta,
  fieldsById: new Map(fields.map((f) => [f.id, f])),
  sections: [{ id: 'sec-1', name: 'Annual' }],
  nameOf: (e) => ({ 'ana@greensglobal.com': 'Ana Diaz' }[e] || e),
};
const task = (over = {}) => ({
  id: over.id || 't', title: 'T', status: 'in_progress', priority: 'medium', completed: false,
  assigneeIds: [], tags: [], dueOn: '', startOn: '', sectionId: '', customFieldValues: {}, ...over,
});
const m = (c, t) => conditionMatches(c, t, ctx);

describe('built-in fields', () => {
  it('status and priority: is / is not / is any of', () => {
    const t = task({ status: 'cs-hold', priority: 'urgent' });
    expect(m({ field: 'status', op: 'is', value: 'cs-hold' }, t)).toBe(true);
    expect(m({ field: 'status', op: 'is_not', value: 'cs-hold' }, t)).toBe(false);
    expect(m({ field: 'status', op: 'is_any_of', value: ['in_progress', 'cs-hold'] }, t)).toBe(true);
    expect(m({ field: 'priority', op: 'is', value: 'urgent' }, t)).toBe(true);
    expect(m({ field: 'priority', op: 'is_not', value: 'high' }, t)).toBe(true);
    expect(m({ field: 'priority', op: 'is_any_of', value: ['low', 'high'] }, t)).toBe(false);
  });

  it('assignee: is me, is not me, a person, unassigned, assigned - across every assignee', () => {
    const shared = task({ assigneeIds: ['ana@greensglobal.com', 'ME@GreensGlobal.com'] });
    expect(m({ field: 'assignee', op: 'is_me' }, shared)).toBe(true);
    expect(m({ field: 'assignee', op: 'is_not_me' }, shared)).toBe(false);
    expect(m({ field: 'assignee', op: 'person_is', value: 'ana@greensglobal.com' }, shared)).toBe(true);
    expect(m({ field: 'assignee', op: 'person_is_not', value: 'ana@greensglobal.com' }, shared)).toBe(false);
    expect(m({ field: 'assignee', op: 'is_unassigned' }, task())).toBe(true);
    expect(m({ field: 'assignee', op: 'is_assigned' }, task())).toBe(false);
    // The older single-assignee mirror still counts.
    expect(m({ field: 'assignee', op: 'is_me' }, task({ assigneeId: ME }))).toBe(true);
  });

  it('"is me" is whoever is looking - and nobody when nobody is signed in', () => {
    const t = task({ assigneeIds: ['ana@greensglobal.com'] });
    expect(conditionMatches({ field: 'assignee', op: 'is_me' }, t, { ...ctx, me: 'ana@greensglobal.com' })).toBe(true);
    expect(conditionMatches({ field: 'assignee', op: 'is_me' }, t, { ...ctx, me: '' })).toBe(false);
  });

  it('created by reads the creator, else the owner', () => {
    expect(m({ field: 'created_by', op: 'is_me' }, task({ requesterId: ME }))).toBe(true);
    expect(m({ field: 'created_by', op: 'person_is', value: 'ana@greensglobal.com' }, task({ ownerId: 'ana@greensglobal.com' }))).toBe(true);
    expect(m({ field: 'created_by', op: 'person_is_not', value: ME }, task({ requesterId: ME }))).toBe(false);
  });

  it('tags: contains ignores case; empty / not empty', () => {
    const t = task({ tags: ['Urgent-Fix'] });
    expect(m({ field: 'tags', op: 'contains', value: 'urgent-fix' }, t)).toBe(true);
    expect(m({ field: 'tags', op: 'not_contains', value: 'urgent-fix' }, t)).toBe(false);
    expect(m({ field: 'tags', op: 'is_empty' }, task())).toBe(true);
    expect(m({ field: 'tags', op: 'is_not_empty' }, t)).toBe(true);
  });

  it('section: the project section, or the person\'s own through sectionOf', () => {
    expect(m({ field: 'section', op: 'is', value: 'sec-1' }, task({ sectionId: 'sec-1' }))).toBe(true);
    expect(m({ field: 'section', op: 'is_not', value: 'sec-1' }, task())).toBe(true);
    expect(m({ field: 'section', op: 'is_empty' }, task())).toBe(true);
    const mine = { ...ctx, sectionOf: (t) => (t.id === 'p1' ? 'sec-1' : '') };
    expect(conditionMatches({ field: 'section', op: 'is', value: 'sec-1' }, task({ id: 'p1' }), mine)).toBe(true);
  });

  it('completed', () => {
    expect(m({ field: 'completed', op: 'is_true' }, task({ completed: true }))).toBe(true);
    expect(m({ field: 'completed', op: 'is_false' }, task({ completed: true }))).toBe(false);
  });

  it('due date: overdue (open only), today, within N days, before / after / on, set / not set', () => {
    expect(m({ field: 'due', op: 'overdue' }, task({ dueOn: '2026-10-21' }))).toBe(true);
    expect(m({ field: 'due', op: 'overdue' }, task({ dueOn: '2026-10-21', completed: true }))).toBe(false);
    expect(m({ field: 'due', op: 'overdue' }, task({ dueOn: TODAY }))).toBe(false);
    expect(m({ field: 'due', op: 'today' }, task({ dueOn: TODAY }))).toBe(true);
    expect(m({ field: 'due', op: 'within', value: 7 }, task({ dueOn: '2026-10-29' }))).toBe(true);
    expect(m({ field: 'due', op: 'within', value: 7 }, task({ dueOn: '2026-10-30' }))).toBe(false);
    expect(m({ field: 'due', op: 'within', value: 7 }, task({ dueOn: '2026-10-21' }))).toBe(false);
    expect(m({ field: 'due', op: 'within', value: 0 }, task({ dueOn: TODAY }))).toBe(true);
    expect(m({ field: 'due', op: 'before', value: '2026-11-01' }, task({ dueOn: '2026-10-31' }))).toBe(true);
    expect(m({ field: 'due', op: 'after', value: '2026-11-01' }, task({ dueOn: '2026-10-31' }))).toBe(false);
    expect(m({ field: 'due', op: 'on', value: '2026-10-31' }, task({ dueOn: '2026-10-31T00:00:00' }))).toBe(true);
    expect(m({ field: 'due', op: 'before', value: '2026-11-01' }, task())).toBe(false);
    expect(m({ field: 'due', op: 'is_empty' }, task())).toBe(true);
    expect(m({ field: 'due', op: 'is_not_empty' }, task({ dueOn: TODAY }))).toBe(true);
  });

  it('start date: in the past, today, within', () => {
    expect(m({ field: 'start', op: 'past' }, task({ startOn: '2026-10-01' }))).toBe(true);
    expect(m({ field: 'start', op: 'today' }, task({ startOn: TODAY }))).toBe(true);
    expect(m({ field: 'start', op: 'within', value: 3 }, task({ startOn: '2026-10-24' }))).toBe(true);
    expect(m({ field: 'start', op: 'is_empty' }, task())).toBe(true);
  });
});

describe('custom fields', () => {
  const cf = (id, values) => task({ customFieldValues: values });
  it('select: is / is not / any of / empty', () => {
    const t = cf('stage', { stage: 'o-a' });
    expect(m({ field: 'cf:stage', op: 'is', value: 'o-a' }, t)).toBe(true);
    expect(m({ field: 'cf:stage', op: 'is_not', value: 'o-a' }, t)).toBe(false);
    expect(m({ field: 'cf:stage', op: 'is_any_of', value: ['o-b', 'o-a'] }, t)).toBe(true);
    expect(m({ field: 'cf:stage', op: 'is_empty' }, task())).toBe(true);
    expect(m({ field: 'cf:stage', op: 'is_not_empty' }, t)).toBe(true);
  });
  it('multiselect: contains / does not contain', () => {
    const t = cf('labels', { labels: ['l-x'] });
    expect(m({ field: 'cf:labels', op: 'contains', value: 'l-x' }, t)).toBe(true);
    expect(m({ field: 'cf:labels', op: 'not_contains', value: 'l-x' }, t)).toBe(false);
    expect(m({ field: 'cf:labels', op: 'is_empty' }, cf('labels', { labels: [] }))).toBe(true);
  });
  it('number: = != > >= < <= between, and blank matches no comparison', () => {
    const t = cf('cost', { cost: 10 });
    expect(m({ field: 'cf:cost', op: 'eq', value: 10 }, t)).toBe(true);
    expect(m({ field: 'cf:cost', op: 'ne', value: 10 }, t)).toBe(false);
    expect(m({ field: 'cf:cost', op: 'gt', value: 9 }, t)).toBe(true);
    expect(m({ field: 'cf:cost', op: 'gte', value: 10 }, t)).toBe(true);
    expect(m({ field: 'cf:cost', op: 'lt', value: 10 }, t)).toBe(false);
    expect(m({ field: 'cf:cost', op: 'lte', value: 10 }, t)).toBe(true);
    expect(m({ field: 'cf:cost', op: 'between', value: [12, 5] }, t)).toBe(true);
    expect(m({ field: 'cf:cost', op: 'ne', value: 10 }, task())).toBe(false);
    expect(m({ field: 'cf:cost', op: 'is_empty' }, task())).toBe(true);
  });
  it('checkbox: checked / unchecked (missing is unchecked)', () => {
    expect(m({ field: 'cf:signed', op: 'is_true' }, cf('signed', { signed: true }))).toBe(true);
    expect(m({ field: 'cf:signed', op: 'is_false' }, task())).toBe(true);
  });
  it('text: contains (any case) / does not contain / empty', () => {
    const t = cf('notes', { notes: 'Waiting on City permit' });
    expect(m({ field: 'cf:notes', op: 'contains', value: 'city' }, t)).toBe(true);
    expect(m({ field: 'cf:notes', op: 'not_contains', value: 'city' }, t)).toBe(false);
    expect(m({ field: 'cf:notes', op: 'is_empty' }, task())).toBe(true);
  });
  it('date: like the due date', () => {
    expect(m({ field: 'cf:review', op: 'overdue' }, cf('review', { review: '2026-10-01' }))).toBe(true);
    expect(m({ field: 'cf:review', op: 'today' }, cf('review', { review: TODAY }))).toBe(true);
    expect(m({ field: 'cf:review', op: 'is_empty' }, task())).toBe(true);
  });
  it('people: includes a person / includes me / empty', () => {
    const t = cf('owners', { owners: ['ana@greensglobal.com', ME] });
    expect(m({ field: 'cf:owners', op: 'person_contains', value: 'ana@greensglobal.com' }, t)).toBe(true);
    expect(m({ field: 'cf:owners', op: 'is_me' }, t)).toBe(true);
    expect(m({ field: 'cf:owners', op: 'is_empty' }, task())).toBe(true);
  });
  it('every operator the server knows has a value kind here', () => {
    for (const f of BUILTIN_FIELDS) for (const op of f.ops) expect(OP_KIND[op]).toBeDefined();
    for (const ops of Object.values(CF_OPS)) for (const op of ops) expect(OP_KIND[op]).toBeDefined();
  });
});

describe('rules', () => {
  const overdue = { id: 'r1', name: 'Overdue', color: 'red', match: 'all', conditions: [{ field: 'due', op: 'overdue' }] };
  const urgent = { id: 'r2', name: 'Urgent', color: 'amber', match: 'all', conditions: [{ field: 'priority', op: 'is', value: 'urgent' }] };

  it('the first enabled matching rule wins', () => {
    const t = task({ id: 'a', dueOn: '2026-10-01', priority: 'urgent' });
    expect(colorMap([overdue, urgent], [t], ctx).get('a').id).toBe('r1');
    expect(colorMap([urgent, overdue], [t], ctx).get('a').id).toBe('r2');
    expect(colorMap([urgent, overdue], [t], ctx).get('a').hex).toBe(NX.amber);
  });

  it('a disabled rule is skipped, not the end of the list', () => {
    const t = task({ id: 'a', dueOn: '2026-10-01', priority: 'urgent' });
    expect(colorMap([{ ...overdue, enabled: false }, urgent], [t], ctx).get('a').id).toBe('r2');
  });

  it('all vs any', () => {
    const both = { id: 'r3', name: 'Both', color: 'red', match: 'all', conditions: [...overdue.conditions, ...urgent.conditions] };
    const t = task({ id: 'a', dueOn: '2026-10-01', priority: 'low' });
    expect(colorMap([both], [t], ctx).has('a')).toBe(false);
    expect(colorMap([{ ...both, match: 'any' }], [t], ctx).has('a')).toBe(true);
  });

  it('a rule on a deleted field, option, status or section needs attention and never matches', () => {
    const t = task({ id: 'a', status: 'gone', customFieldValues: { stage: 'o-zz', ghost: 'x' }, sectionId: 'sec-old' });
    const broken = [
      { field: 'cf:ghost', op: 'is_not_empty' },
      { field: 'cf:stage', op: 'is', value: 'o-zz' },
      { field: 'status', op: 'is', value: 'gone' },
      { field: 'section', op: 'is', value: 'sec-old' },
    ];
    for (const c of broken) {
      const rule = { id: 'x', name: 'X', color: 'red', match: 'any', conditions: [c, { field: 'completed', op: 'is_false' }] };
      expect(conditionProblem(c, ctx)).not.toBe('');
      expect(ruleProblems(rule, ctx)).toHaveLength(1);
      // The OTHER condition would match on its own - the rule still stays off.
      expect(usableRules([rule], ctx)).toHaveLength(0);
      expect(colorMap([rule], [t], ctx).size).toBe(0);
    }
    expect(conditionProblem({ field: 'cf:ghost', op: 'is_not_empty' }, ctx)).toBe('The field this uses was deleted.');
  });

  it('an operator that no longer fits the field (its type changed) needs attention', () => {
    expect(conditionProblem({ field: 'cf:cost', op: 'contains', value: 'x' }, ctx)).toMatch(/no longer fits/);
  });

  it('sections are not judged where there are none to judge against (null)', () => {
    expect(conditionProblem({ field: 'section', op: 'is', value: 'anything' }, { ...ctx, sections: null })).toBe('');
  });

  it('a section row and a missing task never color', () => {
    expect(firstMatch(usableRules([overdue], ctx), { type: 'section', dueOn: '2020-01-01' }, ctx)).toBe(null);
    expect(firstMatch(usableRules([overdue], ctx), null, ctx)).toBe(null);
  });

  it('junk in the stored list is ignored rather than thrown on', () => {
    expect(colorMap([null, { id: 'z' }, 'x', overdue], [task({ id: 'a', dueOn: '2020-01-01' })], ctx).get('a').id).toBe('r1');
    expect(colorMap(undefined, [task()], ctx).size).toBe(0);
  });
});

describe('local dates around midnight', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('just before and just after local midnight, "today" is the local day', async () => {
    const { todayISO } = await import('./lib');
    const rule = { id: 'r', name: 'Today', color: 'teal', match: 'all', conditions: [{ field: 'due', op: 'today' }] };
    const due22 = task({ id: 'a', dueOn: '2026-10-22' });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 22, 23, 59, 30));   // 11:59:30 PM local, Oct 22
    expect(todayISO()).toBe('2026-10-22');
    expect(colorMap([rule], [due22], { ...ctx, today: todayISO() }).has('a')).toBe(true);
    vi.setSystemTime(new Date(2026, 9, 23, 0, 0, 30));     // 12:00:30 AM local, Oct 23
    expect(todayISO()).toBe('2026-10-23');
    expect(colorMap([rule], [due22], { ...ctx, today: todayISO() }).has('a')).toBe(false);
    const overdue = { ...rule, conditions: [{ field: 'due', op: 'overdue' }] };
    expect(colorMap([overdue], [due22], { ...ctx, today: todayISO() }).has('a')).toBe(true);
  });
});

describe('wording', () => {
  it('reads as a sentence', () => {
    const rule = { match: 'all', conditions: [{ field: 'priority', op: 'is', value: 'urgent' }, { field: 'due', op: 'overdue' }] };
    expect(describeRule(rule, ctx)).toBe('Priority is Urgent and Due Date is overdue');
    expect(describeRule({ ...rule, match: 'any' }, ctx)).toBe('Priority is Urgent or Due Date is overdue');
  });

  it('names people, options, sections and US dates', () => {
    expect(describeCondition({ field: 'assignee', op: 'person_is', value: 'ana@greensglobal.com' }, ctx)).toBe('Assignee is Ana Diaz');
    expect(describeCondition({ field: 'cf:stage', op: 'is_any_of', value: ['o-a', 'o-b'] }, ctx)).toBe('Stage is any of Alpha or Beta');
    expect(describeCondition({ field: 'section', op: 'is', value: 'sec-1' }, ctx)).toBe('Section is Annual');
    expect(describeCondition({ field: 'due', op: 'before', value: '2026-11-03' }, ctx)).toBe('Due Date is before 11/03/2026');
    expect(describeCondition({ field: 'due', op: 'within', value: 7 }, ctx)).toBe('Due Date is within the next 7 days');
    expect(describeCondition({ field: 'completed', op: 'is_false' }, ctx)).toBe('Task is not completed');
    expect(describeCondition({ field: 'cf:cost', op: 'between', value: [1, 5] }, ctx)).toBe('Cost is between 1 and 5');
    expect(describeCondition({ field: 'cf:ghost', op: 'is_empty' }, ctx)).toBe('A deleted field');
  });

  it('the editor refuses a draft with no name, no conditions, too many, or a blank value', () => {
    expect(draftProblem({ ...blankRule(), name: '' }, ctx)).toBe('Give the rule a name.');
    expect(draftProblem({ ...blankRule(), name: 'X', conditions: [] }, ctx)).toBe('Add at least one condition.');
    expect(draftProblem({ ...blankRule(), name: 'X', conditions: Array(MAX_CONDITIONS + 1).fill({ field: 'due', op: 'overdue' }) }, ctx)).toMatch(/At most/);
    expect(draftProblem({ ...blankRule(), name: 'X', conditions: [{ field: 'status', op: 'is', value: '' }] }, ctx)).toBe('Condition 1: Pick a value.');
    expect(draftProblem({ ...blankRule(), name: 'X' }, ctx)).toBe('');
  });
});

describe('palette and starters', () => {
  it('seven palette colors from the app tokens - no blue, which is what a selected row looks like; unknown -> gray', () => {
    expect(PALETTE).toHaveLength(7);
    expect(PALETTE.map((p) => p.key)).not.toContain('blue');
    expect(colorHex('red')).toBe(NX.red);
    expect(colorHex('nope')).toBe('#64748b');
  });

  it('three suggestions; the third uses a held-up status when the project has one', () => {
    const plain = starterRules({ statusOrder: ['not_started', 'in_progress'], statusMeta });
    expect(plain.map((r) => r.name)).toEqual(['Overdue', 'Due This Week', 'Unassigned']);
    expect(plain.map((r) => r.color)).toEqual(['red', 'amber', 'gray']);
    const held = starterRules({ statusOrder: ['in_progress', 'cs-hold'], statusMeta });
    expect(held[2]).toMatchObject({ name: 'On Hold', conditions: [{ field: 'status', op: 'is', value: 'cs-hold' }] });
    // Every suggestion is a valid rule here.
    for (const r of [...plain, ...held]) expect(ruleProblems(r, ctx)).toEqual([]);
  });

  it('offers Section only where there are sections, and custom fields of known types', () => {
    const keys = fieldChoices({ customFields: [...fields, { id: 'weird', name: 'W', type: 'formula' }], sections: [] }).map((f) => f.key);
    expect(keys).not.toContain('section');
    expect(keys).toContain('cf:stage');
    expect(keys).not.toContain('cf:weird');
    expect(fieldChoices({ sections: [{ id: 's' }] }).map((f) => f.key)).toContain('section');
  });
});
