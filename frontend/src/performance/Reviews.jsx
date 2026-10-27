// Performance reviews (Neil, Oct 27 2026): one review, as the viewer may see
// it - the server decides that (backend/perf_reviews.py review_out): the
// employee sees the manager's part only once it is shared and never the
// private note. Self Review -> Manager Review -> HR Finalize -> Shared With
// Employee (Nexus Sign, the employee the only signer) -> Complete.
import { useEffect, useState } from 'react';
import { ClipboardCheck, Lock, Send, Undo2, PenLine, ArrowUpRight } from 'lucide-react';
import { api } from '../api';
import { Modal, PersonSelect, usePeople } from '../tasks/components';
import { StatusLabel } from '../components/StatusLabel';
import { LoadingState, ErrorBanner } from '../components/AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import { openPersonProfile } from '../lib/personNav';
import { ProgressBar, GoalStatus } from './Goals';
import { REVIEW_STAGE, LBL, muted } from './lib';

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
          style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '11px 12px',
            border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)' }}>
          <span className="wkc-chip"><ClipboardCheck size={14} /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{showPerson ? r.employeeName : r.cycleName}</span>
            <span style={{ display: 'block', ...muted, fontSize: 12, marginTop: 2 }}>
              {[showPerson ? r.cycleName : '', r.due ? `Due ${formatDate(r.due)}` : '', r.yours && r.stage === 'manager_review' ? 'Yours to write' : ''].filter(Boolean).join(' · ')}
            </span>
          </span>
          {r.overdue && <StatusLabel label="Overdue" color="#dc2626" size="sm" />}
          <ReviewStage stage={r.stage} />
        </button>
      ))}
    </div>
  );
}

function RatingPicker({ scale, value, onChange, disabled, label }) {
  return (
    <span role="radiogroup" aria-label={label} style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {scale.map(s => (
        <button key={s.value} type="button" role="radio" aria-checked={value === s.value} disabled={disabled}
          title={`${s.value} - ${s.label}`} onClick={() => onChange(value === s.value ? null : s.value)}
          className={value === s.value ? 'primary-btn' : 'secondary-btn'} style={{ padding: '4px 10px', fontSize: 12, minWidth: 34 }}>
          {s.value}
        </button>
      ))}
      {value != null && <span style={{ ...muted, fontSize: 12, alignSelf: 'center' }}>{scale.find(s => s.value === value)?.label}</span>}
    </span>
  );
}

const scaleLabel = (scale, v) => (v == null ? 'Not rated' : `${v} - ${scale.find(s => s.value === v)?.label || ''}`);

// The questions and values, either side - editable or read only.
function AnswerForm({ cycle, answers, values, onAnswers, onValues, readOnly }) {
  const scale = cycle.ratingScale || [];
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {(cycle.questions || []).map(q => {
        const a = answers[q.id] || {};
        return (
          <div key={q.id} style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{q.text}</div>
            {q.kind === 'rating' && (readOnly
              ? <div style={{ fontSize: 13 }}>{scaleLabel(scale, a.rating)}</div>
              : <RatingPicker scale={scale} value={a.rating ?? null} label={q.text} onChange={v => onAnswers({ ...answers, [q.id]: { ...a, rating: v } })} />)}
            {readOnly
              ? (a.text ? <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{a.text}</div> : (q.kind === 'text' ? <div style={muted}>-</div> : null))
              : <textarea className="form-input" rows={q.kind === 'text' ? 4 : 2} value={a.text || ''} placeholder={q.kind === 'rating' ? 'Add a comment (optional)' : ''}
                  onChange={e => onAnswers({ ...answers, [q.id]: { ...a, text: e.target.value } })} style={{ fontFamily: 'inherit', resize: 'vertical' }} />}
          </div>
        );
      })}
      {(cycle.values || []).length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={LBL}>Company Values</div>
          {cycle.values.map(v => (
            <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 200px', minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{v.name}</span>
                {v.description && <span style={{ display: 'block', ...muted, fontSize: 12 }}>{v.description}</span>}
              </span>
              {readOnly ? <span style={{ fontSize: 13 }}>{scaleLabel(scale, values[v.id])}</span>
                : <RatingPicker scale={scale} value={values[v.id] ?? null} label={v.name} onChange={x => onValues({ ...values, [v.id]: x })} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Section({ title, children, aside }) {
  return (
    <section style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>{title}</span>
        {aside}
      </div>
      {children}
    </section>
  );
}

function SelfPart({ r, onSaved, toastOk, toastErr }) {
  const [answers, setAnswers] = useState(r.selfAnswers || {});
  const [values, setValues] = useState(r.selfValues || {});
  const [busy, setBusy] = useState(false);
  const edit = r.can.editSelf;
  async function save(submit) {
    setBusy(true);
    try {
      onSaved(await api.perfReviewSelf(r.id, { answers, values, submit }));
      toastOk?.(submit ? 'Self review submitted - it is with your manager now.' : 'Draft saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    finally { setBusy(false); }
  }
  const empty = !Object.keys(r.selfAnswers || {}).length && !edit;
  return (
    <Section title="Self Review" aside={r.selfSubmittedAt ? <span style={muted}>Submitted {formatDateTime(r.selfSubmittedAt)}</span> : null}>
      {empty ? <div style={muted}>{r.role.employee ? 'Not started.' : 'Not submitted yet.'}</div> : (
        <AnswerForm cycle={r.cycle} answers={answers} values={values} onAnswers={setAnswers} onValues={setValues} readOnly={!edit} />
      )}
      {edit && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => save(false)}>Save Draft</button>
          <button type="button" className="primary-btn" disabled={busy} onClick={() => save(true)}>Submit Self Review</button>
        </div>
      )}
    </Section>
  );
}

function ManagerPart({ r, onSaved, toastOk, toastErr }) {
  const [answers, setAnswers] = useState(r.managerAnswers || {});
  const [values, setValues] = useState(r.managerValues || {});
  const [overall, setOverall] = useState(r.overallRating ?? null);
  const [summary, setSummary] = useState(r.managerSummary || '');
  const [note, setNote] = useState(r.privateNote || '');
  const [goals, setGoals] = useState(r.goals ? r.goals.length > 0 || !r.managerSubmittedAt : true);
  const [busy, setBusy] = useState(false);
  const edit = r.can.editManager;
  const inHr = r.stage === 'hr_review';
  if (r.stage === 'self_review' || (!edit && r.managerAnswers === undefined)) return null;
  async function save(submit) {
    setBusy(true);
    try {
      onSaved(await api.perfReviewManager(r.id, { answers, values, overall_rating: overall, summary, private_note: note, attach_goals: goals, submit }));
      toastOk?.(submit ? 'Review submitted - it is with HR now.' : 'Saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    finally { setBusy(false); }
  }
  const scale = r.cycle.ratingScale || [];
  return (
    <Section title="Manager Review" aside={<span style={muted}>{r.managerName}{r.managerSubmittedAt ? ` · Submitted ${formatDateTime(r.managerSubmittedAt)}` : ''}</span>}>
      <AnswerForm cycle={r.cycle} answers={answers} values={values} onAnswers={setAnswers} onValues={setValues} readOnly={!edit} />
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>Overall Rating</div>
        {edit ? <RatingPicker scale={scale} value={overall} onChange={setOverall} label="Overall Rating" />
          : <div style={{ fontSize: 13 }}>{scaleLabel(scale, r.overallRating)}</div>}
      </div>
      <label style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>Summary</span>
        {edit ? <textarea className="form-input" rows={4} value={summary} onChange={e => setSummary(e.target.value)} style={{ fontFamily: 'inherit', resize: 'vertical' }} />
          : <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{r.managerSummary || '-'}</div>}
      </label>
      {r.cycle.includeGoals && (edit ? (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={goals} onChange={e => setGoals(e.target.checked)} /> Attach Their Goal Progress
        </label>
      ) : (r.goals || []).length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={LBL}>Goals</div>
          {r.goals.map((g, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
              <span style={{ flex: 1, minWidth: 0 }}>{g.title}{g.dueOn ? <span style={muted}> · Due {formatDate(g.dueOn)}</span> : null}</span>
              <span style={{ width: 90 }}><ProgressBar value={g.progress} /></span>
              <GoalStatus status={g.status} />
            </div>
          ))}
        </div>
      ))}
      {r.privateNote !== undefined && (
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ ...LBL, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Lock size={12} /> Private Note for HR - Never Shown to the Employee</span>
          {edit ? <textarea className="form-input" rows={3} value={note} onChange={e => setNote(e.target.value)} style={{ fontFamily: 'inherit', resize: 'vertical' }} />
            : <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{r.privateNote || '-'}</div>}
        </label>
      )}
      {edit && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className={inHr ? 'primary-btn' : 'secondary-btn'} disabled={busy} onClick={() => save(false)}>{inHr ? 'Save Changes' : 'Save Draft'}</button>
          {!inHr && <button type="button" className="primary-btn" disabled={busy} onClick={() => save(true)}>Submit to HR</button>}
        </div>
      )}
    </Section>
  );
}

function HrPart({ r, onSaved, toastOk, toastErr }) {
  const people = usePeople();
  const [note, setNote] = useState(r.hrNote || '');
  const [back, setBack] = useState('');
  const [reviewer, setReviewer] = useState(r.managerEmail || '');
  const [busy, setBusy] = useState(false);
  const run = async (p, ok) => {
    setBusy(true);
    try { onSaved(await p()); if (ok) toastOk?.(ok); }
    catch (e) { toastErr?.(e?.message || 'Could not do that.'); }
    finally { setBusy(false); }
  };
  if (!r.can.finalize && !r.can.recall && !r.can.reassign && !r.can.startPromotion) return null;
  return (
    <Section title="HR">
      {r.can.reassign && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={LBL}>Manager Review Written By</span>
          <span style={{ minWidth: 220 }}><PersonSelect value={reviewer} onChange={setReviewer} people={people} allowNone noneLabel="HR" ariaLabel="Written by" /></span>
          {reviewer !== (r.managerEmail || '') && (
            <button type="button" className="secondary-btn" disabled={busy}
              onClick={() => run(() => api.perfReviewReviewer(r.id, reviewer), 'Reviewer changed.')}>Save</button>
          )}
        </div>
      )}
      {r.can.finalize && (<>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={LBL}>Comment From HR (Printed on the Review)</span>
          <textarea className="form-input" rows={3} value={note} onChange={e => setNote(e.target.value)} style={{ fontFamily: 'inherit', resize: 'vertical' }} />
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {note !== (r.hrNote || '') && <button type="button" className="secondary-btn" disabled={busy}
            onClick={() => run(() => api.perfReviewHrNote(r.id, note), 'Comment saved.')}>Save Comment</button>}
          <button type="button" className="primary-btn" disabled={busy || note !== (r.hrNote || '')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            title={note !== (r.hrNote || '') ? 'Save the comment first' : undefined}
            onClick={() => run(() => api.perfReviewShare(r.id), 'Shared - the employee signs to acknowledge it in Nexus Sign.')}>
            <Send size={14} /> Share With Employee
          </button>
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={LBL}>Send It Back</span>
          <textarea className="form-input" rows={2} value={back} onChange={e => setBack(e.target.value)} placeholder="What needs changing?" style={{ fontFamily: 'inherit', resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="secondary-btn" disabled={busy || back.trim().length < 3} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => run(() => api.perfReviewReturn(r.id, { to: 'manager', note: back }), 'Sent back to the manager.')}><Undo2 size={14} /> Return to Manager</button>
            <button type="button" className="secondary-btn" disabled={busy || back.trim().length < 3}
              onClick={() => run(() => api.perfReviewReturn(r.id, { to: 'employee', note: back }), 'Sent back to the employee.')}>Return to Employee</button>
          </div>
        </div>
      </>)}
      {r.can.recall && (
        <div><button type="button" className="secondary-btn" disabled={busy}
          onClick={() => run(() => api.perfReviewRecall(r.id, 'Recalled by HR'), 'Recalled - the signing request was canceled.')}>Recall From Signing</button></div>
      )}
      {r.can.startPromotion && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => { openPersonProfile(r.employeeEmail); toastOk?.('Use Promote on their profile to start the promotion.'); }}>
            <ArrowUpRight size={14} /> Start Promotion
          </button>
          <span style={muted}>Opens their profile in People, where the promotion is started.</span>
        </div>
      )}
    </Section>
  );
}

export function ReviewModal({ reviewId, onClose, onChanged, toastOk, toastErr }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    api.perfReview(reviewId).then(x => { if (live) setR(x); }).catch(e => { if (live) setErr(e?.message || 'Could not load the review.'); });
    return () => { live = false; };
  }, [reviewId]);
  const saved = (x) => { setR(x); onChanged?.(x); };
  const sign = () => {
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'myhr', sub: `sign:${r.signPartyId}` } }));
    onClose?.();
  };
  return (
    <Modal title={r ? `${r.cycle.name} - ${r.employeeName}` : 'Review'} onClose={onClose} width="72vw"
      footer={<button type="button" className="primary-btn" onClick={onClose}>Done</button>}>
      {err ? <ErrorBanner message={err} /> : !r ? <LoadingState size="section" label="Loading the review" /> : (
        <div key={`${r.stage}-${r.selfSubmittedAt}-${r.managerSubmittedAt}`} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <ReviewStage stage={r.stage} size="md" />
            {r.overdue && <StatusLabel label="Overdue" color="#dc2626" size="sm" />}
            <span style={muted}>{[r.cycle.periodStart ? `${formatDate(r.cycle.periodStart)} to ${formatDate(r.cycle.periodEnd)}` : '',
              r.stage === 'self_review' && r.cycle.selfDue ? `Self review due ${formatDate(r.cycle.selfDue)}` : '',
              r.stage === 'manager_review' && r.cycle.managerDue ? `Manager review due ${formatDate(r.cycle.managerDue)}` : ''].filter(Boolean).join(' · ')}</span>
          </div>
          {r.role.employee && r.stage === 'shared' && r.signPartyId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: 12, borderRadius: 12, background: 'var(--wk-brand-tint)' }}>
              <span style={{ flex: 1, fontSize: 13 }}>Your review is ready. Read it and sign to acknowledge you received it - signing does not mean you agree with everything in it.</span>
              <button type="button" className="primary-btn" onClick={sign} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><PenLine size={14} /> Read and Sign</button>
            </div>
          )}
          {r.role.employee && ['manager_review', 'hr_review'].includes(r.stage) && (
            <div style={muted}>Your self review is in. You will see your manager&apos;s review once HR shares it.</div>
          )}
          <SelfPart r={r} onSaved={saved} toastOk={toastOk} toastErr={toastErr} />
          <ManagerPart r={r} onSaved={saved} toastOk={toastOk} toastErr={toastErr} />
          {r.hrNote && !r.can.finalize && <Section title="Comment From HR"><div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{r.hrNote}</div></Section>}
          <HrPart r={r} onSaved={saved} toastOk={toastOk} toastErr={toastErr} />
          {(r.history || []).length > 0 && (
            <div>
              <div style={{ ...LBL, marginBottom: 6 }}>History</div>
              <div style={{ display: 'grid', gap: 4 }}>
                {r.history.slice().reverse().map((h, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {formatDateTime(h.at)} · {h.byName} · {HISTORY_WORDS[h.action] || h.action}{h.note ? ` - "${h.note}"` : ''}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

const HISTORY_WORDS = {
  launched: 'Cycle launched', self_submitted: 'Self review submitted', manager_submitted: 'Manager review submitted',
  hr_edited: 'Edited by HR', returned_to_manager: 'Returned to the manager', returned_to_employee: 'Returned to the employee',
  reviewer_changed: 'Reviewer changed', shared: 'Shared with the employee', recalled: 'Recalled from signing',
  acknowledged: 'Signed by the employee', declined: 'Not signed', signing_canceled: 'Signing canceled',
};
