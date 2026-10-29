// One person's Performance page (Neil, Oct 29 2026: one page, the same for
// the employee and their manager): My Numbers, their goals, their reviews.
// Workday > Performance draws it for "me"; My Team draws it for a direct
// report; People > a person's profile draws it read-mostly for HR. The
// server decides what each viewer may read and change.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Target, ClipboardCheck } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import MyNumbers from './MyNumbers';
import { GoalList, GoalFormModal, GoalDetailModal, AddGoalButton } from './Goals';
import { ReviewList, ReviewModal } from './Reviews';
import { card, cardHead, HD, LBL, muted } from './lib';

function Card({ Icon, title, action, children, label }) {
  return (
    <section style={card} aria-label={label || title}>
      <div style={cardHead}>
        <span className="wkc-chip"><Icon size={14} /></span>
        <span style={HD}>{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

// `email` '' = me. `name` labels the cards for someone else. `reviews` - the
// review rows to show (mine for me; theirs for a manager). `canAdd` - may the
// viewer add a goal for them (themselves, or a direct report).
// `aside` - a column beside the goals and reviews (Workday puts My 1:1s
// there), with the numbers across the top; `wide` = side by side.
export default function PersonPerformance({ ctx, email = '', name = '', reviews = null, canAdd = true, openGoalId = '',
  openReviewId = '', onChanged, toastOk, toastErr, aside = null, wide = true }) {
  const self = !email || email === ctx?.email;
  const [goals, setGoals] = useState(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(false);
  const [openGoal, setOpenGoal] = useState(openGoalId);
  const [openReview, setOpenReview] = useState(openReviewId);
  const [prevGoal, setPrevGoal] = useState(openGoalId);
  if (openGoalId !== prevGoal) { setPrevGoal(openGoalId); if (openGoalId) setOpenGoal(openGoalId); }
  const [prevReview, setPrevReview] = useState(openReviewId);
  if (openReviewId !== prevReview) { setPrevReview(openReviewId); if (openReviewId) setOpenReview(openReviewId); }

  const load = useCallback(() => {
    const p = self ? api.perfGoals('mine') : api.perfGoals('person', { person: email });
    return p.then(r => { setErr(''); setGoals(r); }).catch(e => setErr(e?.message || 'Could not load the goals.'));
  }, [self, email]);
  useEffect(() => { load(); }, [load]);

  const owner = self ? ctx?.email : email;
  const theirs = useMemo(() => (goals || []).filter(g => g.level === 'personal' && g.ownerEmail === owner), [goals, owner]);
  const shared = useMemo(() => (goals || []).filter(g => g.level !== 'personal'), [goals]);
  const open = theirs.filter(g => !g.archived && g.status !== 'done').length;
  const full = open >= (ctx?.maxGoals || 5);
  const refresh = () => { load(); onChanged?.(); };
  const approve = async (g) => {
    try { await api.perfGoalApprove(g.id); toastOk?.('Goal approved.'); refresh(); }
    catch (e) { toastErr?.(e?.message || 'Could not approve the goal.'); }
  };
  const first = (name || '').split(' ')[0];

  const main = (
    <>
      <Card Icon={Target} title={self ? 'My Goals' : 'Goals'} label={self ? 'My Goals' : 'Goals'}
        action={canAdd ? (
          <AddGoalButton onClick={() => setForm(true)} disabled={full}
            title={full ? `${ctx?.maxGoals || 5} open goals already - finish or archive one first` : undefined}
            label={self ? 'Add Goal' : 'Add Goal for Them'} />
        ) : null}>
        {err ? <ErrorBanner message={err} onRetry={load} /> : goals === null ? <SkeletonBlocks count={2} height={58} /> : (
          <div style={{ display: 'grid', gap: 14 }}>
            <GoalList goals={theirs} onOpen={g => setOpenGoal(g.id)} onApprove={approve}
              empty={self ? 'No goals yet. Add up to five - or your manager will.' : 'No goals yet.'} />
            {self && shared.length > 0 && (
              <div>
                <div style={{ ...LBL, marginBottom: 8 }}>Company and Department Goals</div>
                <GoalList goals={shared} onOpen={g => setOpenGoal(g.id)} />
              </div>
            )}
            {full && canAdd && <div style={{ ...muted, fontSize: 12 }}>Five open goals - finish or archive one to add another.</div>}
          </div>
        )}
      </Card>
      {reviews && reviews.length > 0 && (
        <Card Icon={ClipboardCheck} title={self ? 'My Reviews' : 'Reviews'}>
          {(() => {
            const now = reviews.filter(r => r.stage !== 'complete');
            const past = reviews.filter(r => r.stage === 'complete');
            return (
              <div style={{ display: 'grid', gap: 12 }}>
                {now.length > 0 && <ReviewList items={now} onOpen={r => setOpenReview(r.id)} />}
                {past.length > 0 && (
                  <div>
                    <div style={{ ...LBL, marginBottom: 8 }}>Past Reviews</div>
                    <ReviewList items={past} onOpen={r => setOpenReview(r.id)} />
                  </div>
                )}
              </div>
            );
          })()}
        </Card>
      )}
    </>
  );

  return (
    <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      <MyNumbers email={self ? '' : email} title={self ? 'My Numbers' : `${first ? `${first}'s` : 'Their'} Numbers`} />
      {aside ? (
        <div style={{ display: 'grid', gridTemplateColumns: wide ? 'minmax(0, 3fr) minmax(0, 2fr)' : 'minmax(0, 1fr)', gap: 14, alignItems: 'start' }}>
          <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>{main}</div>
          {aside}
        </div>
      ) : main}
      {form && (
        <GoalFormModal ctx={ctx} defaults={self ? {} : { owners: [email], ownerEmail: email }} parents={goals || []} toastErr={toastErr}
          onClose={() => setForm(false)} onSaved={() => { setForm(false); toastOk?.('Goal added.'); refresh(); }} />
      )}
      {openGoal && (
        <GoalDetailModal goalId={openGoal} ctx={ctx} parents={goals || []} onClose={() => setOpenGoal('')}
          onChanged={refresh} toastOk={toastOk} toastErr={toastErr} />
      )}
      {openReview && (
        <ReviewModal reviewId={openReview} onClose={() => { setOpenReview(''); onChanged?.(); }} onChanged={() => onChanged?.()}
          toastOk={toastOk} toastErr={toastErr} />
      )}
    </div>
  );
}
