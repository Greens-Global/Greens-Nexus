// Item Management - Hand an approved checkout over (photo now, or the requester confirms).
// A sheet from the right (Items redesign, Neil 11/02/2026).
import { useState } from 'react';
import { CheckCircle, ChevronLeft } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { uploadToSupabase } from '../ui/upload';
import { PhotoSlot } from '../ui/photos';
import { ItemSheet, ERROR } from '../ui/Sheet';

const CHOICE = {
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, padding: '16px 18px', borderRadius: 12,
  border: '1px solid var(--wk-line, var(--line))', background: 'var(--card)', cursor: 'pointer', textAlign: 'left',
  fontFamily: 'inherit', transition: 'border-color .15s, box-shadow .15s',
};

function Choice({ title, sub, onClick }) {
  return (
    <button type="button" onClick={onClick} style={CHOICE}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--wk-brand)'; e.currentTarget.style.boxShadow = 'var(--wk-shadow-hov)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--wk-line, var(--line))'; e.currentTarget.style.boxShadow = 'none'; }}>
      <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>{title}</span>
      <span style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.45 }}>{sub}</span>
    </button>
  );
}

// onConfirm receives: { photoBy:'allocator'|'employee', batch:bool, photoMap:{[id]:{url,name}} }
export function AllocateModal({ checkout, checkouts: checkoutBatch, onClose, onConfirm, photoOptional = false, zIndex }) {
  const coItems = checkoutBatch || (checkout ? [checkout] : []);
  const first   = coItems[0] || {};
  const isMulti = coItems.length > 1;
  const who     = first.requestedBy || 'the requester';

  const [step,      setStep]      = useState('who');   // 'who' | 'mode' | 'upload' | 'employee'
  const [photoMode, setPhotoMode] = useState('batch'); // 'batch' | 'individual'
  const [photos,    setPhotos]    = useState({});       // { [coId|'batch']: { file, preview, name } }
  const [uploading, setUploading] = useState(false);
  const [error,     setError]     = useState('');

  // Evidence: "Photos by You" needs the photo(s) unless the item is photo-optional.
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
      await Promise.resolve(onConfirm({ photoBy: 'allocator', batch: photoMode === 'batch', photoMap }));
      onClose();
    } catch (err) {
      setError(err?.message || 'The handover did not go through - please try again.');
      setUploading(false);
    }
  }

  async function submitEmployee() {
    if (uploading) return;
    setUploading(true); setError('');
    try {
      await Promise.resolve(onConfirm({ photoBy: 'employee', batch: false, photoMap: {} }));
      onClose();
    } catch (err) {
      setError(err?.message || 'Could not start the handover.');
      setUploading(false);
    }
  }

  const dirty = Object.values(photos).some(p => p?.file);
  const back = (to) => <button className="secondary-btn" style={{ marginRight: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={() => setStep(to)} disabled={uploading}><ChevronLeft size={14} /> Back</button>;
  const title = step === 'mode' ? 'Photo Style'
    : step === 'upload' ? (!isMulti ? 'Handover Photo' : photoMode === 'batch' ? 'Batch Photo' : 'Individual Photos')
    : step === 'employee' ? 'Confirm Handover'
    : `Hand Over ${isMulti ? `${coItems.length} Items` : first.itemName || 'Item'}`;

  const footer = step === 'who' ? <button className="secondary-btn" onClick={onClose}>Cancel</button>
    : step === 'mode' ? <>{back('who')}<button className="secondary-btn" onClick={onClose}>Cancel</button></>
    : step === 'upload' ? (
      <>
        {back(isMulti ? 'mode' : 'who')}
        <button className="secondary-btn" onClick={onClose} disabled={uploading}>Cancel</button>
        <button className="primary-btn" disabled={uploading || !hasPhotos} onClick={submitAllocator}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {uploading ? <><Spinner size={14} /> Uploading…</> : <><CheckCircle size={14} /> Confirm Handover</>}
        </button>
      </>
    ) : (
      <>
        {back('who')}
        <button className="secondary-btn" onClick={onClose} disabled={uploading}>Cancel</button>
        <button className="primary-btn" disabled={uploading} onClick={submitEmployee}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {uploading ? <><Spinner size={14} /> Please wait…</> : <><CheckCircle size={14} /> Handed Over - Notify {who.split(' ')[0]}</>}
        </button>
      </>
    );

  return (
    <ItemSheet title={title} onClose={onClose} isDirty={dirty} footer={footer} zIndex={zIndex}>
      {step === 'who' && (
        <>
          <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '0 0 18px' }}>
            To <strong style={{ color: 'var(--ink)' }}>{who}</strong> - who takes the handover photo?
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <Choice title="Photos by You" sub="You take the photo now - each item, or one shot of them all."
              onClick={() => { setPhotoMode('batch'); setStep(isMulti ? 'mode' : 'upload'); }} />
            <Choice title="Photos by Requester" sub={`${who.split(' ')[0]} confirms receipt and takes the photo on their side.`}
              onClick={() => setStep('employee')} />
          </div>
          {isMulti && (
            <ul style={{ margin: '18px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
              {coItems.map(co => <li key={co.id} style={{ fontSize: 13, color: 'var(--muted)' }}>{co.itemName}</li>)}
            </ul>
          )}
        </>
      )}

      {step === 'mode' && (
        <>
          <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '0 0 18px' }}>
            Handing over <strong style={{ color: 'var(--ink)' }}>{coItems.length} items</strong> to <strong style={{ color: 'var(--ink)' }}>{who}</strong>.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <Choice title="Individual Photos" sub="One photo per item - best for high-value assets."
              onClick={() => { setPhotoMode('individual'); setStep('upload'); }} />
            <Choice title="Batch Photo" sub="One photo of all the items together - quick for groups."
              onClick={() => { setPhotoMode('batch'); setStep('upload'); }} />
          </div>
        </>
      )}

      {step === 'upload' && (
        <>
          <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '0 0 16px' }}>
            {photoMode === 'batch'
              ? `One photo covering ${isMulti ? `all ${coItems.length} items` : first.itemName} for ${who}.`
              : `A photo of each item being handed to ${who}.`}
          </p>
          {photoMode === 'batch'
            ? <PhotoSlot label={isMulti ? `All ${coItems.length} items together` : first.itemName} slotKey="batch" photos={photos} onChange={handlePhotoChange} required={!photoOptional} />
            : coItems.map(co => <PhotoSlot key={co.id} label={co.itemName} slotKey={co.id} photos={photos} onChange={handlePhotoChange} required={!photoOptional} />)}
          {error && <p style={ERROR}>{error}</p>}
        </>
      )}

      {step === 'employee' && (
        <>
          <div style={{ border: '1px solid var(--wk-line2, var(--line))', borderRadius: 12, padding: '14px 16px', background: 'var(--mist)' }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{isMulti ? `${coItems.length} items` : first.itemName} to {who}</div>
            {isMulti && (
              <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 2 }}>
                {coItems.map(co => <li key={co.id} style={{ fontSize: 12.5, color: 'var(--muted)' }}>{co.itemName}</li>)}
              </ul>
            )}
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '10px 0 0', lineHeight: 1.5 }}>
              {who} will be asked to confirm receipt and take a photo. The checkout completes when they do.
            </p>
          </div>
          {error && <p style={ERROR}>{error}</p>}
        </>
      )}
    </ItemSheet>
  );
}
