// Role change approvals (Pranshu, Oct 13). A role change without a promotion
// is a REQUEST: the employee's manager or their company's HR contact reads the
// reason and approves (the role changes then) or declines. Shown two ways:
//
//   RoleChangeRequestCard  - on the person's Access tab (People and
//                            Settings > Access): the pending request, with
//                            Approve / Decline for an approver and Cancel
//                            Request for whoever asked or HR.
//   RoleChangeDecisionModal - opened straight from the bell or the email
//                            (People deep link hr-role-change-<id>).
//
// What each viewer may do comes from the server (canDecide / canCancel).
import { useEffect, useState } from 'react';
import { X, Shield, ArrowRight, Check, Ban, Clock } from 'lucide-react';
import { api } from '../api';
import { Spinner } from './AsyncState';
import { formatDateTime } from '../lib/datetime';

const roleLabel = { manager: 'Manager', hr: 'HR' };

function Details({ r }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, flexWrap: 'wrap' }}>
        <span style={{ padding: '5px 11px', borderRadius: 10, background: 'var(--mist)' }}>{r.fromTitle || 'No role'}</span>
        <ArrowRight size={15} style={{ color: 'var(--muted)' }} />
        <span style={{ padding: '5px 11px', borderRadius: 10, background: 'hsla(var(--color-green),0.1)', fontWeight: 700 }}>{r.toRoleName}</span>
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>Reason</div>
      <div style={{ fontSize: 13.5, marginTop: 3, whiteSpace: 'pre-line', lineHeight: 1.5 }}>{r.reason}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10, lineHeight: 1.5 }}>
        Asked by {r.requestedByName || r.requestedBy} on {formatDateTime(r.createdAt)}.{' '}
        {r.status === 'pending'
          ? <>Waiting on {r.approvers.map(a => `${a.name} (${roleLabel[a.as] || a.as})`).join(' or ')} - the role changes when one of them approves.</>
          : <>{r.statusLabel}{r.decidedByName ? ` by ${r.decidedByName}` : ''}{r.decidedAt ? ` on ${formatDateTime(r.decidedAt)}` : ''}.{r.decisionNote ? ` Note: ${r.decisionNote}` : ''}</>}
      </div>
    </>
  );
}

// Approve / Decline (with an optional note) / Cancel Request - whichever the
// viewer may do. onDone(updatedRequest, verb) after a success.
function Actions({ r, onDone, toastErr }) {
  const [busy, setBusy] = useState('');
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  async function run(kind) {
    setBusy(kind);
    try {
      const out = kind === 'approve' ? await api.approveRoleChange(r.id)
        : kind === 'decline' ? await api.declineRoleChange(r.id, note)
          : await api.cancelRoleChange(r.id);
      onDone(out, kind);
    } catch (err) { toastErr?.(err?.message || 'That did not work.'); }
    setBusy('');
  }
  if (r.status !== 'pending' || (!r.canDecide && !r.canCancel)) return null;
  return (
    <div style={{ marginTop: 12 }}>
      {declining && (
        <textarea className="form-input" rows={2} autoFocus value={note} onChange={e => setNote(e.target.value)}
          placeholder="Why not? (optional) - the person who asked reads it"
          style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13, marginBottom: 8 }} />
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {r.canDecide && !declining && (
          <button className="primary-btn" onClick={() => run('approve')} disabled={!!busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
            {busy === 'approve' ? <Spinner size={13} /> : <Check size={13} />} Approve
          </button>
        )}
        {r.canDecide && (declining ? (
          <>
            <button className="primary-btn" onClick={() => run('decline')} disabled={!!busy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, background: 'hsl(var(--color-red))' }}>
              {busy === 'decline' ? <Spinner size={13} /> : <Ban size={13} />} Decline Request
            </button>
            <button className="secondary-btn" onClick={() => setDeclining(false)} disabled={!!busy} style={{ fontSize: 12.5 }}>Back</button>
          </>
        ) : (
          <button className="secondary-btn" onClick={() => setDeclining(true)} disabled={!!busy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'hsl(var(--color-red))', borderColor: 'hsla(var(--color-red),0.35)' }}>
            <Ban size={13} /> Decline
          </button>
        ))}
        {r.canCancel && !declining && (
          <button className="secondary-btn" onClick={() => run('cancel')} disabled={!!busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
            {busy === 'cancel' ? <Spinner size={13} /> : <X size={13} />} Cancel Request
          </button>
        )}
      </div>
    </div>
  );
}

const DONE_TEXT = { approve: 'Approved - their role has changed.', decline: 'Declined - their role stays as it is.', cancel: 'Request canceled.' };

export function RoleChangeRequestCard({ employeeId = '', email = '', refreshKey, onDecided, toastOk, toastErr }) {
  const [rows, setRows] = useState([]);
  const load = () => api.getRoleChangeRequests({ employeeId, email }).then(setRows).catch(() => setRows([]));
  useEffect(() => { if (employeeId || email) load(); }, [employeeId, email, refreshKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows.length) return null;
  return (
    <div>
      {rows.map(r => (
        <div key={r.id} style={{ marginBottom: 14, border: '1px solid hsla(var(--color-orange),0.45)', background: 'hsla(var(--color-orange),0.06)', borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Clock size={14} style={{ color: 'hsl(var(--color-orange))' }} />
            <b style={{ fontSize: 13.5 }}>Role Change Awaiting Approval</b>
          </div>
          <Details r={r} />
          <Actions r={r} toastErr={toastErr} onDone={(out, kind) => { toastOk?.(DONE_TEXT[kind]); load(); onDecided?.(out, kind); }} />
        </div>
      ))}
    </div>
  );
}

export function RoleChangeDecisionModal({ requestId, onClose, onDecided, toastOk, toastErr }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.getRoleChangeRequest(requestId).then(setR).catch(e => setErr(e?.message || 'Could not open this request.'));
  }, [requestId]);
  return (
    <div onClick={ev => ev.target === ev.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label="Role change request"
        style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 540, maxHeight: 'min(92dvh, 720px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Shield size={17} style={{ color: 'var(--pine)' }} />
          <div style={{ flex: 1, fontWeight: 800, fontSize: 15.5 }}>Role Change{r ? ` - ${r.employeeName}` : ''}</div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '16px 22px 20px' }}>
          {err ? <div style={{ fontSize: 13, color: 'hsl(var(--color-red))' }}>{err}</div>
            : !r ? <div style={{ padding: 20, textAlign: 'center' }}><Spinner size={18} /></div>
              : (
                <>
                  <Details r={r} />
                  {r.status === 'pending' && !r.canDecide && !r.canCancel && (
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 12 }}>Only their manager or HR can approve this.</div>
                  )}
                  <Actions r={r} toastErr={toastErr} onDone={(out, kind) => { toastOk?.(DONE_TEXT[kind]); onDecided?.(out, kind); }} />
                </>
              )}
        </div>
      </div>
    </div>
  );
}
