// Role change requests (Pranshu, Oct 13). Since Neil's Oct 22 call nobody asks
// any more - HR, IT Admins and Global Admins change a role directly, with a
// reason. Requests still pending from before stay decidable here: those same
// people approve (the role changes then), decline or cancel. Shown two ways:
//
//   RoleChangeRequestCard  - on the person's Access tab (People and
//                            Settings > Access): the pending request, with
//                            Approve / Decline for an approver and Cancel
//                            Request for whoever asked or HR.
//   RoleChangeDecisionModal - opened straight from the bell or the email
//                            (People deep link hr-role-change-<id>).
//   RoleHistory            - the person's role change log (Oct 14): decided
//                            requests, direct changes made in People and
//                            signed promotions - when, from / to, the reason,
//                            who raised it and who approved or signed.
//
// What each viewer may do comes from the server (canDecide / canCancel).
import { useEffect, useState, useRef } from 'react';
import { X, Shield, ArrowRight, Check, Ban, Clock } from 'lucide-react';
import { api } from '../api';
import { Spinner } from './AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';

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
          ? <>Asked before role changes stopped needing approval - HR, an IT Admin or a Global Admin approves or declines it.</>
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

// The bell's and the email's "Review Request" land on People at
// hr-role-change-<id>. An approver who cannot open People - a manager above
// the tier that gets a team view, a supervisor named as someone's manager -
// hit Access Restricted there and never saw the dialog (Oct 13 release
// review). App renders this for that one address instead: the decision on
// its own, a note on the outcome, then back to the dashboard.
export function RoleChangeDeepLinkFallback({ requestId, onDone }) {
  const [note, setNote] = useState(null);
  const [open, setOpen] = useState(true);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const decided = () => { setOpen(false); timer.current = setTimeout(onDone, 1800); };
  return (
    <>
      {open && <RoleChangeDecisionModal requestId={requestId} onClose={onDone} onDecided={decided}
        toastOk={(msg) => setNote({ kind: 'ok', msg })} toastErr={(msg) => setNote({ kind: 'error', msg })} />}
      {note && (
        <div role={note.kind === 'error' ? 'alert' : 'status'} style={{
          position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)', zIndex: 1300,
          background: note.kind === 'error' ? 'hsl(var(--color-red))' : 'var(--ink)', color: 'var(--paper)',
          padding: '10px 16px', borderRadius: 10, fontSize: 13, fontWeight: 600, boxShadow: 'var(--shadow-md)', fontFamily: 'Inter,sans-serif',
        }}>{note.msg}</div>
      )}
    </>
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
      <div role="dialog" aria-modal="true" aria-label="Role change request" className="nx-popup"
        style={{ background: 'var(--card)', borderRadius: 16, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
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
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 12 }}>Only HR, an IT Admin or a Global Admin can approve this.</div>
                  )}
                  <Actions r={r} toastErr={toastErr} onDone={(out, kind) => { toastOk?.(DONE_TEXT[kind]); onDecided?.(out, kind); }} />
                </>
              )}
        </div>
      </div>
    </div>
  );
}

const HISTORY_TONE = { approved: 'green', completed: 'green', changed: 'blue', declined: 'red', canceled: 'gray' };

function outcome(h) {
  if (h.kind === 'promotion') {
    return h.signers.length ? `Signed by ${h.signers.map(s => s.name).join(', ')}` : 'Signed through Nexus Sign';
  }
  if (h.kind === 'direct') return 'Changed directly - no approval needed';
  if (h.status === 'approved') return `Approved by ${h.decidedByName || h.decidedBy}`;
  if (h.status === 'declined') return `Declined by ${h.decidedByName || h.decidedBy}${h.note ? ` - ${h.note}` : ''}`;
  return `Canceled by ${h.decidedByName || h.decidedBy}${h.note ? ` - ${h.note}` : ''}`;
}

export function RoleHistory({ employeeId = '', email = '', refreshKey }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (!employeeId && !email) return;
    api.getRoleHistory({ employeeId, email }).then(setRows).catch(() => setRows([]));
  }, [employeeId, email, refreshKey]);
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 700, marginBottom: 8 }}>
        <Clock size={14} style={{ color: 'var(--muted)' }} /> Role History
      </div>
      {rows === null ? <div style={{ padding: 14, color: 'var(--muted)' }}><Spinner size="inline" /></div>
        : rows.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No role changes recorded yet.</div>
        : rows.map(h => {
          const tone = HISTORY_TONE[h.status] || 'gray';
          return (
            <div key={h.id} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
                <span style={{ padding: '2px 9px', borderRadius: 6, fontSize: 11.5, fontWeight: 700,
                  background: tone === 'gray' ? 'var(--mist)' : `hsla(var(--color-${tone}),0.12)`,
                  color: tone === 'gray' ? 'var(--muted)' : `hsl(var(--color-${tone}))` }}>{h.statusLabel}</span>
                <span>{h.from || 'No role'}</span>
                <ArrowRight size={13} style={{ color: 'var(--muted)' }} />
                <span style={{ fontWeight: 700 }}>{h.to}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{formatDateTime(h.at)}</span>
              </div>
              {h.reason && <div style={{ fontSize: 12.5, marginTop: 6, whiteSpace: 'pre-line', lineHeight: 1.5 }}><b>Reason:</b> {h.reason}</div>}
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5, lineHeight: 1.5 }}>
                Raised by {h.raisedByName || h.raisedBy || 'unknown'}{h.raisedAt && h.raisedAt !== h.at ? ` on ${formatDateTime(h.raisedAt)}` : ''}
                {' - '}{outcome(h)}{h.effectiveDate ? `. Effective ${formatDate(h.effectiveDate)}` : ''}.
              </div>
            </div>
          );
        })}
    </div>
  );
}
