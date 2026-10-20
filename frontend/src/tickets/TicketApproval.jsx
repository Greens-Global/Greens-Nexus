// TicketApproval - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { useEffect, useState } from 'react';
import { CheckCircle2, Send, X, ShieldAlert } from 'lucide-react';
import { api } from '../api';
import { NX, chip, btn, input as inputStyle } from '../tasks/theme';
import { PersonSelect, usePeople } from '../tasks/components';
import { fmtDate, APPROVAL_META } from './ticketMeta';

// ── Approvals ────────────────────────────────────────────────────────────────
// A small status chip, shown wherever a ticket is listed.
function ApprovalChip({ ticket }) {
  const meta = APPROVAL_META[ticket.approvalStatus];
  if (!meta) return null;   // "none" - this ticket never needed approval
  // Smaller than the status chip beside it - same reasoning as SlaBadge.
  return <span style={{ ...chip(meta.color, meta.tint), fontSize: 11, padding: '1px 7px' }}>{meta.label}</span>;
}

// The approval panel, in two acts.
//
// 1. A parked request arrives with no approver: an IT Admin picks who signs it
//    off and sends it. Nobody else can - a requester who chooses their own
//    approver has not been approved by anyone.
// 2. Once routed, the named approver (or an admin) sees the decision buttons;
//    everyone else sees who it's waiting on, or what was decided and why.
function ApprovalPanel({ ticket: t, myEmail, nameOf, onDecided }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [approver, setApprover] = useState(null);
  const [itAdmin, setItAdmin] = useState(false);
  const people = usePeople();
  useEffect(() => {
    let alive = true;
    // canAct here, not onDesk - an administrator must be able to unstick a
    // request whose desk was mis-configured.
    // ...and a desk supervisor's: routing for approval is ticket_roles.can_manage_desk.
    api.getMyTicketAccess().then((r) => { if (alive) setItAdmin(!!r?.canAct && r?.canManageDesk !== false); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const status = t.approvalStatus || 'none';
  if (status === 'none') return null;

  const meta = APPROVAL_META[status];
  const mine = (t.approverId || '').toLowerCase() === (myEmail || '').toLowerCase();
  // Not yet routed. The desk's step, not the approver's.
  const needsRouting = status === 'pending' && !t.approverId;

  const sendForApproval = async () => {
    if (!approver) { setErr('Choose who should approve this.'); return; }
    setErr(''); setBusy('send');
    try { await api.requestTicketApproval(t.id, approver, note.trim()); await onDecided?.(); }
    catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  const decide = async (decision) => {
    // The backend requires a reason to reject; ask here rather than fail the call.
    if (decision === 'reject' && !note.trim()) {
      setErr('A reason is required to reject.');
      return;
    }
    setErr(''); setBusy(decision);
    try { await api.decideTicketApproval(t.id, decision, note.trim()); await onDecided?.(); }
    catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  return (
    <div style={{ border: `1px solid ${meta.color}`, background: meta.tint, borderRadius: 10, padding: 14, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: status === 'pending' ? 10 : 6 }}>
        <ShieldAlert size={15} style={{ color: meta.color }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink }}>{meta.label}</span>
        {t.approverId && (
          <span style={{ fontSize: 12.5, color: NX.dim }}>
            {status === 'pending' ? 'waiting on ' : 'by '}{mine ? 'you' : nameOf(t.approverId)}
          </span>
        )}
        {t.approvalDecidedAt && <span style={{ fontSize: 11.5, color: NX.faint, marginLeft: 'auto' }}>{fmtDate(t.approvalDecidedAt)}</span>}
      </div>

      {needsRouting ? (
        itAdmin ? (
          <>
            <div style={{ fontSize: 12, color: NX.dim, marginBottom: 8 }}>
              This request needs approval before it can be assigned. Choose who signs it off.
            </div>
            <div style={{ marginBottom: 8 }}>
              <PersonSelect value={approver} people={people.filter((p) => (p.email || '').toLowerCase() !== (t.requesterId || '').toLowerCase())}
                onChange={setApprover} placeholder="Select approver" />
            </div>
            <input value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Note for the approver (optional)"
              style={{ ...inputStyle, marginBottom: 8 }} />
            <button onClick={sendForApproval} disabled={!!busy} style={btn('primary')}>
              <Send size={14} /> {busy === 'send' ? 'Sending…' : 'Send for Approval'}
            </button>
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: NX.dim }}>
            Waiting for IT to send this for approval. It can't be worked on until it's approved.
          </div>
        )
      ) : status === 'pending' ? (
        mine ? (
          <>
            <div style={{ fontSize: 12, color: NX.dim, marginBottom: 8 }}>
              Approving releases this ticket for assignment. Rejecting closes it.
            </div>
            <input value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Reason (required to reject, optional to approve)"
              style={{ ...inputStyle, marginBottom: 8 }} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={() => decide('approve')} disabled={!!busy} style={btn('primary')}>
                <CheckCircle2 size={14} /> {busy === 'approve' ? 'Approving…' : 'Approve'}
              </button>
              <button onClick={() => decide('reject')} disabled={!!busy} style={{ ...btn('outline'), color: NX.red, borderColor: NX.red }}>
                <X size={14} /> {busy === 'reject' ? 'Rejecting…' : 'Reject'}
              </button>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: NX.dim }}>
            This request can't be worked on until it's approved.
          </div>
        )
      ) : t.approvalNote ? (
        <div style={{ fontSize: 12.5, color: NX.dim }}>“{t.approvalNote}”</div>
      ) : null}
      {err && <div style={{ marginTop: 8, fontSize: 12.5, color: NX.red, fontWeight: 600 }}>{err}</div>}
    </div>
  );
}

export { ApprovalChip, ApprovalPanel };
