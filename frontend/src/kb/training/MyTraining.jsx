// My Training: assigned, plans, policies to sign, completed with
// certificates, a certificate check. Editors also see the course list.
import { useEffect, useState } from 'react';
import { Award, Download, Search, Plus, GraduationCap, PenLine } from 'lucide-react';
import { api, saveBlob } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { Chip, SectionHead, Stat, TrainingChip } from '../components/Chips';
import { useToast, errText } from '../components/Toast';
import { goKb, fmtDate, trainingColor, plural } from '../lib';

export function CourseRow({ c, onOpen }) {
  const open = () => (onOpen ? onOpen(c) : goKb('course', c.id));
  return (
    <div className="kb-row link" onClick={open} role="link" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}>
      <Chip color="#1e7b4e">Course</Chip>
      <div className="kb-grow">
        <div className="kb-title">{c.title} <span className="kb-meta" style={{ fontWeight: 400 }}>{c.code ? `· ${c.code}` : ''}</span></div>
        <div className="kb-meta" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="kb-progress" style={{ width: 120 }}><i style={{ width: `${c.my_pct}%` }} /></span>
          <span>{c.my_pct}%</span>
          {c.due_date && <span>· {c.days_overdue ? `${c.days_overdue} days overdue` : `due ${fmtDate(c.due_date)}`}</span>}
          <span>· about {plural(c.est_minutes, 'minute')}</span>
          {c.source === 'plan' && <span>· part of a plan</span>}
        </div>
      </div>
      <TrainingChip status={c.my_status} />
      <button type="button" className={`kb-btn sm${c.days_overdue ? ' pri' : ''}`} onClick={(e) => { e.stopPropagation(); open(); }}>{c.my_status === 'Not Started' ? 'Start' : c.my_status === 'Completed' ? 'Open' : 'Continue'}</button>
    </div>
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
  useEffect(() => { if (seg === 'courses' && !courses) api.kbCourses(true).then(setCourses).catch((e) => toast(errText(e), 'err')); }, [seg, courses, toast]);
  const download = async (cert) => {
    try { saveBlob(await api.kbCertificatePdf(cert.id), `${cert.serial}.pdf`); } catch (e) { toast(errText(e, 'Could not download'), 'err'); }
  };
  const check = async () => {
    if (!serial.trim()) return;
    try { setLookup(await api.kbCertificateLookup(serial.trim())); } catch (e) { toast(errText(e), 'err'); }
  };

  return (
    <div className="kb-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="kb-h1" style={{ margin: 0, fontSize: 24 }}>Training</h1>
        {me?.can_author && (
          <div className="kb-seg">
            <button type="button" className={seg === 'me' ? 'on' : ''} onClick={() => setSeg('me')}>My Training</button>
            <button type="button" className={seg === 'courses' ? 'on' : ''} onClick={() => setSeg('courses')}>Courses</button>
            <button type="button" onClick={() => goKb('compliance')}>Compliance</button>
          </div>
        )}
        {seg === 'courses' && me?.can_author && <button type="button" className="kb-btn pri" style={{ marginLeft: 'auto' }} onClick={() => goKb('builder', 'new')}><Plus />New Course</button>}
      </div>

      {seg === 'me' && (
        <AsyncSection loading={!data && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
          {data && (
            <>
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
                    <SectionHead title="Assigned to You" />
                    {data.due.length === 0 && <div className="kb-empty">Nothing assigned right now. Courses you are given show up here with their due dates.</div>}
                    {data.due.map((c) => <CourseRow key={c.id} c={c} />)}
                  </section>
                  {data.plans.map((p) => (
                    <section key={p.id} className="kb-card">
                      <SectionHead title={p.name} sub={`${p.done} of ${p.total} done${p.due_date ? ` · due ${fmtDate(p.due_date)}` : ''}`} right={p.completed_at ? <Chip color="#1e7b4e">Completed</Chip> : p.days_overdue ? <Chip color="#dc2626">{p.days_overdue} days overdue</Chip> : null} />
                      <div className="kb-progress" style={{ marginBottom: 10 }}><i style={{ width: `${p.total ? Math.round(100 * p.done / p.total) : 0}%` }} /></div>
                      {p.items.map((it) => (
                        <div key={`${it.kind}:${it.id}`} className="kb-row link" onClick={() => goKb(it.kind === 'course' ? 'course' : 'page', it.id)}>
                          <Chip color={it.kind === 'course' ? '#1e7b4e' : '#7c3aed'}>{it.kind === 'course' ? 'Course' : 'Policy'}</Chip>
                          <div className="kb-grow"><div className="kb-title">{it.title}</div>{it.est_minutes && <div className="kb-meta">about {plural(it.est_minutes, 'minute')}</div>}</div>
                          <Chip color={trainingColor(it.status)}>{it.status}</Chip>
                        </div>
                      ))}
                    </section>
                  ))}
                  {data.policies.filter((p) => !p.signed).length > 0 && (
                    <section className="kb-card">
                      <SectionHead title="Policies to Sign" count={data.policies.filter((p) => !p.signed).length} />
                      {data.policies.filter((p) => !p.signed).map((p) => (
                        <div key={p.id} className="kb-row link" onClick={() => goKb('page', p.id)}>
                          <Chip color="#7c3aed">Policy</Chip>
                          <div className="kb-grow"><div className="kb-title">{p.title} <span className="kb-meta" style={{ fontWeight: 400 }}>v{p.version}</span></div><div className="kb-meta">{p.overdue_days ? `${p.overdue_days} days overdue` : p.due ? `Sign by ${fmtDate(p.due)}` : ''}{p.version_signed ? ` · you signed v${p.version_signed}` : ''}</div></div>
                          <button type="button" className={`kb-btn sm${p.overdue_days ? ' pri' : ''}`}><PenLine />Read and Sign</button>
                        </div>
                      ))}
                    </section>
                  )}
                  <section className="kb-card">
                    <SectionHead title="Completed" />
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
          )}
        </AsyncSection>
      )}

      {seg === 'courses' && (
        <AsyncSection loading={!courses} isEmpty={courses && courses.length === 0} emptyContent={<div className="kb-card soft kb-empty"><GraduationCap size={24} /><div style={{ marginTop: 6 }}>No courses yet. Build one from Library pages, or let Nexus draft it.</div></div>}>
          <section className="kb-card">
            <table className="kb-table"><thead><tr><th>Course</th><th>Status</th><th>Lessons</th><th>Questions</th><th>Learners</th><th>Done</th><th /></tr></thead><tbody>
              {(courses || []).map((c) => (
                <tr key={c.id}>
                  <td><a href="#b" onClick={(e) => { e.preventDefault(); goKb('builder', c.id); }}><b>{c.title}</b></a><div className="kb-meta">{c.code}{c.recert_months ? ` · renews every ${c.recert_months} months` : ''}{c.has_draft && c.status === 'published' ? ' · unpublished edits' : ''}</div></td>
                  <td><Chip color={c.status === 'published' ? '#1e7b4e' : '#64748b'}>{c.status === 'published' ? `Published v${c.major}` : 'Draft'}</Chip></td>
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
