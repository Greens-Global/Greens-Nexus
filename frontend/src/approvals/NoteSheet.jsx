// The note a decision needs, on a phone (Neil, 11/02/2026): one 16px box,
// the "Why?" label, the action as the button. The phone opens it only for an
// action the server marks `note: 'required'` (shared.needsNote), so the
// button stays off until something is typed; an optional note never holds a
// decision up on a phone. The desktop keeps dialog.prompt.
import { useRef, useState } from 'react';
import { Modal } from '../tasks/components';
import { NOTE_ASK, NO_KEYS, needsNote } from './shared';

export default function NoteSheet({ row, action, onSubmit, onClose }) {
  const [text, setText] = useState('');
  const required = needsNote(action);
  const ask = NOTE_ASK[action.key] || { title: action.label, message: '', placeholder: 'Note' };
  const note = text.trim();
  // A required note is not optional, whatever the shared wording says.
  const placeholder = required ? String(ask.placeholder || 'Reason').replace(/\s*\(optional\)$/i, '') : ask.placeholder;
  // Every way out leaves through the Modal's exit (the X's slide), and the
  // decision is sent once the sheet has gone: `sent` holds the note a submit
  // left behind, so onClose knows a submit from a Cancel.
  const sent = useRef(null);
  const blocked = required && !note;
  const send = (close) => { if (blocked) return; sent.current = note; close(); };
  return (
    <Modal title={`${ask.title || action.label}: ${row.title}`} minHeight="auto"
      onClose={() => { if (sent.current !== null) onSubmit(sent.current); else onClose(); }}
      footer={(close) => (
        <>
          <button type="button" className="secondary-btn apv-ph-fbtn" onClick={() => close()}>Cancel</button>
          <button type="button" data-note-send className={`apv-ph-fbtn ${NO_KEYS.has(action.key) ? 'apv-btn apv-no' : 'primary-btn'}`} disabled={blocked} onClick={() => send(close)}>{action.label}</button>
        </>
      )}>
      <div className="apv-ph-note-wrap nx-fill">
        <label className="apv-ph-note-why" htmlFor="apv-ph-note">Why?</label>
        <p className="apv-ph-note-hint">{ask.message || (required ? 'They see this note with the decision.' : 'Optional - they see it with the decision.')}</p>
        <textarea id="apv-ph-note" className="form-input apv-ph-note" style={{ fontSize: /* type-ok: iOS zooms a field under 16px */ 16 }} placeholder={placeholder}
          value={text} onChange={(e) => setText(e.target.value)} autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.closest('[role="dialog"]')?.querySelector('[data-note-send]')?.click(); } }} />
        {required && <small className="apv-ph-note-req">A note is required for this one.</small>}
      </div>
    </Modal>
  );
}
