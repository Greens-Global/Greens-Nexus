// Item Management - Return an item (condition, photo).
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useRef } from 'react';
import { RotateCcw, Camera } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import { FL } from '../ui/styles';
import { imageFromPaste } from '../ui/upload';

// ── Return Modal ───────────────────────────────────────────────────────────────
// Explicit return condition (Neil / P1-13): an enum replaces the backend's old
// damage-keyword sniffing (which auto-retired items on "undamaged"/"not broken").
const RETURN_CONDITIONS = [
  { v:'ok',      label:'Good' },
  { v:'damaged', label:'Damaged' },
  { v:'lost',    label:'Lost' },
];
export function ReturnModal({ checkout, onClose, onSubmit, photoOptional = false }) {
  const [file,          setFile]          = useState(null);
  const [preview,       setPreview]       = useState('');
  const [conditionNote, setConditionNote] = useState('');
  const [condition,     setCondition]     = useState('ok');
  const [submitting,    setSubmitting]    = useState(false);
  const fileRef = useRef(null);

  function handleFile(f) {
    if (!f) return;
    setFile(f);
    const reader = new FileReader();
    reader.onload = e => setPreview(e.target.result);
    reader.readAsDataURL(f);
  }

  function submit() {
    if ((!file && !photoOptional) || submitting) return;
    setSubmitting(true);
    // `condition` drives the backend's retire/lost handling; the note stays free-text.
    Promise.resolve(onSubmit({ file, photoName: file?.name || '', conditionNote, condition }))
      .catch(() => {})
      .finally(() => setSubmitting(false));
  }

  const dirty = !!file || conditionNote.trim() !== '' || condition !== 'ok';
  const canSave = !!file || photoOptional;
  const guard = useUnsavedGuard(dirty, onClose, canSave ? submit : undefined);

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && !submitting && guard.requestClose()}>
      <div tabIndex={0} style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:420, boxShadow:'0 20px 60px rgba(0,0,0,0.3)', outline:'none' }}
        onPaste={e => { const f = imageFromPaste(e); if (f) { e.preventDefault(); handleFile(f); } }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Return Item</h3>
        <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:20 }}>
          Returning <strong>{checkout.itemName}</strong>. {photoOptional ? 'A photo is optional for this item.' : 'A photo of the item is required.'}
        </p>

        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
          <div>
            <label style={FL}>RETURN PHOTO {photoOptional
              ? <span style={{ fontSize:11, fontWeight:400 }}>(optional)</span>
              : <span style={{ color:'hsl(var(--color-red))' }}>*</span>}</label>
            <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }} onChange={e => handleFile(e.target.files?.[0])} />
            {preview ? (
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <img src={preview} alt="Return photo" style={{ width:72, height:72, objectFit:'cover', borderRadius:8, border:'1px solid var(--line)' }} />
                <button type="button" className="secondary-btn" style={{ fontSize:12 }} onClick={() => fileRef.current?.click()}>Replace</button>
              </div>
            ) : (
              <button type="button" onClick={() => fileRef.current?.click()}
                style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:8, padding:'12px', borderRadius:9, border:`2px dashed ${photoOptional ? 'var(--line)' : 'hsla(var(--color-red),0.4)'}`, background: photoOptional ? 'var(--mist)' : 'hsla(var(--color-red),0.04)', cursor:'pointer', fontSize:13, color:'var(--muted)' }}>
                <Camera size={15} /> Take / upload photo
              </button>
            )}
            <p style={{ fontSize:11, color:'var(--muted)', margin:'6px 0 0' }}>or press Ctrl+V to paste a screenshot</p>
          </div>
          {/* Explicit condition (P1-13) - the backend uses this instead of sniffing the note. */}
          <div>
            <label style={FL}>CONDITION</label>
            <div style={{ display:'flex', gap:8 }}>
              {RETURN_CONDITIONS.map(({ v, label }) => {
                const sel = condition === v;
                return (
                  <button key={v} type="button" onClick={() => setCondition(v)}
                    style={{ flex:1, padding:'8px 6px', borderRadius:9, fontSize:12.5, fontWeight:700, cursor:'pointer', fontFamily:'Inter,sans-serif',
                      border:`1px solid ${sel ? (v === 'ok' ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))') : 'var(--line)'}`,
                      background: sel ? (v === 'ok' ? 'hsla(var(--color-green),0.1)' : 'hsla(var(--color-red),0.08)') : 'var(--card)',
                      color: sel ? (v === 'ok' ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))') : 'var(--muted)' }}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label style={FL}>CONDITION NOTES <span style={{ fontSize:11, fontWeight:400 }}>(optional - note any damage)</span></label>
            <textarea rows={3} className="form-input" style={{ width:'100%', resize:'vertical', fontSize:13 }}
              placeholder="e.g. Minor scuff on handle, otherwise good condition"
              value={conditionNote} onChange={e => setConditionNote(e.target.value)} />
          </div>
        </div>

        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
          <button className="secondary-btn" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="primary-btn" disabled={(!file && !photoOptional) || submitting}
            style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:130, justifyContent:'center' }} onClick={submit}>
            {submitting ? <><Spinner size={14} /> Returning…</> : <><RotateCcw size={14} /> Confirm return</>}
          </button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose}
          onSave={canSave ? guard.saveAndClose : undefined} saving={guard.saving || submitting} />
      )}
    </div>
  );
}
