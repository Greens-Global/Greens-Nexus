// Taking a course: the course home (what it is, what you will learn, the
// outline - Neil, 11/07/2026), then lessons (a Library page pinned to its
// version, or its own content), checkpoints, the final quiz (graded on the
// server), the result with what to reread, the certificate.
import { useEffect, useState } from 'react';
import { Check, Lock, Award, Download, BookOpen, RotateCcw, AlertTriangle, ChevronRight, ChevronLeft, MapPin, UserCheck, Home, Clock, Compass, Play } from 'lucide-react';
import { api, saveBlob } from '../../api';
import AsyncSection from '../../components/AsyncState';
import Blocks from '../components/Blocks';
import { Chip, Banner } from '../components/Chips';
import { useToast, errText } from '../components/Toast';
import { useTrailCrumbs } from '../../components/PageTrail';
import { goKb, fmtDate, plural, minutesText } from '../lib';
import { OrderAnswer, ShortAnswer, PhotoAnswer, hasAnswer } from './QuestionInputs';
import { RateCourse } from './CourseFeedback';
import { courseTrackState } from './MyTraining';
import { LevelChip } from './cards';
import { shelfOf } from './catalogModel';
import ProgressTrack from '../../ui/ProgressTrack';

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
      <section className="kb-card kb-quiz-head">
        <div className="kb-title" style={{ fontSize: 16 }}>Final Quiz</div>
        <div className="kb-meta">Try {attempt.try_number || (quiz.tries_used + 1)} · {attempt.pass_pct}% to pass · {answered} of {attempt.questions.length} answered</div>
        <ProgressTrack size="sm" value={attempt.questions.length ? answered / attempt.questions.length : 0} state={answered >= attempt.questions.length ? 'done' : 'live'} label="Questions answered" valueText={`${answered} of ${attempt.questions.length} answered`} style={{ marginTop: 8 }} />
      </section>
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

// The course home: a title page. What the course is, the facts in one
// line, what you will learn, and the outline as a table of contents with
// each lesson's minutes in a column - then one button.
function CourseHome({ course, onGo, onDownload }) {
  const shelf = shelfOf(course);
  const done = course.my_status === 'Completed';
  const next = course.lessons.find((L) => !L.done);
  const started = course.lessons.some((L) => L.done) || course.my_status === 'In Progress';
  const quiz = course.quiz || {};
  const reading = course.lessons.filter((L) => L.type !== 'checkpoint');
  const checks = course.lessons.filter((L) => L.type === 'checkpoint');
  const facts = [
    `${plural(reading.length, 'lesson')}${checks.length ? ` and ${plural(checks.length, 'checkpoint')}` : ''}`,
    `about ${minutesText(course.est_minutes) || plural(course.est_minutes, 'minute')}`,
    quiz.question_count > 0 ? `a final quiz of ${quiz.draw ? `${quiz.draw} of ${quiz.question_count}` : quiz.question_count} questions, ${quiz.pass_pct}% to pass` : course.delivery === 'in_person' ? 'signed off in person' : 'no quiz',
    course.recert_months > 0 ? `renews every ${course.recert_months} months` : '',
    'a certificate on completion',
  ].filter(Boolean).join(' · ');
  return (
    <div className="kb-read">
      <header className="kb-lead">
        <div className="kb-lead-text">
          <div className="kb-kicker">{[shelf !== 'General' ? shelf : '', course.code ? `${course.code} v${course.major}` : ''].filter(Boolean).join(' · ')}{course.level ? <> · <LevelChip level={course.level} /></> : null}</div>
          <h1 className="kb-h1 kb-lead-title">{course.title}</h1>
          {course.description && <p className="kb-lead-sub">{course.description}</p>}
          <div className="kb-meta">{facts}</div>
          {started && !done && <ProgressTrack value={(course.my_pct || 0) / 100} state={courseTrackState(course)} label="Course progress" valueText={`${course.my_pct || 0}% done`} style={{ marginTop: 14, maxWidth: 480 }} note={<><b>{course.my_pct || 0}%</b> done · {course.lessons.filter((L) => L.done).length} of {course.lessons.length} lessons</>} />}
          {course.days_overdue > 0 && <div className="kb-meta" style={{ marginTop: 8 }}><b style={{ color: '#dc2626' }}>{plural(course.days_overdue, 'day')} overdue</b> · was due {fmtDate(course.due_date)}</div>}
          {course.due_date && !course.days_overdue && !done && <div className="kb-meta" style={{ marginTop: 8 }}>Due {fmtDate(course.due_date)}</div>}
        </div>
        <div className="kb-lead-side">
          {done && <>
            <span className="kb-mark done" style={{ alignSelf: 'flex-start' }}><Check size={12} />Completed {fmtDate(course.completed_at)}</span>
            <div className="kb-meta">{course.quiz?.score != null && quiz.question_count ? `Scored ${course.quiz.score}%. ` : ''}{course.expires ? `Valid through ${fmtDate(course.expires)}.` : ''}</div>
            {course.certificate && <button type="button" className="kb-btn pri" onClick={onDownload}><Download />Download Certificate</button>}
            <button type="button" className="kb-btn" onClick={() => onGo(course.lessons[0]?._id)}>Read It Again</button>
          </>}
          {!done && <button type="button" className="kb-btn pri lg" disabled={course.status !== 'published' && !course.can_edit} onClick={() => onGo(next ? next._id : course.delivery === 'in_person' ? 'inperson' : 'quiz')}><Play />{started ? 'Continue' : 'Start Course'}{next ? `: ${next.title}` : ''}</button>}
        </div>
      </header>
      <div className="kb-cols">
        <section className="kb-main kb-toc">
          <h2 className="kb-shelf-title">Outline</h2>
          <ol className="kb-outline">
            {course.lessons.map((L, i) => (
              <li key={L._id} className={L.done ? 'done' : ''}>
                <button type="button" onClick={() => onGo(L._id)}>
                  <span className="kb-item-n" aria-hidden="true">{L.done ? <Check size={14} /> : i + 1}</span>
                  <span className="kb-outline-text">
                    <span className="kb-outline-title">{L.title}{L.type === 'checkpoint' && <span className="kb-item-kind">Checkpoint</span>}{L.type === 'page' && <span className="kb-item-kind">Library page</span>}</span>
                    {L.summary && <span className="kb-meta kb-clamp2">{L.summary}</span>}
                  </span>
                  <span className="kb-outline-min">{L.type === 'checkpoint' ? plural(L.question_count, 'question') : `${L.reading_minutes} min`}</span>
                </button>
              </li>
            ))}
            {course.delivery === 'in_person' && <li className={done ? 'done' : ''}><button type="button" onClick={() => onGo('inperson')}><span className="kb-item-n" aria-hidden="true">{done ? <Check size={14} /> : <UserCheck size={14} />}</span><span className="kb-outline-text"><span className="kb-outline-title">In-Person Sign-Off</span><span className="kb-meta">With a trainer or your manager.</span></span><span className="kb-outline-min" /></button></li>}
            {course.delivery !== 'in_person' && quiz.question_count > 0 && <li className={quiz.passed ? 'done' : ''}><button type="button" onClick={() => onGo('quiz')}><span className="kb-item-n" aria-hidden="true">{quiz.passed ? <Check size={14} /> : '?'}</span><span className="kb-outline-text"><span className="kb-outline-title">Final Quiz</span><span className="kb-meta">{quiz.pass_pct}% to pass, {quiz.tries_allowed} tries; a miss shows where to reread, never the answer.</span></span><span className="kb-outline-min">{plural(quiz.draw || quiz.question_count, 'question')}</span></button></li>}
          </ol>
        </section>
        <aside className="kb-rail kb-read-rail">
          {course.overview?.length > 0 && <section><h2 className="kb-shelf-title">What You'll Learn</h2><ul className="kb-learn">{course.overview.map((o, i) => <li key={i}><Check size={14} />{o}</li>)}</ul></section>}
          {course.tags?.length > 0 && <section><h2 className="kb-shelf-title">Topics</h2><div className="kb-meta">{course.tags.join(' · ')}</div></section>}
          <section><div className="kb-meta">Lessons are marked complete one at a time, so you can stop and come back on any device.</div></section>
        </aside>
      </div>
    </div>
  );
}

function Meta({ icon: Icon, children }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon size={13} />{children}</span>;
}

export default function CoursePlayer({ id, me }) {
  const toast = useToast();
  const [course, setCourse] = useState(null);
  // The page trail: KNOWLEDGE BASE / TRAINING over the course (11/04/2026).
  useTrailCrumbs([{ label: 'Training', onClick: () => goKb('training') }]);
  const [err, setErr] = useState('');
  const [cur, setCur] = useState('');   // 'home' | lesson id | 'quiz' | 'inperson' | 'done'
  const load = () => { setErr(''); return api.kbCourse(id).then((c) => { setCourse(c); return c; }).catch((e) => { setErr(errText(e)); return null; }); };
  useEffect(() => { setCourse(null); setCur(''); load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!course || cur) return;
    // Not started yet, or finished: open on the course home. Mid-course: the next lesson.
    const started = course.lessons.some((L) => L.done) || course.quiz?.tries_used > 0;
    if (!started || course.my_status === 'Completed') { setCur('home'); return; }
    const next = course.lessons.find((L) => !L.done);
    const after = course.delivery === 'in_person' ? 'inperson' : 'quiz';   // In Person: the sign-off step (WP 5.1)
    setCur(next ? next._id : (course.delivery === 'in_person' || (course.quiz.question_count && !course.quiz.passed)) ? after : 'home');
  }, [course, cur]);
  useEffect(() => { if (cur) window.scrollTo?.({ top: 0, behavior: 'auto' }); }, [cur]);
  // WP 5.10: a lesson with an uploaded video counts only once every such video
  // has played to the end in this visit (links to YouTube etc. cannot be watched for).
  const [watched, setWatched] = useState({});
  const lessonVideos = (L) => (L.blocks?.content || []).filter((n) => n?.type === 'video' && n.attrs?.kind === 'file' && n.attrs?.url).map((n) => n.attrs.url);
  const videosWatched = (L) => lessonVideos(L).every((u) => watched[`${L._id}|${u}`]);
  const afterLessons = (c) => (c.delivery === 'in_person' ? 'inperson' : (c.quiz.question_count ? 'quiz' : 'done'));
  const markDone = async (L) => {
    try { const c = await api.kbMarkLessonDone(course.id, L._id); setCourse(c); const i = course.lessons.findIndex((x) => x._id === L._id); const nxt = course.lessons[i + 1]; setCur(nxt ? nxt._id : c.my_status === 'Completed' ? 'done' : afterLessons(course)); } catch (e) { toast(errText(e), 'err'); }
  };
  const download = async () => { try { saveBlob(await api.kbCertificatePdf(course.certificate.id), `${course.certificate.serial}.pdf`); } catch (e) { toast(errText(e), 'err'); } };

  return (
    <AsyncSection loading={!course && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
      {course && (
        <div className="kb-page">
          {course.status !== 'published' && <Banner kind="amber" icon={AlertTriangle}>This course is not published. You are previewing the live content as a learner would see it.{course.can_edit && <button type="button" className="kb-btn sm" style={{ marginLeft: 10 }} onClick={() => goKb('builder', course.id)}>Edit Course</button>}</Banner>}
          {cur === 'home' && <CourseHome course={course} onGo={setCur} onDownload={download} />}
          {cur !== 'home' && (
          <div className="kb-cols">
            <aside className="kb-rail kb-course-rail" style={{ flex: '0 1 300px', maxWidth: 320 }}>
              <section className="kb-card" style={{ padding: 14 }}>
                <div style={{ padding: '4px 10px 10px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <div className="kb-grow" style={{ minWidth: 0 }}>
                    <div className="kb-title" style={{ fontSize: 15 }}>{course.title}</div>
                    <div className="kb-meta">{course.code} · v{course.major} · about {minutesText(course.est_minutes) || plural(course.est_minutes, 'minute')}{course.due_date ? ` · due ${fmtDate(course.due_date)}` : ''}</div>
                    <ProgressTrack size="sm" value={(course.my_pct || 0) / 100} state={courseTrackState(course)} label="Course progress" valueText={`${course.my_pct || 0}% done`} style={{ marginTop: 8 }} />
                  </div>
                </div>
                <div className="kb-lesson" onClick={() => setCur('home')} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setCur('home'); }}>
                  <span className="num"><Home size={12} /></span>
                  <span className="kb-grow"><span style={{ fontWeight: 600, fontSize: 13.5, display: 'block' }}>Course Home</span><span className="kb-meta">overview and outline</span></span>
                </div>
                {course.lessons.map((L, i) => (
                  <div key={L._id} className={`kb-lesson${cur === L._id ? ' on' : ''}`} onClick={() => setCur(L._id)} role="button" tabIndex={0} aria-current={cur === L._id ? 'step' : undefined} onKeyDown={(e) => { if (e.key === 'Enter') setCur(L._id); }}>
                    <span className={`num${L.done ? ' done' : ''}`}>{L.done ? <Check size={13} /> : i + 1}</span>
                    <span className="kb-grow"><span style={{ fontWeight: 600, fontSize: 13.5, display: 'block' }}>{L.title}</span><span className="kb-meta">{L.type === 'checkpoint' ? `Checkpoint · ${plural(L.question_count, 'question')}` : L.type === 'page' ? `Library page · ${plural(L.reading_minutes, 'minute')}` : `${plural(L.reading_minutes, 'minute')}`}</span></span>
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
              {course.overview?.length > 0 && <section className="kb-card"><h3 className="kb-h3" style={{ marginBottom: 6 }}>What You'll Learn</h3><ul className="kb-learn">{course.overview.map((o, i) => <li key={i}><Check size={14} />{o}</li>)}</ul></section>}
            </aside>

            <div className="kb-main">
              {course.lessons.map((L, idx) => L._id === cur && (
                <div key={L._id} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div className="kb-card kb-article" style={{ padding: '28px 36px' }}>
                    <div className="kb-meta" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span>{L.type === 'checkpoint' ? 'Checkpoint' : 'Lesson'} {idx + 1} of {course.lessons.length}</span>
                      {L.type !== 'checkpoint' && <Meta icon={Clock}>{plural(L.reading_minutes, 'minute')}</Meta>}
                      {L.type === 'page' && L.page?.code ? <span>from {L.page.code} v{L.page.version}</span> : null}
                      {L.done && <Chip color="#1e7b4e"><Check size={11} style={{ marginLeft: -2 }} />Done</Chip>}
                    </div>
                    <h1 className="kb-h1" style={{ fontSize: 26 }}>{L.title}</h1>
                    {L.summary && <p className="kb-sub" style={{ fontSize: 15, marginBottom: 12 }}>{L.summary}</p>}
                    {L.page?.newer && me?.can_author && <Banner kind="amber" icon={AlertTriangle}>This lesson is pinned to v{L.page.version}; the page is now v{L.page.current_version}. Update it in the course builder.</Banner>}
                    {L.page?.missing && <Banner kind="red" icon={AlertTriangle}>The page this lesson pointed at is no longer available.</Banner>}
                    {L.type === 'checkpoint' ? <Checkpoint course={course} lesson={L} onDone={load} /> : <Blocks doc={L.blocks} onVideoEnded={(u) => setWatched((w) => ({ ...w, [`${L._id}|${u}`]: true }))} />}
                    {L.type === 'page' && L.page?.doc_id && <div className="kb-meta" style={{ marginTop: 12 }}><a href="#p" onClick={(e) => { e.preventDefault(); goKb('page', L.page.doc_id); }}>Open this page in the Library</a></div>}
                  </div>
                  <div className="kb-lesson-nav">
                    <button type="button" className="kb-btn" onClick={() => setCur(idx > 0 ? course.lessons[idx - 1]._id : 'home')}><ChevronLeft />{idx > 0 ? 'Previous' : 'Course Home'}</button>
                    <span className="kb-grow" />
                    {L.type !== 'checkpoint' && !L.done && <button type="button" className="kb-btn pri lg" disabled={!videosWatched(L)} title={videosWatched(L) ? undefined : 'Watch the video to the end first'} onClick={() => markDone(L)}><Check />Mark Lesson Complete</button>}
                    {L.type !== 'checkpoint' && !L.done && !videosWatched(L) && <span className="kb-meta">Watch the video to the end to finish this lesson.</span>}
                    {(L.done || L.type === 'checkpoint') && <button type="button" className="kb-btn lg" onClick={() => { const nxt = course.lessons[idx + 1]; setCur(nxt ? nxt._id : course.my_status === 'Completed' ? 'done' : afterLessons(course)); }}>{course.lessons[idx + 1] ? 'Next' : course.delivery === 'in_person' ? 'Sign-Off' : course.quiz.question_count ? 'Final Quiz' : 'Finish'}<ChevronRight /></button>}
                  </div>
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
                <section className="kb-card kb-finish">
                  <Award size={30} style={{ color: 'var(--kb-green)' }} />
                  <div style={{ fontFamily: "'Figtree','Inter',sans-serif", fontSize: 24, fontWeight: 700 }}>Course completed</div>
                  <div className="kb-meta">{fmtDate(course.completed_at)}{course.quiz.score != null && course.quiz.question_count ? ` · ${course.quiz.score}%` : ''}{course.expires ? ` · valid through ${fmtDate(course.expires)}` : ''}</div>
                  {course.certificate && <><div className="kb-meta">Certificate {course.certificate.serial}</div><button type="button" className="kb-btn pri" onClick={download}><Download />Download Certificate</button></>}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                    <button type="button" className="kb-btn" onClick={() => goKb('training')}>Back to My Learning</button>
                    <button type="button" className="kb-btn" onClick={() => goKb('catalog')}><Compass />Find the Next Course</button>
                  </div>
                  <RateCourse course={course} onSaved={load} />
                </section>
              )}
            </div>
          </div>
          )}
        </div>
      )}
    </AsyncSection>
  );
}
