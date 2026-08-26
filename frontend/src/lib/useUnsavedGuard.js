import { useState, useEffect, useCallback } from 'react';

// Shared "did this modal get closed with unsaved changes" guard for the many
// hand-rolled modals across Nexus that don't go through one of the module
// Modal wrappers (tasks/components.jsx, investor/lib/ui.jsx,
// asset/components/shared/Modal.jsx, marketing/shared/Modal.jsx - those
// already carry this behavior). An unintentional exit - overlay click,
// Escape, the X button - used to silently discard whatever was typed; with
// `dirty` true, those three now confirm first via UnsavedChangesPrompt
// instead. A form's own footer Cancel button is untouched by this - that's
// still an immediate, deliberate discard.
//
// Usage:
//   const guard = useUnsavedGuard(dirty, onClose, onSave);
//   <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) guard.requestClose(); }}>
//     ...
//     <button onClick={guard.requestClose}><X/></button>
//   </div>
//   {guard.confirming && <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} onSave={onSave ? guard.saveAndClose : undefined} saving={guard.saving} />}
export function useUnsavedGuard(dirty, onClose, onSave) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const requestClose = useCallback(() => {
    if (dirty) setConfirming(true); else onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') requestClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  const keepEditing = useCallback(() => setConfirming(false), []);

  const saveAndClose = useCallback(async () => {
    if (!onSave) { setConfirming(false); onClose(); return; }
    setSaving(true);
    try { await onSave(); } finally { setSaving(false); setConfirming(false); }
  }, [onSave, onClose]);

  return { confirming, saving, requestClose, keepEditing, saveAndClose };
}
