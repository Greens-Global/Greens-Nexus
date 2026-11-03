// Item Management - Confirm a batch delete.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState } from 'react';
import { AlertCircle, Trash2 } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { useEscapeKey } from '../ui/hooks';
import { FL } from '../ui/styles';

// ── Batch Delete Confirm Modal ────────────────────────────────────────────────
export function BatchDeleteConfirmModal({ selectedItems, blockedItems, onClose, onConfirm, deleting }) {
  useEscapeKey(onClose);
  const [confirmText, setConfirmText] = useState('');
  const deletable = selectedItems.filter(i => !blockedItems.find(b => b.id === i.id));
  // Ankush: "someone can just select all and delete all" - a typed confirmation is
  // the guard. The bigger the batch, the more this matters.
  const armed = confirmText.trim().toUpperCase() === 'DELETE';
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:4200, display:'flex', alignItems:'center', justifyContent:'center', padding:24 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:16, padding:'28px 28px 20px', width:'100%', maxWidth:460, boxShadow:'var(--shadow-lg)', maxHeight:'min(85dvh, 640px)', display:'flex', flexDirection:'column' }}>
        <h3 style={{ margin:'0 0 6px', fontSize:16, fontWeight:700 }}>Delete {selectedItems.length} item{selectedItems.length !== 1 ? 's' : ''}?</h3>
        <p style={{ margin:'0 0 16px', fontSize:13, color:'var(--muted)' }}>Deleted items move to the recycle bin and can be restored later.</p>
        {/* Item lists scroll; title + actions stay pinned so the modal never
            outgrows short screens (30 items overflowed an iPhone SE) */}
        <div style={{ overflowY:'auto', minHeight:0 }}>
        {blockedItems.length > 0 && (
          <div style={{ background:'hsla(var(--color-orange),0.1)', border:'1px solid hsla(var(--color-orange),0.3)', borderRadius:10, padding:'10px 14px', marginBottom:14 }}>
            <div style={{ fontWeight:700, fontSize:12.5, color:'hsl(var(--color-orange))', marginBottom:6 }}>
              <AlertCircle size={13} style={{ verticalAlign:'middle', marginRight:4 }} />
              {blockedItems.length} item{blockedItems.length !== 1 ? 's' : ''} cannot be deleted (active checkout)
            </div>
            {blockedItems.map(i => <div key={i.id} style={{ fontSize:12, color:'var(--muted)', paddingLeft:4 }}>· {i.name}</div>)}
          </div>
        )}
        {deletable.length > 0 && (
          <div style={{ background:'var(--mist)', borderRadius:10, padding:'10px 14px', marginBottom:18 }}>
            <div style={{ fontWeight:700, fontSize:12.5, marginBottom:6 }}>Will be deleted:</div>
            {deletable.map(i => <div key={i.id} style={{ fontSize:12, color:'var(--muted)', paddingLeft:4 }}>· {i.name}</div>)}
          </div>
        )}
        </div>
        {deletable.length > 0 && (
          <div style={{ flexShrink:0, paddingTop:4 }}>
            <label style={{ ...FL, marginBottom:6 }}>TYPE <strong style={{ color:'var(--ink)' }}>DELETE</strong> TO CONFIRM</label>
            <input className="form-input" style={{ width:'100%' }} autoFocus value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && armed && !deleting && onConfirm()}
              placeholder="DELETE" />
          </div>
        )}
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', paddingTop:14, flexShrink:0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={deleting}>Cancel</button>
          {deletable.length > 0 && (
            <button onClick={onConfirm} disabled={deleting || !armed}
              style={{ display:'inline-flex', alignItems:'center', gap:6, background:'hsl(var(--color-red))', color:'#fff', border:'none', borderRadius:9, padding:'9px 18px', fontWeight:700, fontSize:13, cursor: (deleting || !armed) ? 'default' : 'pointer', fontFamily:'Inter,sans-serif', opacity: (deleting || !armed) ? 0.5 : 1 }}>
              {deleting ? <Spinner size={14} /> : <Trash2 size={14} />}
              Delete {deletable.length} item{deletable.length !== 1 ? 's' : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
