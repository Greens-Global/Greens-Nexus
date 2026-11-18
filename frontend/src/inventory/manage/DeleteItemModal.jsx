// Item Management - Delete one item (to the Recycle Bin).
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { useEscapeKey } from '../ui/hooks';
import { FL } from '../ui/styles';

// ── Delete Confirm Modal ───────────────────────────────────────────────────────
// Ankush: deleting must require typing "DELETE" so a stray click can't drop a row.
// Deletes are now soft - the item moves to the recycle bin and can be restored.
export function DeleteItemModal({ item, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const armed = confirmText.trim().toUpperCase() === 'DELETE';
  useEscapeKey(onClose);
  function confirm() {
    if (!armed) return;
    setBusy(true);
    Promise.resolve(onConfirm()).catch(() => {}).finally(() => setBusy(false));
  }
  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:4200, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:400, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize:15, fontWeight:700, marginBottom:8 }}>Delete Item?</h3>
        <p style={{ fontSize:13, color:'var(--muted)', marginBottom:16 }}>
          Remove <strong>{item.name}</strong>? It moves to the recycle bin and can be restored later. Deleting fails if the item has an active checkout.
        </p>
        <label style={{ ...FL, marginBottom:6 }}>TYPE <strong style={{ color:'var(--ink)' }}>DELETE</strong> TO CONFIRM</label>
        <input className="form-input" style={{ width:'100%' }} autoFocus value={confirmText}
          onChange={e => setConfirmText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && confirm()}
          placeholder="DELETE" />
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button onClick={confirm} disabled={busy || !armed}
            style={{ display:'inline-flex', alignItems:'center', gap:7, padding:'8px 18px', borderRadius:8, border:'none', background:'hsl(var(--color-red))', color:'#fff', fontWeight:700, fontSize:13, cursor: (busy || !armed) ? 'default' : 'pointer', opacity: (busy || !armed) ? 0.5 : 1 }}>
            {busy ? <><Spinner size={14} /> Deleting…</> : <><Trash2 size={14} /> Delete</>}
          </button>
        </div>
      </div>
    </div>
  );
}
