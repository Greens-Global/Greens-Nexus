// Workday > Performance, made simple (Neil, Oct 29 2026: "this really needs
// to be easy and it needs to provide some real metrics from Nexus"). One
// page: My Numbers, My Goals, My Review, My 1:1s. A manager also gets My
// Team - their direct reports with a few numbers, goal status and where
// their review is - and opens any of them on the same page the employee sees.
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Users, Plus, ChevronLeft, Check, ClipboardCheck } from 'lucide-react';
import { api } from '../api';
import { Avatar } from '../tasks/components';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import { useIsMobile } from '../lib/useIsMobile';
import { formatDateTime } from '../lib/datetime';
import { OneOnOneList, NewOneOnOneModal, OneOnOneModal } from './OneOnOnes';
import { ReviewList, ReviewStage, ReviewModal } from './Reviews';
import PersonPerformance from './PersonPerformance';
import { Segmented } from './MyNumbers';
import { StatusLabel } from '../components/StatusLabel';
import { GOAL_STATUS, card, cardHead, HD, LBL, muted, parsePerfSub } from './lib';
import Figures from './Figures';
import { scoreColor } from './Score';
import { NX } from '../tasks/theme';
import { FeedbackCard } from './Feedback';
import { KudosCard } from './Kudos';
import { PlanCard } from './Plans';

// Needs You (Oct 29 2026): what a manager's team is waiting on, each a
// filter for the table under it.
const NEEDS = [
  { key: 'approve', label: 'Goals to Approve', color: NX.blue, test: p => p.goals?.proposed > 0, n: p => p.goals?.proposed || 0 },
  { key: 'behind', label: 'Goals Behind', color: NX.red, test: p => p.goals?.behind > 0, n: p => p.goals?.behind || 0 },
  { key: 'at_risk', label: 'Goals At Risk', color: NX.amber, test: p => p.goals?.atRisk > 0, n: p => p.goals?.atRisk || 0 },
  { key: 'no_goals', label: 'No Goals Yet', color: '#64748b', test: p => !p.goals?.total, n: p => (p.goals?.total ? 0 : 1) },
  { key: 'no_1on1', label: 'No 1:1 Booked', color: '#64748b', test: p => !p.nextOneOnOne?.at, n: p => (p.nextOneOnOne?.at ? 0 : 1) },
];

function GoalCounts({ g }) {
  if (!g?.total) return <span style={muted}>No goals</span>;
  const parts = [['behind', g.behind], ['at_risk', g.atRisk], ['on_track', g.onTrack], ['done', g.done]].filter(([, n]) => n > 0);
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {parts.map(([k, n]) => <StatusLabel key={k} label={`${n} ${GOAL_STATUS[k].label}`} color={GOAL_STATUS[k].color} size="sm" />)}
    </span>
  );
}

export function TeamTable({ team, onOpen, filtered = false }) {
  const phone = useIsMobile('(max-width: 760px)');
  if (!team) return <SkeletonBlocks count={3} height={64} />;
  if (!team.length) return <div style={muted}>{filtered ? 'Nobody on your team matches - pick the figure again to show everyone.' : 'Nobody reports to you in Nexus People.'}</div>;
  const cols = 'minmax(0, 1.6fr) minmax(0, 0.6fr) minmax(0, 1.7fr) minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr)';
  return (
    <div role="table" aria-label="My Team" style={{ display: 'grid' }}>
      {!phone && (
        <div role="row" style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '6px 10px', ...LBL }}>
          <span role="columnheader">Person</span><span role="columnheader">Score</span><span role="columnheader">Numbers This Quarter</span>
          <span role="columnheader">Goals</span><span role="columnheader">Review</span><span role="columnheader">Next 1:1</span>
        </div>
      )}
      {team.map(p => (
        <button key={p.email} type="button" role="row" className="nx-perf-trow" onClick={() => onOpen(p)}
          style={{ display: 'grid', gridTemplateColumns: phone ? '1fr' : cols, gap: phone ? 8 : 12, alignItems: 'center', padding: '12px 10px',
            minHeight: 56, border: 'none', borderTop: '1px solid var(--line)', textAlign: 'left',
            cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)' }}>
          <span role="cell" style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <Avatar email={p.email} name={p.name} size={32} card={false} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{p.name}</span>
              <span style={{ display: 'block', ...muted, fontSize: 12 }}>{p.title || p.department}</span>
            </span>
            {p.goals?.proposed > 0 && <StatusLabel label={`${p.goals.proposed} to Approve`} color="#2563eb" size="sm" />}
          </span>
          <span role="cell" title={p.score == null ? 'No score this month' : `${p.score} out of 100 this month`}
            style={{ fontSize: 17, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: scoreColor(p.score) }}>{p.score == null ? '-' : p.score}</span>
          <span role="cell" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', minWidth: 0 }}>
            {(p.numbers || []).length ? p.numbers.map(n => (
              <span key={n.key} style={{ minWidth: 0 }}>
                <span style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{n.display}</span>
                <span style={{ ...muted, fontSize: 11.5, marginLeft: 4 }}>{n.label}</span>
              </span>
            )) : <span style={muted}>No numbers yet</span>}
          </span>
          <span role="cell"><GoalCounts g={p.goals} /></span>
          <span role="cell">{p.review ? <ReviewStage stage={p.review.stage} /> : <span style={muted}>-</span>}</span>
          <span role="cell" style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums', color: p.nextOneOnOne?.at ? 'var(--ink)' : 'var(--muted)' }}>
            {p.nextOneOnOne?.at ? (p.nextOneOnOne.label || formatDateTime(p.nextOneOnOne.at)) : (phone ? 'No 1:1 booked' : 'None Booked')}
          </span>
        </button>
      ))}
    </div>
  );
}

// `focus`: { sub } from a bell or link (TimeClock), used once - onFocusUsed
// clears it so coming back to the tab does not reopen it.
export default function PerformanceTab({ focus = null, onFocusUsed, toastOk, toastErr }) {
  const phone = useIsMobile('(max-width: 900px)');
  const [ctx, setCtx] = useState(null);
  const [err, setErr] = useState('');
  const [oneOnOnes, setOneOnOnes] = useState(null);
  const [team, setTeam] = useState(null);
  const [reviews, setReviews] = useState(null);
  const initial = parsePerfSub(focus?.sub) || { view: 'me' };
  const [view, setView] = useState(initial.view);
  const [openGoal, setOpenGoal] = useState(initial.goal || '');
  const [openSeries, setOpenSeries] = useState(initial.oneOnOne || '');
  const [openReview, setOpenReview] = useState(initial.review || '');
  const [newOneOnOne, setNewOneOnOne] = useState(initial.newOneOnOne ? { reportEmail: '' } : null); // null | { reportEmail }
  const [person, setPerson] = useState(null);
  const [need, setNeed] = useState('');
  const [openFeedback, setOpenFeedback] = useState(initial.feedback || '');
  const [openKudos, setOpenKudos] = useState(initial.kudos || '');
  const [openPlan, setOpenPlan] = useState(initial.plan || '');

  // A new bell while the tab is open opens what it points at.
  const [seenFocus, setSeenFocus] = useState(focus);
  if (focus && focus !== seenFocus) {
    setSeenFocus(focus);
    const p = parsePerfSub(focus.sub);
    if (p?.goal) setOpenGoal(p.goal);
    if (p?.oneOnOne) setOpenSeries(p.oneOnOne);
    if (p?.review) setOpenReview(p.review);
    if (p?.feedback || p?.kudos || p?.plan) { setView('me'); setPerson(null); }
    if (p?.feedback) setOpenFeedback(p.feedback);
    if (p?.kudos) setOpenKudos(p.kudos);
    if (p?.plan) setOpenPlan(p.plan);
    if (p?.newOneOnOne) setNewOneOnOne({ reportEmail: '' });
    if (p?.view === 'team') { setView('team'); setPerson(null); }
  }
  useEffect(() => { if (focus) onFocusUsed?.(); }, [focus, onFocusUsed]);

  const loadOneOnOnes = useCallback(() => api.perfOneOnOnes().then(setOneOnOnes).catch(() => setOneOnOnes([])), []);
  const loadReviews = useCallback(() => api.perfReviews().then(setReviews).catch(() => setReviews({ mine: [], team: [] })), []);
  // The month's score rides along on each row (perf_scores); a failed score read leaves the column blank.
  const loadTeam = useCallback(() => Promise.all([api.perfTeam(), api.perfTeamScores().catch(() => [])])
    .then(([rows, scores]) => setTeam(rows.map(p => ({ ...p, score: (Array.isArray(scores) ? scores : []).find(s => s.email === (p.email || '').toLowerCase())?.score ?? null }))))
    .catch(() => setTeam([])), []);
  const loadCtx = useCallback(() => api.perfMe().then(setCtx).catch(e => setErr(e?.message || 'Could not load Performance.')), []);
  useEffect(() => { loadCtx(); loadOneOnOnes(); loadReviews(); }, [loadCtx, loadOneOnOnes, loadReviews]);
  const hasTeam = !!ctx?.hasTeam;
  // Reviews someone writes show for them even with nobody reporting to them
  // (a reviewer HR picked).
  const writes = (reviews?.team || []).filter(r => r.yours);
  const showTeam = hasTeam || writes.length > 0;
  useEffect(() => { if (hasTeam && view === 'team' && team === null) loadTeam(); }, [hasTeam, view, team, loadTeam]);

  if (err && !ctx) return <ErrorBanner message={err} onRetry={() => { setErr(''); loadCtx(); }} />;
  if (!ctx) return <SkeletonBlocks count={3} height={140} />;

  const changed = () => { loadReviews(); if (team !== null) loadTeam(); };
  const theirReviews = person ? (reviews?.team || []).filter(r => r.employeeEmail === person.email) : [];
  const toWrite = writes.filter(r => ['self_review', 'manager_review'].includes(r.stage));

  return (
    <div style={{ fontFamily: 'var(--wk-font)', display: 'grid', gap: 14 }}>
      {showTeam && (
        <div><Segmented label="Whose performance" value={view} onChange={(v) => { setView(v); setPerson(null); setOpenReview(''); setOpenGoal(''); }}
          options={[{ key: 'me', label: 'Me' }, { key: 'team', label: 'My Team' }]} /></div>
      )}
      {view === 'team' && showTeam ? (
        person ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button type="button" className="secondary-btn" onClick={() => setPerson(null)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 40 }}><ChevronLeft size={15} /> My Team</button>
              <Avatar email={person.email} name={person.name} size={32} card={false} />
              <span style={{ fontSize: 16, fontWeight: 700 }}>{person.name}</span>
              <span style={muted}>{person.title || person.department}</span>
              <button type="button" className="secondary-btn" onClick={() => setNewOneOnOne({ reportEmail: person.email })}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', minHeight: 40 }}><Plus size={14} /> Set Up a 1:1</button>
            </div>
            <PersonPerformance key={person.email} ctx={ctx} email={person.email} name={person.name} reviews={theirReviews}
              canAdd onChanged={changed} toastOk={toastOk} toastErr={toastErr} extra={(
                <>
                  <PlanCard email={person.email} name={person.name} canStart toastOk={toastOk} toastErr={toastErr} />
                  <FeedbackCard ctx={ctx} email={person.email} name={person.name} toastOk={toastOk} toastErr={toastErr} />
                  <KudosCard ctx={ctx} person={person.email} name={person.name} toastOk={toastOk} toastErr={toastErr} />
                </>
              )} />
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
            {toWrite.length > 0 && (
              <section style={card} aria-label="Reviews to Write">
                <div style={cardHead}><span className="wkc-chip"><ClipboardCheck size={14} /></span><span style={HD}>Reviews to Write</span></div>
                <ReviewList items={toWrite} onOpen={r => setOpenReview(r.id)} showPerson />
              </section>
            )}
            {hasTeam && (
              <section style={card} aria-label="My Team">
                <div style={cardHead}>
                  <span className="wkc-chip"><Users size={14} /></span>
                  <span style={HD}>My Team</span>
                  <button type="button" className="secondary-btn" onClick={() => setNewOneOnOne({ reportEmail: '' })}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', minHeight: 36 }}><Plus size={14} /> Set Up a 1:1</button>
                </div>
                {team && team.length > 0 && (() => {
                  const items = NEEDS.map(d => ({ key: d.key, label: d.label, color: d.color, n: team.reduce((t, p) => t + d.n(p), 0) }));
                  return (
                    <div style={{ marginBottom: 12 }}>
                      <Figures label="Needs You" items={items} value={need} onPick={setNeed} />
                    </div>
                  );
                })()}
                <TeamTable team={team && need ? team.filter(NEEDS.find(d => d.key === need).test) : team} onOpen={setPerson} filtered={!!need} />
                {(team || []).some(p => p.goals?.proposed) && (
                  <div style={{ ...muted, fontSize: 12, marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <Check size={13} /> Open someone to approve the goals they proposed.
                  </div>
                )}
              </section>
            )}
            {writes.filter(r => !['self_review', 'manager_review'].includes(r.stage)).length > 0 && (
              <section style={card} aria-label="Team Reviews">
                <div style={cardHead}><span className="wkc-chip"><ClipboardCheck size={14} /></span><span style={HD}>Team Reviews</span></div>
                <ReviewList items={writes.filter(r => !['self_review', 'manager_review'].includes(r.stage))} onOpen={r => setOpenReview(r.id)} showPerson />
              </section>
            )}
          </div>
        )
      ) : (
        <PersonPerformance ctx={ctx} reviews={reviews?.mine || []} openGoalId={openGoal} openReviewId={view === 'me' ? openReview : ''}
          onChanged={changed} toastOk={toastOk} toastErr={toastErr} wide={!phone}
          top={<PlanCard self focusId={openPlan} toastOk={toastOk} toastErr={toastErr} />}
          extra={<FeedbackCard ctx={ctx} focusId={openFeedback} toastOk={toastOk} toastErr={toastErr} />} aside={(
          <div style={{ display: 'grid', gap: 14, minWidth: 0, alignContent: 'start' }}>
          <section style={card} aria-label="My 1:1s">
            <div style={cardHead}>
              <span className="wkc-chip"><CalendarClock size={14} /></span>
              <span style={HD}>My 1:1s</span>
              {hasTeam && (
                <button type="button" className="secondary-btn" onClick={() => setNewOneOnOne({ reportEmail: '' })}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', minHeight: 36 }}><Plus size={14} /> Set Up a 1:1</button>
              )}
            </div>
            {oneOnOnes === null ? <SkeletonBlocks count={2} height={52} /> : (
              <OneOnOneList items={oneOnOnes} onOpen={s => setOpenSeries(s.id)}
                empty={ctx.manager ? `No 1:1s yet - ${ctx.manager.name} sets them up.` : 'No 1:1s yet.'} />
            )}
            {(oneOnOnes || []).some(s => s.next?.at) && (
              <div style={{ ...muted, fontSize: 12, marginTop: 8 }}>Next: {formatDateTime((oneOnOnes.find(s => s.next?.at) || {}).next.at)}</div>
            )}
          </section>
          <KudosCard key={openKudos} ctx={ctx} focusId={openKudos} toastOk={toastOk} toastErr={toastErr} />
          </div>
        )} />
      )}

      {view === 'team' && openReview && (
        <ReviewModal reviewId={openReview} onClose={() => { setOpenReview(''); changed(); }} toastOk={toastOk} toastErr={toastErr} />
      )}
      {newOneOnOne && (
        <NewOneOnOneModal ctx={ctx} reportEmail={newOneOnOne.reportEmail} onClose={() => setNewOneOnOne(null)} toastOk={toastOk} toastErr={toastErr}
          onCreated={(s) => { setNewOneOnOne(null); loadOneOnOnes(); setOpenSeries(s.id); }} />
      )}
      {openSeries && (
        <OneOnOneModal seriesId={openSeries} onClose={() => { setOpenSeries(''); loadOneOnOnes(); }} onChanged={() => {}} toastOk={toastOk} toastErr={toastErr} />
      )}
    </div>
  );
}

