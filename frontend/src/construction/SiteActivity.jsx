// Construction - Site Activity: what happened on site this day and this week.
//
// The daily logs and the weekly report used to live inside the Project
// Dashboard, two levels down: open the dashboard, open a project, scroll past
// the registers. That is the wrong depth for the two things people touch most -
// a worker filing today's log and a manager reading the week - so they get
// their own tab between Project Dashboard and Cubby Integration.
//
// The split, in one line: Project Dashboard is the portfolio (which jobsites
// exist, how far along, their milestones and RFIs), this is the timeline (what
// the crew filed, what the week adds up to).
//
// The project picker is a select rather than cards: getting here means you
// already know which site you want, and a second grid of project tiles would
// just be the dashboard again.
import { useCallback, useEffect, useState } from 'react';
import { ClipboardList, Folder, MapPin, Plus } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { CARD, ROW, LOG_STATUS, editable } from './ui';
import Empty from './Empty';
import ConstructionInbox from './ConstructionInbox';
import ReviewQueue from './ReviewQueue';
import DailyLogCapture from './DailyLogCapture';
import WeeklyReports from './WeeklyReports';

export default function SiteActivity() {
  const { can } = useRole();
  const canReview = !!can?.('manager');

  const [projects, setProjects] = useState(null);
  const [projectId, setProjectId] = useState('');
  const [logs, setLogs] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(null);

  useEffect(() => {
    api.getConstructionOverview()
      .then((d) => {
        const list = d?.projects || [];
        setProjects(list);
        // Land on a site rather than on a "pick one" prompt: one jobsite is the
        // common case, and a worker opening this tab wants today's log.
        setProjectId((prev) => prev || list[0]?.id || '');
      })
      .catch((e) => { setProjects([]); setError(e.message || 'Could not load projects.'); });
  }, []);

  const loadLogs = useCallback(() => {
    if (!projectId) { setLogs([]); return; }
    setError('');
    setLogs(null);
    api.getConstructionLogs(projectId)
      .then(setLogs)
      .catch((e) => { setLogs([]); setError(e.message || 'Could not load daily logs.'); });
  }, [projectId]);

  useEffect(loadLogs, [loadLogs]);

  const project = (projects || []).find((p) => p.id === projectId) || null;

  const startToday = async () => {
    if (!project) return;
    setBusy(true);
    try {
      // Jobsite-local date, not UTC: a log filed at 6pm Pacific must not land on
      // tomorrow because the server is on UTC.
      const d = new Date();
      const logDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      setCapturing(await api.startConstructionLog(project.id, { log_date: logDate }));
    } catch (e) {
      setError(e.message || 'Could not start a daily log.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: 24 }}>
        <div className="view-title-group">
          <h2>Site Activity</h2>
          <p>Daily logs from the crew and the weekly report they add up to</p>
        </div>
        {project && (
          <button className="primary-btn" onClick={startToday} disabled={busy}>
            <Plus size={16} />{busy ? 'Starting…' : "Start Today's Log"}
          </button>
        )}
      </div>

      <ConstructionInbox />

      {error && <ErrorBanner message={error} onRetry={loadLogs} />}

      {projects === null ? (
        <SkeletonBlocks count={2} height={110} borderRadius={8} />
      ) : projects.length === 0 ? (
        <div style={CARD}>
          <Empty
            icon={Folder}
            title="No construction projects yet"
            hint="Create a jobsite on the Project Dashboard, then its daily logs and weekly reports show up here."
          />
        </div>
      ) : (
        <>
          {/* One site: naming it beats a select with a single option. */}
          {projects.length > 1 ? (
            <div style={{ ...CARD, marginBottom: 20, padding: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <label htmlFor="site-activity-project" style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                Jobsite
              </label>
              <select
                id="site-activity-project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                style={{
                  padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-color)',
                  backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)',
                  fontSize: '0.9rem', minWidth: 220, cursor: 'pointer',
                }}>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {project?.phase && (
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  {project.phase} · {Math.round(project.percentComplete || 0)}% complete
                </span>
              )}
            </div>
          ) : (
            <div style={{ marginBottom: 20, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              {project?.name}
              {project?.phase ? ` · ${project.phase}` : ''}
            </div>
          )}

          {/* Managers first: what is waiting on them outranks the archive. */}
          {canReview && <ReviewQueue />}

          <div style={CARD}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Daily Logs</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>
              What the crew filed from site, newest first
            </p>

            {logs === null ? (
              <SkeletonBlocks count={3} height={96} borderRadius={8} />
            ) : logs.length === 0 ? (
              <Empty
                icon={ClipboardList}
                title="No daily logs yet"
                hint="A log is one worker, one day on this site. Start one and attach photos, video or a voice note as the day goes."
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {logs.map((l) => {
                  const s = LOG_STATUS[l.status] || LOG_STATUS.draft;
                  return (
                    <div key={l.id} style={ROW} role={editable(l) ? 'button' : undefined}
                      tabIndex={editable(l) ? 0 : undefined}
                      onClick={() => editable(l) && setCapturing(l)}
                      onKeyDown={(e) => { if (editable(l) && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setCapturing(l); } }}
                      title={editable(l) ? 'Add photos, video or a voice note' : undefined}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <strong style={{ fontSize: '1rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{l.logDate}</strong>
                            <span style={{ backgroundColor: s.bg, color: s.fg, fontSize: '0.7rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>{s.label}</span>
                            {/* Advisory, never enforced - see _within_geofence. Shown so a
                                manager can weigh it, not to accuse anyone. */}
                            {!l.geofenceOk && (
                              <span title="Recorded outside the jobsite geofence" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.7rem', color: 'hsl(var(--color-amber, 38 92% 45%))', fontWeight: 600 }}>
                                <MapPin size={11} />Off-site
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                            {l.authorEmail}
                            {l.crewSize ? ` · crew of ${l.crewSize}` : ''}
                            {l.hoursWorked ? ` · ${l.hoursWorked}h` : ''}
                          </div>
                        </div>
                      </div>
                      {/* The AI summary when it exists, the worker's own words until
                          then. Never both - the summary is derived from the notes and
                          showing the pair just makes the row twice as tall. */}
                      {(l.aiSummary || l.notes) && (
                        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
                          {l.aiSummary || l.notes}
                        </p>
                      )}
                      {l.status === 'submitted' && !l.aiProcessedAt && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                          Queued for AI processing
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Below the logs, in the order the week runs: the crew files logs, the
              report is cut from them. */}
          {project && <WeeklyReports project={project} canReview={canReview} />}
        </>
      )}

      {capturing && project && (
        <DailyLogCapture
          log={capturing} project={project}
          onClose={() => { setCapturing(null); loadLogs(); }}
          onSubmitted={() => { setCapturing(null); loadLogs(); }}
        />
      )}
    </div>
  );
}
