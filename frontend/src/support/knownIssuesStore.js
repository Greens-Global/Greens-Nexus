// Known Issues (Help Center, Oct 2026): what is broken right now, posted by
// an administrator (GET/PUT /help-center/known-issues, one nexus_settings
// key). Read by the Help Center page, the Help panel and the ticket form, so
// one fetch serves all three for a minute.
import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api';

const FRESH_MS = 60_000;
let state = { status: 'idle', issues: [], canEdit: false };
let loadedAt = 0;
let inflight = null;
const listeners = new Set();

function set(next) {
  state = next;
  listeners.forEach((fn) => fn());
}

export function loadKnownIssues(force = false) {
  if (!force && state.status === 'ready' && Date.now() - loadedAt < FRESH_MS) return Promise.resolve(state);
  if (inflight) return inflight;
  inflight = Promise.resolve()
    .then(() => api.helpKnownIssues())
    .then((r) => {
      loadedAt = Date.now();
      set({ status: 'ready', issues: Array.isArray(r?.issues) ? r.issues : [], canEdit: !!r?.canEdit });
    })
    .catch(() => { if (state.status !== 'ready') set({ ...state, status: 'error' }); })
    .finally(() => { inflight = null; });
  return inflight;
}

export async function saveKnownIssues(issues) {
  const r = await api.helpSaveKnownIssues(issues);
  loadedAt = Date.now();
  set({ status: 'ready', issues: Array.isArray(r?.issues) ? r.issues : [], canEdit: !!r?.canEdit });
  return state;
}

/** { status, issues (live ones; an administrator's list keeps the expired, flagged), canEdit } */
export function useKnownIssues() {
  const snap = useSyncExternalStore(subscribe, getState, getState);
  // A tab left open checks again every few minutes, so a cleared or ended
  // issue does not linger until a reload.
  useEffect(() => {
    loadKnownIssues();
    const t = setInterval(() => { if (!document.hidden) loadKnownIssues(); }, 5 * 60_000);
    return () => clearInterval(t);
  }, []);
  return snap;
}
function subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; }
function getState() { return state; }

// "Until" ends at midnight where the reader is: the server keeps an issue
// until its day has passed in Los Angeles (the company's latest zone), and
// a reader in India stops seeing it at their own midnight, half a day sooner.
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** The issues with any whose "until" day has ended HERE flagged expired. */
export function withLocalExpiry(issues, today = localDay()) {
  return issues.map((i) => (i.until && String(i.until).slice(0, 10) < today && !i.expired ? { ...i, expired: true } : i));
}

/** Test seam. */
export function __resetKnownIssues() {
  state = { status: 'idle', issues: [], canEdit: false };
  loadedAt = 0;
  inflight = null;
}
