// Tasks whose status or completion changed a moment ago (Oct 12, 2026):
// task id -> when. Written by the tasks store (TasksContext) on every change
// to its task list - your own edit, a board drop, a bulk update or someone
// else's edit arriving live - and read by ChangeFlash when a row or card
// MOUNTS. A card that moves to another board column (a row to another status
// group) is a new element there, so without this its change would arrive as
// a silent mount. Entries expire after RECENT_MS; module scope, like
// taskStore's cache, because the rows read it outside React state.
export const RECENT_MS = 2000;
const changed = new Map();

export function markChanged(id, now = Date.now()) {
  changed.set(id, now);
}

export function changedRecently(id, now = Date.now()) {
  const at = changed.get(id);
  if (at == null) return false;
  if (now - at > RECENT_MS) { changed.delete(id); return false; }
  return true;
}

// Compare two task lists and mark every task present in both whose status or
// completion differs. A task that only appears (a load, a create) is not a
// change. Old entries are swept on the way so the map stays small.
export function noteStatusChanges(prev, next, now = Date.now()) {
  if (prev === next || !prev?.length || !next?.length) return;
  for (const [id, at] of changed) if (now - at > RECENT_MS) changed.delete(id);
  const before = new Map();
  for (const t of prev) before.set(t.id, t);
  for (const t of next) {
    const was = before.get(t.id);
    if (!was || was === t) continue;
    if (was.status !== t.status || !!was.completed !== !!t.completed) changed.set(t.id, now);
  }
}

// Tests only.
export function _resetRecentChanges() { changed.clear(); }
