// The Job's punch list (and a Work Order's steps) - Neil, 11/03/2026, plan
// phases 2 and 3. The rows ARE tasks in the job's task project (the "Punch"
// section); the server writes them through the Tasks module's own paths.
// In the field (phase 3):
//   * each item has a spot - where on the site, in words;
//   * marking a punch item Done needs a photo of the finished work (the
//     camera opens straight away on a phone);
//   * Verified is one tap by a job manager, with Undo;
//   * "Mine" narrows the list to the person's own items;
//   * it all works with no signal: the list opens from the phone
//     (constructionOffline.loadSchedule) and every change goes into the
//     outbox, shown beside the row (SyncState) until it is sent.
import { useMemo, useRef, useState } from 'react';
import { Plus, CheckSquare, ExternalLink, Camera, MapPin } from 'lucide-react';
import { api } from '../../api';
import { useRole } from '../../contexts/RoleContext';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import SyncState from '../../components/offline/SyncState';
import { DateField } from '../../tasks/components';
import { dialog } from '../../ui/dialog';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { CARD, personName } from '../ui';
import Empty from '../Empty';
import { PUNCH_STATE, assigneesOf, clientId, punchState, splitSchedule, useLoad } from '../lib/job';
import { addPunch, loadSchedule, markPunchDone, markPunchVerified } from '../constructionOffline';

export function SetUp({ view, project, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div style={CARD}>
      {error && <ErrorBanner message={error} onRetry={() => setError('')} />}
      <Empty icon={CheckSquare} title="No schedule yet"
        hint="This job has no task project yet. Setting it up adds the job type's sections, the Punch list and the closeout checklist."
        action={view?.canStamp ? (
          <button className="primary-btn" disabled={busy} onClick={async () => {
            setBusy(true); setError('');
            try { await api.makeJobTaskProject(project.id); onDone(); } catch (e) { setError(e.message || 'Could not set it up.'); setBusy(false); }
          }}>{busy ? 'Setting Up…' : 'Set Up Schedule'}</button>
        ) : null} />
    </div>
  );
}

const small = { padding: '6px 12px', fontSize: '0.8rem', minHeight: 36 };

function Row({ t, view, project, onChanged, canVerify, canLog, names, showState = true, local, setLocal, isPunch, subs = [] }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const camRef = useRef(null);
  const meta = (view.punchMeta || {})[t.id] || {};
  const over = local[t.id] || {};
  const state = over.state || punchState(t, view.verifiedStatusId);
  const label = PUNCH_STATE[state];
  const photo = over.photoUrl || meta.donePhotoUrl || '';
  const remember = (patch) => setLocal((m) => ({ ...m, [t.id]: { ...(m[t.id] || {}), ...patch } }));

  const run = async (key, fn, optimistic) => {
    setBusy(key); setError('');
    try {
      const out = await fn();
      if (out?.queued) remember({ ...optimistic, entryId: out.queued.id });
      else { remember({ state: undefined, entryId: '' }); onChanged(); }
      return out;
    } catch (e) { setError(e.message || 'Could not save that.'); return null; } finally { setBusy(''); }
  };
  const done = (file) => {
    const preview = file && typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(file) : '';
    return run('done', () => markPunchDone(project.id, t.id, true, file), { state: 'done', photoUrl: preview });
  };
  const askDone = () => {
    if (!isPunch || photo) { done(null); return; }
    camRef.current?.click();
  };
  const verify = async () => {
    const out = await run('verify', () => markPunchVerified(project.id, t.id, true), { state: 'verified' });
    if (out) dialog.undo(`Verified: ${t.title}`, () => run('verify', () => markPunchVerified(project.id, t.id, false), { state: 'done' }));
  };
  const who = (t.assigneeIds || []).map((e) => (t.assigneeNames || {})[e] || personName(e, names)).join(', ');
  // Round Three item 4 (11/11/2026): the sub whose item it is - their punch list link shows it.
  const subId = over.subVendorId ?? meta.subVendorId ?? '';
  const subName = subId ? ((subs.find((x) => x.vendorId === subId) || {}).name || subId) : '';
  const giveTo = async (vendorId) => {
    setBusy('sub'); setError('');
    try { await api.setPunchSub(t.id, vendorId); remember({ subVendorId: vendorId }); onChanged(); }
    catch (e) { setError(e.message || 'Could not give it to that sub.'); }
    setBusy('');
  };
  return (
    <div data-punch-row={t.id} style={{
      display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: '12px 14px',
      border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-primary)',
    }}>
      {photo && (
        <a href={photo} target="_blank" rel="noreferrer" title="The finished work" style={{ flexShrink: 0 }}>
          <img src={photo} alt={`Finished: ${t.title}`} style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 6, display: 'block' }} />
        </a>
      )}
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '0.92rem', textDecoration: state !== 'open' ? 'line-through' : 'none',
          color: state !== 'open' ? 'var(--text-secondary)' : 'var(--text-primary)', overflowWrap: 'anywhere' }}>{t.title}</div>
        {(meta.location || over.location) && (
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
            <MapPin size={12} aria-hidden="true" />{over.location || meta.location}
          </div>
        )}
        <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
          {[subName ? `Sub: ${subName}` : (who || 'No one assigned'), t.dueOn ? `Due ${formatDate(t.dueOn, t.dueOn)}` : '',
            state === 'verified' && meta.verifiedByName ? `Verified by ${meta.verifiedByName}${meta.verifiedAt ? ` ${formatDateTime(meta.verifiedAt, '')}` : ''}` : ''].filter(Boolean).join(' · ')}
        </div>
        {error && <div role="alert" style={{ fontSize: '0.78rem', color: 'hsl(var(--color-red))', marginTop: 4 }}>{error}</div>}
      </div>
      {over.entryId && <SyncState id={over.entryId} />}
      {showState && <StatusLabel size="sm" label={label.label} color={label.color} />}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
        {isPunch && canVerify && subs.length > 0 && state === 'open' && (
          <select className="form-input" aria-label={`Sub for ${t.title}`} value={subId} disabled={!!busy}
            onChange={(e) => giveTo(e.target.value)} style={{ ...small, width: 'auto', maxWidth: 200 }}>
            <option value="">Our Crew</option>
            {subs.map((x) => <option key={x.vendorId} value={x.vendorId}>{x.name}</option>)}
          </select>
        )}
        {canLog && state === 'open' && (
          <button className="secondary-btn" disabled={!!busy} style={small} onClick={askDone}>
            {isPunch && !photo ? <><Camera size={14} />Mark Done</> : 'Mark Done'}
          </button>
        )}
        {canLog && state === 'done' && (
          <button className="secondary-btn" disabled={!!busy} style={small}
            onClick={() => run('undone', () => markPunchDone(project.id, t.id, false, null), { state: 'open' })}>Not Done</button>
        )}
        {canVerify && state === 'done' && (
          <button className="primary-btn" disabled={!!busy} style={small} onClick={verify}>Verify</button>
        )}
        {canVerify && state === 'verified' && (
          <button className="secondary-btn" disabled={!!busy} style={small}
            onClick={() => run('verify', () => markPunchVerified(project.id, t.id, false), { state: 'done' })}>Unverify</button>
        )}
      </div>
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden data-done-photo={t.id}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) done(f); }} />
    </div>
  );
}

function AddItem({ project, people, onAdded }) {
  const [title, setTitle] = useState('');
  const [spot, setSpot] = useState('');
  const [who, setWho] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = async (e) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true); setError('');
    const body = { id: clientId('punch'), title: title.trim(), assignee_emails: who ? [who] : [], due_on: due, location_text: spot.trim() };
    try {
      const out = await addPunch(project.id, body);
      setTitle(''); setDue(''); setSpot('');
      onAdded(out?.queued ? { ...body, entryId: out.queued.id } : null);
    } catch (err) { setError(err.message || 'Could not add that.'); }
    setBusy(false);
  };
  return (
    <form onSubmit={add} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
      <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="What needs fixing"
        placeholder="What needs fixing" style={{ flex: '2 1 220px', minWidth: 0 }} />
      <input className="form-input" value={spot} onChange={(e) => setSpot(e.target.value)} aria-label="Where on the site"
        placeholder="Where (e.g. Unit 4 hallway)" style={{ flex: '1 1 180px', minWidth: 0 }} />
      <select className="form-input" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Assign to" style={{ flex: '1 1 160px' }}>
        <option value="">Assign to</option>
        {people.map((p) => <option key={p.email} value={p.email}>{p.name}</option>)}
      </select>
      <DateField value={due} onChange={(v) => setDue(v || '')} placeholder="Due Date" title="Due Date" />
      <button type="submit" className="primary-btn" disabled={!title.trim() || busy}><Plus size={14} />{busy ? 'Adding…' : 'Add Item'}</button>
      {error && <div role="alert" style={{ width: '100%', fontSize: '0.8rem', color: 'hsl(var(--color-red))' }}>{error}</div>}
    </form>
  );
}

function SavedNote({ at }) {
  if (!at) return null;
  return <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 10 }}>Opened from this phone (saved {formatDateTime(at, '')}).</div>;
}

export default function PunchTab({ project }) {
  const { myEmail } = useRole();
  const me = String(myEmail || '').toLowerCase();
  const [savedAt, setSavedAt] = useState('');
  const { data: view, error, reload } = useLoad(() => { setSavedAt(''); return loadSchedule(project.id, { onCache: setSavedAt }); }, project.id);
  const [who, setWho] = useState('');
  const [local, setLocal] = useState({});
  const [pending, setPending] = useState([]);   // items added with no signal, until the list has them
  // The job's subs (Round Three item 4): a punch item may be given to one. Read quietly - offline or
  // unreadable, the list simply offers no sub.
  const { data: subsData } = useLoad(() => api.getJobSubs(project.id).catch(() => ({ subs: [] })), project.id);
  const isWorkOrder = project.jobType === 'work_order';
  const parts = useMemo(() => splitSchedule(view), [view]);
  const filterBy = (list) => (who ? list.filter((t) => (t.assigneeIds || []).includes(who)) : list);
  const fromServer = new Set((parts.punch || []).map((t) => t.id));
  const waiting = pending.filter((p) => !fromServer.has(p.id)).map((p) => ({
    id: p.id, title: p.title, assigneeIds: p.assignee_emails, dueOn: p.due_on, completed: false, status: '', entryId: p.entryId, location: p.location_text,
  }));
  const punch = filterBy([...parts.punch, ...waiting]);
  const steps = filterBy(parts.steps);
  const assignees = assigneesOf([...parts.punch, ...(isWorkOrder ? parts.steps : [])]);
  const jobPeople = useMemo(() => {
    const ems = [...new Set([...(project.workerEmails || []), ...(project.managerEmails || [])])];
    return ems.map((e) => ({ email: e, name: personName(e, project.names) })).sort((a, b) => a.name.localeCompare(b.name));
  }, [project]);

  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!view) return <SkeletonBlocks count={4} height={64} borderRadius={8} />;
  if (!view.taskProject) return <SetUp view={view} project={project} onDone={reload} />;
  const canLog = !!view.canLog;
  const canVerify = !!view.canEdit;
  const order = { open: 0, done: 1, verified: 2 };
  const stateOf = (t) => (local[t.id]?.state || punchState(t, view.verifiedStatusId));
  const sorted = [...punch].sort((a, b) => (order[stateOf(a)] - order[stateOf(b)])
    || String(a.dueOn || '9999').localeCompare(String(b.dueOn || '9999')));
  const c = view.punch || {};
  const chip = (on) => ({
    minHeight: 36, padding: '6px 14px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.82rem', fontWeight: 600,
    border: `1px solid ${on ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, background: on ? 'color-mix(in srgb, var(--wk-brand, #2b45e1) 10%, transparent)' : 'var(--bg-card)',
    color: on ? 'var(--wk-brand, #2b45e1)' : 'var(--text-primary)',
  });
  const rowProps = { view, project, onChanged: reload, names: project.names, local, setLocal, subs: subsData?.subs || [] };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <SavedNote at={savedAt} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {['open', 'done', 'verified'].map((k) => (
            <StatusLabel key={k} label={`${c[k] || 0} ${PUNCH_STATE[k].label}`} color={PUNCH_STATE[k].color} />
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {me && (
          <div role="group" aria-label="Show" style={{ display: 'flex', gap: 6 }}>
            <button type="button" aria-pressed={!who} style={chip(!who)} onClick={() => setWho('')}>Everyone</button>
            <button type="button" aria-pressed={who === me} style={chip(who === me)} onClick={() => setWho(me)}>Mine</button>
          </div>
        )}
        {assignees.filter((a) => a.email !== me).length > 0 && (
          <select className="form-input" aria-label="Show one person" value={who && who !== me ? who : ''} onChange={(e) => setWho(e.target.value)} style={{ width: 170 }}>
            <option value="">Someone else</option>
            {assignees.filter((a) => a.email !== me).map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
          </select>
        )}
        <a href={`/tasks/projects?project=${encodeURIComponent(view.taskProject.id)}`} className="secondary-btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: '0.82rem', textDecoration: 'none' }}>
          Open in Tasks <ExternalLink size={12} />
        </a>
      </div>

      {isWorkOrder && (
        <div style={CARD}>
          <h3 style={{ fontSize: '1.05rem', marginBottom: 4 }}>Work Steps</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 14px' }}>The steps from the Work Order template - tick each one off as it is done.</p>
          {steps.length === 0 ? <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>No steps{who ? ' for this person' : ''}.</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {steps.map((t) => <Row key={t.id} t={t} {...rowProps} canLog={canLog} canVerify={false} showState={false} isPunch={false} />)}
            </div>
          )}
        </div>
      )}

      <div style={CARD}>
        <h3 style={{ fontSize: '1.05rem', marginBottom: 4 }}>Punch List</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 14px' }}>
          Each item is a task on the job's schedule. The crew marks it Done with a photo of the finished work; a job manager checks it and marks it Verified.
        </p>
        {canLog && <AddItem project={project} people={jobPeople} onAdded={(p) => { if (p) setPending((x) => [...x, p]); else reload(); }} />}
        {sorted.length === 0 ? (
          <Empty icon={CheckSquare} title={who ? 'Nothing for this person' : 'No punch items yet'}
            hint={canLog ? 'Add each item found on the walk-through - what needs fixing and where.' : 'Items appear here as the walk-through finds them.'} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sorted.map((t) => (t.entryId ? (
              <div key={t.id} data-punch-row={t.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 14px', border: '1px dashed var(--border-color)', borderRadius: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.92rem' }}>{t.title}</div>
                  {t.location && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t.location}</div>}
                </div>
                <SyncState id={t.entryId} />
              </div>
            ) : <Row key={t.id} t={t} {...rowProps} canLog={canLog} canVerify={canVerify} isPunch />))}
          </div>
        )}
      </div>
    </div>
  );
}
