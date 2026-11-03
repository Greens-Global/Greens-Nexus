// Item Management - Ask for more time: pick the new return date (Neil, 11/02/2026).
// A sheet from the right. The server works out the extra days from the
// current due date and keeps the whole loan inside its 90-day ceiling.
import { useState } from 'react';
import { Clock } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { DateBox } from '../ui/DateBox';
import { formatDate } from '../../lib/datetime';
import { addDaysISO, daysBetween, dueDayOf } from '../model/due';
import { ItemSheet, LABEL, HINT, ERROR } from '../ui/Sheet';

export const LOAN_CEILING_DAYS = 90;

/** The latest new return date an extension may ask for (the loan's start +
 *  the 90-day ceiling), as YYYY-MM-DD. */
export function extensionMax(co) {
  const start = co?.handedOverAt || co?.allocatedAt;
  if (!start) return '';
  const d = new Date(start);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return addDaysISO(iso, LOAN_CEILING_DAYS);
}

export function ExtendRequestModal({ checkout, onClose, onSubmit, zIndex }) {
  const current = dueDayOf(checkout);
  const min = current ? addDaysISO(current, 1) : '';
  const max = extensionMax(checkout);
  const [date,   setDate]   = useState('');
  const [reason, setReason] = useState('');
  const [busy,   setBusy]   = useState(false);
  const [error,  setError]  = useState('');

  const extra = date && current ? daysBetween(current, date) : 0;
  const ready = !!date && extra >= 1 && (!max || date <= max) && !!reason.trim();

  function submit() {
    if (!ready || busy) return;
    setBusy(true); setError('');
    Promise.resolve(onSubmit({ newDueDate: date, days: extra, reason: reason.trim() }))
      .then(onClose)
      .catch(err => { setError(err?.message || 'Could not send the extension request.'); setBusy(false); });
  }

  return (
    <ItemSheet title="Request More Time" onClose={onClose} zIndex={zIndex}
      isDirty={!!date || reason.trim() !== ''} onSave={ready ? submit : undefined}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary-btn" disabled={!ready || busy} onClick={submit}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {busy ? <><Spinner size={14} /> Sending…</> : <><Clock size={14} /> Send Request</>}
        </button>
      </>}>
      <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '0 0 18px', lineHeight: 1.5 }}>
        <strong style={{ color: 'var(--ink)' }}>{checkout.itemName}</strong> is due {current ? formatDate(current) : 'soon'}. A manager reviews the new date.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <span style={LABEL}>New Return Date</span>
          <DateBox value={date} onChange={v => setDate(v && min && v < min ? min : v)} min={min} max={max} noPast
            ariaLabel="New Return Date" style={{ width: '100%' }} />
          <p style={HINT}>
            {extra >= 1 ? `${extra} more day${extra === 1 ? '' : 's'}.` : `After ${current ? formatDate(current) : 'the current due date'}`}
            {max ? ` The latest is ${formatDate(max)}.` : ''}
          </p>
        </div>
        <div>
          <label style={LABEL} htmlFor="extend-reason">Why Do You Need More Time?</label>
          <textarea id="extend-reason" rows={3} className="form-input" style={{ width: '100%', resize: 'vertical', fontSize: 13.5 }}
            placeholder="e.g. The site work is running a week longer than planned"
            value={reason} onChange={e => setReason(e.target.value)} />
        </div>
        {date && extra < 1 && <p style={ERROR}>Pick a date after {formatDate(current)}.</p>}
        {error && <p style={ERROR}>{error}</p>}
      </div>
    </ItemSheet>
  );
}
