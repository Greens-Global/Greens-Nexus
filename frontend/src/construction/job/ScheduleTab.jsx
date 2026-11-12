// The Job's Schedule tab (Neil, 11/03/2026, plan phase 2): the job's own
// task project, drawn by the Tasks module's own timeline (TimelineView - bars,
// milestones as diamonds, dependency arrows, drag to reschedule through
// Tasks' own reschedule), its milestones, and a two-week look-ahead the crew
// can read. A task opens in the Tasks drawer. Lazy - it brings the Tasks
// store and timeline, which nothing else on the Job page needs.
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Flag, CalendarRange, FolderKanban, ExternalLink } from 'lucide-react';
import { api } from '../../api';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import { TasksProvider, useTasks } from '../../tasks/TasksContext';
import { TimelineView } from '../../tasks/views/more';
import { formatDate } from '../../lib/datetime';
import { CARD, TONE, personName } from '../ui';
import { splitSchedule, useLoad } from '../lib/job';
import { SetUp } from './PunchTab';

const TaskDetailDrawer = lazy(() => import('../../tasks/TaskDetailDrawer'));

function milestoneState(t, today) {
  if (t.completed) return { label: 'Done', color: TONE.green };
  if (t.dueOn && today && t.dueOn < today) return { label: 'Missed', color: TONE.red };
  return { label: 'Upcoming', color: TONE.slate };
}

function Portfolio({ project, view, onSaved }) {
  const [list, setList] = useState(null);
  const [pick, setPick] = useState(view.taskProject?.portfolioId || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.getTaskPortfolios()).then((r) => { if (live) setList(Array.isArray(r) ? r : []); })
      .catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, []);
  const saved = view.taskProject?.portfolioId || '';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <FolderKanban size={16} style={{ color: 'var(--text-secondary)' }} />
      <label htmlFor="job-portfolio" style={{ fontSize: 13, fontWeight: 600 }}>Portfolio</label>
      <select id="job-portfolio" className="form-input" value={pick} disabled={list === null || busy}
        onChange={(e) => setPick(e.target.value)} style={{ width: 240 }}>
        <option value="">{list === null ? 'Loading…' : 'Not in a portfolio'}</option>
        {(list || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button className="secondary-btn" disabled={busy || pick === saved} onClick={async () => {
        setBusy(true); setError('');
        try { await api.addJobToPortfolio(project.id, pick); onSaved(); } catch (e) { setError(e.message || 'Could not change the portfolio.'); }
        setBusy(false);
      }}>{pick ? 'Add to Portfolio' : 'Take Out'}</button>
      {error && <span role="alert" style={{ fontSize: 13, color: 'hsl(var(--color-red))' }}>{error}</span>}
    </div>
  );
}

function Inner({ project }) {
  const store = useTasks();
  const { data: view, error, reload } = useLoad(() => api.getJobSchedule(project.id), project.id);
  const [openId, setOpenId] = useState(null);
  const tpId = view?.taskProject?.id || '';
  // The store's copy wins (it follows every edit live); the server's read
  // stands in until the store has the project's tasks.
  const live = useMemo(() => (store.tasks || []).filter((t) => tpId && t.projectId === tpId), [store.tasks, tpId]);
  const tasks = useMemo(() => (live.length ? live : (view?.tasks || [])), [live, view]);
  const parts = useMemo(() => {
    if (!view) return null;
    return splitSchedule({ ...view, tasks });
  }, [view, tasks]);

  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!view) return <SkeletonBlocks count={3} height={120} borderRadius={12} />;
  if (!view.taskProject) return <SetUp view={view} project={project} onDone={reload} />;
  const dated = tasks.filter((t) => t.startOn || t.dueOn);
  const today = view.today || project.today;

  return (
    <div>
      <div style={{ ...CARD, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <h3 style={{ fontSize: 18, marginBottom: 2 }}>Timeline</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>
              The job's task project. Drag a bar to move its dates; a diamond is a milestone.
            </p>
          </div>
          <a href={`/tasks/projects?project=${encodeURIComponent(tpId)}`} className="secondary-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: 13, textDecoration: 'none' }}>
            Open in Tasks <ExternalLink size={12} />
          </a>
        </div>
        {dated.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Nothing on the schedule has dates yet. Give tasks a start or due date in Tasks.</div>
        ) : (
          <TimelineView tasks={dated} onOpen={setOpenId} nameOf={store.nameOf} taskById={store.taskById} />
        )}
        {view.canEdit && <Portfolio project={project} view={view} onSaved={reload} />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
        <section style={{ ...CARD, marginBottom: 0 }} aria-label="Two-Week Look-Ahead">
          <h3 style={{ fontSize: 15, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <CalendarRange size={16} style={{ color: 'var(--text-secondary)' }} />Two-Week Look-Ahead
          </h3>
          {parts.lookAhead.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Nothing is planned for the next two weeks.</div>
          ) : parts.lookAhead.map((t) => (
            <button key={t.id} type="button" onClick={() => setOpenId(t.id)} data-lookahead={t.id}
              style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 10, padding: '7px 0', background: 'none',
                border: 'none', borderTop: '1px solid var(--border-color)', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
              <span style={{ minWidth: 0, fontSize: 14, color: 'var(--text-primary)' }}>
                {t.title}
                {(t.assigneeIds || []).length > 0 && (
                  <span style={{ color: 'var(--text-secondary)' }}> · {t.assigneeIds.map((e) => (t.assigneeNames || {})[e] || personName(e, project.names)).join(', ')}</span>
                )}
              </span>
              <span style={{ flexShrink: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
                {[t.startOn && formatDate(t.startOn, t.startOn), t.dueOn && formatDate(t.dueOn, t.dueOn)].filter(Boolean).join(' - ')}
              </span>
            </button>
          ))}
        </section>
        <section style={{ ...CARD, marginBottom: 0 }} aria-label="Milestones">
          <h3 style={{ fontSize: 15, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Flag size={16} style={{ color: 'var(--text-secondary)' }} />Milestones
          </h3>
          {parts.milestones.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No milestones yet. Mark a task as a milestone in Tasks.</div>
          ) : parts.milestones.map((t) => {
            const st = milestoneState(t, today);
            return (
              <button key={t.id} type="button" onClick={() => setOpenId(t.id)} data-milestone={t.id}
                style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '7px 0',
                  background: 'none', border: 'none', borderTop: '1px solid var(--border-color)', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                <span style={{ fontSize: 14, color: 'var(--text-primary)', minWidth: 0 }}>{t.title}</span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t.dueOn ? formatDate(t.dueOn, t.dueOn) : 'No date'}</span>
                  <StatusLabel size="sm" label={st.label} color={st.color} />
                </span>
              </button>
            );
          })}
        </section>
      </div>

      {openId && (
        <Suspense fallback={null}>
          <TaskDetailDrawer taskId={openId} onClose={() => { setOpenId(null); reload(); }} />
        </Suspense>
      )}
    </div>
  );
}

export default function ScheduleTab({ project }) {
  return <TasksProvider><Inner project={project} /></TasksProvider>;
}
