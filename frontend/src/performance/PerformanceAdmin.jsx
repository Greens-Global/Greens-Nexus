// People > Performance (Neil, Oct 29 2026: made simple): HR's review cycles,
// the company and department goals, and everyone's goals in the companies
// HR looks after - Behind and At Risk first. The filters sit on the list they
// filter. 1:1s are not here on purpose: they are the manager's and the
// report's alone.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Target, Search } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import { GoalList, GoalFormModal, GoalDetailModal, AddGoalButton } from './Goals';
import ReviewCycles from './ReviewCycles';
import { GOAL_STATUS, card, cardHead, HD, LBL, muted } from './lib';
import Figures from './Figures';
import { PlansAdmin } from './Plans';

const STATUS_FILTER = ['behind', 'at_risk', 'on_track', 'done', 'no_data'];
const ATTENTION = { behind: 0, at_risk: 1, no_data: 2, on_track: 3, done: 4 };

export default function PerformanceAdmin({ toastOk, toastErr }) {
  const [ctx, setCtx] = useState(null);
  const [err, setErr] = useState('');
  const [company, setCompany] = useState('');
  const [goals, setGoals] = useState(null);
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

  const personal = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (goals || []).filter(g => g.level === 'personal' && (!status || g.status === status)
      && (!needle || `${g.title} ${g.ownerName} ${g.department}`.toLowerCase().includes(needle)))
      .sort((a, b) => (ATTENTION[a.status] ?? 5) - (ATTENTION[b.status] ?? 5));
  }, [goals, status, q]);
  const counts = useMemo(() => Object.fromEntries(STATUS_FILTER.map(k => [k, (goals || []).filter(g => g.level === 'personal' && g.status === k).length])), [goals]);

  if (err) return <ErrorBanner message={err} />;
  if (!ctx) return <SkeletonBlocks count={2} height={140} />;
  if (!ctx.isHr) return <div style={muted}>Performance across the company is for HR. Your own goals and reviews are in Workday &gt; Performance.</div>;
  const companyGoals = (goals || []).filter(g => g.level !== 'personal');
  return (
    <div style={{ display: 'grid', gap: 14, fontFamily: 'var(--wk-font)' }}>
      {(ctx.hrCompanies || []).length > 1 && (
        <label style={{ display: 'grid', gap: 4, maxWidth: 320 }}>
          <span style={LBL}>Company</span>
          <select className="form-input" value={company} onChange={e => setCompany(e.target.value)} aria-label="Company" style={{ fontSize: 16 }}>
            {ctx.hrCompanies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      <ReviewCycles company={company} companies={ctx.hrCompanies || []} toastOk={toastOk} toastErr={toastErr} />
      <PlansAdmin company={company} toastOk={toastOk} toastErr={toastErr} />
      <section style={card} aria-label="Company and Department Goals">
        <div style={cardHead}>
          <span className="wkc-chip"><Target size={14} /></span>
          <span style={HD}>Company and Department Goals</span>
          <AddGoalButton onClick={() => setForm({ level: 'company', companyId: company })} label="Add Company Goal" />
          <button type="button" className="secondary-btn" onClick={() => setForm({ level: 'department', companyId: company })} style={{ minHeight: 36 }}>Add Department Goal</button>
        </div>
        {goals === null ? <SkeletonBlocks count={2} height={58} /> :
          <GoalList goals={companyGoals} onOpen={g => setOpen(g.id)} showOwner empty="No company or department goals yet. People's own goals can support them." />}
      </section>
      <section style={card} aria-label="Everyone's Goals">
        <div style={cardHead}>
          <span className="wkc-chip"><Target size={14} /></span>
          <span style={HD}>Everyone&apos;s Goals</span>
          <span style={{ ...muted, marginLeft: 'auto' }}>Behind and At Risk first</span>
        </div>
        {/* The counts are the status filter (Oct 29 2026): one look says
            how the company is doing, one click narrows the list. */}
        <div style={{ marginBottom: 12 }}>
          <Figures label="Filter by Status" value={status} onPick={setStatus}
            items={STATUS_FILTER.map(k => ({ key: k, n: counts[k] || 0, label: GOAL_STATUS[k].label, color: GOAL_STATUS[k].color }))} />
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end', marginBottom: 12 }}>
          <label style={{ display: 'grid', gap: 4, flex: '1 1 200px' }}>
            <span style={LBL}>Search</span>
            <span style={{ position: 'relative', display: 'flex' }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
              <input className="form-input" value={q} onChange={e => setQ(e.target.value)} placeholder="Goal, person or department" style={{ paddingLeft: 30, width: '100%', fontSize: 16 }} />
            </span>
          </label>
        </div>
        {goals === null ? <SkeletonBlocks count={3} height={58} /> :
          <GoalList goals={personal} onOpen={g => setOpen(g.id)} showOwner
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
