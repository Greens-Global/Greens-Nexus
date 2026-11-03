// Item Management - Approve a checkout request and pick who hands it over.
// A sheet from the right (Items redesign, Neil 11/02/2026).
import { useState, useEffect, useCallback } from 'react';
import { CheckCircle } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import { suggestAllocator } from '../model/allocator';
import { fmtDueDate } from '../model/due';
import { ItemSheet, LABEL, HINT, ERROR } from '../ui/Sheet';

export function ApproveCheckoutModal({ checkout, checkouts: checkoutBatch, onClose, onConfirm, currentUserEmail, currentUserName, zIndex }) {
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
    (first.itemId ? api.getItemAllocatorsFor(first.itemId) : api.getItemAllocators()).then(rows => {
      setAllocators(rows);
      // Pre-select the department's usual allocator (it can still be changed)
      const pick = suggestAllocator(items, rows);
      if (pick) { setSuggested(pick); setPickedEmail(prev => prev || pick.email); }
    }).catch(() => setAllocErr(true));
  }, [items, first.itemId]);
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

  // The suggested allocator is not a change of its own - only a deliberate pick.
  const dirty = !!pickedEmail && pickedEmail !== (suggested?.email || '');

  return (
    <ItemSheet title={isMulti ? `Approve ${items.length} Items` : `Approve ${first.itemName || 'Request'}`} onClose={onClose}
      isDirty={dirty} onSave={dirty ? submit : undefined} zIndex={zIndex}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary-btn" disabled={!pickedEmail || busy} onClick={submit}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {busy ? <><Spinner size={14} /> Approving…</> : <><CheckCircle size={14} /> Approve</>}
        </button>
      </>}>
      <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.5 }}>
        For <strong style={{ color: 'var(--ink)' }}>{first.requestedBy}</strong>.
        {first.reason ? <> Reason: <em>"{first.reason}"</em></> : null}
      </p>
      <div style={{ border: '1px solid var(--wk-line2, var(--line))', borderRadius: 12, marginBottom: 20 }}>
        {items.map((co, i) => (
          <div key={co.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 14px', borderTop: i ? '1px solid var(--wk-line2, var(--line))' : 'none', fontSize: 13.5 }}>
            <span style={{ fontWeight: 600 }}>{co.itemName}</span>
            <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmtDueDate(co) ? `Return by ${fmtDueDate(co)}` : `${co.days} day${co.days === 1 ? '' : 's'}`}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <label style={{ ...LABEL, marginBottom: 0 }} htmlFor="approve-allocator">Who Hands It Over</label>
        {currentUserEmail && (
          <button type="button" onClick={() => setPickedEmail(currentUserEmail)}
            style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--wk-brand)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}>
            Assign to Me
          </button>
        )}
      </div>
      {allocErr ? (
        <div style={{ fontSize: 13, color: 'var(--bad-fg)', display: 'flex', alignItems: 'center', gap: 8 }}>
          Could not load the people who hand items over.
          <button className="secondary-btn" style={{ fontSize: 12, padding: '4px 12px' }} onClick={loadAllocators}>Retry</button>
        </div>
      ) : (
        <select id="approve-allocator" className="form-input" style={{ width: '100%' }} value={pickedEmail} onChange={e => setPickedEmail(e.target.value)}>
          <option value="">Choose a person</option>
          {allocators.map(a => <option key={a.email} value={a.email}>{a.name}</option>)}
          {currentUserEmail && !allocators.some(a => a.email === currentUserEmail) && <option value={currentUserEmail}>{currentUserName || 'Me'}</option>}
        </select>
      )}
      {suggested && pickedEmail === suggested.email && (
        <p style={HINT}>Suggested - {suggested.name} usually handles {suggested.majorityDept} items.</p>
      )}
      {error && <p style={ERROR}>{error}</p>}
    </ItemSheet>
  );
}
