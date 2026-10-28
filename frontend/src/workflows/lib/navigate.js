// The one way a Workflows screen opens another module's record (Oct 28
// 2026): nexus:navigate to the view, plus the pending-open note of
// lib/openTarget.js so the module lands on the record itself.
import { openNotificationTarget } from '../../lib/openTarget';

/** Open a record in its own module: `{ view, sub, taskId?, ticketId?, ... }`. */
export function goTo(link) {
  if (!link?.view) return;
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: link.view, sub: link.sub ?? null } }));
  openNotificationTarget(link);
}
