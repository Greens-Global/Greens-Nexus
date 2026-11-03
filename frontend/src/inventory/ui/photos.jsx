// Item Management - Photo widgets: the row thumbnail, the upload box and the handover photo slot.
// Items redesign (Neil, 11/02/2026): one quiet look before anyone acts - a
// neutral dashed box and a plain "Required" word, never a red box shouting at
// someone who has not done anything yet. The Missing Photo filter on
// Inventory is where an absent photo is called out.
import { useState, useRef, useEffect } from 'react';
import { Camera, ImageOff } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { LABEL, HINT } from './Sheet';
import { imageFromPaste, uploadToSupabase } from './upload';

const DROP = {
  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 12px',
  borderRadius: 10, border: '1px dashed var(--wk-line, var(--line))', background: 'var(--mist)',
  cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--ink)', fontFamily: 'inherit',
};
const NEED = { fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginLeft: 6 };

/** The one "No Photo" placeholder (a tile, a row, the record's hero). */
export function NoPhoto({ size = 44, label = true, radius = 8, style }) {
  const big = size >= 96;
  return (
    <div title="No photo" style={{ width: size, height: size, borderRadius: radius, background: 'var(--mist)', border: '1px solid var(--wk-line2, var(--line))', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, flexShrink: 0, color: 'var(--muted)', ...style }}>
      <ImageOff size={Math.max(14, Math.round(size * (big ? 0.18 : 0.36)))} strokeWidth={1.7} />
      {label && big && <span style={{ fontSize: 12, fontWeight: 600 }}>No Photo</span>}
    </div>
  );
}

export function PhotoThumb({ url, name, onPreview, size = 44 }) {
  if (!url) return <NoPhoto size={size} />;
  return (
    <div onClick={onPreview ? () => onPreview(url, name) : undefined}
      style={{ width: size, height: size, borderRadius: 8, overflow: 'hidden', cursor: onPreview ? 'zoom-in' : 'default', flexShrink: 0, border: '1px solid var(--line)' }}>
      <img src={url} alt={name || 'Item photo'} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    </div>
  );
}

// ── Photo upload widget (the item's catalog photo) ─────────────────────────────
export function PhotoUpload({ value, onChange, label = 'Photo', required = false, hint }) {
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

  // Ctrl+V a screenshot anywhere in this box uploads it; pasting text (a URL)
  // into the link box still works normally.
  function handlePaste(e) {
    const f = imageFromPaste(e);
    if (f) { e.preventDefault(); handleFile(f); }
  }

  return (
    <div onPaste={handlePaste} tabIndex={0} style={{ outline: 'none' }}>
      <label style={LABEL}>{label}{required && <span style={NEED}>Required</span>}</label>
      {hint && <p style={{ ...HINT, margin: '-2px 0 8px' }}>{hint}</p>}
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={e => handleFile(e.target.files?.[0])} />
      {preview ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src={preview} alt="Preview" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button type="button" className="secondary-btn" style={{ fontSize: 12, padding: '5px 12px' }}
              onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? 'Uploading…' : 'Replace Photo'}
            </button>
            <button type="button" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--muted)', textAlign: 'left', padding: 0 }}
              onClick={() => { setPreview(null); onChange(''); }}>Remove</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} style={DROP}>
          {uploading ? <><Spinner size={15} /> Uploading…</> : <><Camera size={15} /> Take or Upload Photo</>}
        </button>
      )}
      {/* Paste an image URL instead of uploading a file (Neil). */}
      <input className="form-input" type="url" value={value || ''}
        onChange={e => onChange(e.target.value.trim())} onPaste={handlePaste}
        placeholder="…or paste an image link (https://…)"
        style={{ width: '100%', fontSize: 12.5, padding: '6px 10px', marginTop: 8 }} />
      <p style={HINT}>Upload a file, paste a link, or press Ctrl+V to paste a screenshot.</p>
      {err && <p style={{ fontSize: 12, color: 'var(--bad-fg)', marginTop: 5 }}>{err}</p>}
    </div>
  );
}

// ── Photo slot used for handover / receipt / return evidence ───────────────────
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
    <div tabIndex={0} style={{ marginBottom: 12, outline: 'none' }}
      onPaste={e => { const f = imageFromPaste(e); if (f) { e.preventDefault(); handleFile(f); } }}>
      {label && <div style={{ ...LABEL, marginBottom: 6 }}>{label}{required ? <span style={NEED}>Required</span> : <span style={NEED}>Optional</span>}</div>}
      <input ref={ref} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleFile(e.target.files?.[0])} />
      {entry.preview ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src={entry.preview} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)', flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</div>
            <button type="button" className="secondary-btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => ref.current?.click()}>Replace</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => ref.current?.click()} style={DROP}>
          <Camera size={15} /> Take or Upload Photo
        </button>
      )}
      {!entry.preview && <p style={HINT}>or press Ctrl+V to paste a screenshot</p>}
    </div>
  );
}

/** A single evidence photo held in local state ({file, preview, name}). */
export function PhotoPick({ label = 'Photo', required = true, value, onChange }) {
  return (
    <PhotoSlot label={label} slotKey="one" photos={{ one: value || {} }} required={required}
      onChange={(_k, v) => onChange(v)} />
  );
}
