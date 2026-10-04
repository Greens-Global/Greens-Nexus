// Onboarding / offboarding / leave checklists (HR roadmap Section C:
// "Onboarding checklist per hire ... each with owner + due date").
//
//   ChecklistSection   - the Checklist tab on a People profile (HR)
//   MyChecklistSteps   - the steps the signed-in person owns, on My HR. A
//                        manager, IT or the new hire ticks their own steps here
//                        without People access; renders nothing when empty.
//   ChecklistSettings  - People > Checklists: who owns each role per company,
//                        and the template rows every new checklist is built from
//
// The server (backend/hr_checklists.py) resolves owners and due dates and
// ticks steps it can see for itself (a finished provisioning run, a signed
// envelope, a status change) - this file only shows and edits them.
import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ListChecks, CheckCircle2, Circle, MinusCircle, AlertTriangle, CalendarDays,
  Pencil, X, ChevronDown, ChevronRight, Sparkles, Play, RotateCcw, Plus,
  Trash2, ArrowUp, ArrowDown, Users, Save, Ban,
} from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { dialog } from '../ui/dialog';
import { usePeopleDirectory } from '../lib/queries';
import { SkeletonBlocks, Spinner } from './AsyncState';
import PersonSearchSelect from './PersonSearchSelect';

const STEP_META = {
  open:    { label: 'Open',    bg: 'hsla(var(--color-blue),0.1)',   fg: 'hsl(var(--color-blue))' },
  overdue: { label: 'Overdue', bg: 'hsla(var(--color-red),0.12)',   fg: 'hsl(var(--color-red))' },
  done:    { label: 'Done',    bg: 'hsla(var(--color-green),0.12)', fg: 'hsl(var(--color-green))' },
  na:      { label: 'N/A',     bg: 'var(--mist)',                   fg: 'var(--muted)' },
};
const LIST_META = {
  open:      { label: 'In Progress', bg: 'hsla(var(--color-blue),0.1)',   fg: 'hsl(var(--color-blue))' },
  done:      { label: 'Complete',    bg: 'hsla(var(--color-green),0.12)', fg: 'hsl(var(--color-green))' },
  cancelled: { label: 'Cancelled',   bg: 'var(--mist)',                   fg: 'var(--muted)' },
};
const ANCHOR_LABEL = { onboarding: 'Start Date', offboarding: 'Exit Date', inactive: 'Leave Starts' };
const EXIT_LABEL = {
  resignation: 'Resignation', resignation_no_notice: 'Resignation Without Notice', termination: 'Termination',
  end_of_contract: 'End Of Contract', retirement: 'Retirement', death: 'Death Of An Employee',
};

const pill = (m) => (
  <span style={{ padding: '2px 9px', borderRadius: 20, fontSize: 10.5, fontWeight: 700, background: m.bg, color: m.fg, whiteSpace: 'nowrap' }}>{m.label}</span>
);
const stepMeta = (s) => STEP_META[s.overdue ? 'overdue' : s.status] || STEP_META.open;
const capLabel = { fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase' };
const inputStyle = { padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', fontSize: 13, fontFamily: 'Inter,sans-serif' };

function ProgressBar({ done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, height: 7, borderRadius: 6, background: 'var(--mist)', overflow: 'hidden', minWidth: 80 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'hsl(var(--color-green))', transition: 'width .25s' }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{done} of {total} Done</span>
    </div>
  );
}

function ownerText(s) {
  if (s.ownerEmail) return s.ownerName || s.ownerEmail;
  return null;
}

// --- One step row ------------------------------------------------------------

function StepRow({ step, canEdit, canAct, people, onChanged, toastErr }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [due, setDue] = useState(step.dueDate || '');
  const m = stepMeta(step);
  const closed = step.status === 'done' || step.status === 'na';

  async function patch(body, okMsg) {
    setBusy(true);
    try {
      const r = await api.updateChecklistItem(step.id, body);
      onChanged(r.item, r.checklistStatus, okMsg);
    } catch (e) { toastErr(e?.message || 'Could not update this step.'); }
    setBusy(false);
  }
  const toggle = () => patch({ status: closed ? 'open' : 'done' });
  async function markNa() {
    const why = await dialog.prompt(`Why does "${step.title}" not apply?`, { title: 'Mark As N/A', required: true, placeholder: 'e.g. No background check for this role' });
    if (why) patch({ status: 'na', note: why });
  }
  async function editNote() {
    const note = await dialog.prompt('Note on this step', { title: 'Add A Note', defaultValue: step.note || '', multiline: true });
    if (note !== null) patch({ note });
  }

  return (
    <div style={{ display: 'flex', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--line)', alignItems: 'flex-start', opacity: busy ? 0.6 : 1 }}>
      <button onClick={toggle} disabled={busy || !canAct} aria-label={closed ? 'Mark as open' : 'Mark as done'}
        title={closed ? 'Mark as open again' : 'Mark as done'}
        style={{ background: 'none', border: 'none', padding: 2, cursor: canAct ? 'pointer' : 'default', color: step.status === 'done' ? 'hsl(var(--color-green))' : 'var(--muted)', flexShrink: 0 }}>
        {step.status === 'done' ? <CheckCircle2 size={18} /> : step.status === 'na' ? <MinusCircle size={18} /> : <Circle size={18} />}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: closed ? 'var(--muted)' : 'var(--ink)', textDecoration: step.status === 'done' ? 'line-through' : 'none' }}>{step.title}</span>
          {pill(m)}
          {step.signal && !closed && (
            <span title={`Nexus ticks this by itself when: ${step.signalLabel}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 700, color: 'var(--wk-brand)' }}>
              <Sparkles size={11} /> Auto
            </span>
          )}
        </div>
        {step.hint && !closed && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>{step.hint}</div>}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 5, fontSize: 12, color: 'var(--muted)' }}>
          <span>
            <b style={{ fontWeight: 700 }}>{step.ownerRoleLabel}:</b>{' '}
            {ownerText(step) || <span style={{ color: 'hsl(var(--color-orange))', fontWeight: 600 }}>Unassigned</span>}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: step.overdue ? 'hsl(var(--color-red))' : 'var(--muted)', fontWeight: step.overdue ? 700 : 400 }}>
            <CalendarDays size={12} /> {step.dueDate ? `Due ${formatDate(step.dueDate)}` : 'No due date'}
          </span>
          {closed && step.doneAt && (
            <span>{step.status === 'na' ? 'N/A' : 'Done'} {step.doneBy === 'Nexus' ? 'by Nexus' : step.doneBy ? `by ${step.doneBy}` : ''} on {formatDate(step.doneAt)}</span>
          )}
        </div>
        {step.note && <div style={{ fontSize: 12, color: 'var(--ink)', marginTop: 5, padding: '6px 9px', background: 'var(--mist)', borderRadius: 7, whiteSpace: 'pre-wrap' }}>{step.note}</div>}

        {editing && canEdit && (
          <div style={{ marginTop: 10, padding: 12, border: '1px solid var(--line)', borderRadius: 10, display: 'grid', gap: 10 }}>
            <div>
              <div style={{ ...capLabel, marginBottom: 5 }}>Owner</div>
              <PersonSearchSelect placeholder={ownerText(step) ? `${ownerText(step)} - type to change` : 'Pick who owns this step'}
                groups={[{ label: 'Nexus People', people }]}
                onPick={email => { setEditing(false); patch({ owner_email: email }, 'Owner changed.'); }} />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label style={{ display: 'grid', gap: 5 }}>
                <span style={capLabel}>Due Date</span>
                <input type="date" value={due} onChange={e => setDue(e.target.value)} style={inputStyle} />
              </label>
              <button className="secondary-btn" disabled={busy} onClick={() => { setEditing(false); patch({ due_date: due }, 'Due date changed.'); }}
                style={{ fontSize: 12.5 }}>Save Date</button>
              <button className="secondary-btn" onClick={() => setEditing(false)} style={{ fontSize: 12.5 }}>Close</button>
            </div>
          </div>
        )}
      </div>
      {canAct && <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
        {!closed && (
          <button onClick={markNa} disabled={busy} title="This step does not apply" className="icon-btn"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4 }}>
            <Ban size={14} />
          </button>
        )}
        <button onClick={editNote} disabled={busy} title="Add a note" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4 }}>
          <Pencil size={14} />
        </button>
        {canEdit && (
          <button onClick={() => { setDue(step.dueDate || ''); setEditing(v => !v); }} title="Change the owner or due date"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: editing ? 'var(--ink)' : 'var(--muted)', padding: 4 }}>
            <Users size={14} />
          </button>
        )}
      </div>}
    </div>
  );
}

// --- One checklist ---------------------------------------------------------

function ChecklistCard({ cl, canEdit, myEmail = '', people, onReplace, toastOk, toastErr, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const [filter, setFilter] = useState('all');
  const lm = LIST_META[cl.status] || LIST_META.open;
  const shown = cl.items.filter(s => filter === 'all' ? true
    : filter === 'open' ? s.status === 'open'
      : filter === 'overdue' ? s.overdue
        : true);
  const phases = [];
  shown.forEach(s => {
    let g = phases.find(p => p.name === s.phase);
    if (!g) { g = { name: s.phase || 'Steps', steps: [] }; phases.push(g); }
    g.steps.push(s);
  });

  function onStepChanged(item, checklistStatus, okMsg) {
    const items = cl.items.map(s => s.id === item.id ? item : s);
    const done = items.filter(s => s.status === 'done' || s.status === 'na').length;
    onReplace({ ...cl, items, done, overdue: items.filter(s => s.overdue).length, status: checklistStatus });
    if (okMsg) toastOk(okMsg);
    if (checklistStatus === 'done' && cl.status !== 'done') toastOk(`${cl.kindLabel} checklist complete.`);
  }
  async function cancel() {
    if (!await dialog.confirm(`Cancel this ${cl.kindLabel.toLowerCase()} checklist? Its steps are kept as history and nobody is reminded any more.`,
      { title: 'Cancel Checklist', confirmText: 'Cancel Checklist', cancelText: 'Keep It', danger: true })) return;
    try { onReplace(await api.cancelChecklist(cl.id)); toastOk('Checklist cancelled.'); }
    catch (e) { toastErr(e?.message || 'Could not cancel the checklist.'); }
  }
  async function reopen() {
    try { onReplace(await api.reopenChecklist(cl.id)); toastOk('Checklist reopened.'); }
    catch (e) { toastErr(e?.message || 'Could not reopen the checklist.'); }
  }

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '14px 16px', marginBottom: 14, background: 'var(--card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button onClick={() => setOpen(o => !o)} aria-expanded={open}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ink)', fontFamily: 'Inter,sans-serif' }}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span style={{ fontSize: 15, fontWeight: 800 }}>{cl.kindLabel}</span>
        </button>
        {pill(lm)}
        {cl.overdue > 0 && cl.status === 'open' && pill({ label: `${cl.overdue} Overdue`, ...STEP_META.overdue })}
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {ANCHOR_LABEL[cl.kind]}: {cl.anchorDate ? formatDate(cl.anchorDate) : <span style={{ color: 'hsl(var(--color-orange))', fontWeight: 600 }}>not set yet</span>}
          {cl.exitType ? ` · ${EXIT_LABEL[cl.exitType] || cl.exitType}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {canEdit && cl.status === 'open' && (
          <button className="secondary-btn" onClick={cancel} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px' }}>
            <X size={12} /> Cancel
          </button>
        )}
        {canEdit && cl.status === 'cancelled' && (
          <button className="secondary-btn" onClick={reopen} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px' }}>
            <RotateCcw size={12} /> Reopen
          </button>
        )}
      </div>
      <div style={{ marginTop: 10 }}><ProgressBar done={cl.done} total={cl.total} /></div>
      {cl.kind === 'onboarding' && !cl.anchorDate && cl.status === 'open' && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: 'hsl(var(--color-orange))', display: 'flex', gap: 6, alignItems: 'center' }}>
          <AlertTriangle size={13} /> Add a start date to the profile - most due dates count from it.
        </div>
      )}
      {open && (
        <>
          <div className="scroll-tabs" style={{ display: 'flex', gap: 6, margin: '12px 0 4px' }}>
            {[['all', 'All Steps'], ['open', 'Open'], ['overdue', 'Overdue']].map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)}
                style={{ padding: '4px 11px', borderRadius: 20, fontSize: 12, fontWeight: 600, fontFamily: 'Inter,sans-serif', cursor: 'pointer', whiteSpace: 'nowrap',
                  border: `1px solid ${filter === k ? 'var(--pine)' : 'var(--line)'}`, background: filter === k ? 'var(--pine)' : 'var(--card)', color: filter === k ? '#fff' : 'var(--ink)' }}>
                {l}
              </button>
            ))}
          </div>
          {!shown.length && <div style={{ fontSize: 13, color: 'var(--muted)', padding: '14px 0' }}>Nothing here.</div>}
          {phases.map(g => (
            <div key={g.name} style={{ marginTop: 12 }}>
              <div style={capLabel}>{g.name}</div>
              {g.steps.map(s => (
                <StepRow key={s.id} step={s} canEdit={canEdit && cl.status !== 'cancelled'} people={people}
                  canAct={cl.status !== 'cancelled' && (canEdit || (!!myEmail && s.ownerEmail === myEmail.toLowerCase()))}
                  onChanged={onStepChanged} toastErr={toastErr} />
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function StartForm({ employee, meta, onStarted, onClose, toastErr }) {
  const [kind, setKind] = useState('onboarding');
  const [date, setDate] = useState(employee.startDate || '');
  const [exitType, setExitType] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { onStarted(await api.startChecklist(employee.id, { kind, anchor_date: date, exit_type: exitType })); }
    catch (e) { toastErr(e?.message || 'Could not start the checklist.'); }
    setBusy(false);
  }
  const needDate = kind !== 'onboarding';
  const ready = (!needDate || date) && (kind !== 'offboarding' || exitType);
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 16, marginBottom: 14, display: 'grid', gap: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 800 }}>Start A Checklist</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(meta?.kinds || []).map(k => (
          <button key={k.value} onClick={() => { setKind(k.value); setDate(k.value === 'onboarding' ? (employee.startDate || '') : ''); }}
            style={{ padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, fontFamily: 'Inter,sans-serif', cursor: 'pointer',
              border: `1px solid ${kind === k.value ? 'var(--pine)' : 'var(--line)'}`, background: kind === k.value ? 'var(--pine)' : 'var(--card)', color: kind === k.value ? '#fff' : 'var(--ink)' }}>
            {k.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'grid', gap: 5 }}>
          <span style={capLabel}>{ANCHOR_LABEL[kind]}</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} disabled={kind === 'onboarding'} style={inputStyle}
            title={kind === 'onboarding' ? 'Onboarding counts from the start date on the profile - change it there' : ''} />
        </label>
        {kind === 'offboarding' && (
          <label style={{ display: 'grid', gap: 5 }}>
            <span style={capLabel}>Exit Type</span>
            <select value={exitType} onChange={e => setExitType(e.target.value)} style={inputStyle}>
              <option value="">Pick one</option>
              {(meta?.exitTypes || []).map(t => <option key={t.value} value={t.value}>{EXIT_LABEL[t.value] || t.label}</option>)}
            </select>
          </label>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
        {kind === 'onboarding' && 'Steps count from the start date on the profile and move with it when it changes.'}
        {kind === 'offboarding' && 'Start it on the day notice is received. Steps already past their date are due today. Starting a checklist changes nothing in Microsoft 365 - Left still happens from Change Status.'}
        {kind === 'inactive' && 'For a leave of absence, suspension or garden leave. Inactive itself changes nothing in Microsoft 365, so access steps are listed for IT.'}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="primary-btn" onClick={go} disabled={!ready || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy ? <Spinner size={13} /> : <Play size={13} />} Start Checklist
        </button>
        <button className="secondary-btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

export function ChecklistSection({ employee, canEdit = false, myEmail = '', toastOk, toastErr }) {
  const [lists, setLists] = useState(null);   // null = loading, false = failed
  const [meta, setMeta] = useState(null);
  const [starting, setStarting] = useState(false);
  const { data: dir = [] } = usePeopleDirectory();
  const people = useMemo(() => dir.map(p => ({ email: (p.email || '').toLowerCase(), name: p.name || p.email })), [dir]);

  const load = useCallback(() => {
    api.getEmployeeChecklists(employee.id)
      .then(r => setLists(r.checklists || []))
      .catch(() => setLists(false));
  }, [employee.id]);
  useEffect(load, [load]);
  useEffect(() => { api.getChecklistMeta().then(setMeta).catch(() => setMeta(null)); }, []);

  const replace = (next) => setLists(prev => (prev || []).map(c => c.id === next.id ? next : c));

  if (lists === null) return <SkeletonBlocks count={2} height={90} />;
  if (lists === false) {
    return (
      <div style={{ fontSize: 13, color: 'var(--muted)', padding: '20px 0' }}>
        Could not load the checklists. <button onClick={load} style={{ background: 'none', border: 'none', color: 'var(--ink)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>Retry</button>
      </div>
    );
  }
  const openLists = lists.filter(c => c.status === 'open');
  const pastLists = lists.filter(c => c.status !== 'open');
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1, lineHeight: 1.5 }}>
          Each step has an owner and a due date. Owners are reminded in the bell and see their steps on My HR.
        </span>
        {canEdit && !starting && (
          <button className="secondary-btn" onClick={() => setStarting(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
            <Plus size={13} /> Start Checklist
          </button>
        )}
      </div>
      {starting && (
        <StartForm employee={employee} meta={meta} toastErr={toastErr} onClose={() => setStarting(false)}
          onStarted={cl => { setStarting(false); setLists(prev => [cl, ...(prev || [])]); toastOk(`${cl.kindLabel} checklist started - ${cl.total} steps.`); }} />
      )}
      {!lists.length && !starting && (
        <div style={{ textAlign: 'center', padding: '28px 12px', color: 'var(--muted)', fontSize: 13, border: '1px dashed var(--line)', borderRadius: 12 }}>
          <ListChecks size={22} style={{ marginBottom: 6 }} />
          <div>No checklist for {employee.firstName || 'this person'} yet.</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Marking a candidate Hired starts onboarding automatically.</div>
        </div>
      )}
      {openLists.map(c => (
        <ChecklistCard key={c.id} cl={c} canEdit={canEdit} myEmail={myEmail} people={people} onReplace={replace}
          toastOk={toastOk} toastErr={toastErr} defaultOpen />
      ))}
      {pastLists.length > 0 && (
        <>
          <div style={{ ...capLabel, margin: '18px 0 8px' }}>Past Checklists</div>
          {pastLists.map(c => (
            <ChecklistCard key={c.id} cl={c} canEdit={canEdit} myEmail={myEmail} people={people} onReplace={replace}
              toastOk={toastOk} toastErr={toastErr} defaultOpen={false} />
          ))}
        </>
      )}
    </div>
  );
}

// --- My HR: steps I own ----------------------------------------------------

export function MyChecklistSteps() {
  const [steps, setSteps] = useState(null);
  const [msg, setMsg] = useState('');
  // Wrapped so a failure (or an older API without the route) only hides the
  // card - My HR must never break because of it.
  const load = useCallback(() => {
    Promise.resolve().then(() => api.getMyChecklistSteps())
      .then(r => setSteps(r?.steps || [])).catch(() => setSteps([]));
  }, []);
  useEffect(load, [load]);
  if (!steps || !steps.length) return null;

  async function done(s) {
    try {
      await api.updateChecklistItem(s.id, { status: 'done' });
      setSteps(prev => prev.filter(x => x.id !== s.id));
      setMsg(`Done: ${s.title}`);
      setTimeout(() => setMsg(''), 3500);
    } catch (e) { setMsg(e?.message || 'Could not update this step.'); }
  }
  const late = steps.filter(s => s.overdue).length;
  const groups = [];
  steps.forEach(s => {
    let g = groups.find(x => x.key === s.checklistId);
    if (!g) { g = { key: s.checklistId, title: `${s.kindLabel}: ${s.employeeName}`, sub: s.employeeTitle, steps: [] }; groups.push(g); }
    g.steps.push(s);
  });
  return (
    <div className="dash-card" style={{ marginBottom: 16 }}>
      <div className="dash-card-head">
        <div>
          <div className="dash-card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ListChecks size={16} /> My Checklist Steps
            {late > 0 && pill({ label: `${late} Overdue`, ...STEP_META.overdue })}
          </div>
          <div className="dash-card-sub">Onboarding and offboarding steps assigned to you</div>
        </div>
      </div>
      {msg && <div style={{ fontSize: 12.5, fontWeight: 600, color: 'hsl(var(--color-green))', marginBottom: 8 }}>{msg}</div>}
      {groups.map(g => (
        <div key={g.key} style={{ marginTop: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
            {g.title} {g.sub && <span style={{ fontWeight: 400, color: 'var(--muted)' }}>· {g.sub}</span>}
          </div>
          {g.steps.map(s => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <button onClick={() => done(s)} title="Mark as done" aria-label={`Mark ${s.title} as done`}
                style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--muted)', flexShrink: 0 }}>
                <Circle size={17} />
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{s.title}</div>
                {s.hint && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>{s.hint}</div>}
              </div>
              <span style={{ fontSize: 12, whiteSpace: 'nowrap', color: s.overdue ? 'hsl(var(--color-red))' : 'var(--muted)', fontWeight: s.overdue ? 700 : 400 }}>
                {s.dueDate ? formatDate(s.dueDate) : 'No date'}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// --- People > Checklists: owners + templates -------------------------------

const ROLE_HINT = {
  hr: 'Used when the company has no HR contact in Company Setup.',
  it: 'Provisioning, licenses, mailbox and sign-in steps.',
  payroll: 'Tax forms, final pay, leave payout.',
  equipment: 'Laptops and phones in Item Management.',
  finance: 'Accounting, bank and vendor portals, company cards.',
};

function OwnersCard({ entityId, people, toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.getChecklistOwners(entityId).then(r => { setData(r); setDraft(r.owners || {}); }).catch(() => setData(false));
  }, [entityId]);
  const nameOf = em => people.find(p => p.email === em)?.name || em;
  async function save() {
    setBusy(true);
    try { const r = await api.saveChecklistOwners(entityId, draft); setData(d => ({ ...d, ...r })); toastOk('Checklist owners saved.'); }
    catch (e) { toastErr(e?.message || 'Could not save the owners.'); }
    setBusy(false);
  }
  if (data === null) return <SkeletonBlocks count={1} height={120} />;
  if (data === false) return <div style={{ fontSize: 13, color: 'var(--muted)' }}>Could not load the owners.</div>;
  return (
    <div className="dash-card" style={{ marginBottom: 16 }}>
      <div className="dash-card-head">
        <div>
          <div className="dash-card-title">Who Owns Each Role</div>
          <div className="dash-card-sub">
            Manager and Employee steps go to the person&apos;s reports-to and the person. HR steps go to the company&apos;s HR contact{data.hrContact ? ` (${nameOf(data.hrContact)})` : ''}.
            {entityId ? ' Roles left blank here use the default.' : ''}
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        {['hr', 'it', 'payroll', 'equipment', 'finance'].map(role => (
          <div key={role} style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 160px) 1fr', gap: 10, alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{role === 'hr' ? 'HR' : role === 'it' ? 'IT' : role[0].toUpperCase() + role.slice(1)}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>{ROLE_HINT[role]}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
              {draft[role] ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 20, background: 'var(--mist)', fontSize: 12.5, fontWeight: 600 }}>
                  {nameOf(draft[role])}
                  <button onClick={() => setDraft(d => ({ ...d, [role]: '' }))} aria-label="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 0, display: 'inline-flex' }}><X size={12} /></button>
                </span>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {data.effective?.[role] ? `Default: ${nameOf(data.effective[role])}` : 'Not set'}
                </span>
              )}
              <div style={{ flex: 1, minWidth: 180 }}>
                <PersonSearchSelect placeholder="Pick a person" groups={[{ label: 'Nexus People', people }]}
                  onPick={em => setDraft(d => ({ ...d, [role]: em }))} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="primary-btn" onClick={save} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy ? <Spinner size={13} /> : <Save size={13} />} Save Owners
        </button>
      </div>
    </div>
  );
}

const TYPE_CHOICES = [['employee', 'Employees'], ['contractor', 'Contractors'], ['intern', 'Interns']];
const COUNTRY_CHOICES = [['US', 'US'], ['IN', 'India']];

function TemplateEditor({ template, meta, entityId, onSaved, toastOk, toastErr }) {
  const [rows, setRows] = useState(template.items || []);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const set = (i, patch) => { setRows(r => r.map((x, j) => j === i ? { ...x, ...patch } : x)); setDirty(true); };
  const move = (i, d) => { setRows(r => { const n = [...r]; const t = n[i]; n[i] = n[i + d]; n[i + d] = t; return n; }); setDirty(true); };
  const toggleIn = (i, field, value) => {
    const cur = rows[i].applies?.[field] || [];
    const next = cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value];
    set(i, { applies: { ...(rows[i].applies || {}), [field]: next } });
  };
  async function save() {
    setBusy(true);
    try { onSaved(await api.saveChecklistTemplate(template.kind, entityId, { items: rows })); setDirty(false); toastOk('Template saved. New checklists use it; ones already started keep their steps.'); }
    catch (e) { toastErr(e?.message || 'Could not save the template.'); }
    setBusy(false);
  }
  async function reset() {
    const msg = entityId ? 'Go back to the default template for this company?' : 'Put the default template back to the steps Nexus shipped with?';
    if (!await dialog.confirm(msg, { title: 'Reset Template', confirmText: 'Reset', danger: true })) return;
    try { onSaved(await api.resetChecklistTemplate(template.kind, entityId)); toastOk('Template reset.'); }
    catch (e) { toastErr(e?.message || 'Could not reset the template.'); }
  }
  const roles = meta?.roles || [];
  const signals = meta?.signals || [];
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1, minWidth: 220, lineHeight: 1.5 }}>
          {template.inherited ? 'This company uses the default template. Saving makes a copy just for this company.' : `${rows.length} steps.`}
          {' '}Offsets are days from the anchor: negative is before, positive is after.
        </span>
        <button className="secondary-btn" onClick={reset} style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}><RotateCcw size={12} /> Reset</button>
        <button className="secondary-btn" onClick={() => { setRows(r => [...r, { key: '', phase: r[r.length - 1]?.phase || '', title: '', owner: 'hr', anchor: template.kind === 'onboarding' ? 'S' : 'X', offset: 0, bd: false, applies: {}, signal: '', hint: '' }]); setDirty(true); }}
          style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add Step</button>
        <button className="primary-btn" onClick={save} disabled={busy || !dirty} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy ? <Spinner size={13} /> : <Save size={13} />} Save Template
        </button>
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, marginBottom: 8, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={r.title} onChange={e => set(i, { title: e.target.value })} placeholder="Step title (Title Case)" style={{ ...inputStyle, flex: '2 1 240px', fontWeight: 600 }} />
            <input value={r.phase} onChange={e => set(i, { phase: e.target.value })} placeholder="Phase" style={{ ...inputStyle, flex: '1 1 140px' }} />
            <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><ArrowUp size={14} /></button>
            <button onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="Move down" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><ArrowDown size={14} /></button>
            <button onClick={() => { setRows(x => x.filter((_, j) => j !== i)); setDirty(true); }} aria-label="Delete step" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--color-red))' }}><Trash2 size={14} /></button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5 }}>
            <select value={r.owner} onChange={e => set(i, { owner: e.target.value })} style={inputStyle} aria-label="Owner">
              {roles.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select value={r.anchor} onChange={e => set(i, { anchor: e.target.value })} style={inputStyle} aria-label="Counts from">
              <option value="S">From Start Date</option>
              <option value="X">From Exit Date / Leave Start</option>
              <option value="created">From The Day It Starts</option>
              <option value="none">No Due Date</option>
            </select>
            {r.anchor !== 'none' && (
              <>
                <input type="number" value={r.offset} onChange={e => set(i, { offset: Number(e.target.value) || 0 })} style={{ ...inputStyle, width: 80 }} aria-label="Offset in days" />
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <input type="checkbox" checked={!!r.bd} onChange={e => set(i, { bd: e.target.checked })} /> Business Days
                </label>
              </>
            )}
            <select value={r.signal} onChange={e => set(i, { signal: e.target.value })} style={{ ...inputStyle, maxWidth: 260 }} aria-label="Ticked by Nexus when">
              <option value="">Ticked By Hand</option>
              {r.signal && !signals.some(s => s.value === r.signal) && <option value={r.signal}>{r.signal}</option>}
              {signals.filter(s => s.value !== 'envelope').map(s => <option key={s.value} value={s.value}>Auto: {s.label}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--muted)' }}>
            <span>For:</span>
            {TYPE_CHOICES.map(([v, l]) => (
              <label key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={(r.applies?.types || []).includes(v)} onChange={() => toggleIn(i, 'types', v)} /> {l}
              </label>
            ))}
            <span>·</span>
            {COUNTRY_CHOICES.map(([v, l]) => (
              <label key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={(r.applies?.countries || []).includes(v)} onChange={() => toggleIn(i, 'countries', v)} /> {l}
              </label>
            ))}
            {template.kind === 'offboarding' && (
              <>
                <span>·</span>
                {(meta?.exitTypes || []).map(t => (
                  <label key={t.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <input type="checkbox" checked={(r.applies?.exit_types || []).includes(t.value)} onChange={() => toggleIn(i, 'exit_types', t.value)} /> {EXIT_LABEL[t.value] || t.label}
                  </label>
                ))}
              </>
            )}
            <span style={{ fontStyle: 'italic' }}>(nothing ticked = everyone)</span>
          </div>
          <input value={r.hint || ''} onChange={e => set(i, { hint: e.target.value })} placeholder="How-to hint shown under the step (optional)" style={inputStyle} />
        </div>
      ))}
    </div>
  );
}

export function ChecklistSettings({ entities = [], toastOk, toastErr }) {
  const [entityId, setEntityId] = useState('');
  const [loaded, setLoaded] = useState({ entityId: null, templates: null });
  const [kind, setKind] = useState('onboarding');
  const [meta, setMeta] = useState(null);
  const { data: dir = [] } = usePeopleDirectory();
  const people = useMemo(() => dir.map(p => ({ email: (p.email || '').toLowerCase(), name: p.name || p.email })), [dir]);
  useEffect(() => { api.getChecklistMeta().then(setMeta).catch(() => setMeta(null)); }, []);
  useEffect(() => {
    api.getChecklistTemplates(entityId)
      .then(r => setLoaded({ entityId, templates: r.templates || [] }))
      .catch(() => setLoaded({ entityId, templates: false }));
  }, [entityId]);
  const templates = loaded.entityId === entityId ? loaded.templates : null;
  const setTemplates = fn => setLoaded(l => ({ ...l, templates: fn(l.templates || []) }));
  const tpl = (templates || []).find(t => t.kind === kind);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Company</span>
        <select value={entityId} onChange={e => setEntityId(e.target.value)} style={inputStyle}>
          <option value="">Default (Every Company)</option>
          {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
        </select>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>A company without its own setup uses the default.</span>
      </div>
      <OwnersCard key={entityId || 'default'} entityId={entityId} people={people} toastOk={toastOk} toastErr={toastErr} />
      <div className="dash-card">
        <div className="dash-card-head">
          <div>
            <div className="dash-card-title">Checklist Templates</div>
            <div className="dash-card-sub">The steps every new checklist is built from</div>
          </div>
        </div>
        <div className="scroll-tabs" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)', marginBottom: 12 }}>
          {(meta?.kinds || []).map(k => (
            <button key={k.value} onClick={() => setKind(k.value)}
              style={{ padding: '8px 12px', fontSize: 13, fontWeight: 600, fontFamily: 'Inter,sans-serif', background: 'none', border: 'none', borderBottom: `2px solid ${kind === k.value ? 'var(--pine)' : 'transparent'}`, color: kind === k.value ? 'var(--ink)' : 'var(--muted)', cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: -1 }}>
              {k.label}
            </button>
          ))}
        </div>
        {templates === null && <SkeletonBlocks count={3} height={70} />}
        {templates === false && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Could not load the templates.</div>}
        {tpl && (
          <TemplateEditor key={`${tpl.kind}:${entityId}:${tpl.updatedAt}:${tpl.entityId}`} template={tpl} meta={meta} entityId={entityId} toastOk={toastOk} toastErr={toastErr}
            onSaved={saved => setTemplates(prev => prev.map(t => t.kind === saved.kind ? saved : t))} />
        )}
      </div>
    </div>
  );
}
