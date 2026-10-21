// Opening one Knowledge Base page or course from outside the Knowledge Base
// (the Help widget's search results, bells). Since the Oct 2026 rebuild a
// page and a course each have an address (/sop/page:<id>, /sop/course:<id>),
// so this is one navigate - no pending note, no second event.
export const KB_OPEN_EVENT = 'nexus:kb-open';
export const PENDING_KB_KIND = 'kb';

/** "course:crs_1" -> { kind: 'course', id: 'crs_1' } */
export function decodeKbTarget(value) {
  if (!value) return null;
  const i = String(value).indexOf(':');
  if (i < 1) return null;
  const kind = value.slice(0, i);
  const id = value.slice(i + 1);
  return (kind === 'doc' || kind === 'page' || kind === 'course') && id ? { kind: kind === 'doc' ? 'page' : kind, id } : null;
}

/** Go to the Knowledge Base and open page or course `id`. */
export function openKb(kind, id) {
  if (!id) return;
  const k = kind === 'doc' ? 'page' : kind;
  if (k !== 'page' && k !== 'course') return;
  window.dispatchEvent(new CustomEvent('nexus:navigate', {
    detail: { view: 'sop', sub: `${k}:${encodeURIComponent(id)}` },
  }));
}
