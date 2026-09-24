// Timesheet review + Nexus Sign (Sep 2026) - replaces the one-click
// "Sign & submit" / "Approve" / "Finalize to sign" cards on the timecard.
//
// Two phases (backend: timesheet_review.py):
//   Review  - the employee submits; the manager sends it back with a note or
//             agrees; back and forth until he agrees. One side edits at a time.
//   Signing - the agreed version goes out in Nexus Sign: employee, then
//             manager, then the company's HR contact. Signing opens the real
//             Nexus Sign screen (consent, code, draw / type / paper). Declining
//             there hands the timesheet back for another round. HR's signature
//             finalizes the period for payroll.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, Clock, FileSignature, Send, Undo2, ChevronRight, Lock } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';
import { SignModal } from './ESign';

const ACTION_LABEL = {
  submitted: 'submitted the timesheet', resubmitted: 'resubmitted the timesheet',
  sent_back: 'sent it back', agreed: 'agreed and sent it for signature',
  declined: 'declined to sign', returned: 'returned it', cancelled: 'cancelled signing',
  signed_employee: 'signed as the employee', signed_manager: 'signed as the manager',
  signed_hr: 'signed for HR', completed: 'finalized it for payroll',
};
const STEPS = [
  { key: 'review', label: 'Review' }, { key: 'employee', label: 'Employee Signs' },
  { key: 'manager', label: 'Manager Signs' }, { key: 'hr', label: 'HR Signs' },
];
const hm = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;

function stepIndex(r) {
  if (!r || ['not_submitted', 'with_manager', 'with_employee'].includes(r.status)) return 0;
  if (r.status === 'completed') return 4;
  return Math.max(1, STEPS.findIndex((s) => s.key === r.turn));
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
          {party.signatureKind === 'paper' && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', background: 'var(--mist)', padding: '2px 8px', borderRadius: 999 }}>On paper</span>}
        </div>
      ) : (
        <span style={{ fontSize: 12.5, fontWeight: 700, color: waiting ? '#b45309' : 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {waiting ? <><Clock size={13} /> Waiting for {party?.name || label}</> : party?.name ? `${party.name} - not yet` : 'Not yet'}
        </span>
      )}
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
  if (!review) return null;
  const r = review;
  const name = (e) => (e ? nameFor?.(e) || e : '');
  const lastNote = [...(r.rounds || [])].reverse().find((e) => e.note)?.note;

  async function run(call, done) {
    setBusy(true);
    try { await call(); setNote(''); toastOk?.(done); onChanged?.(); }
    catch (e) { toastErr?.(e?.message || 'Could not save that.'); }
    finally { setBusy(false); }
  }

  const noteBox = (placeholder) => (
    <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000}
      placeholder={placeholder} className="form-input" style={{ width: '100%', resize: 'vertical', fontSize: 13, marginBottom: 8 }} />
  );

  let body = null;
  if (r.status === 'not_submitted') {
    body = self ? (
      <>
        <p style={{ fontSize: 13, margin: '0 0 8px' }}>When your hours are right, submit them to your manager for review. You sign after they agree.</p>
        {noteBox('Anything your manager should know? (optional)')}
        <button className="primary-btn" disabled={busy} onClick={() => run(() => api.timesheetReviewSubmit(anchor, note.trim()), 'Submitted to your manager.')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><Send size={13} /> Submit for Review</button>
      </>
    ) : <p style={{ fontSize: 13, margin: 0, color: 'var(--muted)' }}>Not submitted yet.</p>;
  } else if (r.status === 'with_manager') {
    body = r.canAgree ? (
      <>
        <p style={{ fontSize: 13, margin: '0 0 8px' }}>
          Review the hours above - you can correct them now. Send it back with what needs changing, or agree to send it for signature.
          {lastNote && <span style={{ color: 'var(--muted)' }}> Latest note: "{lastNote}"</span>}
        </p>
        {noteBox('What needs changing? (required to send back)')}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="secondary-btn" disabled={busy || !note.trim()} onClick={() => run(() => api.timesheetReviewSendBack(r.id, note.trim()), 'Sent back to the employee.')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><Undo2 size={13} /> Send Back</button>
          <button className="primary-btn" disabled={busy} onClick={() => run(() => api.timesheetReviewAgree(r.id, note.trim()), 'Agreed - sent to the employee to sign.')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><FileSignature size={13} /> Agree &amp; Send for Signature</button>
        </div>
      </>
    ) : <p style={{ fontSize: 13, margin: 0 }}><Lock size={12} style={{ verticalAlign: '-1px' }} /> With {name(r.managerEmail)} for review. {self ? 'They can send it back if something needs changing.' : ''}</p>;
  } else if (r.status === 'with_employee') {
    body = r.canSubmit ? (
      <>
        <p style={{ fontSize: 13, margin: '0 0 8px' }}>
          {name(r.managerEmail)} sent it back{lastNote ? <>: <strong>"{lastNote}"</strong></> : '.'} Make the changes above, then resubmit.
        </p>
        {noteBox('What did you change? (optional)')}
        <button className="primary-btn" disabled={busy} onClick={() => run(() => api.timesheetReviewSubmit(anchor, note.trim()), 'Resubmitted to your manager.')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><Send size={13} /> Resubmit</button>
      </>
    ) : <p style={{ fontSize: 13, margin: 0 }}><Lock size={12} style={{ verticalAlign: '-1px' }} /> Back with {name(r.employeeEmail) || 'the employee'} for changes.</p>;
  }

  const parties = Object.fromEntries((r.parties || []).map((p) => [p.role, p]));
  const signingView = ['signing', 'completed'].includes(r.status);
  const myRole = r.myPartyId ? r.turn : null;

  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
      <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>Timesheet Review &amp; Signatures</div>
      <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '0 0 10px' }}>
        The employee and manager agree the hours, then the employee, manager and HR sign in Nexus Sign (electronically or on paper). HR's signature finalizes it for payroll. Period: {periodLabel}.
      </p>
      <Stepper review={r} />
      {body}
      {signingView && (
        <>
          {r.status === 'completed'
            ? <p style={{ fontSize: 13, margin: '0 0 10px', color: 'hsl(var(--color-green))', fontWeight: 700 }}><CheckCircle size={13} style={{ verticalAlign: '-2px' }} /> Signed by everyone and finalized for payroll. The sealed copy is in Documents.</p>
            : <p style={{ fontSize: 13, margin: '0 0 10px' }}>Agreed by {name(r.agreedBy)} on {formatDate(r.agreedAt)}. Hours are locked while it is signed - to change them, decline in Nexus Sign with a reason.</p>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
            <SigCard label="Employee" party={parties.employee} waiting={r.turn === 'employee'} />
            <SigCard label="Manager" party={parties.manager} waiting={r.turn === 'manager'} />
            <SigCard label="HR" party={parties.hr} waiting={r.turn === 'hr'} />
          </div>
          {r.myPartyId && (
            <button className="primary-btn" onClick={() => setSigning(r.myPartyId)}
              style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <FileSignature size={13} /> {myRole === 'employee' ? 'Sign & Submit' : 'Review & Sign'}
            </button>
          )}
        </>
      )}
      <History rounds={r.rounds} nameFor={name} />
      {signing && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'var(--bg, #f4f5f7)', display: 'flex', flexDirection: 'column' }}>
          <SignModal partyId={signing} onClose={() => setSigning(null)}
            onDone={() => { setSigning(null); onChanged?.(); }} toastOk={toastOk || (() => {})} toastErr={toastErr || (() => {})} />
        </div>, document.body)}
    </div>
  );
}
