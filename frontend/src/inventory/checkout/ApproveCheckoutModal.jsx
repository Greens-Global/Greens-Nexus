// Item Management - Approve a checkout request and pick the allocator.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useEffect, useCallback } from 'react';
import { CheckCircle } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import { suggestAllocator } from '../model/allocator';
import { FL } from '../ui/styles';

export function ApproveCheckoutModal({ checkout, checkouts: checkoutBatch, onClose, onConfirm, currentUserEmail, currentUserName }) {
  const items  = checkoutBatch || (checkout ? [checkout] : []);
  const first  = items[0] || {};
  const isMulti = items.length > 1;

  const [allocators,  setAllocators]  = useState([]);
  const [pickedEmail, setPickedEmail] = useState('');
  const [suggested,   setSuggested]   = useState(null);
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState('');
  const [allocErr,    setAllocErr]    = useState(false);

  const loadAllocators = useCallback(() => {
    setAllocErr(false);
    api.getItemAllocators().then(rows => {
      setAllocators(rows);
      // Pre-select the department's usual allocator (user can still change it)
      const pick = suggestAllocator(items, rows);
      if (pick) { setSuggested(pick); setPickedEmail(prev => prev || pick.email); }
    // P4: surface a retry instead of a dead Approve button with no message.
    }).catch(() => setAllocErr(true));
  }, [items]);
  useEffect(() => { loadAllocators(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function submit() {
    const chosen = allocators.find(a => a.email === pickedEmail)
      || (pickedEmail === currentUserEmail ? { email: currentUserEmail, name: currentUserName } : null);
    if (!chosen || busy) return;
    setBusy(true); setError('');
    Promise.resolve(onConfirm(chosen.email, chosen.name))
      .then(onClose)
      .catch(err => { setError(err?.message || 'Could not approve.'); setBusy(false); });
  }

  // Auto-suggested allocator doesn't count as dirty on its own - only a
  // deliberate change away from it (manual pick or "Assign to Me").
  const dirty = !!pickedEmail && pickedEmail !== (suggested?.email || '');
  const guard = useUnsavedGuard(dirty, onClose, dirty ? submit : undefined);

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:420, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Approve checkout{isMulti ? 's' : ''}</h3>
        {isMulti ? (
          <>
            <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:8 }}>
              Approving <strong>{items.length} items</strong> for <strong>{first.requestedBy}</strong>. One allocator will be assigned to all.
            </p>
            <div style={{ background:'var(--mist)', borderRadius:8, padding:'8px 12px', marginBottom:16, maxHeight:120, overflowY:'auto' }}>
              {items.map(co => (
                <div key={co.id} style={{ fontSize:12, color:'var(--fg)', padding:'2px 0', display:'flex', gap:8, alignItems:'center' }}>
                  <span style={{ opacity:.5 }}>·</span> {co.itemName} <span style={{ color:'var(--muted)' }}>({co.days}d)</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:20 }}>
            Approving <strong>{first.itemName}</strong> for <strong>{first.requestedBy}</strong>. Assign who will physically hand over the item.
          </p>
        )}
        <div>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
            <label style={{ ...FL, marginBottom:0 }}>ASSIGN ALLOCATOR <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
            {currentUserEmail && (
              <button onClick={() => setPickedEmail(currentUserEmail)}
                style={{ fontSize:11.5, color:'hsl(var(--color-blue))', background:'none', border:'none', cursor:'pointer', fontFamily:'Inter,sans-serif', padding:'2px 6px' }}>
                Assign to Me
              </button>
            )}
          </div>
          {allocErr ? (
            <div style={{ fontSize:12.5, color:'hsl(var(--color-red))', display:'flex', alignItems:'center', gap:8 }}>
              Couldn't load allocators.
              <button className="secondary-btn" style={{ fontSize:12, padding:'4px 12px' }} onClick={loadAllocators}>Retry</button>
            </div>
          ) : (
            <select className="form-input" style={{ width:'100%' }} value={pickedEmail} onChange={e => setPickedEmail(e.target.value)}>
              <option value="">- select allocator -</option>
              {allocators.map(a => <option key={a.email} value={a.email}>{a.name} ({a.role})</option>)}
            </select>
          )}
          {suggested && pickedEmail === suggested.email && (
            <p style={{ display:'flex', alignItems:'center', gap:5, fontSize:11.5, color:'hsl(var(--color-blue))', margin:'7px 0 0' }}>
              <CheckCircle size={12} style={{ flexShrink:0 }} />
              Suggested - {suggested.name} usually handles {suggested.majorityDept.charAt(0).toUpperCase() + suggested.majorityDept.slice(1)} items
            </p>
          )}
        </div>
        {error && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', marginTop:10 }}>{error}</p>}
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" disabled={!pickedEmail || busy}
            style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:120, justifyContent:'center' }} onClick={submit}>
            {busy ? <><Spinner size={14} /> Approving…</> : <><CheckCircle size={14} /> Approve</>}
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
