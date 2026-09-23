// Shared "Save your changes?" confirmation shown when a dirty add/edit modal
// is about to close via an unintentional exit (overlay click, Escape, the X
// button) - matches the .modal-overlay/.modal-content/.primary-btn/.secondary-btn
// look every non-Tasks/Marketing/Asset screen already uses, so it drops into
// any of those modals without a new visual language. A form's own footer
// Cancel button is untouched by this - that's still an immediate, deliberate
// discard.
import { createPortal } from 'react-dom';

export default function UnsavedChangesPrompt({ onKeepEditing, onDiscard, onSave, saving }) {
  return createPortal((
    <div
      className="modal-overlay" data-nx-prompt="1" role="alertdialog" aria-modal="true" aria-labelledby="nx-unsaved-title"
      style={{ zIndex: 6000 }}
      onClick={(e) => { if (e.target === e.currentTarget) onKeepEditing(); }}
    >
      <div className="modal-content" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '20px 22px 4px' }}>
          <div id="nx-unsaved-title" style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 }}>Discard unsaved changes?</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            You have unsaved changes in this window. If you leave now, they will be lost.
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '16px 22px 20px', flexWrap: 'wrap' }}>
          <button className="secondary-btn" style={{ color: 'hsl(var(--color-red))' }} onClick={onDiscard}>Discard Changes</button>
          <button className={onSave ? 'secondary-btn' : 'primary-btn'} onClick={onKeepEditing} autoFocus>Keep Editing</button>
          {onSave && (
            <button className="primary-btn" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</button>
          )}
        </div>
      </div>
    </div>
  ), document.body);
}
