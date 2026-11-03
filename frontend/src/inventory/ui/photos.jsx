// Item Management - Photo widgets: the row thumbnail, the upload box and the handover photo slot.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useRef, useEffect } from 'react';
import { Camera } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { FL } from './styles';
import { imageFromPaste, uploadToSupabase } from './upload';

export function PhotoThumb({ url, name, onPreview, size = 44 }) {
  if (!url) return (
    <div style={{ width:size, height:size, borderRadius:8, background:'hsla(var(--color-red),0.08)', border:'1px dashed hsla(var(--color-red),0.4)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}
      title="No photo - required">
      <Camera size={size * 0.38} color="hsl(var(--color-red))" />
    </div>
  );
  return (
    <div onClick={onPreview ? () => onPreview(url, name) : undefined}
      style={{ width:size, height:size, borderRadius:8, overflow:'hidden', cursor:onPreview ? 'pointer' : 'default', flexShrink:0, border:'1px solid var(--line)' }}>
      <img src={url} alt={name || 'Item photo'} loading="lazy" decoding="async" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
    </div>
  );
}

// ── Photo upload widget ────────────────────────────────────────────────────────
export function PhotoUpload({ value, onChange, label = 'PHOTO', required = false, hint }) {
  const fileRef = useRef(null);
  const [preview, setPreview] = useState(value || null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { setPreview(value || null); }, [value]);

  async function handleFile(file) {
    if (!file) return;
    setUploading(true); setErr('');
    const path = `item-photos/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { url, error } = await uploadToSupabase(file, 'item-photos', path);
    if (error) { setErr(error); setUploading(false); return; }
    setPreview(url);
    onChange(url);
    setUploading(false);
  }

  // Ctrl+V a screenshot/snip anywhere in this box → upload it (Neil: the Batch
  // Edit paste feature should work in the regular Edit too). Pasting text (a URL)
  // into the link box still works normally.
  function handlePaste(e) {
    const list = e.clipboardData?.items || [];
    for (const it of list) {
      if (it.type && it.type.startsWith('image/')) {
        const blob = it.getAsFile();
        if (blob) {
          e.preventDefault();
          handleFile(blob.name ? blob : new File([blob], `paste-${Date.now()}.png`, { type: blob.type || 'image/png' }));
          return;
        }
      }
    }
  }

  return (
    <div onPaste={handlePaste} tabIndex={0} style={{ outline:'none' }}>
      <label style={FL}>{label}{required && <span style={{ color:'hsl(var(--color-red))' }}> *</span>}</label>
      {hint && <p style={{ fontSize:11.5, color:'var(--muted)', marginBottom:8, marginTop:-2 }}>{hint}</p>}
      <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }}
        onChange={e => handleFile(e.target.files?.[0])} />
      {preview ? (
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <img src={preview} alt="Preview" style={{ width:72, height:72, objectFit:'cover', borderRadius:8, border:'1px solid var(--line)' }} />
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            <button type="button" className="secondary-btn" style={{ fontSize:12, padding:'5px 12px' }}
              onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? 'Uploading…' : 'Replace photo'}
            </button>
            <button type="button" style={{ background:'none', border:'none', cursor:'pointer', fontSize:11.5, color:'hsl(var(--color-red))' }}
              onClick={() => { setPreview(null); onChange(''); }}>Remove</button>
          </div>
        </div>
      ) : (
        <button type="button"
          onClick={() => fileRef.current?.click()} disabled={uploading}
          style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 16px', borderRadius:9, border:`2px dashed ${required ? 'hsla(var(--color-red),0.4)' : 'var(--line)'}`, background: required ? 'hsla(var(--color-red),0.04)' : 'var(--mist)', cursor:'pointer', fontSize:13, color:'var(--muted)', width:'100%', justifyContent:'center' }}>
          {uploading ? <><Spinner size={15} /> Uploading…</> : <><Camera size={15} /> {required ? 'Upload photo (required)' : 'Upload photo'}</>}
        </button>
      )}
      {/* Paste an image URL instead of uploading a file (Neil: add URL to
          individual items). Pasting an image here pastes the screenshot too. */}
      <input className="form-input" type="url" value={value || ''}
        onChange={e => onChange(e.target.value.trim())} onPaste={handlePaste}
        placeholder="…or paste an image URL (https://…)"
        style={{ width:'100%', fontSize:12, padding:'6px 10px', marginTop:8 }} />
      <p style={{ fontSize:11, color:'var(--muted)', margin:'5px 0 0' }}>Upload a file, paste a URL, or press <strong>Ctrl+V</strong> to paste a screenshot.</p>
      {err && <p style={{ fontSize:11.5, color:'hsl(var(--color-red))', marginTop:5 }}>{err}</p>}
    </div>
  );
}

// ── Allocate Modal (manager/allocator takes checkout photo here) ───────────────
// ── Photo upload slot used inside AllocateModal and ReceiptConfirmModal ────────
export function PhotoSlot({ label, slotKey, photos, onChange, required = true }) {
  const ref = useRef(null);
  const entry = photos[slotKey] || {};
  function handleFile(f) {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = e => onChange(slotKey, { file: f, preview: e.target.result, name: f.name });
    reader.readAsDataURL(f);
  }
  return (
    <div tabIndex={0} style={{ marginBottom:12, outline:'none' }}
      onPaste={e => { const f = imageFromPaste(e); if (f) { e.preventDefault(); handleFile(f); } }}>
      {label && <div style={{ fontSize:11.5, fontWeight:600, color:'var(--muted)', marginBottom:5, textTransform:'uppercase', letterSpacing:'.04em' }}>{label}</div>}
      <input ref={ref} type="file" accept="image/*" style={{ display:'none' }} onChange={e => handleFile(e.target.files?.[0])} />
      {entry.preview ? (
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <img src={entry.preview} alt="" style={{ width:64, height:64, objectFit:'cover', borderRadius:8, border:'1px solid var(--line)', flexShrink:0 }} />
          <div>
            <div style={{ fontSize:12, fontWeight:600, marginBottom:4 }}>{entry.name}</div>
            <button type="button" className="secondary-btn" style={{ fontSize:11.5, padding:'3px 10px' }} onClick={() => ref.current?.click()}>Replace</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => ref.current?.click()}
          style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:8, padding:'12px', borderRadius:9, border:`2px dashed ${required ? 'hsla(var(--color-red),0.4)' : 'var(--line)'}`, background: required ? 'hsla(var(--color-red),0.04)' : 'var(--mist)', cursor:'pointer', fontSize:13, color:'var(--muted)', fontFamily:'Inter,sans-serif' }}>
          <Camera size={15} /> Take / upload photo {required
            ? <span style={{ fontSize:11, marginLeft:4, color:'hsl(var(--color-red))' }}>*</span>
            : <span style={{ fontSize:11, marginLeft:4 }}>(optional)</span>}
        </button>
      )}
      {!entry.preview && <p style={{ fontSize:11, color:'var(--muted)', margin:'5px 0 0' }}>or press Ctrl+V to paste a screenshot</p>}
    </div>
  );
}
