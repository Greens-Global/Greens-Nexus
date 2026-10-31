// A run as a story the canvas can tell (Blueprint, 10/30/2026). Pure: the
// definition and a run (GET /workflows/runs/{id}, or a Test's answer) in,
// the node ids the run visited in order and each one's state out. The
// canvas lights them one after another (useReplay).
//
// The lane an approval took is the step's `output.outcome` (the option the
// engine recorded when it resumed; "expired" is the If Nobody Answers
// lane). A step the run never reached is left out of `statusById`, so the
// canvas draws it plain. Steps the run knows that the draft no longer has
// (edited since) are dropped, and `note` says which version actually ran.
import { walkOrder } from './layout';

const STATUS = {
  done: 'done', succeeded: 'done', planned: 'done',
  waiting: 'waiting', retry: 'waiting', running: 'waiting',
  failed: 'failed',
  skipped: 'skipped', cancelled: 'skipped',
};

/**
 * @param {object} definition  the draft the canvas shows
 * @param {object} run         { steps: [{ stepId, status, output }], conditionsPassed?, version? }
 * @param {number} [workflowVersion]  the version the builder shows; differs -> note
 * @returns {{ order: string[], statusById: Record<string, 'done'|'waiting'|'failed'|'skipped'>, note: string }}
 */
export function replayPlan(definition, run, workflowVersion) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const byId = new Map();
  steps.forEach((s) => { if (s && s.stepId) byId.set(String(s.stepId), s); });

  const pick = (step, lanes) => {
    const outcome = byId.get(step.id)?.output?.outcome;
    const i = outcome ? lanes.findIndex((l) => l.key === outcome) : -1;
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
    if (s) statusById[id] = STATUS[String(s.status || '').toLowerCase()] || 'done';
    else if (id.startsWith('join-') || id.startsWith('frame-')) statusById[id] = 'done';
  });

  const ranVersion = Number(run?.version || 0);
  const shown = Number(workflowVersion || 0);
  const note = ranVersion && shown && ranVersion !== shown ? `This run used version ${ranVersion}` : '';
  return { order, statusById, note };
}
