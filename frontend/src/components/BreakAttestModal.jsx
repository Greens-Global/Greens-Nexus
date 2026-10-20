// CA meal and rest breaks at signing (Neil, Oct 17-18 2026 - backend/ca_breaks.py,
// timesheet_review.on_progress / claim_breaks). Only staff on the California
// overtime rule see this: their review / signing payload carries
// `breakAttestation`. There is NO separate question and no tick box (Neil,
// Oct 18): the statement is shown on the signing screen (BreakStatement) and
// printed above the signature line, so signing confirms it. Nothing at
// clock-in, on breaks or at clock-out, and no daily attestation.
//   Report a Missed Break (BreakAttestModal) - pick the day(s) and Meal /
//   Rest (the days the meal check flagged are pre-filled), add a note if you
//   like. This does NOT sign: the time sheet goes back to the manager, who
//   adds the premium pay.
import { useState } from 'react';
import { api } from '../api';
import { formatDate, formatWeekday } from '../lib/datetime';
import { Modal } from '../tasks/components';

const dow = (ds) => `${formatWeekday(ds, 'short')} ${formatDate(ds)}`;

const STATEMENT = 'I was provided every meal and rest break California law requires.';

// The statement the employee's signature confirms, shown on the signing
// screen. `onReport` opens Report a Missed Break; without it (the public
// email-link page, no Nexus session) the line says where to report instead.
export function BreakStatement({ attestation, onReport }) {
  const flagged = attestation?.flaggedDays || [];
  return (
    <div role="note" aria-label="Meal and Rest Breaks" style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: '12px 16px', marginBottom: 14, display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', lineHeight: 1.5 }}>
        {attestation?.statement || STATEMENT}
      </div>
      {flagged.length > 0 && (
        <div style={{ fontSize: 12.5, color: '#b45309', display: 'grid', gap: 2 }}>
          <span>Your punches show:</span>
          {flagged.map(d => <span key={d.date}>{formatDate(d.date)} - {d.label}.</span>)}
        </div>
      )}
      {/* Report a Missed Break: hourly California-rule staff only - salaried
          US staff see the statement alone (canReport, Oct 20). */}
      {attestation?.canReport !== false && <div style={{ fontSize: 12.5, color: 'var(--muted)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span>Missed a meal or rest break? Report it instead of signing - your manager adds the premium pay and sends it back to you.</span>
        {onReport
          ? <button type="button" onClick={onReport} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', fontFamily: 'Inter,sans-serif', fontSize: 12.5, fontWeight: 700, color: '#b45309' }}>Report a Missed Break</button>
          : <span>Open Nexus, then Workday &gt; Time Sheet, and choose Report a Missed Break.</span>}
      </div>}
    </div>
  );
}

export default function BreakAttestModal({ reviewId, attestation, onClose, onSentBack, toastErr }) {
  const flagged = new Map((attestation?.flaggedDays || []).map(d => [d.date, d]));
  const days = attestation?.workedDays?.length ? attestation.workedDays : [...flagged.keys()];
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

  async function sendBack() {
    setBusy(true);
    try { await api.timesheetBreakClaim(reviewId, { claims, note: note.trim() }); onSentBack?.(); }
    catch (e) { toastErr?.(e?.message || 'Could not send it back.'); setBusy(false); }
  }

  const footer = (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      <button type="button" className="secondary-btn" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="primary-btn" disabled={busy || !claims.length} onClick={sendBack}>
        {busy ? 'Sending…' : 'Send Back to Manager'}
      </button>
    </div>
  );

  return (
    <Modal title="Report a Missed Break" onClose={onClose} footer={footer}>
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
    </Modal>
  );
}
