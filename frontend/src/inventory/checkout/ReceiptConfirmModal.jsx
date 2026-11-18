// Item Management - The requester confirms receipt with a photo.
// A sheet from the right (Items redesign, Neil 11/02/2026).
import { useState } from 'react';
import { CheckCircle, ChevronLeft } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { uploadToSupabase } from '../ui/upload';
import { PhotoSlot } from '../ui/photos';
import { ItemSheet, ERROR } from '../ui/Sheet';

// onConfirm receives: { batch:bool, photoMap:{[id]:{url,name}} }
export function ReceiptConfirmModal({ checkout, checkouts: checkoutBatch, onClose, onConfirm, photoOptional = false, zIndex }) {
  const coItems = checkoutBatch || (checkout ? [checkout] : []);
  const first   = coItems[0] || {};
  const isMulti = coItems.length > 1;

  const [step,      setStep]      = useState(isMulti ? 'mode' : 'upload');
  const [photoMode, setPhotoMode] = useState('batch');
  const [photos,    setPhotos]    = useState({});
  const [uploading, setUploading] = useState(false);
  const [error,     setError]     = useState('');

  const hasPhotos = photoOptional || (photoMode === 'batch'
    ? !!photos['batch']?.file
    : coItems.every(co => !!photos[co.id]?.file));

  function handlePhotoChange(key, val) { setPhotos(prev => ({ ...prev, [key]: val })); }

  async function uploadPhotoEntry(entry, checkoutId) {
    if (!entry?.file) return { url: '', name: '' };
    const path = `receipt-photos/${checkoutId}/${Date.now()}-${entry.file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { url, error: upErr } = await uploadToSupabase(entry.file, 'checkout-photos', path);
    if (upErr) throw new Error(upErr);
    return { url, name: entry.file.name };
  }

  async function submit() {
    if (!hasPhotos || uploading) return;
    setUploading(true); setError('');
    try {
      const photoMap = {};
      if (photoMode === 'batch') {
        const { url, name } = await uploadPhotoEntry(photos['batch'], first.id);
        coItems.forEach(co => { photoMap[co.id] = { url, name }; });
      } else {
        for (const co of coItems) {
          const { url, name } = await uploadPhotoEntry(photos[co.id], co.id);
          photoMap[co.id] = { url, name };
        }
      }
      await Promise.resolve(onConfirm({ batch: photoMode === 'batch', photoMap }));
      onClose();
    } catch (err) {
      setError(err?.message || 'Upload failed - please try again.');
      setUploading(false);
    }
  }

  const from = first.allocatedBy || first.assignedAllocatorName || 'Your allocator';
  const choice = (id, title, sub) => (
    <button key={id} type="button" onClick={() => { setPhotoMode(id); setStep('upload'); }}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, padding: '16px 18px', borderRadius: 12, border: '1px solid var(--wk-line, var(--line))', background: 'var(--card)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
      <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>{title}</span>
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>{sub}</span>
    </button>
  );

  return (
    <ItemSheet title="Confirm Receipt" onClose={onClose} zIndex={zIndex}
      isDirty={Object.values(photos).some(p => p?.file)}
      footer={step === 'mode'
        ? <button className="secondary-btn" onClick={onClose}>Cancel</button>
        : <>
            {isMulti && <button className="secondary-btn" style={{ marginRight: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={() => setStep('mode')} disabled={uploading}><ChevronLeft size={14} /> Back</button>}
            <button className="secondary-btn" onClick={onClose} disabled={uploading}>Cancel</button>
            <button className="primary-btn" disabled={uploading || !hasPhotos} onClick={submit}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              {uploading ? <><Spinner size={14} /> Uploading…</> : <><CheckCircle size={14} /> Confirm Receipt</>}
            </button>
          </>}>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px' }}>
        {from} handed {isMulti ? `${coItems.length} items` : first.itemName} to you. A photo records the condition it arrived in.
      </p>
      {step === 'mode' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          {choice('individual', 'Individual Photos', 'One photo per item.')}
          {choice('batch', 'Batch Photo', 'One photo of all the items together.')}
        </div>
      )}
      {step === 'upload' && (
        <>
          {photoMode === 'batch'
            ? <PhotoSlot label={isMulti ? `All ${coItems.length} items` : first.itemName} slotKey="batch" photos={photos} onChange={handlePhotoChange} required={!photoOptional} />
            : coItems.map(co => <PhotoSlot key={co.id} label={co.itemName} slotKey={co.id} photos={photos} onChange={handlePhotoChange} required={!photoOptional} />)}
          {error && <p style={ERROR}>{error}</p>}
        </>
      )}
    </ItemSheet>
  );
}
