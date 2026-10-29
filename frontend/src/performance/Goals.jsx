// Goals, made simple (Neil, Oct 29 2026). A goal is a title, a target and a
// due date - measured BY one of the person's Nexus numbers (it updates by
// itself) or kept by hand. The status is worked out on the server from
// progress against the time gone (backend/performance.computed_status); an
// employee's own goal is Proposed until their manager approves it. At most
// five open goals each. The server decides who may see and change what.
import { useEffect, useMemo, useState } from 'react';
import { Target, Plus, Archive, Pencil, ArrowUpRight, Check, Sparkles } from 'lucide-react';
import { api } from '../api';
import { Modal, DateField, PersonSelect, usePeople } from '../tasks/components';
import { StatusLabel } from '../components/StatusLabel';
import { LoadingState, ErrorBanner } from '../components/AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import { GOAL_STATUS, LEVEL_LABEL, MEASURES, measureText, LBL, muted, TAP } from './lib';

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

export function GoalRow({ goal: g, onOpen, onApprove, showOwner = false }) {
  const meta = GOAL_STATUS[g.status] || GOAL_STATUS.on_track;
  return (
    <div className="nx-perf-row" style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', minWidth: 0 }}>
      <button type="button" onClick={() => onOpen?.(g)}
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '6px 12px', alignItems: 'center', width: '100%',
          textAlign: 'left', padding: '11px 12px', border: 'none', background: 'transparent', borderRadius: 12,
          cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)', minHeight: 44 }}>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</span>
          <span style={{ display: 'block', ...muted, fontSize: 12, marginTop: 2 }}>
            {[g.level !== 'personal' ? (g.level === 'department' ? `${g.department} Department` : 'Company Goal') : '',
              showOwner || g.level !== 'personal' ? g.ownerName : '',
              g.dueOn ? `Due ${formatDate(g.dueOn)}` : ''].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {g.proposed && <StatusLabel label="Proposed" color="#64748b" size="sm" />}
          <GoalStatus status={g.status} />
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, gridColumn: '1 / -1', minWidth: 0 }}>
          <span style={{ flex: 1, minWidth: 60 }}><ProgressBar value={g.progress} color={meta.color} label={`${g.title} progress`} /></span>
          <span style={{ fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{measureText(g)}</span>
        </span>
        {g.measuredByNexus && (
          <span style={{ gridColumn: '1 / -1', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)' }}>
            <Sparkles size={12} /> Measured by Nexus: {g.metricLabel}
          </span>
        )}
      </button>
      {g.canApprove && onApprove && (
        <div style={{ padding: '0 12px 10px' }}>
          <button type="button" className="primary-btn" onClick={() => onApprove(g)} style={{ ...TAP, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Check size={14} /> Approve
          </button>
        </div>
      )}
    </div>
  );
}

export function GoalList({ goals, onOpen, onApprove, showOwner = false, empty = 'No goals yet.' }) {
  if (!goals?.length) return <div style={{ ...muted, padding: '6px 2px' }}>{empty}</div>;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {goals.map(g => <GoalRow key={g.id} goal={g} onOpen={onOpen} onApprove={onApprove} showOwner={showOwner} />)}
    </div>
  );
}

const field = { display: 'grid', gap: 5, minWidth: 0 };
const BY_HAND = '';

// Which kinds of goal this person may set (the server checks the same:
// backend/performance.check_create).
function levelsFor(ctx) {
  const out = [{ key: 'personal', label: 'Personal' }];
  if (ctx?.isHr || ctx?.hasTeam) out.push({ key: 'department', label: 'Department' });
  if (ctx?.isHr) out.push({ key: 'company', label: 'Company' });
  return out;
}

// `defaults.owners` = [emails] preselects who it is for (a manager's team).
export function GoalFormModal({ ctx, goal = null, defaults = {}, parents = [], onClose, onSaved, toastErr }) {
  const editing = !!goal;
  const people = usePeople();
  const metrics = ctx?.metrics || [];
  const [f, setF] = useState(() => ({
    title: goal?.title || '', description: goal?.description || '',
    level: goal?.level || defaults.level || 'personal',
    owners: goal ? [goal.ownerEmail] : (defaults.owners || [defaults.ownerEmail || ctx?.email].filter(Boolean)),
    ownerEmail: goal?.ownerEmail || defaults.ownerEmail || ctx?.email || '',
    companyId: goal?.companyId || defaults.companyId || ctx?.hrCompanies?.[0]?.id || ctx?.company || '',
    department: goal?.department || defaults.department || ctx?.department || '',
    metricKey: goal ? (goal.metricKey || BY_HAND) : (defaults.metricKey ?? BY_HAND),
    measure: goal?.measure || 'percent', targetValue: goal?.targetValue ?? '',
    unit: goal?.unit || '', dueOn: goal?.dueOn || '', parentId: goal?.parentId || '',
  }));
  const [more, setMore] = useState(!!(goal?.parentId || goal?.description));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (v) => setF(p => ({ ...p, [k]: v }));
  const levels = levelsFor(ctx);
  const metric = metrics.find(m => m.key === f.metricKey);
  const personal = f.level === 'personal';
  // Who it is for: yourself, or - for a manager - one or several direct reports.
  const forChoices = useMemo(() => {
    const me = { email: ctx?.email, name: `${ctx?.name || ctx?.email} (Me)` };
    return [me, ...(ctx?.reports || []).map(r => ({ email: r.email, name: r.name }))].filter(p => p.email);
  }, [ctx]);
  const ownerChoices = useMemo(() => (ctx?.isHr ? people : forChoices), [ctx, people, forChoices]);
  const parentChoices = parents.filter(p => p.id !== goal?.id && !p.archived);
  const needsTarget = !!metric || f.measure === 'number';
  const dirty = !!(f.title || f.description);

  async function save() {
    if (!f.title.trim()) { setErr('Give the goal a title.'); return; }
    if (needsTarget && (f.targetValue === '' || f.targetValue === null)) { setErr('Set the target.'); return; }
    if (personal && !editing && !f.owners.length) { setErr('Pick who it is for.'); return; }
    setBusy(true); setErr('');
    const body = {
      title: f.title.trim(), description: f.description, due_on: f.dueOn || '', parent_id: f.parentId || '',
      metric_key: f.metricKey || '',
      ...(metric ? { target_value: Number(f.targetValue) } : {
        measure: f.measure, unit: f.unit, target_value: f.measure === 'number' ? Number(f.targetValue) : undefined, start_value: 0,
      }),
    };
    try {
      let out;
      if (editing) out = await api.perfGoalUpdate(goal.id, body);
      else if (personal && f.owners.length > 1) out = await api.perfGoalCreate({ ...body, level: 'personal', owner_emails: f.owners });
      else out = await api.perfGoalCreate({ ...body, level: f.level, owner_email: personal ? f.owners[0] : f.ownerEmail, company_id: f.companyId, department: f.department });
      onSaved?.(out);
    } catch (e) {
      setErr(e?.message || 'Could not save the goal.');
      toastErr?.(e?.message || 'Could not save the goal.');
    } finally { setBusy(false); }
  }

  const toggleOwner = (email) => setF(p => ({ ...p, owners: p.owners.includes(email) ? p.owners.filter(x => x !== email) : [...p.owners, email] }));

  return (
    <Modal title={editing ? 'Edit Goal' : 'Add Goal'} onClose={onClose} isDirty={dirty && !editing}
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : editing ? 'Save' : 'Add Goal'}</button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minHeight: 0 }}>
        {err && <ErrorBanner message={err} />}
        <label style={field}>
          <span style={LBL}>Goal</span>
          <input className="form-input" value={f.title} onChange={e => set('title')(e.target.value)} placeholder="What do you want to achieve?"
            autoFocus style={{ fontSize: 16 }} />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <label style={field}>
            <span style={LBL}>Measured By</span>
            <select className="form-input" value={f.metricKey} onChange={e => set('metricKey')(e.target.value)} style={{ fontSize: 16 }}>
              <option value={BY_HAND}>I&apos;ll Update It</option>
              <optgroup label="Nexus Numbers (Update By Themselves)">
                {metrics.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
              </optgroup>
            </select>
          </label>
          {!metric && (
            <label style={field}>
              <span style={LBL}>Kept As</span>
              <select className="form-input" value={f.measure} onChange={e => set('measure')(e.target.value)} style={{ fontSize: 16 }}>
                {MEASURES.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            </label>
          )}
          {needsTarget && (
            <label style={field}>
              <span style={LBL}>{metric?.good === 'low' ? 'Target (At Most)' : 'Target'}{metric?.unit ? ` (${metric.unit})` : ''}</span>
              <input className="form-input" type="number" inputMode="decimal" value={f.targetValue} onChange={e => set('targetValue')(e.target.value)}
                placeholder={metric?.unit === '%' ? '95' : '40'} style={{ fontSize: 16 }} />
            </label>
          )}
          <div style={field}>
            <span style={LBL}>Due Date</span>
            <span className="form-input" style={{ display: 'flex', alignItems: 'center' }}>
              <DateField value={f.dueOn} onChange={set('dueOn')} placeholder="6 months from now" style={{ width: '100%' }} />
            </span>
          </div>
        </div>
        {metric && <div style={{ ...muted, fontSize: 12, marginTop: -6 }}>{metric.description}. Nexus keeps the number - no check-ins needed.</div>}
        {!editing && levels.length > 1 && (
          <label style={{ ...field, maxWidth: 260 }}>
            <span style={LBL}>Type</span>
            <select className="form-input" value={f.level} onChange={e => set('level')(e.target.value)} style={{ fontSize: 16 }}>
              {levels.map(l => <option key={l.key} value={l.key}>{l.label}</option>)}
            </select>
          </label>
        )}
        {!editing && personal && forChoices.length > 1 && !ctx?.isHr && (
          <div style={field}>
            <span style={LBL}>For</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {forChoices.map(p => (
                <label key={p.email} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, padding: '6px 10px', minHeight: 36,
                  border: '1px solid var(--line)', borderRadius: 999, cursor: 'pointer', background: f.owners.includes(p.email) ? 'var(--wk-brand-tint)' : 'transparent' }}>
                  <input type="checkbox" checked={f.owners.includes(p.email)} onChange={() => toggleOwner(p.email)} /> {p.name}
                </label>
              ))}
            </div>
          </div>
        )}
        {!editing && (ctx?.isHr && personal) && (
          <div style={{ ...field, maxWidth: 320 }}>
            <span style={LBL}>For</span>
            <PersonSelect value={f.owners[0] || ''} onChange={v => set('owners')(v ? [v] : [])} people={ownerChoices} allowNone={false} ariaLabel="For" />
          </div>
        )}
        {f.level === 'company' && !editing && (ctx?.hrCompanies || []).length > 1 && (
          <label style={{ ...field, maxWidth: 320 }}>
            <span style={LBL}>Company</span>
            <select className="form-input" value={f.companyId} onChange={e => set('companyId')(e.target.value)}>
              {(ctx?.hrCompanies || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        {f.level === 'department' && !editing && (
          <label style={{ ...field, maxWidth: 320 }}>
            <span style={LBL}>Department</span>
            <input className="form-input" value={f.department} disabled={!ctx?.isHr} onChange={e => set('department')(e.target.value)} />
          </label>
        )}
        {!more ? (
          <button type="button" className="secondary-btn" onClick={() => setMore(true)} style={{ alignSelf: 'flex-start' }}>Add a Note or Link It to a Bigger Goal</button>
        ) : (<>
          {parentChoices.length > 0 && (
            <label style={{ ...field, maxWidth: 420 }}>
              <span style={LBL}>Supports</span>
              <select className="form-input" value={f.parentId} onChange={e => set('parentId')(e.target.value)}>
                <option value="">Nothing - a goal of its own</option>
                {parentChoices.map(p => <option key={p.id} value={p.id}>{p.title} ({LEVEL_LABEL[p.level]})</option>)}
              </select>
            </label>
          )}
          <label style={{ ...field, flex: 1 }} className="nx-fill">
            <span style={LBL}>Note</span>
            <textarea className="form-input" value={f.description} onChange={e => set('description')(e.target.value)}
              placeholder="What does done look like?" style={{ fontFamily: 'inherit', fontSize: 16 }} />
          </label>
        </>)}
      </div>
    </Modal>
  );
}

function CheckinForm({ goal, onSaved, toastErr }) {
  const [value, setValue] = useState(goal.measure === 'done' ? (Number(goal.currentValue) >= 1 ? 1 : 0) : goal.currentValue ?? 0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const out = await api.perfGoalCheckin(goal.id, { value: Number(value), note });
      setNote('');
      onSaved?.(out);
    } catch (e) { toastErr?.(e?.message || 'Could not save the update.'); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, border: '1px solid var(--line)', borderRadius: 12, flex: 1, minHeight: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 700 }}>Update Progress</div>
      {goal.measure === 'done' ? (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, minHeight: 44 }}>
          <input type="checkbox" checked={Number(value) >= 1} onChange={e => setValue(e.target.checked ? 1 : 0)} /> Done
        </label>
      ) : (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
          <span style={LBL}>{goal.measure === 'percent' ? 'Percent Done' : `Now${goal.unit ? ` (${goal.unit})` : ''}`}</span>
          <input className="form-input" type="number" inputMode="decimal" value={value} min={goal.measure === 'percent' ? 0 : undefined}
            max={goal.measure === 'percent' ? 100 : undefined} onChange={e => setValue(e.target.value)} style={{ width: 120, fontSize: 16 }} />
        </label>
      )}
      <label className="nx-fill" style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1 }}>
        <span style={LBL}>Note (Optional)</span>
        <textarea className="form-input" value={note} onChange={e => setNote(e.target.value)} placeholder="What moved, what is in the way?" style={{ fontFamily: 'inherit', fontSize: 16 }} />
      </label>
      <div><button type="button" className="primary-btn" onClick={save} disabled={busy} style={TAP}>{busy ? 'Saving…' : 'Save Update'}</button></div>
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
  async function approve() {
    try {
      const out = await api.perfGoalApprove(g.id);
      api.perfGoal(g.id).then(changed).catch(() => changed(out));
      toastOk?.('Goal approved.');
    } catch (e) { toastErr?.(e?.message || 'Could not approve the goal.'); }
  }
  if (editing && g) {
    return <GoalFormModal ctx={ctx} goal={g} parents={parents} onClose={() => setEditing(false)} toastErr={toastErr}
      onSaved={() => { setEditing(false); api.perfGoal(g.id).then(changed).catch(() => {}); toastOk?.('Goal saved.'); }} />;
  }
  const meta = GOAL_STATUS[g?.status] || GOAL_STATUS.on_track;
  return (
    <Modal title={g ? g.title : 'Goal'} onClose={onClose}
      footer={g?.canEdit || g?.archived || g?.canApprove ? <>
        {(g.canEdit || g.archived) && (
          <button type="button" className="secondary-btn" onClick={archive} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Archive size={14} /> {g.archived ? 'Restore' : 'Archive'}
          </button>
        )}
        {g.canEdit && !g.archived && <button type="button" className="secondary-btn" onClick={() => setEditing(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Pencil size={14} /> Edit</button>}
        {g.canApprove && <button type="button" className="primary-btn" onClick={approve} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Check size={14} /> Approve</button>}
        <button type="button" className={g.canApprove ? 'secondary-btn' : 'primary-btn'} onClick={onClose}>Done</button>
      </> : <button type="button" className="primary-btn" onClick={onClose}>Done</button>}>
      {err ? <ErrorBanner message={err} /> : !g ? <LoadingState size="section" label="Loading the goal" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <GoalStatus status={g.status} size="md" />
            {g.proposed && <StatusLabel label="Proposed" color="#64748b" size="md" />}
            <span style={muted}>{[g.level !== 'personal' ? `${LEVEL_LABEL[g.level]} Goal` : '', g.ownerName, g.dueOn ? `Due ${formatDate(g.dueOn)}` : ''].filter(Boolean).join(' · ')}</span>
          </div>
          {g.proposed && <div style={muted}>{g.canApprove ? 'Proposed - approve it so it counts as agreed.' : 'Proposed - waiting for your manager to approve it.'}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ flex: 1 }}><ProgressBar value={g.progress} color={meta.color} /></span>
            <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{measureText(g)}</span>
          </div>
          {g.measuredByNexus && (
            <div style={{ ...muted, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Sparkles size={13} /> Measured by Nexus: {g.metricLabel}, {formatDate(g.periodStart)} to {formatDate(g.periodEnd)}. It updates by itself.
            </div>
          )}
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
          {g.canCheckIn && <CheckinForm key={g.lastCheckinAt} goal={g} onSaved={(out) => { changed(out); toastOk?.('Progress saved.'); }} toastErr={toastErr} />}
          {!g.measuredByNexus && (
            <div>
              <div style={{ ...LBL, marginBottom: 6 }}>Updates</div>
              {!g.checkins?.length ? <div style={muted}>No updates yet.</div> : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {g.checkins.map(c => (
                    <div key={c.id} style={{ borderLeft: `3px solid ${(GOAL_STATUS[c.status] || meta).color}`, padding: '4px 0 4px 10px' }}>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {formatDateTime(c.at)} · {c.byName}{c.value !== null && c.value !== undefined ? ` · ${measureText({ ...g, currentValue: c.value })}` : ''}
                      </div>
                      {c.note && <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginTop: 2 }}>{c.note}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export function AddGoalButton({ onClick, label = 'Add Goal', disabled = false, title }) {
  return (
    <button type="button" className="secondary-btn" onClick={onClick} disabled={disabled} title={title}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', minHeight: 36 }}>
      <Plus size={14} /> {label}
    </button>
  );
}

export const GoalIcon = Target;
