// Handoff for "open this exact thing" across a module that is still loading.
//
// The notification bell's "View task" / "View ticket" navigates to the owning
// module and then fires `nexus:open-task` / `nexus:open-ticket`. That event
// alone is only half an answer: both modules are lazy() (App.jsx), so on the
// first visit the chunk is still downloading when the event fires and there is
// no listener yet - you land on My Tasks or the ticket list, which is the very
// thing the event was added to prevent. It only appeared to work because you
// are usually already in the module when you click.
//
// So the request is also written down here. The event serves the module that is
// already mounted; this note serves the one that has yet to mount, which drains
// it on the way up. Same job as the "?ticket=<id>" query param the ticket
// emails use, minus the URL.
//
// Consumed once and cleared: a later remount of the same module must not
// reopen a drawer the person already closed. Stale requests are dropped rather
// than kept, for the same reason - a note left from minutes ago is no longer
// what anyone is asking for.
const TTL_MS = 30_000;

const pending = new Map();   // kind -> { id, at }

/** Record that `id` should be opened by whichever view owns `kind`. */
export function setPendingOpen(kind, id) {
  if (!kind || !id) return;
  pending.set(kind, { id, at: Date.now() });
}

/** Take and clear the pending id for `kind`, or null if there is none / it is
 *  stale. Call this on mount, next to whatever listens for the live event. */
export function takePendingOpen(kind) {
  const hit = pending.get(kind);
  if (!hit) return null;
  pending.delete(kind);
  return (Date.now() - hit.at) > TTL_MS ? null : hit.id;
}

/** Test seam - drop everything without consuming it. */
export function __clearPendingOpen() {
  pending.clear();
}
