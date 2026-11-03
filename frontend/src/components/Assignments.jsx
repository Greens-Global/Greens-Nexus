/* Permanent-assignment UI: the shared assignments store, the accept / decline /
   return sheets an assignee uses, the manager queue (accept returns, cancel /
   force-recover) and the assign / reassign sheet. All state lives in the DB
   via /items/assignments - components only mirror it and poll.

   Items redesign (Neil green-lit editing Visesh's Items files, 11/02/2026):
   every popup here is a sheet from the right (the shared Modal), states read
   through the one set of words (Awaiting Acceptance -> Active -> Return
   Started -> Closed, StatusLabel), and Cancel / Force Recover / Retire are
   held to confirm (HoldButton). */
import { useState, useEffect, useRef } from 'react';
import { Camera, CheckCircle, XCircle, RotateCcw, User, MapPin, ZoomIn } from 'lucide-react';
import { api } from '../api';
import { emailToName } from '../lib/utils';
import { supabase } from '../lib/supabase';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { usePeopleDirectory } from '../lib/queries';
import { toViewUrl } from '../lib/storageView';
import { Spinner } from './AsyncState';
import { StatusLabel } from './StatusLabel';
import HoldButton, { HOLD_RECORD_MS } from '../ui/HoldButton';
import { Modal, PersonSelect } from '../tasks/components';

const FL = { fontSize: 12.5, fontWeight: 600, color: 'var(--wk-dim, var(--muted))', display: 'block', marginBottom: 6 };
const HINT = { fontSize: 12, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.45 };
const ERR = { fontSize: 12.5, color: 'var(--bad-fg)', margin: '10px 0 0' };

// The one set of words (inventory/model/words.js mirrors these for the module).
export const ASSIGN_STATUS_META = {
  pending_acceptance: { label: 'Awaiting Acceptance', color: '#64748b' },
  active:             { label: 'Active',              color: 'var(--wk-green)' },
  return_initiated:   { label: 'Return Started',      color: 'var(--wk-live)' },
  closed:             { label: 'Closed',              color: '#64748b' },
  declined:           { label: 'Declined',            color: '#64748b' },
  cancelled:          { label: 'Canceled',            color: '#64748b' },
};

const REASON_FLAG = {
  dead:     'Reported Dead',
  lost:     'Reported Lost',
  reassign: 'Reassignment',
};

// Shared across ALL useAssignments() consumers: one poll, one in-flight request,
// many subscribers.
let _asgState = [];
const _asgSubs = new Set();
let _asgTimer = null;
let _asgInFlight = false;
let _asgRefetchQueued = false;   // a refresh was asked for WHILE a fetch was in flight
function _asgFetch() {
  // P1-8: a refresh that lands during the poll's in-flight window is remembered
  // and run once the current fetch resolves, so a just-committed change shows.
  if (_asgInFlight) { _asgRefetchQueued = true; return Promise.resolve(); }
  _asgInFlight = true;
  return api.getAssignments()
    .then(rows => {
      if (JSON.stringify(_asgState) !== JSON.stringify(rows)) {
        _asgState = rows;
        _asgSubs.forEach(fn => fn(_asgState));   // broadcast only on real change
      }
    })
    .catch(() => {})
    .finally(() => {
      _asgInFlight = false;
      if (_asgRefetchQueued) { _asgRefetchQueued = false; _asgFetch(); }
    });
}
export function useAssignments() {
  const [assignments, setAssignments] = useState(_asgState);
  useEffect(() => {
    _asgSubs.add(setAssignments);
    setAssignments(_asgState);
    if (_asgSubs.size === 1) {
      _asgFetch();
      _asgTimer = pollWhileVisible(_asgFetch, 15000);
    } else {
      _asgFetch();
    }
    return () => {
      _asgSubs.delete(setAssignments);
      if (_asgSubs.size === 0 && _asgTimer) { _asgTimer(); _asgTimer = null; }
    };
  }, []);
  return { assignments, refreshAssignments: _asgFetch };
}

async function uploadPhoto(file, prefix) {
  if (!file) return { url: '', name: '' };
  const path = `item-photos/${prefix}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { data, error } = await supabase.storage.from('item-photos').upload(path, file, { contentType: file.type, upsert: false, cacheControl: '31536000' });
  if (error || !data) throw new Error(error?.message || 'Photo upload failed');
  const { data: urlData } = supabase.storage.from('item-photos').getPublicUrl(data.path);
  return { url: toViewUrl(urlData.publicUrl), name: file.name };
}

function PhotoField({ file, setFile, required = true, label = 'Photo' }) {
  const ref = useRef(null);
  const [preview, setPreview] = useState(null);
  function take(f) {
    if (!f) return;
    setFile(f); const r = new FileReader(); r.onload = ev => setPreview(ev.target.result); r.readAsDataURL(f);
  }
  // A screenshot pasted with Ctrl+V lands the same as choosing a file
  function onPaste(e) {
    for (const it of e.clipboardData?.items || []) {
      if (it.type && it.type.startsWith('image/')) {
        const blob = it.getAsFile();
        if (blob) { e.preventDefault(); take(blob.name ? blob : new File([blob], `paste-${Date.now()}.png`, { type: blob.type || 'image/png' })); return; }
      }
    }
  }
  return (
    <div tabIndex={0} onPaste={onPaste} style={{ outline: 'none' }}>
      <span style={FL}>{label}<span style={{ fontWeight: 600, fontSize: 11.5, color: 'var(--muted)', marginLeft: 6 }}>{required ? 'Required' : 'Optional'}</span></span>
      <input ref={ref} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={e => take(e.target.files?.[0])} />
      {preview
        ? <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src={preview} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} />
            <button type="button" className="secondary-btn" style={{ fontSize: 12 }} onClick={() => ref.current?.click()}>Replace</button>
          </div>
        : <button type="button" onClick={() => ref.current?.click()}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 14, borderRadius: 10, border: '1px dashed var(--wk-line, var(--line))', background: 'var(--mist)', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--ink)', fontFamily: 'inherit' }}>
            <Camera size={15} /> Take or Upload Photo
          </button>}
      {!preview && <p style={HINT}>or press Ctrl+V to paste a screenshot</p>}
    </div>
  );
}

// A sheet from the right (the shared Modal): ESC / the scrim ask before a
// filled-in form is thrown away; a sheet mid-save does not close.
function ModalShell({ title, sub, children, onClose, busy = false, isDirty = false, footer, zIndex = 4100 }) {
  return (
    <Modal title={title} onClose={() => { if (!busy) onClose(); }} isDirty={isDirty} footer={footer} placement="sheet" zIndex={zIndex}>
      {sub && <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '0 0 18px', lineHeight: 1.5 }}>{sub}</p>}
      {children}
    </Modal>
  );
}

// Manager: assign (or reassign) an item to a person from the directory
export function AssignItemModal({ item, userEmail = '', locations = [], onClose, onDone, toast, zIndex }) {
  const { data: directory = [] } = usePeopleDirectory();   // shared cache - one fetch across all pickers
  const [tab,  setTab]  = useState('person');   // 'person' | 'location'
  const [pick, setPick] = useState('');
  const [loc,  setLoc]  = useState(item.location || '');
  const [skipAccept, setSkipAccept] = useState(false); // manager option - activate without the assignee accepting
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const chosen = directory.find(d => d.email === pick);
  // A person currently holds it: the person flow is a reassignment.
  const reassign = !!item.assignedToEmail;
  const currentEmail = (item.assignedToEmail || '').toLowerCase();
  const sameAsCurrent = !!chosen && !!currentEmail && chosen.email.toLowerCase() === currentEmail;
  const sameMsg = sameAsCurrent
    ? (chosen.email.toLowerCase() === (userEmail || '').toLowerCase()
        ? 'This item is already assigned to you.'
        : `This item is already assigned to ${item.assignedToName || chosen.name}.`)
    : '';
  const locChanged = loc.trim() !== (item.location || '').trim();
  // Temporary items are checked out, never person-assigned.
  const transient = item.ownershipType !== 'permanent';
  useEffect(() => { if (transient) setTab('location'); }, [transient]);

  function submitPerson() {
    setBusy(true); setError('');
    (reassign ? api.reassignItem(item.id, { assignee_email: chosen.email, assignee_name: chosen.name })
              : api.assignItem(item.id, { assignee_email: chosen.email, assignee_name: chosen.name, skip_acceptance: skipAccept }))
      .then(() => { toast?.(reassign ? `Return requested from ${item.assignedToName} - ${chosen.name} is assigned next.`
                          : skipAccept ? `${item.name} assigned to ${chosen.name} - active now, no acceptance needed.`
                          : `${item.name} assigned to ${chosen.name} - waiting for them to accept.`); onDone?.(); onClose(); })
      .catch(err => { setError(err?.message || 'Could not assign.'); setBusy(false); });
  }
  function submitLocation() {
    setBusy(true); setError('');
    api.assignItemToLocation(item.id, loc.trim())
      .then(() => { toast?.(loc.trim() ? `${item.name} is now at ${loc.trim()}.` : `Cleared ${item.name}'s location.`); onDone?.(); onClose(); })
      .catch(err => { setError(err?.message || 'Could not set the location.'); setBusy(false); });
  }

  const dirty = !!pick || locChanged || skipAccept;
  const seg = (k, l) => (
    <button key={k} type="button" onClick={() => { setTab(k); setError(''); }} aria-pressed={tab === k}
      style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', background: tab === k ? 'var(--card)' : 'transparent', boxShadow: tab === k ? '0 1px 3px rgba(0,0,0,.08)' : 'none', color: tab === k ? 'var(--ink)' : 'var(--muted)', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>{l}</button>
  );

  return (
    <ModalShell onClose={onClose} busy={busy} isDirty={dirty} zIndex={zIndex}
      title={reassign ? `Reassign ${item.name}` : `Assign ${item.name}`}
      sub="Give it to a person (they accept it) or set where it lives - a location and a person can both apply."
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        {tab === 'person' ? (
          <button className="primary-btn" disabled={!chosen || busy || sameAsCurrent || transient} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={submitPerson}>
            {busy ? <Spinner size={14} /> : <User size={14} />} {reassign ? 'Start Reassignment' : 'Assign'}
          </button>
        ) : (
          <button className="primary-btn" disabled={busy || !locChanged} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={submitLocation}>
            {busy ? <Spinner size={14} /> : <MapPin size={14} />} Set Location
          </button>
        )}
      </>}>
      <div style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 10, background: 'var(--mist)', marginBottom: 18 }}>
        {seg('person', 'To a Person')}{seg('location', 'To a Location')}
      </div>

      {tab === 'person' ? (
        transient ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>
            This is a temporary item - people borrow it, it is not assigned for good.
            To give it to one person for good, change its ownership to Permanent first (Batch Edit, Ownership).
          </p>
        ) : (
        <>
          <span style={FL}>Assign To</span>
          <PersonSelect value={pick || null} onChange={v => setPick(v || '')} allowNone={false}
            placeholder="Select a person" ariaLabel="Assign To"
            people={directory.filter(d => d.email).map(d => ({ email: d.email, name: d.name ? `${d.name} - ${d.email}` : d.email, external: !!d.external }))}
            style={{ borderRadius: 10, padding: '9px 13px', fontSize: 13.5, fontWeight: 400 }} />
          {reassign && <p style={HINT} title={item.assignedToEmail || ''}>With {item.assignedToName || emailToName(item.assignedToEmail)} now - they return it with a photo, then the new person accepts.</p>}
          {!reassign && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 14, cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox" checked={skipAccept} onChange={e => setSkipAccept(e.target.checked)}
                style={{ cursor: 'pointer', accentColor: 'var(--wk-brand)', marginTop: 2 }} />
              <span style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.45 }}>
                <strong style={{ color: 'var(--ink)' }}>Skip acceptance</strong> - the assignment is active right away. They are still told, just not asked to accept.
              </span>
            </label>
          )}
        </>
        )
      ) : (
        <>
          <label style={FL} htmlFor="assign-loc">Location</label>
          <input id="assign-loc" className="form-input" style={{ width: '100%' }} list="assign-loc-list" value={loc} autoFocus
            onChange={e => setLoc(e.target.value)} placeholder="e.g. Austin Yard - leave blank to clear" />
          <datalist id="assign-loc-list">{locations.map(l => <option key={l} value={l} />)}</datalist>
          <p style={HINT}>
            Where the item physically lives. {item.assignedToEmail ? `It stays assigned to ${item.assignedToName || 'its holder'}.` : 'It stays unassigned until you assign a person.'}
          </p>
        </>
      )}

      {(sameMsg || error) && <p style={sameMsg ? { ...ERR, color: 'var(--muted)' } : ERR}>{sameMsg || error}</p>}
    </ModalShell>
  );
}

// Assignee: decline a pending assignment, with an optional reason.
export function DeclineAssignmentModal({ a, onClose, onDone, toast, zIndex }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function go() {
    setBusy(true); setError('');
    api.declineAssignment(a.id, { note: note.trim() })
      .then(() => { toast?.('Assignment declined.'); onDone?.(); })
      .catch(e => { setError(e?.message || 'Could not decline.'); setBusy(false); });
  }
  return (
    <ModalShell onClose={onClose} busy={busy} isDirty={!!note.trim()} title={`Decline ${a.itemName}`} zIndex={zIndex}
      sub="Let the manager know why, so they can assign it to someone else. The reason is optional."
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary-btn" disabled={busy} onClick={go} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'var(--wk-red)' }}>
          {busy ? <Spinner size={14} /> : <XCircle size={14} />} Decline
        </button>
      </>}>
      <label style={FL} htmlFor="decline-note">Reason <span style={{ fontWeight: 500, color: 'var(--muted)' }}>(optional)</span></label>
      <textarea id="decline-note" rows={3} className="form-input" style={{ width: '100%', resize: 'vertical', fontSize: 13.5 }} value={note}
        onChange={e => setNote(e.target.value)} placeholder="e.g. I already have one" autoFocus />
      {error && <p style={ERR}>{error}</p>}
    </ModalShell>
  );
}

export function AcceptAssignmentModal({ a, onClose, onDone, toast, zIndex }) {
  const [file, setFile] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go() {
    setBusy(true); setError('');
    try {
      const { url, name } = file ? await uploadPhoto(file, `accept-${a.id}`) : { url: '', name: '' };
      await api.acceptAssignment(a.id, { photo_url: url, photo_name: name, note: note.trim() });
      toast?.(`${a.itemName} is now assigned to you.`); onDone?.();
    } catch (e) { setError(e?.message || 'Could not accept.'); setBusy(false); }
  }
  return (
    <ModalShell onClose={onClose} busy={busy} isDirty={!!(file || note.trim())} title={`Accept ${a.itemName}`} zIndex={zIndex}
      sub="One click and it is yours. A photo is optional for permanent items - add one for a condition record."
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary-btn" disabled={busy} onClick={go} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {busy ? <Spinner size={14} /> : <CheckCircle size={14} />} Accept Assignment
        </button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <PhotoField file={file} setFile={setFile} required={false} />
        <div>
          <label style={FL} htmlFor="accept-note">Condition Notes <span style={{ fontWeight: 500, color: 'var(--muted)' }}>(optional - note any existing damage)</span></label>
          <textarea id="accept-note" rows={3} className="form-input" style={{ width: '100%', resize: 'vertical', fontSize: 13.5 }} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Small dent on the lid" />
        </div>
      </div>
      {error && <p style={ERR}>{error}</p>}
    </ModalShell>
  );
}

const RETURN_COPY = {
  normal:   { title: 'Return', sub: 'Returning this item (leaving the company, or you no longer need it). A supervisor checks and accepts it.' },
  dead:     { title: 'Report Dead', sub: 'The item no longer works. Photograph it as evidence - a supervisor accepts the return and decides what happens to it.' },
  lost:     { title: 'Report Lost', sub: 'The item is lost or stolen. No photo needed - a supervisor confirms the write-off.' },
  reassign: { title: 'Return for Reassignment', sub: 'Photograph the item as you hand it back - the new person takes over once a supervisor accepts.' },
};

export function AssignmentReturnModal({ a, reason, onClose, onDone, toast, zIndex }) {
  const c = RETURN_COPY[reason] || RETURN_COPY.normal;
  const needPhoto = reason !== 'lost';
  const [file, setFile] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = (!needPhoto || !!file) && (reason === 'normal' || reason === 'reassign' || !!note.trim());
  async function go() {
    setBusy(true); setError('');
    try {
      const photo = needPhoto ? await uploadPhoto(file, `return-${a.id}`) : { url: '', name: '' };
      await api.initAssignmentReturn(a.id, { reason: reason === 'reassign' ? 'normal' : reason, photo_url: photo.url, photo_name: photo.name, note: note.trim() });
      toast?.('Return sent - a supervisor checks and accepts it.'); onDone?.();
    } catch (e) { setError(e?.message || 'Could not send the return.'); setBusy(false); }
  }
  return (
    <ModalShell onClose={onClose} busy={busy} isDirty={!!(file || note.trim())} title={`${c.title}: ${a.itemName}`} sub={c.sub} zIndex={zIndex}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary-btn" disabled={busy || !ready} onClick={go} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {busy ? <Spinner size={14} /> : <RotateCcw size={14} />} {reason === 'lost' ? 'Report Lost' : 'Send Return'}
        </button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {needPhoto && <PhotoField file={file} setFile={setFile} label="Return Photo" />}
        <div>
          <label style={FL} htmlFor="asg-return-note">Notes {reason === 'dead' || reason === 'lost' ? null : <span style={{ fontWeight: 500, color: 'var(--muted)' }}>(optional)</span>}</label>
          <textarea id="asg-return-note" rows={3} className="form-input" style={{ width: '100%', resize: 'vertical', fontSize: 13.5 }} value={note} onChange={e => setNote(e.target.value)}
            placeholder={reason === 'dead' ? 'What happened to it?' : reason === 'lost' ? 'When and where was it last seen?' : 'Anything the supervisor should know'} />
        </div>
      </div>
      {error && <p style={ERR}>{error}</p>}
    </ModalShell>
  );
}

// Manager: accept a return - back to stock, or retire it (held to confirm).
export function AcceptReturnModal({ a, onClose, onDone, toast, zIndex }) {
  const dead = ['dead', 'lost'].includes(a.returnReason);
  const [dispo, setDispo] = useState(dead ? 'retired' : 'stock');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A return in a reassign chain promises the item to the next person; any
  // choice other than "back to stock" drops that reassignment - say so.
  const nextName = a.returnReason === 'reassign' ? (a.nextAssigneeName || emailToName(a.nextAssigneeEmail)) : '';
  const promisedNext = !!(a.returnReason === 'reassign' && (a.nextAssigneeName || a.nextAssigneeEmail));
  const run = () => api.acceptAssignmentReturn(a.id, { disposition: dispo }).then(() => { toast?.('Return accepted.'); });
  return (
    <ModalShell onClose={onClose} busy={busy} title={`Accept Return: ${a.itemName}`} zIndex={zIndex}
      sub={`From ${a.assigneeName || emailToName(a.assigneeEmail)}. ${promisedNext ? `Accepting assigns it to ${nextName} next.` : 'Choose what happens to the item.'}`}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        {dispo === 'retired' ? (
          <HoldButton label="Hold to Retire" doneLabel="Retired" holdMs={HOLD_RECORD_MS}
            fallbackMessage={`Retire ${a.itemName}? It leaves service.`}
            onConfirm={() => run()} onDone={() => onDone?.()} />
        ) : (
          <button className="primary-btn" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
            onClick={() => { setBusy(true); setError(''); run().then(() => onDone?.()).catch(e => { setError(e?.message || 'Could not accept the return.'); setBusy(false); }); }}>
            {busy ? <Spinner size={14} /> : <CheckCircle size={14} />} Back to Stock
          </button>
        )}
      </>}>
      {(a.returnPhotoUrl || a.acceptPhotoUrl) && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 18 }}>
          {[['At Acceptance', a.acceptPhotoUrl], ['At Return', a.returnPhotoUrl]].filter(([, u]) => u).map(([l, u]) => (
            <figure key={l} style={{ margin: 0 }}>
              <span style={FL}>{l}</span>
              <img src={u} alt={l} style={{ width: 150, height: 112, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} />
            </figure>
          ))}
        </div>
      )}
      <span style={FL}>What Happens to It</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[['stock', 'Back to stock - ready to borrow or assign again'], ['retired', 'Retire - dead, lost or written off']].map(([v, l]) => (
          <label key={v} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, cursor: 'pointer', border: `1px solid ${dispo === v ? 'var(--wk-brand)' : 'var(--wk-line, var(--line))'}`, background: dispo === v ? 'var(--wk-brand-tint)' : 'var(--card)', borderRadius: 10, padding: '10px 12px' }}>
            <input type="radio" checked={dispo === v} onChange={() => setDispo(v)} style={{ accentColor: 'var(--wk-brand)' }} />{l}
          </label>
        ))}
      </div>
      {promisedNext && dispo !== 'stock' && (
        <p style={{ ...HINT, color: 'var(--ink)' }}>This item is promised to {nextName}. Retiring it cancels that reassignment.</p>
      )}
      {error && <p style={ERR}>{error}</p>}
    </ModalShell>
  );
}

// Manager queue (Requests > Assignments): live assignments, returns to accept,
// awaiting acceptance, history. Cancel and Force Recover are held on the row.
export function AssignmentsQueue({ assignments, userEmail = '', refresh, toast, focus }) {
  const [chip, setChip] = useState(focus?.chip || 'live');
  useEffect(() => { if (focus?.chip) setChip(focus.chip); }, [focus]);
  const [accepting, setAccepting] = useState(null);
  const [selfAccept, setSelfAccept] = useState(null); // accept an item assigned to ME, from the queue
  const [preview, setPreview] = useState(null);
  const [search, setSearch] = useState('');
  const live = assignments.filter(a => ['pending_acceptance', 'active', 'return_initiated'].includes(a.status));
  const q = search.trim().toLowerCase();
  const matchesSearch = a => !q ||
    (a.itemName || '').toLowerCase().includes(q) ||
    (a.assigneeName || '').toLowerCase().includes(q) ||
    (a.assigneeEmail || '').toLowerCase().includes(q) ||
    (a.nextAssigneeName || '').toLowerCase().includes(q) ||
    (a.nextAssigneeEmail || '').toLowerCase().includes(q);
  // History can be long: filter by the search FIRST, then cap.
  const base = chip === 'live' ? live
    : chip === 'returns' ? assignments.filter(a => a.status === 'return_initiated')
    : chip === 'pending' ? assignments.filter(a => a.status === 'pending_acceptance')
    : assignments.filter(a => ['closed', 'declined', 'cancelled'].includes(a.status));
  const filtered = base.filter(matchesSearch);
  const shown = chip === 'history' ? filtered.slice(0, 50) : filtered;
  const chips = [['live', 'Live', live.length], ['returns', 'Returns to Accept', assignments.filter(a => a.status === 'return_initiated').length], ['pending', 'Awaiting Acceptance', null], ['history', 'History', null]];
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <div className="scroll-tabs" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {chips.map(([k, l, n]) => (
            <button key={k} onClick={() => setChip(k)} aria-pressed={chip === k}
              style={{ padding: '6px 12px', borderRadius: 8, border: `1px solid ${chip === k ? 'var(--wk-brand)' : 'var(--wk-line, var(--line))'}`, background: chip === k ? 'var(--wk-brand-tint)' : 'var(--card)', color: chip === k ? 'var(--wk-brand)' : 'var(--ink)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              {l}{n ? <span style={{ marginLeft: 6, color: 'var(--muted)', fontWeight: 600 }}>{n}</span> : null}
            </button>
          ))}
        </div>
        <div className="search-bar" style={{ flex: 1, minWidth: 200, marginLeft: 'auto' }}>
          <User size={13} style={{ flexShrink: 0 }} />
          <input placeholder="Search by person or item…" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search assignments" />
          {search && (
            <button onClick={() => setSearch('')} aria-label="Clear search" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}>
              <XCircle size={13} />
            </button>
          )}
        </div>
      </div>
      {shown.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--muted)' }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)', marginBottom: 4 }}>Nothing here</div>
          <div style={{ fontSize: 13 }}>No assignments in this list.</div>
        </div>
      ) : (
        <div style={{ border: '1px solid var(--wk-line2, var(--line))', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
          {shown.map((a, i) => {
            const sm = ASSIGN_STATUS_META[a.status] || ASSIGN_STATUS_META.closed;
            const flag = a.status === 'return_initiated' ? REASON_FLAG[a.returnReason] : '';
            const mine = (a.assigneeEmail || '').toLowerCase() === (userEmail || '').toLowerCase();
            const liveRow = ['pending_acceptance', 'active', 'return_initiated'].includes(a.status);
            return (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '11px 16px', borderTop: i ? '1px solid var(--wk-line2, var(--line))' : 'none' }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{a.itemName}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
                    <span title={a.assigneeEmail || ''}>{a.assigneeName || emailToName(a.assigneeEmail)}</span>
                    {a.status === 'return_initiated' && a.returnReason === 'reassign' && (a.nextAssigneeName || a.nextAssigneeEmail) && <> to <strong title={a.nextAssigneeEmail || ''}>{a.nextAssigneeName || emailToName(a.nextAssigneeEmail)}</strong></>}
                    {flag && <> · {flag}</>}
                    {a.returnNote && <span style={{ fontStyle: 'italic' }}> · "{a.returnNote}"</span>}
                  </div>
                </div>
                <StatusLabel label={sm.label} color={sm.color} size="sm" />
                {(a.returnPhotoUrl || a.acceptPhotoUrl) && (
                  <button onClick={() => setPreview(a.returnPhotoUrl || a.acceptPhotoUrl)} aria-label="View photo" style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 7, padding: '4px 8px', cursor: 'zoom-in', color: 'var(--muted)', display: 'flex' }}><ZoomIn size={12} /></button>
                )}
                {a.status === 'return_initiated' && (a.returnPhotoUrl || a.returnReason === 'lost') && (
                  <button className="primary-btn" style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }} onClick={() => setAccepting(a)}>
                    <CheckCircle size={12} /> Accept Return
                  </button>
                )}
                {a.status === 'pending_acceptance' && mine && (
                  <button className="primary-btn" style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }} onClick={() => setSelfAccept(a)}>
                    <CheckCircle size={12} /> Accept
                  </button>
                )}
                {liveRow && (
                  <HoldButton size="sm" holdMs={HOLD_RECORD_MS} icon={XCircle}
                    label={a.status === 'pending_acceptance' ? 'Cancel' : 'Force Recover'}
                    doneLabel={a.status === 'pending_acceptance' ? 'Canceled' : 'Recovered'}
                    ariaLabel={`${a.status === 'pending_acceptance' ? 'Cancel the assignment of' : 'Force recover'} ${a.itemName}`}
                    fallbackMessage={a.status === 'pending_acceptance'
                      ? `Cancel the assignment of ${a.itemName}? It goes back in stock.`
                      : `Take ${a.itemName} back from ${a.assigneeName || emailToName(a.assigneeEmail)} without their confirmation?`}
                    onConfirm={() => api.cancelAssignment(a.id).then(() => { toast?.(a.status === 'pending_acceptance' ? 'Assignment canceled.' : `${a.itemName} recovered - back in stock.`); })}
                    onDone={() => refresh?.()} />
                )}
              </div>
            );
          })}
        </div>
      )}
      {accepting && (
        <AcceptReturnModal a={accepting} onClose={() => setAccepting(null)} toast={toast}
          onDone={() => { refresh?.(); setAccepting(null); }} />
      )}
      {selfAccept && (
        <AcceptAssignmentModal a={selfAccept} onClose={() => setSelfAccept(null)} onDone={() => { refresh?.(); setSelfAccept(null); }} toast={toast} />
      )}
      {preview && (
        <div role="dialog" aria-modal="true" aria-label="Photo" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 4600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }} onClick={() => setPreview(null)}>
          <img src={preview} alt="" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 10 }} />
        </div>
      )}
    </div>
  );
}
