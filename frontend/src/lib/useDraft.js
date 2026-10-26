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
export function useDraft(saved) {
  const key = JSON.stringify(saved ?? null);
  const [state, setState] = useState({ key, draft: saved });
  // The saved value changed under the draft: start over from it (React's
  // "adjust state while rendering" idiom - no effect, no extra render pass
  // with a stale draft).
  if (state.key !== key) setState({ key, draft: saved });
  const draft = state.key === key ? state.draft : saved;
  const setDraft = useCallback((next) => setState(s => ({ ...s, draft: typeof next === 'function' ? next(s.draft) : next })), []);
  const patch = useCallback((p) => setState(s => ({ ...s, draft: { ...(s.draft || {}), ...p } })), []);
  const reset = useCallback(() => setState(s => ({ ...s, draft: saved })), [saved]);
  const dirty = saved != null && JSON.stringify(draft ?? null) !== key;
  return { draft, setDraft, patch, dirty, reset };
}
