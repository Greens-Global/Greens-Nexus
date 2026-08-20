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
// Shared with SiteActivity, which draws the same cards and status chips.
import { CARD, ROW } from './ui';
import Empty from './Empty';
import ConstructionInbox from './ConstructionInbox';
import ReviewQueue from './ReviewQueue';
import Registers from './Registers';

function Stat({ label, value, helper }) {
  return (
    <div className="kpi-card card-blue" style={{ cursor: 'default' }}>
      <div className="kpi-card-header"><span className="kpi-title">{label}</span></div>
      <div className="kpi-stat" style={{ fontSize: '2rem' }}>{value}</div>
      {helper && <div className="kpi-helper" style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{helper}</div>}
    </div>
  );
}

// ── Project detail: one jobsite's standing facts ────────────────────────────
// The day-to-day (logs, weekly report) moved to Site Activity; what stays here
// is what belongs to the jobsite itself - its identity, progress and registers.
function ProjectDetail({ project, onBack }) {
  const { can } = useRole();
  const canReview = !!can?.('manager');
  const [logs, setLogs] = useState(null);
  const [error, setError] = useState('');

  // Still fetched, only to count them: "12 daily logs" is a fact about the
  // jobsite, and a card that cannot say how much is over there is a weaker
  // signpost than one that can.
  const load = useCallback(() => {
    setError('');
    api.getConstructionLogs(project.id)
      .then(setLogs)
      .catch((e) => { setLogs([]); setError(e.message || 'Could not load daily logs.'); });
  }, [project.id]);

  useEffect(load, [load]);

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
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {/* The daily logs and the weekly report moved to the Site Activity tab -
          they are the two things people open every day, and they were two levels
          down from here. This card is the way back to them for anyone who
          arrived via a project, so the move does not read as a deletion. */}
      <div style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <ClipboardList size={20} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
            {logs === null ? 'Daily logs' : `${logs.length} daily log${logs.length === 1 ? '' : 's'}`}
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 2 }}>
            Daily logs and weekly reports for this jobsite live on Site Activity.
          </div>
        </div>
        <button className="secondary-btn" onClick={() => window.dispatchEvent(
          new CustomEvent('nexus:navigate', { detail: { view: 'ops', sub: 'construction-activity' } }))}>
          Open Site Activity
        </button>
      </div>

      {/* The schedule and the open correspondence stay with the project: they are
          properties of the jobsite, not of a given day or week. */}
      <Registers project={project} canReview={canReview} />
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

      {/* Above the stats on purpose: a log bounced back with a question is the
          one thing on this screen that is waiting on the reader personally.
          Renders nothing when there is nothing waiting. */}
      <ConstructionInbox />

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
