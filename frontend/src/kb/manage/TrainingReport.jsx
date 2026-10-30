// Training reports (WP 5.6, Oct 29 2026): Manage > Compliance's Training
// Trends card. Completions by month, each course's completion rate, average
// score and rating, and each team's assigned vs completed - within the
// caller's company. Backend: GET /kb/reports/training (Manage only).
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { SectionHead } from '../components/Chips';
import { goKb } from '../lib';

const pct = (v) => (v == null ? '-' : `${v}%`);

export default function TrainingReport() {
  const [rep, setRep] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.kbTrainingReport(6)).then((r) => { if (live && r && r.courses) setRep(r); }).catch(() => {});
    return () => { live = false; };
  }, []);
  if (!rep || !rep.courses.length) return null;
  return (
    <section className="kb-card">
      <SectionHead title="Training Trends" sub="last 6 months, your company" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 18 }}>
        <div>
          <div className="kb-label">Completions by Month</div>
          <table className="kb-table"><thead><tr><th>Month</th><th>Completed</th></tr></thead><tbody>
            {rep.months.map((m) => <tr key={m.month}><td>{m.month}</td><td>{m.completed}</td></tr>)}
          </tbody></table>
        </div>
        <div>
          <div className="kb-label">By Team</div>
          <table className="kb-table"><thead><tr><th>Team</th><th>Done</th><th>Rate</th></tr></thead><tbody>
            {rep.teams.map((t) => <tr key={t.department}><td>{t.department}</td><td>{t.completed} of {t.assigned}</td><td>{pct(t.rate)}</td></tr>)}
          </tbody></table>
        </div>
      </div>
      <div className="kb-label" style={{ marginTop: 12 }}>By Course</div>
      <table className="kb-table"><thead><tr><th>Course</th><th>Done</th><th>Rate</th><th>Avg Score</th><th>Rating</th></tr></thead><tbody>
        {rep.courses.map((c) => (
          <tr key={c.id}>
            <td><a href="#c" onClick={(e) => { e.preventDefault(); goKb('builder', c.id); }}>{c.title}</a>{c.delivery === 'in_person' && <span className="kb-meta"> · in person</span>}</td>
            <td>{c.completed} of {c.assigned}</td><td>{pct(c.rate)}</td><td>{pct(c.avg_score)}</td><td>{c.avg_rating ?? '-'}</td>
          </tr>
        ))}
      </tbody></table>
    </section>
  );
}
