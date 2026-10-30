// A performance review, made simple (Neil, Oct 29 2026). ONE form for both
// sides - What went well? What could be better? What should the focus be
// next? - with the person's Nexus numbers for the period and their goals
// beside it. The manager scores each goal (Met / Partly Met / Not Met), picks
// one Overall Rating in four words, may tick Ready for Promotion and leave a
// private note only HR reads. HR shares it; the employee reads it, adds
// their comments and clicks Acknowledge (Nexus Sign, they are its only
// signer). The server decides what this viewer may see (perf_reviews.py).
import { useEffect, useState } from 'react';
import { ClipboardCheck, Lock, Send, Undo2, PenLine, UserMinus, Sparkles, Target } from 'lucide-react';
import { api } from '../api';
import { Modal, PersonSelect, usePeople } from '../tasks/components';
import { ReviewFeedback } from './Feedback';
import { StatusLabel } from '../components/StatusLabel';
import { LoadingState, ErrorBanner } from '../components/AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import { useIsMobile } from '../lib/useIsMobile';
import { ProgressBar, GoalStatus, GoalFormModal } from './Goals';
import MyNumbers, { Segmented } from './MyNumbers';
import { REVIEW_STAGE, RATINGS, GOAL_SCORES, QUESTIONS, LBL, muted, TAP, measureText } from './lib';

export function ReviewStage({ stage, size = 'sm' }) {
  const m = REVIEW_STAGE[stage] || { label: stage, color: '#64748b' };
  return <StatusLabel label={m.label} color={m.color} size={size} />;
}

export function ReviewList({ items, onOpen, showPerson = false, empty = 'No reviews.' }) {
  if (!items?.length) return <div style={{ ...muted, padding: '6px 2px' }}>{empty}</div>;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {items.map(r => (
        <button key={r.id} type="button" onClick={() => onOpen?.(r)}
          style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '11px 12px', minHeight: 44,
            border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)' }}>
          <span className="wkc-chip"><ClipboardCheck size={14} /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{showPerson ? r.employeeName : r.cycleName}</span>
            <span style={{ display: 'block', ...muted, fontSize: 12, marginTop: 2 }}>
              {[showPerson ? r.cycleName : '', r.due ? `Due ${formatDate(r.due)}` : '', r.yours && ['self_review', 'manager_review'].includes(r.stage) ? 'Yours to write' : ''].filter(Boolean).join(' · ')}
            </span>
          </span>
          {r.overdue && <StatusLabel label="Overdue" color="#dc2626" size="sm" />}
          <ReviewStage stage={r.stage} />
        </button>
      ))}
    </div>
  );
}

function Section({ title, children, aside }) {
  return (
    <section style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14, display: 'grid', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>{title}</span>
        {aside}
      </div>
      {children}
    </section>
  );
}

// The three questions - editable or read only. `after` - something to draw
// under one question's answer (Make This a Goal under "next").
function Questions({ answers, onChange, readOnly, emptyText = '-', after = {} }) {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {QUESTIONS.map(q => {
        const text = (answers?.[q.id] || {}).text || '';
        return (
          <label key={q.id} style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>{q.text}</span>
            {readOnly
              ? <span style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.5, color: text ? 'var(--ink)' : 'var(--muted)' }}>{text || emptyText}</span>
              : <textarea className="form-input" rows={3} value={text} onChange={e => onChange({ ...answers, [q.id]: { text: e.target.value } })}
                  style={{ fontFamily: 'inherit', resize: 'vertical', fontSize: 16 }} />}
            {after[q.id] ? after[q.id](text) : null}
          </label>
        );
      })}
    </div>
  );
}

// The person's goals for the period, each with where it stands - and, for
// the manager, a score.
function GoalsBeside({ goals, scores, onScore, editable }) {
  if (!goals?.length) return <div style={muted}>No goals for this period.</div>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {goals.map(g => (
        <div key={g.id} style={{ display: 'grid', gap: 6, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ flex: '1 1 160px', minWidth: 0, fontSize: 13, fontWeight: 600 }}>{g.title}</span>
            <GoalStatus status={g.status} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: 1 }}><ProgressBar value={g.progress} label={`${g.title} progress`} /></span>
            <span style={{ ...muted, fontSize: 12, whiteSpace: 'nowrap' }}>{measureText({ ...g, metricGood: 'high' })}</span>
          </div>
          {g.measuredByNexus && <span style={{ ...muted, fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Sparkles size={11} /> {g.metricLabel}</span>}
          {editable ? (
            <Segmented label={`Score for ${g.title}`} value={scores?.[g.id] || ''} onChange={(k) => onScore({ ...scores, [g.id]: k })} options={GOAL_SCORES} />
          ) : scores?.[g.id] ? (
            <span style={{ fontSize: 12.5 }}>Score: <strong>{GOAL_SCORES.find(s => s.key === scores[g.id])?.label}</strong></span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SelfPart({ r, onSaved, toastOk, toastErr }) {
  const [answers, setAnswers] = useState(r.selfAnswers || {});
  const [busy, setBusy] = useState(false);
  const edit = r.can.editSelf;
  async function save(submit) {
    setBusy(true);
    try {
      onSaved(await api.perfReviewSelf(r.id, { answers, submit }));
      toastOk?.(submit ? 'Submitted - your manager reads it before writing theirs.' : 'Draft saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    finally { setBusy(false); }
  }
  const has = Object.values(r.selfAnswers || {}).some(a => (a?.text || '').trim());
  if (!edit && !has && !r.role.employee) {
    return <Section title="Self Review"><div style={muted}>{r.can.waitForSelf ? `Not in yet. You can write yours once it is, or after ${formatDate(r.cycle.selfDue)}.` : 'Not submitted.'}</div></Section>;
  }
  return (
    <Section title={r.role.employee ? 'Your Self Review' : 'Self Review'}
      aside={r.selfSubmittedAt ? <span style={muted}>Submitted {formatDateTime(r.selfSubmittedAt)}</span>
        : edit ? <span style={muted}>Due {formatDate(r.cycle.selfDue)}</span> : null}>
      <Questions answers={answers} onChange={setAnswers} readOnly={!edit} />
      {edit && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => save(false)} style={TAP}>Save Draft</button>
          <button type="button" className="primary-btn" disabled={busy} onClick={() => save(true)} style={TAP}>Submit</button>
        </div>
      )}
    </Section>
  );
}

function ManagerPart({ r, scores, onSaved, toastOk, toastErr }) {
  const [answers, setAnswers] = useState(r.managerAnswers || {});
  const [rating, setRating] = useState(r.rating || '');
  const [promo, setPromo] = useState(!!r.promotionReady);
  const [note, setNote] = useState(r.privateNote || '');
  const [busy, setBusy] = useState(false);
  const [goalFor, setGoalFor] = useState(null);   // { ctx, title } - Make This a Goal
  const edit = r.can.editManager;
  const ready = r.stage === 'ready';
  // Make This a Goal (spec): the answer to "What should the focus be next?"
  // opens Add Goal for them, prefilled - nothing is saved until Add Goal.
  const makeGoal = async (text) => {
    try { setGoalFor({ ctx: await api.perfMe(), title: text.trim().slice(0, 300) }); }
    catch (e) { toastErr?.(e?.message || 'Could not open the goal form.'); }
  };
  // Only for someone who may set them a goal (their direct manager or HR -
  // the server's goal rule, can.addGoal).
  const after = edit && r.can.addGoal ? { next: (text) => (text.trim() ? (
    <button type="button" className="secondary-btn" onClick={(e) => { e.preventDefault(); makeGoal(text); }}
      style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 36, fontSize: 12.5 }}>
      <Target size={13} /> Make This a Goal
    </button>) : null) } : {};
  if (!edit && r.managerAnswers === undefined) return null;
  if (!edit && !r.managerSubmittedAt && !r.rating) return null;
  async function save(submit) {
    setBusy(true);
    try {
      onSaved(await api.perfReviewManager(r.id, { answers, goal_scores: scores, rating, promotion_ready: promo, private_note: note, submit }));
      toastOk?.(submit ? 'Done - it is with HR to share.' : 'Saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    finally { setBusy(false); }
  }
  return (
    <Section title={r.role.employee ? 'Your Manager\'s Review' : 'Manager Review'}
      aside={<span style={muted}>{r.managerName}{r.managerSubmittedAt ? ` · ${formatDateTime(r.managerSubmittedAt)}` : ''}</span>}>
      <Questions answers={answers} onChange={setAnswers} readOnly={!edit} after={after} />
      {goalFor && (
        <GoalFormModal ctx={goalFor.ctx} defaults={{ title: goalFor.title, owners: [r.employeeEmail], ownerEmail: r.employeeEmail }}
          onClose={() => setGoalFor(null)} toastErr={toastErr}
          onSaved={() => { setGoalFor(null); toastOk?.(`Goal added for ${r.employeeName.split(' ')[0]}.`); }} />
      )}
      <div style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>Overall Rating</span>
        {edit ? <Segmented label="Overall Rating" value={rating} onChange={setRating} options={RATINGS} />
          : <span style={{ fontSize: 14, fontWeight: 600 }}>{r.ratingLabel || 'Not rated'}</span>}
        {r.calibratedFromLabel && <span style={muted}>Calibrated by HR - the manager rated {r.calibratedFromLabel}.</span>}
      </div>
      {r.promotionReady !== undefined && (edit ? (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5, minHeight: 40 }}>
          <input type="checkbox" checked={promo} onChange={e => setPromo(e.target.checked)} /> Ready for Promotion
        </label>
      ) : r.promotionReady ? <span style={{ fontSize: 13 }}>Ready for Promotion</span> : null)}
      {r.privateNote !== undefined && (
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ ...LBL, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Lock size={12} /> Private Note for HR - Never Shown to Them</span>
          {edit ? <textarea className="form-input" rows={2} value={note} onChange={e => setNote(e.target.value)} style={{ fontFamily: 'inherit', resize: 'vertical', fontSize: 16 }} />
            : <span style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{r.privateNote || '-'}</span>}
        </label>
      )}
      {edit && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className={ready ? 'primary-btn' : 'secondary-btn'} disabled={busy} onClick={() => save(false)} style={TAP}>{ready ? 'Save Changes' : 'Save Draft'}</button>
          {!ready && <button type="button" className="primary-btn" disabled={busy || !rating} title={!rating ? 'Pick the Overall Rating first' : undefined}
            onClick={() => save(true)} style={TAP}>Submit</button>}
        </div>
      )}
    </Section>
  );
}

function HrPart({ r, onSaved, onRemoved, toastOk, toastErr }) {
  const people = usePeople();
  const [back, setBack] = useState('');
  const [reviewer, setReviewer] = useState(r.managerEmail || '');
  const [busy, setBusy] = useState(false);
  const run = async (p, ok) => {
    setBusy(true);
    try { const out = await p(); if (ok) toastOk?.(ok); return out; }
    catch (e) { toastErr?.(e?.message || 'Could not do that.'); return null; }
    finally { setBusy(false); }
  };
  const c = r.can;
  if (!c.share && !c.recall && !c.remove && !c.reassign) return null;
  return (
    <Section title="HR">
      {c.share && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="primary-btn" disabled={busy} style={{ ...TAP, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={async () => { const out = await run(() => api.perfReviewShare(r.id), 'Shared - they can read it and acknowledge it.'); if (out) onSaved(out); }}>
            <Send size={14} /> Share With {r.employeeName.split(' ')[0]}
          </button>
        </div>
      )}
      {c.returnToManager && (
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={LBL}>Send It Back to the Manager</span>
          <textarea className="form-input" rows={2} value={back} onChange={e => setBack(e.target.value)} placeholder="What needs changing?" style={{ fontFamily: 'inherit', resize: 'vertical', fontSize: 16 }} />
          <div><button type="button" className="secondary-btn" disabled={busy || back.trim().length < 3} style={{ ...TAP, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={async () => { const out = await run(() => api.perfReviewReturn(r.id, back), 'Sent back to the manager.'); if (out) onSaved(out); }}><Undo2 size={14} /> Return to Manager</button></div>
        </div>
      )}
      {c.reassign && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={LBL}>Written By</span>
          <span style={{ minWidth: 220, flex: '1 1 220px' }}><PersonSelect value={reviewer} onChange={setReviewer} people={people} allowNone noneLabel="HR" ariaLabel="Written by" /></span>
          {reviewer !== (r.managerEmail || '') && (
            <button type="button" className="secondary-btn" disabled={busy}
              onClick={async () => { const out = await run(() => api.perfReviewReviewer(r.id, reviewer), 'Reviewer changed - they have been told.'); if (out) onSaved(out); }}>Save</button>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {c.recall && <button type="button" className="secondary-btn" disabled={busy}
          onClick={async () => { const out = await run(() => api.perfReviewRecall(r.id, 'Recalled by HR'), 'Recalled - back to Ready to Share.'); if (out) onSaved(out); }}>Recall</button>}
        {c.remove && <button type="button" className="secondary-btn" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={async () => { const out = await run(() => api.perfReviewRemove(r.id), 'Taken out of this review.'); if (out) onRemoved?.(); }}><UserMinus size={14} /> Remove From Review</button>}
      </div>
    </Section>
  );
}

// The employee's shared review: their comments and Acknowledge.
function Acknowledge({ r, onClose, toastErr }) {
  const [comment, setComment] = useState(r.employeeComment || '');
  const [busy, setBusy] = useState(false);
  const started = !!r.signPartyId;
  async function go() {
    setBusy(true);
    try {
      const out = started ? { signPartyId: r.signPartyId } : await api.perfReviewAcknowledge(r.id, comment);
      if (out?.signPartyId) {
        window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'myhr', sub: `sign:${out.signPartyId}` } }));
        onClose?.();
      }
    } catch (e) { toastErr?.(e?.message || 'Could not open it for signing.'); }
    finally { setBusy(false); }
  }
  return (
    <Section title="Acknowledge">
      <div style={{ fontSize: 13 }}>Signing says you received and read it - it does not mean you agree with everything in it.</div>
      <label className="nx-fill" style={{ display: 'grid', gap: 6 }}>
        <span style={LBL}>Your Comments (Optional - Printed on Your Copy)</span>
        <textarea className="form-input" rows={3} value={comment} disabled={started} onChange={e => setComment(e.target.value)} style={{ fontFamily: 'inherit', resize: 'vertical', fontSize: 16 }} />
      </label>
      <div><button type="button" className="primary-btn" disabled={busy} onClick={go} style={{ ...TAP, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <PenLine size={14} /> {started ? 'Continue to Sign' : 'Acknowledge'}
      </button></div>
    </Section>
  );
}

export function ReviewModal({ reviewId, onClose, onChanged, toastOk, toastErr }) {
  const phone = useIsMobile('(max-width: 900px)');
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');
  const [scores, setScores] = useState({});
  useEffect(() => {
    let live = true;
    api.perfReview(reviewId).then(x => { if (live) { setR(x); setScores(x.goalScores || {}); } })
      .catch(e => { if (live) setErr(e?.message || 'Could not load the review.'); });
    return () => { live = false; };
  }, [reviewId]);
  const saved = (x) => { setR(x); setScores(x.goalScores || scores); onChanged?.(x); };
  const scoring = !!r?.can.editManager;
  return (
    <Modal title={r ? `${r.cycle.name} - ${r.employeeName}` : 'Review'} onClose={onClose} width="80vw"
      footer={<button type="button" className="primary-btn" onClick={onClose}>Done</button>}>
      {err ? <ErrorBanner message={err} /> : !r ? <LoadingState size="section" label="Loading the review" /> : (
        <div key={`${r.stage}-${r.selfSubmittedAt}-${r.managerSubmittedAt}`} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <ReviewStage stage={r.stage} size="md" />
            {r.overdue && <StatusLabel label="Overdue" color="#dc2626" size="sm" />}
            <span style={muted}>{[r.cycle.periodStart ? `${formatDate(r.cycle.periodStart)} to ${formatDate(r.cycle.periodEnd)}` : '',
              r.cycle.due ? `Due ${formatDate(r.cycle.due)}` : ''].filter(Boolean).join(' · ')}</span>
          </div>
          {r.role.employee && ['manager_review', 'ready'].includes(r.stage) && (
            <div style={muted}>Your self review is in. You will see your manager&apos;s review once HR shares it.</div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: phone ? '1fr' : 'minmax(0, 2fr) minmax(0, 3fr)', gap: 14, alignItems: 'start' }}>
            <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
              <Section title="Their Numbers" aside={<span style={muted}>From Nexus</span>}>
                <MyNumbers email={r.employeeEmail} start={r.cycle.periodStart} end={r.cycle.periodEnd} bare />
              </Section>
              <Section title="Goals">
                <GoalsBeside goals={r.goals} scores={scoring ? scores : r.goalScores} onScore={setScores} editable={scoring} />
              </Section>
              {r.peerFeedback && (
                <Section title="Feedback From Colleagues" aside={<span style={{ ...muted, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Lock size={12} aria-hidden="true" /> Never shown to them</span>}>
                  <ReviewFeedback r={r} me={r.role.manager ? r.managerEmail : ''} toastOk={toastOk} toastErr={toastErr}
                    onAsked={() => api.perfReview(reviewId).then(saved).catch(() => {})} />
                </Section>
              )}
            </div>
            <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
              <SelfPart r={r} onSaved={saved} toastOk={toastOk} toastErr={toastErr} />
              <ManagerPart r={r} scores={scores} onSaved={saved} toastOk={toastOk} toastErr={toastErr} />
              {r.employeeComment && !r.can.acknowledge && <Section title="Employee Comments"><div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{r.employeeComment}</div></Section>}
              {r.can.acknowledge && <Acknowledge r={r} onClose={onClose} toastErr={toastErr} />}
              <HrPart r={r} onSaved={saved} onRemoved={() => { onChanged?.(); onClose?.(); }} toastOk={toastOk} toastErr={toastErr} />
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
