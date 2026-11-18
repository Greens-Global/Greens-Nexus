// Done on a field ticket (Construction plan phase 5, 11/03/2026): what was
// done (typed or dictated), the checklist, and a photo of the finished work -
// REQUIRED on a preventive ticket (evidence, the Items rule for handovers).
// POST /maintenance/tickets/{id}/done resolves it through update_ticket.
import { useState } from 'react';
import { Modal } from '../tasks/components';
import { api } from '../api';
import { PhotoPicker, DictateButton } from './workUi';
import { usePhotos, field, box, OVERDUE_COLOR } from './workLib';

export default function FinishWork({ row, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [steps, setSteps] = useState(() => (row.checklist || []).map((c) => ({ ...c })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const photos = usePhotos('finished');
  const needsPhoto = !!row.preventive;
  const ready = note.trim() && (!needsPhoto || photos.photos.length > 0) && !photos.busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true); setErr('');
    try {
      await api.finishMaintenanceWork(row.id, { note: note.trim(), photos: photos.photos.map((p) => p.url), checklist: steps });
      onDone?.();
    } catch (e) { setErr(e?.message || 'That did not save - try again.'); setBusy(false); }
  };
  return (
    <Modal title={`Mark Done · ${row.codeLabel}`} onClose={onClose} minHeight="auto" zIndex={4400}
      isDirty={!!note.trim() || photos.photos.length > 0}
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-btn" onClick={submit} disabled={!ready || busy}>{busy ? 'Saving...' : 'Mark Done'}</button>
      </>}>
      <div onPaste={photos.onPaste} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{row.subject}</div>
        {steps.length > 0 && (
          <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend style={{ ...field, marginBottom: 6 }}>Checklist</legend>
            {steps.map((s, i) => (
              <label key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 40, fontSize: 15, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!s.done} style={{ width: 20, height: 20 }}
                  onChange={(e) => setSteps((all) => all.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)))} />
                <span style={{ color: s.done ? 'var(--muted)' : 'var(--ink)', textDecoration: s.done ? 'line-through' : 'none' }}>{s.label}</span>
              </label>
            ))}
          </fieldset>
        )}
        <label style={field}>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            What Was Done <DictateButton value={note} onChange={setNote} />
          </span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} style={box}
            placeholder="Replaced the filter, cleared the drain line." />
        </label>
        <div style={field}>
          <span>Photo of the Finished Work</span>
          <PhotoPicker state={photos} required={needsPhoto} />
          {needsPhoto && !photos.photos.length && <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--muted)' }}>A preventive ticket needs one photo before it can be marked done.</span>}
        </div>
        {err && <div role="alert" style={{ color: OVERDUE_COLOR, fontSize: 13 }}>{err}</div>}
      </div>
    </Modal>
  );
}
