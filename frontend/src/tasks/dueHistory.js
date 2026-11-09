// Task Module - a task's due-date moves as readable lines (backend task_due.py
// keeps the history). Shared by DueBadge's tooltip and the drawer's Date History.
import { fmtDate } from './lib';

/** One line per move of the due date, newest first - the badge's tooltip and
 * the drawer's history both read this. */
export function dueHistoryLines(task, nameOf) {
  const src = { asana: ' (in Asana)', cubby: ' (in Cubby)', bulk: ' (bulk edit)', proposal: ' (agreed proposal)', counter: ' (suggested instead)', automation: ' (automation rule)', approved: ' (extension approved)', cascade: ' (moved with its blocker)', auto: ' (automatic scheduling)' };
  // A date Cubby set or moved is Cubby's (cubby_tasks.py), not the person the sync runs as.
  const system = { 'cubby@nexus': 'Cubby' };
  return [...(task?.dueHistory || [])].reverse().map((h) => {
    const who = h.by ? (system[h.by] || nameOf?.(h.by) || h.by) : 'Asana';
    const what = !h.from ? `Set to ${fmtDate(h.to)}`
      : !h.to ? `Removed (was ${fmtDate(h.from)})`
      : `${fmtDate(h.from)} → ${fmtDate(h.to)}`;
    return { ...h, text: `${what} by ${who} on ${fmtDate(h.at)}${src[h.source] || ''}`, who };
  });
}
