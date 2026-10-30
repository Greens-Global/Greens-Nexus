// Unsent words in a task (Neil, Oct 29 2026: "if I start writing a comment
// but then swap back to the main tab, i lose my comment and it doesn't ask
// me"). Every box in the task drawer that holds typed text until a button
// sends it - a new comment, a reply, an edit to a comment, a checklist line,
// a subtask title - keeps that text HERE, keyed by task, instead of in the
// component's own state. So:
//   - switching tabs in the drawer (Overview <-> Comments, or any other)
//     unmounts the box but not the words; the box comes back holding them,
//     and Overview's and the Comments tab's composers share one draft;
//   - stepping into a subtask and back keeps each task's own draft;
//   - closing the drawer with anything unsent asks first (UnsentPrompt in
//     TaskDetailDrawer: Keep Editing / Discard / Post);
//   - a reload or a crash still finds the text: it is mirrored to
//     localStorage for a week (text and the assignee only - staged files are
//     File objects and live in memory).
// Fields that save on their own (title, description, custom fields) are not
// drafts; the drawer blurs them before it closes so they commit.
import { useCallback, useSyncExternalStore } from 'react';
import { isEmptyDoc } from './RichDescription';

const STORE_KEY = 'nexus.taskDrafts';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY = Object.freeze({});

// key -> { taskId, kind, text, assignTo?, parentId?, commentId?, files?, at }
let drafts = load();
const subs = new Set();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    const now = Date.now();
    return Object.fromEntries(Object.entries(raw || {}).filter(([, d]) => d && d.taskId && now - (d.at || 0) < TTL_MS));
  } catch { return {}; }
}
function save() {
  try {
    const out = {};
    for (const [k, d] of Object.entries(drafts)) {
      if (!hasWords(d)) continue;
      const { files: _files, ...rest } = d;
      out[k] = rest;
    }
    if (Object.keys(out).length) localStorage.setItem(STORE_KEY, JSON.stringify(out));
    else localStorage.removeItem(STORE_KEY);
  } catch { /* storage full or blocked - the in-memory draft still holds */ }
}
function emit() { subs.forEach((fn) => fn()); }
function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

/** Kinds: 'comment' (one per task), 'reply' (ref = thread root id),
 *  'edit' (ref = comment id), 'checklist', 'subtask'. */
export function draftKey(taskId, kind, ref = '') {
  return `${taskId}:${kind}${ref ? `:${ref}` : ''}`;
}

/** True when the draft holds something worth asking about. */
export function hasWords(d) {
  if (!d) return false;
  if (d.files?.length) return true;
  const t = d.text || '';
  if (d.kind === 'checklist' || d.kind === 'subtask') return !!t.trim();
  if (isEmptyDoc(t)) return false;
  // An edit that still reads as the saved comment is nothing to lose.
  return !(d.kind === 'edit' && d.original != null && t === d.original);
}

export function getDraft(key) { return drafts[key] || EMPTY; }

/** Merge `patch` (or `patch(current)`) into the draft at `key`. */
export function setDraft(key, base, patch) {
  const cur = drafts[key] || { ...base };
  const next = { ...cur, ...base, ...(typeof patch === 'function' ? patch(cur) : patch), at: Date.now() };
  drafts = { ...drafts, [key]: next };
  save();
  emit();
}

export function clearDraft(key) {
  if (!(key in drafts)) return;
  const { [key]: _gone, ...rest } = drafts;
  drafts = rest;
  save();
  emit();
}

/** Every draft with words in it for these tasks, oldest first. */
export function draftsFor(taskIds) {
  const ids = new Set(taskIds.filter(Boolean));
  return Object.entries(drafts)
    .filter(([, d]) => ids.has(d.taskId) && hasWords(d))
    .map(([key, d]) => ({ key, ...d }))
    .sort((a, b) => (a.at || 0) - (b.at || 0));
}

export function clearDraftsFor(taskIds) {
  const ids = new Set(taskIds.filter(Boolean));
  const keep = Object.fromEntries(Object.entries(drafts).filter(([, d]) => !ids.has(d.taskId)));
  if (Object.keys(keep).length === Object.keys(drafts).length) return;
  drafts = keep;
  save();
  emit();
}

/** Re-renders when any draft changes; returns draftsFor(taskIds). */
export function useTaskDrafts(taskIds) {
  const snap = useSyncExternalStore(subscribe, () => drafts);
  void snap;
  return draftsFor(taskIds);
}

/**
 * One draft box. `base` names it ({ taskId, kind, parentId?, commentId? }).
 * Returns [draft, set, clear]: `set(patch | fn)` merges, `clear()` drops it
 * (after it was sent, or on Cancel).
 */
export function useTaskDraft(key, base) {
  const d = useSyncExternalStore(subscribe, () => drafts[key] || EMPTY);
  const baseKey = JSON.stringify(base);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const set = useCallback((patch) => setDraft(key, base, patch), [key, baseKey]);
  const clear = useCallback(() => clearDraft(key), [key]);
  return [d, set, clear];
}

// For tests: forget everything (memory and storage).
export function resetTaskDrafts() {
  drafts = {};
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  emit();
}
