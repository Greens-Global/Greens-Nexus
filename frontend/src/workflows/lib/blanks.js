// Template blanks (Oct 28 2026). POST /workflows/templates/{key}/use answers
// with the new workflow plus `blanks: [paths]` - the fields the template
// left for the person to fill, in the backend's own shape
// (`steps[1].params.body`). Templates stashes them under a sessionStorage
// key before it navigates to the builder; the builder takes them on mount
// (and clears the key) so the notice shows once, on that first open, and a
// reload or a pasted link shows a plain builder.
const KEY = (id) => `wf:blanks:${id}`;

export function stashBlanks(id, blanks) {
  if (!id || !Array.isArray(blanks) || !blanks.length) return;
  try { window.sessionStorage.setItem(KEY(id), JSON.stringify(blanks)); } catch { /* storage off: no notice */ }
}

/** The stashed blanks for `id`, cleared as they are read; [] when none. */
export function takeBlanks(id) {
  if (!id) return [];
  try {
    const raw = window.sessionStorage.getItem(KEY(id));
    if (raw === null) return [];
    window.sessionStorage.removeItem(KEY(id));
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p) : [];
  } catch { return []; }
}

// The root step indexes the blanks point at: `steps[1].params.body` and
// `steps.1.params.body` both mean the second step.
export function blankStepIndexes(blanks) {
  const out = new Set();
  for (const p of Array.isArray(blanks) ? blanks : []) {
    const m = /^steps(?:\[(\d+)\]|\.(\d+))/.exec(String(p || ''));
    if (m) out.add(Number(m[1] ?? m[2]));
  }
  return out;
}

/** Whether a root step (its index, its id) is one the blanks name. */
export function isBlankStep(blanks, index, stepId) {
  if (!Array.isArray(blanks) || !blanks.length) return false;
  if (blankStepIndexes(blanks).has(index)) return true;
  const id = String(stepId || '');
  return !!id && blanks.some((p) => p === id || String(p).startsWith(`${id}.`));
}
