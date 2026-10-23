// My Open Tasks counts the work that is live now (in progress, overdue, due
// in the next 30 days - backend my_work.task_focus_bucket, Neil Oct 23 2026);
// the line under it names what was left out: "+12 with no due date,
// +8 recurring". Null when nothing was, so the tile keeps its usual hint.
export function myTasksFootnote(kpis) {
  const parts = [];
  const undated = Number(kpis?.my_open_tasks_undated) || 0;
  const recurring = Number(kpis?.my_open_tasks_recurring) || 0;
  if (undated > 0) parts.push(`+${undated} with no due date`);
  if (recurring > 0) parts.push(`+${recurring} recurring`);
  return parts.length ? parts.join(', ') : null;
}
export const MY_TASKS_RULE = 'In progress, overdue, or due in the next 30 days';
