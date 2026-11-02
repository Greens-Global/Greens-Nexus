import { useEffect, useState } from 'react';
import { installDialogGuard, subscribe } from '../lib/dialogGuard';
import UnsavedChangesPrompt from './UnsavedChangesPrompt';

// Mounted once (main.jsx). Installs the document-wide guard and shows the
// shared unsaved-changes prompt whenever it asks - see lib/dialogGuard.js.
// When the unsaved work is Settings forms that said how to save themselves,
// the prompt names them and offers Save and Leave.
export default function DialogGuard() {
  const [pending, setPending] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    installDialogGuard();
    return subscribe(setPending);
  }, []);
  if (!pending) return null;
  const { labels, save, discard } = pending.summary?.() || { labels: [], save: null, discard: null };
  const saveAndLeave = save ? async () => {
    setSaving(true);
    const ok = await save();
    setSaving(false);
    pending.resolve(ok === true);
  } : undefined;
  return (
    <UnsavedChangesPrompt
      what={labels}
      onKeepEditing={() => pending.resolve(false)}
      onDiscard={() => { discard?.(); pending.resolve(true); }}
      onSave={saveAndLeave} saving={saving} saveText="Save and Leave"
    />
  );
}
