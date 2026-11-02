// A run as a story the canvas can tell (Blueprint, 10/30/2026). Pure: the
// definition and a run (GET /workflows/runs/{id}, or a Test's answer) in,
// the node ids the run visited in order and each one's state out. The
// canvas lights them one after another (useReplay).
//
// The engine names a nested step's row by its path - "ap/Approve/a2" for a
// step in an approval lane, "if1/a2" in an If lane, "fe#0/a2" for the first
// item of a For Each, "fault/fx" in the fault lane - so a row is matched to
// the definition's step by the last segment, the item number stripped; a
// step the loop ran several times keeps its worst status. The lane an If
// took is the step's `output.branch` ("then" / "else"); an approval's is
// `output.outcome` (the option the engine recorded when it resumed,
// "expired" being the If Nobody Answers lane). A step the run never
// reached is left out of `statusById`, so the canvas draws it plain. Steps
// the run knows that the draft no longer has (edited since) are dropped,
// and `note` says which version actually ran.
import { walkOrder } from './layout';

const STATUS = {
  done: 'done', succeeded: 'done', planned: 'done',
  waiting: 'waiting', retry: 'waiting', running: 'waiting',
  failed: 'failed',
  skipped: 'skipped', cancelled: 'skipped',
};
// Several rows for one step (a For Each's items): the one that needs a look wins.
const SEVERITY = { failed: 3, waiting: 2, done: 1, skipped: 0 };

/** "ap/Approve/a2" -> "a2", "fe#0/a2" -> "a2", "fe#1" -> "fe", "a1" -> "a1". */
export function stepIdOf(rowId) {
  const last = String(rowId || '').split('/').pop() || '';
  return last.replace(/#\d+$/, '');
}

const statusOf = (row) => STATUS[String(row?.status || '').toLowerCase()] || 'done';

/**
 * @param {object} definition  the draft the canvas shows
 * @param {object} run         { steps: [{ stepId, status, output }], conditionsPassed?, version? }
 * @param {number} [workflowVersion]  the version the builder shows; differs -> note
 * @returns {{ order: string[], statusById: Record<string, 'done'|'waiting'|'failed'|'skipped'>, note: string }}
 */
export function replayPlan(definition, run, workflowVersion) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  // id -> { status, output }: the worst status over the rows, the first
  // output that names a lane
  const byId = new Map();
  steps.forEach((row) => {
    if (!row || !row.stepId) return;
    const id = stepIdOf(row.stepId);
    if (!id) return;
    const status = statusOf(row);
    const out = row.output && typeof row.output === 'object' ? row.output : {};
    const have = byId.get(id);
    if (!have) { byId.set(id, { status, output: out }); return; }
    if (SEVERITY[status] > SEVERITY[have.status]) have.status = status;
    if (!have.output.branch && !have.output.outcome && (out.branch || out.outcome)) have.output = out;
  });

  const pick = (step, lanes) => {
    const out = byId.get(step.id)?.output;
    const key = step.kind === 'if' ? out?.branch : out?.outcome;
    const i = key ? lanes.findIndex((l) => l.key === key) : -1;
    return i >= 0 ? i : 0;
  };
  const full = walkOrder(definition, pick);

  // Cut after the last step the run reached (a join or a loop frame right
  // behind it is kept so the lane reads as finished).
  let last = -1;
  full.forEach((id, i) => { if (byId.has(id)) last = i; });
  let order;
  if (last >= 0) {
    let end = last + 1;
    while (end < full.length && (full[end].startsWith('join-') || full[end].startsWith('frame-'))) end++;
    order = full.slice(0, end);
  } else {
    // nothing ran: the trigger, and the gate when the conditions stopped it
    order = full.slice(0, full[1] === 'gate' ? 2 : 1);
  }

  const statusById = { trigger: 'done' };
  if (order.includes('gate')) statusById.gate = run?.conditionsPassed === false ? 'skipped' : 'done';
  order.forEach((id) => {
    if (id in statusById) return;
    const s = byId.get(id);
    if (s) statusById[id] = s.status;
    else if (id.startsWith('join-') || id.startsWith('frame-')) statusById[id] = 'done';
  });

  const ranVersion = Number(run?.version || 0);
  const shown = Number(workflowVersion || 0);
  const note = ranVersion && shown && ranVersion !== shown ? `This run used version ${ranVersion}` : '';
  return { order, statusById, note };
}
