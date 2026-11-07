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
import { Award, Download, Search, Plus, GraduationCap, PenLine, Compass, ChevronRight, Clock, BookOpen, CheckCircle2 } from 'lucide-react';
import { api, saveBlob } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { ModuleActions } from '../../components/ModuleTabs';
import { Chip, SectionHead, Stat, TrainingChip } from '../components/Chips';
import { useToast, errText } from '../components/Toast';
import { goKb, fmtDate, plural, minutesText, colorFor, initials } from '../lib';
import MyCompliance from './MyCompliance';
import Catalog from './Catalog';
import ProgressTrack from '../../ui/ProgressTrack';
import { PathTile, LevelChip } from './cards';
import { shelfOf, courseAction } from './catalogModel';

// The track's state for one course card: red while it is overdue (or an
// expired completion), green once completed, else the live accent.
export function courseTrackState(c) {
  if (c?.days_overdue) return 'overdue';
  return c?.my_status === 'Completed' ? 'done' : 'live';
}

export function CourseRow({ c, onOpen }) {
  const open = () => (onOpen ? onOpen(c) : goKb('course', c.id));
  return (
    <div className="kb-row link kb-wrap" onClick={open} role="link" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}>
      <Chip color="#1e7b4e">Course</Chip>
      <div className="kb-grow">
        <div className="kb-title">{c.title} <span className="kb-meta" style={{ fontWeight: 400 }}>{c.code ? `· ${c.code}` : ''}</span></div>
        <div className="kb-meta" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <ProgressTrack size="sm" value={(c.my_pct || 0) / 100} state={courseTrackState(c)} label={`${c.title} progress`} style={{ width: 120 }} />
          <span>{c.my_pct}%</span>
          {c.due_date && <span>· {c.days_overdue ? `${c.days_overdue} days overdue` : `due ${fmtDate(c.due_date)}`}</span>}
          <span>· about {minutesText(c.est_minutes) || plural(c.est_minutes, 'minute')}</span>
          {c.source === 'plan' && <span>· part of a path</span>}
        </div>
      </div>
      <TrainingChip status={c.my_status} />
      <button type="button" className={`kb-btn sm${c.days_overdue ? ' pri' : ''}`} onClick={(e) => { e.stopPropagation(); open(); }}>{c.my_status === 'Not Started' ? 'Start' : c.my_status === 'Completed' ? 'Open' : 'Continue'}</button>
    </div>
  );
}

// Everything a person still owes, as one list: courses assigned to them
// (plan courses included), and policies to sign. Overdue first (most overdue
// on top), then the soonest due date, then anything with no date; a course
// already started sits above one not started at the same due date.
export function todoList(data) {
  const rows = [];
  for (const c of data.due || []) {
    if (c.my_status === 'Completed') continue;
    rows.push({ kind: 'course', id: c.id, title: c.title, item: c, overdue: c.days_overdue || 0, due: c.due_date || '', started: c.my_status === 'In Progress' });
  }
  for (const p of data.policies || []) {
    if (p.signed) continue;
    rows.push({ kind: 'policy', id: p.id, title: p.title, item: p, overdue: p.overdue_days || 0, due: p.due || '', started: false });
  }
  return rows.sort((a, b) => (b.overdue - a.overdue) || ((a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0) || (b.started - a.started) || a.title.localeCompare(b.title));
}

// What the "pick up where you left off" card shows: the course furthest
// along that is not done, else the first thing on the to-do list.
export function continueCourse(data) {
  const open = (data?.due || []).filter((c) => c.my_status !== 'Completed');
  const started = open.filter((c) => c.my_status === 'In Progress' || c.my_pct > 0).sort((a, b) => (b.days_overdue - a.days_overdue) || (b.my_pct - a.my_pct));
  if (started.length) return started[0];
  const todo = todoList(data).find((t) => t.kind === 'course');
  return todo ? todo.item : null;
}

function ContinueCard({ c }) {
  const shelf = shelfOf(c);
  const color = colorFor(shelf);
  const started = c.my_status === 'In Progress' || c.my_pct > 0;
  return (
    <section className="kb-hero kb-continue" style={{ '--tile': color }}>
      <div className="kb-hero-body">
        <div className="kb-label" style={{ marginBottom: 8 }}>{started ? 'Pick Up Where You Left Off' : 'Up Next'}</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span className="kb-ico" style={{ background: color, width: 44, height: 44, fontSize: 18, borderRadius: 12 }} aria-hidden="true">{initials(shelf).slice(0, 1)}</span>
          <div className="kb-grow" style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <h2 className="kb-h2" style={{ fontSize: 22 }}>{c.title}</h2>
              <LevelChip level={c.level} />
              {c.days_overdue > 0 && <Chip color="#dc2626">{plural(c.days_overdue, 'day')} overdue</Chip>}
            </div>
            {c.description && <div className="kb-sub kb-clamp2" style={{ fontSize: 14, marginTop: 4, maxWidth: 640 }}>{c.description}</div>}
            <div className="kb-meta kb-tile-meta" style={{ marginTop: 10 }}>
              <span><BookOpen size={13} />{plural(c.lesson_count || 0, 'lesson')}</span>
              <span><Clock size={13} />{minutesText(c.est_minutes)}</span>
              {c.due_date && <span>Due {fmtDate(c.due_date)}</span>}
              {shelf !== 'General' && <span>{shelf}</span>}
            </div>
            <ProgressTrack value={(c.my_pct || 0) / 100} state={courseTrackState(c)} label="Course progress" valueText={`${c.my_pct || 0}% done`} style={{ marginTop: 12, maxWidth: 420 }} note={<><b>{c.my_pct || 0}%</b> done</>} />
          </div>
        </div>
      </div>
      <div className="kb-hero-side">
        <button type="button" className="kb-btn pri lg" onClick={() => goKb('course', c.id)}>{courseAction(c)} Course<ChevronRight /></button>
        <button type="button" className="kb-btn" onClick={() => goKb('catalog')}><Compass />Browse the Catalog</button>
      </div>
    </section>
  );
}

function CaughtUp({ hasPaths }) {
  return (
    <section className="kb-hero kb-continue" style={{ '--tile': '#1e7b4e' }}>
      <div className="kb-hero-body">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="kb-ico" style={{ background: '#1e7b4e', width: 44, height: 44, borderRadius: 12 }} aria-hidden="true"><CheckCircle2 size={22} /></span>
          <div>
            <h2 className="kb-h2" style={{ fontSize: 22 }}>You are all caught up</h2>
            <div className="kb-sub" style={{ fontSize: 14 }}>{hasPaths ? 'Nothing is due. Keep going on a path below, or pick something new from the catalog.' : 'Nothing is due. Pick a path for your role or a course from the catalog.'}</div>
          </div>
        </div>
      </div>
      <div className="kb-hero-side">
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
            const total = todo.length + (data.stats?.completed || 0) + (data.policies || []).filter((p) => p.signed).length;
            const pct = total ? Math.round(100 * (total - todo.length) / total) : 100;
            const next = continueCourse(data);
            const plans = data.plans || [];
            return (
            <>
              {next ? <ContinueCard c={next} /> : <CaughtUp hasPaths={plans.length > 0} />}
              <div className="kb-stats">
                <Stat value={data.stats.due} label="assigned, not done" />
                <Stat value={data.stats.overdue} label="overdue" color={data.stats.overdue ? '#dc2626' : undefined} />
                <Stat value={data.stats.to_sign} label="policies to sign" color={data.stats.to_sign ? '#b45309' : undefined} />
                <Stat value={data.stats.completed} label="completed" color="#1e7b4e" />
                <Stat value={data.stats.certificates} label="certificates" />
              </div>
              <div className="kb-cols">
                <div className="kb-main">
                  <section className="kb-card">
                    <SectionHead title="To Do" count={todo.filter((t) => t.overdue).length} sub={todo.length ? `${todo.length} to go` : ''} right={<span className="kb-meta">{pct}% done</span>} />
                    <ProgressTrack value={pct / 100} state={todo.some((t) => t.overdue) ? 'overdue' : undefined} label="Training to do" valueText={`${pct}% done`} style={{ marginBottom: 10 }} />
                    {todo.length === 0 && <div className="kb-empty">You are all caught up. Courses, paths and policies you are given show up here, overdue first.</div>}
                    {todo.map((t) => (t.kind === 'course'
                      ? <CourseRow key={`c:${t.id}`} c={t.item} />
                      : (
                        <div key={`p:${t.id}`} className="kb-row link kb-wrap" onClick={() => goKb('page', t.id)} role="link" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') goKb('page', t.id); }}>
                          <Chip color="#7c3aed">Policy</Chip>
                          <div className="kb-grow"><div className="kb-title">{t.title} <span className="kb-meta" style={{ fontWeight: 400 }}>v{t.item.version}</span></div><div className="kb-meta">{t.overdue ? `${t.overdue} days overdue` : t.due ? `Sign by ${fmtDate(t.due)}` : 'Read and sign'}{t.item.version_signed ? ` · you signed v${t.item.version_signed}` : ''}</div></div>
                          <TrainingChip status={t.overdue ? 'Overdue' : 'Not Started'} />
                          <button type="button" className={`kb-btn sm${t.overdue ? ' pri' : ''}`}><PenLine />Read and Sign</button>
                        </div>
                      )))}
                  </section>
                  <section>
                    <SectionHead title="My Paths" sub={plans.length ? 'your onboarding, role and department training, stage by stage' : ''} right={<button type="button" className="kb-btn sm ghost" onClick={() => goKb('catalog')}><Compass />All Paths</button>} />
                    {plans.length === 0 && <div className="kb-card soft kb-empty"><GraduationCap size={22} /><div style={{ marginTop: 6 }}>No path yet. The catalog has paths for roles and departments; one for yours shows up here when you start it or it is assigned to you.</div></div>}
                    {plans.length > 0 && <div className="kb-tiles">{plans.map((p) => <PathTile key={p.id} p={{ ...p, enrolled: true }} />)}</div>}
                  </section>
                  <section className="kb-card">
                    <SectionHead title="Completed" sub={data.completed.length ? plural(data.completed.length, 'course') : ''} />
                    {data.completed.length === 0 && <div className="kb-empty">Completed courses and their certificates live here.</div>}
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
                  <section className="kb-card soft" style={{ background: '#eef7f1', borderColor: '#cfe6d8' }}>
                    <div className="kb-meta">Reminders: 7 days before a due date, on the day, then weekly. Your manager hears on Mondays about anything overdue.</div>
                  </section>
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
                  <td><a href="#b" onClick={(e) => { e.preventDefault(); goKb('builder', c.id); }}><b>{c.title}</b></a><div className="kb-meta">{c.code}{c.recert_months ? ` · renews every ${c.recert_months} months` : ''}{c.has_draft && c.status === 'published' ? ' · unpublished edits' : ''}{c.delivery === 'in_person' ? ' · in person' : ''}</div></td>
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
