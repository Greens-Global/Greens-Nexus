// Item Management - Reject a checkout request with a reason.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState } from 'react';
import { XCircle } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';

// ── Reject Modal - supports single or batch ───────────────────────────────────
export function RejectCheckoutModal({ checkout, checkouts: checkoutBatch, onClose, onConfirm }) {
  const items   = checkoutBatch || (checkout ? [checkout] : []);
  const first   = items[0] || {};
  const isMulti = items.length > 1;

  const [reason, setReason] = useState('');
  const [busy,   setBusy]   = useState(false);

  function submit() {
    if (!reason.trim() || busy) return;
    setBusy(true);
    Promise.resolve(onConfirm(reason.trim()))
      .then(onClose)
      .catch(() => setBusy(false));
  }

  const dirty = reason.trim() !== '';
  const guard = useUnsavedGuard(dirty, onClose, dirty ? submit : undefined);

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:380, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Reject checkout{isMulti ? 's' : ''}</h3>
        {isMulti ? (
          <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:16 }}>
            Rejecting <strong>{items.length} items</strong> for <strong>{first.requestedBy}</strong>. One reason applies to all.
          </p>
        ) : (
          <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:16 }}>Rejecting <strong>{first.itemName}</strong> for {first.requestedBy}. Give a reason.</p>
        )}
        <textarea rows={3} autoFocus className="form-input" style={{ width:'100%', resize:'vertical', fontSize:13, marginBottom:16 }}
          placeholder="Reason for rejection…" value={reason} onChange={e => setReason(e.target.value)} />
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button disabled={!reason.trim() || busy}
            style={{ background:'hsl(var(--color-red))', color:'#fff', border:'none', borderRadius:8, padding:'8px 18px', fontWeight:700, fontSize:13.5, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:7, fontFamily:'Inter,sans-serif' }}
            onClick={submit}>
            {busy ? <Spinner size={14} /> : <XCircle size={14} />} Reject
          </button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose}
          onSave={dirty ? guard.saveAndClose : undefined} saving={guard.saving || busy} />
      )}
    </div>
  );
}
