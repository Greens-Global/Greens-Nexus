// Return Pending (Neil, 11/14/2026): an item still out with someone when
// they were marked Left stays out - not lendable or assignable to anyone
// else - until someone presses Received or Lost, on the exit (People >
// Exits) or on the item in Item Management. The ordinary return rules apply
// (routers/items.settle_return_pending): Received needs a return photo
// (uploaded to the private return-photos bucket, Ctrl+V pastes one), Lost
// needs none and marks the item Lost - held, it cannot be taken back.
import { useEffect, useRef, useState } from 'react';
import { CheckCircle, Camera, HelpCircle } from 'lucide-react';
import { Modal } from '../tasks/components';
import { Spinner } from './AsyncState';
import HoldButton, { HOLD_RECORD_MS } from '../ui/HoldButton';
import { imageFromPaste, uploadToSupabase } from '../inventory/ui/upload';

const small = { fontSize: 12, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 };

/** The photo and note for Received - a sheet (it is a form). */
export function ReceivedSheet({ item, holder = '', onClose, onConfirm, toastErr }) {
  const [file, setFileNow] = useState(null);
  const [preview, setPreview] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const shown = useRef('');
  const needsPhoto = item.pictureRequired !== false;
  const setFile = (f) => {
    if (shown.current) URL.revokeObjectURL(shown.current);
    shown.current = f ? URL.createObjectURL(f) : '';
    setPreview(shown.current);
    setFileNow(f);
  };
  useEffect(() => {
    const onPaste = (ev) => {
      const f = imageFromPaste(ev);
      if (!f) return;
      ev.preventDefault();
      if (shown.current) URL.revokeObjectURL(shown.current);
      shown.current = URL.createObjectURL(f);
      setPreview(shown.current);
      setFileNow(f);
    };
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('paste', onPaste); if (shown.current) URL.revokeObjectURL(shown.current); };
  }, []);
  async function save() {
    setBusy(true);
    try {
      let photo = { url: '', name: '' };
      if (file) {
        const ext = (file.name.split('.').pop() || 'png').toLowerCase();
        const up = await uploadToSupabase(file, 'return-photos', `left/${item.rowId || item.id}-${Date.now()}.${ext}`);
        if (up.error) throw new Error(up.error);
        photo = { url: up.url, name: file.name };
      }
      await onConfirm({ photo_url: photo.url, photo_name: photo.name, note: note.trim() });
    } catch (e) {
      toastErr?.(e?.message || 'Could not mark it received.');
      setBusy(false);
    }
  }
  return (
    <Modal title={`Received - ${item.name || item.itemName || 'Item'}`} onClose={onClose} zIndex={4200} isDirty={(!!file || !!note.trim()) && !busy}
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-btn" onClick={save} disabled={busy || (needsPhoto && !file)}
          title={needsPhoto && !file ? 'Add the return photo first' : undefined}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy ? <Spinner size={14} /> : <CheckCircle size={14} />} Mark Received
        </button>
      </>}>
      <div style={{ fontFamily: 'Inter,sans-serif', fontSize: 13, lineHeight: 1.5 }}>
        <div>{holder ? `${holder} has left. ` : ''}Mark it received once it is back in hand - it goes back into stock.</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', margin: '14px 0 6px' }}>Return Photo{needsPhoto ? ' *' : ''}</div>
        <button type="button" onClick={() => input.current?.click()} disabled={busy}
          style={{ width: '100%', minHeight: 140, border: '1px dashed var(--line)', borderRadius: 12, background: 'var(--mist)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 10, font: 'inherit', color: 'var(--muted)' }}>
          {preview
            ? <img src={preview} alt="Return photo" style={{ maxHeight: 220, maxWidth: '100%', borderRadius: 8 }} />
            : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Camera size={16} /> Click to take or choose a photo - or press Ctrl+V to paste one</span>}
        </button>
        <input ref={input} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
          onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) setFile(f); }} />
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', margin: '14px 0 6px' }}>Note</div>
        <input className="form-input" style={{ width: '100%' }} value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="e.g. Dropped off at the front desk" />
      </div>
    </Modal>
  );
}

/**
 * Received / Lost on one Return Pending row. `item`: { name, rowId, rowKind,
 * pictureRequired }; `settle(outcome, body)` calls the server and resolves
 * once it is saved.
 */
export function ReturnPendingButtons({ item, holder = '', settle, onDone, toastErr, disabled = false }) {
  const [receiving, setReceiving] = useState(false);
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <button type="button" className="secondary-btn" style={small} disabled={disabled} onClick={() => setReceiving(true)}>
        <CheckCircle size={12} /> Received
      </button>
      <HoldButton size="sm" label="Mark Lost" doneLabel="Lost" icon={HelpCircle} holdMs={HOLD_RECORD_MS} disabled={disabled}
        fallbackMessage={`Mark ${item.name || 'this item'} Lost? It stays out of circulation until an items manager marks it found.`}
        onConfirm={async () => {
          try { await settle('lost', {}); }
          catch (e) { throw new Error(e?.message || 'Could not mark it lost.', { cause: e }); }
        }}
        onDone={() => onDone?.()} />
      {receiving && (
        <ReceivedSheet item={item} holder={holder} toastErr={toastErr} onClose={() => setReceiving(false)}
          onConfirm={async (body) => { await settle('received', body); setReceiving(false); onDone?.(); }} />
      )}
    </span>
  );
}
