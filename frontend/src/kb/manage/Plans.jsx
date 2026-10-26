// Manage > Plans and Rules: Training Plans (bundles for a role) and the
// assignment rules that put people on courses automatically.
import { useEffect, useState } from 'react';
import { Plus, Users, X, Trash2 } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { Modal } from '../../tasks/components';
import { Chip, SectionHead } from '../components/Chips';
import AudienceModal, { normalizeAudience } from '../components/AudienceModal';
import { PeopleMultiPick } from '../components/PeoplePick';
import { useToast, errText } from '../components/Toast';
import { goKb, plural } from '../lib';

function PlanModal({ plan, courses, policies, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: plan?.name || '', description: plan?.description || '', due_days: plan?.due_days ?? 30, items: plan?.items?.map((i) => ({ kind: i.kind, id: i.id })) || [], audience: plan?.audience || null });
  const [aud, setAud] = useState(false);
  const [emails, setEmails] = useState([]);
  const add = (kind, id) => { if (id && !form.items.some((i) => i.kind === kind && i.id === id)) setForm({ ...form, items: [...form.items, { kind, id }] }); };
  const titleOf = (i) => (i.kind === 'course' ? courses.find((c) => c.id === i.id)?.title : policies.find((p) => p.id === i.id)?.title) || i.id;
  const save = async () => {
    try {
      const p = plan ? await api.kbUpdatePlan(plan.id, form) : await api.kbCreatePlan(form);
      if (emails.length) await api.kbAssignPlan(p.id, emails);
      toast('Saved'); onSaved(); onClose();
    } catch (e) { toast(errText(e), 'err'); }
  };
  return (
    <Modal title={plan ? plan.name : 'New Training Plan'} onClose={onClose} footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="kb-btn" onClick={onClose}>Cancel</button><button type="button" className="kb-btn pri" disabled={!form.name.trim() || !form.items.length} onClick={save}>Save Plan</button></div>}>
      <div className="kb" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="kb-field"><label>Name</label><input className="kb-input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="New Hire: Site Manager" /></div>
          <div className="kb-field"><label>Description</label><input className="kb-input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Everything a new site manager finishes in the first month" /></div>
          <div className="kb-field"><label>Due</label><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input type="number" min="1" className="kb-input" style={{ width: 90 }} value={form.due_days} onChange={(e) => setForm({ ...form, due_days: Number(e.target.value) || 30 })} /><span className="kb-meta">days after start date</span></div></div>
          <div className="kb-field"><label>Who gets it automatically</label><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="kb-meta kb-grow">{form.audience ? 'An audience is set' : 'Nobody yet (assign by name below, or set an audience)'}</span><button type="button" className="kb-btn sm" onClick={() => setAud(true)}><Users />{form.audience ? 'Change' : 'Set Audience'}</button></div></div>
          <div className="kb-field"><label>Also assign to</label><PeopleMultiPick value={emails} onChange={setEmails} /></div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="kb-label">In the plan, in order</div>
          {form.items.map((i, n) => <div key={`${i.kind}:${i.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: '1px solid var(--kb-line)', borderRadius: 8, fontSize: 13 }}><span className="kb-meta">{n + 1}</span><Chip color={i.kind === 'course' ? '#1e7b4e' : '#7c3aed'}>{i.kind === 'course' ? 'Course' : 'Policy'}</Chip><span className="kb-grow kb-ellipsis">{titleOf(i)}</span><button type="button" className="kb-ibtn" style={{ width: 24, height: 24, border: 0 }} aria-label="Remove" onClick={() => setForm({ ...form, items: form.items.filter((x) => x !== i) })}><X size={13} /></button></div>)}
          <select className="kb-select" value="" onChange={(e) => add('course', e.target.value)}><option value="">Add a course</option>{courses.filter((c) => c.status === 'published').map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>
          <select className="kb-select" value="" onChange={(e) => add('policy', e.target.value)}><option value="">Add a policy to sign</option>{policies.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
        </div>
      </div>
      {aud && <AudienceModal value={normalizeAudience(form.audience || {})} title="Who Gets This Plan" dueLabel="Due" onClose={() => setAud(false)} onChange={(a) => setForm({ ...form, audience: a, due_days: a.due_days || form.due_days })} />}
    </Modal>
  );
}

export default function Plans() {
  const toast = useToast();
  const [plans, setPlans] = useState(null);
  const [rules, setRules] = useState(null);
  const [courses, setCourses] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [edit, setEdit] = useState(null);     // null | 'new' | plan
  const load = () => { api.kbPlans().then(setPlans).catch((e) => toast(errText(e), 'err')); api.kbRules().then(setRules).catch(() => setRules([])); };
  useEffect(() => { load(); api.kbCourses(true).then(setCourses).catch(() => {}); api.kbPages({ status: 'approved' }).then((rows) => setPolicies(rows.filter((p) => p.require_ack))).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="kb-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="kb-h1" style={{ margin: 0, fontSize: 24 }}>Plans and Rules</h1>
        <div className="kb-seg">
          <button type="button" onClick={() => goKb('health')}>Health</button>
          <button type="button" onClick={() => goKb('compliance')}>Compliance</button>
          <button type="button" onClick={() => goKb('collections')}>Collections</button>
          <button type="button" className="on">Plans and Rules</button>
        </div>
        <button type="button" className="kb-btn pri" style={{ marginLeft: 'auto' }} onClick={() => setEdit('new')}><Plus />New Training Plan</button>
      </div>
      <div className="kb-cols">
        <div className="kb-main">
          <section className="kb-card">
            <SectionHead title="Training Plans" sub="A bundle of courses and policies for a role, tracked as one checklist" />
            <AsyncSection loading={!plans} isEmpty={plans && plans.length === 0} emptyContent={<div className="kb-empty">No plans yet. "New Hire: Site Manager" is the usual first one.</div>}>
              {(plans || []).map((p) => (
                <div key={p.id} className="kb-row link" onClick={() => setEdit(p)} style={{ alignItems: 'flex-start' }}>
                  <div className="kb-grow"><div className="kb-title">{p.name}{!p.active && <Chip color="#9ca3af" style={{ marginLeft: 6 }}>Off</Chip>}</div><div className="kb-meta">{plural(p.items.length, 'item')} · due {p.due_days} days after start · {p.audience_text} · {p.assigned} assigned, {p.completed} done</div></div>
                  <button type="button" className="kb-btn sm" onClick={(e) => { e.stopPropagation(); setEdit(p); }}>Edit</button>
                </div>
              ))}
            </AsyncSection>
          </section>
        </div>
        <aside className="kb-rail">
          <section className="kb-card">
            <SectionHead title="Assignment Rules" sub="who takes which course, automatically" />
            <AsyncSection loading={!rules} isEmpty={rules && rules.length === 0} emptyContent={<div className="kb-empty">Rules are made from a course's Who Takes It tab.</div>}>
              {(rules || []).map((r) => (
                <div key={r.id} className="kb-row" style={{ alignItems: 'flex-start' }}>
                  <div className="kb-grow"><div className="kb-title"><a href="#b" onClick={(e) => { e.preventDefault(); goKb(r.kind === 'course' ? 'builder' : 'plans', r.target_id); }}>{r.target}</a>{!r.active && <Chip color="#9ca3af" style={{ marginLeft: 6 }}>Off</Chip>}</div><div className="kb-meta">{r.audience_text} · due {r.due_days} days{r.renew_months ? ` · renews every ${r.renew_months} months` : ''} · {r.matches} match</div></div>
                  {r.active && <button type="button" className="kb-ibtn" style={{ width: 28, height: 28 }} aria-label="Turn off" onClick={() => api.kbDeleteRule(r.id).then(load)}><Trash2 size={14} /></button>}
                </div>
              ))}
            </AsyncSection>
          </section>
        </aside>
      </div>
      {edit && <PlanModal plan={edit === 'new' ? null : edit} courses={courses} policies={policies} onClose={() => setEdit(null)} onSaved={load} />}
    </div>
  );
}
