// Photo proof reviews (WP 5.5, Oct 29 2026): Manage > Health's list of photo
// answers waiting on you. Approve, or send back with a note the learner sees.
// The quiz is graded once every photo on it is decided. Backend:
// GET /kb/photo-reviews, POST /kb/photo-reviews/{id}/decide.
import { useEffect, useState } from 'react';
import { Check, Undo2 } from 'lucide-react';
import { api } from '../../api';
import { Modal } from '../../tasks/components';
import { SectionHead } from '../components/Chips';
import { useToast, errText } from '../components/Toast';
import { fmtDateTime } from '../lib';

function SendBack({ row, onSent, onClose }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try { await api.kbDecidePhoto(row.id, 'reject', note.trim()); toast('Sent back'); onSent(); onClose(); }
    catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Send the Photo Back" onClose={onClose}
           footer={<div className="kb" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
             <button type="button" className="kb-btn" onClick={onClose}>Cancel</button>
             <button type="button" className="kb-btn pri" disabled={busy || !note.trim()} onClick={send}><Undo2 />Send Back</button></div>}>
      <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
        <div className="kb-title">{row.user_name} · {row.question}</div>
        <img src={row.photo_url} alt="The photo answer" style={{ maxWidth: 360, borderRadius: 10 }} />
        <div className="kb-field nx-fill" style={{ display: 'flex', flexDirection: 'column' }}>
          <label htmlFor="kb-photo-note">What To Fix</label>
          <textarea id="kb-photo-note" className="kb-textarea" style={{ flex: 1, minHeight: 90 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="The padlock is not visible" />
          <div className="kb-help">They see this as the reason the answer was missed.</div>
        </div>
      </div>
    </Modal>
  );
}

export default function PhotoReviews() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [back, setBack] = useState(null);
  const load = () => Promise.resolve().then(() => api.kbPhotoReviews()).then((r) => setRows(Array.isArray(r) ? r : [])).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  if (!rows || rows.length === 0) return null;
  const approve = (row) => api.kbDecidePhoto(row.id, 'approve').then(() => { toast('Approved'); load(); }).catch((e) => toast(errText(e), 'err'));
  return (
    <section className="kb-card">
      <SectionHead title="Photo Reviews" count={rows.length} sub="photo answers waiting on you" />
      {rows.map((r) => (
        <div key={r.id} className="kb-row" style={{ alignItems: 'flex-start' }}>
          <img src={r.photo_url} alt={`Photo from ${r.user_name}`} style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 8 }} />
          <div className="kb-grow"><div className="kb-title">{r.user_name}</div><div style={{ fontSize: 13.5 }}>{r.question}</div><div className="kb-meta">{r.course_title} · {fmtDateTime(r.created_at)}</div></div>
          <button type="button" className="kb-btn sm pri" onClick={() => approve(r)}><Check />Approve</button>
          <button type="button" className="kb-btn sm" onClick={() => setBack(r)}><Undo2 />Send Back</button>
        </div>
      ))}
      {back && <SendBack row={back} onSent={load} onClose={() => setBack(null)} />}
    </section>
  );
}
