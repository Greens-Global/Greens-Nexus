// Knowledge Base documents and courses for the help search, fetched once per
// session (on the first Help tab open or first search) and kept in memory.
//
// Uses the Knowledge Base's own list endpoints, so the server's scoping (the
// company wall, courses only when published for non-managers) is exactly what
// the library shows this person; docsSearch then keeps approved documents and
// published courses only. A failure is NOT kept for the session (Oct 28 2026:
// the dev API restarts for ~4 minutes on every deploy, and one miss turned
// Knowledge Base results off until a reload): it is tried again the next time
// the panel asks, at most once a minute, so typing never refetches. The guide
// results keep working either way. Half an answer (documents but no courses,
// or the reverse) is searched as it is - 'partial' - and retried the same way.
import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api';
import { makeKbCorpus } from './docsSearch';

export const KB_RETRY_MS = 60_000;

let state = { status: 'idle', corpus: null, at: 0 };   // idle | loading | ready | partial | error
let inflight = null;
const listeners = new Set();

function set(next) {
  state = next;
  listeners.forEach((fn) => fn(state));
}

/** Start the fetch if it has not run yet, or retry one that failed a minute ago. */
export function loadKbCorpus() {
  if (state.status === 'ready') return Promise.resolve(state);
  if (inflight) return inflight;
  const failed = state.status === 'error' || state.status === 'partial';
  if (failed && Date.now() - state.at < KB_RETRY_MS) return Promise.resolve(state);
  // A retry keeps what it has on screen (the half that loaded, or the note)
  // until the answer is in; only the first fetch shows "loading".
  if (!failed) set({ status: 'loading', corpus: null, at: 0 });
  inflight = Promise.allSettled([api.kbCorpusDocs(), api.kbCorpusCourses()]).then(([docs, courses]) => {
    const okDocs = docs.status === 'fulfilled' ? docs.value : null;
    const okCourses = courses.status === 'fulfilled' ? courses.value : null;
    const at = Date.now();
    if (okDocs == null && okCourses == null) set({ status: 'error', corpus: state.corpus, at });
    else set({ status: okDocs && okCourses ? 'ready' : 'partial', corpus: makeKbCorpus(okDocs || [], okCourses || []), at });
    inflight = null;
    return state;
  });
  return inflight;
}

/** { status, corpus } - starts the fetch when `enabled` first turns true. */
export function useKbCorpus(enabled) {
  const snap = useSyncExternalStore(subscribe, getState, getState);
  useEffect(() => { if (enabled) loadKbCorpus(); }, [enabled]);
  return snap;
}
function subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; }
function getState() { return state; }

/** Test seam - forget the session cache. */
export function __resetKbCorpus() {
  state = { status: 'idle', corpus: null, at: 0 };
  inflight = null;
}
