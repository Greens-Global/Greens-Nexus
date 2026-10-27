// Workday > Performance (Neil, Oct 27 2026): your goals and your 1:1s on one
// page - and, when people report to you, your team on a second view. Kept
// plain on purpose (Neil: Keka's performance module confuses its users):
// two cards, one click to open anything, no setup screens.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDateTime } from '../lib/datetime';
import { Target, CalendarClock, Users, Plus, ClipboardCheck } from 'lucide-react';
import { api } from '../api';
import { Modal } from '../tasks/components';
import { SkeletonBlocks, ErrorBanner, LoadingState } from '../components/AsyncState';
import { useIsMobile } from '../lib/useIsMobile';
import { GoalList, GoalFormModal, GoalDetailModal, AddGoalButton, ProgressBar } from './Goals';
import { OneOnOneList, NewOneOnOneModal, OneOnOneModal } from './OneOnOnes';
import { ReviewList, ReviewModal } from './Reviews';
import { card, cardHead, HD, muted, LBL, parsePerfSub } from './lib';

function Card({ Icon, title, action, children }) {
  return (
    <section style={card} aria-label={title}>
      <div style={cardHead}>
        <span className="wkc-chip"><Icon size={14} /></span>
        <span style={HD}>{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div role="tablist" aria-label="Whose performance" style={{ display: 'inline-flex', padding: 3, borderRadius: 10, background: 'var(--mist)', gap: 2, marginBottom: 14 }}>
      {options.map(o => (
        <button key={o.key} type="button" role="tab" aria-selected={value === o.key} onClick={() => onChange(o.key)}
          style={{ padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
            background: value === o.key ? 'var(--card)' : 'transparent', color: value === o.key ? 'var(--ink)' : 'var(--muted)',
            boxShadow: value === o.key ? 'var(--wk-shadow)' : 'none' }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// One person on my team: their goals and, for a direct report, our 1:1.
function PersonModal({ person, reload = 0, oneOnOnes, onClose, onOpenGoal, onOpenOneOnOne, onNewOneOnOne, onAddGoal }) {
  const [goals, setGoals] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    api.perfGoals('person', { person: person.email }).then(r => { if (live) setGoals(r); })
      .catch(e => { if (live) setErr(e?.message || 'Could not load their goals.'); });
    return () => { live = false; };
  }, [person.email, reload]);
  const mine = oneOnOnes.filter(s => s.reportEmail === person.email && s.side === 'manager');
  return (
    <Modal title={person.name} onClose={onClose} footer={<button type="button" className="primary-btn" onClick={onClose}>Done</button>}>
      <div style={{ display: 'grid', gap: 18 }}>
        <div style={muted}>{[person.title, person.department, person.direct ? 'Reports to you' : 'On your team'].filter(Boolean).join(' · ')}</div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <span style={LBL}>Goals</span>
            {person.direct && <AddGoalButton onClick={() => onAddGoal(person)} label="Add Goal for Them" />}
          </div>
          {err ? <ErrorBanner message={err} /> : !goals ? <LoadingState size="inline" compact /> :
            <GoalList goals={goals} onOpen={onOpenGoal} empty="No goals yet." />}
        </div>
        {person.direct && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
              <span style={LBL}>1:1s</span>
              <button type="button" className="secondary-btn" onClick={() => onNewOneOnOne(person.email)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}><Plus size={14} /> Set Up a 1:1</button>
            </div>
            <OneOnOneList items={mine} onOpen={onOpenOneOnOne} empty="No 1:1 with them yet." />
          </div>
        )}
      </div>
    </Modal>
  );
}

function TeamView({ ctx, team, onOpenPerson, onNewOneOnOne }) {
  const phone = useIsMobile('(max-width: 640px)');
  if (!team) return <SkeletonBlocks count={3} height={64} />;
  if (!team.length) return <div style={muted}>Nobody reports to you in Nexus People.</div>;
  return (
    <section style={card} aria-label="My Team">
      <div style={cardHead}>
        <span className="wkc-chip"><Users size={14} /></span>
        <span style={HD}>My Team</span>
        {ctx.hasTeam && (
          <button type="button" className="secondary-btn" onClick={() => onNewOneOnOne('')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}><Plus size={14} /> Set Up a 1:1</button>
        )}
      </div>
      <div role="table" aria-label="Team performance" style={{ display: 'grid' }}>
        {!phone && (
          <div role="row" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) 1fr minmax(0, 1.4fr) minmax(0, 1.4fr)', gap: 12, padding: '6px 10px', ...LBL }}>
            <span role="columnheader">Person</span><span role="columnheader">Goals</span>
            <span role="columnheader">Progress</span><span role="columnheader">Next 1:1</span>
          </div>
        )}
        {team.map(p => (
          <button key={p.email} type="button" role="row" onClick={() => onOpenPerson(p)}
            style={{ display: 'grid', gridTemplateColumns: phone ? '1fr' : 'minmax(0, 2fr) 1fr minmax(0, 1.4fr) minmax(0, 1.4fr)', gap: phone ? 4 : 12,
              alignItems: 'center', padding: '10px', border: 'none', borderTop: '1px solid var(--line)', background: 'transparent',
              textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)' }}>
            <span role="cell" style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, paddingLeft: p.direct ? 0 : 14 }}>{p.name}</span>
              <span style={{ display: 'block', ...muted, fontSize: 12, paddingLeft: p.direct ? 0 : 14 }}>{p.title || p.department}</span>
            </span>
            <span role="cell" style={{ fontSize: 13 }}>
              {p.goals.total ? `${p.goals.total} ${p.goals.total === 1 ? 'Goal' : 'Goals'}` : 'No Goals'}
              {(p.goals.atRisk + p.goals.offTrack) > 0 && <span style={{ ...muted, fontSize: 12 }}> · {p.goals.atRisk + p.goals.offTrack} Need Attention</span>}
            </span>
            <span role="cell">{p.goals.total ? <ProgressBar value={p.goals.progress} label={`${p.name} progress`} /> : <span style={muted}>-</span>}</span>
            <span role="cell" style={{ fontSize: 12.5, color: p.nextOneOnOne?.at ? 'var(--ink)' : 'var(--muted)' }}>
              {p.direct ? (p.nextOneOnOne?.at ? formatDateTime(p.nextOneOnOne.at) : (p.nextOneOnOne ? 'Nothing scheduled' : 'No 1:1 yet')) : '-'}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

// `focus`: { sub } from a bell or link (TimeClock), used once - onFocusUsed
// clears it so coming back to the tab does not reopen it.
export default function PerformanceTab({ focus = null, onFocusUsed, toastOk, toastErr }) {
  const phone = useIsMobile('(max-width: 900px)');
  const [ctx, setCtx] = useState(null);
  const [err, setErr] = useState('');
  const [goals, setGoals] = useState(null);
  const [oneOnOnes, setOneOnOnes] = useState(null);
  const [team, setTeam] = useState(null);
  const initial = parsePerfSub(focus?.sub) || { view: 'me' };
  const [view, setView] = useState(initial.view);
  const [openGoal, setOpenGoal] = useState(initial.goal || '');
  const [openSeries, setOpenSeries] = useState(initial.oneOnOne || '');
  const [openReview, setOpenReview] = useState(initial.review || '');
  const [reviews, setReviews] = useState(null);
  const [goalForm, setGoalForm] = useState(null);       // null | { defaults }
  const [newOneOnOne, setNewOneOnOne] = useState(null); // null | { reportEmail }
  const [person, setPerson] = useState(null);
  const [reloadPerson, setReloadPerson] = useState(0);

  // A new bell while the tab is open opens what it points at (state adjusted
  // during render, the way TimeClock follows its sub - no effect needed).
  const [seenFocus, setSeenFocus] = useState(focus);
  if (focus && focus !== seenFocus) {
    setSeenFocus(focus);
    const p = parsePerfSub(focus.sub);
    if (p?.goal) setOpenGoal(p.goal);
    if (p?.oneOnOne) setOpenSeries(p.oneOnOne);
    if (p?.review) setOpenReview(p.review);
    if (p?.view === 'team') setView('team');
  }

  useEffect(() => { if (focus) onFocusUsed?.(); }, [focus, onFocusUsed]);

  const loadGoals = useCallback(() => api.perfGoals('mine').then(setGoals).catch(e => setErr(e?.message || 'Could not load your goals.')), []);
  const loadOneOnOnes = useCallback(() => api.perfOneOnOnes().then(setOneOnOnes).catch(() => setOneOnOnes([])), []);
  const loadReviews = useCallback(() => api.perfReviews().then(setReviews).catch(() => setReviews({ mine: [], team: [] })), []);
  const loadTeam = useCallback(() => api.perfTeam().then(setTeam).catch(() => setTeam([])), []);
  useEffect(() => {
    api.perfMe().then(setCtx).catch(e => setErr(e?.message || 'Could not load Performance.'));
    loadGoals();
    loadOneOnOnes();
    loadReviews();
  }, [loadGoals, loadOneOnOnes, loadReviews]);
  const showTeam = !!ctx && (ctx.team || []).length > 0;
  useEffect(() => { if (showTeam && view === 'team' && team === null) loadTeam(); }, [showTeam, view, team, loadTeam]);

  const refresh = () => { loadGoals(); loadOneOnOnes(); if (team !== null) loadTeam(); };
  const myGoals = useMemo(() => (goals || []).filter(g => g.level === 'personal' && g.ownerEmail === ctx?.email), [goals, ctx]);
  const ownedOther = useMemo(() => (goals || []).filter(g => g.level !== 'personal' && g.ownerEmail === ctx?.email), [goals, ctx]);
  const shared = useMemo(() => (goals || []).filter(g => g.level !== 'personal' && g.ownerEmail !== ctx?.email), [goals, ctx]);

  if (err && !ctx) return <ErrorBanner message={err} onRetry={() => { setErr(''); api.perfMe().then(setCtx).catch(e => setErr(e?.message || 'Could not load Performance.')); loadGoals(); }} />;
  if (!ctx) return <SkeletonBlocks count={2} height={180} gridTemplateColumns={phone ? '1fr' : '1fr 1fr'} />;

  return (
    <div style={{ fontFamily: 'var(--wk-font)' }}>
      {showTeam && (
        <Segmented value={view} onChange={setView} options={[{ key: 'me', label: 'My Performance' }, { key: 'team', label: 'My Team' }]} />
      )}
      {view === 'team' && showTeam ? (
        <div style={{ display: 'grid', gap: 14 }}>
          {(reviews?.team || []).length > 0 && (
            <Card Icon={ClipboardCheck} title="Team Reviews">
              <ReviewList items={reviews.team} onOpen={r => setOpenReview(r.id)} showPerson />
            </Card>
          )}
          <TeamView ctx={ctx} team={team} onOpenPerson={setPerson}
            onNewOneOnOne={(email) => setNewOneOnOne({ reportEmail: email })} />
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: phone ? '1fr' : 'minmax(0, 3fr) minmax(0, 2fr)', gap: 14, alignItems: 'start' }}>
          <Card Icon={Target} title="My Goals" action={<AddGoalButton onClick={() => setGoalForm({ defaults: {} })} />}>
            {goals === null ? <SkeletonBlocks count={2} height={58} /> : (
              <div style={{ display: 'grid', gap: 16 }}>
                <GoalList goals={[...ownedOther, ...myGoals]} onOpen={g => setOpenGoal(g.id)}
                  empty="No goals yet. Add one - or your manager will." />
                {shared.length > 0 && (
                  <div>
                    <div style={{ ...LBL, marginBottom: 8 }}>Company and Department Goals</div>
                    <GoalList goals={shared} onOpen={g => setOpenGoal(g.id)} />
                  </div>
                )}
              </div>
            )}
          </Card>
          <Card Icon={CalendarClock} title="My 1:1s" action={ctx.hasTeam ? (
            <button type="button" className="secondary-btn" onClick={() => setNewOneOnOne({ reportEmail: '' })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}><Plus size={14} /> Set Up a 1:1</button>) : null}>
            {oneOnOnes === null ? <SkeletonBlocks count={2} height={52} /> : (
              <OneOnOneList items={oneOnOnes} onOpen={s => setOpenSeries(s.id)}
                empty={ctx.manager ? `No 1:1s yet - ${ctx.manager.name} sets them up.` : 'No 1:1s yet.'} />
            )}
          </Card>
          {(reviews?.mine || []).length > 0 && (
            <div style={{ gridColumn: '1 / -1' }}>
              <Card Icon={ClipboardCheck} title="My Reviews">
                <ReviewList items={reviews.mine} onOpen={r => setOpenReview(r.id)} />
              </Card>
            </div>
          )}
        </div>
      )}

      {person && (
        <PersonModal person={person} reload={reloadPerson} oneOnOnes={oneOnOnes || []} onClose={() => setPerson(null)}
          onOpenGoal={g => setOpenGoal(g.id)} onOpenOneOnOne={s => setOpenSeries(s.id)}
          onNewOneOnOne={(email) => setNewOneOnOne({ reportEmail: email })}
          onAddGoal={(p) => setGoalForm({ defaults: { ownerEmail: p.email } })} />
      )}
      {goalForm && (
        <GoalFormModal ctx={ctx} defaults={goalForm.defaults} parents={goals || []} toastErr={toastErr}
          onClose={() => setGoalForm(null)} onSaved={() => { setGoalForm(null); toastOk?.('Goal added.'); refresh(); setReloadPerson(n => n + 1); }} />
      )}
      {openGoal && (
        <GoalDetailModal goalId={openGoal} ctx={ctx} parents={goals || []} onClose={() => setOpenGoal('')}
          onChanged={() => { refresh(); setReloadPerson(n => n + 1); }} toastOk={toastOk} toastErr={toastErr} />
      )}
      {newOneOnOne && (
        <NewOneOnOneModal ctx={ctx} reportEmail={newOneOnOne.reportEmail} onClose={() => setNewOneOnOne(null)} toastOk={toastOk} toastErr={toastErr}
          onCreated={(s) => { setNewOneOnOne(null); loadOneOnOnes(); if (team !== null) loadTeam(); setOpenSeries(s.id); }} />
      )}
      {openReview && (
        <ReviewModal reviewId={openReview} onClose={() => { setOpenReview(''); loadReviews(); }} toastOk={toastOk} toastErr={toastErr} />
      )}
      {openSeries && (
        <OneOnOneModal seriesId={openSeries} onClose={() => { setOpenSeries(''); loadOneOnOnes(); }} onChanged={() => {}} toastOk={toastOk} toastErr={toastErr} />
      )}
    </div>
  );
}
