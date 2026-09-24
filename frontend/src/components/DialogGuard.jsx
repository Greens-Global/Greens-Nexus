import { useEffect, useState } from 'react';
import { installDialogGuard, subscribe } from '../lib/dialogGuard';
import UnsavedChangesPrompt from './UnsavedChangesPrompt';

// Mounted once (main.jsx). Installs the document-wide guard and shows the
// shared unsaved-changes prompt whenever it asks - see lib/dialogGuard.js.
export default function DialogGuard() {
  const [pending, setPending] = useState(null);
  useEffect(() => {
    installDialogGuard();
    return subscribe(setPending);
  }, []);
  if (!pending) return null;
  return (
    <UnsavedChangesPrompt
      onKeepEditing={() => pending.resolve(false)}
      onDiscard={() => pending.resolve(true)}
    />
  );
}
