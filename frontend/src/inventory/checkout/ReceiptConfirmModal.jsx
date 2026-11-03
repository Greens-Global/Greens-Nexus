// Item Management - The employee confirms receipt with a photo.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState } from 'react';
import { CheckCircle } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import { uploadToSupabase } from '../ui/upload';
import { PhotoSlot } from '../ui/photos';

// ── Receipt confirmation modal for the employee ────────────────────────────────
// onConfirm receives: { batch:bool, photoMap:{[id]:{url,name}} }
export function ReceiptConfirmModal({ checkout, checkouts: checkoutBatch, onClose, onConfirm, photoOptional = false }) {
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
    if (!hasPhotos) return;
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

  const CARD = { background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:460, boxShadow:'0 20px 60px rgba(0,0,0,0.3)', maxHeight:'90vh', overflowY:'auto' };

  const dirty = (isMulti && step !== 'mode') || Object.values(photos).some(p => p?.file);
  const guard = useUnsavedGuard(dirty, onClose, undefined);

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && !uploading && guard.requestClose()}>
      <div style={CARD}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:4 }}>Confirm Receipt</h3>
        <p style={{ fontSize:13, color:'var(--muted)', marginBottom:16 }}>
          {isMulti
            ? `${first.assignedAllocatorName || 'Your allocator'} has handed over ${coItems.length} items to you.`
            : `${first.assignedAllocatorName || 'Your allocator'} has handed over ${first.itemName} to you.`}
        </p>

        {step === 'mode' && (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:20 }}>
              {/* No emoji icons here - matches AllocateModal (Neil rejected them). */}
              {[
                { id:'individual', title:'Individual Photos', sub:'One photo per item.' },
                { id:'batch',      title:'Batch Photo',       sub:'One photo of all items together.' },
              ].map(opt => (
                <button key={opt.id} onClick={() => { setPhotoMode(opt.id); setStep('upload'); }}
                  style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', gap:6, padding:'14px 16px', borderRadius:12, border:'1.5px solid var(--line)', background:'var(--mist)', cursor:'pointer', textAlign:'left', fontFamily:'Inter,sans-serif', transition:'border-color .15s' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor='var(--pine)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor='var(--line)'}>
                  <span style={{ fontWeight:700, fontSize:13.5 }}>{opt.title}</span>
                  <span style={{ fontSize:12, color:'var(--muted)', lineHeight:1.4 }}>{opt.sub}</span>
                </button>
              ))}
            </div>
            <div style={{ display:'flex', justifyContent:'flex-end' }}>
              <button className="secondary-btn" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {step === 'upload' && (
          <>
            {photoMode === 'batch' ? (
              <PhotoSlot label={isMulti ? `All ${coItems.length} items` : first.itemName} slotKey="batch" photos={photos} onChange={handlePhotoChange} required={!photoOptional} />
            ) : (
              coItems.map(co => <PhotoSlot key={co.id} label={co.itemName} slotKey={co.id} photos={photos} onChange={handlePhotoChange} required={!photoOptional} />)
            )}
            {error && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', marginTop:8 }}>{error}</p>}
            <div style={{ display:'flex', gap:10, justifyContent:'space-between', marginTop:16 }}>
              {isMulti ? (
                <button className="secondary-btn" style={{ fontSize:12 }} onClick={() => setStep('mode')}>← Back</button>
              ) : <span />}
              <div style={{ display:'flex', gap:8 }}>
                <button className="secondary-btn" onClick={onClose} disabled={uploading}>Cancel</button>
                <button className="primary-btn" disabled={uploading || !hasPhotos}
                  style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:150, justifyContent:'center', opacity: (!hasPhotos && !uploading) ? 0.45 : 1 }}
                  onClick={submit}>
                  {uploading ? <><Spinner size={14} /> Uploading…</> : <><CheckCircle size={14} /> Confirm receipt</>}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} />
      )}
    </div>
  );
}
