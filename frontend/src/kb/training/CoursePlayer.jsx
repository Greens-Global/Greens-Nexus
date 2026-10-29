// Taking a course: lessons (a Library page pinned to its version, or its
// own content), checkpoints, the final quiz (graded on the server), the
// result with what to reread, the certificate.
import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Lock, Award, Download, BookOpen, RotateCcw, AlertTriangle, ChevronRight, MapPin, UserCheck } from 'lucide-react';
import { api, saveBlob } from '../../api';
import AsyncSection from '../../components/AsyncState';
import Blocks from '../components/Blocks';
import { Chip, Banner } from '../components/Chips';
import { useToast, errText } from '../components/Toast';
import { goKb, fmtDate, plural } from '../lib';
import { OrderAnswer, ShortAnswer, PhotoAnswer, hasAnswer } from './QuestionInputs';
import { RateCourse } from './CourseFeedback';

function Quiz({ course, onDone }) {
  const toast = useToast();
  const [attempt, setAttempt] = useState(null);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try { setAttempt(await api.kbQuizStart(course.id)); setAnswers({}); setResult(null); } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  const pick = (q, pos) => setAnswers((a) => {
    const cur = a[q._id] || [];
    if (q.type === 'multi') return { ...a, [q._id]: cur.includes(pos) ? cur.filter((x) => x !== pos) : [...cur, pos] };
    return { ...a, [q._id]: [pos] };
  });
  const submit = async () => {
    setBusy(true);
    try { const r = await api.kbQuizSubmit(attempt.attempt_id, answers); setResult(r); onDone(); } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  const quiz = course.quiz;
  if (result?.pending_review) {
    return (
      <section className="kb-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center', padding: 28 }}>
        <div style={{ fontFamily: "'Figtree','Inter',sans-serif", fontSize: 21, fontWeight: 700 }}>Waiting for Review</div>
        <div className="kb-meta">Your photo goes to your manager or the course owner. You get a bell with your result; this does not use a try until it is reviewed.</div>
      </section>
    );
  }
  if (result) {
    const pct = result.score;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <section className="kb-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' }}>
          <div className="kb-ring" style={{ background: `conic-gradient(${result.passed ? '#1e7b4e' : '#dc2626'} 0 ${pct}%, #e5e7eb ${pct}% 100%)` }}><div><b style={{ fontSize: 28, letterSpacing: '-.02em', lineHeight: 1 }}>{pct}%</b><span className="kb-meta">{result.correct} of {result.total}</span></div></div>
          <div style={{ fontFamily: "'Figtree','Inter',sans-serif", fontSize: 21, fontWeight: 700 }}>{result.passed ? 'You passed.' : `Not quite. You need ${result.pass_pct}%.`}</div>
          <div className="kb-meta">Try {result.tries_used} · {result.locked ? 'no tries left: your manager can unlock another round' : result.passed ? '' : `${result.tries_left} ${result.tries_left === 1 ? 'try' : 'tries'} left`}</div>
        </section>
        {!result.passed && result.missed.length > 0 && (
          <>
            <div className="kb-title">Reread these before you try again</div>
            {result.missed.map((m) => (
              <div key={m.id} className="kb-card soft" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <b style={{ fontSize: 14.5 }}>{m.q}{m.unanswered ? <span className="kb-meta"> (not answered)</span> : ''}</b>
                {m.explanation && <div className="kb-meta">{m.explanation}</div>}
                {m.lesson_title && <span className="kb-chip" style={{ '--c': '#2b45e1', alignSelf: 'flex-start' }}><BookOpen size={12} style={{ marginLeft: -2 }} />{m.lesson_title}</span>}
              </div>
            ))}
            <div className="kb-meta">Correct answers are never shown. The next try draws from the same lessons.</div>
          </>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {result.passed ? <button type="button" className="kb-btn pri" onClick={onDone}><Award />See Your Certificate</button>
            : !result.locked ? <button type="button" className="kb-btn pri" onClick={start} disabled={busy}><RotateCcw />Try Again</button> : null}
        </div>
      </div>
    );
  }
  if (!attempt) {
    return (
      <section className="kb-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="kb-title" style={{ fontSize: 17 }}>Final Quiz</div>
        <div className="kb-meta">{quiz.draw ? `${quiz.draw} of ${quiz.question_count} questions` : plural(quiz.question_count, 'question')} · {quiz.pass_pct}% to pass · {quiz.tries_allowed} tries{quiz.tries_used ? ` (${quiz.tries_used} used)` : ''}</div>
        {quiz.in_review ? <Banner kind="blue" icon={Lock}>Your answers are waiting for a photo review. You get a bell with the result.</Banner>
          : quiz.locked ? <Banner kind="amber" icon={Lock}>Finish every lesson first. The quiz opens when the last one is marked done.</Banner>
          : quiz.passed ? <Banner kind="green" icon={Check}>You passed with {quiz.score}%.</Banner>
          : quiz.tries_left === 0 ? <Banner kind="red" icon={Lock}>No tries left. Ask your manager to unlock another round; they get a bell from the course report.</Banner>
          : <button type="button" className="kb-btn pri lg" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={start}>{quiz.open_attempt_id ? 'Continue the Quiz' : 'Start the Quiz'}</button>}
        {quiz.last && !quiz.passed && quiz.last.missed?.length > 0 && <div className="kb-meta">Last try: {quiz.last.score}%. Missed: {quiz.last.missed.map((m) => m.lesson_title).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'see the lessons'}.</div>}
      </section>
    );
  }
  const answered = attempt.questions.filter((q) => hasAnswer(answers[q._id])).length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="kb-meta">Try {attempt.try_number || (quiz.tries_used + 1)} · {attempt.pass_pct}% to pass · {answered} of {attempt.questions.length} answered</div>
      {attempt.questions.map((q, i) => (
        <section key={q._id} className="kb-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 15.5 }}>{i + 1}. {q.q}{q.type === 'multi' && <span className="kb-meta" style={{ fontWeight: 400 }}> (choose all that apply)</span>}</div>
          {q.type === 'order' ? <OrderAnswer q={q} value={answers[q._id]} onChange={(v) => setAnswers((a) => ({ ...a, [q._id]: v }))} />
            : q.type === 'short' ? <ShortAnswer q={q} value={answers[q._id]} onChange={(v) => setAnswers((a) => ({ ...a, [q._id]: v }))} />
            : q.type === 'photo' ? <PhotoAnswer q={q} value={answers[q._id]} onChange={(v) => setAnswers((a) => ({ ...a, [q._id]: v }))} />
            : q.options.map((o, pos) => {
              const on = (answers[q._id] || []).includes(pos);
              return <label key={pos} className={`kb-option${on ? ' on' : ''}`}><input type={q.type === 'multi' ? 'checkbox' : 'radio'} name={q._id} checked={on} onChange={() => pick(q, pos)} /><span>{o}</span></label>;
            })}
        </section>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" className="kb-btn pri lg" disabled={busy || answered < attempt.questions.length} onClick={submit}>Submit Answers</button>
        {answered < attempt.questions.length && <span className="kb-meta">Answer every question to submit.</span>}
      </div>
    </div>
  );
}

function Checkpoint({ course, lesson, onDone }) {
  const toast = useToast();
  const [attempt, setAttempt] = useState(null);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  useEffect(() => { api.kbCheckpointStart(course.id, lesson._id).then(setAttempt).catch((e) => toast(errText(e), 'err')); }, [course.id, lesson._id, toast]);
  const submit = async () => { try { setResult(await api.kbCheckpointSubmit(attempt.attempt_id, answers)); onDone(); } catch (e) { toast(errText(e), 'err'); } };
  if (!attempt) return <div className="kb-empty">Loading the checkpoint...</div>;
  if (result) return (
    <section className="kb-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="kb-title" style={{ fontSize: 17 }}>{result.correct} of {result.total} right</div>
      <div className="kb-meta">A checkpoint is practice; it does not count as a quiz try. {result.missed.length ? 'Worth rereading:' : 'Well done.'}</div>
      {result.missed.map((m) => <div key={m.id} className="kb-card soft" style={{ padding: 10 }}><b style={{ fontSize: 14 }}>{m.q}</b>{m.explanation && <div className="kb-meta">{m.explanation}</div>}</div>)}
    </section>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {attempt.questions.map((q, i) => (
        <section key={q._id} className="kb-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontWeight: 600 }}>{i + 1}. {q.q}</div>
          {q.type === 'order' && <OrderAnswer q={q} value={answers[q._id]} onChange={(v) => setAnswers((a) => ({ ...a, [q._id]: v }))} />}
          {q.type === 'short' && <ShortAnswer q={q} value={answers[q._id]} onChange={(v) => setAnswers((a) => ({ ...a, [q._id]: v }))} />}
          {q.type === 'photo' && <PhotoAnswer q={q} value={answers[q._id]} onChange={(v) => setAnswers((a) => ({ ...a, [q._id]: v }))} />}
          {!['order', 'short', 'photo'].includes(q.type) && q.options.map((o, pos) => <label key={pos} className={`kb-option${(answers[q._id] || []).includes(pos) ? ' on' : ''}`}><input type={q.type === 'multi' ? 'checkbox' : 'radio'} name={q._id} checked={(answers[q._id] || []).includes(pos)} onChange={() => setAnswers((a) => ({ ...a, [q._id]: q.type === 'multi' ? ((a[q._id] || []).includes(pos) ? a[q._id].filter((x) => x !== pos) : [...(a[q._id] || []), pos]) : [pos] }))} /><span>{o}</span></label>)}
        </section>
      ))}
      <button type="button" className="kb-btn pri" style={{ alignSelf: 'flex-start' }} onClick={submit}>Check My Answers</button>
    </div>
  );
}

export default function CoursePlayer({ id, me }) {
  const toast = useToast();
  const [course, setCourse] = useState(null);
  const [err, setErr] = useState('');
  const [cur, setCur] = useState('');   // lesson id | 'quiz' | 'done'
  const load = () => { setErr(''); return api.kbCourse(id).then((c) => { setCourse(c); return c; }).catch((e) => { setErr(errText(e)); return null; }); };
  useEffect(() => { setCourse(null); setCur(''); load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!course || cur) return;
    const next = course.lessons.find((L) => !L.done);
    const after = course.delivery === 'in_person' ? 'inperson' : 'quiz';   // In Person: the sign-off step (WP 5.1)
    setCur(next ? next._id : course.my_status === 'Completed' ? 'done' : (course.delivery === 'in_person' || (course.quiz.question_count && !course.quiz.passed)) ? after : (course.lessons[0]?._id || after));
  }, [course, cur]);
  // WP 5.10: a lesson with an uploaded video counts only once every such video
  // has played to the end in this visit (links to YouTube etc. cannot be watched for).
  const [watched, setWatched] = useState({});
  const lessonVideos = (L) => (L.blocks?.content || []).filter((n) => n?.type === 'video' && n.attrs?.kind === 'file' && n.attrs?.url).map((n) => n.attrs.url);
  const videosWatched = (L) => lessonVideos(L).every((u) => watched[`${L._id}|${u}`]);
  const markDone = async (L) => {
    try { setCourse(await api.kbMarkLessonDone(course.id, L._id)); const i = course.lessons.findIndex((x) => x._id === L._id); const nxt = course.lessons[i + 1]; setCur(nxt ? nxt._id : course.delivery === 'in_person' ? 'inperson' : (course.quiz.question_count ? 'quiz' : 'done')); } catch (e) { toast(errText(e), 'err'); }
  };
  const download = async () => { try { saveBlob(await api.kbCertificatePdf(course.certificate.id), `${course.certificate.serial}.pdf`); } catch (e) { toast(errText(e), 'err'); } };

  return (
    <AsyncSection loading={!course && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
      {course && (
        <div className="kb-page">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} className="kb-meta">
            <button type="button" className="kb-ibtn" style={{ width: 30, height: 30 }} aria-label="Back to Training" onClick={() => goKb('training')}><ArrowLeft /></button>
            <a href="#t" onClick={(e) => { e.preventDefault(); goKb('training'); }}>Training</a> / <b style={{ color: 'var(--kb-ink)' }}>{course.title}</b>
            {course.can_edit && <button type="button" className="kb-btn sm" style={{ marginLeft: 'auto' }} onClick={() => goKb('builder', course.id)}>Edit Course</button>}
          </div>
          {course.status !== 'published' && <Banner kind="amber" icon={AlertTriangle}>This course is not published. You are previewing the live content as a learner would see it.</Banner>}
          <div className="kb-cols">
            <aside className="kb-rail" style={{ flex: '0 1 300px', maxWidth: 320 }}>
              <section className="kb-card" style={{ padding: 14 }}>
                <div style={{ padding: '4px 10px 10px' }}>
                  <div className="kb-title" style={{ fontSize: 16 }}>{course.title}</div>
                  <div className="kb-meta">{course.code} · v{course.major} · about {plural(course.est_minutes, 'minute')}{course.due_date ? ` · due ${fmtDate(course.due_date)}` : ''}</div>
                  <div className="kb-progress" style={{ marginTop: 8 }}><i style={{ width: `${course.my_pct}%` }} /></div>
                </div>
                {course.lessons.map((L, i) => (
                  <div key={L._id} className={`kb-lesson${cur === L._id ? ' on' : ''}`} onClick={() => setCur(L._id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setCur(L._id); }}>
                    <span className={`num${L.done ? ' done' : ''}`}>{L.done ? <Check size={13} /> : i + 1}</span>
                    <span className="kb-grow"><span style={{ fontWeight: 600, fontSize: 13.5, display: 'block' }}>{L.title}</span><span className="kb-meta">{L.type === 'checkpoint' ? `Checkpoint · ${plural(L.question_count, 'question')}` : L.type === 'page' ? `Library page · v${L.page?.version || ''}` : `${plural(L.reading_minutes, 'minute')}`}</span></span>
                  </div>
                ))}
                {course.delivery === 'in_person' && (
                  <div className={`kb-lesson${cur === 'inperson' ? ' on' : ''}`} onClick={() => setCur('inperson')} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setCur('inperson'); }}>
                    <span className={`num${course.my_status === 'Completed' ? ' done' : ''}`}>{course.my_status === 'Completed' ? <Check size={13} /> : <UserCheck size={12} />}</span>
                    <span className="kb-grow"><span style={{ fontWeight: 600, fontSize: 13.5, display: 'block' }}>In-Person Sign-Off</span><span className="kb-meta">{course.sessions?.length ? course.sessions[0].when : 'with a trainer or your manager'}</span></span>
                  </div>
                )}
                {course.delivery !== 'in_person' && course.quiz.question_count > 0 && (
                  <div className={`kb-lesson${cur === 'quiz' ? ' on' : ''}`} onClick={() => setCur('quiz')} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setCur('quiz'); }}>
                    <span className={`num${course.quiz.passed ? ' done' : ''}`}>{course.quiz.passed ? <Check size={13} /> : course.quiz.locked ? <Lock size={12} /> : '?'}</span>
                    <span className="kb-grow"><span style={{ fontWeight: 600, fontSize: 13.5, display: 'block' }}>Final Quiz</span><span className="kb-meta">{course.quiz.draw ? `${course.quiz.draw} of ${course.quiz.question_count}` : course.quiz.question_count} questions · {course.quiz.pass_pct}% to pass</span></span>
                  </div>
                )}
              </section>
              {course.overview?.length > 0 && <section className="kb-card"><h3 className="kb-h3" style={{ marginBottom: 6 }}>What You'll Learn</h3><ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5 }}>{course.overview.map((o, i) => <li key={i}>{o}</li>)}</ul></section>}
            </aside>

            <div className="kb-main">
              {course.lessons.map((L) => L._id === cur && (
                <div key={L._id} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div className="kb-card kb-article" style={{ padding: '28px 36px' }}>
                    <div className="kb-meta">Lesson {course.lessons.indexOf(L) + 1} of {course.lessons.length}{L.type === 'page' && L.page?.code ? ` · from ${L.page.code} v${L.page.version}` : ''}</div>
                    <h1 className="kb-h1" style={{ fontSize: 26 }}>{L.title}</h1>
                    {L.summary && <p className="kb-sub" style={{ fontSize: 15, marginBottom: 12 }}>{L.summary}</p>}
                    {L.page?.newer && me?.can_author && <Banner kind="amber" icon={AlertTriangle}>This lesson is pinned to v{L.page.version}; the page is now v{L.page.current_version}. Update it in the course builder.</Banner>}
                    {L.page?.missing && <Banner kind="red" icon={AlertTriangle}>The page this lesson pointed at is no longer available.</Banner>}
                    {L.type === 'checkpoint' ? <Checkpoint course={course} lesson={L} onDone={load} /> : <Blocks doc={L.blocks} onVideoEnded={(u) => setWatched((w) => ({ ...w, [`${L._id}|${u}`]: true }))} />}
                    {L.type === 'page' && L.page?.doc_id && <div className="kb-meta" style={{ marginTop: 12 }}><a href="#p" onClick={(e) => { e.preventDefault(); goKb('page', L.page.doc_id); }}>Open this page in the Library</a></div>}
                  </div>
                  {L.type !== 'checkpoint' && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {!L.done ? <button type="button" className="kb-btn pri lg" disabled={!videosWatched(L)} title={videosWatched(L) ? undefined : 'Watch the video to the end first'} onClick={() => markDone(L)}><Check />Mark Lesson Complete</button>
                        : <button type="button" className="kb-btn lg" onClick={() => { const i = course.lessons.indexOf(L); const nxt = course.lessons[i + 1]; setCur(nxt ? nxt._id : 'quiz'); }}>Next<ChevronRight /></button>}
                      {L.done && <Chip color="#1e7b4e">Done</Chip>}
                      {!L.done && !videosWatched(L) && <span className="kb-meta">Watch the video to the end to finish this lesson.</span>}
                    </div>
                  )}
                </div>
              ))}
              {cur === 'quiz' && <Quiz course={course} onDone={load} />}
              {cur === 'inperson' && course.my_status !== 'Completed' && (
                <section className="kb-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div className="kb-title" style={{ fontSize: 17 }}>Completed In Person</div>
                  <div className="kb-meta">This course is finished on site: a trainer marks you Attended at a session, or your manager signs you off after watching you do it. The certificate follows.</div>
                  {(course.sessions || []).length === 0 ? <div className="kb-empty">No session is booked for you yet. Your manager or the course owner will add you to one.</div>
                    : course.sessions.map((s) => (
                      <div key={s.id} className="kb-row"><MapPin size={16} style={{ color: 'var(--kb-dim)' }} />
                        <div className="kb-grow"><div className="kb-title">{s.when}</div><div className="kb-meta">{[s.location, s.trainer_name && `trainer ${s.trainer_name}`].filter(Boolean).join(' · ')}</div></div></div>
                    ))}
                </section>
              )}
              {(cur === 'done' || (course.my_status === 'Completed' && cur !== 'quiz' && !course.lessons.some((L) => L._id === cur))) && (
                <section className="kb-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center', padding: 36 }}>
                  <Award size={40} style={{ color: 'var(--kb-green)' }} />
                  <div style={{ fontFamily: "'Figtree','Inter',sans-serif", fontSize: 22, fontWeight: 700 }}>Course completed</div>
                  <div className="kb-meta">{fmtDate(course.completed_at)}{course.quiz.score != null && course.quiz.question_count ? ` · ${course.quiz.score}%` : ''}{course.expires ? ` · valid through ${fmtDate(course.expires)}` : ''}</div>
                  {course.certificate && <><div className="kb-meta">Certificate {course.certificate.serial}</div><button type="button" className="kb-btn pri" onClick={download}><Download />Download Certificate</button></>}
                  <RateCourse course={course} onSaved={load} />
                </section>
              )}
            </div>
          </div>
        </div>
      )}
    </AsyncSection>
  );
}
