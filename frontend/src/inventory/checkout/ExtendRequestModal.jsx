// Item Management - Ask for more days on a checkout.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState } from 'react';
import { Clock } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import { FL } from '../ui/styles';

// ── Extend Request Modal ───────────────────────────────────────────────────────
export function ExtendRequestModal({ checkout, onClose, onSubmit }) {
  const [days,   setDays]   = useState(1);
  const [reason, setReason] = useState('');
  const [busy,   setBusy]   = useState(false);
  const [error,  setError]  = useState('');

  function submit() {
    if (busy || !reason.trim()) return;
    setBusy(true); setError('');
    Promise.resolve(onSubmit({ days, reason: reason.trim() }))
      .then(onClose)
      .catch(err => { setError(err?.message || 'Could not submit extension request.'); setBusy(false); });
  }

  const dirty = days !== 1 || reason.trim() !== '';
  const guard = useUnsavedGuard(dirty, onClose, reason.trim() ? submit : undefined);

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:400, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Request an Extension</h3>
        <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:20 }}>
          Ask for more time with <strong>{checkout.itemName}</strong>. A manager will review your request.
        </p>

        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div>
            <label style={FL}>HOW MANY MORE DAYS? <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <button onClick={() => setDays(d => Math.max(1, d - 1))}
                style={{ width:32, height:32, borderRadius:8, border:'1px solid var(--line)', background:'var(--mist)', cursor:'pointer', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Inter,sans-serif' }}>−</button>
              <input type="number" min={1} max={90} value={days}
                onChange={e => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
                style={{ width:56, textAlign:'center', padding:'7px 4px', border:'1px solid var(--line)', borderRadius:8, fontSize:15, fontWeight:700, fontFamily:'Inter,sans-serif', background:'var(--card)' }} />
              <button onClick={() => setDays(d => Math.min(90, d + 1))}
                style={{ width:32, height:32, borderRadius:8, border:'1px solid var(--line)', background:'var(--mist)', cursor:'pointer', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Inter,sans-serif' }}>+</button>
              <span style={{ fontSize:13, fontWeight:700, color:'hsl(var(--color-blue))' }}>{days} extra day{days !== 1 ? 's' : ''}</span>
            </div>
          </div>
          <div>
            <label style={FL}>WHY DO YOU NEED MORE TIME? <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
            <textarea rows={2} className="form-input" style={{ width:'100%', resize:'vertical', fontSize:13 }}
              placeholder="e.g. Site work running longer than planned"
              value={reason} onChange={e => setReason(e.target.value)} />
          </div>
        </div>

        {error && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', marginTop:12 }}>{error}</p>}

        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" disabled={busy || !reason.trim()}
            style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:150, justifyContent:'center', opacity: (!reason.trim() && !busy) ? 0.5 : 1 }} onClick={submit}>
            {busy ? <><Spinner size={14} /> Sending…</> : <><Clock size={14} /> Request extension</>}
          </button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose}
          onSave={reason.trim() ? guard.saveAndClose : undefined} saving={guard.saving || busy} />
      )}
    </div>
  );
}
