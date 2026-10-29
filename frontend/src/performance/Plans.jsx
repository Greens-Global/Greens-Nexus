// Improvement plans (Neil, Oct 29 2026: "add all the bigger features").
// Plain on purpose: why, what has to change and how it is measured, the
// support given, a start and an end. The manager drafts it, HR starts it,
// the employee acknowledges it; check-ins as it runs; HR closes it with an
// outcome. backend/perf_plans.py holds the rules; this draws what it says.
import { useCallback, useEffect, useState } from 'react';
import { LifeBuoy, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { Modal, DateField } from '../tasks/components';
import { StatusLabel } from '../components/StatusLabel';
import { SkeletonBlocks, LoadingState, ErrorBanner } from '../components/AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import { NX } from '../tasks/theme';
import { Segmented } from './MyNumbers';
import { card, cardHead, HD, LBL, muted, TAP } from './lib';
import Figures from './Figures';

const PLAN_STATUS = {
  draft: { label: 'Draft', color: '#64748b' },
  proposed: { label: 'With HR', color: NX.purple },
  active: { label: 'Active', color: NX.amber },
  closed: { label: 'Closed', color: '#64748b' },
};
const OUTCOMES = [{ key: 'met', label: 'Met' }, { key: 'not_met', label: 'Not Met' }, { key: 'canceled', label: 'Canceled' }];
const RESULTS = [{ key: 'met', label: 'Met' }, { key: 'not', label: 'Not Met' }];

const blank = () => ({ id: `n${Math.random().toString(36).slice(2, 9)}`, text: '', measure: '' });
const field = { display: 'grid', gap: 5 };

function PlanStatus({ p, size = 'sm' }) {
  const s = PLAN_STATUS[p.status] || PLAN_STATUS.draft;
  const label = p.status === 'closed' && p.outcomeLabel ? `Closed - ${p.outcomeLabel}` : s.label;
  return <StatusLabel label={label} color={p.status === 'closed' && p.outcome === 'met' ? NX.green : p.status === 'closed' && p.outcome === 'not_met' ? NX.red : s.color} size={size} />;
}

function Part({ title, children, aside }) {
  return (
    <section style={{ borderTop: '1px solid var(--line)', paddingTop: 12, display: 'grid', gap: 8, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>{title}</span>{aside}
      </div>
      {children}
    </section>
  );
}

function PlanForm({ f, set }) {
  const exp = f.expectations;
  const setExp = (i, k, v) => set('expectations')(exp.map((e, j) => (j === i ? { ...e, [k]: v } : e)));
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <label style={field}><span style={LBL}>Title</span>
        <input className="form-input" value={f.title} onChange={e => set('title')(e.target.value)} style={{ fontSize: 16 }} /></label>
      <label style={field}><span style={LBL}>Why the Plan Is Needed</span>
        <textarea className="form-input" rows={3} value={f.reason} onChange={e => set('reason')(e.target.value)} style={{ fontSize: 16, resize: 'vertical' }}
          placeholder="What has happened, with dates and examples." /></label>
      <div style={field}>
        <span style={LBL}>What Has to Change</span>
        {exp.map((e, i) => (
          <div key={e.id} className="nx-plan-exp">
            <span style={{ ...muted, fontVariantNumeric: 'tabular-nums', paddingTop: 10 }}>{i + 1}.</span>
            <input className="form-input" value={e.text} onChange={x => setExp(i, 'text', x.target.value)} placeholder="Close every month on time"
              aria-label={`Expectation ${i + 1}`} style={{ fontSize: 16 }} />
            <input className="form-input" value={e.measure} onChange={x => setExp(i, 'measure', x.target.value)} placeholder="How it is measured - by day 5, every month"
              aria-label={`How expectation ${i + 1} is measured`} style={{ fontSize: 16 }} />
            <button type="button" className="nx-perf-icon-btn" onClick={() => set('expectations')(exp.filter((_, j) => j !== i))}
              aria-label={`Remove expectation ${i + 1}`} disabled={exp.length === 1}><Trash2 size={15} /></button>
          </div>
        ))}
        {exp.length < 10 && <div><button type="button" className="secondary-btn" onClick={() => set('expectations')([...exp, blank()])}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 36 }}><Plus size={14} /> Add Expectation</button></div>}
      </div>
      <label style={field}><span style={LBL}>Support We Will Give</span>
        <textarea className="form-input" rows={2} value={f.support} onChange={e => set('support')(e.target.value)} style={{ fontSize: 16, resize: 'vertical' }}
          placeholder="Weekly 1:1s, training, a buddy, clearer priorities." /></label>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ ...field, flex: '1 1 160px' }}><span style={LBL}>Starts</span><DateField value={f.startOn} onChange={set('startOn')} placeholder="Pick a day" style={{ width: '100%' }} /></label>
        <label style={{ ...field, flex: '1 1 160px' }}><span style={LBL}>Ends</span><DateField value={f.endOn} onChange={set('endOn')} placeholder="30, 60 or 90 days on" style={{ width: '100%' }} /></label>
      </div>
    </div>
  );
}

const toForm = (p) => ({
  title: p?.title || 'Performance Improvement Plan', reason: p?.reason || '', support: p?.support || '',
  expectations: p?.expectations?.length ? p.expectations.map(e => ({ ...e })) : [blank()],
  startOn: p?.startOn || '', endOn: p?.endOn || '',
});
const toBody = (f) => ({
  title: f.title, reason: f.reason, support: f.support, start_on: f.startOn, end_on: f.endOn,
  expectations: f.expectations.filter(e => e.text.trim()).map(e => ({ id: e.id.startsWith('n') ? '' : e.id, text: e.text, measure: e.measure, result: e.result || '' })),
});

// `planId` - open one; `newFor` {email, name} - draft a new one.
export function PlanModal({ planId = '', newFor = null, onClose, onChanged, toastOk, toastErr }) {
  const [p, setP] = useState(null);
  const [err, setErr] = useState('');
  const [f, setF] = useState(newFor ? toForm(null) : null);
  const [saved, setSaved] = useState(newFor ? JSON.stringify(toForm(null)) : '');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('');              // '' | extend | close | ack
  const [note, setNote] = useState('');
  const [endOn, setEndOn] = useState('');
  const [outcome, setOutcome] = useState('met');
  const [results, setResults] = useState({});
  const [checkin, setCheckin] = useState('');
  const take = useCallback((x) => { setP(x); const fx = toForm(x); setF(fx); setSaved(JSON.stringify(fx)); setResults(Object.fromEntries((x.expectations || []).map(e => [e.id, e.result || '']))); }, []);
  useEffect(() => {
    if (!planId) return undefined;
    let live = true;
    api.perfPlan(planId).then(x => { if (live) take(x); }).catch(e => { if (live) setErr(e?.message || 'Could not load the plan.'); });
    return () => { live = false; };
  }, [planId, take]);
  const set = (k) => (v) => setF(x => ({ ...x, [k]: v }));
  const editing = newFor || p?.can.edit;
  const dirty = !!editing && !!f && JSON.stringify(f) !== saved;
  const act = async (fn, ok) => {
    setBusy(true);
    try { const x = await fn(); take(x); setMode(''); setNote(''); toastOk?.(ok); onChanged?.(); return x; }
    catch (e) { toastErr?.(e?.message || 'Could not do that.'); return null; }
    finally { setBusy(false); }
  };
  const save = () => (p ? act(() => api.perfPlanUpdate(p.id, toBody(f)), 'Saved.')
    : act(() => api.perfPlanCreate({ ...toBody(f), employee: newFor.email }), 'Draft saved.'));
  const saveThen = async (fn, ok) => { if (dirty && !(await save())) return; await act(fn, ok); };
  const who = p?.employeeName || newFor?.name || '';

  const footer = [];
  if (editing) footer.push(<button key="save" type="button" className="secondary-btn" disabled={busy || !dirty} onClick={save}>Save Draft</button>);
  if (p?.can.drop) footer.push(<button key="drop" type="button" className="secondary-btn" disabled={busy}
    onClick={() => act(() => api.perfPlanAct(p.id, 'close', { outcome: 'canceled' }), 'Dropped - the draft is kept as Canceled.')}>Drop Draft</button>);
  if (p?.can.sendToHr) footer.push(<button key="send" type="button" className="primary-btn" disabled={busy} onClick={() => saveThen(() => api.perfPlanAct(p.id, 'send'), 'Sent to HR.')}>Send to HR</button>);
  if (p?.can.start) footer.push(<button key="start" type="button" className="primary-btn" disabled={busy} onClick={() => saveThen(() => api.perfPlanAct(p.id, 'start'), 'Started - they have been told.')}>Start Plan</button>);
  if (p?.can.extend) footer.push(<button key="ext" type="button" className="secondary-btn" disabled={busy} onClick={() => { setMode('extend'); setEndOn(''); }}>Extend</button>);
  if (p?.can.close) footer.push(<button key="close" type="button" className="primary-btn" disabled={busy} onClick={() => setMode('close')}>Close Plan</button>);
  if (p?.can.acknowledge) footer.push(<button key="ack" type="button" className="primary-btn" disabled={busy} onClick={() => setMode('ack')}>Acknowledge</button>);
  footer.push(<button key="done" type="button" className={footer.length ? 'secondary-btn' : 'primary-btn'} onClick={onClose}>{footer.length ? 'Close' : 'Done'}</button>);

  return (
    <Modal title={who ? `Improvement Plan - ${who}` : 'Improvement Plan'} onClose={onClose} width="72vw" isDirty={dirty} onSave={dirty ? save : undefined}
      footer={<>{footer}</>}>
      {err ? <ErrorBanner message={err} /> : !f ? <LoadingState size="section" label="Loading the plan" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {p && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <PlanStatus p={p} size="md" />
              <span style={muted}>{[p.startOn && p.endOn ? `${formatDate(p.startOn)} to ${formatDate(p.endOn)}` : '',
                p.managerName ? `Manager ${p.managerName}` : '', p.acknowledgedAt ? `Acknowledged ${formatDate(p.acknowledgedAt)}` : ''].filter(Boolean).join(' · ')}</span>
              {p.pastEnd && <StatusLabel label="Past Its End" color={NX.red} size="sm" />}
            </div>
          )}
          {editing ? (
            <>
              <div style={muted}>{newFor || p?.status === 'draft'
                ? `A draft is seen only by their manager and HR - never by ${who.split(' ')[0] || 'them'}. ${p?.role?.hr ? 'Start it when it is ready.' : 'Save it, then Send to HR - HR starts it with them.'}`
                : 'A manager sent this. Change what you need, then Start it.'}</div>
              <PlanForm f={f} set={set} />
            </>
          ) : (
            <>
              <Part title="Why the Plan Is Needed"><div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{p.reason}</div></Part>
              <Part title="What Has to Change">
                <div className="nx-perf-list" role="list">
                  {p.expectations.map((e, i) => (
                    <div key={e.id} className="nx-perf-row nx-plan-line" role="listitem">
                      <span style={{ ...muted, fontVariantNumeric: 'tabular-nums' }}>{i + 1}.</span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{e.text}</span>
                        {e.measure && <span style={{ display: 'block', ...muted }}>{e.measure}</span>}
                      </span>
                      {mode === 'close' ? (
                        <Segmented label={`Result ${i + 1}`} value={results[e.id] || ''} onChange={v => setResults(r => ({ ...r, [e.id]: v }))} options={RESULTS} />
                      ) : e.result ? <StatusLabel label={e.result === 'met' ? 'Met' : 'Not Met'} color={e.result === 'met' ? NX.green : NX.red} size="sm" /> : <span />}
                    </div>
                  ))}
                </div>
              </Part>
              {p.support && <Part title="Support We Will Give"><div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{p.support}</div></Part>}
            </>
          )}
          {mode === 'ack' && (
            <Part title="Acknowledge">
              <div style={muted}>Acknowledging means you have read the plan - not that you agree with all of it.</div>
              <label style={field}><span style={LBL}>Your Comments (Optional)</span>
                <textarea className="form-input" rows={3} value={note} onChange={e => setNote(e.target.value)} style={{ fontSize: 16 }} /></label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="secondary-btn" onClick={() => setMode('')}>Not Yet</button>
                <button type="button" className="primary-btn" disabled={busy} onClick={() => act(() => api.perfPlanAct(p.id, 'acknowledge', { comment: note }), 'Acknowledged.')}>I Have Read It</button>
              </div>
            </Part>
          )}
          {mode === 'extend' && (
            <Part title="Extend">
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <label style={{ ...field, flex: '0 1 200px' }}><span style={LBL}>New End Date</span><DateField value={endOn} onChange={setEndOn} placeholder="Pick a day" style={{ width: '100%' }} /></label>
                <label style={{ ...field, flex: '1 1 240px' }}><span style={LBL}>Why</span><input className="form-input" value={note} onChange={e => setNote(e.target.value)} style={{ fontSize: 16 }} /></label>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="secondary-btn" onClick={() => setMode('')}>Cancel</button>
                <button type="button" className="primary-btn" disabled={busy} onClick={() => act(() => api.perfPlanAct(p.id, 'extend', { end_on: endOn, note }), 'Extended - they have been told.')}>Extend Plan</button>
              </div>
            </Part>
          )}
          {mode === 'close' && (
            <Part title="Close the Plan">
              <div style={muted}>Mark each expectation above, then the outcome. Not Met does nothing by itself - ending employment is the Offboard flow in People.</div>
              <Segmented label="Outcome" value={outcome} onChange={setOutcome} options={OUTCOMES} />
              <label style={field}><span style={LBL}>Outcome Note</span>
                <textarea className="form-input" rows={3} value={note} onChange={e => setNote(e.target.value)} style={{ fontSize: 16 }} /></label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="secondary-btn" onClick={() => setMode('')}>Cancel</button>
                <button type="button" className="primary-btn" disabled={busy} onClick={() => act(() => api.perfPlanAct(p.id, 'close', { outcome, note, results }), 'Closed - they have been told.')}>Close Plan</button>
              </div>
            </Part>
          )}
          {p && p.status !== 'draft' && p.status !== 'proposed' && (
            <Part title="Check-Ins" aside={<span style={muted}>{p.checkins.length || 'None yet'}</span>}>
              {p.checkins.map(c => (
                <div key={c.id} style={{ display: 'grid', gap: 2 }}>
                  <span style={muted}>{c.byName} · {formatDateTime(c.at)}</span>
                  <span style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{c.note}</span>
                </div>
              ))}
              {p.can.checkin && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <label style={{ ...field, flex: '1 1 260px' }}><span style={LBL}>Add a Check-In</span>
                    <textarea className="form-input" rows={2} value={checkin} onChange={e => setCheckin(e.target.value)} style={{ fontSize: 16 }}
                      placeholder="How it is going against each expectation." /></label>
                  <button type="button" className="secondary-btn" style={TAP} disabled={busy || checkin.trim().length < 3}
                    onClick={async () => { if (await act(() => api.perfPlanAct(p.id, 'checkins', { note: checkin }), 'Check-in added - they have been told.')) setCheckin(''); }}>Add Check-In</button>
                </div>
              )}
            </Part>
          )}
          {p?.employeeComment && <Part title="Employee Comments"><div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{p.employeeComment}</div></Part>}
          {p?.outcomeNote && <Part title="Outcome"><div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{p.outcomeNote}</div></Part>}
          {p?.history?.length > 0 && (
            <Part title="History">
              {p.history.map((h, i) => <div key={i} style={muted}>{formatDateTime(h.at)} · {h.label} by {h.byName}{h.note ? ` - ${h.note}` : ''}</div>)}
            </Part>
          )}
        </div>
      )}
    </Modal>
  );
}

function PlanRows({ items, onOpen, showPerson = false }) {
  return (
    <div className="nx-perf-list" role="list">
      {items.map(p => (
        <div key={p.id} className="nx-perf-row" role="listitem">
          <button type="button" className="nx-perf-fb" onClick={() => onOpen(p)} style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{showPerson ? p.employeeName : p.title}</span>
              <span style={{ display: 'block', ...muted, fontSize: 12 }}>
                {[showPerson ? p.managerName && `Manager ${p.managerName}` : '', p.startOn && p.endOn ? `${formatDate(p.startOn)} to ${formatDate(p.endOn)}` : 'No dates yet',
                  p.status === 'active' && !p.acknowledgedAt ? 'Not acknowledged yet' : ''].filter(Boolean).join(' · ')}
              </span>
            </span>
            <span style={{ display: 'inline-flex', gap: 6 }}>
              {p.pastEnd && <StatusLabel label="Past Its End" color={NX.red} size="sm" />}
              <PlanStatus p={p} />
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}

// The plan card on a person's page. For the employee (`self`) it shows only
// when they have a started plan; for their manager or HR it lists the
// person's plans with Start an Improvement Plan.
export function PlanCard({ email = '', name = '', self = false, canStart = false, focusId = '', toastOk, toastErr }) {
  const [plans, setPlans] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(focusId);
  const [prevFocus, setPrevFocus] = useState(focusId);
  if (focusId !== prevFocus) { setPrevFocus(focusId); if (focusId) setOpen(focusId); }
  const [drafting, setDrafting] = useState(false);
  const load = useCallback(() => api.perfPlans(self ? {} : { person: email }).then(r => { const all = Array.isArray(r) ? r : []; setErr(''); setPlans(self ? all.filter(p => p.role?.employee) : all); })
    .catch(e => setErr(e?.message || 'Could not load the plans.')), [self, email]);
  useEffect(() => { load(); }, [load]);
  const live = (plans || []).some(p => ['draft', 'proposed', 'active'].includes(p.status));
  if (self && (!plans || !plans.length) && !open) return null;
  if (!self && !canStart && plans && !plans.length && !open) return null;
  const first = (name || '').split(' ')[0];
  return (
    <section style={card} aria-label="Improvement Plan">
      <div style={cardHead}>
        <span className="wkc-chip"><LifeBuoy size={14} /></span>
        <span style={HD}>{self ? 'Your Improvement Plan' : 'Improvement Plan'}</span>
        {canStart && !live && plans && (
          <button type="button" className="secondary-btn" onClick={() => setDrafting(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', minHeight: 36 }}><Plus size={14} /> Start a Plan</button>
        )}
      </div>
      {err ? <ErrorBanner message={err} onRetry={load} /> : plans === null ? <SkeletonBlocks count={1} height={48} /> : plans.length
        ? <PlanRows items={plans} onOpen={p => setOpen(p.id)} />
        : <div style={muted}>None. When {first || 'someone'} needs a clear path back on track, draft a plan here - HR starts it with them.</div>}
      {drafting && <PlanModal newFor={{ email, name }} onClose={() => { setDrafting(false); load(); }} onChanged={load} toastOk={toastOk} toastErr={toastErr} />}
      {open && <PlanModal planId={open} onClose={() => { setOpen(''); load(); }} onChanged={load} toastOk={toastOk} toastErr={toastErr} />}
    </section>
  );
}

const ADMIN_FILTERS = [
  { key: 'proposed', label: 'With HR', test: p => p.status === 'proposed' },
  { key: 'active', label: 'Active', test: p => p.status === 'active' },
  { key: 'past', label: 'Past Their End', test: p => p.pastEnd },
  { key: 'closed', label: 'Closed', test: p => p.status === 'closed' },
];

// People > Performance: every plan in the company HR looks after.
export function PlansAdmin({ company, toastOk, toastErr }) {
  const [plans, setPlans] = useState(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState('');
  const [open, setOpen] = useState('');
  const load = useCallback(() => {
    if (!company) return;
    api.perfPlans({ company }).then(r => { setErr(''); setPlans(Array.isArray(r) ? r : []); }).catch(e => setErr(e?.message || 'Could not load the plans.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);
  const shown = (plans || []).filter(p => p.status !== 'draft' || p.role.hr).filter(p => !pick || ADMIN_FILTERS.find(f => f.key === pick).test(p));
  return (
    <section style={card} aria-label="Improvement Plans">
      <div style={cardHead}>
        <span className="wkc-chip"><LifeBuoy size={14} /></span>
        <span style={HD}>Improvement Plans</span>
        <span style={{ ...muted, marginLeft: 'auto' }}>Managers draft them from My Team</span>
      </div>
      {err ? <ErrorBanner message={err} onRetry={load} /> : plans === null ? <SkeletonBlocks count={2} height={48} /> : (
        <div style={{ display: 'grid', gap: 12 }}>
          {plans.length > 0 && (
            <Figures label="Filter Plans" value={pick} onPick={setPick}
              items={ADMIN_FILTERS.map(f => ({ key: f.key, label: f.label, n: plans.filter(f.test).length,
                color: f.key === 'past' ? NX.red : f.key === 'proposed' ? NX.purple : f.key === 'active' ? NX.amber : '#64748b' }))} />
          )}
          {shown.length ? <PlanRows items={shown} onOpen={p => setOpen(p.id)} showPerson />
            : <div style={muted}>{pick ? 'None match - pick the figure again to show all.' : 'No improvement plans.'}</div>}
        </div>
      )}
      {open && <PlanModal planId={open} onClose={() => { setOpen(''); load(); }} onChanged={load} toastOk={toastOk} toastErr={toastErr} />}
    </section>
  );
}
