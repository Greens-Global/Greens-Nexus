// The Job page (Neil, 11/03/2026, plan https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr,
// phase 2 "The Job, Connected"). One record - a Work Order or a Project -
// and the place people look; the work itself stays in the module that owns
// it (Tasks holds the schedule and the punch list, Tickets the request,
// Shifts and the Time Clock the crew and hours, Forms the inspections, Items
// the equipment, Asset Management the property). Size decides what shows: a
// Work Order has Overview, Tasks, Field and Closeout; a Project every tab.
// The tab is in the URL (/construction/project:<id>:<tab>) so Back works and
// an Approvals row lands on RFIs And Submittals. Lazy: its own chunk, and the
// Schedule tab (the Tasks timeline) a chunk of its own beyond that.
import { lazy, Suspense, useEffect, useState } from 'react';
import { ArrowLeft, Pencil, Flag, ClipboardList, CheckSquare, Users, Ticket, Building2, Inbox, ExternalLink } from 'lucide-react';
import { api } from '../../api';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import ProgressTrack from '../../ui/ProgressTrack';
import ViewErrorBoundary from '../../components/ViewErrorBoundary';
import { openNotificationTarget } from '../../lib/openTarget';
import { formatDate } from '../../lib/datetime';
import { CARD, LOG_STATUS, PROJECT_STATUS, personName } from '../ui';
import HealthRow from '../HealthRow';
import EditJobSheet from '../EditJobSheet';
import Registers from '../Registers';
import { SiteWeatherCard } from '../SiteWeather';
import { daysWords, trackStateFor } from '../lib/health';
import { JOB_TYPE, PUNCH_STATE, jobTabs, tabFor, useLoad } from '../lib/job';
import PunchTab from './PunchTab';
import FieldTab from './FieldTab';
import MoneyLine from './MoneyLine';
import { useJobMoney } from '../lib/money';
import { prefetchJob } from '../constructionOffline';
import PageTrail, { useTrailCrumbs } from '../../components/PageTrail';

const ScheduleTab = lazy(() => import('./ScheduleTab'));
// Field and Closeout (11/03/2026, phase 3): each its own chunk, beyond the
// Job page's - a manager opening Overview never downloads the field tickets.
const PhotosTab = lazy(() => import('./PhotosTab'));
const ChangesTab = lazy(() => import('./ChangesTab'));
const CloseoutTab = lazy(() => import('./CloseoutTab'));
// Money (phase 4): its own chunk with the Accounting side panel.
const MoneyTab = lazy(() => import('./MoneyTab'));
const tabWait = <SkeletonBlocks count={3} height={120} borderRadius={12} />;

const go = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub } }));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const head = { display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.92rem', fontWeight: 700, color: 'var(--text-primary)' };
const quiet = { fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.5 };
const linkBtn = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.8rem',
  fontWeight: 600, color: 'var(--wk-brand, #2b45e1)', display: 'inline-flex', alignItems: 'center', gap: 4,
};

function Card({ icon: Icon, title, count, children, testId }) {
  return (
    <section data-job-card={testId} aria-label={title} style={{
      background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12,
      boxShadow: 'var(--shadow-sm)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0,
    }}>
      <div style={head}>
        <Icon size={16} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
        <span>{title}</span>
        {count != null && <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{count}</span>}
      </div>
      {children}
    </section>
  );
}

function Line({ left, right, onClick }) {
  const body = (
    <>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{left}</span>
      {right != null && <span style={{ flexShrink: 0, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{right}</span>}
    </>
  );
  const style = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: '0.85rem', padding: '4px 0', color: 'var(--text-primary)' };
  return onClick
    ? <button type="button" onClick={onClick} style={{ ...style, width: '100%', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>{body}</button>
    : <div style={style}>{body}</div>;
}

// ── Overview ────────────────────────────────────────────────────────────────
function Overview({ project, onTab, money }) {
  const { data, error, reload } = useLoad(() => api.getJobConnected(project.id), project.id);
  const isProject = project.jobType !== 'work_order';
  const names = { ...(project.names || {}), ...(data?.names || {}) };
  const pct = Math.round(project.percentComplete || 0);
  const needs = data?.needsYou || {};
  const needRows = [
    ['logsToReview', 'daily log', 'to review', () => go('ops', `activity:${project.id}`)],
    ['rfisToAnswer', 'RFI', 'to answer', () => onTab('rfis')],
    ['submittalsToDecide', 'submittal', 'to decide', () => onTab('rfis')],
    ['myPunch', 'punch item', 'assigned to you', () => onTab('punch')],
  ].filter(([k]) => needs[k] > 0);
  const team = [['Crew', project.workerEmails], ['Managers', project.managerEmails], ['Executives', project.executiveEmails]];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ ...CARD, marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <HealthRow health={project.health} />
        <ProgressTrack value={pct / 100} state={trackStateFor(project)} label={`${project.name} progress`}
          start={project.startOn ? `Started ${formatDate(project.startOn, project.startOn)}` : undefined}
          end={project.targetFinishOn ? `Target ${formatDate(project.targetFinishOn, project.targetFinishOn)}` : undefined}
          note={<><b>{pct}% complete</b>{project.phase ? ` - ${project.phase}` : ''}</>} />
        <MoneyLine money={money} onOpen={() => onTab('money')} />
      </div>
      {error && <ErrorBanner message={error} onRetry={reload} />}
      {!data && !error ? <SkeletonBlocks count={3} height={120} borderRadius={12} /> : data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
          <Card icon={Inbox} title="Needs You" testId="needs">
            {needRows.length === 0 ? <div style={quiet}>Nothing on this job is waiting on you.</div>
              : needRows.map(([k, w, tail, onClick]) => (
                <Line key={k} left={<b>{plural(needs[k], w)} {tail}</b>} right="Open" onClick={onClick} />
              ))}
          </Card>
          {isProject && (
            <Card icon={Flag} title="Next Milestones" testId="milestones">
              {(data.nextMilestones || []).length === 0
                ? <div style={quiet}>No milestones ahead. They live on the job's schedule.</div>
                : data.nextMilestones.map((m) => (
                  <Line key={m.id} left={m.title}
                    right={m.dueOn ? `${formatDate(m.dueOn, m.dueOn)} (${daysWords(dayGap(project.today, m.dueOn))})` : ''} />
                ))}
              <div><button type="button" style={linkBtn} onClick={() => onTab('schedule')}>Open Schedule</button></div>
            </Card>
          )}
          <Card icon={CheckSquare} title="Punch List" testId="punch">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {['open', 'done', 'verified'].map((k) => (
                <StatusLabel key={k} size="sm" label={`${data.punch?.[k] || 0} ${PUNCH_STATE[k].label}`} color={PUNCH_STATE[k].color} />
              ))}
            </div>
            <div><button type="button" style={linkBtn} onClick={() => onTab('punch')}>{isProject ? 'Open Punch List' : 'Open Tasks'}</button></div>
          </Card>
          <Card icon={ClipboardList} title="Last Daily Log" testId="log">
            {data.lastLog ? (
              <>
                <Line left={<>{formatDate(data.lastLog.logDate, data.lastLog.logDate)}{data.lastLog.authorName ? ` - ${data.lastLog.authorName}` : ''}</>}
                  right={<StatusLabel size="sm" label={(LOG_STATUS[data.lastLog.status] || LOG_STATUS.submitted).label} color={(LOG_STATUS[data.lastLog.status] || LOG_STATUS.submitted).color} />} />
                {(data.lastLog.crewSize > 0 || data.lastLog.hoursWorked > 0) && (
                  <div style={quiet}>{[data.lastLog.crewSize ? `${data.lastLog.crewSize} ${data.lastLog.crewSize === 1 ? 'person' : 'people'}` : '', data.lastLog.hoursWorked ? `${data.lastLog.hoursWorked} h` : ''].filter(Boolean).join(' · ')}</div>
                )}
              </>
            ) : <div style={quiet}>No daily log filed yet.</div>}
            <div><button type="button" style={linkBtn} onClick={() => go('ops', `activity:${project.id}`)}>Open Site Activity</button></div>
          </Card>
          <Card icon={Users} title="This Week's Crew" count={(data.crew?.people || []).length || null} testId="crew">
            {(data.crew?.people || []).length === 0
              ? <div style={quiet}>No one is scheduled on this jobsite this week. Place the crew here in Shifts.</div>
              : data.crew.people.slice(0, 8).map((c) => (
                <Line key={c.email} left={c.name || personName(c.email, names)}
                  right={`${plural(c.days.length, 'day')} · ${c.plannedHours} h`} />
              ))}
          </Card>
          {(data.tickets || []).length > 0 && (
            <Card icon={Ticket} title={data.tickets.length > 1 ? 'Source Tickets' : 'Source Ticket'} testId="tickets">
              {data.tickets.map((t) => (
                <Line key={t.id} left={<>{t.code ? `${t.code} · ` : ''}{t.subject}</>}
                  right="Open Ticket" onClick={() => { go('tickets'); openNotificationTarget({ ticketId: t.id }); }} />
              ))}
              {data.tickets[0].requesterEmail && (
                <div style={quiet}>Requested by {personName(data.tickets[0].requesterEmail, names)}</div>
              )}
            </Card>
          )}
          <Card icon={Building2} title="Property" testId="property">
            {data.property ? (
              <>
                <Line left={<b>{data.property.name}</b>} />
                {(data.property.address || data.property.city) && (
                  <div style={quiet}>{[data.property.address, [data.property.city, data.property.state].filter(Boolean).join(', ')].filter(Boolean).join(' - ')}</div>
                )}
                <div>
                  <button type="button" style={linkBtn}
                    onClick={() => go('property-asset', `a:${encodeURIComponent(data.property.id)}:property`)}>
                    Open in Asset Management <ExternalLink size={11} />
                  </button>
                </div>
              </>
            ) : <div style={quiet}>{project.propertyId ? 'A property you cannot open.' : 'Not linked to a property. Edit Job to link one.'}</div>}
          </Card>
          <Card icon={Users} title="Team" testId="team">
            {team.map(([label, list]) => (
              <div key={label} style={{ fontSize: '0.84rem' }}>
                <span style={{ fontWeight: 600, color: 'var(--text-secondary)', marginRight: 6 }}>{label}</span>
                {(list || []).length ? list.map((e) => personName(e, names)).join(', ')
                  : <span style={{ color: 'var(--text-secondary)' }}>{label === 'Managers' ? "None named - the company's managers review" : 'None yet'}</span>}
              </div>
            ))}
          </Card>
        </div>
      )}
      <SiteWeatherCard project={project} />
    </div>
  );
}

function dayGap(fromISO, toISO) {
  const a = Date.parse(`${String(fromISO || '').slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toISO || '').slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.round((b - a) / 86400000);
}

// ── The page ────────────────────────────────────────────────────────────────
export default function JobPage({ project, tab = 'overview', onTab, onBack, onChanged }) {
  const [editing, setEditing] = useState(false);
  // Money shows only when the server says this caller may see it; a link
  // straight to the tab waits for that answer instead of falling to Overview.
  const money = useJobMoney(project);
  const moneyOn = !!money.data?.allowed || (tab === 'money' && !money.data && !money.error);
  const tabs = jobTabs(project.jobType, { money: moneyOn });
  const active = tabFor(project.jobType, tab, { money: moneyOn });
  const type = JOB_TYPE[project.jobType] || JOB_TYPE.project;
  const status = PROJECT_STATUS[project.status];
  // Keep what the field needs on the phone while there is signal (the punch
  // list, today's log prefill, the photos, the changes) - offline tomorrow.
  useEffect(() => { prefetchJob(project); }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // CONSTRUCTION / PROJECT DASHBOARD over the job's name (the page trail).
  useTrailCrumbs([{ label: 'Project Dashboard', onClick: onBack }]);

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }} data-job-page={project.id}>
      <div className="view-header" style={{ marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: '1 1 320px' }}>
          <button className="secondary-btn" onClick={onBack} style={{ padding: 8 }} title="Back to Construction" aria-label="Back to Construction">
            <ArrowLeft size={16} />
          </button>
          <div className="view-title-group" style={{ minWidth: 0 }}>
            <PageTrail title={project.name} />
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ overflowWrap: 'anywhere' }}>{project.name}</span>
              <StatusLabel size="sm" label={type.label} color={type.color} />
              {status && project.status !== 'active' && <StatusLabel size="sm" label={status.label} color={status.color} />}
            </h2>
            <p style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {project.address || 'No address'}{project.phase ? ` · ${project.phase}` : ''}
            </p>
          </div>
        </div>
        {project.canEdit && (
          <button className="secondary-btn" onClick={() => setEditing(true)}><Pencil size={14} />Edit Job</button>
        )}
      </div>

      <div className="scroll-tabs" role="tablist" aria-label="Job sections"
        style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border-color)', marginBottom: 16 }}>
        {tabs.map((t) => {
          const on = t.key === active;
          return (
            <button key={t.key} type="button" role="tab" aria-selected={on} data-job-tab={t.key}
              onClick={() => onTab(t.key)}
              style={{
                background: 'none', border: 'none', borderBottom: `2.5px solid ${on ? 'var(--wk-brand, #2b45e1)' : 'transparent'}`,
                padding: '10px 12px', fontFamily: 'inherit', fontSize: '0.88rem', fontWeight: 600, whiteSpace: 'nowrap',
                color: on ? 'var(--text-primary)' : 'var(--text-secondary)', cursor: 'pointer', marginBottom: -1,
              }}>
              {t.label}
            </button>
          );
        })}
      </div>

      <ViewErrorBoundary resetKey={`${project.id}:${active}`}>
        {active === 'overview' && <Overview project={project} onTab={onTab} money={money} />}
        {active === 'schedule' && (
          <Suspense fallback={<SkeletonBlocks count={3} height={120} borderRadius={12} />}>
            <ScheduleTab project={project} onChanged={onChanged} />
          </Suspense>
        )}
        {active === 'punch' && <PunchTab project={project} />}
        {active === 'photos' && <Suspense fallback={tabWait}><PhotosTab project={project} /></Suspense>}
        {active === 'changes' && <Suspense fallback={tabWait}><ChangesTab project={project} /></Suspense>}
        {active === 'field' && <FieldTab project={project} />}
        {active === 'rfis' && (
          <Registers project={project} canReview={!!project.canEdit} onChanged={onChanged}
            kinds={['rfis', 'submittals']} title="RFIs And Submittals" />
        )}
        {active === 'money' && (
          <Suspense fallback={tabWait}>
            <MoneyTab project={project} money={money} onEdit={project.canEdit ? () => setEditing(true) : null} />
          </Suspense>
        )}
        {active === 'closeout' && <Suspense fallback={tabWait}><CloseoutTab project={project} onChanged={onChanged} /></Suspense>}
      </ViewErrorBoundary>

      {editing && (
        <EditJobSheet project={project} money={money} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); money.reload(); onChanged?.(); }} />
      )}
    </div>
  );
}

