// The note a decision needs, on a phone (Neil, 11/02/2026): one 16px box,
// the "Why?" hint, the action as the button. Required (reimbursement send
// back / reject, HR letter decline, and the rest shared.noteRequired
// names) keeps the button off until something is typed; optional (time
// off's reject) sends with an empty note. The desktop keeps dialog.prompt.
import { useState } from 'react';
import { Modal } from '../tasks/components';
import { NOTE_ASK, NO_KEYS, noteRequired } from './shared';

export default function NoteSheet({ row, action, onSubmit, onClose }) {
  const [text, setText] = useState('');
  const required = noteRequired(row, action);
  const ask = NOTE_ASK[action.key] || { title: action.label, message: '', placeholder: 'Note' };
  const note = text.trim();
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
        <textarea id="apv-ph-note" className="form-input apv-ph-note" aria-label="Note" style={{ fontSize: 16 }} placeholder={ask.placeholder}
          value={text} onChange={(e) => setText(e.target.value)} autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
        {required && <small className="apv-ph-note-req">A note is required for this one.</small>}
      </div>
    </Modal>
  );
}
