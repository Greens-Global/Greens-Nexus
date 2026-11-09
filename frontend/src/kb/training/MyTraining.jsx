// Training (Neil, 11/02/2026: "training is a mess"; redesigned 11/07/2026:
// "missing role based paths and departmental trainings"). Four screens under
// one segment control:
//   My Learning  - pick up where you left off, ONE to-do list (overdue, then
//                  due soonest, policies to sign in the same list), your
//                  paths with their stages, what you completed, certificates
//   Catalog      - every path and course, by role and department (Catalog.jsx)
//   Compliance   - your own requirements (MyCompliance.jsx)
//   Courses      - authors: the course list
// The module bar names the module; this page never repeats "Training" as a
// title of its own (Neil, 11/06/2026).
import { useEffect, useState } from 'react';
import { Award, Download, Search, Plus, GraduationCap, PenLine, Compass, ChevronRight, CheckCircle2 } from 'lucide-react';
import { api, saveBlob } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { ModuleActions } from '../../components/ModuleTabs';
import { Chip, SectionHead } from '../components/Chips';
import { useToast, errText } from '../components/Toast';
import { goKb, fmtDate, plural, minutesText } from '../lib';
import MyCompliance from './MyCompliance';
import Catalog from './Catalog';
import ProgressTrack from '../../ui/ProgressTrack';
import { PathRow, LevelChip } from './cards';
import { shelfOf, courseAction, isStarted, itemFraction, pathOrder, blurb } from './catalogModel';
import Refresher from './Refresher';

// The track's state for one course card: red while it is overdue (or an
// expired completion), green once completed, else the live accent.
export function courseTrackState(c) {
  if (c?.days_overdue) return 'overdue';
  return c?.my_status === 'Completed' ? 'done' : 'live';
}

// One thing to do: a course row. Quiet - the kind and state are words, the
// progress a thin line; the whole row opens the course.
export function CourseRow({ c, onOpen }) {
  const open = () => (onOpen ? onOpen(c) : goKb('course', c.id));
  return (
    <div className="kb-todo" onClick={open} role="link" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}>
      <span className="kb-todo-kind">Course</span>
      <div className="kb-todo-text">
        <div className="kb-prow-title">{c.title}</div>
        <div className="kb-meta kb-crow-facts">
          {isStarted(c) ? <ProgressTrack size="sm" value={(c.my_pct || 0) / 100} state={courseTrackState(c)} label={`${c.title} progress`} valueText={`${c.my_pct || 0}% done`} style={{ width: 96 }} /> : null}
          {isStarted(c) ? <span>{c.my_pct}% done</span> : null}
          <span>about {minutesText(c.est_minutes) || plural(c.est_minutes, 'minute')}</span>
          {c.source === 'plan' && <span>part of a path</span>}
        </div>
      </div>
      <span className="kb-todo-due">{c.days_overdue ? <b style={{ color: '#dc2626' }}>{plural(c.days_overdue, 'day')} overdue</b> : c.due_date ? `Due ${fmtDate(c.due_date)}` : <span className="kb-meta">No due date</span>}</span>
      <button type="button" className={`kb-btn sm${c.days_overdue ? ' pri' : ''}`} onClick={(e) => { e.stopPropagation(); open(); }}>{courseAction(c)}</button>
    </div>
  );
}

function PolicyRow({ t }) {
  const open = () => goKb('page', t.id);
  return (
    <div className="kb-todo" onClick={open} role="link" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}>
      <span className="kb-todo-kind policy">Policy</span>
      <div className="kb-todo-text">
        <div className="kb-prow-title">{t.title}<span className="kb-item-kind">v{t.item.version}</span></div>
        <div className="kb-meta">Read it and sign your name{t.item.version_signed ? ` · you signed v${t.item.version_signed}` : ''}</div>
      </div>
      <span className="kb-todo-due">{t.overdue ? <b style={{ color: '#dc2626' }}>{plural(t.overdue, 'day')} overdue</b> : t.due ? `Sign by ${fmtDate(t.due)}` : <span className="kb-meta">No due date</span>}</span>
      <button type="button" className={`kb-btn sm${t.overdue ? ' pri' : ''}`} onClick={(e) => { e.stopPropagation(); open(); }}><PenLine />Read and Sign</button>
    </div>
  );
}

// Everything a person still owes, as one list: courses assigned to them
// (plan courses included), and policies to sign. Overdue first (most overdue
// on top), then the soonest due date, then the order your paths take them
// (catalogModel.pathOrder), then a course already started above one not
// started, then anything with no date.
export function todoList(data) {
  const rows = [];
  const order = pathOrder(data.plans);
  for (const c of data.due || []) {
    if (c.my_status === 'Completed') continue;
    rows.push({ kind: 'course', id: c.id, title: c.title, item: c, overdue: c.days_overdue || 0, due: c.due_date || '', started: isStarted(c), at: order.get(c.id) ?? 1e9 });
  }
  for (const p of data.policies || []) {
    if (p.signed) continue;
    rows.push({ kind: 'policy', id: p.id, title: p.title, item: p, overdue: p.overdue_days || 0, due: p.due || '', started: false, at: 1e9 });
  }
  return rows.sort((a, b) => (b.overdue - a.overdue) || ((a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0) || (a.at - b.at) || (b.started - a.started) || a.title.localeCompare(b.title));
}

// How much of everything owed is done, 0..100, from the same numbers as each
// row: a started course counts by its own percent (so it never reads 0%
// while the course above it reads 13%).
export function todoPct(data, todo) {
  const doneCount = (data.stats?.completed || 0) + (data.policies || []).filter((p) => p.signed).length;
  const total = todo.length + doneCount;
  if (!total) return 100;
  const open = todo.reduce((n, t) => n + (t.kind === 'course' ? itemFraction(t.item) : 0), 0);
  return Math.round((100 * (doneCount + open)) / total);
}

// What the "continue" block shows: the course furthest along that is not
// done, else the first course on the to-do list.
export function continueCourse(data) {
  const open = (data?.due || []).filter((c) => c.my_status !== 'Completed');
  const started = open.filter(isStarted).sort((a, b) => (b.days_overdue - a.days_overdue) || (b.my_pct - a.my_pct));
  if (started.length) return started[0];
  const todo = todoList(data).find((t) => t.kind === 'course');
  return todo ? todo.item : null;
}

// One sentence on where the person stands: "1 course and 7 policies to go · nothing overdue".
export function standingLine(data, todo) {
  const courses = todo.filter((t) => t.kind === 'course').length;
  const policies = todo.filter((t) => t.kind === 'policy').length;
  const parts = [];
  if (courses) parts.push(plural(courses, 'course'));
  if (policies) parts.push(`${policies} ${policies === 1 ? 'policy' : 'policies'}`);
  const togo = parts.length ? `${parts.join(' and ')} to go` : 'Nothing to do';
  const overdue = data.stats?.overdue || 0;
  return `${togo} · ${overdue ? `${overdue} overdue` : 'nothing overdue'}`;
}

function Continue({ c }) {
  const started = isStarted(c);
  const left = Math.max(0, Math.round((c.est_minutes || 0) * (1 - (c.my_pct || 0) / 100)));
  const shelf = shelfOf(c);
  return (
    <section className="kb-continue">
      <div className="kb-continue-text">
        <div className="kb-kicker">{started ? 'Continue Where You Left Off' : 'Up Next'}</div>
        <h2 className="kb-continue-title">{c.title}</h2>
        {c.description && <div className="kb-prow-desc" style={{ maxWidth: 640 }}>{blurb(c.description)}</div>}
        <div className="kb-meta kb-crow-facts" style={{ marginTop: 8 }}>
          <LevelChip level={c.level} />
          {shelf !== 'General' && <span>{shelf}</span>}
          <span>{plural(c.lesson_count || 0, 'lesson')}</span>
          <span>{started && left ? `about ${minutesText(left)} left` : `about ${minutesText(c.est_minutes)}`}</span>
          {c.due_date && <span>{c.days_overdue ? <b style={{ color: '#dc2626' }}>{plural(c.days_overdue, 'day')} overdue</b> : `due ${fmtDate(c.due_date)}`}</span>}
        </div>
        <ProgressTrack value={(c.my_pct || 0) / 100} state={courseTrackState(c)} label="Course progress" valueText={`${c.my_pct || 0}% done`} style={{ marginTop: 12, maxWidth: 480 }} note={<><b>{c.my_pct || 0}%</b> done</>} />
      </div>
      <div className="kb-continue-side">
        <button type="button" className="kb-btn pri lg" onClick={() => goKb('course', c.id)}>{courseAction(c)} Course<ChevronRight /></button>
      </div>
    </section>
  );
}

function CaughtUp({ hasPaths }) {
  return (
    <section className="kb-continue">
      <div className="kb-continue-text">
        <div className="kb-kicker" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><CheckCircle2 size={15} style={{ color: 'var(--kb-green)' }} />Nothing Due</div>
        <h2 className="kb-continue-title">You are all caught up</h2>
        <div className="kb-prow-desc">{hasPaths ? 'Keep going on a path below, or pick something new from the catalog.' : 'Pick a path for your role, or a course from the catalog.'}</div>
      </div>
      <div className="kb-continue-side">
        <button type="button" className="kb-btn pri lg" onClick={() => goKb('catalog')}><Compass />Browse the Catalog</button>
      </div>
    </section>
  );
}

export default function MyTraining({ me, seg: initialSeg = 'me' }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [seg, setSeg] = useState(initialSeg);
  const [courses, setCourses] = useState(null);
  const [serial, setSerial] = useState('');
  const [lookup, setLookup] = useState(null);
  const load = () => { setErr(''); api.kbTrainingMe().then(setData).catch((e) => setErr(errText(e))); };
  useEffect(() => { load(); }, []);
  useEffect(() => { setSeg(initialSeg); }, [initialSeg]);
  useEffect(() => { if (seg === 'courses' && !courses) api.kbCourses(true).then(setCourses).catch((e) => toast(errText(e), 'err')); }, [seg, courses, toast]);
  const download = async (cert) => {
    try { saveBlob(await api.kbCertificatePdf(cert.id), `${cert.serial}.pdf`); } catch (e) { toast(errText(e, 'Could not download'), 'err'); }
  };
  const check = async () => {
    if (!serial.trim()) return;
    try { setLookup(await api.kbCertificateLookup(serial.trim())); } catch (e) { toast(errText(e), 'err'); }
  };
  const go = (k) => { setSeg(k); goKb(k === 'me' ? 'training' : k === 'catalog' ? 'catalog' : k === 'compliance' ? 'training-compliance' : 'courses'); };

  return (
    <div className="kb-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {/* Everyone has their own compliance (Oct 30 2026); Courses is for authors. */}
        <div className="kb-seg" role="tablist" aria-label="Training screens">
          <button type="button" role="tab" aria-selected={seg === 'me'} className={seg === 'me' ? 'on' : ''} onClick={() => go('me')}>My Learning</button>
          <button type="button" role="tab" aria-selected={seg === 'catalog'} className={seg === 'catalog' ? 'on' : ''} onClick={() => go('catalog')}>Catalog</button>
          <button type="button" role="tab" aria-selected={seg === 'compliance'} className={seg === 'compliance' ? 'on' : ''} onClick={() => go('compliance')}>Compliance</button>
          {me?.can_author && <button type="button" role="tab" aria-selected={seg === 'courses'} className={seg === 'courses' ? 'on' : ''} onClick={() => go('courses')}>Courses</button>}
        </div>
        {seg === 'courses' && me?.can_author && (
          <ModuleActions>
            <button type="button" className="kb-btn" onClick={() => goKb('plans')}>Learning Paths</button>
            <button type="button" className="kb-btn pri" onClick={() => goKb('builder', 'new')}><Plus />New Course</button>
          </ModuleActions>
        )}
      </div>

      {seg === 'compliance' && <MyCompliance me={me} />}
      {seg === 'catalog' && <Catalog me={me} />}
      {seg === 'me' && (
        <AsyncSection loading={!data && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
          {data && (() => {
            const todo = todoList(data);
            const pct = todoPct(data, todo);
            const next = continueCourse(data);
            const plans = data.plans || [];
            return (
            <>
              {next ? <Continue c={next} /> : <CaughtUp hasPaths={plans.length > 0} />}
              <Refresher />
              <div className="kb-cols">
                <div className="kb-main">
                  <section className="kb-shelf">
                    <div className="kb-shelf-head">
                      <h3 className="kb-shelf-title">To Do</h3>
                      <span className="kb-meta">{standingLine(data, todo)}</span>
                      <span className="kb-meta kb-shelf-count">{pct}% done</span>
                    </div>
                    <ProgressTrack size="sm" value={pct / 100} state={todo.some((t) => t.overdue) ? 'overdue' : pct >= 100 ? 'done' : 'live'} label="Training to do" valueText={`${pct}% done`} style={{ marginBottom: 4 }} />
                    <div className="kb-shelf-body">
                      {todo.length === 0 && <div className="kb-empty-state"><div className="kb-empty-title">All Caught Up</div><div className="kb-meta">Courses, paths and policies you are given show up here, overdue first.</div></div>}
                      {todo.map((t) => (t.kind === 'course' ? <CourseRow key={`c:${t.id}`} c={t.item} /> : <PolicyRow key={`p:${t.id}`} t={t} />))}
                    </div>
                  </section>
                  <section className="kb-shelf">
                    <div className="kb-shelf-head">
                      <h3 className="kb-shelf-title">My Paths</h3>
                      {plans.length > 0 && <span className="kb-meta">onboarding, role and department training, stage by stage</span>}
                      <button type="button" className="kb-btn sm ghost kb-shelf-count" onClick={() => goKb('catalog')}>All Paths<ChevronRight size={14} /></button>
                    </div>
                    <div className="kb-shelf-body">
                      {plans.length === 0 && <div className="kb-empty-state"><GraduationCap size={22} /><div className="kb-empty-title">No Path Yet</div><div className="kb-meta">The catalog has paths for roles and departments. One for yours shows up here when you start it or it is assigned to you.</div></div>}
                      {plans.map((p) => <PathRow key={p.id} p={{ ...p, enrolled: true }} />)}
                    </div>
                  </section>
                  <section className="kb-shelf">
                    <div className="kb-shelf-head">
                      <h3 className="kb-shelf-title">Completed</h3>
                      <span className="kb-meta">{data.completed.length ? `${plural(data.completed.length, 'course')} · ${plural(data.stats?.certificates || 0, 'certificate')}` : ''}</span>
                    </div>
                    <div className="kb-shelf-body">
                      {data.completed.length === 0 && <div className="kb-empty-state"><div className="kb-empty-title">Nothing Completed Yet</div><div className="kb-meta">Completed courses and their certificates live here.</div></div>}
                      {data.completed.length > 0 && (
                        <table className="kb-table"><thead><tr><th>Course</th><th>Completed</th><th>Valid Through</th><th>Certificate</th></tr></thead><tbody>
                          {data.completed.map((c) => (
                            <tr key={c.id}>
                              <td><a href="#c" onClick={(e) => { e.preventDefault(); goKb('course', c.id); }}>{c.title}</a></td>
                              <td>{fmtDate(c.completed_at)}</td>
                              <td>{c.expires ? fmtDate(c.expires) : 'No expiry'}</td>
                              <td>{c.certificate ? <button type="button" className="kb-btn sm" onClick={() => download(c.certificate)}><Download />{c.certificate.serial}</button> : <span className="kb-meta">None</span>}</td>
                            </tr>
                          ))}
                        </tbody></table>
                      )}
                    </div>
                  </section>
                </div>
                <aside className="kb-rail">
                  {data.policies.filter((p) => p.signed).length > 0 && (
                    <section className="kb-card">
                      <SectionHead title="Policies You Signed" />
                      {data.policies.filter((p) => p.signed).map((p) => <div key={p.id} className="kb-row link" onClick={() => goKb('page', p.id)}><div className="kb-grow"><div className="kb-title">{p.title}</div><div className="kb-meta">v{p.version} · {fmtDate(p.signed_at)}</div></div></div>)}
                    </section>
                  )}
                  <section className="kb-card">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}><Award size={16} style={{ color: 'var(--kb-green)' }} /><h3 className="kb-h3">Certificate Check</h3></div>
                    <div className="kb-meta" style={{ marginBottom: 8 }}>Paste a serial number to confirm a certificate is real and current.</div>
                    <div style={{ display: 'flex', gap: 6 }}><input className="kb-input" value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="CERT-2026-00417" onKeyDown={(e) => { if (e.key === 'Enter') check(); }} /><button type="button" className="kb-ibtn" aria-label="Check" onClick={check}><Search /></button></div>
                    {lookup && (
                      <div className="kb-meta" style={{ marginTop: 8 }}>
                        {!lookup.found ? <Chip color="#dc2626">Not found</Chip> : lookup.revoked ? <Chip color="#dc2626">Revoked</Chip> : lookup.expired ? <Chip color="#b45309">Expired {fmtDate(lookup.expires_at)}</Chip> : <Chip color="#1e7b4e">Valid</Chip>}
                        {lookup.found && <div style={{ marginTop: 6 }}><b>{lookup.user_name}</b> · {lookup.course_title} v{lookup.course_major} · issued {fmtDate(lookup.issued_at)}{lookup.score ? ` · ${lookup.score}%` : ''}</div>}
                      </div>
                    )}
                  </section>
                  <div className="kb-meta" style={{ padding: '0 4px' }}>Reminders: 7 days before a due date, on the day, then weekly. Your manager hears on Mondays about anything overdue.</div>
                </aside>
              </div>
            </>
            );
          })()}
        </AsyncSection>
      )}

      {seg === 'courses' && (
        <AsyncSection loading={!courses} isEmpty={courses && courses.length === 0} emptyContent={<div className="kb-card soft kb-empty"><GraduationCap size={24} /><div style={{ marginTop: 6 }}>No courses yet. Build one from Library pages, or let Nexus draft it.</div></div>}>
          <section className="kb-card">
            <table className="kb-table"><thead><tr><th>Course</th><th>Status</th><th>Department</th><th>Level</th><th>Lessons</th><th>Questions</th><th>Learners</th><th>Done</th><th /></tr></thead><tbody>
              {(courses || []).map((c) => (
                <tr key={c.id}>
                  <td><a href="#b" onClick={(e) => { e.preventDefault(); goKb('builder', c.id); }}><b>{c.title}</b></a><div className="kb-meta">{c.code}{c.recert_months ? ` · renews every ${c.recert_months} months` : ''}{c.has_draft && c.status === 'published' ? ' · unpublished edits' : ''}{c.delivery === 'in_person' ? ' · in person' : ''}{c.review_flag?.changes?.length ? <> · <b style={{ color: '#b45309' }}>Nexus changed, review</b></> : ''}</div></td>
                  <td><Chip color={c.status === 'published' ? '#1e7b4e' : '#64748b'}>{c.status === 'published' ? `Published v${c.major}` : 'Draft'}</Chip></td>
                  <td>{(c.department_list || []).join(', ') || <span className="kb-meta">None</span>}</td>
                  <td><LevelChip level={c.level} /></td>
                  <td>{c.lesson_count}</td><td>{c.question_count}</td><td>{c.learners}</td><td>{c.completions}</td>
                  <td style={{ whiteSpace: 'nowrap' }}><button type="button" className="kb-btn sm" onClick={() => goKb('builder', c.id)}>Edit</button> <button type="button" className="kb-btn sm ghost" onClick={() => goKb('course', c.id)}>Preview</button></td>
                </tr>
              ))}
            </tbody></table>
          </section>
        </AsyncSection>
      )}
    </div>
  );
}
