// The Job's punch list (and a Work Order's steps) - Neil, 11/03/2026, plan
// phase 2. The rows ARE tasks in the job's task project (the "Punch"
// section); the server writes them through the Tasks module's own paths.
// Two steps: the crew marks an item Done, a job reviewer marks it Verified.
// Each person can narrow the list to their own items. Field writes carry an
// id made on the phone (lib/job.js clientId) so the offline outbox can resend
// one safely.
import { useMemo, useState } from 'react';
import { Plus, CheckSquare, ExternalLink } from 'lucide-react';
import { api } from '../../api';
import { useRole } from '../../contexts/RoleContext';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import { DateField } from '../../tasks/components';
import { formatDate } from '../../lib/datetime';
import { CARD, personName } from '../ui';
import Empty from '../Empty';
import { PUNCH_STATE, assigneesOf, clientId, punchState, splitSchedule, useLoad } from '../lib/job';

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

function Row({ t, view, onChanged, canVerify, canLog, names, showState = true }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const state = punchState(t, view.verifiedStatusId);
  const meta = PUNCH_STATE[state];
  const act = (key, fn) => async () => {
    setBusy(key); setError('');
    try { await fn(); onChanged(); } catch (e) { setError(e.message || 'Could not save that.'); }
    setBusy('');
  };
  const who = (t.assigneeIds || []).map((e) => (t.assigneeNames || {})[e] || personName(e, names)).join(', ');
  return (
    <div data-punch-row={t.id} style={{
      display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: '12px 14px',
      border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-primary)',
    }}>
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '0.92rem', textDecoration: state !== 'open' ? 'line-through' : 'none',
          color: state !== 'open' ? 'var(--text-secondary)' : 'var(--text-primary)', overflowWrap: 'anywhere' }}>{t.title}</div>
        <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
          {[who || 'No one assigned', t.dueOn ? `Due ${formatDate(t.dueOn, t.dueOn)}` : ''].filter(Boolean).join(' · ')}
        </div>
        {error && <div role="alert" style={{ fontSize: '0.78rem', color: 'hsl(var(--color-red))', marginTop: 4 }}>{error}</div>}
      </div>
      {showState && <StatusLabel size="sm" label={meta.label} color={meta.color} />}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {canLog && state !== 'verified' && (
          <button className="secondary-btn" disabled={!!busy} style={{ padding: '6px 12px', fontSize: '0.8rem' }}
            onClick={act('done', () => api.setPunchDone(t.id, state === 'open'))}>
            {state === 'open' ? 'Mark Done' : 'Not Done'}
          </button>
        )}
        {canVerify && state !== 'open' && (
          <button className={state === 'done' ? 'primary-btn' : 'secondary-btn'} disabled={!!busy}
            style={{ padding: '6px 12px', fontSize: '0.8rem' }}
            onClick={act('verify', () => api.setPunchVerified(t.id, state === 'done'))}>
            {state === 'done' ? 'Verify' : 'Unverify'}
          </button>
        )}
      </div>
    </div>
  );
}

function AddItem({ project, people, onAdded }) {
  const [title, setTitle] = useState('');
  const [who, setWho] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = async (e) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true); setError('');
    try {
      await api.addPunchItem(project.id, { id: clientId('punch'), title: title.trim(), assignee_emails: who ? [who] : [], due_on: due });
      setTitle(''); setDue('');
      onAdded();
    } catch (err) { setError(err.message || 'Could not add that.'); }
    setBusy(false);
  };
  return (
    <form onSubmit={add} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
      <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="What needs fixing"
        placeholder="What needs fixing, and where" style={{ flex: '2 1 240px', minWidth: 0 }} />
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

export default function PunchTab({ project }) {
  const { myEmail } = useRole();
  const me = String(myEmail || '').toLowerCase();
  const { data: view, error, reload } = useLoad(() => api.getJobSchedule(project.id), project.id);
  const [who, setWho] = useState('');
  const isWorkOrder = project.jobType === 'work_order';
  const parts = useMemo(() => splitSchedule(view), [view]);
  const filterBy = (list) => (who ? list.filter((t) => (t.assigneeIds || []).includes(who)) : list);
  const punch = filterBy(parts.punch);
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
  const sorted = [...punch].sort((a, b) => (order[punchState(a, view.verifiedStatusId)] - order[punchState(b, view.verifiedStatusId)])
    || String(a.dueOn || '9999').localeCompare(String(b.dueOn || '9999')));
  const c = view.punch || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {['open', 'done', 'verified'].map((k) => (
            <StatusLabel key={k} label={`${c[k] || 0} ${PUNCH_STATE[k].label}`} color={PUNCH_STATE[k].color} />
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <label htmlFor="punch-who" style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Show</label>
        <select id="punch-who" className="form-input" value={who} onChange={(e) => setWho(e.target.value)} style={{ width: 200 }}>
          <option value="">Everyone</option>
          {me && <option value={me}>Mine</option>}
          {assignees.filter((a) => a.email !== me).map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
        </select>
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
              {steps.map((t) => <Row key={t.id} t={t} view={view} onChanged={reload} canLog={canLog} canVerify={false} names={project.names} showState={false} />)}
            </div>
          )}
        </div>
      )}

      <div style={CARD}>
        <h3 style={{ fontSize: '1.05rem', marginBottom: 4 }}>Punch List</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 14px' }}>
          Each item is a task on the job's schedule. The crew marks it Done; a job manager checks it and marks it Verified.
        </p>
        {canLog && <AddItem project={project} people={jobPeople} onAdded={reload} />}
        {sorted.length === 0 ? (
          <Empty icon={CheckSquare} title={who ? 'Nothing for this person' : 'No punch items yet'}
            hint={canLog ? 'Add each item found on the walk-through - what needs fixing and where.' : 'Items appear here as the walk-through finds them.'} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sorted.map((t) => <Row key={t.id} t={t} view={view} onChanged={reload} canLog={canLog} canVerify={canVerify} names={project.names} />)}
          </div>
        )}
      </div>
    </div>
  );
}
