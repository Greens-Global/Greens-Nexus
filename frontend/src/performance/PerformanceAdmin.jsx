// People > Performance (Neil, Oct 27 2026): HR's review cycles and the company's goals -
// the company and department goals HR sets, and every person's goals in the
// companies HR looks after, with the ones that need attention first. 1:1s are
// not here on purpose: they are the manager's and the report's alone.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Target, Search } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import { GoalList, GoalFormModal, GoalDetailModal, AddGoalButton } from './Goals';
import ReviewCycles from './ReviewCycles';
import { GOAL_STATUS, GOAL_STATUS_KEYS, card, cardHead, HD, LBL, muted } from './lib';

export default function PerformanceAdmin({ toastOk, toastErr }) {
  const [ctx, setCtx] = useState(null);
  const [err, setErr] = useState('');
  const [company, setCompany] = useState('');
  const [goals, setGoals] = useState(null);
  const [level, setLevel] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [form, setForm] = useState(null);
  const [open, setOpen] = useState('');

  useEffect(() => {
    api.perfMe().then(c => { setCtx(c); setCompany(c.hrCompanies?.[0]?.id || ''); })
      .catch(e => setErr(e?.message || 'Could not load Performance.'));
  }, []);
  const load = useCallback(() => {
    if (!ctx?.isHr) return;
    api.perfGoals('company', { company }).then(setGoals).catch(e => setErr(e?.message || 'Could not load the goals.'));
  }, [ctx, company]);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (goals || []).filter(g => (!level || g.level === level) && (!status || g.status === status)
      && (!needle || `${g.title} ${g.ownerName} ${g.department}`.toLowerCase().includes(needle)));
  }, [goals, level, status, q]);
  const counts = useMemo(() => Object.fromEntries(GOAL_STATUS_KEYS.map(k => [k, (goals || []).filter(g => g.status === k).length])), [goals]);

  if (err) return <ErrorBanner message={err} />;
  if (!ctx) return <SkeletonBlocks count={2} height={140} />;
  if (!ctx.isHr) return <div style={muted}>Performance across the company is for HR. Your own goals and 1:1s are in Workday &gt; Performance.</div>;
  const companyGoals = shown.filter(g => g.level !== 'personal');
  const personal = shown.filter(g => g.level === 'personal');
  const attention = (g) => (g.status === 'off_track' ? 0 : g.status === 'at_risk' ? 1 : 2);
  return (
    <div style={{ display: 'grid', gap: 14, fontFamily: 'var(--wk-font)' }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
        {(ctx.hrCompanies || []).length > 1 && (
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={LBL}>Company</span>
            <select className="form-input" value={company} onChange={e => setCompany(e.target.value)} aria-label="Company">
              {ctx.hrCompanies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={LBL}>Type</span>
          <select className="form-input" value={level} onChange={e => setLevel(e.target.value)} aria-label="Type">
            <option value="">All Goals</option><option value="company">Company</option>
            <option value="department">Department</option><option value="personal">Personal</option>
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={LBL}>Status</span>
          <select className="form-input" value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
            <option value="">Any Status</option>
            {GOAL_STATUS_KEYS.map(k => <option key={k} value={k}>{GOAL_STATUS[k].label} ({counts[k] || 0})</option>)}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4, flex: '1 1 200px' }}>
          <span style={LBL}>Search</span>
          <span style={{ position: 'relative', display: 'flex' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
            <input className="form-input" value={q} onChange={e => setQ(e.target.value)} placeholder="Goal, person or department" style={{ paddingLeft: 30, width: '100%' }} />
          </span>
        </label>
      </div>
      <ReviewCycles company={company} toastOk={toastOk} toastErr={toastErr} />
      <section style={card} aria-label="Company and Department Goals">
        <div style={cardHead}>
          <span className="wkc-chip"><Target size={14} /></span>
          <span style={HD}>Company and Department Goals</span>
          <AddGoalButton onClick={() => setForm({ level: 'company', companyId: company })} label="Add Company Goal" />
          <button type="button" className="secondary-btn" onClick={() => setForm({ level: 'department', companyId: company })}>Add Department Goal</button>
        </div>
        {goals === null ? <SkeletonBlocks count={2} height={58} /> :
          <GoalList goals={companyGoals} onOpen={g => setOpen(g.id)} showOwner empty="No company or department goals yet." />}
      </section>
      <section style={card} aria-label="Everyone's Goals">
        <div style={cardHead}>
          <span className="wkc-chip"><Target size={14} /></span>
          <span style={HD}>Everyone&apos;s Goals</span>
          <span style={{ ...muted, marginLeft: 'auto' }}>Off Track and At Risk first</span>
        </div>
        {goals === null ? <SkeletonBlocks count={3} height={58} /> :
          <GoalList goals={[...personal].sort((a, b) => attention(a) - attention(b))} onOpen={g => setOpen(g.id)} showOwner
            empty="Nobody has a goal yet - people add their own in Workday > Performance, and managers add them for their team." />}
      </section>
      {form && (
        <GoalFormModal ctx={ctx} defaults={form} parents={goals || []} toastErr={toastErr}
          onClose={() => setForm(null)} onSaved={() => { setForm(null); toastOk?.('Goal added.'); load(); }} />
      )}
      {open && (
        <GoalDetailModal goalId={open} ctx={ctx} parents={goals || []} onClose={() => setOpen('')}
          onChanged={load} toastOk={toastOk} toastErr={toastErr} />
      )}
    </div>
  );
}
