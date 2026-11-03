// Item Management - Hand an approved checkout over (photo now, or the employee confirms).
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState } from 'react';
import { CheckCircle } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import { uploadToSupabase } from '../ui/upload';
import { PhotoSlot } from '../ui/photos';

// ── Handover modal for the assigned allocator ──────────────────────────────────
// onConfirm receives: { photoBy:'allocator'|'employee', batch:bool, photoMap:{[id]:{url,name}} }
export function AllocateModal({ checkout, checkouts: checkoutBatch, onClose, onConfirm, photoOptional = false }) {
  const coItems = checkoutBatch || (checkout ? [checkout] : []);
  const first   = coItems[0] || {};
  const isMulti = coItems.length > 1;

  const [step,      setStep]      = useState('who');   // 'who' | 'mode' | 'upload' | 'employee'
  const [photoMode, setPhotoMode] = useState('batch'); // 'batch' | 'individual'
  const [photos,    setPhotos]    = useState({});       // { [coId|'batch']: { file, preview, name } }
  const [uploading, setUploading] = useState(false);
  const [error,     setError]     = useState('');

  // P0-4: the "Photos by You" path had NO photo guard (button only disabled while
  // uploading), letting a handover complete with no evidence. Mirror
  // ReceiptConfirmModal - require the photo(s) unless the item is photo-optional.
  const hasPhotos = photoOptional || (photoMode === 'batch'
    ? !!photos['batch']?.file
    : coItems.every(co => !!photos[co.id]?.file));

  function handlePhotoChange(key, val) { setPhotos(prev => ({ ...prev, [key]: val })); }

  async function uploadPhotoEntry(entry, checkoutId) {
    if (!entry?.file) return { url: '', name: '' };
    const path = `checkout-photos/${checkoutId}/${Date.now()}-${entry.file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { url, error: upErr } = await uploadToSupabase(entry.file, 'checkout-photos', path);
    if (upErr) throw new Error(upErr);
    return { url, name: entry.file.name };
  }

  async function submitAllocator() {
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
      await Promise.resolve(onConfirm({ photoBy: 'allocator', batch: photoMode === 'batch', photoMap }));
      onClose();
    } catch (err) {
      setError(err?.message || 'Upload failed - please try again.');
      setUploading(false);
    }
  }

  async function submitEmployee() {
    setUploading(true); setError('');
    try {
      await Promise.resolve(onConfirm({ photoBy: 'employee', batch: false, photoMap: {} }));
      onClose();
    } catch (err) {
      setError(err?.message || 'Could not initiate handover.');
      setUploading(false);
    }
  }

  const CARD = { background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:460, boxShadow:'0 20px 60px rgba(0,0,0,0.3)', maxHeight:'90vh', overflowY:'auto' };

  const dirty = step !== 'who' || Object.values(photos).some(p => p?.file);
  const guard = useUnsavedGuard(dirty, onClose, undefined);

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && !uploading && guard.requestClose()}>
      <div style={CARD}>

        {/* Step: who takes photos */}
        {step === 'who' && (
          <>
            <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Hand over {isMulti ? `${coItems.length} Items` : first.itemName}</h3>
            <p style={{ fontSize:13, color:'var(--muted)', marginBottom:20 }}>
              To <strong>{first.requestedBy}</strong> - who will upload the handover photo?
            </p>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:20 }}>
              {/* Neil: no icons here (misleading), and "Employee" → "Requester" -
                  everyone is technically an employee */}
              {[
                { id:'you',      title:'Photos by You',       sub:'You upload now - individual items or a batch shot.' },
                { id:'employee', title:'Photos by Requester', sub:'Requester confirms receipt and uploads on their side.' },
              ].map(opt => (
                <button key={opt.id} onClick={() => opt.id === 'you' ? setStep(isMulti ? 'mode' : 'upload') || setPhotoMode('batch') : setStep('employee')}
                  style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', gap:6, padding:'14px 16px', borderRadius:12, border:'1.5px solid var(--line)', background:'var(--mist)', cursor:'pointer', textAlign:'left', fontFamily:'Inter,sans-serif', transition:'border-color .15s, box-shadow .15s' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor='var(--pine)'; e.currentTarget.style.boxShadow='0 2px 12px rgba(0,0,0,.08)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor='var(--line)'; e.currentTarget.style.boxShadow='none'; }}>
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

        {/* Step: individual or batch (only for multi-item orders) */}
        {step === 'mode' && (
          <>
            <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Photo Style</h3>
            <p style={{ fontSize:13, color:'var(--muted)', marginBottom:20 }}>
              Handing over <strong>{coItems.length} items</strong> to <strong>{first.requestedBy}</strong>.
            </p>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:20 }}>
              {[
                { id:'individual', title:'Individual Photos', sub:'One photo per item - best for high-value assets.' },
                { id:'batch',      title:'Batch Photo',       sub:'One photo of all items together - quick for groups.' },
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
            <div style={{ display:'flex', justifyContent:'space-between' }}>
              <button className="secondary-btn" style={{ fontSize:12 }} onClick={() => setStep('who')}>← Back</button>
              <button className="secondary-btn" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {/* Step: upload photos */}
        {step === 'upload' && (
          <>
            <h3 style={{ fontSize:16, fontWeight:700, marginBottom:4 }}>
              {/* Single-item handover must not read "Batch Photo" (Neil) */}
              {!isMulti ? 'Handover Photo' : photoMode === 'batch' ? 'Batch Photo' : 'Individual Photos'}
            </h3>
            <p style={{ fontSize:13, color:'var(--muted)', marginBottom:16 }}>
              {photoMode === 'batch'
                ? `One photo covering all ${isMulti ? coItems.length + ' items' : first.itemName} for ${first.requestedBy}.`
                : `Upload a photo for each item being handed to ${first.requestedBy}.`}
            </p>
            {photoMode === 'batch' ? (
              <PhotoSlot label={isMulti ? `All ${coItems.length} items together` : first.itemName} slotKey="batch" photos={photos} onChange={handlePhotoChange} required={!photoOptional} />
            ) : (
              coItems.map(co => <PhotoSlot key={co.id} label={co.itemName} slotKey={co.id} photos={photos} onChange={handlePhotoChange} required={!photoOptional} />)
            )}
            {error && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', marginTop:8 }}>{error}</p>}
            <div style={{ display:'flex', gap:10, justifyContent:'space-between', marginTop:16 }}>
              <button className="secondary-btn" style={{ fontSize:12 }} onClick={() => setStep(isMulti ? 'mode' : 'who')}>← Back</button>
              <div style={{ display:'flex', gap:8 }}>
                <button className="secondary-btn" onClick={onClose} disabled={uploading}>Cancel</button>
                <button className="primary-btn" disabled={uploading || !hasPhotos}
                  style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:150, justifyContent:'center', opacity: (!hasPhotos && !uploading) ? 0.45 : 1 }}
                  onClick={submitAllocator}>
                  {uploading ? <><Spinner size={14} /> Uploading…</> : <><CheckCircle size={14} /> Confirm handover</>}
                </button>
              </div>
            </div>
          </>
        )}

        {/* Step: employee-photo confirmation */}
        {step === 'employee' && (
          <>
            <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Confirm Handover</h3>
            <div style={{ background:'hsla(var(--color-blue),0.07)', border:'1px solid hsla(var(--color-blue),0.2)', borderRadius:10, padding:'14px 16px', marginBottom:20 }}>
              <div style={{ fontWeight:600, fontSize:13.5, marginBottom:4 }}>
                {isMulti ? `${coItems.length} items` : first.itemName} → {first.requestedBy}
              </div>
              {isMulti && (
                <div style={{ marginTop:6, display:'flex', flexDirection:'column', gap:2 }}>
                  {coItems.map(co => <div key={co.id} style={{ fontSize:12, color:'var(--muted)' }}>· {co.itemName}</div>)}
                </div>
              )}
              <div style={{ fontSize:12.5, color:'var(--muted)', marginTop:8, lineHeight:1.5 }}>
                {first.requestedBy} will be prompted on their side to confirm receipt and upload a photo. The checkout won't complete until they do.
              </div>
            </div>
            {error && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', marginTop:8 }}>{error}</p>}
            <div style={{ display:'flex', gap:10, justifyContent:'space-between' }}>
              <button className="secondary-btn" style={{ fontSize:12 }} onClick={() => setStep('who')}>← Back</button>
              <div style={{ display:'flex', gap:8 }}>
                <button className="secondary-btn" onClick={onClose} disabled={uploading}>Cancel</button>
                <button className="primary-btn" disabled={uploading}
                  style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:160, justifyContent:'center' }}
                  onClick={submitEmployee}>
                  {uploading ? <><Spinner size={14} /> Please wait…</> : <><CheckCircle size={14} /> Handed over - notify {(first.requestedBy || 'Requester').split(' ')[0]}</>}
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
