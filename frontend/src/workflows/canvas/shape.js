// A workflow's silhouette (Blueprint, 10/30/2026). The Workflows list and
// the Templates gallery draw each workflow as a small thumbnail of its
// canvas; the list never carries whole definitions, so a row carries this
// compact `shape` instead, and the thumbnail turns it back into a bare
// definition the layout engine can draw.
//
// Grammar (mirrored by backend/workflows/shape.py - change both together):
// a lane is an array; each step is [kind] or [kind, [lane, ...]] for the
// kinds that hold lanes - if (then, else), approval (one per option, in
// order, then the If Nobody Answers lane) and for_each (one). Only kinds
// travel: no titles, no params, no recipients.
import { DEFAULT_OPTIONS, lanesOf } from '../lib/definition';

const KINDS = new Set(['action', 'if', 'approval', 'wait', 'for_each', 'stop']);

function laneShape(steps) {
  if (!Array.isArray(steps)) return [];
  const out = [];
  for (const s of steps) {
    if (!s || typeof s !== 'object') continue;
    const kind = KINDS.has(s.kind) ? s.kind : 'action';
    if (kind === 'if') out.push([kind, [laneShape(s.then), laneShape(s.else)]]);
    else if (kind === 'approval') out.push([kind, lanesOf(s).map((l) => laneShape(s.branches?.[l.key]))]);
    else if (kind === 'for_each') out.push([kind, [laneShape(s.steps)]]);
    else out.push([kind]);
  }
  return out;
}

/** The root lane's shape; [] for a workflow with no steps yet. */
export function shapeOf(definition) {
  return laneShape(definition?.steps);
}

// A bare definition with the shape's steps and made-up ids, enough for
// layout() to draw. An approval gets as many options as the shape has
// lanes minus the no-answer lane, so lanesOf() fans out the same way.
function laneFrom(shape, prefix) {
  if (!Array.isArray(shape)) return [];
  return shape.map((entry, i) => {
    const [kind, lanes] = Array.isArray(entry) ? entry : [entry];
    const id = `${prefix}${i}`;
    const k = KINDS.has(kind) ? kind : 'action';
    if (k === 'if') return { id, kind: k, then: laneFrom(lanes?.[0], `${id}t`), else: laneFrom(lanes?.[1], `${id}e`), enabled: true };
    if (k === 'approval') {
      const count = Math.max(1, (Array.isArray(lanes) ? lanes.length : 1) - 1);
      const options = count === DEFAULT_OPTIONS.length ? DEFAULT_OPTIONS.slice() : Array.from({ length: count }, (_, n) => `Option ${n + 1}`);
      const branches = {};
      options.forEach((o, n) => { branches[o] = laneFrom(lanes?.[n], `${id}b${n}`); });
      branches.expired = laneFrom(lanes?.[count], `${id}x`);
      return { id, kind: k, params: { options }, branches, enabled: true };
    }
    if (k === 'for_each') return { id, kind: k, steps: laneFrom(lanes?.[0], `${id}s`), as: 'item', enabled: true };
    return { id, kind: k, enabled: true };
  });
}

export function definitionFromShape(shape) {
  return {
    v: 1,
    trigger: { kind: 'event', event: 'shape', filters: [] },
    conditions: [],
    steps: laneFrom(shape, 's'),
    settings: { faultSteps: [] },
  };
}
