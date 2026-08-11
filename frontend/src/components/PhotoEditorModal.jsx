import { useState } from 'react';
import { X, Camera, CheckCircle, Loader2, Trash2 } from 'lucide-react';
import { api } from '../api';

// Profile photo editor - view, re-crop (pan + zoom slider, thirds grid), or
// choose a new photo; exports a 512px square JPEG via canvas. Its own file
// (not inlined in HR.jsx) because TopHeader -> MyProfileModal needs it too,
// and TopHeader is always loaded - importing it from HR.jsx would drag that
// whole (huge) view into the main bundle instead of its own lazy chunk.
//
// Upload target is pluggable (onUpload) so the same cropper serves both HR's
// admin edit (any employee, via employee.photoUrl/onUpload below) and the
// self-service "My Profile" flow, which has no employee record in hand, only
// /myhr/profile. onRemove is optional - HR's admin path doesn't wire it (out
// of scope to add remove there too); My Profile does.
export default function PhotoEditorModal({ employee: e, photoUrl, title = 'Profile Photo', onUpload, onRemove, onClose, onSaved, toastOk, toastErr }) {
  const STAGE = 280;
  const initialUrl = photoUrl ?? e?.photoUrl ?? '';
  const doUpload = onUpload || (form => api.uploadEmployeePhoto(e.id, form));
  const [imgSrc, setImgSrc]   = useState(initialUrl);
  const [isRemote, setIsRemote] = useState(!!initialUrl);
  const [nat, setNat]         = useState(null);          // { w, h } natural size
  const [zoom, setZoom]       = useState(1);
  const [off, setOff]         = useState({ x: 0, y: 0 });
  const [busy, setBusy]       = useState(false);
  const imgRef  = useState({ current: null })[0];
  const dragRef = useState({ current: null })[0];

  const baseScale = nat ? STAGE / Math.min(nat.w, nat.h) : 1;
  const scale = baseScale * zoom;

  const clamp = (o, z = zoom) => {
    if (!nat) return o;
    const s = baseScale * z;
    return {
      x: Math.min(0, Math.max(STAGE - nat.w * s, o.x)),
      y: Math.min(0, Math.max(STAGE - nat.h * s, o.y)),
    };
  };

  function onImgLoad(ev) {
    const w = ev.target.naturalWidth, h = ev.target.naturalHeight;
    setNat({ w, h });
    const s = STAGE / Math.min(w, h);
    setZoom(1);
    setOff({ x: (STAGE - w * s) / 2, y: (STAGE - h * s) / 2 });
  }

  function pickFile(file) {
    if (!file) return;
    if (imgSrc && !isRemote) URL.revokeObjectURL(imgSrc);
    setImgSrc(URL.createObjectURL(file));
    setIsRemote(false);
    setNat(null);
  }

  // Ctrl+V a screenshot/snip anywhere in the modal → same cropper flow as a
  // chosen file.
  function handlePaste(ev) {
    const list = ev.clipboardData?.items || [];
    for (const it of list) {
      if (it.type && it.type.startsWith('image/')) {
        const blob = it.getAsFile();
        if (blob) {
          ev.preventDefault();
          pickFile(blob.name ? blob : new File([blob], `paste-${Date.now()}.png`, { type: blob.type || 'image/png' }));
          return;
        }
      }
    }
  }

  function onZoom(z) {
    // Keep the stage centre fixed while zooming
    if (!nat) { setZoom(z); return; }
    const sOld = baseScale * zoom, sNew = baseScale * z;
    const cx = (STAGE / 2 - off.x) / sOld, cy = (STAGE / 2 - off.y) / sOld;
    setZoom(z);
    setOff(clamp({ x: STAGE / 2 - cx * sNew, y: STAGE / 2 - cy * sNew }, z));
  }

  async function save() {
    if (!imgSrc || !nat || busy) return;
    setBusy(true);
    try {
      const blob = await new Promise((resolve, reject) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 512;
        const ctx = canvas.getContext('2d');
        const src = STAGE / scale;
        try {
          ctx.drawImage(imgRef.current, -off.x / scale, -off.y / scale, src, src, 0, 0, 512, 512);
        } catch (err) { reject(err); return; }
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not read the image - pick the file again.')), 'image/jpeg', 0.9);
      });
      const form = new FormData();
      form.append('file', blob, 'avatar.jpg');
      const updated = await doUpload(form);
      onSaved(updated);
      toastOk('Profile photo updated.');
      onClose();
    } catch (err) {
      toastErr(err?.message || 'Could not save the photo - try choosing the file again.');
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await onRemove();
      onSaved(updated);
      toastOk('Profile photo removed.');
      onClose();
    } catch (err) {
      toastErr(err?.message || 'Could not remove the photo.');
      setBusy(false);
    }
  }

  const gridLine = (pos, vertical) => (
    <div style={{ position: 'absolute', background: 'rgba(255,255,255,0.55)', pointerEvents: 'none',
      ...(vertical ? { left: pos, top: 0, bottom: 0, width: 1 } : { top: pos, left: 0, right: 0, height: 1 }) }} />
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={ev => ev.target === ev.currentTarget && !busy && onClose()}>
      <div onPaste={handlePaste} tabIndex={0} style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', outline: 'none' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>{title}</h3>
          <button onClick={onClose} disabled={busy} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: 22, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          {imgSrc ? (
            <div
              onPointerDown={ev => { ev.currentTarget.setPointerCapture(ev.pointerId); dragRef.current = { x: ev.clientX - off.x, y: ev.clientY - off.y }; }}
              onPointerMove={ev => { if (dragRef.current) setOff(clamp({ x: ev.clientX - dragRef.current.x, y: ev.clientY - dragRef.current.y })); }}
              onPointerUp={() => { dragRef.current = null; }}
              style={{ position: 'relative', width: STAGE, height: STAGE, borderRadius: 14, overflow: 'hidden', background: 'var(--mist)', cursor: 'grab', touchAction: 'none', flexShrink: 0 }}>
              <img ref={el => { imgRef.current = el; }} src={imgSrc} alt="" draggable={false}
                crossOrigin={isRemote ? 'anonymous' : undefined} onLoad={onImgLoad}
                style={{ position: 'absolute', left: off.x, top: off.y, width: nat ? nat.w * scale : 'auto', height: nat ? nat.h * scale : 'auto', maxWidth: 'none', userSelect: 'none' }} />
              {/* Rule-of-thirds grid */}
              {gridLine(STAGE / 3, true)}{gridLine((STAGE / 3) * 2, true)}
              {gridLine(STAGE / 3, false)}{gridLine((STAGE / 3) * 2, false)}
              <div style={{ position: 'absolute', inset: 0, border: '1px solid rgba(255,255,255,0.4)', borderRadius: 14, pointerEvents: 'none' }} />
            </div>
          ) : (
            <div style={{ width: STAGE, height: STAGE, borderRadius: 14, border: '1.5px dashed var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
              No photo yet - choose one below
            </div>
          )}
          {/* Zoom slider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: STAGE }}>
            <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700 }}>−</span>
            <input type="range" min="1" max="3" step="0.01" value={zoom} disabled={!nat}
              onChange={ev => onZoom(Number(ev.target.value))}
              style={{ flex: 1, accentColor: 'var(--pine)' }} />
            <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 700 }}>+</span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Drag to reposition · slide to zoom · Ctrl+V to paste a screenshot</div>
        </div>
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <label className="secondary-btn" style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <Camera size={13} /> {imgSrc ? 'Change photo' : 'Choose photo'}
            <input type="file" accept="image/jpeg,image/png,image/webp" hidden
              onChange={ev => { pickFile(ev.target.files?.[0]); ev.target.value = ''; }} />
          </label>
          {onRemove && initialUrl && (
            <button className="secondary-btn" onClick={remove} disabled={busy}
              style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, color: 'hsl(var(--color-red))' }}>
              <Trash2 size={13} /> Remove photo
            </button>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="primary-btn" onClick={save} disabled={!nat || busy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!nat || busy) ? 0.6 : 1 }}>
              {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Save photo
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
