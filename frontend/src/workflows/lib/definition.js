// The workflow definition, as pure functions (Oct 2026). Nothing here touches
// React or the API: the builder's cards call these and render what comes
// back, and the same checks the backend runs on Publish are mirrored in
// `problems` so the Publish button can say what is missing before the round
// trip. Shapes are pinned in docs/superpowers/plans/2026-10-28-workflows.md
// (Task 1) and never change without a migration note.
//
// A "lane" is one ordered list of steps: the root `steps`, an If's `then` /
// `else`, an approval's `branches.<option>`, a For Each's `steps` or the
// settings' `faultSteps`. A lane is addressed by its path from the
// definition root, e.g. ['steps'], ['steps', 2, 'then'],
// ['steps', 0, 'branches', 'Approve'], ['settings', 'faultSteps'].

export const DEFAULT_OPTIONS = ['Approve', 'Decline'];

export const STEP_KINDS = {
  action:   { label: 'Action' },
  if:       { label: 'If / Else' },
  approval: { label: 'Ask For Approval' },
  wait:     { label: 'Wait' },
  for_each: { label: 'For Each' },
  stop:     { label: 'Stop' },
};

// Operators that take no value.
export const NO_VALUE_OPS = new Set(['is_empty', 'is_not_empty', 'changed']);
// Operators whose value is a list.
export const LIST_OPS = new Set(['is_any_of']);
// Operators whose value is a number of days.
export const DAYS_OPS = new Set(['within_next_days', 'within_last_days']);

export function uid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultSettings() {
  return {
    oncePerSubject: false, cooldownHours: 0, suppress: { people: [], companies: [] }, logSkips: false,
    allowDownstream: false, maxRunsPerHour: 100, maxRecipients: 50, onError: 'stop', faultSteps: [],
  };
}

export function emptyDefinition(trigger) {
  return {
    v: 1,
    trigger: trigger || { kind: 'event', event: '', filters: [] },
    conditions: [],
    steps: [],
    settings: defaultSettings(),
  };
}

// A definition read from the server may be missing pieces (an old draft, a
// Describe It answer); fill them so every card has something to render.
export function normalizeDefinition(def) {
  const d = def && typeof def === 'object' ? def : {};
  const settings = { ...defaultSettings(), ...(d.settings || {}) };
  settings.suppress = { people: [], companies: [], ...(settings.suppress || {}) };
  settings.faultSteps = Array.isArray(settings.faultSteps) ? settings.faultSteps : [];
  return {
    v: 1,
    trigger: d.trigger && d.trigger.kind ? d.trigger : { kind: 'event', event: '', filters: [] },
    conditions: Array.isArray(d.conditions) ? d.conditions : [],
    steps: Array.isArray(d.steps) ? d.steps : [],
    settings,
  };
}

export function defaultParamValue(param) {
  if (param.default !== undefined && param.default !== null) return param.default;
  switch (param.type) {
    case 'number': case 'duration': return 0;
    case 'bool': return false;
    case 'recipients': case 'approvers': case 'options': return [];
    case 'date_offset': return { field: '', offsetDays: 0, time: '08:00' };
    case 'list_source': return { key: '', params: {} };
    default: return '';
  }
}

// `actionDef` (from the catalog) seeds the params with their defaults so a
// fresh step renders every control with a value.
export function newStep(kind, actionDef) {
  const id = uid();
  switch (kind) {
    case 'action': {
      const params = {};
      (actionDef?.params || []).forEach((p) => { params[p.key] = defaultParamValue(p); });
      return { id, kind: 'action', action: actionDef?.key || '', params, enabled: true };
    }
    case 'if':
      return { id, kind: 'if', conditions: [[{ field: '', op: '', value: '' }]], then: [], else: [], enabled: true };
    case 'approval':
      return {
        id, kind: 'approval',
        params: { approvers: [], mode: 'any', question: '', options: DEFAULT_OPTIONS.slice(), remindDays: 2, expireDays: 7, allowSelf: false },
        branches: { Approve: [], Decline: [], expired: [] },
        enabled: true,
      };
    case 'wait':
      return { id, kind: 'wait', params: { mode: 'duration', minutes: 60, field: '', offsetDays: 0 }, enabled: true };
    case 'for_each':
      return { id, kind: 'for_each', source: { key: '', params: {} }, as: 'item', steps: [], enabled: true };
    case 'stop':
      return { id, kind: 'stop', enabled: true };
    default:
      throw new Error(`Unknown step kind: ${kind}`);
  }
}

// ── Lanes ──────────────────────────────────────────────────────────────────

function getAt(obj, path) {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Returns a copy of `obj` with `path` replaced by `value`; every container on
// the way is copied, nothing else is touched.
function setAt(obj, path, value) {
  if (!path.length) return value;
  const [k, ...rest] = path;
  const copy = Array.isArray(obj) ? obj.slice() : { ...(obj || {}) };
  copy[k] = setAt(obj == null ? undefined : obj[k], rest, value);
  return copy;
}

export function getLane(definition, lanePath) {
  const lane = getAt(definition, lanePath);
  return Array.isArray(lane) ? lane : [];
}

export function setLane(definition, lanePath, steps) {
  // A lane that did not change hands the same definition back, so a no-op
  // edit (a move out of range) never marks the workflow dirty.
  if (getAt(definition, lanePath) === steps) return definition;
  return setAt(definition, lanePath, steps);
}

// Array-level helpers (pure): the StepList works on one lane at a time.
export function insertAt(steps, step, index = steps.length) {
  const next = steps.slice();
  const at = Math.max(0, Math.min(index, next.length));
  next.splice(at, 0, step);
  return next;
}
export function removeAt(steps, index) {
  if (index < 0 || index >= steps.length) return steps;
  return steps.filter((_, i) => i !== index);
}
export function moveAt(steps, from, to) {
  if (from < 0 || from >= steps.length || to < 0 || to >= steps.length || from === to) return steps;
  const next = steps.slice();
  const [s] = next.splice(from, 1);
  next.splice(to, 0, s);
  return next;
}
export function toggleAt(steps, index) {
  if (index < 0 || index >= steps.length) return steps;
  return steps.map((s, i) => (i === index ? { ...s, enabled: s.enabled === false } : s));
}
export function patchAt(steps, index, patch) {
  if (index < 0 || index >= steps.length) return steps;
  return steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
}

// Definition-level helpers: a new definition each time, the old one untouched.
export function insertStep(definition, lanePath, step, index) {
  const lane = getLane(definition, lanePath);
  return setLane(definition, lanePath, insertAt(lane, step, index === undefined ? lane.length : index));
}
export function removeStep(definition, lanePath, index) {
  return setLane(definition, lanePath, removeAt(getLane(definition, lanePath), index));
}
export function moveStep(definition, lanePath, from, to) {
  return setLane(definition, lanePath, moveAt(getLane(definition, lanePath), from, to));
}
export function toggleStep(definition, lanePath, index) {
  return setLane(definition, lanePath, toggleAt(getLane(definition, lanePath), index));
}
export function updateStep(definition, lanePath, index, patch) {
  return setLane(definition, lanePath, patchAt(getLane(definition, lanePath), index, patch));
}

// The lanes nested inside one step: [{key, label, path (relative to the step)}].
export function lanesOf(step) {
  if (!step) return [];
  if (step.kind === 'if') return [{ key: 'then', label: 'Then', path: ['then'] }, { key: 'else', label: 'Otherwise', path: ['else'] }];
  if (step.kind === 'approval') {
    const options = Array.isArray(step.params?.options) && step.params.options.length ? step.params.options : DEFAULT_OPTIONS;
    return [
      ...options.map((o) => ({ key: o, label: o, path: ['branches', o] })),
      { key: 'expired', label: 'If Nobody Answers', path: ['branches', 'expired'] },
    ];
  }
  if (step.kind === 'for_each') return [{ key: 'steps', label: `For each ${step.as || 'item'}`, path: ['steps'] }];
  return [];
}

// Visits every step in the definition, depth first, with its lane path and index.
export function walkSteps(definition, fn) {
  const visit = (lanePath) => {
    const lane = getLane(definition, lanePath);
    lane.forEach((step, index) => {
      fn(step, lanePath, index);
      lanesOf(step).forEach((l) => visit([...lanePath, index, ...l.path]));
    });
  };
  visit(['steps']);
  visit(['settings', 'faultSteps']);
}

// Where a step lives: {lanePath, index} or null.
export function pathOf(definition, stepId) {
  let found = null;
  walkSteps(definition, (step, lanePath, index) => { if (!found && step.id === stepId) found = { lanePath, index }; });
  return found;
}

export function countSteps(definition) {
  let n = 0;
  walkSteps(definition, () => { n += 1; });
  return n;
}

// ── Catalog lookups ────────────────────────────────────────────────────────

export const findEntity = (catalog, key) => (catalog?.entities || []).find((e) => e.key === key) || null;
export const findEvent = (catalog, key) => (catalog?.events || []).find((e) => e.key === key) || null;
export const findAction = (catalog, key) => (catalog?.actions || []).find((a) => a.key === key) || null;
export const findListSource = (catalog, key) => (catalog?.listSources || []).find((s) => s.key === key) || null;

// The entity a workflow is about, from its trigger.
export function triggerEntityKey(trigger, catalog) {
  if (!trigger) return '';
  if (trigger.kind === 'event') return findEvent(catalog, trigger.event)?.entity || '';
  if (trigger.kind === 'schedule') return trigger.entity || '';
  return trigger.entity || '';
}
export function triggerEntity(definition, catalog) {
  return findEntity(catalog, triggerEntityKey(definition?.trigger, catalog));
}

export function operatorsFor(catalog, type) {
  const ops = catalog?.operators?.[type] || catalog?.operators?.text || [];
  return ops;
}

// Template paths a text box may insert for this trigger: subject fields,
// change.<field>.from / to for the event's changes, actor, today, the link.
export function templatePaths(entityDef, eventDef) {
  const out = [];
  (entityDef?.fields || []).forEach((f) => out.push({ path: `subject.${f.key}`, label: f.label, group: entityDef.label || 'Record' }));
  out.push({ path: 'subject.link', label: 'Link To The Record', group: entityDef?.label || 'Record' });
  (eventDef?.changes || []).forEach((k) => {
    const label = (entityDef?.fields || []).find((f) => f.key === k)?.label || k;
    out.push({ path: `change.${k}.from`, label: `${label} (Before)`, group: 'Change' });
    out.push({ path: `change.${k}.to`, label: `${label} (After)`, group: 'Change' });
  });
  out.push({ path: 'actor.name', label: 'Who Did It (Name)', group: 'Context' });
  out.push({ path: 'actor.email', label: 'Who Did It (Email)', group: 'Context' });
  out.push({ path: 'today', label: 'Today', group: 'Context' });
  return out;
}

const TEMPLATE_RE = /\{\{\s*([^}|]+?)\s*(\|[^}]*)?\}\}/g;

// Every `{{ path }}` in a text, filters stripped.
export function templateRefs(text) {
  const refs = [];
  String(text || '').replace(TEMPLATE_RE, (_, path) => { refs.push(path.trim()); return ''; });
  return refs;
}

// A For Each lane may also read `{{ item.* }}` - allowed under any name the
// loop uses (`as`).
export function unknownTemplatePaths(text, allowed, loopNames = []) {
  const ok = new Set(allowed.map((p) => (typeof p === 'string' ? p : p.path)));
  return templateRefs(text).filter((ref) => {
    if (ok.has(ref)) return false;
    const head = ref.split('.')[0];
    return !loopNames.includes(head);
  });
}

// ── Validation ─────────────────────────────────────────────────────────────

export const isBlank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

function conditionProblems(groups, prefix, push) {
  (groups || []).forEach((group, g) => {
    (group || []).forEach((row, r) => {
      const at = `${prefix}[${g}][${r}]`;
      if (isBlank(row?.field)) push(at, 'Pick a field for this condition');
      else if (isBlank(row?.op)) push(at, 'Pick how to compare it');
      else if (!NO_VALUE_OPS.has(row.op) && isBlank(row.value)) push(at, 'Enter a value to compare with');
    });
  });
}

export function problems(definition, catalog) {
  const out = [];
  const push = (path, message) => out.push({ path, message });
  const def = definition || {};
  const trigger = def.trigger || {};
  const entityDef = triggerEntity(def, catalog);
  const eventDef = trigger.kind === 'event' ? findEvent(catalog, trigger.event) : null;

  if (trigger.kind === 'event') {
    if (isBlank(trigger.event)) push('trigger', 'Choose what starts this workflow');
    else if (catalog && !eventDef) push('trigger', `The trigger "${trigger.event}" is no longer available`);
    conditionProblems([trigger.filters || []], 'trigger.filters', (p, m) => push(p.replace('[0]', ''), m));
  } else if (trigger.kind === 'schedule') {
    if (!['day', 'week', 'month'].includes(trigger.every)) push('trigger', 'Choose how often it runs');
    if ((trigger.every === 'week' || trigger.every === 'month') && isBlank(trigger.days)) push('trigger', 'Pick at least one day');
    if (!/^\d{2}:\d{2}$/.test(trigger.time || '')) push('trigger', 'Pick a time');
  } else if (trigger.kind === 'date') {
    if (isBlank(trigger.entity)) push('trigger', 'Choose what kind of record');
    else if (catalog && !entityDef) push('trigger', `"${trigger.entity}" is no longer available`);
    if (isBlank(trigger.field)) push('trigger', 'Choose which date');
    else if (entityDef && !(entityDef.dates || []).some((d) => d.key === trigger.field)) push('trigger', `"${trigger.field}" is not a date of ${entityDef.label}`);
    if (!/^\d{2}:\d{2}$/.test(trigger.time || '')) push('trigger', 'Pick a time');
  } else if (trigger.kind === 'manual') {
    if (isBlank(trigger.entity)) push('trigger', 'Choose what kind of record it runs on');
    else if (catalog && !entityDef) push('trigger', `"${trigger.entity}" is no longer available`);
  } else {
    push('trigger', 'Choose a trigger');
  }

  conditionProblems(def.conditions, 'conditions', push);

  const allowed = templatePaths(entityDef, eventDef);
  const entityLabel = entityDef?.label || 'this record';
  const loopsAt = (lanePath) => {
    // Names of the For Each loops this lane sits inside.
    const names = [];
    for (let i = 0; i + 1 < lanePath.length; i += 1) {
      if (typeof lanePath[i + 1] === 'number') {
        const step = getAt(def, lanePath.slice(0, i + 2));
        if (step?.kind === 'for_each') names.push(step.as || 'item');
      }
    }
    return names;
  };
  const checkTemplate = (text, at, loops) => {
    unknownTemplatePaths(text, allowed, loops).forEach((ref) => push(at, `"{{ ${ref} }}" is not a field of ${entityLabel}`));
  };

  walkSteps(def, (step, lanePath, index) => {
    const at = [...lanePath, index].join('.');
    const loops = loopsAt(lanePath);
    if (step.enabled === false) return;
    if (step.kind === 'action') {
      const actionDef = findAction(catalog, step.action);
      if (isBlank(step.action)) { push(at, 'Choose what this step does'); return; }
      if (catalog && !actionDef) { push(at, `The action "${step.action}" is no longer available`); return; }
      (actionDef?.params || []).forEach((p) => {
        const v = step.params?.[p.key];
        const label = p.label || p.key;
        if (p.required !== false && isBlank(v) && p.type !== 'bool') push(`${at}.${p.key}`, `${label} is required`);
        else if (p.type === 'template') checkTemplate(v, `${at}.${p.key}`, loops);
        else if (p.type === 'date_offset' && v && isBlank(v.field) && p.required !== false) push(`${at}.${p.key}`, `${label}: choose which date`);
        else if (p.type === 'list_source' && v && isBlank(v.key) && p.required !== false) push(`${at}.${p.key}`, `${label}: choose a list`);
        if (p.type === 'template' && p.max && String(v || '').length > p.max) push(`${at}.${p.key}`, `${label} is over ${p.max} characters`);
      });
    } else if (step.kind === 'if') {
      const groups = Array.isArray(step.conditions) ? step.conditions : [];
      if (!groups.some((g) => (g || []).length)) push(at, 'Add at least one condition to the If');
      conditionProblems(groups, `${at}.conditions`, push);
    } else if (step.kind === 'approval') {
      const p = step.params || {};
      if (isBlank(p.approvers)) push(`${at}.approvers`, 'Choose who approves');
      if (isBlank(p.question)) push(`${at}.question`, 'Write the question the approvers see');
      else checkTemplate(p.question, `${at}.question`, loops);
      const options = Array.isArray(p.options) && p.options.length ? p.options : [];
      if (options.length < 2) push(`${at}.options`, 'Give the approvers at least two options');
      options.forEach((o) => {
        if (!Array.isArray(step.branches?.[o])) push(`${at}.branches.${o}`, `Ask For Approval has no branch for "${o}"`);
      });
    } else if (step.kind === 'wait') {
      const p = step.params || {};
      if (p.mode === 'duration' && !(Number(p.minutes) > 0)) push(at, 'Wait needs a length of time');
      else if (p.mode === 'until' && isBlank(p.field)) push(at, 'Wait needs a date to wait for');
      else if (!['duration', 'until', 'business_morning'].includes(p.mode)) push(at, 'Choose how long to wait');
    } else if (step.kind === 'for_each') {
      if (isBlank(step.source?.key)) push(at, 'Choose the list to go through');
      else if (catalog && !findListSource(catalog, step.source.key)) push(at, `The list "${step.source.key}" is no longer available`);
      if (!(step.steps || []).length) push(at, 'Add a step inside the For Each');
    }
  });

  const s = def.settings || {};
  if (s.maxRunsPerHour !== undefined && !(Number(s.maxRunsPerHour) >= 1)) push('settings.maxRunsPerHour', 'Runs per hour must be at least 1');
  if (s.maxRecipients !== undefined && !(Number(s.maxRecipients) >= 1)) push('settings.maxRecipients', 'Recipients per run must be at least 1');
  return out;
}

// A list of problems, as one sentence for a disabled button's reason.
export function problemsSummary(list) {
  if (!list.length) return '';
  if (list.length === 1) return list[0].message;
  return `${list[0].message} (and ${list.length - 1} more)`;
}
