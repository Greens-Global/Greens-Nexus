// Task Module - what the Share popup offers on a subtask and warns about on a
// task with subtasks (TaskDetailDrawer's ShareModal).
// A subtask is never wider than its parent (Oct 22 2026): under a private
// task "Everyone" is shown but cannot be picked, with the reason; making a
// task private says how many of its open subtasks go private with it (the
// server takes them along - tasks._cascade_level).
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
  return { underPrivate, openBelow };
}
