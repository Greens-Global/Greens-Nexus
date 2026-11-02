// The note a decision needs, on a phone (Neil, 11/02/2026): one 16px box,
// the "Why?" label, the action as the button. The phone opens it only for an
// action the server marks `note: 'required'` (shared.needsNote), so the
// button stays off until something is typed; an optional note never holds a
// decision up on a phone. The desktop keeps dialog.prompt.
import { useState } from 'react';
import { Modal } from '../tasks/components';
import { NOTE_ASK, NO_KEYS, needsNote } from './shared';

export default function NoteSheet({ row, action, onSubmit, onClose }) {
  const [text, setText] = useState('');
  const required = needsNote(action);
  const ask = NOTE_ASK[action.key] || { title: action.label, message: '', placeholder: 'Note' };
  const note = text.trim();
  // A required note is not optional, whatever the shared wording says.
  const placeholder = required ? String(ask.placeholder || 'Reason').replace(/\s*\(optional\)$/i, '') : ask.placeholder;
  const send = () => { if (required && !note) return; onSubmit(note); };
  return (
    <Modal title={`${ask.title || action.label}: ${row.title}`} onClose={onClose} minHeight="auto" footer={
      <>
        <button type="button" className="secondary-btn apv-ph-fbtn" onClick={onClose}>Cancel</button>
        <button type="button" className={`apv-ph-fbtn ${NO_KEYS.has(action.key) ? 'apv-btn apv-no' : 'primary-btn'}`} disabled={required && !note} onClick={send}>{action.label}</button>
      </>
    }>
      <div className="apv-ph-note-wrap nx-fill">
        <label className="apv-ph-note-why" htmlFor="apv-ph-note">Why?</label>
        <p className="apv-ph-note-hint">{ask.message || (required ? 'They see this note with the decision.' : 'Optional - they see it with the decision.')}</p>
        <textarea id="apv-ph-note" className="form-input apv-ph-note" style={{ fontSize: 16 }} placeholder={placeholder}
          value={text} onChange={(e) => setText(e.target.value)} autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
        {required && <small className="apv-ph-note-req">A note is required for this one.</small>}
      </div>
    </Modal>
  );
}
