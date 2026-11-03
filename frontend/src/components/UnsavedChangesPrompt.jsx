// Shared "Save your changes?" confirmation shown when a dirty add/edit modal
// is about to close via an unintentional exit (overlay click, Escape, the X
// button) - matches the .modal-overlay/.modal-content/.primary-btn/.secondary-btn
// look every non-Tasks/Marketing/Asset screen already uses, so it drops into
// any of those modals without a new visual language. A form's own footer
// Cancel button is untouched by this - that's still an immediate, deliberate
// discard.
import { createPortal } from 'react-dom';

// "Pay Rules", "Pay Rules and Probation", "Pay Rules, Probation and Letterheads".
export function nameList(names) {
  const list = (names || []).filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// title / message / saveText: a screen with its own words (the shift
// schedule's drafts, Oct 28 2026); the defaults are the dialog wording.
// `what`: the names of the forms with unsaved changes (the Settings groups),
// named in the message when no message is given.
export default function UnsavedChangesPrompt({ onKeepEditing, onDiscard, onSave, saving, title = 'Discard Unsaved Changes?',
  message, what, saveText = 'Save Changes' }) {
  const names = nameList(what);
  const text = message || (names
    ? `Your changes to ${names} on this page have not been saved. If you leave now, they will be lost.`
    : 'You have unsaved changes. If you leave now, they will be lost.');
  return createPortal((
    <div
      className="modal-overlay" data-nx-prompt="1" role="alertdialog" aria-modal="true" aria-labelledby="nx-unsaved-title"
      aria-describedby="nx-unsaved-text" style={{ zIndex: 6000 }}
      onClick={(e) => { if (e.target === e.currentTarget) onKeepEditing(); }}
    >
      {/* A question stays a centered card, sized to its words: no nx-popup
          (the 60% content floor and the right-edge sheet geometry are for
          records and forms - style.css "Sheets", Neil 11/01/2026). */}
      <div className="modal-content nx-center" data-nx-question="" style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 440, minHeight: 0 }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '20px 22px 4px' }}>
          <div id="nx-unsaved-title" style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 }}>{title}</div>
          <div id="nx-unsaved-text" style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            {text}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '16px 22px 20px', flexWrap: 'wrap' }}>
          <button type="button" className="secondary-btn" style={{ color: 'hsl(var(--color-red))' }} onClick={onDiscard} disabled={saving}>Discard Changes</button>
          <button type="button" className={onSave ? 'secondary-btn' : 'primary-btn'} onClick={onKeepEditing} autoFocus>Keep Editing</button>
          {onSave && (
            <button type="button" className="primary-btn" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : saveText}</button>
          )}
        </div>
      </div>
    </div>
  ), document.body);
}
