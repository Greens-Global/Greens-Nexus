import { useState, useCallback } from 'react';

// A form's draft beside its saved value (the Settings save pattern, Oct 23
// 2026): `saved` is what the server last answered; the draft starts from it,
// follows it whenever it changes (a reload, a save, a scope switch), and
// `dirty` says whether they differ. Nothing is written until the panel
// saves the draft itself; `reset` drops the edits.
//
//   const { draft, patch, dirty, reset } = useDraft(cfg);
//   <input value={draft.name} onChange={e => patch({ name: e.target.value })} />
//   <SaveRow dirty={dirty} busy={busy} onSave={() => save(draft)} onDiscard={reset} />
//
// `{ rebase: true }`: when the saved value changes under an object draft, a
// field the server did not move keeps the person's edit - a save that failed
// for some keys leaves those keys as a draft (Pay Rules), and a switch saved
// on click does not wipe a half-typed number beside it - while a field the
// server moved takes the server's value (a save that landed: "10" typed, 10
// echoed; a mailbox lowercased; hours clamped), so a save that worked never
// leaves the form looking unsaved. Off by default: a panel that switches what
// it edits (another company) in place must start over from the new value.
//
// For an exact answer a save can say what it did: `begin()` before sending
// notes the draft, `settle(keys)` once those keys saved adopts the server's
// value for each of them - unless the person changed it again while the
// save was in flight. Keys a save did not settle follow the rule above.
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// The new saved value with the person's edits laid over it, field by field
// inside objects: an untouched field follows the server (an `updatedAt`, a
// `hasOverride` the save set), so does a field the server moved; an edited
// field the server left alone keeps the edit.
function rebaseValue(was, now, draft) {
  if (same(draft, was)) return now;
  if (same(was, now)) return draft;
  if (!isObj(was) || !isObj(now) || !isObj(draft)) return now;
  const out = { ...now };
  for (const k of Object.keys(draft)) out[k] = rebaseValue(was[k], now[k], draft[k]);
  return out;
}

export function useDraft(saved, { rebase = false } = {}) {
  const key = JSON.stringify(saved ?? null);
  const [state, setState] = useState({ key, saved, draft: saved, snap: null, settle: null });
  let current = state;
  if (state.key !== key || state.settle) {
    // The saved value changed under the draft, or a save settled: start over
    // from it, or carry the edits across (React's "adjust state while
    // rendering" idiom - no effect, no extra render pass with a stale draft).
    let draft = state.draft;
    if (state.key !== key) {
      draft = rebase && isObj(saved) && isObj(state.draft) && isObj(state.saved)
        ? rebaseValue(state.saved, saved, state.draft) : saved;
      // Typed again while a save was in flight: that edit stays.
      if (rebase && isObj(state.snap) && isObj(draft) && isObj(state.draft)) {
        draft = { ...draft };
        for (const k of Object.keys(state.draft)) {
          if (!same(state.draft[k], state.snap[k])) draft[k] = state.draft[k];
        }
      }
    }
    let snap = state.snap;
    if (state.settle && isObj(saved) && isObj(draft)) {
      draft = { ...draft };
      for (const k of state.settle) {
        if (!snap || same(state.draft?.[k], snap[k])) draft[k] = saved[k];
      }
      snap = null;
    }
    current = { key, saved, draft, snap, settle: null };
    setState(current);
  }
  const draft = current.draft;
  const setDraft = useCallback((next) => setState(s => ({ ...s, draft: typeof next === 'function' ? next(s.draft) : next })), []);
  const patch = useCallback((p) => setState(s => ({ ...s, draft: { ...(s.draft || {}), ...p } })), []);
  const reset = useCallback(() => setState(s => ({ ...s, draft: saved })), [saved]);
  const begin = useCallback(() => setState(s => ({ ...s, snap: s.draft })), []);
  const settle = useCallback((keys) => setState(s => ({ ...s, settle: keys || Object.keys(s.snap || s.draft || {}) })), []);
  const dirty = saved != null && JSON.stringify(draft ?? null) !== key;
  return { draft, setDraft, patch, dirty, reset, begin, settle };
}
