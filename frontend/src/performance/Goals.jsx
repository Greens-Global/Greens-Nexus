// Goals (Neil, Oct 27 2026): a row per goal, a form to set one, and the goal
// itself with its check-ins. The server decides who may see and change what
// (backend/performance.py); `canEdit` on each goal says whether this viewer
// may check in on it.
import { useEffect, useMemo, useState } from 'react';
import { Target, Plus, Archive, Pencil, ArrowUpRight } from 'lucide-react';
import { api } from '../api';
import { Modal, DateField, PersonSelect, usePeople } from '../tasks/components';
import { StatusLabel } from '../components/StatusLabel';
import { LoadingState, ErrorBanner } from '../components/AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import { GOAL_STATUS, GOAL_STATUS_KEYS, LEVEL_LABEL, MEASURES, measureText, LBL, muted } from './lib';

export function ProgressBar({ value = 0, color = 'var(--wk-brand)', label }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <span role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={label || 'Progress'}
      style={{ display: 'block', height: 6, borderRadius: 4, background: 'var(--mist)', overflow: 'hidden', minWidth: 60 }}>
      <span style={{ display: 'block', height: '100%', width: `${v}%`, background: color, borderRadius: 4, transition: 'width .3s ease' }} />
    </span>
  );
}

export function GoalStatus({ status, size = 'sm' }) {
  const m = GOAL_STATUS[status] || { label: status || '-', color: '#64748b' };
  return <StatusLabel label={m.label} color={m.color} size={size} />;
}

export function GoalRow({ goal: g, onOpen, showOwner = false }) {
  const meta = GOAL_STATUS[g.status] || GOAL_STATUS.on_track;
  return (
    <button type="button" onClick={() => onOpen?.(g)} className="nx-perf-row"
      style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '6px 14px', alignItems: 'center', width: '100%',
        textAlign: 'left', padding: '11px 12px', border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)',
        cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)' }}>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</span>
        <span style={{ display: 'block', ...muted, fontSize: 12, marginTop: 2 }}>
          {[g.level !== 'personal' ? (g.level === 'department' ? `${g.department} Department` : 'Company Goal') : '',
            showOwner || g.level !== 'personal' ? g.ownerName : '',
            g.dueOn ? `Due ${formatDate(g.dueOn)}` : '',
            g.parentTitle ? `Supports: ${g.parentTitle}` : ''].filter(Boolean).join(' · ')}
        </span>
      </span>
      <GoalStatus status={g.status} />
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, gridColumn: '1 / -1' }}>
        <span style={{ flex: 1 }}><ProgressBar value={g.progress} color={meta.color} label={`${g.title} progress`} /></span>
        <span style={{ fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{measureText(g)}</span>
      </span>
    </button>
  );
}

export function GoalList({ goals, onOpen, showOwner = false, empty = 'No goals yet.' }) {
  if (!goals?.length) return <div style={{ ...muted, padding: '6px 2px' }}>{empty}</div>;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {goals.map(g => <GoalRow key={g.id} goal={g} onOpen={onOpen} showOwner={showOwner} />)}
    </div>
  );
}

const field = { display: 'grid', gap: 5, minWidth: 0 };

// Which kinds of goal this person may set, and for whom (the server checks
// the same: backend/performance.check_create).
function levelsFor(ctx) {
  const out = [{ key: 'personal', label: 'Personal' }];
  if (ctx?.isHr || ctx?.hasTeam) out.push({ key: 'department', label: 'Department' });
  if (ctx?.isHr) out.push({ key: 'company', label: 'Company' });
  return out;
}

export function GoalFormModal({ ctx, goal = null, defaults = {}, parents = [], onClose, onSaved, toastErr }) {
  const editing = !!goal;
  const people = usePeople();
  const [f, setF] = useState(() => ({
    title: goal?.title || '', description: goal?.description || '',
    level: goal?.level || defaults.level || 'personal',
    ownerEmail: goal?.ownerEmail || defaults.ownerEmail || ctx?.email || '',
    companyId: goal?.companyId || defaults.companyId || ctx?.hrCompanies?.[0]?.id || ctx?.company || '',
    department: goal?.department || defaults.department || ctx?.department || '',
    measure: goal?.measure || 'percent', startValue: goal?.startValue ?? 0, targetValue: goal?.targetValue ?? '',
    unit: goal?.unit || '', dueOn: goal?.dueOn || '', parentId: goal?.parentId || '', status: goal?.status || 'on_track',
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (v) => setF(p => ({ ...p, [k]: v }));
  const levels = levelsFor(ctx);
  // Owner choices: yourself and your direct reports; HR picks anyone.
  const ownerChoices = useMemo(() => {
    if (ctx?.isHr) return people;
    const mine = [{ email: ctx?.email, name: ctx?.name || ctx?.email }];
    return [...mine, ...(ctx?.reports || []).map(r => ({ email: r.email, name: r.name }))].filter(p => p.email);
  }, [ctx, people]);
  const ownerFixed = editing ? goal.level === 'personal' : (f.level === 'department' && !ctx?.isHr);
  const parentChoices = parents.filter(p => p.id !== goal?.id && !p.archived);
  const dirty = !!(f.title || f.description);

  async function save() {
    if (!f.title.trim()) { setErr('Give the goal a title.'); return; }
    if (f.measure === 'number' && (f.targetValue === '' || f.targetValue === null)) { setErr('Set the target number.'); return; }
    setBusy(true); setErr('');
    const body = {
      title: f.title.trim(), description: f.description, measure: f.measure, unit: f.unit,
      start_value: f.measure === 'number' ? Number(f.startValue || 0) : undefined,
      target_value: f.measure === 'number' ? Number(f.targetValue) : undefined,
      due_on: f.dueOn || '', parent_id: f.parentId || '', status: f.status,
    };
    try {
      const out = editing
        ? await api.perfGoalUpdate(goal.id, { ...body, ...(goal.level !== 'personal' && f.ownerEmail !== goal.ownerEmail ? { owner_email: f.ownerEmail } : {}) })
        : await api.perfGoalCreate({ ...body, level: f.level, owner_email: f.ownerEmail, company_id: f.companyId, department: f.department });
      onSaved?.(out);
    } catch (e) {
      setErr(e?.message || 'Could not save the goal.');
      toastErr?.(e?.message || 'Could not save the goal.');
    } finally { setBusy(false); }
  }

  return (
    <Modal title={editing ? 'Edit Goal' : 'Add Goal'} onClose={onClose} isDirty={dirty && !editing}
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : editing ? 'Save' : 'Add Goal'}</button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minHeight: 0 }}>
        {err && <ErrorBanner message={err} />}
        <label style={field}>
          <span style={LBL}>Title</span>
          <input className="form-input" value={f.title} onChange={e => set('title')(e.target.value)} placeholder="What do you want to achieve?" autoFocus />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          {!editing && levels.length > 1 && (
            <label style={field}>
              <span style={LBL}>Type</span>
              <select className="form-input" value={f.level} onChange={e => setF(p => ({ ...p, level: e.target.value, ownerEmail: e.target.value === 'department' && !ctx?.isHr ? ctx?.email : p.ownerEmail }))}>
                {levels.map(l => <option key={l.key} value={l.key}>{l.label}</option>)}
              </select>
            </label>
          )}
          {f.level === 'company' && !editing && (ctx?.hrCompanies || []).length > 1 && (
            <label style={field}>
              <span style={LBL}>Company</span>
              <select className="form-input" value={f.companyId} onChange={e => set('companyId')(e.target.value)}>
                {(ctx?.hrCompanies || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          {f.level === 'department' && !editing && (
            <label style={field}>
              <span style={LBL}>Department</span>
              <input className="form-input" value={f.department} disabled={!ctx?.isHr} onChange={e => set('department')(e.target.value)} />
            </label>
          )}
          <div style={field}>
            <span style={LBL}>Owner</span>
            {ownerFixed
              ? <span style={{ fontSize: 13.5, padding: '8px 0' }}>{goal?.ownerName || ctx?.name}</span>
              : <PersonSelect value={f.ownerEmail} onChange={set('ownerEmail')} people={ownerChoices} allowNone={false} ariaLabel="Owner" />}
          </div>
          <div style={field}>
            <span style={LBL}>Due Date</span>
            <span className="form-input" style={{ display: 'flex', alignItems: 'center' }}>
              <DateField value={f.dueOn} onChange={set('dueOn')} placeholder="No due date" style={{ width: '100%' }} />
            </span>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, alignItems: 'end' }}>
          <label style={field}>
            <span style={LBL}>Measured By</span>
            <select className="form-input" value={f.measure} onChange={e => set('measure')(e.target.value)}>
              {MEASURES.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </label>
          {f.measure === 'number' && (<>
            <label style={field}>
              <span style={LBL}>Start</span>
              <input className="form-input" type="number" value={f.startValue} onChange={e => set('startValue')(e.target.value)} />
            </label>
            <label style={field}>
              <span style={LBL}>Target</span>
              <input className="form-input" type="number" value={f.targetValue} onChange={e => set('targetValue')(e.target.value)} />
            </label>
            <label style={field}>
              <span style={LBL}>Unit</span>
              <input className="form-input" value={f.unit} onChange={e => set('unit')(e.target.value)} placeholder="calls, $, units" />
            </label>
          </>)}
        </div>
        <div style={{ ...muted, fontSize: 12, marginTop: -6 }}>{MEASURES.find(m => m.key === f.measure)?.hint}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <label style={field}>
            <span style={LBL}>Supports</span>
            <select className="form-input" value={f.parentId} onChange={e => set('parentId')(e.target.value)}>
              <option value="">Nothing - a goal of its own</option>
              {parentChoices.map(p => <option key={p.id} value={p.id}>{p.title} ({LEVEL_LABEL[p.level]})</option>)}
            </select>
          </label>
          {editing && (
            <label style={field}>
              <span style={LBL}>Status</span>
              <select className="form-input" value={f.status} onChange={e => set('status')(e.target.value)}>
                {GOAL_STATUS_KEYS.map(k => <option key={k} value={k}>{GOAL_STATUS[k].label}</option>)}
              </select>
            </label>
          )}
        </div>
        <label style={{ ...field, flex: 1 }} className="nx-fill">
          <span style={LBL}>Description</span>
          <textarea className="form-input" value={f.description} onChange={e => set('description')(e.target.value)}
            placeholder="What does done look like? Anything that helps." style={{ fontFamily: 'inherit' }} />
        </label>
      </div>
    </Modal>
  );
}

function CheckinForm({ goal, onSaved, toastErr }) {
  const [value, setValue] = useState(goal.measure === 'done' ? (Number(goal.currentValue) >= 1 ? 1 : 0) : goal.currentValue ?? 0);
  const [status, setStatus] = useState(goal.status);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const out = await api.perfGoalCheckin(goal.id, { value: Number(value), status, note });
      setNote('');
      onSaved?.(out);
    } catch (e) { toastErr?.(e?.message || 'Could not save the check-in.'); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, border: '1px solid var(--line)', borderRadius: 12, flex: 1, minHeight: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 700 }}>Check In</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {goal.measure === 'done' ? (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={Number(value) >= 1} onChange={e => setValue(e.target.checked ? 1 : 0)} /> Done
          </label>
        ) : (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span style={LBL}>{goal.measure === 'percent' ? 'Progress (%)' : `Now${goal.unit ? ` (${goal.unit})` : ''}`}</span>
            <input className="form-input" type="number" value={value} min={goal.measure === 'percent' ? 0 : undefined}
              max={goal.measure === 'percent' ? 100 : undefined} onChange={e => setValue(e.target.value)} style={{ width: 110 }} />
          </label>
        )}
        <span role="radiogroup" aria-label="Status" style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          {GOAL_STATUS_KEYS.map(k => (
            <button key={k} type="button" role="radio" aria-checked={status === k} onClick={() => setStatus(k)}
              className={status === k ? 'primary-btn' : 'secondary-btn'} style={{ padding: '5px 10px', fontSize: 12 }}>
              {GOAL_STATUS[k].label}
            </button>
          ))}
        </span>
      </div>
      <label className="nx-fill" style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1 }}>
        <span style={LBL}>Note</span>
        <textarea className="form-input" value={note} onChange={e => setNote(e.target.value)} placeholder="What moved, what is in the way?" style={{ fontFamily: 'inherit' }} />
      </label>
      <div><button type="button" className="primary-btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Check-In'}</button></div>
    </div>
  );
}

export function GoalDetailModal({ goalId, ctx, parents = [], onClose, onChanged, toastOk, toastErr }) {
  const [g, setG] = useState(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let live = true;
    api.perfGoal(goalId).then(r => { if (live) setG(r); }).catch(e => { if (live) setErr(e?.message || 'Could not load the goal.'); });
    return () => { live = false; };
  }, [goalId]);
  const changed = (out) => { setG(out); onChanged?.(out); };
  async function archive() {
    try {
      const out = await api.perfGoalArchive(g.id, g.archived);
      toastOk?.(g.archived ? 'Goal restored.' : 'Goal archived - it stays in the history.');
      onChanged?.(out);
      onClose?.();
    } catch (e) { toastErr?.(e?.message || 'Could not archive the goal.'); }
  }
  if (editing && g) {
    return <GoalFormModal ctx={ctx} goal={g} parents={parents} onClose={() => setEditing(false)} toastErr={toastErr}
      onSaved={() => { setEditing(false); api.perfGoal(g.id).then(changed).catch(() => {}); toastOk?.('Goal saved.'); }} />;
  }
  const meta = GOAL_STATUS[g?.status] || GOAL_STATUS.on_track;
  return (
    <Modal title={g ? g.title : 'Goal'} onClose={onClose}
      footer={g?.canEdit || g?.archived ? <>
        <button type="button" className="secondary-btn" onClick={archive} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Archive size={14} /> {g.archived ? 'Restore' : 'Archive'}
        </button>
        {!g.archived && <button type="button" className="secondary-btn" onClick={() => setEditing(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Pencil size={14} /> Edit</button>}
        <button type="button" className="primary-btn" onClick={onClose}>Done</button>
      </> : <button type="button" className="primary-btn" onClick={onClose}>Done</button>}>
      {err ? <ErrorBanner message={err} /> : !g ? <LoadingState size="section" label="Loading the goal" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <GoalStatus status={g.status} size="md" />
            <span style={muted}>{[LEVEL_LABEL[g.level] + ' Goal', g.ownerName, g.dueOn ? `Due ${formatDate(g.dueOn)}` : ''].filter(Boolean).join(' · ')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ flex: 1 }}><ProgressBar value={g.progress} color={meta.color} /></span>
            <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{measureText(g)}</span>
          </div>
          {g.description && <div style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{g.description}</div>}
          {g.parentTitle && <div style={muted}><ArrowUpRight size={13} style={{ verticalAlign: -2 }} /> Supports {g.parentTitle}</div>}
          {g.children?.length > 0 && (
            <div>
              <div style={{ ...LBL, marginBottom: 6 }}>Goals That Support This One</div>
              <div style={{ display: 'grid', gap: 6 }}>
                {g.children.map(k => (
                  <div key={k.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.title} <span style={muted}>· {k.ownerName}</span></span>
                    <span style={{ width: 90 }}><ProgressBar value={k.progress} color={(GOAL_STATUS[k.status] || meta).color} /></span>
                    <GoalStatus status={k.status} />
                  </div>
                ))}
              </div>
            </div>
          )}
          {g.canEdit && <CheckinForm key={g.lastCheckinAt} goal={g} onSaved={(out) => { changed(out); toastOk?.('Check-in saved.'); }} toastErr={toastErr} />}
          <div>
            <div style={{ ...LBL, marginBottom: 6 }}>Check-Ins</div>
            {!g.checkins?.length ? <div style={muted}>No check-ins yet.</div> : (
              <div style={{ display: 'grid', gap: 8 }}>
                {g.checkins.map(c => (
                  <div key={c.id} style={{ borderLeft: `3px solid ${(GOAL_STATUS[c.status] || meta).color}`, padding: '4px 0 4px 10px' }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {formatDateTime(c.at)} · {c.byName} · {c.statusLabel}{c.value !== null && c.value !== undefined ? ` · ${measureText({ ...g, currentValue: c.value })}` : ''}
                    </div>
                    {c.note && <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginTop: 2 }}>{c.note}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

export function AddGoalButton({ onClick, label = 'Add Goal' }) {
  return (
    <button type="button" className="secondary-btn" onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
      <Plus size={14} /> {label}
    </button>
  );
}

export const GoalIcon = Target;
