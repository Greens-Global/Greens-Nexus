/* Permanent-assignment UI: employee panel (accept / return / report dead-lost),
   manager queue (accept returns, cancel/force-recover) and the assign/reassign
   modal. All state lives in the DB via /items/assignments — components only
   mirror it and poll. */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Camera, CheckCircle, XCircle, RotateCcw, Loader2, AlertCircle, User, Package, ZoomIn } from 'lucide-react';
import { api } from '../api';
import { supabase } from '../lib/supabase';

const FL = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6, letterSpacing: '.04em' };

export const ASSIGN_STATUS_META = {
  pending_acceptance: { label: 'Awaiting Acceptance', bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))' },
  active:             { label: 'Assigned',            bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))'   },
  return_initiated:   { label: 'Return in Progress',  bg: 'hsla(var(--color-purple),0.12)', fg: 'hsl(var(--color-purple))' },
  closed:             { label: 'Closed',              bg: 'var(--mist)',                    fg: 'var(--muted)'             },
  declined:           { label: 'Declined',            bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))'    },
  cancelled:          { label: 'Cancelled',           bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))'    },
};

const REASON_FLAG = {
  dead:     { label: 'ITEM DEAD', color: 'var(--color-red)'    },
  lost:     { label: 'ITEM LOST', color: 'var(--color-red)'    },
  reassign: { label: 'REASSIGNMENT', color: 'var(--color-blue)' },
};

export function useAssignments() {
  const [assignments, setAssignments] = useState([]);
  const timer = useRef(null);
  // Keep the previous array reference when the poll returns identical data so
  // React bails out of re-rendering consumers every 15s.
  const fetchNow = useCallback(() => api.getAssignments()
    .then(rows => setAssignments(prev => JSON.stringify(prev) === JSON.stringify(rows) ? prev : rows))
    .catch(() => {}), []);
  useEffect(() => {
    fetchNow();
    timer.current = setInterval(fetchNow, 15000);
    return () => clearInterval(timer.current);
  }, [fetchNow]);
  return { assignments, refreshAssignments: fetchNow };
}

async function uploadPhoto(file, prefix) {
  if (!file) return { url: '', name: '' };
  const path = `item-photos/${prefix}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { data, error } = await supabase.storage.from('item-photos').upload(path, file, { contentType: file.type, upsert: false, cacheControl: '31536000' });
  if (error || !data) throw new Error(error?.message || 'Photo upload failed');
  const { data: urlData } = supabase.storage.from('item-photos').getPublicUrl(data.path);
  return { url: urlData.publicUrl, name: file.name };
}

function PhotoField({ file, setFile, required = true }) {
  const ref = useRef(null);
  const [preview, setPreview] = useState(null);
  return (
    <div>
      <label style={FL}>PHOTO {required ? <span style={{ color: 'hsl(var(--color-red))' }}>*</span> : <span style={{ fontWeight: 400 }}>(optional)</span>}</label>
      <input ref={ref} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (!f) return; setFile(f); const r = new FileReader(); r.onload = ev => setPreview(ev.target.result); r.readAsDataURL(f); }} />
      {preview
        ? <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src={preview} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} />
            <button type="button" className="secondary-btn" style={{ fontSize: 12 }} onClick={() => ref.current?.click()}>Replace</button>
          </div>
        : <button type="button" onClick={() => ref.current?.click()}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 12, borderRadius: 9, border: '2px dashed hsla(var(--color-blue),0.4)', background: 'hsla(var(--color-blue),0.04)', cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>
            <Camera size={15} /> Take / Upload Photo
          </button>}
    </div>
  );
}

function ModalShell({ title, sub, children, onClose }) {
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 14, padding: 28, width: '100%', maxWidth: 430, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{title}</h3>
        {sub && <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 18 }}>{sub}</p>}
        {children}
      </div>
    </div>
  );
}

// Manager: assign (or reassign) an item to a person from the directory
export function AssignItemModal({ item, mode, onClose, onDone, toast }) {
  const [directory, setDirectory] = useState([]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api.getRolesDirectory().then(setDirectory).catch(() => {}); }, []);
  const chosen = directory.find(d => d.email === pick);
  const reassign = mode === 'reassign';
  return (
    <ModalShell onClose={onClose}
      title={reassign ? `Reassign ${item.name}` : `Assign ${item.name}`}
      sub={reassign
        ? `Currently with ${item.assignedToName || item.assignedToEmail}. They will be asked to return it with a photo; once a supervisor accepts the return, the new person is asked to accept it.`
        : 'The person will be notified and must accept with a photo before the assignment becomes active.'}>
      <label style={FL}>ASSIGN TO <span style={{ color: 'hsl(var(--color-red))' }}>*</span></label>
      <select className="form-input" style={{ width: '100%' }} value={pick} onChange={e => setPick(e.target.value)}>
        <option value="">— select a person —</option>
        {directory.map(d => <option key={d.email} value={d.email}>{d.name}</option>)}
      </select>
      {error && <p style={{ fontSize: 12.5, color: 'hsl(var(--color-red))', marginTop: 10 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary-btn" disabled={!chosen || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
          onClick={() => {
            setBusy(true); setError('');
            (reassign ? api.reassignItem(item.id, { assignee_email: chosen.email, assignee_name: chosen.name })
                      : api.assignItem(item.id, { assignee_email: chosen.email, assignee_name: chosen.name }))
              .then(() => { toast(reassign ? `Return requested from ${item.assignedToName} — ${chosen.name} will be assigned next.` : `${item.name} assigned to ${chosen.name} — awaiting their acceptance.`); onDone(); onClose(); })
              .catch(err => { setError(err?.message || 'Could not assign.'); setBusy(false); });
          }}>
          {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <User size={14} />} {reassign ? 'Start Reassignment' : 'Assign'}
        </button>
      </div>
    </ModalShell>
  );
}

// Employee: the "Permanent" tab content in My Items
export function MyPermanentPanel({ assignments, userEmail, refresh, toast }) {
  const [modal, setModal] = useState(null); // {kind:'accept'|'return', a, reason}
  const mine = assignments.filter(a => a.assigneeEmail === userEmail);
  const live = mine.filter(a => ['pending_acceptance', 'active', 'return_initiated'].includes(a.status));
  const past = mine.filter(a => !['pending_acceptance', 'active', 'return_initiated'].includes(a.status));
  if (!mine.length) return (
    <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 12 }}>
      <Package size={30} style={{ opacity: .2, display: 'block', margin: '0 auto 10px' }} />
      <div style={{ fontSize: 13.5 }}>No items are permanently assigned to you.</div>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {[...live, ...past.slice(0, 10)].map(a => {
        const sm = ASSIGN_STATUS_META[a.status] || ASSIGN_STATUS_META.closed;
        const flag = REASON_FLAG[a.returnReason];
        return (
          <div key={a.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '14px 18px', background: 'var(--card)', boxShadow: 'var(--shadow-sm)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{a.itemName}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  Assigned by {a.assignedBy || '—'}{a.acceptedAt ? ` · accepted ${new Date(a.acceptedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
                </div>
              </div>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                {flag && a.status === 'return_initiated' && (
                  <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 10.5, fontWeight: 800, background: `hsla(${flag.color},0.12)`, color: `hsl(${flag.color})` }}>{flag.label}</span>
                )}
                <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: sm.bg, color: sm.fg }}>{sm.label}</span>
              </span>
            </div>
            {a.status === 'pending_acceptance' && (
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10, flexWrap: 'wrap' }}>
                <button onClick={() => { const r = prompt('Why are you declining? (optional)') ?? ''; api.declineAssignment(a.id, { note: r }).then(() => { toast('Assignment declined.'); refresh(); }).catch(e => toast(e?.message || 'Could not decline.', 'error')); }}
                  style={{ background: 'none', border: '1px solid hsla(var(--color-red),0.4)', borderRadius: 8, padding: '5px 12px', fontSize: 12, cursor: 'pointer', color: 'hsl(var(--color-red))', fontWeight: 600, fontFamily: 'Inter,sans-serif' }}>
                  Decline
                </button>
                <button className="primary-btn" style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }} onClick={() => setModal({ kind: 'accept', a })}>
                  <Camera size={13} /> Accept & Upload Photo
                </button>
              </div>
            )}
            {a.status === 'active' && (
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10, flexWrap: 'wrap' }}>
                <button onClick={() => setModal({ kind: 'return', a, reason: 'dead' })}
                  style={{ background: 'none', border: '1px solid hsla(var(--color-red),0.4)', borderRadius: 8, padding: '5px 12px', fontSize: 12, cursor: 'pointer', color: 'hsl(var(--color-red))', fontWeight: 600, fontFamily: 'Inter,sans-serif' }}>
                  <AlertCircle size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />Report Dead
                </button>
                <button onClick={() => setModal({ kind: 'return', a, reason: 'lost' })}
                  style={{ background: 'none', border: '1px solid hsla(var(--color-red),0.4)', borderRadius: 8, padding: '5px 12px', fontSize: 12, cursor: 'pointer', color: 'hsl(var(--color-red))', fontWeight: 600, fontFamily: 'Inter,sans-serif' }}>
                  Report Lost
                </button>
                <button className="primary-btn" style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }} onClick={() => setModal({ kind: 'return', a, reason: 'normal' })}>
                  <RotateCcw size={13} /> Return Item
                </button>
              </div>
            )}
            {a.status === 'return_initiated' && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                {a.returnReason === 'reassign' && !a.returnPhotoUrl
                  ? <>This item is being reassigned to <strong>{a.nextAssigneeName || a.nextAssigneeEmail}</strong> — please return it: <button className="primary-btn" style={{ fontSize: 12, marginLeft: 8 }} onClick={() => setModal({ kind: 'return', a, reason: 'reassign' })}><Camera size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />Return with Photo</button></>
                  : 'Waiting for a supervisor to accept the return.'}
              </div>
            )}
          </div>
        );
      })}

      {modal?.kind === 'accept' && (
        <AcceptAssignmentModal a={modal.a} onClose={() => setModal(null)} onDone={() => { refresh(); setModal(null); }} toast={toast} />
      )}
      {modal?.kind === 'return' && (
        <AssignmentReturnModal a={modal.a} reason={modal.reason} onClose={() => setModal(null)} onDone={() => { refresh(); setModal(null); }} toast={toast} />
      )}
    </div>
  );
}

function AcceptAssignmentModal({ a, onClose, onDone, toast }) {
  const [file, setFile] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <ModalShell onClose={onClose} title={`Accept ${a.itemName}`}
      sub="Take a photo of the item as you received it — this records the handover and its condition.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <PhotoField file={file} setFile={setFile} />
        <div>
          <label style={FL}>CONDITION NOTES <span style={{ fontSize: 11, fontWeight: 400 }}>(optional — note any existing damage)</span></label>
          <textarea rows={2} className="form-input" style={{ width: '100%', resize: 'vertical', fontSize: 13 }} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Small dent on the lid" />
        </div>
      </div>
      {error && <p style={{ fontSize: 12.5, color: 'hsl(var(--color-red))', marginTop: 10 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary-btn" disabled={!file || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
          onClick={async () => {
            setBusy(true); setError('');
            try {
              const { url, name } = await uploadPhoto(file, `accept-${a.id}`);
              await api.acceptAssignment(a.id, { photo_url: url, photo_name: name, note: note.trim() });
              toast(`${a.itemName} is now assigned to you.`); onDone();
            } catch (e) { setError(e?.message || 'Could not accept.'); setBusy(false); }
          }}>
          {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Accept Assignment
        </button>
      </div>
    </ModalShell>
  );
}

const RETURN_COPY = {
  normal:   { title: 'Return', sub: 'Returning this item (e.g. leaving the company or no longer need it). A supervisor will verify and accept it.' },
  dead:     { title: 'Report Dead & Return', sub: 'The item no longer works. Photograph it as evidence — a supervisor will accept the return and decide its fate.' },
  lost:     { title: 'Report Lost', sub: 'The item is lost or stolen. No photo needed — a supervisor will confirm the write-off.' },
  reassign: { title: 'Return for Reassignment', sub: 'Photograph the item as you hand it back — the new assignee takes over once a supervisor accepts.' },
};

function AssignmentReturnModal({ a, reason, onClose, onDone, toast }) {
  const c = RETURN_COPY[reason] || RETURN_COPY.normal;
  const needPhoto = reason !== 'lost';
  const [file, setFile] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <ModalShell onClose={onClose} title={`${c.title}: ${a.itemName}`} sub={c.sub}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {needPhoto && <PhotoField file={file} setFile={setFile} />}
        <div>
          <label style={FL}>NOTES {reason !== 'normal' ? <span style={{ color: 'hsl(var(--color-red))' }}>*</span> : <span style={{ fontSize: 11, fontWeight: 400 }}>(optional)</span>}</label>
          <textarea rows={2} className="form-input" style={{ width: '100%', resize: 'vertical', fontSize: 13 }} value={note} onChange={e => setNote(e.target.value)}
            placeholder={reason === 'dead' ? 'What happened to it?' : reason === 'lost' ? 'When/where was it last seen?' : 'Anything the supervisor should know'} />
        </div>
      </div>
      {error && <p style={{ fontSize: 12.5, color: 'hsl(var(--color-red))', marginTop: 10 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary-btn" disabled={busy || (needPhoto && !file) || (reason !== 'normal' && !note.trim())} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
          onClick={async () => {
            setBusy(true); setError('');
            try {
              const photo = needPhoto ? await uploadPhoto(file, `return-${a.id}`) : { url: '', name: '' };
              await api.initAssignmentReturn(a.id, { reason: reason === 'reassign' ? 'normal' : reason, photo_url: photo.url, photo_name: photo.name, note: note.trim() });
              toast('Return submitted — a supervisor will verify and accept it.'); onDone();
            } catch (e) { setError(e?.message || 'Could not submit return.'); setBusy(false); }
          }}>
          {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <RotateCcw size={14} />} Submit Return
        </button>
      </div>
    </ModalShell>
  );
}

// Manager queue: Checkouts → Assignments segment
export function AssignmentsQueue({ assignments, refresh, toast }) {
  const [chip, setChip] = useState('live');
  const [accepting, setAccepting] = useState(null);
  const [preview, setPreview] = useState(null);
  const [cancelling, setCancelling] = useState(null); // assignment pending in-app confirm (no native dialogs)
  const live = assignments.filter(a => ['pending_acceptance', 'active', 'return_initiated'].includes(a.status));
  const shown = chip === 'live' ? live
    : chip === 'returns' ? assignments.filter(a => a.status === 'return_initiated')
    : chip === 'pending' ? assignments.filter(a => a.status === 'pending_acceptance')
    : assignments.filter(a => ['closed', 'declined', 'cancelled'].includes(a.status)).slice(0, 50);
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {[['live', `Live (${live.length})`], ['returns', 'Returns to Accept'], ['pending', 'Awaiting Acceptance'], ['history', 'History']].map(([k, l]) => (
          <button key={k} onClick={() => setChip(k)}
            style={{ padding: '5px 14px', borderRadius: 20, border: `1px solid ${chip === k ? 'var(--pine)' : 'var(--line)'}`, background: chip === k ? 'hsla(var(--color-green),0.1)' : 'transparent', color: chip === k ? 'hsl(var(--color-green))' : 'var(--muted)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
            {l}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--muted)' }}>
          <User size={30} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />No assignments in this filter.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shown.map(a => {
            const sm = ASSIGN_STATUS_META[a.status] || ASSIGN_STATUS_META.closed;
            const flag = REASON_FLAG[a.returnReason];
            return (
              <div key={a.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '14px 18px', background: 'var(--card)', boxShadow: 'var(--shadow-sm)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{a.itemName}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                    {a.assigneeName || a.assigneeEmail}
                    {a.status === 'return_initiated' && a.returnReason === 'reassign' && a.nextAssigneeName && <> → <strong>{a.nextAssigneeName}</strong></>}
                    {a.returnNote && <span style={{ fontStyle: 'italic' }}> · "{a.returnNote}"</span>}
                  </div>
                </div>
                {flag && a.status === 'return_initiated' && (
                  <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 10.5, fontWeight: 800, background: `hsla(${flag.color},0.12)`, color: `hsl(${flag.color})` }}>{flag.label}</span>
                )}
                <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: sm.bg, color: sm.fg }}>{sm.label}</span>
                {(a.returnPhotoUrl || a.acceptPhotoUrl) && (
                  <button onClick={() => setPreview(a.returnPhotoUrl || a.acceptPhotoUrl)} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 7, padding: '4px 8px', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><ZoomIn size={12} /></button>
                )}
                {a.status === 'return_initiated' && (a.returnPhotoUrl || a.returnReason === 'lost') && (
                  <button className="primary-btn" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }} onClick={() => setAccepting(a)}>
                    <CheckCircle size={12} /> Accept Return
                  </button>
                )}
                {['pending_acceptance', 'active', 'return_initiated'].includes(a.status) && (
                  <button title={a.status === 'pending_acceptance' ? 'Cancel assignment' : 'Force-recover (employee unavailable)'}
                    onClick={() => setCancelling(a)}
                    style={{ background: 'none', border: '1px solid hsla(var(--color-red),0.4)', borderRadius: 8, padding: '5px 11px', fontSize: 12, cursor: 'pointer', color: 'hsl(var(--color-red))', fontWeight: 600, fontFamily: 'Inter,sans-serif' }}>
                    <XCircle size={12} style={{ verticalAlign: '-2px', marginRight: 3 }} />{a.status === 'pending_acceptance' ? 'Cancel' : 'Force Recover'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {accepting && (
        <ModalShell onClose={() => setAccepting(null)} title={`Accept return: ${accepting.itemName}`}
          sub={`From ${accepting.assigneeName || accepting.assigneeEmail}. ${accepting.returnReason === 'reassign' && accepting.nextAssigneeName ? `Accepting will assign it to ${accepting.nextAssigneeName} next.` : 'Choose what happens to the item.'}`}>
          <AcceptReturnBody a={accepting} onClose={() => setAccepting(null)} onDone={() => { refresh(); setAccepting(null); }} toast={toast} />
        </ModalShell>
      )}
      {cancelling && (
        <ModalShell onClose={() => setCancelling(null)}
          title={cancelling.status === 'pending_acceptance' ? 'Cancel this assignment?' : `Force-recover ${cancelling.itemName}?`}
          sub={cancelling.status === 'pending_acceptance'
            ? `${cancelling.itemName} hasn't been accepted by ${cancelling.assigneeName || cancelling.assigneeEmail} yet — cancelling puts it back in stock.`
            : `Take ${cancelling.itemName} back from ${cancelling.assigneeName || cancelling.assigneeEmail} without their confirmation. Use this when the holder can't complete the return themselves.`}>
          <CancelAssignmentBody a={cancelling} onClose={() => setCancelling(null)} onDone={() => { refresh(); setCancelling(null); }} toast={toast} />
        </ModalShell>
      )}
      {preview && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }} onClick={() => setPreview(null)}>
          <img src={preview} alt="" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 10 }} />
        </div>
      )}
    </div>
  );
}

function CancelAssignmentBody({ a, onClose, onDone, toast }) {
  const [busy, setBusy] = useState(false);
  const recover = a.status !== 'pending_acceptance';
  function go() {
    setBusy(true);
    api.cancelAssignment(a.id)
      .then(() => { toast(recover ? `${a.itemName} recovered — back in stock.` : 'Assignment cancelled.'); onDone(); })
      .catch(e => { toast(e?.message || 'Failed.', 'error'); setBusy(false); });
  }
  return (
    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6 }}>
      <button className="secondary-btn" onClick={onClose} disabled={busy}>Keep Assigned</button>
      <button onClick={go} disabled={busy}
        style={{ background: 'hsl(var(--color-red))', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 18px', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'Inter,sans-serif', opacity: busy ? 0.7 : 1 }}>
        {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <XCircle size={13} />}
        {recover ? 'Force Recover' : 'Cancel Assignment'}
      </button>
    </div>
  );
}

function AcceptReturnBody({ a, onClose, onDone, toast }) {
  const dead = ['dead', 'lost'].includes(a.returnReason);
  const [dispo, setDispo] = useState(dead ? 'retired' : 'stock');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <label style={FL}>DISPOSITION</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[['stock', 'Back to stock — available for checkout/assignment'], ['retired', 'Retire — dead, lost or written off']].map(([v, l]) => (
          <label key={v} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer', border: `1px solid ${dispo === v ? 'var(--pine)' : 'var(--line)'}`, borderRadius: 9, padding: '9px 12px' }}>
            <input type="radio" checked={dispo === v} onChange={() => setDispo(v)} style={{ accentColor: 'var(--pine)' }} />{l}
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary-btn" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
          onClick={() => { setBusy(true); api.acceptAssignmentReturn(a.id, { disposition: dispo }).then(() => { toast('Return accepted.'); onDone(); }).catch(e => { toast(e?.message || 'Failed.', 'error'); setBusy(false); }); }}>
          {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Confirm
        </button>
      </div>
    </>
  );
}
