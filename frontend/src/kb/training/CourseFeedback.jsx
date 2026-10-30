// Course feedback (WP 5.7, Oct 29 2026): the learner rates a course they
// finished (once per version); the owner sees the average and the comments,
// without names. Backend: POST /kb/courses/{id}/feedback, report.feedback.
import { useState } from 'react';
import { Star, Send } from 'lucide-react';
import { api } from '../../api';
import { useToast, errText } from '../components/Toast';
import { fmtDate } from '../lib';

function Stars({ value, onPick, size = 22 }) {
  return (
    <span role={onPick ? 'radiogroup' : undefined} aria-label={onPick ? 'Rating' : `${value} of 5 stars`} style={{ display: 'inline-flex', gap: 2 }}>
      {[1, 2, 3, 4, 5].map((n) => {
        const icon = <Star size={size} fill={n <= value ? '#f59e0b' : 'none'} color={n <= value ? '#f59e0b' : 'var(--kb-dim)'} />;
        return onPick
          ? <button key={n} type="button" role="radio" aria-checked={n === value} aria-label={`${n} star${n > 1 ? 's' : ''}`} className="kb-ibtn" style={{ width: size + 8, height: size + 8 }} onClick={() => onPick(n)}>{icon}</button>
          : <span key={n}>{icon}</span>;
      })}
    </span>
  );
}

export function RateCourse({ course, onSaved }) {
  const toast = useToast();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  if (course.my_feedback) return <div className="kb-meta">You rated this course <Stars value={course.my_feedback.rating} size={14} />. Thank you.</div>;
  const send = async () => {
    setBusy(true);
    try { await api.kbCourseFeedback(course.id, rating, comment); toast('Thanks for the feedback'); onSaved?.(); }
    catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', width: '100%', maxWidth: 420 }}>
      <div className="kb-title">How Was This Course?</div>
      <Stars value={rating} onPick={setRating} />
      <textarea className="kb-textarea" style={{ minHeight: 60, width: '100%' }} aria-label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Optional: what was clear, what was not. The owner sees it without your name." />
      <button type="button" className="kb-btn sm pri" disabled={busy || !rating} onClick={send}><Send />Send Feedback</button>
    </div>
  );
}

export function FeedbackSummary({ feedback }) {
  if (!feedback) return null;
  return (
    <section className="kb-card">
      <h3 className="kb-h3" style={{ marginBottom: 6 }}>Feedback</h3>
      {!feedback.count ? <div className="kb-empty">No ratings yet.</div> : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><b style={{ fontSize: 22 }}>{feedback.average}</b><Stars value={Math.round(feedback.average)} size={14} /><span className="kb-meta">from {feedback.count}</span></div>
          {feedback.comments.slice(0, 10).map((c) => (
            <div key={`${c.at}${c.comment}`} className="kb-row" style={{ alignItems: 'flex-start', padding: '8px 0' }}>
              <div className="kb-grow"><Stars value={c.rating} size={12} /><div style={{ fontSize: 13.5 }}>{c.comment}</div><div className="kb-meta">{fmtDate(c.at)}</div></div>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
