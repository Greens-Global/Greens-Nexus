// The tasks started from one SOP, and the old run history.
import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { Chip, Av } from '../components/Chips';
import { errText } from '../components/Toast';
import { goKb, goView, fmtDate, fmtDateTime } from '../lib';

export default function PageTasksView({ id }) {
  const [page, setPage] = useState(null);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const load = () => { setErr(''); Promise.all([api.kbPage(id), api.kbPageTasks(id)]).then(([p, t]) => { setPage(p); setData(t); }).catch((e) => setErr(errText(e))); };
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <AsyncSection loading={!data && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
      {data && page && (
        <div className="kb-page">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} className="kb-meta">
            <button type="button" className="kb-ibtn" style={{ width: 30, height: 30 }} aria-label="Back" onClick={() => goKb('page', id)}><ArrowLeft /></button>
            <a href="#p" onClick={(e) => { e.preventDefault(); goKb('page', id); }}>{page.title}</a> / <b style={{ color: 'var(--kb-ink)' }}>Done as a Task</b>
          </div>
          <section className="kb-card">
            <h3 className="kb-h3" style={{ marginBottom: 8 }}>Tasks</h3>
            {data.tasks.length === 0 && <div className="kb-empty">This page has not been started as a task yet.</div>}
            {data.tasks.map((t) => (
              <div key={t.task_id} className="kb-row link" onClick={() => { goView('tasks', 'mine'); setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:open-task', { detail: { taskId: t.task_id } })), 0); }}>
                <Chip color={t.completed ? '#1e7b4e' : '#2b6cb0'}>{t.completed ? 'Done' : 'Open'}</Chip>
                <div className="kb-grow"><div className="kb-title">{t.code ? `${t.code} · ` : ''}{t.title}</div><div className="kb-meta">{t.assignee_name}{t.due_on ? ` · due ${fmtDate(t.due_on)}` : ''} · {t.checklist_done} of {t.checklist_total} steps · v{t.version}{t.recurring ? ' · repeats' : ''}</div></div>
              </div>
            ))}
          </section>
          {data.legacy_runs.length > 0 && (
            <section className="kb-card">
              <h3 className="kb-h3" style={{ marginBottom: 8 }}>Earlier Runs</h3>
              <div className="kb-meta" style={{ marginBottom: 6 }}>From before tasks replaced the run checklist. Kept as history.</div>
              {data.legacy_runs.map((r) => <div key={r.id} className="kb-row"><Av name={r.user_name} size={24} /><div className="kb-grow"><div className="kb-title">{r.user_name}</div><div className="kb-meta">{r.status} · {r.steps_done} of {r.step_count} steps · {fmtDateTime(r.started_at)}</div></div></div>)}
            </section>
          )}
        </div>
      )}
    </AsyncSection>
  );
}
