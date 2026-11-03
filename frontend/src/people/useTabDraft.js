import { useCallback, useEffect, useRef, useState } from 'react';
import { useDraft } from '../lib/useDraft';
import { setInlineDirty } from '../lib/dialogGuard';
import { dialog } from '../ui/dialog';

// The person record edits in place (Neil, 11/03/2026): each tab owns its
// fields, an Edit button turns them on, and ONE Save row at the tab's foot
// saves them together (the Settings save pattern - a draft beside the saved
// value, lib/useDraft.js). A tab holding unsaved edits says so here, so
// changing tab, opening another person and leaving the page all ask first.
//
//   const t = useTabDraft(seed, { label: 'Job', onSave: async (draft) => true });
//   t.editing / t.startEdit() / t.draft / t.patch({...}) / t.dirty / t.busy
//   <SaveRow dirty={t.dirty} busy={t.busy} onSave={t.save} onDiscard={t.discard} />
//
// `onSave(draft)` resolves true once it saved (anything else keeps the edit
// open; it shows its own error).

const KEY = 'people-record';
const dirtyTabs = new Map();   // reporter -> { label, save, discard }

function sync() {
  const entries = [...dirtyTabs.values()];
  setInlineDirty(KEY, entries.length > 0, {
    labels: [...new Set(entries.map(v => v.label))],
    save: async () => (await Promise.all(entries.map(v => v.save()))).every(Boolean),
    discard: () => entries.forEach(v => v.discard()),
  });
}

export function isRecordDirty() { return dirtyTabs.size > 0; }

// Ask before the edits on screen are lost. Resolves true to go on (the
// edits are discarded), false to stay.
export async function confirmLeaveRecord() {
  if (!dirtyTabs.size) return true;
  const labels = [...new Set([...dirtyTabs.values()].map(v => v.label))].join(', ');
  const ok = await dialog.confirm(`You have unsaved changes on ${labels}. Leave without saving them?`,
    { title: 'Discard Changes?', confirmText: 'Discard Changes', cancelText: 'Keep Editing', danger: true });
  if (ok) [...dirtyTabs.values()].forEach(v => v.discard());
  return !!ok;
}

// Run `fn` now when nothing is unsaved, else once the person agrees to discard.
export function guardRecordLeave(fn) {
  if (!dirtyTabs.size) { fn(); return; }
  confirmLeaveRecord().then(ok => { if (ok) fn(); });
}

export function useTabDraft(saved, { label, onSave }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const { draft, patch, setDraft, dirty: changed, reset } = useDraft(saved);
  const dirty = editing && changed;
  const onSaveRef = useRef(onSave);
  useEffect(() => { onSaveRef.current = onSave; });
  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; });

  const save = useCallback(async () => {
    setBusy(true);
    try {
      const ok = await onSaveRef.current(draftRef.current);
      if (ok === true) setEditing(false);
      return ok === true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  const discard = useCallback(() => { reset(); setEditing(false); }, [reset]);
  const startEdit = useCallback(() => { reset(); setEditing(true); }, [reset]);

  const [who] = useState(() => Symbol('tab'));
  const discardRef = useRef(discard);
  useEffect(() => { discardRef.current = discard; });
  useEffect(() => {
    if (dirty) dirtyTabs.set(who, { label, save, discard: () => discardRef.current() });
    else dirtyTabs.delete(who);
    sync();
  }, [dirty, label, save, who]);
  useEffect(() => () => { dirtyTabs.delete(who); sync(); }, [who]);

  return { editing, startEdit, draft, patch, setDraft, dirty, busy, save, discard };
}
