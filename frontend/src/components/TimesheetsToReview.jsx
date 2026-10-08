import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, FileSignature, Undo2, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';

// Timesheets to Review (Sep 29): the list at the top of People > Time of every
// timesheet submitted to YOU that you have not decided yet - who, which
// period, the hours as submitted, when, and their note - with Agree and Send
// Back right on the row and Review to open the full timecard. Nothing renders
// when nothing is waiting. Agree is disabled, with the reason, while it would
// be refused (the period is still running, or a missing punch is open) - the
// same check the server makes (timesheet_review.agree_blocker).
//
// Refreshes on `nexus:timesheet-review-changed`, which the review panel on the
// timecard fires after any decision, so the two never disagree.

const hm = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;

// `onCount` (optional) hears how many are waiting - null when the list could
// not be loaded - so the People > Time "To Review" tile shows the same number.
export default function TimesheetsToReview({ onOpen, toastOk, toastErr, onCount }) {
  const [rows, setRows] = useState([]);
  const [busyId, setBusyId] = useState('');
  const [backFor, setBackFor] = useState('');   // review id whose Send Back note is open
  const [note, setNote] = useState('');

  const load = useCallback(() => {
    api.timesheetReviewWaiting().then(r => {
      const list = Array.isArray(r?.reviews) ? r.reviews : [];
      setRows(list);
      onCount?.(list.length);
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

  if (!rows.length) return null;
  return (
    <div style={{ marginBottom: 16, border: '1px solid var(--wk-line2)', background: 'var(--card)', borderRadius: 12, padding: '12px 16px', boxShadow: 'var(--wk-shadow)' }}>
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
  );
}
