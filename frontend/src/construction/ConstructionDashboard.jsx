// Construction - Project Dashboard, backed by /construction/*.
//
// Replaces the hardcoded INIT_PROJECTS / "156 / 12 / 0 / 94%" block that used to
// live inline in views/Operations.jsx. Its own file because the construction
// module is going to grow (daily log capture, manager review, weekly reports)
// and Operations.jsx also owns the unrelated Cubby tab.
//
// Every number shown here is derived server-side in /construction/overview. The
// old "Productivity 94%" card is gone rather than reimplemented: nothing in the
// data model measures productivity, and a KPI with no source is worse than no
// KPI - somebody eventually puts it in a board deck.
import { useCallback, useEffect, useState } from 'react';
import { useRole } from '../contexts/RoleContext';
import { Folder, MapPin, Users, Calendar, ChevronRight, ArrowLeft, Plus, ClipboardList } from 'lucide-react';
import { api } from '../api';
// Shared rather than local copies: AsyncState is the codebase's one loading /
// error idiom, and a fourth hand-rolled banner is a fourth thing to restyle.
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import ReviewQueue from './ReviewQueue';
import DailyLogCapture from './DailyLogCapture';
import WeeklyReports from './WeeklyReports';
import Registers from './Registers';

const CARD = {
  backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)',
  borderRadius: 12, padding: 24, marginBottom: 24, boxShadow: 'var(--shadow-sm)',
};
const ROW = {
  backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)',
  borderRadius: 8, padding: 20, display: 'flex', flexDirection: 'column', gap: 12,
};

// Only a draft or a bounced-back log can still be edited. submit_log freezes
// the rest server-side (409), so opening capture on one would dead-end.
const editable = (l) => l.status === 'draft' || l.status === 'needs_info';

const LOG_STATUS = {
  draft:      { label: 'Draft',        bg: 'var(--border-color)',    fg: 'var(--text-secondary)' },
  submitted:  { label: 'Submitted',    bg: 'hsl(var(--color-blue))', fg: '#fff' },
  processed:  { label: 'AI Processed', bg: 'hsl(var(--color-blue))', fg: '#fff' },
  needs_info: { label: 'Needs Info',   bg: 'hsl(var(--color-red))',  fg: '#fff' },
  approved:   { label: 'Approved',     bg: 'hsl(var(--color-green))', fg: '#fff' },
};

function Stat({ label, value, helper }) {
  return (
    <div className="kpi-card card-blue" style={{ cursor: 'default' }}>
      <div className="kpi-card-header"><span className="kpi-title">{label}</span></div>
      <div className="kpi-stat" style={{ fontSize: '2rem' }}>{value}</div>
      {helper && <div className="kpi-helper" style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{helper}</div>}
    </div>
  );
}

// Loading and empty are distinct states on purpose. A spinner that resolves to
// "No projects yet" reads as working; an empty list that was actually a failed
// fetch reads as "the data is gone" and generates a support ticket.
function Empty({ icon: Icon, title, hint, action }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-secondary)' }}>
      <Icon size={32} style={{ opacity: 0.4, marginBottom: 12 }} />
      <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>{title}</div>
      {hint && <p style={{ fontSize: '0.85rem', maxWidth: 420, margin: '0 auto 16px' }}>{hint}</p>}
      {action}
    </div>
  );
}

// ── Project detail: the daily logs for one jobsite ──────────────────────────
function ProjectDetail({ project, onBack }) {
  const { can } = useRole();
  const canReview = !!can?.('manager');
  const [logs, setLogs] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(null);   // the log being filled in

  const load = useCallback(() => {
    setError('');
    api.getConstructionLogs(project.id)
      .then(setLogs)
      .catch((e) => { setLogs([]); setError(e.message || 'Could not load daily logs.'); });
  }, [project.id]);

  useEffect(load, [load]);

  const startToday = async () => {
    setBusy(true);
    try {
      // Jobsite-local date, not UTC: a log filed at 6pm Pacific must not land on
      // tomorrow because the server is on UTC.
      const d = new Date();
      const logDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      // Straight into capture - the worker tapped Start to attach something,
      // not to look at a list.
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <button className="secondary-btn" onClick={onBack} style={{ padding: 8 }} title="Back to Construction">
            <ArrowLeft size={16} />
          </button>
          <div className="view-title-group" style={{ minWidth: 0 }}>
            <h2 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</h2>
            <p>
              {project.address || 'No address'}
              {project.phase ? ` · ${project.phase}` : ''}
              {` · ${Math.round(project.percentComplete || 0)}% complete`}
            </p>
          </div>
        </div>
        <button className="primary-btn" onClick={startToday} disabled={busy}>
          <Plus size={16} />{busy ? 'Starting…' : "Start Today's Log"}
        </button>
      </div>

      <div style={CARD}>
        <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Daily Logs</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>
          What the crew filed from site, newest first
        </p>

        {error && <ErrorBanner message={error} onRetry={load} />}

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

      {/* Between the logs and the report, in the order the week actually runs:
          the crew files logs, the manager reconciles them against the schedule
          and the open correspondence, and the report is cut from all three. */}
      <Registers project={project} canReview={canReview} />

      {/* Below the logs, not a tab: the report is what the logs are for, and a
          manager who has just approved the week should see the draft it feeds
          without hunting for it. */}
      <WeeklyReports project={project} canReview={canReview} />

      {capturing && (
        <DailyLogCapture
          log={capturing} project={project}
          onClose={() => { setCapturing(null); load(); }}
          onSubmitted={() => { setCapturing(null); load(); }}
        />
      )}
    </div>
  );
}

// ── New project modal ───────────────────────────────────────────────────────
function NewProjectModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', address: '', phase: '', general_contractor: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || saving) return;
    setSaving(true); setError('');
    try {
      onCreated(await api.createConstructionProject(form));
    } catch (err) {
      setSaving(false);
      setError(err.message || 'Could not create the project.');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <form onSubmit={save}>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>New Project</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>
            A jobsite. You are added as its manager so you can review logs straight away.
          </p>
          {error && <ErrorBanner message={error} onRetry={() => setError('')} />}
          <label className="form-label">Project Name</label>
          <input className="form-input" autoFocus value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Valley Center Phase 2" />
          <label className="form-label" style={{ marginTop: 14 }}>Address</label>
          <input className="form-input" value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Jobsite address" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
            <div>
              <label className="form-label">Phase</label>
              <input className="form-input" value={form.phase}
                onChange={(e) => setForm({ ...form, phase: e.target.value })} placeholder="Foundation" />
            </div>
            <div>
              <label className="form-label">General Contractor</label>
              <input className="form-input" value={form.general_contractor}
                onChange={(e) => setForm({ ...form, general_contractor: e.target.value })} placeholder="Optional" />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
            <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-btn" disabled={!form.name.trim() || saving}>
              {saving ? 'Creating…' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Dashboard ───────────────────────────────────────────────────────────────
export default function ConstructionDashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const { can } = useRole();
  const canReview = !!can?.('manager');

  const load = useCallback(() => {
    setError('');
    api.getConstructionOverview()
      .then(setData)
      .catch((e) => { setData({ projects: [] }); setError(e.message || 'Could not load construction data.'); });
  }, []);

  useEffect(load, [load]);

  const projects = data?.projects || [];
  const open = openId ? projects.find((p) => p.id === openId) : null;
  if (open) return <ProjectDetail project={open} onBack={() => { setOpenId(null); load(); }} />;

  return (
    <>
      <div className="view-header" style={{ marginBottom: 24 }}>
        <div className="view-title-group">
          <h2>Construction Overview</h2>
          <p>Jobsite daily logs, media and weekly reporting</p>
        </div>
        <button className="primary-btn" onClick={() => setShowNew(true)}><Plus size={16} />New Project</button>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 24 }}>
        <Stat label="Active Sites"    value={data ? data.activeSites : '—'} />
        <Stat label="Crew on Projects" value={data ? data.totalWorkforce : '—'} />
        <Stat label="Safety Flags"    value={data ? data.safetyFlags : '—'} helper="raised by AI from site media" />
        <Stat label="Pending Review"  value={data ? data.pendingReview : '—'} helper="logs awaiting a manager" />
      </div>

      {canReview && <ReviewQueue />}

      <div style={CARD}>
        <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Active Projects</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Open a project to see and file its daily logs</p>

        {data === null ? (
          <SkeletonBlocks count={3} height={110} borderRadius={8} />
        ) : projects.length === 0 ? (
          <Empty
            icon={Folder}
            title="No construction projects yet"
            hint="Create a jobsite to start collecting daily logs from the field."
            action={<button className="primary-btn" onClick={() => setShowNew(true)}><Plus size={16} />New Project</button>}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {projects.map((p) => (
              <div key={p.id} role="button" tabIndex={0}
                onClick={() => setOpenId(p.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(p.id); } }}
                style={{ ...ROW, cursor: 'pointer', transition: 'border-color .13s' }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-color)'; }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Folder size={18} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                      <strong style={{ fontSize: '1.05rem', fontFamily: "'Plus Jakarta Sans', sans-serif", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</strong>
                      {p.phase && (
                        <span style={{ backgroundColor: '#111827', color: '#fff', fontSize: '0.7rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>{p.phase}</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: '0.8rem', color: 'var(--text-secondary)', alignItems: 'center' }}>
                      {p.address && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><MapPin size={13} />{p.address}</span>}
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Users size={13} />{(p.workerEmails || []).length} crew
                      </span>
                      {p.targetFinishOn && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Calendar size={13} />Due: {p.targetFinishOn}</span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                    <strong style={{ fontSize: '1.15rem' }}>{Math.round(p.percentComplete || 0)}%</strong>
                    <ChevronRight size={18} style={{ color: 'var(--text-secondary)' }} />
                  </div>
                </div>
                <div style={{ height: 6, borderRadius: 999, backgroundColor: 'var(--border-color)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, p.percentComplete || 0))}%`, backgroundColor: '#111827', borderRadius: 999 }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showNew && (
        <NewProjectModal
          onClose={() => setShowNew(false)}
          onCreated={(p) => { setShowNew(false); load(); setOpenId(p.id); }}
        />
      )}
    </>
  );
}
