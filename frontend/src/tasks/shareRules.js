// Task Module - what the Share popup offers on a subtask and warns about on a
// task with subtasks (TaskDetailDrawer's ShareModal).
// A subtask is never wider than its parent (Oct 22 2026): under a private
// task "Everyone" is shown but cannot be picked, with the reason; making a
// task private says how many of its open subtasks go private with it, and
// opening it up again how many come back with it (the server takes them
// along both ways - tasks._cascade_level).
export function shareRules(task, tasks = [], taskById = {}) {
  const parent = task.parentTaskId ? taskById[task.parentTaskId] || tasks.find((x) => x.id === task.parentTaskId) : null;
  // A parent this person cannot see at all is a private one.
  const underPrivate = !!task.parentTaskId && (!parent || (parent.accessLevel || 'org') !== 'org');
  const kids = new Map();
  for (const x of tasks) if (x.parentTaskId) kids.set(x.parentTaskId, [...(kids.get(x.parentTaskId) || []), x]);
  let openBelow = 0;
  const seen = new Set([task.id]);
  const walk = [task.id];
  while (walk.length) {
    for (const k of kids.get(walk.pop()) || []) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      walk.push(k.id);
      if ((k.accessLevel || 'org') === 'org') openBelow += 1;
    }
  }
  // Opening it up again brings back the subtasks private only because of it
  // (narrowedBy = their parent), down the chain while each link is that way -
  // what the server's _cascade_level opens. One made private by hand stays.
  let reopenBelow = 0;
  const again = [task.id];
  const met = new Set([task.id]);
  while (again.length) {
    const pid = again.pop();
    for (const k of kids.get(pid) || []) {
      if (met.has(k.id) || (k.accessLevel || 'org') === 'org' || k.narrowedBy !== pid) continue;
      met.add(k.id);
      again.push(k.id);
      reopenBelow += 1;
    }
  }
  return { underPrivate, openBelow, reopenBelow };
}
