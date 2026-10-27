// People > Performance > Review Cycles (Neil, Oct 27 2026): HR creates a cycle
// for a company (who is in it, the deadlines, the questions), launches it,
// and follows it on one dashboard: how many are at each stage, who is
// overdue, a Nudge that reminds whoever it waits on. No calibration, no
// 9-box (Neil).
import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, Plus, Trash2, Bell, Rocket } from 'lucide-react';
import { api } from '../api';
import { Modal, DateField, ChipMultiSelect } from '../tasks/components';
import { StatusLabel } from '../components/StatusLabel';
import { SkeletonBlocks, LoadingState, ErrorBanner } from '../components/AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import { ReviewModal, ReviewStage } from './Reviews';
import { ProgressBar } from './Goals';
import { REVIEW_STAGE, REVIEW_STAGE_KEYS, card, cardHead, HD, LBL, muted } from './lib';

const TYPES = [['full_time', 'Full-Time'], ['part_time', 'Part-Time'], ['contractor', 'Contractor'], ['intern', 'Intern']];
const CYCLE_STATUS = { draft: { label: 'Draft', color: '#64748b' }, active: { label: 'Active', color: '#2563eb' }, closed: { label: 'Closed', color: '#16a34a' } };
const DEFAULT_QUESTIONS = [
  { kind: 'rating', text: 'Overall, how did this period go?' },
  { kind: 'text', text: 'What went well?' },
  { kind: 'text', text: 'What could have gone better?' },
  { kind: 'text', text: 'What should the focus be for the next period?' },
];
const field = { display: 'grid', gap: 5, minWidth: 0 };

function DateBox({ value, onChange, label, disabled }) {
  return (
    <div style={field}>
      <span style={LBL}>{label}</span>
      <span className="form-input" style={{ display: 'flex', alignItems: 'center' }}>
        <DateField value={value} onChange={onChange} placeholder="Pick a day" disabled={disabled} style={{ width: '100%' }} />
      </span>
    </div>
  );
}

function CycleFormModal({ company, cycle = null, onClose, onSaved, toastErr }) {
  const draft = !cycle || cycle.status === 'draft';
  const [f, setF] = useState(() => ({
    name: cycle?.name || '', periodStart: cycle?.periodStart || '', periodEnd: cycle?.periodEnd || '',
    selfDue: cycle?.selfDue || '', managerDue: cycle?.managerDue || '',
    departments: cycle?.filters?.departments || [], types: cycle?.filters?.types || ['full_time', 'part_time'],
    startedBy: cycle?.filters?.startedBy || '', includeGoals: cycle ? !!cycle.includeGoals : true,
    questions: (cycle?.questions || DEFAULT_QUESTIONS).map((q, i) => ({ id: q.id || `q${i + 1}`, kind: q.kind, text: q.text })),
  }));
  const [depts, setDepts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.perfReviewDepartments(company).then(d => setDepts(d || [])).catch(() => {}); }, [company]);
  const set = (k) => (v) => setF(p => ({ ...p, [k]: v }));
  const setQ = (i, patch) => setF(p => ({ ...p, questions: p.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) }));
  async function save() {
    if (!f.name.trim()) { setErr('Name the cycle.'); return; }
    setBusy(true); setErr('');
    const body = {
      name: f.name.trim(), period_start: f.periodStart, period_end: f.periodEnd, self_due: f.selfDue, manager_due: f.managerDue,
      ...(draft ? { filters: { departments: f.departments, types: f.types, startedBy: f.startedBy },
        questions: f.questions.filter(q => q.text.trim()), include_goals: f.includeGoals } : {}),
    };
    try {
      const out = cycle ? await api.perfCycleUpdate(cycle.id, body) : await api.perfCycleCreate({ ...body, company_id: company });
      onSaved?.(out);
    } catch (e) { setErr(e?.message || 'Could not save the cycle.'); toastErr?.(e?.message || 'Could not save the cycle.'); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={cycle ? 'Edit Review Cycle' : 'New Review Cycle'} onClose={onClose} isDirty={!cycle && !!f.name}
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : cycle ? 'Save' : 'Create Cycle'}</button>
      </>}>
      <div style={{ display: 'grid', gap: 14 }}>
        {err && <ErrorBanner message={err} />}
        <label style={field}>
          <span style={LBL}>Name</span>
          <input className="form-input" value={f.name} onChange={e => set('name')(e.target.value)} placeholder="2026 Annual Review" autoFocus />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <DateBox label="Period From" value={f.periodStart} onChange={set('periodStart')} disabled={!draft} />
          <DateBox label="Period To" value={f.periodEnd} onChange={set('periodEnd')} disabled={!draft} />
          <DateBox label="Self Reviews Due" value={f.selfDue} onChange={set('selfDue')} />
          <DateBox label="Manager Reviews Due" value={f.managerDue} onChange={set('managerDue')} />
        </div>
        {draft && (<>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, alignItems: 'start' }}>
            <div style={field}>
              <span style={LBL}>Departments</span>
              <ChipMultiSelect value={f.departments} onChange={set('departments')} options={depts.map(d => ({ id: d, label: d }))} placeholder="Every department" />
            </div>
            <div style={field}>
              <span style={LBL}>Who</span>
              <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', paddingTop: 6 }}>
                {TYPES.map(([k, l]) => (
                  <label key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13 }}>
                    <input type="checkbox" checked={f.types.includes(k)}
                      onChange={e => set('types')(e.target.checked ? [...f.types, k] : f.types.filter(x => x !== k))} /> {l}
                  </label>
                ))}
              </span>
            </div>
            <DateBox label="Started On or Before" value={f.startedBy} onChange={set('startedBy')} />
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={f.includeGoals} onChange={e => set('includeGoals')(e.target.checked)} /> Managers May Attach Goal Progress
          </label>
          <div style={{ display: 'grid', gap: 8 }}>
            <span style={LBL}>Questions</span>
            <div style={{ ...muted, fontSize: 12, marginTop: -4 }}>Both the employee and the manager answer each one. The rating scale and the company values come from Settings &gt; Performance.</div>
            {f.questions.map((q, i) => (
              <div key={q.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select className="form-input" value={q.kind} onChange={e => setQ(i, { kind: e.target.value })} aria-label="Question type" style={{ width: 120 }}>
                  <option value="rating">Rating</option><option value="text">Text</option>
                </select>
                <input className="form-input" value={q.text} onChange={e => setQ(i, { text: e.target.value })} aria-label={`Question ${i + 1}`} style={{ flex: 1 }} />
                <button type="button" className="secondary-btn" aria-label="Remove question" title="Remove" style={{ padding: 6 }}
                  onClick={() => setF(p => ({ ...p, questions: p.questions.filter((_, j) => j !== i) }))}><Trash2 size={14} /></button>
              </div>
            ))}
            <div><button type="button" className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => setF(p => ({ ...p, questions: [...p.questions, { id: `q${Date.now()}`, kind: 'text', text: '' }] }))}><Plus size={14} /> Add Question</button></div>
          </div>
        </>)}
        {!draft && <div style={muted}>The cycle is running: only its name and deadlines can change.</div>}
      </div>
    </Modal>
  );
}

function CycleModal({ cycleId, onClose, onChanged, toastOk, toastErr }) {
  const [c, setC] = useState(null);
  const [err, setErr] = useState('');
  const [people, setPeople] = useState(null);
  const [edit, setEdit] = useState(false);
  const [open, setOpen] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.perfCycle(cycleId).then(setC).catch(e => setErr(e?.message || 'Could not load the cycle.')), [cycleId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (c?.status === 'draft' && people === null) api.perfCycleParticipants(c.id).then(setPeople).catch(() => setPeople([])); }, [c, people]);
  const act = async (p, ok) => {
    setBusy(true);
    try { const out = await p(); if (ok) toastOk?.(typeof ok === 'function' ? ok(out) : ok); await load(); onChanged?.(); }
    catch (e) { toastErr?.(e?.message || 'Could not do that.'); }
    finally { setBusy(false); }
  };
  const total = c?.counts?.total || 0;
  const done = c?.counts?.complete || 0;
  return (
    <Modal title={c ? c.name : 'Review Cycle'} onClose={onClose} width="72vw"
      footer={c ? <>
        {c.status !== 'closed' && <button type="button" className="secondary-btn" onClick={() => setEdit(true)}>Edit</button>}
        {c.status === 'active' && <button type="button" className="secondary-btn" disabled={busy} onClick={() => act(() => api.perfCycleClose(c.id), 'Cycle closed.')}>Close Cycle</button>}
        {c.status === 'draft' && <button type="button" className="primary-btn" disabled={busy || !people?.length} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={() => act(() => api.perfCycleLaunch(c.id), (out) => `Launched - ${out.launched} self reviews sent.`)}><Rocket size={14} /> Launch</button>}
        <button type="button" className={c.status === 'draft' ? 'secondary-btn' : 'primary-btn'} onClick={onClose}>Done</button>
      </> : <button type="button" className="primary-btn" onClick={onClose}>Done</button>}>
      {err ? <ErrorBanner message={err} /> : !c ? <LoadingState size="section" label="Loading the cycle" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <StatusLabel label={CYCLE_STATUS[c.status]?.label || c.status} color={CYCLE_STATUS[c.status]?.color} size="md" />
            <span style={muted}>{[c.periodStart ? `${formatDate(c.periodStart)} to ${formatDate(c.periodEnd)}` : '',
              c.selfDue ? `Self reviews due ${formatDate(c.selfDue)}` : '', c.managerDue ? `Manager reviews due ${formatDate(c.managerDue)}` : ''].filter(Boolean).join(' · ')}</span>
          </div>
          {c.status === 'draft' ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={LBL}>Who Is In It {people ? `(${people.length})` : ''}</div>
              {people === null ? <SkeletonBlocks count={2} height={36} /> : !people.length
                ? <div style={muted}>Nobody matches the filters - edit the cycle.</div>
                : <div style={{ display: 'grid', gap: 2 }}>{people.map(p => (
                    <div key={p.email} style={{ fontSize: 13, display: 'flex', gap: 8 }}>
                      <span style={{ flex: 1 }}>{p.name}</span><span style={muted}>{p.department}{p.hasManager ? '' : ' · No manager - HR writes it'}</span>
                    </div>))}</div>}
            </div>
          ) : (<>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
              {REVIEW_STAGE_KEYS.map(k => (
                <div key={k} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px' }}>
                  <div style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{c.counts?.[k] || 0}</div>
                  <div style={{ ...muted, fontSize: 12 }}>{REVIEW_STAGE[k].label}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 200px' }}><ProgressBar value={total ? Math.round((done / total) * 100) : 0} label="Complete" /></span>
              <span style={muted}>{done} of {total} complete{c.counts?.overdue ? ` · ${c.counts.overdue} overdue` : ''}</span>
              {c.status === 'active' && (
                <button type="button" className="secondary-btn" disabled={busy || !c.counts?.overdue} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  onClick={() => act(() => api.perfCycleNudge(c.id, { overdue_only: true }), (out) => (out.nudged ? `Reminded ${out.nudged}.` : 'Nobody to remind - each was reminded in the last day.'))}>
                  <Bell size={14} /> Nudge Overdue
                </button>
              )}
            </div>
            <div role="table" aria-label="Reviews" style={{ display: 'grid' }}>
              {(c.reviews || []).map(r => (
                <div key={r.id} role="row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
                  <button type="button" role="cell" onClick={() => setOpen(r.id)}
                    style={{ flex: '1 1 200px', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)', padding: 0 }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{r.employeeName}</span>
                    <span style={{ display: 'block', ...muted, fontSize: 12 }}>Manager: {r.managerName}{r.nudgedAt ? ` · Reminded ${formatDateTime(r.nudgedAt)}` : ''}</span>
                  </button>
                  {r.overdue && <StatusLabel label="Overdue" color="#dc2626" size="sm" />}
                  <ReviewStage stage={r.stage} />
                  {c.status === 'active' && ['self_review', 'manager_review'].includes(r.stage) && (
                    <button type="button" className="secondary-btn" disabled={busy} title="Remind whoever it waits on" style={{ padding: '4px 8px', fontSize: 12 }}
                      onClick={() => act(() => api.perfCycleNudge(c.id, { review_ids: [r.id], overdue_only: false }), (out) => (out.nudged ? 'Reminder sent.' : 'Already reminded in the last day.'))}>Nudge</button>
                  )}
                </div>
              ))}
            </div>
          </>)}
        </div>
      )}
      {edit && c && <CycleFormModal company={c.companyId} cycle={c} onClose={() => setEdit(false)} toastErr={toastErr}
        onSaved={() => { setEdit(false); setPeople(null); load(); onChanged?.(); toastOk?.('Cycle saved.'); }} />}
      {open && <ReviewModal reviewId={open} onClose={() => { setOpen(''); load(); }} toastOk={toastOk} toastErr={toastErr} />}
    </Modal>
  );
}

export default function ReviewCycles({ company, toastOk, toastErr }) {
  const [cycles, setCycles] = useState(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(false);
  const [open, setOpen] = useState('');
  const load = useCallback(() => {
    if (!company) return;
    api.perfCycles(company).then(r => { setErr(''); setCycles(r); }).catch(e => setErr(e?.message || 'Could not load the review cycles.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);
  return (
    <section style={card} aria-label="Review Cycles">
      <div style={cardHead}>
        <span className="wkc-chip"><ClipboardCheck size={14} /></span>
        <span style={HD}>Review Cycles</span>
        <button type="button" className="secondary-btn" onClick={() => setForm(true)} disabled={!company}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}><Plus size={14} /> New Review Cycle</button>
      </div>
      {err ? <ErrorBanner message={err} onRetry={load} /> : cycles === null ? <SkeletonBlocks count={2} height={52} /> : !cycles.length
        ? <div style={muted}>No review cycles yet. Create one, check who is in it, then launch it.</div> : (
          <div style={{ display: 'grid', gap: 8 }}>
            {cycles.map(c => {
              const total = c.counts?.total || 0;
              return (
                <button key={c.id} type="button" onClick={() => setOpen(c.id)}
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '6px 12px', alignItems: 'center', width: '100%', textAlign: 'left',
                    padding: '11px 12px', border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)' }}>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{c.name}</span>
                    <span style={{ display: 'block', ...muted, fontSize: 12 }}>
                      {c.status === 'draft' ? 'Not launched yet' : `${c.counts?.complete || 0} of ${total} complete${c.counts?.overdue ? ` · ${c.counts.overdue} overdue` : ''}`}
                      {c.managerDue ? ` · Manager reviews due ${formatDate(c.managerDue)}` : ''}
                    </span>
                  </span>
                  <StatusLabel label={CYCLE_STATUS[c.status]?.label || c.status} color={CYCLE_STATUS[c.status]?.color} size="sm" />
                  {c.status !== 'draft' && <span style={{ gridColumn: '1 / -1' }}><ProgressBar value={total ? Math.round(((c.counts?.complete || 0) / total) * 100) : 0} label={`${c.name} complete`} /></span>}
                </button>
              );
            })}
          </div>
        )}
      {form && <CycleFormModal company={company} onClose={() => setForm(false)} toastErr={toastErr}
        onSaved={(c) => { setForm(false); load(); setOpen(c.id); toastOk?.('Cycle created - check who is in it, then launch it.'); }} />}
      {open && <CycleModal cycleId={open} onClose={() => setOpen('')} onChanged={load} toastOk={toastOk} toastErr={toastErr} />}
    </section>
  );
}
