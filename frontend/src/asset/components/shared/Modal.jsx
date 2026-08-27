import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import UnsavedChangesPrompt from '../../../components/UnsavedChangesPrompt';

/**
 * Generic centered modal shell: overlay + card with header (title + close button),
 * scrollable body, and a footer action row. Clicking the overlay itself (not the
 * card) closes it. `wide` bumps the default max width from 560 to 760; `maxWidth`
 * overrides both.
 *
 * `isDirty` + `onSave`: an unintentional exit (overlay click, Escape, the X
 * button) used to silently discard an in-progress edit - with isDirty set,
 * those three now confirm first instead. The footer's own Cancel stays an
 * immediate, deliberate discard.
 */
export function Modal({ title, children, footer, wide, maxWidth, onClose, isDirty = false, onSave }) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestClose = () => { if (isDirty) setConfirming(true); else onClose(); };
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') requestClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, isDirty]);
  const saveAndClose = async () => {
    if (!onSave) { setConfirming(false); onClose(); return; }
    setSaving(true);
    try { await onSave(); } finally { setSaving(false); setConfirming(false); }
  };
  return (
    <div
      className="modal-overlay"
      style={{ display: 'flex' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        className="modal-content"
        style={{ width: maxWidth ? `min(94vw, ${maxWidth}px)` : undefined, maxWidth: maxWidth || (wide ? 'clamp(680px, 68vw, 1100px)' : 'clamp(520px, 60vw, 980px)') }}
      >
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="close-btn" onClick={requestClose}>
            <X size={18} />
          </button>
        </div>
        <div style={{ padding: '4px 24px 16px' }}>{children}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '12px 24px 18px', borderTop: '1px solid var(--border-color)' }}>
          {footer}
        </div>
      </div>
      {confirming && (
        <UnsavedChangesPrompt
          onKeepEditing={() => setConfirming(false)}
          onDiscard={onClose}
          onSave={onSave ? saveAndClose : undefined}
          saving={saving}
        />
      )}
    </div>
  );
}
