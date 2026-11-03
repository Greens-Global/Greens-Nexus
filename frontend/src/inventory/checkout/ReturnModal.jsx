// Item Management - Return an item (condition, photo).
// A sheet from the right (Items redesign, Neil 11/02/2026). A lost item has
// nothing to photograph, so Lost needs no photo - only where it was last seen
// (it used to be stuck behind the photo requirement). The photo taken at the
// handover shows beside the return photo, so the condition is judged on
// evidence.
import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { PhotoPick } from '../ui/photos';
import { ItemSheet, LABEL, HINT, ERROR } from '../ui/Sheet';

// Explicit return condition (P1-13): the server uses this enum, never the note.
export const RETURN_CONDITIONS = [
  { v: 'ok',      label: 'Good' },
  { v: 'damaged', label: 'Damaged' },
  { v: 'lost',    label: 'Lost' },
];

export function ConditionPicker({ value, onChange }) {
  return (
    <div role="radiogroup" aria-label="Condition" style={{ display: 'flex', gap: 8 }}>
      {RETURN_CONDITIONS.map(({ v, label }) => {
        const sel = value === v;
        return (
          <button key={v} type="button" role="radio" aria-checked={sel} onClick={() => onChange(v)}
            style={{ flex: 1, padding: '9px 6px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              border: `1px solid ${sel ? 'var(--wk-brand)' : 'var(--wk-line, var(--line))'}`,
              background: sel ? 'var(--wk-brand-tint)' : 'var(--card)', color: sel ? 'var(--wk-brand)' : 'var(--ink)' }}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function ReturnModal({ checkout, onClose, onSubmit, photoOptional = false, zIndex }) {
  const [photo,         setPhoto]         = useState(null);   // { file, preview, name }
  const [conditionNote, setConditionNote] = useState('');
  const [condition,     setCondition]     = useState('ok');
  const [submitting,    setSubmitting]    = useState(false);
  const [error,         setError]         = useState('');

  const lost = condition === 'lost';
  const needPhoto = !photoOptional && !lost;
  const needNote = lost;
  const ready = (!needPhoto || !!photo?.file) && (!needNote || !!conditionNote.trim());
  const handoverPhoto = checkout.receiptPhotoUrl || checkout.checkoutPhotoUrl || '';

  function submit() {
    if (!ready || submitting) return;
    setSubmitting(true); setError('');
    Promise.resolve(onSubmit({ file: lost ? null : (photo?.file || null), photoName: lost ? '' : (photo?.file?.name || ''), conditionNote: conditionNote.trim(), condition }))
      .then(() => onClose?.())
      .catch(err => { setError(err?.message || 'Could not confirm the return - please try again.'); setSubmitting(false); });
  }

  const dirty = !!photo?.file || conditionNote.trim() !== '' || condition !== 'ok';

  return (
    <ItemSheet title={`Return ${checkout.itemName}`} onClose={onClose} zIndex={zIndex}
      isDirty={dirty} onSave={ready ? submit : undefined}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={submitting}>Cancel</button>
        <button className="primary-btn" disabled={!ready || submitting} onClick={submit}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {submitting ? <><Spinner size={14} /> Returning…</> : <><RotateCcw size={14} /> {lost ? 'Report Lost' : 'Confirm Return'}</>}
        </button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <span style={LABEL}>Condition</span>
          <ConditionPicker value={condition} onChange={setCondition} />
          {lost && <p style={HINT}>No photo needed. An items manager will see it marked Lost; it cannot be borrowed again until it is found.</p>}
        </div>
        {!lost && (
          <div style={{ display: 'grid', gridTemplateColumns: handoverPhoto ? 'minmax(0, 1fr) 120px' : 'minmax(0, 1fr)', gap: 14, alignItems: 'start' }}>
            <PhotoPick label="Return Photo" required={needPhoto} value={photo} onChange={setPhoto} />
            {handoverPhoto && (
              <figure style={{ margin: 0 }}>
                <span style={LABEL}>At Handover</span>
                <img src={handoverPhoto} alt="At handover" style={{ width: 120, height: 90, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} />
              </figure>
            )}
          </div>
        )}
        <div>
          <label style={LABEL} htmlFor="return-note">{lost ? 'Where Was It Last Seen?' : 'Condition Notes'}{!needNote && <span style={{ fontWeight: 500, color: 'var(--muted)' }}> (optional)</span>}</label>
          <textarea id="return-note" rows={3} className="form-input" style={{ width: '100%', resize: 'vertical', fontSize: 13.5 }}
            placeholder={lost ? 'e.g. Left at the Austin site on 10/30/2026' : 'e.g. Minor scuff on the handle, otherwise good'}
            value={conditionNote} onChange={e => setConditionNote(e.target.value)} />
        </div>
        {error && <p style={ERROR}>{error}</p>}
      </div>
    </ItemSheet>
  );
}
