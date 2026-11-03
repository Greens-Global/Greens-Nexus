// Item Management - A manager closes a checkout as returned.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import { FL } from '../ui/styles';

// ── Force Return Modal ────────────────────────────────────────────────────────
// Manager reclaims an item without the holder's action. Reason is mandatory -
// it is stored on the checkout and shows up in the audit trail (Neil: "leaves
// 100% of the control with the manager here and an auditable log of why").
export function ForceReturnModal({ checkout, checkouts, onClose, onConfirm }) {
  const list = checkouts || [checkout];
  const multi = list.length > 1;
  const holders = [...new Set(list.map(c => c.requestedBy))];
  const [reason, setReason] = useState('');
  const [busy,   setBusy]   = useState(false);
  const [error,  setError]  = useState('');

  function submit() {
    if (!reason.trim() || busy) return;
    setBusy(true); setError('');
    Promise.resolve(onConfirm(reason.trim()))
      .then(onClose)
      .catch(err => { setError(err?.message || 'Could not check the item back in.'); setBusy(false); });
  }

  const dirty = reason.trim() !== '';
  const guard = useUnsavedGuard(dirty, onClose, dirty ? submit : undefined);

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:420, boxShadow:'0 20px 60px rgba(0,0,0,0.3)', maxHeight:'min(85dvh, 640px)', display:'flex', flexDirection:'column' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Force return{multi ? ` ${list.length} Items` : ''}</h3>
        <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:16, lineHeight:1.5 }}>
          Check {multi ? <strong>{list.length} items</strong> : <strong>{list[0].itemName}</strong>} back
          in on behalf of <strong>{holders.length === 1 ? holders[0] : `${holders.length} people`}</strong>.
          Use this when the holder can't or won't return it in the app. The reason is recorded on
          {multi ? ' every checkout' : ' the checkout'} and in the activity log.
        </p>
        {multi && (
          <div style={{ overflowY:'auto', minHeight:0, background:'var(--mist)', borderRadius:10, padding:'10px 14px', marginBottom:14 }}>
            {list.map(c => (
              <div key={c.id} style={{ fontSize:12, color:'var(--muted)', paddingLeft:4 }}>
                · {c.itemName}{holders.length > 1 ? <span style={{ opacity:.75 }}> - {c.requestedBy}</span> : null}
              </div>
            ))}
          </div>
        )}
        <label style={FL}>REASON <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
        <textarea rows={3} autoFocus className="form-input" style={{ width:'100%', resize:'vertical', fontSize:13 }}
          placeholder="e.g. Collected from site office - employee on leave"
          value={reason} onChange={e => setReason(e.target.value)} />
        {error && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', marginTop:8 }}>{error}</p>}
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:18 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button disabled={!reason.trim() || busy} onClick={submit}
            style={{ background:'hsl(var(--color-orange))', color:'#fff', border:'none', borderRadius:8, padding:'8px 18px', fontWeight:700, fontSize:13.5, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:7, fontFamily:'Inter,sans-serif', opacity: (!reason.trim() || busy) ? 0.6 : 1 }}>
            {busy ? <Spinner size={14} /> : <RotateCcw size={14} />} Check back in
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
