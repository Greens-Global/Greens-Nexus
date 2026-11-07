// Manage > Learning Paths (Neil, 11/07/2026: "missing role based paths and
// departmental trainings"). A path is a training plan with a KIND - the
// onboarding track, a role's path, a department's training, or a custom
// bundle - ordered STAGES, the courses and policies in each, who gets it
// automatically (an audience) and whether anyone may start it from the
// catalog. The rail suggests a path for every job title and department in
// People that has none yet, and lists the assignment rules.
import { useEffect, useMemo, useState } from 'react';
import { Plus, Users, X, Trash2, ArrowUp, ArrowDown, ExternalLink, Sparkles } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { Modal, DateField } from '../../tasks/components';
import { Chip, SectionHead } from '../components/Chips';
import AudienceModal, { normalizeAudience } from '../components/AudienceModal';
import { PeopleMultiPick } from '../components/PeoplePick';
import { useToast, errText } from '../components/Toast';
import { goKb, plural, fmtDate, PATH_KINDS, pathKindMeta, minutesText } from '../lib';
import { KindChip, LevelChip } from '../training/cards';
import { suggestPaths } from '../training/catalogModel';

const KIND_ORDER = ['onboarding', 'role', 'department', 'custom'];

function PlanModal({ plan, seed, courses, policies, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: plan?.name || seed?.name || '', description: plan?.description || '', kind: plan?.kind || seed?.kind || 'custom',
    due_days: plan?.due_days ?? 30, due_date: plan?.due_date || '', stages: plan?.stages ? [...plan.stages] : [],
    items: plan?.items?.map((i) => ({ kind: i.kind, id: i.id, stage: Number.isInteger(i.stage) ? i.stage : -1 })) || [],
    audience: plan?.audience || (seed?.audience ? normalizeAudience({ ...seed.audience, everyone: false }) : null),
    open_enrollment: plan ? plan.open_enrollment !== false : true, active: plan ? plan.active !== false : true,
  });
  const [aud, setAud] = useState(false);
  const [emails, setEmails] = useState([]);
  const [busy, setBusy] = useState(false);
  const set = (p) => setForm((f) => ({ ...f, ...p }));
  const add = (kind, id) => { if (id && !form.items.some((i) => i.kind === kind && i.id === id)) set({ items: [...form.items, { kind, id, stage: form.stages.length ? form.stages.length - 1 : -1 }] }); };
  const titleOf = (i) => (i.kind === 'course' ? courses.find((c) => c.id === i.id) : policies.find((p) => p.id === i.id));
  const move = (n, d) => { const a = [...form.items]; const j = n + d; if (j < 0 || j >= a.length) return; [a[n], a[j]] = [a[j], a[n]]; set({ items: a }); };
  const setStage = (n, v) => set({ items: form.items.map((it, k) => (k === n ? { ...it, stage: v } : it)) });
  const removeStage = (n) => set({ stages: form.stages.filter((_, k) => k !== n), items: form.items.map((it) => ({ ...it, stage: it.stage === n ? -1 : it.stage > n ? it.stage - 1 : it.stage })) });
  const minutes = form.items.reduce((t, i) => t + (i.kind === 'course' ? (titleOf(i)?.est_minutes || 0) : 0), 0);
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...form, audience: form.audience || null };
      const p = plan ? await api.kbUpdatePlan(plan.id, body) : await api.kbCreatePlan(body);
      if (emails.length) await api.kbAssignPlan(p.id, emails);
      toast('Saved'); onSaved(); onClose();
    } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={plan ? plan.name : 'New Learning Path'} onClose={onClose} footer={<div className="kb" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <span className="kb-meta kb-grow">{plural(form.items.length, 'item')}{minutes ? ` · about ${minutesText(minutes)}` : ''}</span>
      <button type="button" className="kb-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="kb-btn pri" disabled={busy || !form.name.trim() || !form.items.length} onClick={save}>Save Path</button></div>}>
      <div className="kb" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="kb-field"><label>What Kind of Path</label>
            <div className="kb-types" role="radiogroup" aria-label="Kind of path">
              {KIND_ORDER.map((k) => { const m = PATH_KINDS[k]; return <button key={k} type="button" role="radio" aria-checked={form.kind === k} className={`kb-type${form.kind === k ? ' on' : ''}`} style={{ '--c': m.color }} onClick={() => set({ kind: k })}><KindChip kind={k} /><span className="kb-help">{m.blurb}</span></button>; })}
            </div></div>
          <div className="kb-field"><label>Name</label><input className="kb-input" autoFocus={!seed} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={form.kind === 'role' ? 'Site Manager Path' : form.kind === 'department' ? 'Operations Training' : form.kind === 'onboarding' ? 'New Hire: Facility Team' : 'Forklift Certification'} /></div>
          <div className="kb-field"><label>Description</label><input className="kb-input" value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="Who it is for and what they can do at the end" /></div>
          <div className="kb-field"><label>Stages</label>
            <div className="kb-stage-list">
              {form.stages.map((st, n) => <div key={n}><span className="kb-stage-tag">Stage {n + 1}</span><input className="kb-input" value={st} onChange={(e) => set({ stages: form.stages.map((x, k) => (k === n ? e.target.value : x)) })} placeholder="Week 1: The Basics" /><button type="button" className="kb-ibtn" style={{ width: 28, height: 28 }} aria-label="Remove stage" onClick={() => removeStage(n)}><X size={13} /></button></div>)}
              {form.stages.length < 12 && <button type="button" className="kb-btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => set({ stages: [...form.stages, ''] })}><Plus />Stage</button>}
            </div>
            <div className="kb-help">Optional. Stages group the items ("Week 1", "Before the first shift"); a path with none is one list.</div></div>
          <div className="kb-field"><label>Due</label>
            <div className="kb-seg" role="radiogroup" aria-label="Due mode" style={{ alignSelf: 'flex-start' }}>
              <button type="button" role="radio" aria-checked={!form.due_date} className={!form.due_date ? 'on' : ''} onClick={() => set({ due_date: '' })}>Within a number of days</button>
              <button type="button" role="radio" aria-checked={!!form.due_date} className={form.due_date ? 'on' : ''} onClick={() => set({ due_date: form.due_date || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) })}>By one date for everyone</button>
            </div>
            {form.due_date && <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}><DateField value={form.due_date} onChange={(v) => set({ due_date: v || '' })} noPast style={{ minHeight: 40, borderRadius: 10, width: 200 }} /><span className="kb-meta">Everyone on the path, by this date.</span></div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}><input type="number" min="1" className="kb-input" style={{ width: 90 }} value={form.due_days} onChange={(e) => set({ due_days: Number(e.target.value) || 30 })} /><span className="kb-meta">{form.due_date ? 'days of grace for someone who joins after the date' : 'days after start date'}</span></div></div>
          <div className="kb-field"><label>Who gets it automatically</label><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="kb-meta kb-grow">{form.audience && !form.audience.everyone ? 'An audience is set' : form.audience?.everyone ? 'Everyone' : 'Nobody yet (assign by name below, or set an audience)'}</span><button type="button" className="kb-btn sm" onClick={() => setAud(true)}><Users />{form.audience ? 'Change' : 'Set Audience'}</button></div>
            <div className="kb-help">{form.kind === 'role' ? 'Pick the job title: everyone with it is put on the path, new hires as they start.' : form.kind === 'department' ? 'Pick the department: everyone in it is put on the path.' : form.kind === 'onboarding' ? 'Pick who is onboarded this way; new hires get it from their start date.' : 'Any mix of department, job title, site or named people.'}</div></div>
          <div className="kb-field"><label>Also assign to</label><PeopleMultiPick value={emails} onChange={setEmails} /></div>
          <label className="kb-check"><input type="checkbox" checked={form.open_enrollment} onChange={(e) => set({ open_enrollment: e.target.checked })} />Anyone may start it from the catalog</label>
          {plan && <label className="kb-check"><input type="checkbox" checked={form.active} onChange={(e) => set({ active: e.target.checked })} />Switched on (people can see it and rules run)</label>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="kb-label">In the path, in order</div>
          {form.items.length === 0 && <div className="kb-empty" style={{ padding: 16 }}>Add courses and policies below.</div>}
          {form.items.map((i, n) => {
            const t = titleOf(i);
            return (
              <div key={`${i.kind}:${i.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: '1px solid var(--kb-line)', borderRadius: 8, fontSize: 13 }}>
                <span className="kb-meta" style={{ width: 18 }}>{n + 1}</span>
                <Chip color={i.kind === 'course' ? '#1e7b4e' : '#7c3aed'} plain>{i.kind === 'course' ? 'Course' : 'Policy'}</Chip>
                <span className="kb-grow kb-ellipsis">{t?.title || i.id}{i.kind === 'course' && t?.status && t.status !== 'published' ? <span className="kb-meta"> · {t.status}</span> : ''}</span>
                {i.kind === 'course' && <LevelChip level={t?.level} />}
                {form.stages.length > 0 && <select className="kb-select" style={{ width: 'auto', padding: '4px 8px', fontSize: 12.5 }} value={i.stage} onChange={(e) => setStage(n, Number(e.target.value))} aria-label="Stage"><option value={-1}>No stage</option>{form.stages.map((st, k) => <option key={k} value={k}>{st || `Stage ${k + 1}`}</option>)}</select>}
                <button type="button" className="kb-ibtn" style={{ width: 24, height: 24, border: 0 }} aria-label="Up" onClick={() => move(n, -1)}><ArrowUp size={12} /></button>
                <button type="button" className="kb-ibtn" style={{ width: 24, height: 24, border: 0 }} aria-label="Down" onClick={() => move(n, 1)}><ArrowDown size={12} /></button>
                <button type="button" className="kb-ibtn" style={{ width: 24, height: 24, border: 0 }} aria-label="Remove" onClick={() => set({ items: form.items.filter((x) => x !== i) })}><X size={13} /></button>
              </div>
            );
          })}
          <select className="kb-select" value="" onChange={(e) => add('course', e.target.value)} aria-label="Add a course"><option value="">Add a course</option>{courses.filter((c) => c.status === 'published').map((c) => <option key={c.id} value={c.id}>{c.title}{c.department_list?.length ? ` (${c.department_list.join(', ')})` : ''}</option>)}</select>
          <select className="kb-select" value="" onChange={(e) => add('policy', e.target.value)} aria-label="Add a policy to sign"><option value="">Add a policy to sign</option>{policies.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
          <div className="kb-help">Only published courses can go on a path. A course in the catalog that is not here can still be taken on its own.</div>
        </div>
      </div>
      {aud && <AudienceModal value={normalizeAudience(form.audience || {})} title="Who Gets This Path" dueLabel="Due" onClose={() => setAud(false)} onChange={(a) => set({ audience: a, due_days: a.due_days || form.due_days })} />}
    </Modal>
  );
}

function PlanRow({ p, onEdit }) {
  return (
    <div className="kb-row link" onClick={onEdit} style={{ alignItems: 'flex-start' }} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onEdit(); }}>
      <div className="kb-grow" style={{ minWidth: 0 }}>
        <div className="kb-title" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{p.name}{!p.active && <Chip color="#9ca3af">Off</Chip>}{p.open_enrollment === false && <Chip color="#64748b" plain>By assignment only</Chip>}</div>
        <div className="kb-meta">{plural(p.items.length, 'item')}{p.stages?.length ? ` in ${plural(p.stages.length, 'stage')}` : ''}{p.est_minutes ? ` · about ${minutesText(p.est_minutes)}` : ''} · {p.due_date ? `due by ${fmtDate(p.due_date)}` : `due ${p.due_days} days after start`} · {p.audience_text} · {p.assigned} on it, {p.completed} done</div>
      </div>
      <button type="button" className="kb-btn sm ghost" title="Open as a learner sees it" aria-label={`Open ${p.name}`} onClick={(e) => { e.stopPropagation(); goKb('path', p.id); }}><ExternalLink /></button>
      <button type="button" className="kb-btn sm" onClick={(e) => { e.stopPropagation(); onEdit(); }}>Edit</button>
    </div>
  );
}

export default function Plans() {
  const toast = useToast();
  const [plans, setPlans] = useState(null);
  const [rules, setRules] = useState(null);
  const [courses, setCourses] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [options, setOptions] = useState(null);
  const [edit, setEdit] = useState(null);     // null | { plan } | { seed }
  const load = () => { api.kbPlans().then(setPlans).catch((e) => toast(errText(e), 'err')); api.kbRules().then(setRules).catch(() => setRules([])); };
  useEffect(() => { load(); api.kbCourses(true).then(setCourses).catch(() => {}); api.kbPages({ status: 'approved' }).then((rows) => setPolicies(rows.filter((p) => p.require_ack))).catch(() => {}); api.kbAudienceOptions().then(setOptions).catch(() => setOptions({})); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => KIND_ORDER.map((k) => ({ kind: k, plans: (plans || []).filter((p) => (p.kind || 'custom') === k) })).filter((g) => g.plans.length), [plans]);
  const suggestions = useMemo(() => suggestPaths(options, plans), [options, plans]);
  return (
    <div className="kb-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="kb-h1" style={{ margin: 0, fontSize: 24 }}>Learning Paths</h1>
        <div className="kb-seg">
          <button type="button" onClick={() => goKb('health')}>Health</button>
          <button type="button" onClick={() => goKb('compliance')}>Compliance</button>
          <button type="button" onClick={() => goKb('collections')}>Collections</button>
          <button type="button" className="on">Paths and Rules</button>
        </div>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" className="kb-btn" onClick={() => goKb('catalog')}>See the Catalog</button>
          <button type="button" className="kb-btn pri" onClick={() => setEdit({})}><Plus />New Path</button>
        </span>
      </div>
      <div className="kb-cols">
        <div className="kb-main">
          <AsyncSection loading={!plans} isEmpty={plans && plans.length === 0} emptyContent={<section className="kb-card soft kb-empty">No paths yet. Start with the onboarding track for new hires, then one path per job title - the suggestions on the right are one click each.</section>}>
            {groups.map((g) => {
              const m = pathKindMeta(g.kind);
              return (
                <section key={g.kind} className="kb-card">
                  <SectionHead title={g.kind === 'role' ? 'Paths by Role' : g.kind === 'department' ? 'Department Training' : g.kind === 'onboarding' ? 'Onboarding' : 'Other Paths'} sub={m.blurb} right={<KindChip kind={g.kind} />} />
                  {g.plans.map((p) => <PlanRow key={p.id} p={p} onEdit={() => setEdit({ plan: p })} />)}
                </section>
              );
            })}
          </AsyncSection>
        </div>
        <aside className="kb-rail">
          {suggestions.length > 0 && (
            <section className="kb-card">
              <SectionHead title="Suggested" sub="roles and departments in People with no path yet" />
              {suggestions.slice(0, 12).map((s) => (
                <div key={`${s.kind}:${s.value}`} className="kb-row">
                  <div className="kb-grow" style={{ minWidth: 0 }}><div className="kb-title">{s.value}</div><div className="kb-meta">{s.kind === 'role' ? 'Job title, no role path yet' : 'Department, no training path yet'}</div></div>
                  <button type="button" className="kb-btn sm" onClick={() => setEdit({ seed: s })}><Sparkles />Create</button>
                </div>
              ))}
              {suggestions.length > 12 && <div className="kb-meta" style={{ marginTop: 6 }}>and {suggestions.length - 12} more</div>}
            </section>
          )}
          <section className="kb-card">
            <SectionHead title="Assignment Rules" sub="who takes which course, automatically" />
            <AsyncSection loading={!rules} isEmpty={rules && rules.length === 0} emptyContent={<div className="kb-empty">Rules are made from a course's Who Takes It tab.</div>}>
              {(rules || []).map((r) => (
                <div key={r.id} className="kb-row" style={{ alignItems: 'flex-start' }}>
                  <div className="kb-grow"><div className="kb-title"><a href="#b" onClick={(e) => { e.preventDefault(); goKb(r.kind === 'course' ? 'builder' : 'plans', r.target_id); }}>{r.target}</a>{!r.active && <Chip color="#9ca3af" style={{ marginLeft: 6 }}>Off</Chip>}</div><div className="kb-meta">{r.audience_text}{r.new_hires_only ? ' · new hires only' : ''} · {r.due_date ? `due by ${fmtDate(r.due_date)}, ${r.due_days} days of grace` : `due ${r.due_days} days`}{r.renew_months ? ` · renews every ${r.renew_months} months` : ''}{r.escalate_days ? ` · escalates after ${r.escalate_days} days overdue` : ''} · {r.matches} match</div></div>
                  {r.active && <button type="button" className="kb-ibtn" style={{ width: 28, height: 28 }} aria-label="Turn off" onClick={() => api.kbDeleteRule(r.id).then(load)}><Trash2 size={14} /></button>}
                </div>
              ))}
            </AsyncSection>
          </section>
        </aside>
      </div>
      {edit && <PlanModal plan={edit.plan || null} seed={edit.seed || null} courses={courses} policies={policies} onClose={() => setEdit(null)} onSaved={load} />}
    </div>
  );
}
