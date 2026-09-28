// Opening the guide at a specific page and section, from anywhere.
//
// Same two-part handoff the bell uses for tickets (lib/pendingOpen.js): the
// Documentation tab is lazy, so on a first visit it is still loading when the
// event fires. The request is also written down, and the tab drains it as it
// mounts. The event serves a tab that is already open.
import { setPendingOpen } from '../lib/pendingOpen';

export const DOCS_OPEN_EVENT = 'nexus:docs-open';
const KIND = 'docs';

const encode = (docId, anchor) => (anchor ? `${docId}#${anchor}` : docId);

/** "workday#w-request-time-off" -> { docId, anchor } */
export function decodeDocTarget(value) {
  if (!value) return null;
  const [docId, anchor = null] = String(value).split('#');
  return docId ? { docId, anchor } : null;
}

/** Go to Support > Documentation, on `docId`, scrolled to `anchor`. */
export function openDoc(docId, anchor = null) {
  if (!docId) return;
  setPendingOpen(KIND, encode(docId, anchor));
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'support', sub: 'documentation' } }));
  setTimeout(() => window.dispatchEvent(new CustomEvent(DOCS_OPEN_EVENT, { detail: { docId, anchor } })), 0);
}

/** A link to the same place, for opening in a new tab (keeps the current page intact). */
export function docUrl(docId, anchor = null) {
  const q = new URLSearchParams({ doc: docId });
  if (anchor) q.set('section', anchor);
  return `/support/documentation?${q.toString()}`;
}

export const PENDING_DOCS_KIND = KIND;
