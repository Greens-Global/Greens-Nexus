// Item Management - Take an approved item of your own (a manager, or the
// allocator of their own request): the handover photo, then it is with you.
// A sheet from the right (Items redesign, Neil 11/02/2026).
import { useState } from 'react';
import { CheckCircle } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { uploadToSupabase } from '../ui/upload';
import { PhotoPick } from '../ui/photos';
import { ItemSheet, ERROR } from '../ui/Sheet';

export function EmployeeAcceptModal({ checkout, onClose, onConfirm, photoOptional = false, zIndex }) {
  const [photo,     setPhoto]     = useState(null);   // { file, preview, name }
  const [uploading, setUploading] = useState(false);
  const [error,     setError]     = useState('');

  async function submit() {
    if ((!photo?.file && !photoOptional) || uploading) return;
    setUploading(true); setError('');
    let url = '', name = '';
    if (photo?.file) {
      const path = `checkout-photos/${checkout.id}/${Date.now()}-${photo.file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const { url: uploaded, error: upErr } = await uploadToSupabase(photo.file, 'checkout-photos', path);
      if (upErr) { setError(upErr); setUploading(false); return; }
      url = uploaded; name = photo.file.name;
    }
    Promise.resolve(onConfirm(url, name))
      .then(onClose)
      .catch(err => { setError(err?.message || 'Could not confirm the handover.'); setUploading(false); });
  }

  return (
    <ItemSheet title={`Take ${checkout.itemName}`} onClose={onClose} zIndex={zIndex} isDirty={!!photo?.file}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={uploading}>Cancel</button>
        <button className="primary-btn" disabled={(!photo?.file && !photoOptional) || uploading} onClick={submit}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {uploading ? <><Spinner size={14} /> Uploading…</> : <><CheckCircle size={14} /> It's With Me</>}
        </button>
      </>}>
      <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.5 }}>
        A photo of <strong style={{ color: 'var(--ink)' }}>{checkout.itemName}</strong> as you take it records its condition at the handover.
      </p>
      <PhotoPick label="Handover Photo" required={!photoOptional} value={photo} onChange={setPhoto} />
      {error && <p style={ERROR}>{error}</p>}
    </ItemSheet>
  );
}
