// Construction - Project Dashboard, backed by /construction/*.
//
// Replaces the hardcoded INIT_PROJECTS / "156 / 12 / 0 / 94%" block that used to
// live inline in views/Operations.jsx. Its own file because the construction
// module is going to grow (daily log capture, manager review, weekly reports).
//
// Every number shown here is derived server-side in /construction/overview. The
// old "Productivity 94%" card is gone rather than reimplemented: nothing in the
// data model measures productivity, and a KPI with no source is worse than no
// KPI - somebody eventually puts it in a board deck.
//
// 11/03/2026 (Neil, plan https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr):
// the projects come first, worst first, each with its health row (Late / At
// Risk / On Track - construction_health.py) above the KPIs; progress is the
// house ProgressTrack (red past the target finish); an open project is a URL
// (/construction/project:<id>, Operations.jsx) so Back works and a bell or a
// pasted link lands on it; Edit Job is a sheet with the team pickers.
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useRole } from '../contexts/RoleContext';
import { Folder, MapPin, Users, Calendar, ChevronRight, ArrowLeft, Plus, ExternalLink } from 'lucide-react';
import { api } from '../api';
import { readThrough } from '../lib/offline/store';
// Shared rather than local copies: AsyncState is the codebase's one loading /
// error idiom, and a fourth hand-rolled banner is a fourth thing to restyle.
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../components/UnsavedChangesPrompt';
import { StatusLabel } from '../components/StatusLabel';
import ProgressTrack from '../ui/ProgressTrack';
import { useIsMobile } from '../lib/useIsMobile';
// Shared with SiteActivity, which draws the same cards and status chips.
import { CARD, ROW, TONE, PROJECT_STATUS, tagLabel } from './ui';
import Empty from './Empty';
import ConstructionInbox from './ConstructionInbox';
import ReviewQueue from './ReviewQueue';
import HealthRow from './HealthRow';
import { SiteWeatherStrip } from './SiteWeather';
import { trackStateFor } from './lib/health';
import { useNexusPeople, useProperties } from './lib/jobForm';
import { JOB_TYPE, clientId } from './lib/job';
import ChoicePills from '../components/ChoicePills';
import { formatDate } from '../lib/datetime';
import { PersonMultiSelect } from '../tasks/components';
import WorkSiteLinkPanel from '../components/WorkSiteLinkPanel';
import WorkSiteAddressMap from '../components/WorkSiteAddressMap';
import { googleMapsUrl } from '../lib/addressSearch';
import { ModuleActions } from '../components/ModuleTabs';
import { useTableValue } from '../tasks/tableCols';
import ProgramTable from './ProgramTable';

function Stat({ label, value, helper }) {
  return (
    <div className="kpi-card card-blue" style={{ cursor: 'default' }}>
      <div className="kpi-card-header"><span className="kpi-title">{label}</span></div>
      <div className="kpi-stat" style={{ fontSize: '2rem' }}>{value}</div>
      {helper && <div className="kpi-helper" style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{helper}</div>}
    </div>
  );
}

const pct = (p) => Math.round(p?.percentComplete || 0);

function Progress({ project, withEnds = false }) {
  return (
    <ProgressTrack value={pct(project) / 100} state={trackStateFor(project)} size="sm"
      label={`${project.name} progress`}
      start={withEnds && project.startOn ? `Started ${formatDate(project.startOn, project.startOn)}` : undefined}
      end={withEnds && project.targetFinishOn ? `Target ${formatDate(project.targetFinishOn, project.targetFinishOn)}` : undefined}
      note={withEnds ? <><b>{pct(project)}% complete</b>{project.phase ? ` - ${project.phase}` : ''}</> : undefined} />
  );
}

function StatusChip({ project }) {
  const s = PROJECT_STATUS[project.status];
  if (!s || project.status === 'active') return null;
  return <StatusLabel size="sm" label={s.label} color={s.color} />;
}

// The Job page (11/03/2026, plan phase 2): its own lazy chunk.
const JobPage = lazy(() => import('./job/JobPage'));

// ── New project modal ───────────────────────────────────────────────────────
// The jobsite is placed the way a work site is (Pranshu, 11/02/2026): its
// Google Maps link gives the exact point - the one the weather is read at -
// and the address, shown on the map where the pin can be fine-tuned. A typed
// address with no link is still looked up on the server, less exactly.
// The crew and the managers are picked here too (11/03/2026), so a new job
// is usable the moment it exists.
const GEOFENCE_M = 500;   // a new project's default (routers/construction.py)

// New Job (11/03/2026, plan phase 2) asks the type (a Work Order or a
// Project - size decides which sections the Job page shows), the property,
// the crew and managers, and the Tasks template its schedule is stamped from
// (blank = the job type's own: "Work Order" or "Construction Project").
const TYPE_LABELS = { [JOB_TYPE.work_order.label]: 'work_order', [JOB_TYPE.project.label]: 'project' };

function useTemplates() {
  const [list, setList] = useState([]);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.getTaskProjectTemplates?.())
      .then((r) => { if (live) setList((Array.isArray(r) ? r : []).filter((t) => !t.archived)); })
      .catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, []);
  return list;
}

function NewProjectModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', address: '', phase: '', general_contractor: '' });
  const [jobType, setJobType] = useState('project');
  const [propertyId, setPropertyId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [newId] = useState(() => clientId('job'));
  const properties = useProperties();
  const templates = useTemplates();
  const [crew, setCrew] = useState([]);
  const [managers, setManagers] = useState([]);
  const [loc, setLoc] = useState({ lat: '', lng: '', point: null, link: '', manual: false, adjusted: false });
  const [focus, setFocus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const people = useNexusPeople();
  const hasPoint = loc.lat !== '' && loc.lng !== '';

  const save = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || saving) return;
    setSaving(true); setError('');
    try {
      onCreated(await api.createConstructionProject({ ...form, id: newId, job_type: jobType,
        ...(propertyId ? { property_id: propertyId } : {}),
        ...(templateId ? { task_template_id: templateId } : {}),
        ...(crew.length ? { worker_emails: crew } : {}),
        ...(managers.length ? { manager_emails: managers } : {}),
        ...(hasPoint ? { latitude: Number(loc.lat), longitude: Number(loc.lng) } : {}) }));
    } catch (err) {
      setSaving(false);
      setError(err.message || 'Could not create the job.');
    }
  };

  const dirty = !!(form.name.trim() || form.address.trim() || form.phase.trim() || form.general_contractor.trim() || hasPoint || crew.length || managers.length);
  const guard = useUnsavedGuard(dirty, onClose, form.name.trim() ? () => save({ preventDefault() {} }) : undefined);
  const status = hasPoint
    ? `${loc.adjusted ? 'Pin fine-tuned on the map.' : 'Placed from the Google Maps link.'} The weather is read at this exact point.`
    : form.address.trim() ? 'No exact point yet - Nexus will look this address up for its weather. A Google Maps link is exact.'
    : 'Not placed yet. Paste the Google Maps link of the jobsite.';

  return (
    <div className="modal-overlay" onClick={guard.requestClose}>
      <div className="modal-content nx-popup" onClick={(e) => e.stopPropagation()}>
        {/* .modal-content has no padding of its own (it expects modal-header /
            modal-body), so the form brings its own - it sat flush to the edges. */}
        <form onSubmit={save} style={{ padding: '22px 24px 20px' }}>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>New Job</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>
            A work order or a project at a jobsite. With no managers picked you are its manager, so you can review logs straight away.
          </p>
          {error && <ErrorBanner message={error} onRetry={() => setError('')} />}
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {/* Left: the inputs, in the order they are filled in. */}
            <div style={{ flex: '1 1 340px', minWidth: 0 }}>
              <label className="form-label" id="new-job-type">Job Type</label>
              <ChoicePills label="Job Type" options={Object.keys(TYPE_LABELS)}
                value={jobType === 'work_order' ? JOB_TYPE.work_order.label : JOB_TYPE.project.label}
                onChange={(label) => setJobType(TYPE_LABELS[label])} />
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', margin: '6px 0 14px' }}>
                {jobType === 'work_order'
                  ? 'A repair or a short job: its steps, a punch list, the field record and closeout.'
                  : 'A build: a full schedule with milestones, punch list, RFIs and submittals.'}
              </div>
              <label className="form-label">Job Name</label>
              <input className="form-input" autoFocus value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Valley Center Phase 2" />
              <label className="form-label" style={{ marginTop: 14 }}>Google Maps Link</label>
              <WorkSiteLinkPanel link={loc.link} point={loc.point} resolve={api.resolveProjectLink} what="jobsite"
                onResolved={({ link, point }) => {
                  setLoc({ lat: point.lat.toFixed(6), lng: point.lng.toFixed(6), point, link, manual: !point.address, adjusted: false });
                  setForm((f) => ({ ...f, address: point.address || f.address, name: f.name.trim() ? f.name : (point.placeName || '') }));
                  setFocus({ lat: point.lat, lng: point.lng, key: Date.now() });
                }} />
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginTop: 6 }}>
                <label className="form-label" htmlFor="project-address">Address</label>
                <button type="button" onClick={() => setLoc((l) => ({ ...l, manual: !l.manual }))}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, color: 'var(--wk-brand, #2b45e1)' }}>
                  {loc.manual ? 'Done' : 'Enter Manually'}
                </button>
              </div>
              <input id="project-address" className="form-input" value={form.address} readOnly={!loc.manual}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder={loc.manual ? 'e.g. 25260 N Centre City Pkwy, Escondido, CA 92026' : 'Filled in from the Google Maps link'}
                style={loc.manual ? undefined : { background: 'var(--mist)' }} />
              <div data-project-place="" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.45, color: hasPoint ? 'hsl(var(--color-green))' : 'var(--text-secondary)' }}>
                {status}
                {hasPoint && (
                  <> <a href={/^https?:/i.test(loc.link) ? loc.link : googleMapsUrl(loc.lat, loc.lng)} target="_blank" rel="noreferrer"
                    style={{ color: 'var(--wk-brand, #2b45e1)', fontWeight: 600, whiteSpace: 'nowrap' }}>Open in Google Maps <ExternalLink size={10} /></a></>
                )}
              </div>
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
              <label className="form-label" style={{ marginTop: 14 }} htmlFor="new-job-property">Property</label>
              <select id="new-job-property" className="form-input" value={propertyId} disabled={properties === null}
                onChange={(e) => setPropertyId(e.target.value)} style={{ width: '100%' }}>
                <option value="">{properties === null ? 'Loading…' : 'No Property'}</option>
                {(properties || []).map((o) => (
                  <option key={o.id} value={o.id}>{o.parentName ? `${o.parentName} - ${o.name}` : o.name}{[o.city, o.state].filter(Boolean).length ? ` (${[o.city, o.state].filter(Boolean).join(', ')})` : ''}</option>
                ))}
              </select>
              <label className="form-label" style={{ marginTop: 14 }} htmlFor="new-job-template">Schedule Template</label>
              <select id="new-job-template" className="form-input" value={templateId}
                onChange={(e) => setTemplateId(e.target.value)} style={{ width: '100%' }}>
                <option value="">{jobType === 'work_order' ? 'Work Order (the default)' : 'Construction Project (the default)'}</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <label className="form-label" style={{ marginTop: 14 }}>Crew</label>
              <div data-new-project="crew">
                <PersonMultiSelect value={crew} people={people} onChange={setCrew} placeholder="Who files daily logs" addTitle="Add crew" />
              </div>
              <label className="form-label" style={{ marginTop: 14 }}>Managers</label>
              <div data-new-project="managers">
                <PersonMultiSelect value={managers} people={people} onChange={setManagers} placeholder="Who reviews the logs" addTitle="Add managers" />
              </div>
            </div>
            {/* Right: the map, satellite by default, the pin draggable once placed. */}
            <div style={{ flex: '1 1 340px', minWidth: 280 }}>
              <WorkSiteAddressMap lat={loc.lat} lng={loc.lng} radiusM={GEOFENCE_M} showSearch={false} focus={focus}
                anchorLabel="the Google Maps point" adjustable={hasPoint}
                onAdjust={({ lat, lng }) => setLoc((l) => ({ ...l, lat: lat.toFixed(6), lng: lng.toFixed(6), adjusted: true }))} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
            <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-btn" disabled={!form.name.trim() || saving}>
              {saving ? 'Creating…' : 'Create Job'}
            </button>
          </div>
        </form>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} onSave={form.name.trim() ? guard.saveAndClose : undefined} saving={saving} />
      )}
    </div>
  );
}

// ── One project card ────────────────────────────────────────────────────────
function ProjectCard({ p, onOpen, overBudget = false }) {
  return (
    <div role="button" tabIndex={0} data-project-card={p.id}
      onClick={() => onOpen(p.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(p.id); } }}
      style={{ ...ROW, cursor: 'pointer', transition: 'border-color .13s' }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-color)'; }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
            <Folder size={18} style={{ color: 'var(--text-secondary)', flexShrink: 0, marginTop: 3 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px 8px', minWidth: 0, flexWrap: 'wrap' }}>
              {/* The name wraps rather than cuts off - on a phone it is the whole point of the card. */}
              <strong style={{ fontSize: '1.05rem', fontFamily: "'Plus Jakarta Sans', sans-serif", overflowWrap: 'anywhere', minWidth: 0 }}>{p.name}</strong>
              {p.jobType === 'work_order' && <StatusLabel size="sm" label={JOB_TYPE.work_order.label} color={JOB_TYPE.work_order.color} />}
              {p.phase && <StatusLabel size="sm" label={p.phase} color={TONE.slate} />}
              <StatusChip project={p} />
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: '0.8rem', color: 'var(--text-secondary)', alignItems: 'center' }}>
            {p.address && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}><MapPin size={13} style={{ flexShrink: 0 }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.address}</span></span>}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Users size={13} />{(p.workerEmails || []).length} crew
            </span>
            {p.targetFinishOn && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Calendar size={13} />Target {formatDate(p.targetFinishOn, p.targetFinishOn)}</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <strong style={{ fontSize: '1.15rem' }}>{pct(p)}%</strong>
          <ChevronRight size={18} style={{ color: 'var(--text-secondary)' }} />
        </div>
      </div>
      <Progress project={p} />
      <HealthRow health={p.health} compact overBudget={overBudget} targetMoves={p.targetMoves} />
    </div>
  );
}

// ── Dashboard ───────────────────────────────────────────────────────────────
export default function ConstructionDashboard({ projectId = '', jobTab = 'overview', onOpenProject }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [localId, setLocalId] = useState('');
  const [localTab, setLocalTab] = useState('overview');
  const [single, setSingle] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const { can } = useRole();
  const canReview = !!can?.('manager');
  const isMobile = useIsMobile();
  // Cards or the Program table (Round Two, 11/05/2026) - a computer's choice,
  // kept per person; phones keep the cards.
  const [jobsView, setJobsView] = useTableValue('construction-program', 'view', 'Cards');
  const asTable = !isMobile && jobsView === 'Table';
  // The open project is the URL's (Operations passes it); without a router
  // above (a test, an embed) it is kept here.
  const openId = onOpenProject ? projectId : localId;
  const tab = onOpenProject ? jobTab : localTab;
  const open = (id, t) => {
    if (onOpenProject) return t ? onOpenProject(id, t) : onOpenProject(id);
    setLocalId(id || ''); setLocalTab(t || 'overview');
    return undefined;
  };

  const load = useCallback(() => {
    setError('');
    // Through the phone (field offline, 11/03/2026): with no signal the jobs
    // open from what this phone saved.
    readThrough('construction:overview', () => api.getConstructionOverview())
      .then(setData)
      .catch((e) => { setData({ projects: [] }); setError(e.message || 'Could not load construction data.'); });
  }, []);

  useEffect(load, [load]);

  // Over Budget on the cards (plan phase 4): managers with Accounting access
  // only - the server answers {} for anyone else, and a failed read shows no flag.
  const [moneyFlags, setMoneyFlags] = useState({});
  useEffect(() => {
    if (!canReview) return undefined;
    let live = true;
    Promise.resolve().then(() => api.getJobMoneyFlags?.())
      .then((r) => { if (live) setMoneyFlags(r?.flags || {}); })
      .catch(() => { if (live) setMoneyFlags({}); });
    return () => { live = false; };
  }, [canReview, data]);

  // A project URL may name one the list does not carry (complete, archived,
  // or not loaded yet): read it on its own.
  const loadSingle = useCallback(() => {
    if (!openId) { setSingle(null); return; }
    readThrough(`construction:project:${openId}`, () => api.getConstructionProject(openId))
      .then((p) => setSingle(p || null))
      .catch((e) => { setSingle({ error: e.message || 'Could not open this project.' }); });
  }, [openId]);
  useEffect(loadSingle, [loadSingle]);

  const projects = data?.projects || [];
  if (openId) {
    const fromList = projects.find((p) => p.id === openId);
    const project = (single && !single.error && single.id === openId) ? single : fromList;
    if (project) {
      return (
        <Suspense fallback={<SkeletonBlocks count={3} height={110} borderRadius={8} />}>
          <JobPage project={project} tab={tab} onTab={(t) => open(project.id, t)}
            onBack={() => { open(''); load(); }} onChanged={() => { load(); loadSingle(); }} />
        </Suspense>
      );
    }
    if (single?.error) {
      return (
        <div>
          <ErrorBanner message={single.error} onRetry={loadSingle} />
          <button className="secondary-btn" onClick={() => open('')}><ArrowLeft size={14} />Back to Construction</button>
        </div>
      );
    }
    return <SkeletonBlocks count={3} height={110} borderRadius={8} />;
  }

  const tags = data?.tagCounts || null;
  const flagged = tags ? Object.values(tags).reduce((a, b) => a + b, 0) : null;
  const flagHelper = tags ? Object.entries(tags).filter(([, n]) => n).map(([k, n]) => `${n} ${tagLabel(k)}`).join(' · ') || 'Nothing flagged' : '';

  const list = (
    <div style={CARD} key="list">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Jobs</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>
            {asTable ? 'Every job on one table: health, dates, money and cost per square foot, compared. Open a row for the job.' : 'Late and at-risk jobs first. Open one for its schedule, punch list, crew and weather.'}
          </p>
        </div>
        {!isMobile && projects.length > 0 && (
          <ChoicePills label="Jobs view" options={['Cards', 'Table']} value={jobsView === 'Table' ? 'Table' : 'Cards'} onChange={setJobsView} />
        )}
      </div>
      {data === null ? (
        <SkeletonBlocks count={3} height={110} borderRadius={8} />
      ) : asTable && projects.length > 0 ? (
        <ProgramTable projects={projects} flags={moneyFlags} onOpen={open} />
      ) : projects.length === 0 ? (
        <Empty
          icon={Folder}
          title="No jobs yet"
          hint="Create a job - a work order or a project - to schedule the crew and collect daily logs from the field."
          action={<button className="primary-btn" onClick={() => setShowNew(true)}><Plus size={16} />New Job</button>}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {projects.map((p) => <ProjectCard key={p.id} p={p} onOpen={open} overBudget={!!moneyFlags[p.id]?.overBudget} />)}
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* No page title (Neil, 11/06/2026): the module bar names the tab; New Job rides its right end. */}
      <ModuleActions>
        <button className="primary-btn" onClick={() => setShowNew(true)}><Plus size={16} />New Job</button>
      </ModuleActions>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {/* Phones: the jobs first - the reason anyone opens this on site. */}
      {isMobile && list}

      {/* A log bounced back with a question is the one thing here that is
          waiting on the reader personally. Renders nothing when nothing is. */}
      <ConstructionInbox />

      {!isMobile && list}

      <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 24 }}>
        <Stat label="Active Sites"     value={data ? data.activeSites : '-'} />
        <Stat label="Crew on Projects" value={data ? data.totalWorkforce : '-'} />
        <Stat label="Flagged by Crew"  value={flagged == null ? '-' : flagged} helper={flagHelper ? `${flagHelper} (7 days)` : ''} />
        <Stat label="Pending Review"   value={data ? data.pendingReview : '-'} helper="logs waiting on a reviewer" />
      </div>

      {canReview && <ReviewQueue />}

      {/* Project-based weather (Neil, 10/30/2026): today at every active
          jobsite, with the first wet hour and a red flag when the work is at
          risk. A tile opens its project. */}
      <SiteWeatherStrip onOpen={open} />

      {showNew && (
        <NewProjectModal
          onClose={() => setShowNew(false)}
          onCreated={(p) => { setShowNew(false); load(); open(p.id); }}
        />
      )}
    </>
  );
}
