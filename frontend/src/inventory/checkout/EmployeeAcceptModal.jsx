// Item Management - The employee accepts a handed-over item with a photo.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useRef } from 'react';
import { CheckCircle, Camera } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import { FL } from '../ui/styles';
import { imageFromPaste, uploadToSupabase } from '../ui/upload';

// ── Employee Accept Modal (employee takes checkout photo to confirm receipt) ───
export function EmployeeAcceptModal({ checkout, onClose, onConfirm, photoOptional = false }) {
  const [file,       setFile]       = useState(null);
  const [preview,    setPreview]    = useState('');
  const [uploading,  setUploading]  = useState(false);
  const [error,      setError]      = useState('');
  const fileRef = useRef(null);

  function handleFile(f) {
    if (!f) return;
    setFile(f);
    const reader = new FileReader();
    reader.onload = e => setPreview(e.target.result);
    reader.readAsDataURL(f);
  }

  async function submit() {
    if ((!file && !photoOptional) || uploading) return;
    setUploading(true); setError('');
    let url = '', name = '';
    if (file) {
      const path = `checkout-photos/${checkout.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const { url: uploaded, error: upErr } = await uploadToSupabase(file, 'checkout-photos', path);
      if (upErr) { setError(upErr); setUploading(false); return; }
      url = uploaded; name = file.name;
    }
    Promise.resolve(onConfirm(url, name))
      .then(onClose)
      .catch(err => { setError(err?.message || 'Could not confirm receipt.'); setUploading(false); });
  }

  const dirty = !!file;
  const canSave = !!file || photoOptional;
  const guard = useUnsavedGuard(dirty, onClose, canSave ? submit : undefined);

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div tabIndex={0} style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:420, boxShadow:'0 20px 60px rgba(0,0,0,0.3)', outline:'none' }}
        onPaste={e => { const f = imageFromPaste(e); if (f) { e.preventDefault(); handleFile(f); } }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Confirm you have it</h3>
        <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:20 }}>
          Take a photo of <strong>{checkout.itemName}</strong> to confirm you received it. This creates a condition record for the handover.
        </p>
        <div>
          <label style={FL}>HANDOVER PHOTO {photoOptional
            ? <span style={{ fontSize:11, fontWeight:400 }}>(optional)</span>
            : <span style={{ color:'hsl(var(--color-red))' }}>*</span>}</label>
          <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }} onChange={e => handleFile(e.target.files?.[0])} />
          {preview ? (
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <img src={preview} alt="Handover photo" style={{ width:72, height:72, objectFit:'cover', borderRadius:8, border:'1px solid var(--line)' }} />
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
        {error && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', marginTop:10 }}>{error}</p>}
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
          <button className="secondary-btn" onClick={onClose} disabled={uploading}>Cancel</button>
          <button className="primary-btn" disabled={(!file && !photoOptional) || uploading}
            style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:160, justifyContent:'center' }} onClick={submit}>
            {uploading ? <><Spinner size={14} /> Uploading…</> : <><CheckCircle size={14} /> Confirm receipt</>}
          </button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose}
          onSave={canSave ? guard.saveAndClose : undefined} saving={guard.saving || uploading} />
      )}
    </div>
  );
}
