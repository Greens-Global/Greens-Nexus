// The edits the canvas makes (10/30/2026), as pure functions over the
// definition: drop a new block on an insert point, move a step from one
// lane to another, change one step. Every one goes through the helpers in
// lib/definition.js, so a canvas edit and a recipe edit produce the same
// shape, and the old definition is never touched.
import { getLane, insertStep, newStep, removeStep, updateStep } from '../lib/definition';
import { laneInside } from './layout';

const samePath = (a, b) => a.length === b.length && a.every((k, i) => String(k) === String(b[i]));
const startsWith = (path, prefix) => path.length > prefix.length && prefix.every((k, i) => String(k) === String(path[i]));

/** A new step of `kind` at `to` ({ path, index }); an action starts with no action chosen - the inspector asks. */
export function insertKind(definition, kind, to, actionDef = null) {
  return insertStep(definition, to.path, newStep(kind, kind === 'action' ? actionDef : null), to.index);
}

/** True when a step may land on `to`: not inside its own lanes, not the same slot. */
export function canMove(definition, from, to) {
  const step = getLane(definition, from.path)[from.index];
  if (!step) return false;
  if (laneInside(definition, to.path, step.id)) return false;
  if (samePath(from.path, to.path) && (to.index === from.index || to.index === from.index + 1)) return false;
  return true;
}

/**
 * Move the step at `from` to `to`. Removing it first shifts what sat after
 * it in the same lane: an index in that lane moves down one, and so does
 * the lane segment of a path that passes through that lane past it.
 */
export function moveBetween(definition, from, to) {
  if (!canMove(definition, from, to)) return definition;
  const step = getLane(definition, from.path)[from.index];
  const removed = removeStep(definition, from.path, from.index);
  const toPath = to.path.slice();
  let toIndex = to.index;
  if (samePath(toPath, from.path)) {
    if (toIndex > from.index) toIndex -= 1;
  } else if (startsWith(toPath, from.path)) {
    const seg = from.path.length;
    if (typeof toPath[seg] === 'number' && toPath[seg] > from.index) toPath[seg] -= 1;
  }
  return insertStep(removed, toPath, step, toIndex);
}

export const patchStep = (definition, path, index, patch) => updateStep(definition, path, index, patch);

/** The lane and index a step id sits at, from a layout's nodes. */
export function locate(nodes, id) {
  const n = (nodes || []).find((x) => x.id === id && x.step);
  return n ? { path: n.path, index: n.index, step: n.step } : null;
}
