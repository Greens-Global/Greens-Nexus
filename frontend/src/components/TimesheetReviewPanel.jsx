// Timesheet review + Nexus Sign (Sep 2026) - replaces the one-click
// "Sign & submit" / "Approve" / "Finalize to sign" cards on the timecard.
//
// Oct 16 2026 (Neil, Charmi - call): ONLY THE EMPLOYEE SIGNS. Backend:
// timesheet_review.py.
//   Review  - the approver (the manager, or the HR contact when nobody is set)
//             clicks Review & Approve / Agree - no signature, no code, and the
//             employee need not have submitted first. Or Send Back with a
//             note; back and forth until they approve. One side edits at a time.
//   Sign    - the approval sends the envelope straight to the employee, the
//             only signer (consent, code, draw / type / paper). Their signature
//             finalizes it; the PDF logs who approved it and when.
//   A change after approval (the employee asks for a punch fix, the manager
//   edits) sends it back to the manager. HR may change it at any point
//   without approval; the employee then signs the updated card (Sign
//   Updated Timesheet - the 'approved' state).
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, Clock, FileSignature, Send, Undo2, ChevronRight, Lock, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';
import { SignModal } from './ESign';
import BreakAttestModal from './BreakAttestModal';
import { needsBreakAnswer } from '../lib/breakAttest';

const ACTION_LABEL = {
  submitted: 'submitted the time sheet', resubmitted: 'sent it back to the manager',
  sent_back: 'sent it back', agreed: 'agreed and sent it for signature',
  approved: 'reviewed and approved it', employee_approved: 'approved it to sign',
  reopened: 'reopened it', hr_edited: 'changed the hours (HR)', unlocked: 'unlocked it for corrections',
  declined: 'declined to sign', returned: 'returned it', cancelled: 'cancelled signing',
  recalled: 'recalled it from signing to apply a punch fix',
  finalized_unsigned: "finalized it without the employee's signature (HR)",
  signed_employee: 'signed as the employee', signed_manager: 'signed as the manager',
  signed_hr: 'signed for HR', completed: 'finalized it for payroll',
  // CA-rule staff only (Oct 17 2026): the meal and rest break question.
  break_attested: 'answered Yes to the meal and rest break question',
};
// Oct 16 (Neil): only the employee signs. The lead approver - the manager, or
// the company's HR contact / a Global Admin when nobody is set - approves by
// clicking Agree; the employee's signature finalizes the period.
const STEPS = [
  { key: 'review', label: 'Review' }, { key: 'employee', label: 'Employee Signs' },
  { key: 'done', label: 'Finalized' },
];
const hm = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;

function stepIndex(r) {
  if (!r || ['not_submitted', 'with_manager', 'with_employee'].includes(r.status)) return 0;
  if (r.status === 'completed') return STEPS.length;
  return 1;
}

function Stepper({ review }) {
  const at = stepIndex(review);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
      {STEPS.map((s, i) => {
        const done = i < at, current = i === at;
        return (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 999,
              fontSize: 11.5, fontWeight: 700,
              background: done ? 'hsla(var(--color-green),0.12)' : current ? 'var(--mist)' : 'transparent',
              color: done ? 'hsl(var(--color-green))' : current ? 'var(--ink)' : 'var(--muted)',
              border: `1px solid ${current ? 'var(--line)' : 'transparent'}`,
            }}>
              {done ? <CheckCircle size={12} /> : <span style={{ width: 16, textAlign: 'center' }}>{i + 1}</span>}{s.label}
            </span>
            {i < STEPS.length - 1 && <ChevronRight size={13} style={{ color: 'var(--muted)' }} />}
          </div>
        );
      })}
    </div>
  );
}

function SigCard({ label, party, waiting }) {
  const done = party?.status === 'signed';
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14, background: 'var(--card)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)' }}>{label} Signature</div>
      {done ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: 'hsl(var(--color-green))', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <CheckCircle size={14} /> {party.name}
          </span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{formatDate(party.signedAt)}</span>
          {party.signatureKind === 'paper' && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', background: 'var(--mist)', padding: '2px 8px', borderRadius: 999 }}>On Paper</span>}
        </div>
      ) : (
        <span style={{ fontSize: 12.5, fontWeight: 700, color: waiting ? '#b45309' : 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {waiting ? <><Clock size={13} /> Waiting for {party?.name || label}</> : party?.name ? `${party.name} - not yet` : 'Not yet'}
        </span>
      )}
    </div>
  );
}

// "Manager Sahil approved Jackson's time card at this time on this date"
// (Neil) - the same lines the signed PDF carries.
function ApprovalLog({ lines }) {
  if (!lines?.length) return null;
  return (
    <div data-approval-log style={{ margin: '10px 0 0', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>Approval Log</div>
      {lines.map((l, i) => (
        <div key={i} style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: i ? 3 : 0 }}>
          <ShieldCheck size={13} style={{ color: 'hsl(var(--color-green))', flexShrink: 0, marginTop: 2 }} /><span>{l}</span>
        </div>
      ))}
    </div>
  );
}

function History({ rounds, nameFor }) {
  const [open, setOpen] = useState(false);
  if (!rounds?.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <ChevronRight size={13} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }} />
        Review History ({rounds.length})
      </button>
      {open && (
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          {[...rounds].reverse().map((e, i) => (
            <div key={`${e.at}-${i}`} style={{ fontSize: 12.5, borderLeft: '2px solid var(--line)', paddingLeft: 10 }}>
              <div><strong>{nameFor(e.by)}</strong> {ACTION_LABEL[e.action] || e.action}
                <span style={{ color: 'var(--muted)' }}> · {formatDateTime(e.at)}</span></div>
              {e.note && <div style={{ color: 'var(--ink)', marginTop: 2 }}>"{e.note}"</div>}
              {e.changes?.length > 0 && (
                <div style={{ color: 'var(--muted)', marginTop: 2 }}>
                  {e.changes.map((c) => `${formatDate(c.date)}: ${hm(c.before)} → ${hm(c.after)}`).join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TimesheetReviewPanel({ review, self, anchor, periodLabel, nameFor, onChanged, toastOk, toastErr }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState(null);   // Nexus Sign party id
  // CA-rule staff only: the meal and rest break question before signing
  // (BreakAttestModal). {partyId, review} while it is open.
  const [asking, setAsking] = useState(null);
  const startSign = (partyId, review = r) => {
    if (needsBreakAnswer(review)) setAsking({ partyId, review });
    else setSigning(partyId);
  };
  const [reason, setReason] = useState('');
  if (!review) return null;
  const r = review;
  const name = (e) => (e ? nameFor?.(e) || e : '');
  const lastNote = [...(r.rounds || [])].reverse().find((e) => e.note)?.note;
  const mgr = name(r.managerEmail) || 'your manager';

  async function run(call, done) {
    setBusy(true);
    try {
      const out = await call(); setNote(''); toastOk?.(done); onChanged?.();
      window.dispatchEvent(new CustomEvent('nexus:timesheet-review-changed'));   // Timesheets to Review list
      return out;
    }
    catch (e) { toastErr?.(e?.message || 'Could not save that.'); return null; }
    finally { setBusy(false); }
  }

  // Approve & Sign: the envelope goes out and the signing screen opens on it.
  async function approveAndSign() {
    const out = await run(() => api.timesheetReviewSign(r.id), 'Sign it to finalize.');
    if (out?.myPartyId) startSign(out.myPartyId, out);
  }

  // A missing clock-out, a clock-out with no clock-in or an unended break is
  // fixed before it reaches the manager (Oct 1) - the server refuses Submit
  // with the same words.
  const submitNote = r.submitBlocker && (
    <p role="note" style={{ fontSize: 12.5, margin: '0 0 8px', color: '#b45309' }}>{r.submitBlocker}</p>
  );
  const blockerNote = r.agreeBlocker && (
    <p role="note" style={{ fontSize: 12.5, margin: '0 0 8px', color: '#b45309' }}>{r.agreeBlocker}</p>
  );

  const noteBox = (placeholder) => (
    <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000}
      placeholder={placeholder} className="form-input" style={{ width: '100%', resize: 'vertical', fontSize: 13, marginBottom: 8 }} />
  );
  const approveBtn = (call) => (
    <button className="primary-btn" disabled={busy || !!r.agreeBlocker} title={r.agreeBlocker || 'These hours are accurate - the employee then approves and signs'}
      onClick={() => run(call, `Approved - ${name(r.employeeEmail) || 'the employee'} is asked to sign.`)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><CheckCircle size={13} /> Review &amp; Approve</button>
  );

  let body = null;
  if (r.status === 'not_submitted') {
    if (self) {
      body = (
        <>
          <p style={{ fontSize: 13, margin: '0 0 8px' }}>Your manager reviews and approves your hours after the period ends. Then you approve and sign them. Want them to look now? Send it to them.</p>
          {noteBox('Anything your manager should know? (optional)')}
          {submitNote}
          <button className="primary-btn" disabled={busy || !!r.submitBlocker} title={r.submitBlocker || undefined}
            onClick={() => run(() => api.timesheetReviewSubmit(anchor, note.trim()), 'Sent to your manager.')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><Send size={13} /> Send to Manager</button>
        </>
      );
    } else if (r.canApprove) {
      body = (
        <>
          <p style={{ fontSize: 13, margin: '0 0 8px' }}>Review the hours above - you can correct them now. When they are accurate, approve them and the employee is asked to sign. They don't need to submit first.</p>
          {noteBox('Anything the employee should know? (optional)')}
          {blockerNote}
          {approveBtn(() => api.timesheetReviewApprovePeriod(r.employeeEmail, anchor, note.trim()))}
        </>
      );
    } else {
      body = <p style={{ fontSize: 13, margin: 0, color: 'var(--muted)' }}>Not reviewed yet.</p>;
    }
  } else if (r.status === 'with_manager') {
    body = r.canApprove || r.canAgree ? (
      <>
        <p style={{ fontSize: 13, margin: '0 0 8px' }}>
          Review the hours above - you can correct them now. Approve them when they are accurate, or send it back with what the employee needs to change.
          {lastNote && <span style={{ color: 'var(--muted)' }}> Latest note: "{lastNote}"</span>}
        </p>
        {noteBox('What needs changing? (required to send back)')}
        {blockerNote}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="secondary-btn" disabled={busy || !note.trim()} onClick={() => run(() => api.timesheetReviewSendBack(r.id, note.trim()), 'Sent back to the employee.')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><Undo2 size={13} /> Send Back</button>
          {approveBtn(() => api.timesheetReviewApprove(r.id, note.trim()))}
        </div>
      </>
    ) : <p style={{ fontSize: 13, margin: 0 }}><Lock size={12} style={{ verticalAlign: '-1px' }} /> With {mgr} for review. {self ? 'You can still ask for punch fixes above - they go to them.' : ''}</p>;
  } else if (r.status === 'with_employee') {
    body = r.canSubmit ? (
      <>
        <p style={{ fontSize: 13, margin: '0 0 8px' }}>
          {mgr} sent it back{lastNote ? <>: <strong>"{lastNote}"</strong></> : '.'} Make the changes above, then resubmit.
        </p>
        {noteBox('What did you change? (optional)')}
        {submitNote}
        <button className="primary-btn" disabled={busy || !!r.submitBlocker} title={r.submitBlocker || undefined}
          onClick={() => run(() => api.timesheetReviewSubmit(anchor, note.trim()), 'Resubmitted to your manager.')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><Send size={13} /> Resubmit</button>
      </>
    ) : <p style={{ fontSize: 13, margin: 0 }}><Lock size={12} style={{ verticalAlign: '-1px' }} /> Back with {name(r.employeeEmail) || 'the employee'} for changes.</p>;
  } else if (r.status === 'approved') {
    body = r.canEmployeeApprove ? (
      <>
        <p style={{ fontSize: 13, margin: '0 0 8px' }}>
          HR changed your hours after {name(r.agreedBy) || mgr} approved them{r.agreedAt ? ` on ${formatDateTime(r.agreedAt)}` : ''}. Check them above, then sign the updated time sheet. If something is wrong, ask for a punch fix or tell {mgr} what - it goes back to them.
        </p>
        {noteBox('What is wrong? (required to send it back)')}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="secondary-btn" disabled={busy || !note.trim()}
            onClick={() => run(() => api.timesheetReviewSubmit(anchor, note.trim()), 'Sent back to your manager.')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><Undo2 size={13} /> Not Right - Send Back</button>
          <button className="primary-btn" disabled={busy} onClick={approveAndSign}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><FileSignature size={13} /> Sign Updated Time Sheet</button>
        </div>
      </>
    ) : (
      <p style={{ fontSize: 13, margin: 0 }}>
        Approved by {name(r.agreedBy) || mgr}{r.agreedAt ? ` on ${formatDateTime(r.agreedAt)}` : ''}. HR changed the hours since, so it is waiting for {name(r.employeeEmail) || 'the employee'} to sign the updated time sheet.
      </p>
    );
  }

  const parties = Object.fromEntries((r.parties || []).map((p) => [p.role, p]));
  const signingView = ['signing', 'completed'].includes(r.status);
  const unsigned = r.status === 'completed' && (r.rounds || []).at(-1)?.action === 'finalized_unsigned';

  // Oct 17: an employee who never signs (left, unreachable) must not hold the
  // period open. HR finalizes it with a reason - at once for someone who left,
  // after the wait for anyone else (the server's finalizeUnsignedBlocker).
  const showUnsigned = r.isHr && r.status !== 'completed'
    && (r.canFinalizeUnsigned || ['approved', 'signing'].includes(r.status) || r.employeeLeft);
  const unsignedBox = showUnsigned && (
    <div data-finalize-unsigned style={{ marginTop: 12, padding: '10px 12px', border: '1px dashed var(--line)', borderRadius: 10 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}>Employee Not Signing?</div>
      <p style={{ fontSize: 12.5, margin: '0 0 8px', color: r.canFinalizeUnsigned ? 'var(--ink)' : '#b45309' }}>
        {r.canFinalizeUnsigned
          ? `${r.employeeLeft ? `${name(r.employeeEmail) || 'This person'} is no longer active. ` : ''}You can finalize this period for payroll without their signature. Say why - it is logged on the time sheet.`
          : r.finalizeUnsignedBlocker}
      </p>
      {r.canFinalizeUnsigned && (
        <>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={400}
            placeholder="Why it is finalized without their signature (required)" className="form-input"
            style={{ width: '100%', resize: 'vertical', fontSize: 13, marginBottom: 8 }} />
          <button className="secondary-btn" disabled={busy || reason.trim().length < 5}
            onClick={async () => {
              const out = await run(() => api.timesheetReviewFinalizeUnsigned(r.employeeEmail, r.periodStart || anchor, reason.trim()),
                'Finalized for payroll without the employee\'s signature.');
              if (out) setReason('');
            }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><Lock size={13} /> Finalize Without Employee Signature</button>
        </>
      )}
    </div>
  );

  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
      <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>Time Sheet Review &amp; Signature</div>
      <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '0 0 10px' }}>
        The employee and their approver agree the hours, then the employee signs in Nexus Sign (electronically or on paper). That signature finalizes the period for payroll. Period: {periodLabel}.
      </p>
      {r.isHr && (
        <p data-hr-override style={{ fontSize: 12, margin: '0 0 10px', color: 'var(--ink)', background: 'var(--mist)', borderRadius: 8, padding: '6px 10px' }}>
          As HR you can change these hours at any point without approval. If the manager already approved them, the employee is asked to sign the changed card.
        </p>
      )}
      <Stepper review={r} />
      {body}
      {signingView && (
        <>
          {unsigned
            ? <p style={{ fontSize: 13, margin: '0 0 10px', fontWeight: 700 }}><Lock size={13} style={{ verticalAlign: '-2px' }} /> Finalized for payroll by HR without the employee's signature.</p>
            : r.status === 'completed'
            ? <p style={{ fontSize: 13, margin: '0 0 10px', color: 'hsl(var(--color-green))', fontWeight: 700 }}><CheckCircle size={13} style={{ verticalAlign: '-2px' }} /> Approved and signed - finalized for payroll. The sealed copy is in Documents.</p>
            : <p style={{ fontSize: 13, margin: '0 0 10px' }}>Agreed by {name(r.agreedBy)} on {formatDate(r.agreedAt)}. To change the hours, ask for a punch fix or decline in Nexus Sign with a reason - either way it goes back to the manager.</p>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
            <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14, background: 'var(--card)', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)' }}>Approval</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: 'hsl(var(--color-green))', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <CheckCircle size={14} /> {name(r.agreedBy) || 'Approver'}
                </span>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>agreed {formatDate(r.agreedAt)}</span>
              </div>
            </div>
            <SigCard label="Employee" party={parties.employee} waiting={r.turn === 'employee'} />
          </div>
          {r.myPartyId && (
            <button className="primary-btn" onClick={() => startSign(r.myPartyId)}
              style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <FileSignature size={13} /> {r.turn === 'employee' ? 'Sign & Submit' : 'Review & Sign'}
            </button>
          )}
        </>
      )}
      {unsignedBox}
      <ApprovalLog lines={r.approvalLog} />
      <History rounds={r.rounds} nameFor={name} />
      {asking && (
        <BreakAttestModal reviewId={asking.review.id} attestation={asking.review.breakAttestation} toastErr={toastErr}
          onClose={() => setAsking(null)}
          onYes={() => { const pid = asking.partyId; setAsking(null); setSigning(pid); }}
          onSentBack={() => {
            setAsking(null); toastOk?.('Sent back to your manager to add the premium pay.'); onChanged?.();
            window.dispatchEvent(new CustomEvent('nexus:timesheet-review-changed'));
          }} />
      )}
      {signing && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'var(--bg, #f4f5f7)', display: 'flex', flexDirection: 'column' }}>
          <SignModal partyId={signing} onClose={() => setSigning(null)}
            onDone={() => { setSigning(null); onChanged?.(); }} toastOk={toastOk || (() => {})} toastErr={toastErr || (() => {})} />
        </div>, document.body)}
    </div>
  );
}
