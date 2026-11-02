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
// `{ rebase: true }`: when the saved value changes under an object draft, the
// keys the person edited keep their edits and only the others follow - a
// save that landed for some keys and failed for others leaves the failed
// ones as a draft (Pay Rules), and a switch saved on click does not wipe a
// half-typed number beside it. Off by default: a panel that switches what it
// edits (another company) in place must start over from the new value.
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// The new saved value with the person's edits laid over it, field by field
// inside objects: an untouched field follows the server (an `updatedAt`, a
// `hasOverride` the save set), an edited one keeps the edit.
function rebaseValue(was, now, draft) {
  if (same(draft, was)) return now;
  if (!isObj(was) || !isObj(now) || !isObj(draft)) return draft;
  const out = { ...now };
  for (const k of Object.keys(draft)) out[k] = rebaseValue(was[k], now[k], draft[k]);
  return out;
}

export function useDraft(saved, { rebase = false } = {}) {
  const key = JSON.stringify(saved ?? null);
  const [state, setState] = useState({ key, saved, draft: saved });
  let current = state;
  if (state.key !== key) {
    // The saved value changed under the draft: start over from it, or carry
    // the edited keys across (React's "adjust state while rendering" idiom -
    // no effect, no extra render pass with a stale draft).
    const draft = rebase && isObj(saved) && isObj(state.draft) && isObj(state.saved)
      ? rebaseValue(state.saved, saved, state.draft) : saved;
    current = { key, saved, draft };
    setState(current);
  }
  const draft = current.draft;
  const setDraft = useCallback((next) => setState(s => ({ ...s, draft: typeof next === 'function' ? next(s.draft) : next })), []);
  const patch = useCallback((p) => setState(s => ({ ...s, draft: { ...(s.draft || {}), ...p } })), []);
  const reset = useCallback(() => setState(s => ({ ...s, draft: saved })), [saved]);
  const dirty = saved != null && JSON.stringify(draft ?? null) !== key;
  return { draft, setDraft, patch, dirty, reset };
}
