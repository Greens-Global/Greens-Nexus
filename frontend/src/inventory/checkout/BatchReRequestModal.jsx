// Item Management - The batch re-request form.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useEffect } from 'react';
import { RotateCcw } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import { TYPE_DEPT_FALLBACK, suggestAllocator } from '../model/allocator';
import { FL } from '../ui/styles';

// ── Batch Re-Request Modal ────────────────────────────────────────────────────
// Past Checkouts → tick rows → request them all again as ONE fresh order
// (Neil: construction crews check out the same items over and over).
export function BatchReRequestModal({ checkouts, onClose, onSubmit }) {
  const [reason,        setReason]        = useState('');
  const [approvers,     setApprovers]     = useState([]);
  const [approverEmail, setApproverEmail] = useState('');
  const [busy,          setBusy]          = useState(false);
  const [error,         setError]         = useState('');
  // Days are pre-filled from each item's last checkout but stay editable -
  // users can change the duration before re-submitting (Pranshu, Jun 16).
  const [days,          setDays]          = useState(() =>
    Object.fromEntries(checkouts.map(c => [c.id, c.days || 1])));
  const setItemDays = (id, v) => {
    const n = parseInt(v, 10);
    // Backend rejects >90 days - clamp here too (cart/extension already cap at 90).
    setDays(d => ({ ...d, [id]: Number.isNaN(n) ? '' : Math.max(1, Math.min(90, n)) }));
  };

  // Same defaulting as the cart: last-used manager, else the usual manager
  // for these items' departments
  useEffect(() => {
    api.getItemApprovers().then(rows => {
      setApprovers(rows);
      setApproverEmail(prev => {
        if (prev) return prev;
        const remembered = localStorage.getItem('nexus-approver-email');
        if (remembered && rows.some(a => a.email === remembered)) return remembered;
        const pseudoItems = checkouts.map(c => ({ department: c.department || TYPE_DEPT_FALLBACK[c.itemType] || '' }));
        const pick = suggestAllocator(pseudoItems, rows);
        return pick ? pick.email : '';
      });
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const approver  = approvers.find(a => a.email === approverEmail) || null;
  const canSubmit = reason.trim() && approver && !busy;

  function submit() {
    if (!canSubmit) return;
    setBusy(true); setError('');
    localStorage.setItem('nexus-approver-email', approver.email);
    const daysMap = Object.fromEntries(Object.entries(days).map(([id, v]) => [id, Math.max(1, parseInt(v, 10) || 1)]));
    Promise.resolve(onSubmit({ reason: reason.trim(), approverEmail: approver.email, approverName: approver.name, days: daysMap }))
      .catch(err => { setError(err?.message || 'Could not submit the request.'); setBusy(false); });
  }

  // approverEmail is excluded - it's auto-filled from the last-used manager, not
  // something the user typed, so its presence alone shouldn't count as dirty.
  const initialDays = Object.fromEntries(checkouts.map(c => [c.id, c.days || 1]));
  const dirty = reason.trim() !== '' || JSON.stringify(days) !== JSON.stringify(initialDays);
  const guard = useUnsavedGuard(dirty, onClose, canSubmit ? submit : undefined);

  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:440, boxShadow:'0 20px 60px rgba(0,0,0,0.3)', maxHeight:'85vh', overflowY:'auto' }}>
        <h3 style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Request Again</h3>
        <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:16 }}>
          {checkouts.length} item{checkouts.length !== 1 ? 's' : ''} from your past checkouts will go in as one new request. Days are pre-filled from last time - adjust any of them below before submitting.
        </p>

        <div style={{ border:'1px solid var(--line)', borderRadius:10, marginBottom:16, overflow:'hidden' }}>
          {checkouts.map((c, idx) => (
            <div key={c.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', borderTop: idx > 0 ? '1px solid var(--line)' : 'none' }}>
              <span style={{ flex:1, minWidth:0, fontSize:13, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.itemName}</span>
              <div style={{ display:'inline-flex', alignItems:'center', gap:6, flexShrink:0 }}>
                <input type="number" min={1} max={90} value={days[c.id] ?? ''}
                  onChange={e => setItemDays(c.id, e.target.value)}
                  onBlur={e => { if (!e.target.value) setItemDays(c.id, 1); }}
                  className="form-input"
                  style={{ width:58, padding:'4px 8px', fontSize:12.5, textAlign:'center' }} />
                <span style={{ fontSize:11.5, color:'var(--muted)' }}>day{(days[c.id] || 1) !== 1 ? 's' : ''}</span>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginBottom:16 }}>
          <label style={FL}>WHO SHOULD APPROVE THIS? <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
          <select className="form-input" style={{ width:'100%' }} value={approverEmail} onChange={e => setApproverEmail(e.target.value)}>
            <option value="">- select a manager -</option>
            {approvers.map(a => <option key={a.email} value={a.email}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label style={FL}>REASON FOR CHECKOUT <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
          <textarea rows={2} className="form-input" style={{ width:'100%', resize:'vertical', fontSize:13 }}
            placeholder="Briefly explain why you need these items again…"
            value={reason} onChange={e => setReason(e.target.value)} />
        </div>
        {error && <div style={{ marginTop:10, fontSize:12.5, color:'hsl(var(--color-red))' }}>{error}</div>}

        <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:20 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" disabled={!canSubmit} onClick={submit}
            style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
            {busy ? <Spinner size={13} /> : <RotateCcw size={13} />}
            Request {checkouts.length} item{checkouts.length !== 1 ? 's' : ''} again
          </button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose}
          onSave={canSubmit ? guard.saveAndClose : undefined} saving={guard.saving || busy} />
      )}
    </div>
  );
}
