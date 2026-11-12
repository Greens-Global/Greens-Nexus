// Construction - Site Activity: what happened on site this day and this week.
//
// The daily logs and the weekly report used to live inside the Project
// Dashboard, two levels down: open the dashboard, open a project, scroll past
// the registers. That is the wrong depth for the two things people touch most -
// a worker filing today's log and a manager reading the week - so they get
// their own tab after Project Dashboard.
//
// The split, in one line: Project Dashboard is the portfolio (which jobsites
// exist, how far along, their milestones and RFIs), this is the timeline (what
// the crew filed, what the week adds up to).
//
// The project picker is one searchable field rather than cards: getting here
// means you already know which site you want, and a second grid of project
// tiles would just be the dashboard again.
//
// 11/03/2026: the jobsite is in the URL (/construction/activity:<id> -
// Operations.jsx), so "Open Site Activity" on a project and a bell land on
// it; the review queue shows only the picked jobsite; "today" is the
// jobsite's own date (the server's clock for it); names, never addresses;
// nothing about AI while AI is off; an approved log reopens only with a reason.
import { useCallback, useEffect, useState } from 'react';
import { ClipboardList, Folder, MapPin, Plus, RotateCcw } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import { dialog } from '../ui/dialog';
import { CARD, ROW, LOG_STATUS, TAG_COLOR, editable, personName, tagLabel } from './ui';
import Empty from './Empty';
import ConstructionInbox from './ConstructionInbox';
import ReviewQueue from './ReviewQueue';
import DailyLogCapture from './DailyLogCapture';
import WeeklyReports from './WeeklyReports';
import SearchPicker from './SearchPicker';
import { useConstructionMeta } from './lib/meta';
import { formatDate, formatDateTime } from '../lib/datetime';
import { loadLogs as loadLogsThroughPhone, prefetchJob, startLog, loadPrefill } from './constructionOffline';
import { readThrough } from '../lib/offline/store';
import { ModuleActions } from '../components/ModuleTabs';
import { formatHoursWords } from '../lib/hoursText';

// The browser's own date - only when the server has not said the jobsite's.
function browserToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function SiteActivity({ projectId: routeId = '', onProjectChange }) {
  const { can } = useRole();
  const { aiEnabled } = useConstructionMeta();

  const [projects, setProjects] = useState(null);
  const [pickedId, setPickedId] = useState('');
  const [logs, setLogs] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(null);
  const [queueKey, setQueueKey] = useState(0);
  const [savedAt, setSavedAt] = useState('');

  // Through the phone (field offline, 11/03/2026): with no signal the jobsites
  // and their logs open from what this phone saved.
  useEffect(() => {
    readThrough('construction:overview', () => api.getConstructionOverview(), { onCache: setSavedAt })
      .then((d) => setProjects(d?.projects || []))
      .catch((e) => { setProjects([]); setError(e.message || 'Could not load projects.'); });
  }, []);

  // The URL's jobsite wins; else the one picked here; else the first - one
  // jobsite is the common case, and a worker opening this tab wants today's log.
  const list = projects || [];
  const projectId = (routeId && list.some((p) => p.id === routeId) ? routeId : '')
    || (pickedId && list.some((p) => p.id === pickedId) ? pickedId : '') || list[0]?.id || '';
  const project = list.find((p) => p.id === projectId) || null;
  const canReview = !!project?.canEdit || !!can?.('manager');

  const pick = (id) => {
    setPickedId(id);
    if (onProjectChange) onProjectChange(id);
  };

  const loadLogs = useCallback(() => {
    if (!projectId) { setLogs([]); return; }
    setError('');
    setLogs(null);
    loadLogsThroughPhone(projectId, { onCache: setSavedAt })
      .then(setLogs)
      .catch((e) => { setLogs([]); setError(e.message || 'Could not load daily logs.'); });
  }, [projectId]);

  useEffect(loadLogs, [loadLogs]);
  // Keep today's prefill and the job's field lists on the phone while there is signal.
  useEffect(() => { if (project) prefetchJob(project); }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const startToday = async () => {
    if (!project) return;
    setBusy(true);
    try {
      // The JOBSITE's date (the server's clock for it, construction_company),
      // not UTC and not the phone's: a log filed at 6 PM on a Pacific site must
      // not land on tomorrow.
      // With no signal the log starts on this phone from its saved prefill
      // and goes to the server when there is signal (constructionOffline).
      const day = project.today || browserToday();
      let pre = null;
      try { pre = await loadPrefill(project.id, day); } catch { /* none saved */ }
      setCapturing(await startLog(project, day, pre));
    } catch (e) {
      setError(e.message || 'Could not start a daily log.');
    } finally {
      setBusy(false);
    }
  };

  // The one way back from Approved: a manager, with a reason on the record.
  const reopen = async (l) => {
    const reason = await dialog.prompt('Why is this log being reopened? The crew member sees the reason.', {
      title: 'Reopen Daily Log', confirmText: 'Reopen', required: true, placeholder: 'e.g. Crew count is wrong',
    });
    if (!reason) return;
    try {
      await api.reopenConstructionLog(l.id, reason);
      loadLogs();
      setQueueKey((k) => k + 1);
    } catch (e) {
      setError(e.message || 'Could not reopen the log.');
    }
  };

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* No page title (Neil, 11/06/2026): the module bar names the tab; Start
          Today's Log rides its right end. */}
      {project && (
        <ModuleActions>
          <button className="primary-btn" onClick={startToday} disabled={busy}>
            <Plus size={16} />{busy ? 'Starting…' : "Start Today's Log"}
          </button>
        </ModuleActions>
      )}
      {savedAt && <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px' }}>Opened from this phone (saved {formatDateTime(savedAt, '')}).</p>}

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
              <label htmlFor="site-activity-project" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
                Jobsite
              </label>
              <SearchPicker
                id="site-activity-project"
                value={projectId}
                onChange={pick}
                placeholder="Pick a jobsite"
                searchPlaceholder="Search jobsites…"
                options={projects.slice()
                  .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }))
                  .map((p) => ({ id: p.id, label: p.name, hint: p.phase || '' }))} />
              {project?.phase && (
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  {project.phase} · {Math.round(project.percentComplete || 0)}% complete
                </span>
              )}
            </div>
          ) : (
            <div style={{ marginBottom: 20, fontSize: 15, color: 'var(--text-secondary)' }}>
              {project?.name}
              {project?.phase ? ` · ${project.phase}` : ''}
            </div>
          )}

          {/* Managers first: what is waiting on them outranks the archive -
              this jobsite's logs only (11/03/2026). */}
          {canReview && project && (
            <ReviewQueue key={`${project.id}-${queueKey}`} projectId={project.id}
              onDecided={loadLogs} />
          )}

          <div style={CARD}>
            <h3 style={{ fontSize: 18, fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Daily Logs</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 20 }}>
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
                  const text = (aiEnabled && l.aiSummary) || l.notes;
                  return (
                    <div key={l.id} style={ROW} role={editable(l) ? 'button' : undefined}
                      tabIndex={editable(l) ? 0 : undefined}
                      onClick={() => editable(l) && setCapturing(l)}
                      onKeyDown={(e) => { if (editable(l) && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setCapturing(l); } }}
                      title={editable(l) ? 'Add photos, video or a voice note' : undefined}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <strong style={{ fontSize: 15, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{formatDate(l.logDate, l.logDate)}</strong>
                            <StatusLabel size="sm" label={s.label} color={s.color} />
                            {(l.tags || []).map((t) => <StatusLabel key={t} size="sm" label={tagLabel(t)} color={TAG_COLOR[t]} />)}
                            {/* Advisory, never enforced - see _within_geofence. Shown so a
                                manager can weigh it, not to accuse anyone. */}
                            {!l.geofenceOk && (
                              <span title="Recorded outside the jobsite geofence" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                                <MapPin size={11} />Off-Site
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                            {l.authorName || personName(l.authorEmail)}
                            {l.crewSize ? ` · crew of ${l.crewSize}` : ''}
                            {l.hoursWorked ? ` · ${formatHoursWords(l.hoursWorked, { compact: true })}` : ''}
                          </div>
                        </div>
                        {canReview && l.status === 'approved' && (
                          <button type="button" className="secondary-btn" style={{ fontSize: 13, flexShrink: 0 }}
                            onClick={(e) => { e.stopPropagation(); reopen(l); }}>
                            <RotateCcw size={13} />Reopen
                          </button>
                        )}
                      </div>
                      {/* The AI summary when AI is on and it exists, the worker's own
                          words otherwise. Never both - the summary is derived from the
                          notes and showing the pair just makes the row twice as tall. */}
                      {text && (
                        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
                          {text}
                        </p>
                      )}
                      {l.status === 'needs_info' && l.reviewNote && (
                        <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                          <strong>{l.reviewedByName || personName(l.reviewedBy) || 'Your manager'} asks:</strong> {l.reviewNote}
                        </div>
                      )}
                      {aiEnabled && l.status === 'submitted' && !l.aiProcessedAt && (
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
          {project && <WeeklyReports key={project.id} project={project} canReview={canReview} />}
        </>
      )}

      {capturing && project && (
        <DailyLogCapture
          log={capturing} project={project}
          onClose={() => { setCapturing(null); loadLogs(); }}
          onSubmitted={() => { setCapturing(null); loadLogs(); setQueueKey((k) => k + 1); }}
        />
      )}
    </div>
  );
}
