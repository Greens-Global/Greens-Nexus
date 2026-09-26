// Opening one Knowledge Base document or course from outside the Knowledge
// Base (the Help widget's search results). Same two-part handoff as
// openDoc.js / the bell's tickets: the event serves a Knowledge Base view that
// is already mounted, the pending note serves one that is still loading.
import { setPendingOpen } from '../lib/pendingOpen';

export const KB_OPEN_EVENT = 'nexus:kb-open';
export const PENDING_KB_KIND = 'kb';

/** "course:crs_1" -> { kind: 'course', id: 'crs_1' } */
export function decodeKbTarget(value) {
  if (!value) return null;
  const i = String(value).indexOf(':');
  if (i < 1) return null;
  const kind = value.slice(0, i);
  const id = value.slice(i + 1);
  return (kind === 'doc' || kind === 'course') && id ? { kind, id } : null;
}

/** Go to the Knowledge Base and open document or course `id`. */
export function openKb(kind, id) {
  if (!id || (kind !== 'doc' && kind !== 'course')) return;
  setPendingOpen(PENDING_KB_KIND, `${kind}:${id}`);
  window.dispatchEvent(new CustomEvent('nexus:navigate', {
    detail: { view: 'sop', sub: kind === 'course' ? 'lms' : 'index' },
  }));
  setTimeout(() => window.dispatchEvent(new CustomEvent(KB_OPEN_EVENT, { detail: { kind, id } })), 0);
}
