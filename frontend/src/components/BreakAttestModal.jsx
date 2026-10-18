// CA meal and rest breaks at signing (Neil, Oct 17 2026 - backend/ca_breaks.py,
// timesheet_review.attest_breaks / claim_breaks). Only staff on the California
// overtime rule see this: their review carries `breakAttestation`. ONE
// question before the signing screen opens - nothing at clock-in, on breaks or
// at clock-out, and no daily attestation.
//   Yes - recorded, then the signing screen opens exactly as before.
//   No  - pick the day(s) and Meal / Rest (the days the meal check flagged are
//         pre-filled), add a note if you like. This does NOT sign: the time
//         sheet goes back to the manager, who adds the premium pay.
import { useState } from 'react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { Modal } from '../tasks/components';

const dow = (ds) => `${new Date(`${ds}T00:00`).toLocaleDateString('en-US', { weekday: 'short' })} ${formatDate(ds)}`;

export default function BreakAttestModal({ reviewId, attestation, onClose, onYes, onSentBack, toastErr }) {
  const flagged = new Map((attestation?.flaggedDays || []).map(d => [d.date, d]));
  const days = attestation?.workedDays?.length ? attestation.workedDays : [...flagged.keys()];
  const [step, setStep] = useState('ask');          // ask | claim
  const [picks, setPicks] = useState(() => {
    const p = {};
    flagged.forEach((_d, ds) => { p[`${ds}|meal`] = true; });
    return p;
  });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const toggle = (k) => setPicks(p => ({ ...p, [k]: !p[k] }));
  const claims = Object.entries(picks).filter(([, v]) => v).map(([k]) => {
    const [date, kind] = k.split('|');
    return { date, kind };
  });

  async function yes() {
    setBusy(true);
    try { await api.timesheetBreakAttest(reviewId); onYes?.(); }
    catch (e) { toastErr?.(e?.message || 'Could not record your answer.'); setBusy(false); }
  }
  async function sendBack() {
    setBusy(true);
    try { await api.timesheetBreakClaim(reviewId, { claims, note: note.trim() }); onSentBack?.(); }
    catch (e) { toastErr?.(e?.message || 'Could not send it back.'); setBusy(false); }
  }

  const footer = step === 'ask' ? (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      <button type="button" className="secondary-btn" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="secondary-btn" disabled={busy} onClick={() => setStep('claim')}>No</button>
      <button type="button" className="primary-btn" disabled={busy} onClick={yes}>{busy ? 'Saving…' : 'Yes, Continue to Sign'}</button>
    </div>
  ) : (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      <button type="button" className="secondary-btn" disabled={busy} onClick={() => setStep('ask')}>Back</button>
      <button type="button" className="primary-btn" disabled={busy || !claims.length} onClick={sendBack}>
        {busy ? 'Sending…' : 'Send Back to Manager'}
      </button>
    </div>
  );

  return (
    <Modal title="Meal and Rest Breaks" onClose={onClose} footer={footer}>
      {step === 'ask' ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--ink)', lineHeight: 1.5 }}>
            {attestation?.question || 'In this pay period I was provided every meal and rest break California law requires.'}
          </p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
            Answer Yes to sign your time sheet. If you missed a meal or rest break, answer No - your manager adds the premium pay and sends it back to you to sign.
          </p>
          {flagged.size > 0 && (
            <div role="note" style={{ fontSize: 12.5, color: '#b45309', border: '1px solid rgba(180,83,9,0.3)', borderRadius: 10, padding: '8px 10px' }}>
              Your punches show no full meal break on {[...flagged.keys()].map(formatDate).join(', ')}.
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
            Pick each day and the break you missed. Days your punches flagged are already ticked for Meal. This does not sign your time sheet - it goes back to your manager.
          </p>
          <div role="table" aria-label="Missed Breaks" style={{ display: 'grid', gap: 2 }}>
            <div role="row" style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px', gap: 8, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', padding: '4px 2px' }}>
              <span role="columnheader">Day</span><span role="columnheader">Meal</span><span role="columnheader">Rest</span>
            </div>
            {days.map(ds => (
              <div role="row" key={ds} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px', gap: 8, alignItems: 'center', padding: '6px 2px', borderTop: '1px solid var(--line)', fontSize: 13 }}>
                <span role="cell">
                  {dow(ds)}
                  {flagged.get(ds) && <span style={{ marginLeft: 8, fontSize: 11.5, color: '#b45309' }}>{flagged.get(ds).chip}</span>}
                </span>
                {['meal', 'rest'].map(kind => (
                  <span role="cell" key={kind}>
                    <input type="checkbox" aria-label={`${kind === 'meal' ? 'Meal' : 'Rest'} ${formatDate(ds)}`}
                      checked={!!picks[`${ds}|${kind}`]} onChange={() => toggle(`${ds}|${kind}`)} />
                  </span>
                ))}
              </div>
            ))}
          </div>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>
            Note (Optional)
            <textarea className="form-input" rows={2} maxLength={500} value={note} onChange={e => setNote(e.target.value)}
              placeholder="Anything your manager should know" style={{ fontSize: 13, resize: 'vertical' }} />
          </label>
        </div>
      )}
    </Modal>
  );
}
