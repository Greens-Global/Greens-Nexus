// Item Management - Reject a checkout request with a reason.
// A question, so the centered card (Items redesign, Neil 11/02/2026).
import { useState } from 'react';
import { XCircle } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { ItemQuestion, LABEL, ERROR } from '../ui/Sheet';

export function RejectCheckoutModal({ checkout, checkouts: checkoutBatch, onClose, onConfirm }) {
  const items   = checkoutBatch || (checkout ? [checkout] : []);
  const first   = items[0] || {};
  const isMulti = items.length > 1;

  const [reason, setReason] = useState('');
  const [busy,   setBusy]   = useState(false);
  const [error,  setError]  = useState('');

  function submit() {
    if (!reason.trim() || busy) return;
    setBusy(true); setError('');
    Promise.resolve(onConfirm(reason.trim()))
      .then(onClose)
      .catch(err => { setError(err?.message || 'Could not reject.'); setBusy(false); });
  }

  return (
    <ItemQuestion title={isMulti ? `Reject ${items.length} Items?` : `Reject ${first.itemName || 'This Request'}?`} onClose={onClose}
      isDirty={reason.trim() !== ''}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Keep It</button>
        <button className="primary-btn" disabled={!reason.trim() || busy} onClick={submit}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'var(--wk-red)' }}>
          {busy ? <Spinner size={14} /> : <XCircle size={14} />} Reject
        </button>
      </>}>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
        {isMulti ? <>{items.length} items for <strong style={{ color: 'var(--ink)' }}>{first.requestedBy}</strong>. One reason goes to all of them.</>
          : <>For <strong style={{ color: 'var(--ink)' }}>{first.requestedBy}</strong>. They will see your reason.</>}
      </p>
      <label style={LABEL} htmlFor="reject-reason">Reason</label>
      <textarea id="reject-reason" rows={3} autoFocus className="form-input" style={{ width: '100%', resize: 'vertical', fontSize: 13 }}
        placeholder="e.g. The van is booked for the Austin job that week" value={reason} onChange={e => setReason(e.target.value)} />
      {error && <p style={ERROR}>{error}</p>}
    </ItemQuestion>
  );
}
