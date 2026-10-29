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
//
// Oct 28 2026 (Neil: "less chunky and clunky ... taking up too much room"):
// one bordered card - the title with the steps on the same line, the status
// in a sentence, and the note box (one line until it is used) beside its
// button; the signatures read as one line of facts, not a row of boxes.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, Clock, FileSignature, Send, Undo2, ChevronRight, Lock, ShieldCheck, Info } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';
import { SignModal } from './ESign';
import { Avatar, AvatarName } from '../tasks/components';

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
  break_attested: 'confirmed the meal and rest break statement by signing',
  break_not_collected: 'signed on paper without the meal and rest break statement',
  // Oct 20: signed, but a pay setting moved the totals - not finalized.
  totals_changed: 'Totals changed after approval - sent back to the manager',
  // HR's correction of a finalized period (Neil, Oct 22).
  correction_sent: 'sent the corrected time sheet to sign (HR)', relocked: 'locked it again unchanged (HR)',
  auto_accepted: 'Not signed in time - the corrected time sheet was accepted as sent',
};
// Oct 16 (Neil): only the employee signs. The lead approver - the manager, or
// the company's HR contact / a Global Admin when nobody is set - approves by
// clicking Agree; the employee's signature finalizes the period.
const STEPS = [
  { key: 'review', label: 'Review' }, { key: 'employee', label: 'Employee Signs' },
  { key: 'done', label: 'Finalized' },
];
const HOW = 'The employee and their approver agree the hours, then the employee signs in Nexus Sign (electronically or on paper). That signature finalizes the period for payroll.';
// A phone's note box starts at two lines so its prompt is not cut off.
const NARROW = () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 640px)').matches;
const hm = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;

function stepIndex(r) {
  if (!r || ['not_submitted', 'with_manager', 'with_employee', 'correcting'].includes(r.status)) return 0;
  if (r.status === 'completed') return STEPS.length;
  return 1;
}

function Stepper({ review }) {
  const at = stepIndex(review);
  return (
    <ol aria-label="Review steps" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', listStyle: 'none', margin: 0, padding: 0 }}>
      {STEPS.map((s, i) => {
        const done = i < at, current = i === at;
        return (
          <li key={s.key} aria-current={current ? 'step' : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: current ? 700 : 600,
              color: done ? 'hsl(var(--color-green))' : current ? 'var(--ink)' : 'var(--muted)' }}>
            {done ? <CheckCircle size={14} /> : (
              <span style={{ width: 16, height: 16, borderRadius: '50%', border: `1.5px solid ${current ? 'var(--ink)' : 'var(--line)'}`,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700 }}>{i + 1}</span>
            )}
            {s.label}
            {i < STEPS.length - 1 && <span aria-hidden="true" style={{ width: 18, height: 1, background: 'var(--line)', marginLeft: 2 }} />}
          </li>
        );
      })}
    </ol>
  );
}

// A label over its value - the signing facts read as one line, not boxes.
const FACT_LABEL = { fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)' };

function SigCard({ label, party, waiting }) {
  const done = party?.status === 'signed';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      <div style={FACT_LABEL}>{label} Signature</div>
      {done ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: 'hsl(var(--color-green))', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <CheckCircle size={14} /> <Avatar email={party.email} name={party.name} size={20} /> {party.name}
          </span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{formatDate(party.signedAt)}</span>
          {party.signatureKind === 'paper' && <><span aria-hidden="true" style={{ color: 'var(--muted)' }}>·</span><span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>On Paper</span></>}
        </div>
      ) : (
        <span style={{ fontSize: 12.5, fontWeight: 700, color: waiting ? '#b45309' : 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {waiting ? <><Clock size={13} /> Waiting for {party?.name ? <AvatarName email={party.email} name={party.name} size={18} /> : label}</> : party?.name ? <><AvatarName email={party.email} name={party.name} size={18} /> - not yet</> : 'Not yet'}
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
    <div data-approval-log style={{ margin: '12px 0 0', paddingTop: 10, borderTop: '1px solid var(--line)' }}>
      <div style={{ ...FACT_LABEL, marginBottom: 4 }}>Approval Log</div>
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
              <div><AvatarName email={e.by} name={nameFor(e.by)} size={18}><strong>{nameFor(e.by)}</strong></AvatarName> {ACTION_LABEL[e.action] || e.action}
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

// `below`: a card the time card hangs under the panel (a contractor's Invoice card, Oct 21).
export default function TimesheetReviewPanel({ review, self, anchor, periodLabel, nameFor, onChanged, toastOk, toastErr, below = null }) {
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);   // the note box is one line until it is used
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState(null);   // Nexus Sign party id
  // CA-rule staff: no question before signing (Oct 18) - the signing screen
  // shows the meal and rest break statement and Report a Missed Break.
  const startSign = (partyId) => setSigning(partyId);
  const [reason, setReason] = useState('');
  if (!review) return below;
  const r = review;
  const name = (e) => (e ? nameFor?.(e) || e : '');
  const lastNote = [...(r.rounds || [])].reverse().find((e) => e.note)?.note;
  const mgr = name(r.managerEmail) || 'your manager';

  async function run(call, done) {
    setBusy(true);
    try {
      const out = await call(); setNote(''); setNoteOpen(false); toastOk?.(done); onChanged?.();
      window.dispatchEvent(new CustomEvent('nexus:timesheet-review-changed'));   // Timesheets to Review list
      return out;
    }
    catch (e) { toastErr?.(e?.message || 'Could not save that.'); return null; }
    finally { setBusy(false); }
  }

  // Approve & Sign: the envelope goes out and the signing screen opens on it.
  async function approveAndSign() {
    const out = await run(() => api.timesheetReviewSign(r.id), 'Sign it to finalize.');
    if (out?.myPartyId) startSign(out.myPartyId);
  }

  // A missing clock-out, a clock-out with no clock-in or an unended break is
  // fixed before it reaches the manager (Oct 1) - the server refuses Submit
  // with the same words.
  const submitNote = r.submitBlocker && (
    <p role="note" style={{ fontSize: 12, margin: '6px 0 0', color: '#b45309' }}>{r.submitBlocker}</p>
  );
  const blockerNote = r.agreeBlocker && (
    <p role="note" style={{ fontSize: 12, margin: '6px 0 0', color: '#b45309' }}>{r.agreeBlocker}</p>
  );

  // The note sits beside its button(s): one line until it is focused or
  // filled, then three. It never shrinks back while it holds text.
  const noteBox = (placeholder) => (
    <textarea value={note} onChange={(e) => setNote(e.target.value)} onFocus={() => setNoteOpen(true)}
      rows={noteOpen || note ? 3 : NARROW() ? 2 : 1} maxLength={1000} placeholder={placeholder} aria-label={placeholder}
      className="form-input" style={{ flex: '1 1 300px', minWidth: 0, resize: 'vertical', fontSize: 13, minHeight: 36 }} />
  );
  const actions = (...kids) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>{kids}</div>
  );
  const approveBtn = (call) => (
    <button className="primary-btn" disabled={busy || !!r.agreeBlocker} title={r.agreeBlocker || 'These hours are accurate - the employee then approves and signs'}
      onClick={() => run(call, `Approved - ${name(r.employeeEmail) || 'the employee'} is asked to sign.`)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, whiteSpace: 'nowrap' }}><CheckCircle size={13} /> Review &amp; Approve</button>
  );

  let body = null;
  const corr = r.correction || {};
  const emp = name(r.employeeEmail) || 'the employee';
  if (r.status === 'not_submitted') {
    if (self) {
      body = (
        <>
          <p style={{ fontSize: 13, margin: '0 0 8px' }}>Your manager reviews your hours after the period ends, then you sign them. Want them to look sooner? Send it now.</p>
          {actions(
            <span key="n" style={{ display: 'contents' }}>{noteBox('Anything your manager should know? (optional)')}</span>,
            <button key="b" className="primary-btn" disabled={busy || !!r.submitBlocker} title={r.submitBlocker || undefined}
              onClick={() => run(() => api.timesheetReviewSubmit(anchor, note.trim()), 'Sent to your manager.')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, whiteSpace: 'nowrap' }}><Send size={13} /> Send to Manager</button>,
          )}
          {submitNote}
        </>
      );
    } else if (r.canApprove) {
      body = (
        <>
          <p style={{ fontSize: 13, margin: '0 0 8px' }}>Review the hours above - you can correct them now. When they are accurate, approve them and the employee is asked to sign. They don't need to submit first.</p>
          {actions(
            <span key="n" style={{ display: 'contents' }}>{noteBox('Anything the employee should know? (optional)')}</span>,
            <span key="b" style={{ display: 'contents' }}>{approveBtn(() => api.timesheetReviewApprovePeriod(r.employeeEmail, anchor, note.trim()))}</span>,
          )}
          {blockerNote}
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
        {actions(
          <span key="n" style={{ display: 'contents' }}>{noteBox('What needs changing? (required to send back)')}</span>,
          <button key="s" className="secondary-btn" disabled={busy || !note.trim()} onClick={() => run(() => api.timesheetReviewSendBack(r.id, note.trim()), 'Sent back to the employee.')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, whiteSpace: 'nowrap' }}><Undo2 size={13} /> Send Back</button>,
          <span key="a" style={{ display: 'contents' }}>{approveBtn(() => api.timesheetReviewApprove(r.id, note.trim()))}</span>,
        )}
        {blockerNote}
      </>
    ) : <p style={{ fontSize: 13, margin: 0 }}><Lock size={12} style={{ verticalAlign: '-1px' }} /> With {mgr} for review. {self ? 'You can still ask for punch fixes above - they go to them.' : ''}</p>;
  } else if (r.status === 'with_employee') {
    body = r.canSubmit ? (
      <>
        <p style={{ fontSize: 13, margin: '0 0 8px' }}>
          {mgr} sent it back{lastNote ? <>: <strong>"{lastNote}"</strong></> : '.'} Make the changes above, then resubmit.
        </p>
        {actions(
          <span key="n" style={{ display: 'contents' }}>{noteBox('What did you change? (optional)')}</span>,
          <button key="b" className="primary-btn" disabled={busy || !!r.submitBlocker} title={r.submitBlocker || undefined}
            onClick={() => run(() => api.timesheetReviewSubmit(anchor, note.trim()), 'Resubmitted to your manager.')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, whiteSpace: 'nowrap' }}><Send size={13} /> Resubmit</button>,
        )}
        {submitNote}
      </>
    ) : <p style={{ fontSize: 13, margin: 0 }}><Lock size={12} style={{ verticalAlign: '-1px' }} /> Back with {name(r.employeeEmail) || 'the employee'} for changes.</p>;
  } else if (r.status === 'correcting') {
    // HR unlocked a finalized period to correct it (Neil, Oct 22): HR changes
    // it, then the employee signs it again - or it is locked again unchanged.
    const why = corr.reason ? `: "${corr.reason}"` : '';
    body = r.isHr && !self ? (
      <>
        <p style={{ fontSize: 13, margin: '0 0 8px' }}>
          Unlocked by {corr.by ? <AvatarName email={corr.by} name={name(corr.by)} /> : 'HR'}{corr.at ? ` on ${formatDate(corr.at)}` : ''}{why}. Only HR can change these hours now. When they are right, send the time sheet to {emp} to sign. If nothing needed changing, lock it again - no new signature is needed.
        </p>
        {r.correctionBlocker && <p role="note" style={{ fontSize: 12.5, margin: '0 0 8px', color: '#b45309' }}>{r.correctionBlocker}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {r.canRelock && (
            <button className="secondary-btn" disabled={busy} onClick={() => run(() => api.timesheetReviewRelock(r.id), 'Locked again - the signed copy stands.')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><Lock size={13} /> Re-lock (No Changes)</button>
          )}
          {r.canSendCorrection && (
            <button className="primary-btn" disabled={busy || !!r.correctionBlocker} title={r.correctionBlocker || undefined}
              onClick={() => run(() => api.timesheetReviewSendCorrection(r.id), `Sent to ${emp} to sign.`)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><FileSignature size={13} /> Send to {emp} to Sign</button>
          )}
        </div>
      </>
    ) : (
      <p style={{ fontSize: 13, margin: 0 }}>
        {self
          ? <>HR ({corr.by ? <AvatarName email={corr.by} name={name(corr.by)} /> : 'HR'}) unlocked your time sheet to correct it{why}. You will be asked to review and sign it again when they are done.</>
          : <>{corr.by ? <AvatarName email={corr.by} name={name(corr.by)} /> : 'HR'} unlocked this time sheet{corr.at ? ` on ${formatDate(corr.at)}` : ''} to correct it{why}. Only HR can change it; {emp} signs it again.</>}
      </p>
    );
  } else if (r.status === 'approved') {
    body = r.canEmployeeApprove ? (
      <>
        <p style={{ fontSize: 13, margin: '0 0 8px' }}>
          HR changed your hours after {r.agreedBy ? <AvatarName email={r.agreedBy} name={name(r.agreedBy)} /> : mgr} approved them{r.agreedAt ? ` on ${formatDateTime(r.agreedAt)}` : ''}. Check them above, then sign the updated time sheet. If something is wrong, ask for a punch fix or tell {mgr} what - it goes back to them.
        </p>
        {actions(
          <span key="n" style={{ display: 'contents' }}>{noteBox('What is wrong? (required to send it back)')}</span>,
          <button key="s" className="secondary-btn" disabled={busy || !note.trim()}
            onClick={() => run(() => api.timesheetReviewSubmit(anchor, note.trim()), 'Sent back to your manager.')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, whiteSpace: 'nowrap' }}><Undo2 size={13} /> Not Right - Send Back</button>,
          <button key="a" className="primary-btn" disabled={busy} onClick={approveAndSign}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, whiteSpace: 'nowrap' }}><FileSignature size={13} /> Sign Updated Time Sheet</button>,
        )}
      </>
    ) : (
      <p style={{ fontSize: 13, margin: 0 }}>
        Approved by {r.agreedBy ? <AvatarName email={r.agreedBy} name={name(r.agreedBy)} /> : mgr}{r.agreedAt ? ` on ${formatDateTime(r.agreedAt)}` : ''}. HR changed the time sheet since, so it is waiting for {name(r.employeeEmail) || 'the employee'} to sign the updated time sheet.
      </p>
    );
  }

  const parties = Object.fromEntries((r.parties || []).map((p) => [p.role, p]));
  const signingView = ['signing', 'completed'].includes(r.status);
  // The sealed copy, for the employee, the approving manager, the HR contact,
  // Full HR and Global Admins (Neil, Oct 20) - no longer listed in Documents.
  async function openSigned() {
    try {
      const { url } = await api.downloadSign(r.signRequestId);
      window.open(url, '_blank', 'noopener');
    } catch (e) { toastErr?.(e?.message || 'Could not open the signed copy.'); }
  }
  const unsigned = r.status === 'completed' && (r.rounds || []).at(-1)?.action === 'finalized_unsigned';

  // Oct 17: an employee who never signs (left, unreachable) must not hold the
  // period open. HR finalizes it with a reason - at once for someone who left,
  // after the wait for anyone else (the server's finalizeUnsignedBlocker).
  const showUnsigned = r.isHr && r.status !== 'completed' && (!r.inCorrection || r.employeeLeft)
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

  const sentBack = self && r.status === 'with_employee' && r.canSubmit;   // waiting on me - the Time Sheet tab's count
  return (
    <section data-review-panel className={sentBack ? 'nx-needs-you nx-needs-you--card' : undefined} aria-label="Time Sheet Review and Signature"
      style={{ margin: self ? '0 0 12px' : '18px 0 0', padding: '12px 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)' }}>
      {/* The title and the steps share one line; how it works is behind the info mark. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px 16px', flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Time Sheet Review &amp; Signature
          <span role="img" aria-label={HOW} title={`${HOW} Period: ${periodLabel}.`} style={{ display: 'inline-flex', color: 'var(--muted)', cursor: 'help' }}>
            <Info size={14} />
          </span>
        </div>
        <div style={{ marginLeft: 'auto' }}><Stepper review={r} /></div>
      </div>
      {r.isHr && (
        <p data-hr-override style={{ fontSize: 12, margin: '0 0 8px', color: 'var(--muted)' }}>
          As HR you can change these hours at any point without approval. If the manager already approved them, the employee is asked to sign the changed card.
        </p>
      )}
      {body}
      {signingView && (
        <>
          {unsigned
            ? <p style={{ fontSize: 13, margin: '0 0 10px', fontWeight: 700 }}><Lock size={13} style={{ verticalAlign: '-2px' }} /> Finalized for payroll by HR without the employee's signature.</p>
            : r.status === 'completed'
            ? <p style={{ fontSize: 13, margin: '0 0 10px', color: 'hsl(var(--color-green))', fontWeight: 700, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span><CheckCircle size={13} style={{ verticalAlign: '-2px' }} /> Approved and signed - finalized for payroll. The sealed copy is filed to the employee's HR folder.</span>
                {r.signRequestId && <button type="button" className="secondary-btn" onClick={openSigned} style={{ fontSize: 12.5 }}>Open Signed Copy</button>}
              </p>
            : r.inCorrection
            ? <p style={{ fontSize: 13, margin: '0 0 10px' }}>HR corrected this time sheet after it was signed. {self ? 'Sign it, or decline it with what is wrong' : `${emp} signs it, or declines it with what is wrong`} - a decline goes back to HR.{corr.acceptBy ? ` If it is not signed or declined by ${formatDate(corr.acceptBy)}, it is accepted as sent.` : ''}</p>
            : <p style={{ fontSize: 13, margin: '0 0 10px' }}>{r.agreedBy ? <>Agreed by <AvatarName email={r.agreedBy} name={name(r.agreedBy)} />{r.agreedAt ? ` on ${formatDate(r.agreedAt)}` : ''}. </> : ''}To change the hours, ask for a punch fix or decline in Nexus Sign with a reason - either way it goes back to the manager.</p>}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px 32px', flexWrap: 'wrap', paddingTop: 10, borderTop: '1px solid var(--line)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <div style={FACT_LABEL}>Approval</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: 'hsl(var(--color-green))', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <CheckCircle size={14} /> {r.agreedBy && <Avatar email={r.agreedBy} name={name(r.agreedBy)} size={20} />} {name(r.agreedBy) || 'Approver'}
                </span>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>agreed {formatDate(r.agreedAt)}</span>
              </div>
            </div>
            <SigCard label="Employee" party={parties.employee} waiting={r.turn === 'employee'} />
            {r.myPartyId && (
              <button className="primary-btn" onClick={() => startSign(r.myPartyId)}
                style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, whiteSpace: 'nowrap' }}>
                <FileSignature size={13} /> {r.turn === 'employee' ? 'Sign & Submit' : 'Review & Sign'}
              </button>
            )}
          </div>
        </>
      )}
      {unsignedBox}
      <ApprovalLog lines={r.approvalLog} />
      <History rounds={r.rounds} nameFor={name} />
      {signing && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'var(--bg, #f4f5f7)', display: 'flex', flexDirection: 'column' }}>
          <SignModal partyId={signing} onClose={() => setSigning(null)}
            onDone={() => { setSigning(null); onChanged?.(); }} toastOk={toastOk || (() => {})} toastErr={toastErr || (() => {})} />
        </div>, document.body)}
      {below}
    </section>
  );
}
