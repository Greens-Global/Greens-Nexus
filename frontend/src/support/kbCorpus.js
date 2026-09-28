// Knowledge Base documents and courses for the help search, fetched once per
// session (on the first Help tab open or first search) and kept in memory.
//
// Uses the Knowledge Base's own list endpoints, so the server's scoping (the
// company wall, courses only when published for non-managers) is exactly what
// the library shows this person; docsSearch then keeps approved documents and
// published courses only. A failure is remembered for the session too, so the
// widget says so once instead of retrying on every keystroke; the guide
// results keep working either way.
import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api';
import { makeKbCorpus } from './docsSearch';

let state = { status: 'idle', corpus: null };   // idle | loading | ready | error
let inflight = null;
const listeners = new Set();

function set(next) {
  state = next;
  listeners.forEach((fn) => fn(state));
}

/** Start the fetch if it has not run yet this session. */
export function loadKbCorpus() {
  if (state.status === 'ready' || state.status === 'error') return Promise.resolve(state);
  if (inflight) return inflight;
  set({ status: 'loading', corpus: null });
  inflight = Promise.allSettled([api.getKbDocs(), api.getKbCourses()]).then(([docs, courses]) => {
    const okDocs = docs.status === 'fulfilled' ? docs.value : null;
    const okCourses = courses.status === 'fulfilled' ? courses.value : null;
    // Half an answer is still worth searching; only both failing is an error.
    if (okDocs == null && okCourses == null) set({ status: 'error', corpus: null });
    else set({ status: okDocs && okCourses ? 'ready' : 'error', corpus: makeKbCorpus(okDocs || [], okCourses || []) });
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
  state = { status: 'idle', corpus: null };
  inflight = null;
}
