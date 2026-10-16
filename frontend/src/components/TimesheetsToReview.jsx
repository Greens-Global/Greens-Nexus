import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ClipboardCheck, FileSignature, Undo2, ChevronRight, PenLine } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { SignModal } from './ESign';

// Timesheets to Review (Sep 29): the list at the top of People > Time of every
// timesheet submitted to YOU that you have not decided yet - who, which
// period, the hours as submitted, when, and their note - with Agree and Send
// Back right on the row and Review to open the full timecard. Nothing renders
// when nothing is waiting. Agree is disabled, with the reason, while it would
// be refused (the period is still running, or a missing punch is open) - the
// same check the server makes (timesheet_review.agree_blocker).
//
// Timesheets to Sign (Oct 16): the agreed timesheets waiting on YOUR
// signature (the manager's or HR's turn in Nexus Sign), signed right here -
// the same in-place signing screen the employee gets on their own timecard.
// Managers reach People and Documents only through an Access Group grant, so
// without one the signature bell and the email link both landed on Access
// Restricted and the manager could never sign.
//
// Refreshes on `nexus:timesheet-review-changed`, which the review panel on the
// timecard fires after any decision, so the two never disagree.

const hm = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;
const ROLE_WORD = { manager: 'as the manager', hr: 'for HR', employee: 'as the employee' };

// `onCount` (optional) hears how many are waiting (to review plus to sign) -
// null when the list could not be loaded - so the People > Time "To Review"
// tile and the Workday Time Sheet tab show the same number.
export default function TimesheetsToReview({ onOpen, toastOk, toastErr, onCount }) {
  const [rows, setRows] = useState([]);
  const [toSign, setToSign] = useState([]);
  const [busyId, setBusyId] = useState('');
  const [backFor, setBackFor] = useState('');   // review id whose Send Back note is open
  const [note, setNote] = useState('');
  const [signing, setSigning] = useState(null);  // party id being signed in place

  const load = useCallback(() => {
    api.timesheetReviewWaiting().then(r => {
      const list = Array.isArray(r?.reviews) ? r.reviews : [];
      const sign = Array.isArray(r?.toSign) ? r.toSign : [];
      setRows(list);
      setToSign(sign);
      onCount?.(list.length + sign.length);
    }).catch(() => onCount?.(null));
  }, [onCount]);
  useEffect(() => {
    load();
    window.addEventListener('nexus:timesheet-review-changed', load);
    return () => window.removeEventListener('nexus:timesheet-review-changed', load);
  }, [load]);

  async function run(r, call, done) {
    setBusyId(r.id);
    try {
      await call();
      toastOk?.(done);
      setBackFor(''); setNote('');
      window.dispatchEvent(new CustomEvent('nexus:timesheet-review-changed'));
    } catch (e) { toastErr?.(e?.message || 'Could not save that.'); }
    setBusyId('');
  }

  const card = { marginBottom: 16, border: '1px solid var(--wk-line2)', background: 'var(--card)', borderRadius: 12, padding: '12px 16px', boxShadow: 'var(--wk-shadow)' };
  const signPortal = signing && createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'var(--bg, #f4f5f7)', display: 'flex', flexDirection: 'column' }}>
      <SignModal partyId={signing} onClose={() => setSigning(null)}
        onDone={() => { setSigning(null); window.dispatchEvent(new CustomEvent('nexus:timesheet-review-changed')); }}
        toastOk={toastOk || (() => {})} toastErr={toastErr || (() => {})} />
    </div>, document.body);

  if (!rows.length && !toSign.length) return null;
  return (
    <>
      {rows.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <ClipboardCheck size={15} style={{ color: 'var(--wk-brand)' }} />
            <span style={{ fontWeight: 800, fontSize: 13.5 }}>Timesheets to Review</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{rows.length} waiting on you</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rows.map(r => (
              <div key={r.id} data-review={r.employeeEmail} style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                      {r.name}{r.resubmitted && <span style={{ fontSize: 11, fontWeight: 700, color: '#b45309', marginLeft: 6 }}>Resubmitted</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {formatDate(r.periodStart)} - {formatDate(r.periodEnd)} · {hm(r.workedMin)} · submitted {formatDate(r.submittedAt)}
                    </div>
                    {r.note && <div style={{ fontSize: 12, marginTop: 2 }}>"{r.note}"</div>}
                    {r.agreeBlocker && <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 2 }}>{r.agreeBlocker}</div>}
                  </div>
                  {/* Review opens the full timecard in People > Time - offered only
                      where the caller can open it (no onOpen = no button, Oct 1). */}
                  {onOpen && (
                    <button type="button" className="secondary-btn" onClick={() => onOpen(r)}
                      style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 4 }}>Review <ChevronRight size={13} /></button>
                  )}
                  <button type="button" className="secondary-btn" disabled={busyId === r.id}
                    onClick={() => { setBackFor(backFor === r.id ? '' : r.id); setNote(''); }}
                    style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Undo2 size={13} /> Send Back</button>
                  <button type="button" className="primary-btn" disabled={busyId === r.id || !!r.agreeBlocker}
                    title={r.agreeBlocker || 'Agree to these hours and send them for signature'}
                    onClick={() => run(r, () => api.timesheetReviewAgree(r.id, ''), `Agreed - sent to ${r.name} to sign.`)}
                    style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5, opacity: r.agreeBlocker ? 0.55 : 1 }}>
                    <FileSignature size={13} /> Agree
                  </button>
                </div>
                {backFor === r.id && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <input className="form-input" value={note} onChange={e => setNote(e.target.value)} maxLength={1000} autoFocus
                      placeholder="What needs changing?" aria-label={`What needs changing for ${r.name}`} style={{ flex: 1, fontSize: 12.5 }} />
                    <button type="button" className="primary-btn" disabled={!note.trim() || busyId === r.id}
                      onClick={() => run(r, () => api.timesheetReviewSendBack(r.id, note.trim()), `Sent back to ${r.name}.`)}
                      style={{ fontSize: 12.5 }}>Send</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {toSign.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <PenLine size={15} style={{ color: 'var(--wk-brand)' }} />
            <span style={{ fontWeight: 800, fontSize: 13.5 }}>Timesheets to Sign</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{toSign.length} waiting on your signature</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {toSign.map(s => (
              <div key={s.partyId} data-sign={s.employeeEmail} style={{ borderTop: '1px solid var(--line)', padding: '10px 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{s.role === 'employee' ? 'Your timesheet' : s.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {formatDate(s.periodStart)} - {formatDate(s.periodEnd)}
                    {s.agreedBy ? ` · agreed by ${s.agreedBy}${s.agreedAt ? ` on ${formatDate(s.agreedAt)}` : ''}` : ''}
                    {` · you sign ${ROLE_WORD[s.role] || ''}`.replace(/ $/, '')}
                  </div>
                </div>
                <button type="button" className="primary-btn" onClick={() => setSigning(s.partyId)}
                  style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <FileSignature size={13} /> {s.role === 'employee' ? 'Sign & Submit' : 'Review & Sign'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {signPortal}
    </>
  );
}
