/* eslint-disable react-hooks/refs -- the org-chart canvas reads container/zoom refs during render for pan-zoom fit-to-view; safe intentional reads the React-Compiler rule flags */
import { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react';
import { InterviewPanel, LeaderboardModal } from '../components/Interviews';
import { SendHiringPacketModal, PacketSigner, PersonLifeEvents, PaperworkStatus, usDay } from '../components/HiringPacket';
import PacketReview from '../components/PacketReview';
import SendFederalFormMenu from '../components/SendFederalFormMenu';
import OfferModal from '../components/OfferModal';
import { PromoteModal, OffboardModal, RoleChangeModal } from '../components/HrPersonActions';
import { ProbationBadge } from '../components/HrProbation';
import { StatusLabel } from '../components/StatusLabel';
import PersonActions from '../components/PersonActions';
import MailboxExportResult from '../components/MailboxExportResult';
import { RoleChangeRequestCard, RoleChangeDecisionModal } from '../components/RoleChangeRequests';
import CandidateDetailModal, { STAGES, STAGE_META, candName } from '../components/HiringCandidateDetail';
import { ScheduleInterviewModal } from '../components/HiringSchedule';
import CandidateFormModal from '../components/HiringCandidateForm';
import {
  Users, Plus, Search, X, Mail, Briefcase, Check, TrendingUp, LogOut,
  ChevronLeft, Network, UserPlus, Pencil, FileText,
  CheckCircle, ChevronRight, History, CalendarDays, Camera,
  Building2, Trash2, Lock,
  Shield, AlertTriangle, Clock, RotateCcw,
  ChevronDown, ChevronUp, Link2, ExternalLink,
  ListChecks, RefreshCw, Hourglass, BarChart3,
  Target,
} from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime, formatWeekday } from '../lib/datetime';
import { formatDistance, metersToFeet, feetToMeters } from '../lib/distance';
import { dialog } from '../ui/dialog';
import { HOLD_MAJOR_MS } from '../ui/HoldButton';
import { usePeopleDirectory, usePeopleDirectoryWithExternal } from '../lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../lib/queryClient';
import { SkeletonBlocks, ErrorBanner, Spinner, LoadingState, ModalLoading, CountSkeleton } from '../components/AsyncState';
import { useRole, MODULES, MODULE_LEVELS } from '../contexts/RoleContext';
import { Switch } from '../components/settings/SettingsUI';
import { setPendingOpen } from '../lib/pendingOpen';
import TimeAdmin from '../components/TimeAdmin';
import ModuleTabs, { ModuleActions } from '../components/ModuleTabs';
import PhotoEditorModal from '../components/PhotoEditorModal';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../components/UnsavedChangesPrompt';
// External tab folded into People (Neil, Aug 24: one master list) - only the
// shared pieces remain in use: badge, invite toast, lifecycle section.
import { ExternalBadge, inviteOutcomeToast } from './ExternalUsersPanel';
import TierMark from '../components/TierMark';
import PersonHover from '../components/PersonHoverCard';
import EgnytePersonFolder from '../egnyte/EgnytePersonFolder';
import InvestorChart from '../components/InvestorChart';
import OrgChartCanvas, { ReportsPill } from '../components/orgchart/OrgChartCanvas';
import { divisionColor as divColorFor, countBelow } from '../components/orgchart/tree';
import { takePendingPerson } from '../lib/personNav';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { TaskChecklist, punchTime } from '../components/WorkLogDrawer';
import { COUNTRIES } from '../lib/countries';
import WorkSiteAddressMap from '../components/WorkSiteAddressMap';
import WorkSiteLinkPanel from '../components/WorkSiteLinkPanel';
import { googleMapsUrl } from '../lib/addressSearch';
import WorkSiteFenceCheck from '../components/WorkSiteFenceCheck';
import AnchoredMenu from '../components/AnchoredMenu';
import PersonSearchSelect from '../components/PersonSearchSelect';
import { PersonSelect, Avatar as EmailAvatar, Modal, DateField, ChipMultiSelect } from '../tasks/components';
import StatusChangeSheet from '../people/StatusChangeSheet';
import AddPersonSheet from '../people/AddPersonSheet';
import AccessTab from '../people/AccessTab';
import { US_STATE_NAMES } from '../lib/usStates';
import { ChecklistSection, ChecklistSettings, ChecklistBoard, ChecklistChip } from '../components/HrChecklists';
import RecordsAudit from '../components/RecordsAudit';
import { useActionCounts, withBadges } from '../lib/useActionCounts';
import { PersonReimbursements } from '../components/Reimbursements';
import { formatFieldValue, matchesFieldFilter } from '../lib/employeeCustomFields';
import { LetterRequestsPanel } from '../components/HrLetters';
// The person record's tabs (Neil, 11/03/2026) - each edited in place.
import OverviewTab from '../people/OverviewTab';
import JobTab from '../people/JobTab';
import TimeTab from '../people/TimeTab';
import PayTab from '../people/PayTab';
import ComplianceTab from '../people/ComplianceTab';
import { guardRecordLeave } from '../people/useTabDraft';
import { daysUntil, INACTIVE_STATUSES, peopleTallies } from '../people/lib';
// Workforce Analytics Policy tab (Sep 19) - lazy so TimeTrackingAdmin's chunk
// only loads once an admin actually opens a company's policy tab.
const MonitoringPolicy = lazy(() => import('../components/TimeTrackingAdmin').then(m => ({ default: m.MonitoringPolicy })));
// A company's Roles tab (Company Settings) - lazy for the same reason.
const CompanyRoles = lazy(() => import('./CompanyRoles'));
// A company's Holiday Calendar (holiday policies, Oct 29 2026) - its own chunk.
const CompanyHolidayCalendar = lazy(() => import('../holidays/CompanyHolidayCalendar'));
// Sync Employee Codes From Intacct (Charmi, Oct 21 2026) - HR only, lazy.
const IntacctEmployeeCodes = lazy(() => import('../components/IntacctEmployeeCodes'));
// Hiring > Openings and Headcount (Neil, Oct 27 2026) - lazy, own chunks.
const JobOpenings = lazy(() => import('../components/hiring/JobOpenings'));
const HeadcountRequests = lazy(() => import('../components/hiring/HeadcountRequests'));
// Performance (Oct 27 2026): HR's review cycles and company goals - lazy.
const PerformanceAdmin = lazy(() => import('../performance/PerformanceAdmin'));
// A person's Performance on their profile (Oct 29 2026) lives on Overview (people/OverviewTab.jsx).
// People Analytics and Exits (Oct 27 2026) load with their tab - their own chunks.
const HrAnalytics = lazy(() => import('../components/HrAnalytics'));
const ExitsTab = lazy(() => import('../components/ExitsTab'));
// People > Reports (Neil, Teams 11/02/2026): Company Directory, Employees,
// Contractors - filterable and exportable, over the rows People already holds.
const PeopleReports = lazy(() => import('../components/PeopleReports'));

// ── HR module - Phase 1: employee master + People directory ──────────────────
// Hiring pipeline, org chart and leave land in later phases (tabs are stubs).
// Old hardcoded onboarding/disclosure screens were dummy data - removed.

const EMP_TYPES = [
  ['full_time', 'Full-Time'], ['part_time', 'Part-Time'], ['contractor', 'Contractor'], ['intern', 'Intern'],
];
const TYPE_LABEL = Object.fromEntries(EMP_TYPES);

const STATUS_META = {
  onboarding: { label: 'Onboarding', bg: 'hsla(var(--color-blue),0.1)',    fg: 'hsl(var(--color-blue))' },
  active:     { label: 'Active',     bg: 'hsla(var(--color-green),0.1)',   fg: 'hsl(var(--color-green))' },
  inactive:   { label: 'Inactive',   bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))' },
  offboarded: { label: 'Left',       bg: 'var(--mist)',                    fg: 'var(--muted)' },
};

// INACTIVE_STATUSES (the Inactive tab's statuses) and peopleTallies (every
// people count on this screen) live in people/lib.js.
// Guest (Microsoft 365 guest) and external (no M365 login) rows - one
// predicate for the whole screen.
const isExternalPerson = (e) => ['guest', 'external'].includes(e?.identityType || 'internal');

// The status dropdown's "Deleted" entry. Deliberately NOT a STATUS_META member:
// removal is orthogonal to employment status (a removed person keeps whatever
// status they had, so it can be restored unchanged), and it selects a different
// LIST rather than filtering the current one. The sentinel cannot collide with a
// real status value.
const DELETED_F = '__deleted__';
// "Probation Ending" (Oct 27 2026): people whose probation ends inside the
// company's reminder window, or has passed undecided - a lens, not a status.
const PROBATION_F = '__probation__';
// Probation lenses by status (Neil, Oct 29 2026): On Probation is the open
// ones only; Passed / Past (never tracked, past the window, derived) /
// Removed From Probation. Sentinels like the ones above.
const PROBATION_LENSES = [
  ['__probation:open__', 'On Probation', (p) => ['in_probation', 'extended'].includes(p?.status)],
  ['__probation:passed__', 'Passed Probation', (p) => p?.status === 'passed'],
  ['__probation:past__', 'Past Probation', (p) => p?.status === 'past'],
  ['__probation:removed__', 'Removed From Probation', (p) => p?.status === 'removed'],
];
const PROBATION_LENS = Object.fromEntries(PROBATION_LENSES.map(([v, , test]) => [v, test]));

const FL = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6, letterSpacing: '.04em' };

const AVATAR_HUES = ['215,75%,45%', '142,60%,35%', '30,80%,48%', '271,60%,48%', '350,65%,48%'];
const fullName = e => [e.firstName, e.lastName].filter(Boolean).join(' ');
// Rows for the Tasks people picker (PersonSelect) from employee records: name
// and photo, keyed by the lowercased work email - for a field that saves the
// email.
const pickRows = (list) => {
  const seen = new Set();
  return list.filter(e => {
    const em = (e.workEmail || '').toLowerCase();
    if (!em || seen.has(em)) return false;
    seen.add(em);
    return true;
  }).map(e => ({ email: e.workEmail.toLowerCase(), name: fullName(e), external: isExternalPerson(e) }));
};
// Directory rows ({ email, name }) for the same picker.
const dirPickRows = (list) => list.filter(p => p.email).map(p => ({ email: p.email.toLowerCase(), name: p.name || p.email, external: !!p.external }));
// A picker trigger the height and shape of the form's other boxes.
const PICK_BOX = { height: 38, padding: '0 13px', borderRadius: 10, fontSize: 13.5, fontWeight: 400 };
const initials = e => `${(e.firstName || '?')[0]}${(e.lastName || '')[0] || ''}`.toUpperCase();
const hueFor = e => AVATAR_HUES[(e.employeeCode || e.id || '').split('').reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_HUES.length];

// `card={false}` for avatars already inside a clickable row (the People table,
// org-chart nodes) - those rows select the person themselves, so a nested click
// target and a floating card would fight the row.
function Avatar({ e, size = 38, card = true }) {
  const img = e.photoUrl
    ? <img src={e.photoUrl} alt="" style={{ width: size, height: size, borderRadius: size * 0.28, objectFit: 'cover', flexShrink: 0 }} />
    : (
      <div style={{ width: size, height: size, borderRadius: size * 0.28, background: `hsla(${hueFor(e)},0.13)`, color: `hsl(${hueFor(e)})`, fontSize: size * 0.34, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {initials(e)}
      </div>
    );
  return <PersonHover email={e.workEmail} name={fullName(e)} disabled={!card}>{img}</PersonHover>;
}

// Same photo-or-initials pattern as Avatar, for a company row instead of a
// person - initials come from the company name's first letters (e.g. "Greens
// Global" -> "GG") rather than first/last name.
const companyInitials = name => (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const hueForString = s => AVATAR_HUES[(s || '').split('').reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_HUES.length];
function CompanyLogo({ name, logoUrl, size = 36 }) {
  return logoUrl
    ? <img src={logoUrl} alt="" style={{ width: size, height: size, borderRadius: size * 0.28, objectFit: 'contain', background: '#fff', border: '1px solid var(--line)', flexShrink: 0 }} />
    : (
      <div style={{ width: size, height: size, borderRadius: size * 0.28, background: `hsla(${hueForString(name)},0.13)`, color: `hsl(${hueForString(name)})`, fontSize: size * 0.34, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {companyInitials(name)}
      </div>
    );
}

function useIsMobile(bp = 900) {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(`(max-width: ${bp}px)`).matches);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp}px)`);
    const h = e => setMobile(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [bp]);
  return mobile;
}

// ── Documents (Phase 3) - private bucket, viewed via short-lived signed URLs ──
const DOC_KINDS = [['resume', 'Resume'], ['id', 'ID'], ['contract', 'Contract'], ['certificate', 'Certificate'], ['other', 'Other']];

// Live read of what a person holds in Item Management (Section B5). No data is
// stored here - Items stays the single source of truth; this deep-links into it.
function AssetsSection({ employee }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.getEmployeeAssets(employee.id).then(setData).catch(() => setData({ assignments: [], checkouts: [] })); }, [employee.id]);
  const goToItems = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'inventory', sub: 'active-checkouts' } }));
  const assignments = data?.assignments || [];
  const checkouts = data?.checkouts || [];
  const total = assignments.length + checkouts.length;

  const line = (icon, name, meta, key) => (
    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{meta}</div>
      </div>
    </div>
  );

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', flex: 1 }}>
          <Briefcase size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />Assets held {data && `· ${total}`}
        </span>
        <button className="secondary-btn" onClick={goToItems} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px' }}>
          Open in Item Management <ChevronRight size={12} />
        </button>
      </div>
      {!data ? (
        <SkeletonBlocks count={4} height={40} />
      ) : total === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>
          {employee.workEmail ? 'No assigned equipment or active checkouts.' : 'No work email yet - provision the account to link assets.'}
        </div>
      ) : (
        <div>
          {assignments.map(a => line(
            <Briefcase size={14} style={{ color: 'hsl(var(--color-green))', flexShrink: 0 }} />,
            a.name, [a.serial && `SN ${a.serial}`, a.type, 'permanent assignment'].filter(Boolean).join(' · '), `a-${a.id}`))}
          {checkouts.map(c => line(
            <History size={14} style={{ color: 'hsl(var(--color-orange))', flexShrink: 0 }} />,
            c.itemName, [c.itemType, c.status === 'pending_receipt' ? 'awaiting receipt' : 'checked out', c.days && `${c.days}d`].filter(Boolean).join(' · '), `c-${c.id}`))}
        </div>
      )}
    </div>
  );
}

// day.toISOString().slice(0,10) but in local time, not UTC - a UTC-based cut
// would flip to the wrong calendar day for anyone west of Greenwich.
function localIsoDate(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function lastWeekRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 6);
  return [localIsoDate(start), localIsoDate(end)];
}

// Read-only log of a person's Beginning/End-of-day posts (Section: Time Clock's
// BOD/EOD composer). Source of truth stays in timeclock.py's TimeBod table;
// this only reads, newest first, so a manager doesn't have to scroll Teams to
// see what someone said they'd do and what was left pending. Defaults to the
// trailing week; the date filter pages back through older history. BOD and
// EOD render together on the same card for each day.
export function WorkLogsSection({ employee }) {
  const [[start, end], setRange] = useState(lastWeekRange);
  const [logs, setLogs] = useState(null);
  const load = useCallback((quiet = false) => {
    if (!quiet) setLogs(null);
    api.getEmployeeBod(employee.id, start, end).then(r => setLogs(r.logs || []))
      .catch(() => { if (!quiet) setLogs([]); });   // a failed background poll keeps the last good data on screen
  }, [employee.id, start, end]);
  useEffect(() => { load(); }, [load]);
  // Live while viewing this range: a manager watching a report shouldn't have
  // to reopen the tab to see a punch that just landed. Quiet refresh (keeps
  // the current cards on screen) only while the range covers today, and only
  // while the tab is actually visible - same pattern as TimeClock's own poll.
  useEffect(() => {
    const today = localIsoDate(new Date());
    if (today < start || today > end) return undefined;
    return pollWhileVisible(() => load(true), 15000);
  }, [load, start, end]);

  // Group the flat, newest-first list into one card per WORKDAY (BOD + EOD together) -
  // an overnight shift's EOD and clock-out sit on the day the shift began.
  // EVERY message is kept (Oct 3): a day can hold two EODs - a re-sent one,
  // or an old row filed before the shift-day fix next to the right one - and
  // keeping only one silently hid the other (whichever came first won).
  // Oldest first inside a day, each with its send time when there are several.
  const byDate = [];
  for (const l of logs || []) {
    let group = byDate.find(g => g.date === l.date);
    if (!group) { group = { date: l.date, bod: [], eod: [] }; byDate.push(group); }
    group[l.kind].unshift(l);
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', flex: 1 }}>
          <Clock size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />Work logs (BOD/EOD)
        </span>
        <button className="secondary-btn" onClick={() => setRange(lastWeekRange())} style={{ fontSize: 11.5, padding: '4px 10px' }}>This week</button>
        <DateField value={start} onChange={v => v && setRange([v, end])} title="From" style={{ fontSize: 12, width: 140, height: 32, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 8 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>to</span>
        <DateField value={end} onChange={v => v && setRange([start, v])} title="To" style={{ fontSize: 12, width: 140, height: 32, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 8 }} />
      </div>
      {logs === null ? (
        <SkeletonBlocks count={3} height={54} />
      ) : byDate.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>
          {!employee.workEmail ? 'No work email yet - work logs key off it.' : 'No work logs posted in this date range.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {byDate.map(g => (
            <div key={g.date} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '11px 14px' }}>
              {/* The WORKDAY - the day the shift began (shift_day.py, Oct 2). */}
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)', marginBottom: 8 }}>{formatWeekday(`${g.date}T12:00:00`, 'short')}, {formatDate(`${g.date}T12:00:00`)}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                {[['Beginning of day', g.bod, 'bod', 'Punched in'], ['End of day', g.eod, 'eod', 'Punched out']].map(([label, posts, kind, punchLabel]) => {
                  const slot = posts.find(x => x.punchAt) || posts[0];
                  return (
                  <div key={label} style={{ background: 'var(--mist)', borderRadius: 10, padding: '9px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', flex: 1 }}>{label}</span>
                      {slot?.punchAt && (
                        <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--wk-brand, var(--ink))' }} title={`${punchLabel} at ${punchTime(slot.punchAt, slot.punchTz, g.date)}, on the employee's clock`}>
                          {punchLabel} {punchTime(slot.punchAt, slot.punchTz, g.date)}
                        </span>
                      )}
                    </div>
                    {posts.length ? posts.map((post, i) => (
                      <div key={post.id} style={i ? { marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--line)' } : undefined}>
                        {posts.length > 1 && (
                          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 3 }}>
                            Sent {punchTime(post.at, slot?.punchTz, g.date)}
                          </div>
                        )}
                        <div style={{ fontSize: 12.5, color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>{post.message || <span style={{ color: 'var(--muted)' }}>(no message)</span>}</div>
                        <TaskChecklist tasks={post.tasks} kind={kind} />
                      </div>
                    )) : (
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>-</span>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentsSection({ employeeId, employee, onSent, toastOk, toastErr }) {
  const [docs, setDocs] = useState(null);
  const [kind, setKind] = useState('other');
  const [uploading, setUploading] = useState(false);
  useEffect(() => { api.getEmployeeDocs(employeeId).then(setDocs).catch(() => setDocs([])); }, [employeeId]);

  async function upload(file) {
    if (!file || uploading) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('kind', kind);
      const doc = await api.uploadEmployeeDoc(employeeId, form);
      setDocs(prev => [doc, ...(prev || [])]);
      toastOk(`${file.name} uploaded.`);
    } catch (err) { toastErr(err?.message || 'Upload failed.'); }
    setUploading(false);
  }
  async function view(doc) {
    try { const { url } = await api.getDocUrl(doc.id); window.open(url, '_blank', 'noopener'); }
    catch (err) { toastErr(err?.message || 'Could not open document.'); }
  }
  async function remove(doc) {
    try { await api.deleteEmployeeDoc(doc.id); setDocs(prev => prev.filter(d => d.id !== doc.id)); toastOk('Document removed.'); }
    catch (err) { toastErr(err?.message || 'Could not delete.'); }
  }
  const fmtSize = b => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', flex: 1 }}>
          <FileText size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />Documents
        </span>
        {/* Federal forms (Neil, 11/02/2026): HR++ sends a W-4, I-9 or direct deposit form to this person. */}
        {employee && <SendFederalFormMenu employee={employee} toastOk={toastOk} toastErr={toastErr} onSent={onSent} />}
        <select className="form-input" value={kind} onChange={e => setKind(e.target.value)} style={{ padding: '3px 8px', fontSize: 11.5, height: 28 }}>
          {DOC_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <label className="secondary-btn" style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', padding: '5px 12px' }}>
          {uploading ? <Spinner size={12} /> : <Plus size={12} />} Upload
          <input type="file" hidden onChange={e => { upload(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>
      {docs === null ? <Spinner size={15} />
        : docs.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No documents yet.</div>
        : docs.map(d => (
          <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 0', borderBottom: '1px solid var(--line)', fontSize: 12.5 }}>
            <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.05em', background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 7px', color: 'var(--muted)', textTransform: 'uppercase', flexShrink: 0 }}>
              {d.kind}
            </span>
            <button onClick={() => view(d)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--color-blue))', fontWeight: 600, fontSize: 12.5, fontFamily: 'Inter,sans-serif', padding: 0, flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {d.fileName}
            </button>
            <span style={{ color: 'var(--muted)', fontSize: 11, flexShrink: 0 }}>{fmtSize(d.sizeBytes)}</span>
            <button onClick={() => remove(d)} title="Delete" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 3 }}><X size={13} /></button>
          </div>
        ))}
    </div>
  );
}

// ── Provisioning modal (Phase 4) ──────────────────────────────────────────────
const STEP_LABEL = {
  m365_user: 'Microsoft 365 account', m365_license: 'License + mailbox',
  m365_manager: 'Reporting line in Entra', asana: 'Asana', ignite: 'Ignite', welcome_email: 'Welcome email',
};
const STEP_COLOR = { ok: '--color-green', failed: '--color-red', manual: '--color-orange', skipped: null, pending: null };

function ProvisionModal({ employee: e, onClose, onDone, toastErr }) {
  const guess = `${(e.firstName || '').toLowerCase()}.${(e.lastName || '').toLowerCase()}`.replace(/\.+$/, '') + '@greensglobal.com';
  const [email, setEmail] = useState(e.workEmail || guess);
  // Usage location drives license compliance - guess India from the profile, else US
  const [usageLoc, setUsageLoc] = useState(() =>
    /india/i.test(`${e.location} ${e.department} ${e.notes}`) ? 'IN' : 'US');
  const [skus, setSkus] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  useEffect(() => {
    api.getProvisionSkus().then(rows => {
      setSkus(rows);
      // Pre-tick the standard new-hire license (Business Basic) when in stock
      setPicked(new Set(rows.filter(s => s.isDefault && s.available > 0).map(s => s.skuId)));
    }).catch(err => { setSkus([]); toastErr(err?.message || 'Could not load licenses.'); });
  }, [toastErr]);

  const togglePick = id => setPicked(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.provisionEmployee(e.id, { work_email: email.trim(), license_sku_ids: [...picked], usage_location: usageLoc });
      setResult(res);
      onDone(res.employee);
    } catch (err) { toastErr(err?.message || 'Provisioning failed.'); }
    setBusy(false);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={ev => ev.target === ev.currentTarget && !busy && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: 'max(min(100%, 560px), 60vw)', maxWidth: '100%', minHeight: 'min(60vh, 90dvh)', maxHeight: '90dvh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Provision accounts - {fullName(e)}</h3>
          <button onClick={onClose} disabled={busy} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px', display: 'flex', flexDirection: 'column' }}>
          {!result ? (<>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.55 }}>
              Creates the Microsoft 365 account (with a temp password shown once to you), assigns the license - which
              is what creates the Outlook mailbox - sets the Entra reporting line, and emails a welcome note to their
              personal address. Asana and Ignite stay manual checklist items for now.
            </p>
            <label style={FL}>WORK EMAIL (becomes their sign-in) *</label>
            <input className="form-input" style={{ width: '100%', marginBottom: 14 }} value={email} onChange={ev => setEmail(ev.target.value)} />
            <label style={FL}>USAGE LOCATION (where they'll use the license) *</label>
            <select className="form-input" style={{ width: '100%', marginBottom: 14 }} value={usageLoc} onChange={ev => setUsageLoc(ev.target.value)}>
              <option value="US">United States</option>
              <option value="IN">India</option>
            </select>
            <label style={FL}>LICENSES{picked.size > 0 ? ` (${picked.size} selected)` : ' - none selected: no mailbox'}</label>
            {skus === null ? <Spinner size={16} /> : (
              <div className="nx-fill" style={{ border: '1px solid var(--line)', borderRadius: 10, overflowY: 'auto' }}>
                {skus.map((s, i) => {
                  const out = s.available <= 0;
                  return (
                    <label key={s.skuId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderTop: i > 0 ? '1px solid var(--line)' : 'none', cursor: out ? 'default' : 'pointer', opacity: out ? 0.5 : 1, userSelect: 'none' }}>
                      <input type="checkbox" disabled={out} checked={picked.has(s.skuId)} onChange={() => togglePick(s.skuId)}
                        style={{ cursor: out ? 'not-allowed' : 'pointer', accentColor: 'var(--pine)', flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                          {s.displayName || s.skuPartNumber}
                          {s.isDefault && <span style={{ marginLeft: 7, fontSize: 9.5, fontWeight: 800, letterSpacing: '.05em', background: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))', borderRadius: 20, padding: '1px 7px' }}>STANDARD</span>}
                        </div>
                        <div style={{ fontSize: 11, color: out ? 'hsl(var(--color-red))' : 'var(--muted)' }}>
                          {out ? 'No licenses available' : `${s.available} of ${s.total} available`}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </>) : (<>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {result.steps.map(s => (
                <div key={s.step} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 13 }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', marginTop: 4, flexShrink: 0, background: STEP_COLOR[s.status] ? `hsl(var(${STEP_COLOR[s.status]}))` : 'var(--line)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 600 }}>{STEP_LABEL[s.step]}</span>
                    <span style={{ color: 'var(--muted)', marginLeft: 7, fontSize: 12 }}>
                      {s.status === 'manual' ? 'manual step' : s.status}{s.detail ? ` - ${s.detail}` : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {result.tempPassword && (
              <div style={{ marginTop: 16, background: 'hsla(var(--color-orange),0.08)', border: '1px solid hsla(var(--color-orange),0.35)', borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', color: 'hsl(var(--color-orange))', marginBottom: 5 }}>TEMP PASSWORD - SHOWN ONLY ONCE</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <code style={{ fontSize: 14, fontWeight: 700 }}>{result.tempPassword}</code>
                  <button className="secondary-btn" style={{ fontSize: 11.5, padding: '4px 10px' }}
                    onClick={() => navigator.clipboard?.writeText(result.tempPassword)}>Copy</button>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 5 }}>Share it with {e.firstName} directly - they must change it on first sign-in. It is not stored anywhere.</div>
              </div>
            )}
          </>)}
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
          {!result ? (<>
            <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="primary-btn" onClick={run} disabled={busy || !email.trim()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'hsl(var(--color-green))' }}>
              {busy ? <Spinner size={14} /> : <CheckCircle size={14} />}
              {busy ? 'Provisioning…' : 'Provision now'}
            </button>
          </>) : <button className="primary-btn" onClick={onClose}>Done</button>}
        </div>
      </div>
    </div>
  );
}

// Profile photo editor now lives in components/PhotoEditorModal.jsx (shared
// with TopHeader -> MyProfileModal's self-service flow, which needs it
// without pulling this whole view into the always-loaded header bundle).

// ── Profile detail pane ───────────────────────────────────────────────────────
// Whole-month tenure from a start date, e.g. "2y 3m". Null if unknown/future.
function fmtTenure(startDate) {
  if (!startDate) return null;
  const d = new Date(startDate + 'T00:00:00'); if (isNaN(d)) return null;
  const now = new Date();
  let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (now.getDate() < d.getDate()) months -= 1;
  if (months < 0) return null;
  const y = Math.floor(months / 12), m = months % 12;
  return y ? (m ? `${y}y ${m}m` : `${y}y`) : `${m}m`;
}

// The soonest date that matters for this person - right-to-work doc expiry or,
// for contractors, contract end. Returns { label, date, days } or null.
function nextExpiry(e) {
  const cands = [
    e.compliance?.expiryDate && { label: 'Doc expiry', date: e.compliance.expiryDate },
    e.employmentType === 'contractor' && e.contractor?.contract_end && { label: 'Contract end', date: e.contractor.contract_end },
  ].filter(Boolean).map(c => ({ ...c, days: daysUntil(c.date) })).filter(c => c.days !== null);
  if (!cands.length) return null;
  return cands.sort((a, b) => a.days - b.days)[0];
}

// A small fact card: the record's four facts and the Team view's access strip.
function StatCard({ label, value, sub, tone }) {
  const color = tone === 'red' ? 'hsl(var(--color-red))' : tone === 'orange' ? 'hsl(var(--color-orange))' : 'var(--ink)';
  return (
    <div style={{ flex: '1 1 120px', minWidth: 110, background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 8, padding: '11px 14px' }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 3, color, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>}
    </div>
  );
}

// "Ask HR" (Neil, Oct 27 2026): requests are confidential HR tickets now, so
// HR works them on the ticket desk - this is the way in. The open HR tickets
// of the companies you are HR for, each opening its ticket, a link to the
// desk filtered to HR, and the requests from before the move (Earlier
// Requests, read-only - their files can still be added to the person's
// documents). An old request that could not be moved yet keeps its Resolve.
const ASK_HR_KIND = { document: 'Document Update', profile: 'Profile Change', question: 'HR Question', other: 'Other HR Request' };
function EmployeeRequestsPanel({ toastOk, toastErr }) {
  const { can, myGrantedModules } = useRole();
  const canOpenTickets = can('administrator') || myGrantedModules.has('tickets') || myGrantedModules.has('tasks');
  const [desk, setDesk] = useState(null);             // open HR tickets, null while loading
  const [reqs, setReqs] = useState([]);               // the old hr_self_requests rows
  const [showEarlier, setShowEarlier] = useState(false);
  const [resolving, setResolving] = useState(null);   // request id with the reply box open
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);
  const [filedKind, setFiledKind] = useState('other');
  const [filed, setFiled] = useState({});             // request id -> true once added to docs
  useEffect(() => {
    api.askHrDesk(true).then(r => setDesk(Array.isArray(r) ? r : [])).catch(() => setDesk([]));
    api.hrSelfRequests().then(r => setReqs(Array.isArray(r) ? r : [])).catch(() => {});
  }, []);
  const stuck = reqs.filter(r => r.status === 'open' && !r.ticketId);   // not moved into a ticket yet
  const earlier = reqs.filter(r => r.status !== 'open' || r.ticketId);
  if (desk === null) return <SkeletonBlocks count={1} height={72} />;
  if (desk.length === 0 && stuck.length === 0 && earlier.length === 0) return null;
  const TYPE_LABEL = { document: 'Document update', profile: 'Profile change', question: 'Question', other: 'Request' };
  const openTicket = (id) => {
    const view = canOpenTickets ? 'tickets' : 'support';
    setPendingOpen('ticket', id);
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view } }));
    window.dispatchEvent(new CustomEvent('nexus:open-ticket', { detail: { ticketId: id } }));
  };
  const openDesk = () => {
    setPendingOpen('ticket-desk', 'hr');
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tickets' } }));
    window.dispatchEvent(new CustomEvent('nexus:ticket-desk', { detail: { desk: 'hr' } }));
  };
  const resolve = async (id) => {
    setBusy(true);
    try {
      await api.hrSelfRequestResolve(id, { response });
      setReqs(rs => rs.map(r => r.id === id ? { ...r, status: 'resolved', response } : r));
      setResolving(null); setResponse('');
      toastOk?.('Resolved - the employee has been notified');
    } catch (e) { toastErr?.(e?.message || 'Could not resolve'); }
    finally { setBusy(false); }
  };
  const viewAttachment = async (id) => {
    try { const { url } = await api.hrSelfRequestAttachmentUrl(id); window.open(url, '_blank', 'noopener'); }
    catch (e) { toastErr?.(e?.message || 'Could not open attachment'); }
  };
  const fileAttachment = async (id) => {
    try {
      await api.hrSelfRequestAttachToEmployee(id, filedKind);
      setFiled(p => ({ ...p, [id]: true }));
      toastOk?.("Added to the employee's documents");
    } catch (e) { toastErr?.(e?.message || 'Could not add to documents'); }
  };
  const attachmentRow = (r) => r.attachmentName && (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7, flexWrap: 'wrap' }}>
      <button onClick={() => viewAttachment(r.id)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--color-blue))', fontSize: 12, fontWeight: 600, fontFamily: 'Inter,sans-serif', padding: 0 }}>
        <FileText size={12} /> {r.attachmentName}
      </button>
      {filed[r.id] ? (
        <span style={{ fontSize: 11.5, color: 'hsl(var(--color-green))', fontWeight: 600 }}>✓ Added to their documents</span>
      ) : (
        <>
          <select className="form-input" value={filedKind} onChange={e => setFiledKind(e.target.value)}
            style={{ fontSize: 11.5, padding: '3px 22px 3px 8px', height: 'auto' }}>
            <option value="id">ID</option>
            <option value="contract">Contract</option>
            <option value="certificate">Certificate</option>
            <option value="resume">Resume</option>
            <option value="other">Other</option>
          </select>
          <button className="secondary-btn" style={{ fontSize: 11.5, padding: '4px 10px' }}
            onClick={() => fileAttachment(r.id)}>
            Add to Employee Documents
          </button>
        </>
      )}
    </div>
  );
  return (
    <div style={{ border: '1px solid hsla(var(--color-blue),0.25)', borderRadius: 12, background: 'hsla(var(--color-blue),0.03)', padding: '14px 16px', marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 180, fontSize: 12, fontWeight: 700, color: 'hsl(var(--color-blue))', textTransform: 'uppercase', letterSpacing: '.05em' }}>
          Ask HR - {desk.length + stuck.length ? `${desk.length + stuck.length} open` : 'nothing open'}
        </div>
        {canOpenTickets && (
          <button className="secondary-btn" style={{ fontSize: 12, padding: '5px 12px' }} onClick={openDesk}>
            Open HR Desk in Tickets
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '-4px 0 10px' }}>
        Requests are confidential HR tickets - only the employee, the people on it and HR see them. Reply, assign and resolve on the ticket.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {desk.map(t => (
          <button type="button" key={t.id} onClick={() => openTicket(t.id)} className="nx-needs-you--card"
            style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)', padding: '10px 12px', textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{t.requesterName}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}> · {ASK_HR_KIND[t.askHrKind] || 'HR Request'} · #{t.code} · {formatDate(t.createdAt?.slice(0, 10))}</span>
                <div style={{ fontSize: 12.5, color: 'var(--ink)', marginTop: 3 }}>{t.subject}</div>
              </div>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', flexShrink: 0 }}>{t.assigneeId ? '' : 'Unassigned · '}Open Ticket</span>
            </div>
          </button>
        ))}
        {stuck.map(r => (
          <div key={r.id} className="nx-needs-you--card" style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)', padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{r.name}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}> · {TYPE_LABEL[r.type] || r.type} · {formatDate(r.createdAt?.slice(0, 10))}</span>
                <div style={{ fontSize: 12.5, color: 'var(--ink)', marginTop: 3 }}>{r.message}</div>
                {attachmentRow(r)}
              </div>
              {resolving !== r.id && (
                <button className="secondary-btn" style={{ fontSize: 12, padding: '5px 12px', flexShrink: 0 }}
                  onClick={() => { setResolving(r.id); setResponse(''); }}>
                  Resolve
                </button>
              )}
            </div>
            {resolving === r.id && (
              <div style={{ marginTop: 8 }}>
                <textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontSize: '0.85rem' }}
                  placeholder="Reply to the employee (they see this on My HR)…" value={response}
                  onChange={e => setResponse(e.target.value)} autoFocus />
                <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                  <button className="secondary-btn" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => setResolving(null)} disabled={busy}>Cancel</button>
                  <button className="primary-btn" style={{ fontSize: 12, padding: '5px 14px' }} onClick={() => resolve(r.id)} disabled={busy}>
                    {busy ? 'Resolving…' : 'Mark Resolved'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {earlier.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <button type="button" onClick={() => setShowEarlier(v => !v)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'hsl(var(--color-blue))', fontFamily: 'Inter,sans-serif' }}>
            {showEarlier ? 'Hide Earlier Requests' : `Earlier Requests (${earlier.length})`}
          </button>
          {showEarlier && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {earlier.map(r => (
                <div key={r.id} style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)', padding: '8px 12px' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>{r.name}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}> · {TYPE_LABEL[r.type] || r.type} · {formatDate(r.createdAt?.slice(0, 10))}
                    {' · '}{r.ticketId ? 'Moved to a ticket' : (r.status === 'resolved' ? 'Resolved' : r.status)}</span>
                  <div style={{ fontSize: 12, color: 'var(--ink)', marginTop: 3 }}>{r.message}</div>
                  {r.response && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}><strong>HR:</strong> {r.response}</div>}
                  {attachmentRow(r)}
                  {r.ticketId && (
                    <button type="button" onClick={() => openTicket(r.ticketId)}
                      style={{ marginTop: 5, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'hsl(var(--color-blue))', fontFamily: 'Inter,sans-serif' }}>
                      Open Ticket
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// The record's Access tab - people/AccessTab.jsx, the ONE access editor
// (Neil, 11/03/2026): Settings > People & Access opens the same component.
// The name stays so the record's call site merges. `showLifecycle` puts the
// external lifecycle box here once the record header stops drawing it.
function EmployeeAccess({ email, identityType = 'internal', companyId = '', showLifecycle = false, toastOk, toastErr, onChanged, onChangeRole, onExternalChanged, onRemoved }) {
  return (
    <AccessTab email={email} identityType={identityType} companyId={companyId} showLifecycle={showLifecycle}
      toastOk={toastOk} toastErr={toastErr} onChanged={onChanged} onChangeRole={onChangeRole}
      onExternalChanged={onExternalChanged} onRemoved={onRemoved} />
  );
}

// The Access tab for a manager looking at their team in People (Oct 6): what
// this person can open in Nexus, read only - access is changed by
// administrators in Admin > Roles & Access. Remounts per person (the profile
// is keyed on the employee), so it loads once and never resets in an effect.
const titleCase = v => String(v || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
function TeamAccessView({ employee }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    api.getEmployeeAccessRead(employee.id)
      .then(d => { if (live) setData(d); })
      .catch(e => { if (live) setErr(e?.message || 'Could not load access.'); });
    return () => { live = false; };
  }, [employee.id]);
  if (err) return <ErrorBanner message={err} />;
  if (!data) return <SkeletonBlocks count={3} height={40} />;
  const modName = id => MODULES.find(m => m.id === id)?.label || id;
  const lvl = l => MODULE_LEVELS[l]?.label || titleCase(l);
  const head = { fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', textAlign: 'left', padding: '6px 8px' };
  const cell = { fontSize: 13, padding: '7px 8px', borderTop: '1px solid var(--line)' };
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatCard label="Role Tier" value={titleCase(data.tier || 'employee')} sub="what their role allows" />
        <StatCard label="Job Role" value={data.job_role?.name || '-'} sub={data.extra_groups?.length ? `+ ${data.extra_groups.map(g => g.name).join(', ')}` : 'no extra groups'} />
      </div>
      {(data.modules || []).length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>No module access beyond what every employee has.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={head}>Module</th><th style={head}>Level</th><th style={head}>Granted By</th></tr></thead>
          <tbody>
            {data.modules.map(m => (
              <tr key={m.module}>
                <td style={{ ...cell, fontWeight: 600 }}>{modName(m.module)}</td>
                <td style={cell}>{lvl(m.level)}</td>
                <td style={{ ...cell, color: 'var(--muted)' }}>{m.source}{m.manual ? ' (added)' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Lock size={12} /> Read only - administrators change access in Admin &gt; Roles &amp; Access.
      </div>
    </div>
  );
}

// The person record (Neil, 11/03/2026): each tab owns its fields and is
// edited in place where it is read - Edit turns them on, one Save row at the
// tab's foot saves them (people/useTabDraft.js); leaving a tab or the record
// with unsaved edits asks first. The tab bodies live in frontend/src/people/.
// Old keys still land: 'location' (Work Mode) is Time & Scheduling and
// 'details' (More Details) is the foot of Overview.
const LEGACY_TAB = { location: 'time', details: 'overview', expenses: 'pay', compliance: 'documents', checklist: 'job', bod: 'time' };
function EmployeeDetail({ e, employees, companyName = '', canSeeComp = false, isAdmin = false, teamView = false, initialTab = 'overview', checklists = [], focusProbation = false, onBack, isMobile, toastOk, toastErr, onEmployeeUpdated, onRemoved, onRestored, onExternalChanged, onReload }) {
  // Removed from Nexus (soft delete) - the record is intact and restorable.
  const isRemoved = !!e.deletedAt;
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  // HR's actions on an employee (Neil, Oct 8): promote / change role / offboard
  const [roleAction, setRoleAction] = useState(null);      // 'choose' (Change Role asks first) | 'promotion'
  const [offboardOpen, setOffboardOpen] = useState(false);
  // End Employment on probation opens Offboard with Termination and the reason (Oct 27 2026).
  const [offboardInitial, setOffboardInitial] = useState(null);
  const [signParty, setSignParty] = useState(null);        // HR's own signature on a letter
  const [reviewEvent, setReviewEvent] = useState(null);    // a letter / package built from Documents, being reviewed (Oct 14)
  const [eventsKey, setEventsKey] = useState(0);
  const [requestsKey, setRequestsKey] = useState(0);   // the pending role change card
  const [welcomeBusy, setWelcomeBusy] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  // The probation bell lands on the probation card, which sits on Job now.
  const [tab, setTabNow] = useState(() => (focusProbation && initialTab === 'overview' ? 'job' : LEGACY_TAB[initialTab] || initialTab));
  // A tab with unsaved edits asks before another one opens.
  const setTab = id => { if (id !== tab) guardRecordLeave(() => setTabNow(id)); };
  // On the Schedule (11/03/2026): off = not on the shift planner, given no
  // shifts and never checked for Late. The switch is on Time & Scheduling.
  const [scheduleNow, setScheduleNow] = useState(null);
  const onSchedule = scheduleNow ?? (e.onSchedule !== false);
  // Checklist steps: HR editors start, cancel and reassign; viewers only read.
  const { canAccessModule: canAccessHr, myEmail: viewerEmail } = useRole();
  const canEditChecklist = canAccessHr('hr', 'administrator', 'editor');
  const canEditProfile = canAccessHr('hr', 'manager', 'editor');
  // The tabs' Edit: People editors outside a team view, on a record still in Nexus.
  const canEdit = !teamView && canEditProfile && !isRemoved;
  // Promote / Change Role: HR editors outside a team view, Administrators and
  // Super Administrators only (Neil, Oct 22 - "Manager calls HR"); the server's
  // role_change.can_change_roles is the same rule.
  const canChangeRole = !teamView && canAccessHr('hr', 'administrator', 'editor');
  const [restoreBusy, setRestoreBusy] = useState(false);
  // Nexus-only removal - separate from offboarding (which deprovisions M365).
  // REVERSIBLE since Aug 11: the record is hidden, not destroyed, and the copy
  // says so. It used to warn that history would be deleted, which was true and
  // is the reason nobody dared use it.
  async function removeFromNexus() {
    if (!await dialog.confirm(
      `Remove ${fullName(e)} from Nexus? They disappear from the directory and everywhere else in Nexus, but nothing is deleted - you can restore them any time from the Deleted filter. It does NOT change or deprovision their Microsoft 365 account - use Offboard for a full offboarding.`,
      { title: 'Remove From Nexus Only', confirmText: 'Remove From Nexus', danger: true, hold: true })) return;
    try {
      await api.deleteEmployee(e.id);
      toastOk(`${fullName(e)} removed from Nexus. Restore them any time from the Deleted filter.`);
      onRemoved?.(e.id);
    } catch (err) { toastErr(err?.message || 'Could not remove from Nexus.'); }
  }
  async function restoreToNexus() {
    setRestoreBusy(true);
    try {
      const restored = await api.restoreEmployee(e.id);
      toastOk(`${fullName(e)} restored to Nexus.`);
      onRestored?.(restored);
    } catch (err) { toastErr(err?.message || 'Could not restore this person.'); }
    setRestoreBusy(false);
  }
  const sm = STATUS_META[e.status] || STATUS_META.active;
  // Case-insensitive email match - manager_email is stored lowercased server-side
  // and the org chart matches the same way, so a reassignment there reflects here.
  const meEmail = (e.workEmail || '').toLowerCase();
  const mgrEmail = (e.managerEmail || '').toLowerCase();
  const manager = mgrEmail ? employees.find(m => (m.workEmail || '').toLowerCase() === mgrEmail) : null;
  const reports = meEmail ? employees.filter(r => (r.managerEmail || '').toLowerCase() === meEmail) : [];
  // A manager looking at their team (Oct 6) gets a short read-only strip -
  // plus Pay & Benefits and Reimbursements for their DIRECT reports (Oct 7).
  // Tab order and names are Neil's (11/03/2026); the keys stay so links land.
  const directReport = teamView && !!mgrEmail && mgrEmail === (viewerEmail || '').toLowerCase();
  // Seven tabs (Neil, 11/08/2026): Checklist rides on Job, Work Logs on
  // Time, Reimbursements on Pay, Compliance on Documents; Access and Assets
  // stay their own. The old keys still land (LEGACY_TAB).
  const tabs = (teamView ? [
    ['overview', 'Overview'],
    ['job', 'Job'],
    ['time', 'Time & Scheduling'],
    directReport && ['pay', 'Pay'],
    ['access', 'Access'],
    ['assets', 'Assets'],
  ] : [
    ['overview', 'Overview'],
    ['job', 'Job'],
    ['time', 'Time & Scheduling'],
    canSeeComp && ['pay', 'Pay'],
    ['documents', 'Documents'],
    ['access', 'Access'],
    ['assets', 'Assets'],
  ]).filter(Boolean);
  const shownTab = tabs.some(([id]) => id === tab) ? tab : 'overview';
  const expiry = nextExpiry(e);
  const tenure = fmtTenure(e.startDate);
  const canAct = canEditProfile && !teamView && ['active', 'onboarding'].includes(e.status) && e.identityType !== 'external';
  // Everything HR can do to the record, behind one Actions menu (11/08/2026);
  // the two that cannot be taken back sit last, in red.
  const actions = isRemoved || teamView ? [] : [
    canChangeRole && canAct && { label: 'Promote', Icon: TrendingUp, onClick: () => setRoleAction('promotion'), title: 'Promotion letter through Nexus Sign - new role, pay and date; the employee and their manager sign' },
    canChangeRole && canAct && { label: 'Change Role', Icon: Shield, onClick: () => setRoleAction('choose'), title: 'Move them to a different role - as a promotion with a letter, or just the role' },
    { label: 'Change Status', Icon: Pencil, onClick: () => setStatusOpen(true), title: 'Change status (with reason)' },
    !!e.m365Id && { label: pushBusy ? 'Pushing to Microsoft 365…' : 'Push to Microsoft 365', Icon: Network, disabled: pushBusy, title: 'Push name, title, department, phone, office (and manager) from Nexus back to their Entra account',
      onClick: async () => {
        setPushBusy(true);
        try {
          const r = await api.pushToEntra(e.id);
          const mgr = r.manager === true ? ' · manager' : '';
          toastOk(`Pushed ${r.written.length} fields${mgr} to Microsoft 365.`);
          onReload?.();
        } catch (err) { toastErr(err?.message || 'Could not push to Microsoft 365.'); }
        setPushBusy(false);
      } },
    !!(e.m365Id && e.personalEmail) && { label: welcomeBusy ? 'Sending Welcome Email…' : 'Resend Welcome Email', Icon: Mail, disabled: welcomeBusy, title: 'Send the branded welcome email to their personal address again',
      onClick: async () => {
        setWelcomeBusy(true);
        try { const r = await api.resendWelcome(e.id); toastOk(`Welcome email sent to ${r.sentTo}.`); }
        catch (err) { toastErr(err?.message || 'Could not send welcome email.'); }
        setWelcomeBusy(false);
      } },
    (canAct || isAdmin) && { divider: true },
    canAct && { label: 'Offboard', Icon: LogOut, danger: true, onClick: () => setOffboardOpen(true), title: 'Last day, the separation package through Nexus Sign, and everything that happens when they leave' },
    isAdmin && { label: 'Remove From Nexus', Icon: Trash2, danger: true, onClick: removeFromNexus, title: "Remove this person's Nexus record only - does not touch Microsoft 365" },
  ].filter(Boolean);
  return (
    <div className="pr-record" style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: isMobile ? '16px 16px' : '20px 24px' }}>
      {isMobile && (
        <button onClick={() => guardRecordLeave(() => onBack?.())} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 600, fontFamily: 'Inter,sans-serif', padding: 0, marginBottom: 14 }}>
          <ChevronLeft size={15} /> All People
        </button>
      )}
      {/* The header is the person (11/08/2026): photo, name, what they do;
          Message / Call, one primary when it applies and one Actions menu -
          not a toolbar. The four fact cards sit under it, then the tabs. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <button title={teamView ? fullName(e) : 'View or change profile photo'} disabled={teamView} onClick={() => setPhotoOpen(true)}
          style={{ position: 'relative', cursor: teamView ? 'default' : 'pointer', flexShrink: 0, background: 'none', border: 'none', padding: 0 }}>
          <Avatar e={e} size={56} card={false} />
          {!teamView && (
            <span style={{ position: 'absolute', right: -3, bottom: -3, width: 20, height: 20, borderRadius: '50%', background: 'var(--card)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--line)' }}>
              <Camera size={11} />
            </span>
          )}
        </button>
        <div style={{ flex: 1, minWidth: 'min(100%, 260px)' }}>
          <div style={{ fontWeight: 700, fontSize: 20, lineHeight: 1.2, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {fullName(e)}<TierMark tier={e.tier} size={16} />
            {e.identityType && e.identityType !== 'internal' && (
              <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--muted)' }}>{e.identityType === 'guest' ? 'Guest' : 'External'}</span>
            )}
            {isRemoved
              ? <StatusLabel label="Removed" color="hsl(var(--color-red))" size="sm" />
              : teamView
                ? <StatusLabel label={sm.label} color={sm.fg} size="sm" />
                : <button type="button" className="pr-status-btn" onClick={() => setStatusOpen(true)} title="Change status (with reason)"><StatusLabel label={sm.label} color={sm.fg} size="sm" /></button>}
            {!onSchedule && !isRemoved && <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)' }}>Off the Schedule</span>}
          </div>
          <div style={{ fontSize: 14, color: 'var(--ink)', marginTop: 3 }}>
            {[e.jobTitle, companyName].filter(Boolean).join(' · ') || '-'}
            {e.employeeCode && <span style={{ color: 'var(--muted)' }}> · {e.employeeCode}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {e.workEmail && <PersonActions email={e.workEmail} name={fullName(e)} external={e.identityType !== 'internal'} myEmail={viewerEmail} variant="pill" />}
          {isRemoved && isAdmin && (
            <button className="primary-btn" onClick={restoreToNexus} disabled={restoreBusy}
              title="Put this person back into Nexus with their full record"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <RotateCcw size={13} /> {restoreBusy ? 'Restoring…' : 'Restore to Nexus'}
            </button>
          )}
          {!isRemoved && !teamView && !e.m365Id && (
            <button className="primary-btn" onClick={() => setProvisionOpen(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <CheckCircle size={13} /> Provision Accounts
            </button>
          )}
          {actions.length > 0 && <ActionsMenu items={actions} />}
        </div>
      </div>
      {isRemoved && (
        <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, background: 'hsla(var(--color-red),0.08)', border: '1px solid hsla(var(--color-red),0.25)', fontSize: 12.5, color: 'var(--ink)', lineHeight: 1.55 }}>
          Removed from Nexus{e.deletedBy ? ` by ${e.deletedBy}` : ''}
          {e.deletedAt ? ` on ${formatDate(e.deletedAt)}` : ''}. Their record is kept in full and
          nothing was deleted. Their Microsoft 365 account was never changed.
        </div>
      )}
      {/* Four facts, no extra fetch: tenure, manager, type, compliance. */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
        <StatCard label="Tenure" value={tenure || '-'} sub={e.startDate ? `since ${formatDate(e.startDate)}` : 'no start date'} />
        <StatCard label="Reports To" value={manager ? fullName(manager) : mgrEmail ? (mgrEmail === (viewerEmail || '').toLowerCase() ? 'You' : mgrEmail) : 'No manager'}
          sub={reports.length ? `${reports.length} direct report${reports.length === 1 ? '' : 's'}` : 'no direct reports'} />
        <StatCard label="Type" value={TYPE_LABEL[e.employmentType] || '-'} sub={[e.department, e.location].filter(Boolean).join(' · ') || '-'} />
        {teamView ? null : expiry
          ? <StatCard label={expiry.label} value={expiry.days < 0 ? 'Expired' : `${expiry.days} day${expiry.days === 1 ? '' : 's'}`} sub={formatDate(expiry.date)} tone={expiry.days < 0 ? 'red' : expiry.days <= 60 ? 'orange' : undefined} />
          : <StatCard label="Compliance" value="Clear" sub="no upcoming expiry" />}
      </div>
      {!teamView && <PaperworkStatus employeeId={e.id} refreshKey={eventsKey} pendingOnly />}
      {(e.probation || checklists.length > 0) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          {checklists.map(p => <ChecklistChip key={p.checklistId} p={p} onClick={() => setTab('job')} />)}
          <ProbationBadge p={e.probation} />
        </div>
      )}
      {!teamView && <PersonLifeEvents employeeId={e.id} workEmail={e.workEmail} refreshKey={eventsKey} onSignNow={setSignParty} onChanged={onReload} toastOk={toastOk} toastErr={toastErr} />}
      {roleAction === 'choose' && <RoleChangeModal employee={e} toastErr={toastErr}
        onClose={() => setRoleAction(null)} onPromote={() => setRoleAction('promotion')}
        onChanged={res => {
          setRoleAction(null); setRequestsKey(n => n + 1); onReload?.();
          toastOk(`${e.firstName} is now ${res.roleName}.${res.warning ? ` ${res.warning}` : ''}`);
        }} />}
      {roleAction === 'promotion' && <PromoteModal employee={e} mode={roleAction} canSeePay={canSeeComp} toastErr={toastErr}
        onClose={() => setRoleAction(null)}
        onSent={ev => {
          setRoleAction(null); setEventsKey(n => n + 1);
          if (ev.openReview) setReviewEvent(ev.id);
          else if (ev.senderPartyId) setSignParty(ev.senderPartyId);
          else toastOk(`Letter sent - ${e.firstName} signs first, then their manager.`);
        }} />}
      {offboardOpen && <OffboardModal employee={e} companyName={companyName} toastErr={toastErr} initial={offboardInitial}
        onClose={() => { setOffboardOpen(false); setOffboardInitial(null); }}
        onSent={ev => {
          setOffboardOpen(false); setOffboardInitial(null); setEventsKey(n => n + 1);
          // Left now, or scheduled with a checklist started: either way the
          // whole People page re-reads (tiles, lists, chips) right away.
          if (ev.applyStatus === 'applied') onEmployeeUpdated?.({ ...e, status: 'offboarded' });
          else onReload?.();
          const m = ev.result?.m365 || {};
          const extra = [m.signIn && `sign-in ${m.signIn}`, m.licenses && `license ${m.licenses}`, m.export && 'mailbox export started - download it from the Documents tab once it is ready', m.error && `M365 issue: ${m.error}`].filter(Boolean).join(', ');
          toastOk(ev.applyStatus === 'applied'
            ? `${e.firstName} is offboarded${extra ? ` - ${extra}` : ''}.`
            : `Offboarding scheduled - last day ${usDay(ev.effectiveDate)}, Nexus marks them Left the morning after.`);
          if (ev.status === 'review') setReviewEvent(ev.id);
          else if (ev.senderPartyId) setSignParty(ev.senderPartyId);
        }} />}
      {reviewEvent && <PacketReview eventId={reviewEvent} onClose={() => setReviewEvent(null)}
        onChanged={() => { setEventsKey(n => n + 1); onReload?.(); }} onSignNow={setSignParty} toastOk={toastOk} toastErr={toastErr} />}
      <PacketSigner partyId={signParty} toastOk={toastOk} toastErr={toastErr}
        onClose={() => { setSignParty(null); setEventsKey(n => n + 1); }}
        onDone={() => { setSignParty(null); setEventsKey(n => n + 1); onReload?.(); toastOk('Signed.'); }} />

      <div className="pr-body">
        <div className="pr-main">
          <div className="pr-tabs scroll-tabs">
            {tabs.map(([id, tlabel]) => (
              <button key={id} type="button" className="pr-tab" onClick={() => setTab(id)} aria-current={shownTab === id ? 'page' : undefined}>{tlabel}</button>
            ))}
          </div>

          {shownTab === 'overview' && (
            <OverviewTab e={e} employees={employees} canEdit={canEdit} canSync={canEdit} isRemoved={isRemoved}
              readOnlyCustom={teamView || isRemoved || !canEditProfile}
              onSaved={onEmployeeUpdated} toastOk={toastOk} toastErr={toastErr} />
          )}

          {shownTab === 'job' && (
            <>
              <JobTab e={e} employees={employees} companyName={companyName} viewerEmail={viewerEmail} canEdit={canEdit} isRemoved={isRemoved}
                empTypes={EMP_TYPES} statusLabel={isRemoved ? 'Removed' : sm.label}
                onChangeStatus={!teamView && !isRemoved ? () => setStatusOpen(true) : null}
                focusProbation={focusProbation} onReload={onReload}
                onOffboard={init => { setOffboardInitial(init); setOffboardOpen(true); }}
                roleHistoryKey={`${requestsKey}-${eventsKey}-${e.updatedAt || ''}`}
                onSaved={onEmployeeUpdated} toastOk={toastOk} toastErr={toastErr} />
              {!teamView && (
                <>
                  <h3 className="pr-h3">Checklists</h3>
                  <ChecklistSection employee={e} canEdit={canEditChecklist && !isRemoved} myEmail={viewerEmail} toastOk={toastOk} toastErr={toastErr} />
                </>
              )}
            </>
          )}

          {shownTab === 'time' && (
            <>
              <TimeTab e={e} onSchedule={onSchedule} onScheduleChange={on => { setScheduleNow(on); onReload?.(); }}
                canEdit={canEdit} canSeeComp={canSeeComp} toastOk={toastOk} toastErr={toastErr} />
              <h3 className="pr-h3">Work Logs</h3>
              <WorkLogsSection employee={e} />
            </>
          )}

          {shownTab === 'pay' && (canSeeComp || directReport) && (
            <>
              <PayTab employee={e} readOnly={teamView} onGoCompliance={teamView ? null : () => setTab('documents')} toastOk={toastOk} toastErr={toastErr} />
              {/* Every reimbursement this person filed, with receipts and history (Oct 18 2026). */}
              {e.workEmail && (
                <>
                  <h3 className="pr-h3">Reimbursements</h3>
                  <PersonReimbursements email={e.workEmail.toLowerCase()} toastErr={toastErr} />
                </>
              )}
            </>
          )}

          {shownTab === 'documents' && !teamView && (
            <>
              <ComplianceTab e={e} canEdit={canEdit} paperworkKey={eventsKey} onSaved={onEmployeeUpdated} toastErr={toastErr} />
              <h3 className="pr-h3">Documents</h3>
              {/* Signed offer / packet / letters, one line each with their filing (off the header - Neil, Oct 22). */}
              <PersonLifeEvents signed employeeId={e.id} workEmail={e.workEmail} refreshKey={eventsKey} onSignNow={setSignParty} onChanged={onReload} toastOk={toastOk} toastErr={toastErr} />
              <DocumentsSection employeeId={e.id} employee={e} onSent={onReload} toastOk={toastOk} toastErr={toastErr} />
              {/* The person's wired Egnyte folder (Neil, Aug 6): hiring package,
                  invoices, payment proofs live in Egnyte, not as Nexus uploads.
                  Resolution + re-pointing happen in Egnyte - Wiring. */}
              {e.workEmail && (
                <div style={{ marginTop: 18 }}>
                  <h3 className="pr-h3">Egnyte Folder</h3>
                  <EgnytePersonFolder email={e.workEmail} personName={fullName(e)} />
                </div>
              )}
              {/* Started only from Offboard / Change Status; here is just the result. */}
              <MailboxExportResult employeeId={e.id} toastErr={toastErr} />
            </>
          )}

          {shownTab === 'assets' && <AssetsSection employee={e} />}

          {/* A role change request from before Oct 22 still waiting: HR decides
              or cancels it here, or from the bell / email. */}
          {shownTab === 'access' && <RoleChangeRequestCard employeeId={e.id} refreshKey={requestsKey}
            toastOk={toastOk} toastErr={toastErr} onDecided={() => { setRequestsKey(n => n + 1); onReload?.(); }} />}
          {shownTab === 'access' && teamView && <TeamAccessView employee={e} />}
          {/* keyed on updatedAt: a role change made from the Change Role modal
              re-reads the job role and access shown here */}
          {shownTab === 'access' && isAdmin && !teamView && <EmployeeAccess key={e.updatedAt} email={meEmail} identityType={e.identityType} companyId={e.company || ''} showLifecycle={!isRemoved} onExternalChanged={onExternalChanged} onRemoved={() => onRemoved?.(e.id)} toastOk={toastOk} toastErr={toastErr} onChanged={onEmployeeUpdated}
            onChangeRole={['active', 'onboarding'].includes(e.status) && e.identityType !== 'external' ? () => setRoleAction('choose') : undefined} />}
        </div>
      </div>
      {photoOpen && (
        <PhotoEditorModal employee={e} toastOk={toastOk} toastErr={toastErr}
          onClose={() => setPhotoOpen(false)} onSaved={onEmployeeUpdated} />
      )}
      {provisionOpen && (
        <ProvisionModal employee={e} toastErr={toastErr}
          onClose={() => setProvisionOpen(false)}
          onDone={updated => { onEmployeeUpdated(updated); toastOk(`${fullName(e)} provisioned.`); }} />
      )}
      {statusOpen && (
        <StatusChangeModal employee={e} employees={employees} toastOk={toastOk} toastErr={toastErr} onClose={() => setStatusOpen(false)} onSaved={onEmployeeUpdated} />
      )}
    </div>
  );
}

// The record's Actions menu (11/08/2026): every action HR can take, the
// ones that cannot be taken back last and in red. `null` is a divider.
function ActionsMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const down = (ev) => { if (ref.current && !ref.current.contains(ev.target)) setOpen(false); };
    const key = (ev) => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="secondary-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
        Actions <ChevronDown size={14} />
      </button>
      {open && (
        <div role="menu" aria-label="Actions" className="header-user-dropdown" style={{ width: 250 }}>
          {items.map((it, i) => it.divider
            ? <div key={`d${i}`} className="hud-divider" role="separator" />
            : (
              <button key={it.label} type="button" role="menuitem" className="hud-item" disabled={it.disabled} title={it.title}
                onClick={() => { setOpen(false); it.onClick(); }}
                style={it.danger ? { color: 'hsl(var(--color-red))' } : undefined}>
                <it.Icon size={15} style={{ flexShrink: 0, color: it.danger ? 'hsl(var(--color-red))' : 'var(--muted)' }} aria-hidden="true" /> {it.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

// ── Hiring pipeline (Phase 2) ─────────────────────────────────────────────────
const daysSince = iso => Math.max(0, Math.floor((Date.now() - new Date(iso)) / 86400000));

function HiringTab({ isMobile, toastOk, toastErr, onEmployeeCreated, onSendForSignature }) {
  const [candidates, setCandidates] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showInactive, setShowInactive] = useState(false);   // rejected ones taken off the board
  const [dragOver, setDragOver] = useState('');              // the lane a card is being dragged over
  const [lbOpen, setLbOpen] = useState(false);      // interview leaderboard
  const [ivFor, setIvFor] = useState(null);         // candidate for the interview room
  const [loadErr, setLoadErr] = useState(false);
  const [editing, setEditing] = useState(null);            // candidate open in the edit form
  const [scheduling, setScheduling] = useState(null);      // { candidate, replace } - the one scheduling path
  const [packetFor, setPacketFor] = useState(null);        // candidate the hiring packet is being sent to
  const [offerFor, setOfferFor] = useState(null);          // candidate the offer is being made to (Oct 14)
  const [signParty, setSignParty] = useState(null);        // HR's own signature on a packet
  const [reviewFor, setReviewFor] = useState(null);        // a packet built from Documents, being reviewed (Oct 14)
  const [packetRefresh, setPacketRefresh] = useState(0);
  const { canAccessModule } = useRole();
  const canSeePay = canAccessModule('hr_comp', 'owner', 'viewer');
  // Pipeline | Openings | Headcount (Neil, Oct 27 2026): hiring starts before the
  // candidate - a headcount request, then the job opening the careers page lists.
  const [hView, setHView] = useState('pipeline');
  const [openings, setOpenings] = useState([]);
  const [openingFilter, setOpeningFilter] = useState('');   // '' = every candidate
  const loadOpenings = useCallback(() => { api.listOpenings().then(setOpenings).catch(() => {}); }, []);
  useEffect(() => { loadOpenings(); }, [loadOpenings]);
  // Headcount Requests are off per company until Settings turns them on (Neil,
  // Oct 30 2026): no Headcount tab without any, and where they are off HR
  // starts openings by hand (directOpeningCompanies).
  const [hcMeta, setHcMeta] = useState({ showTab: false, directOpeningCompanies: [] });
  useEffect(() => {
    Promise.resolve().then(() => api.headcountMeta())
      .then(m => setHcMeta({ showTab: !!m?.showTab, directOpeningCompanies: m?.directOpeningCompanies || [] })).catch(() => {});
  }, []);
  // Roles typed in as Other on Add Candidate that have no hiring packet yet
  // (Neil, Oct 12) - the Packets button carries the count until each has one.
  const [needPackets, setNeedPackets] = useState([]);
  const loadNeedPackets = useCallback(() => {
    api.getPackets().then(p => setNeedPackets(p?.rolesNeedingPacket || [])).catch(() => {});
  }, []);
  useEffect(() => { loadNeedPackets(); }, [loadNeedPackets]);

  const loadCandidates = useCallback(() => {
    setLoadErr(false); setCandidates(null);
    api.getCandidates().then(setCandidates).catch(() => setLoadErr(true));
  }, []);
  useEffect(() => { loadCandidates(); }, [loadCandidates]);
  // Refresh the board (and the open card) without the full-page spinner.
  const refreshBoard = useCallback(() => api.getCandidates().then(rows => {
    setCandidates(rows);
    setDetail(d => (d ? rows.find(x => x.id === d.id) || d : d));
  }).catch(() => {}), []);

  async function moveStage(c, stage, note) {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await api.updateCandidate(c.id, { stage, stage_note: note || '' });
      setCandidates(prev => prev.map(x => x.id === c.id ? { ...x, ...updated } : x));
      setDetail(stage === 'hired' ? null : { ...c, ...updated });
      if (stage === 'hired') {
        toastOk(`${candName(c)} hired - added to People as Onboarding (${updated.createdEmployee?.employeeCode || ''}).`);
        if (updated.createdEmployee) onEmployeeCreated(updated.createdEmployee);
      } else if (stage === 'rejected') toastOk(`${candName(c)} marked rejected.`);
      else toastOk(`${candName(c)} → ${STAGE_META[stage].label}.`);
    } catch (err) { toastErr(err?.message || 'Could not update stage.'); }
    setBusy(false);
  }

  if (loadErr) return <ErrorBanner message="Couldn't load candidates right now." onRetry={loadCandidates} />;
  if (candidates === null) return <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}><Spinner size="section" /></div>;

  const open = candidates.filter(c => !['hired', 'rejected'].includes(c.stage));
  // Neil, Oct 14: Hired and Rejected stay on the board ("there's no need to keep
  // this closed"); a rejected candidate leaves it when removed, or after 90 days.
  const inactive = candidates.filter(c => c.inactive);
  const byStage = s => candidates.filter(c => c.stage === s && !c.inactive && (!openingFilter || c.openingId === openingFilter));
  const LANES = [...STAGES, 'rejected'];
  // The openings still taking candidates, with how many are on the board for each.
  const activeOpenings = openings.filter(o => ['draft', 'open', 'paused'].includes(o.status) || o.id === openingFilter);
  const viewTabs = (
    <div className="scroll-tabs" role="tablist" aria-label="Hiring" style={{ display: 'flex', gap: 4 }}>
      {[['pipeline', 'Pipeline'], ['openings', `Openings${activeOpenings.length ? ` (${activeOpenings.length})` : ''}`], ...(hcMeta.showTab ? [['headcount', 'Headcount']] : [])].map(([k, label]) => (
        <button key={k} type="button" role="tab" aria-selected={hView === k} onClick={() => { setHView(k); if (k === 'pipeline') { refreshBoard(); loadOpenings(); } }}
          className={hView === k ? 'primary-btn' : 'secondary-btn'} style={{ fontSize: 12.5, padding: '5px 12px' }}>{label}</button>
      ))}
    </div>
  );
  if (hView !== 'pipeline') {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>{viewTabs}</div>
        <Suspense fallback={<SkeletonBlocks count={3} height={64} />}>
          {hView === 'openings'
            ? <JobOpenings toastOk={toastOk} toastErr={toastErr} canSeePay={canSeePay} directCompanies={hcMeta.directOpeningCompanies}
              onCreated={loadOpenings} onFilterPipeline={id => { setOpeningFilter(id); setHView('pipeline'); refreshBoard(); loadOpenings(); }} />
            : <HeadcountRequests toastOk={toastOk} toastErr={toastErr} />}
        </Suspense>
      </div>
    );
  }

  // Drag a card to another stage (Neil, Oct 14: "you should be able to drag
  // and drop people ... you should be able to go backwards"). Each target runs
  // the same action its button does - Interview is reached by scheduling one.
  async function dropOn(id, stage) {
    setDragOver('');
    const c = candidates.find(x => x.id === id);
    if (!c || c.stage === stage) return;
    if (c.stage === 'hired') { toastErr(`${candName(c)} is hired - that is final.`); return; }
    const from = LANES.indexOf(c.stage), to = LANES.indexOf(stage);
    if (stage === 'rejected') {
      const why = await dialog.prompt(`Reject ${candName(c)}? Add a reason for the notes (optional).`, { title: 'Reject', confirmText: 'Reject' });
      if (why !== null) moveStage(c, 'rejected', why);
      return;
    }
    if (c.stage === 'rejected') {
      if (await dialog.confirm(`Reopen ${candName(c)} in ${STAGE_META[stage].label}?`, { title: 'Reopen', confirmText: 'Reopen' })) {
        moveStage(c, stage === 'screening' ? 'screening' : 'applied', 'Reopened');
      }
      return;
    }
    if (stage === 'hired') {
      if (c.stage !== 'offer') { toastErr('Hire from Offer - make the offer first.'); return; }
      markHiredByHand(c);
      return;
    }
    if (stage === 'interview' && from < to) {
      if (!c.email) { toastErr('Add their email first (open them, then Edit) - the Teams invite goes there.'); return; }
      setScheduling({ candidate: c, replace: null });     // Interview means a scheduled interview
      return;
    }
    // Decision sits between Interview and Offer (Neil, Oct 19).
    if (stage === 'decision' && from < to && c.stage !== 'interview') { toastErr('Interview them first - schedule the interview.'); return; }
    if (stage === 'offer' && c.stage !== 'decision') {
      toastErr(c.stage === 'interview' ? 'Move them to Decision first - the interviewers and the department head decide before the offer.'
        : 'Interview them before the offer - schedule the interview first.');
      return;
    }
    // Into Offer means making the offer: the offer questions come up (Oct 14).
    if (stage === 'offer' && from < to) { setOfferFor(c); return; }
    if (to < from && !await dialog.confirm(`Move ${candName(c)} back to ${STAGE_META[stage].label}?`, { title: 'Move Back', confirmText: 'Move Back' })) return;
    moveStage(c, stage, to < from ? `Moved back to ${STAGE_META[stage].label}` : '');
  }
  // Only for an offer signed on paper - and never without saying why.
  async function markHiredByHand(c, note = '') {
    const why = note || await dialog.prompt(`Mark ${candName(c)} hired without the hiring packet? Say why - for example "signed the offer on paper".`,
      { title: 'Mark Hired By Hand', confirmText: 'Mark Hired', required: true });
    if (why) moveStage(c, 'hired', why);
  }

  const card = c => {
    const hue = hueFor({ employeeCode: c.id });
    return (
      <button key={c.id} onClick={() => setDetail(c)}
        draggable={!isMobile && c.stage !== 'hired'}
        onDragStart={e => { e.dataTransfer.setData('text/x-candidate', c.id); e.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={() => setDragOver('')}
        title={!isMobile && c.stage !== 'hired' ? 'Drag to another stage' : undefined}
        style={{ display: 'block', width: '100%', textAlign: 'left', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 13px', marginBottom: 8, boxShadow: 'var(--shadow-sm)', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: `hsla(${hue},0.13)`, color: `hsl(${hue})`, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {`${(c.firstName || '?')[0]}${(c.lastName || '')[0] || ''}`.toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{candName(c)}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.roleTitle || c.department || '-'}</div>
          </div>
          <span style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 600, flexShrink: 0 }}>{daysSince(c.updatedAt)}d</span>
        </div>
        {['applied', 'screening'].includes(c.stage) && c.expectedInterviewOn && !c.interview && (
          <div style={{ marginTop: 7 }}>
            <span title="Expected interview date - screening is due one business day before"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: 'var(--mist)', color: 'var(--muted)' }}>
              <CalendarDays size={10} /> Interview By {formatDate(c.expectedInterviewOn)}
            </span>
          </div>
        )}
        {(c.interview || c.interviewScore != null) && !['hired', 'rejected'].includes(c.stage) && (
          <div style={{ marginTop: 7, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {c.interview && ['scheduled', 'live'].includes(c.interview.status) && (
              <span title={c.interview.interviewers?.length ? `With ${c.interview.interviewers.join(', ')}` : ''}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                  background: c.interview.status === 'live' ? 'hsla(var(--color-orange),0.12)' : 'hsla(var(--color-purple),0.1)',
                  color: c.interview.status === 'live' ? 'hsl(var(--color-orange))' : 'hsl(var(--color-purple))' }}>
                <CalendarDays size={10} />
                {c.interview.status === 'live' ? 'In Progress' : formatDateTime(c.interview.at)}
                {c.interview.interviewers?.length ? ` · ${c.interview.interviewers.map(n => n.split(' ')[0]).join(', ')}` : ''}
              </span>
            )}
            {c.interview?.status === 'completed' && (
              <span title="Interview done - waiting on the transcript or the score"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: 'var(--mist)', color: 'var(--muted)' }}>
                <CheckCircle size={10} /> Interviewed
              </span>
            )}
            {c.interviewScore != null && (
              <span title="Calibrated interview score (0–100)"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 12,
                  background: c.interviewScore >= 70 ? 'hsla(var(--color-green),0.12)' : c.interviewScore >= 45 ? 'hsla(var(--color-orange),0.12)' : 'hsla(var(--color-red),0.12)',
                  color: c.interviewScore >= 70 ? 'hsl(var(--color-green))' : c.interviewScore >= 45 ? 'hsl(var(--color-orange))' : 'hsl(var(--color-red))' }}>
                🏆 {c.interviewScore}
              </span>
            )}
          </div>
        )}
      </button>
    );
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {viewTabs}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {/* Neil, Oct 14: the questionnaires and the documents are settings -
              set up in Settings > Hiring, never edited on the board. */}
          <button className="secondary-btn"
            onClick={() => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'admin-console', sub: 'hiring' } }))}
            title={needPackets.length ? `${needPackets.map(r => r.name).join(', ')} - added while hiring, no hiring documents yet` : 'Hiring documents and interview questionnaires, in Settings'}
            style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6,
              ...(needPackets.length ? { borderColor: '#b45309', color: '#b45309', background: 'rgba(180,83,9,0.08)', fontWeight: 700 } : {}) }}>
            {needPackets.length > 0 && <AlertTriangle size={13} />}
            Hiring Setup
            {needPackets.length > 0 && (
              <span style={{ fontSize: 11, fontWeight: 800, padding: '1px 7px', borderRadius: 999, background: '#b45309', color: '#fff' }}>{needPackets.length}</span>
            )}
          </button>
          <button className="secondary-btn" style={{ fontSize: 12.5 }} onClick={() => setLbOpen(true)}>Leaderboard</button>
          {inactive.length > 0 && (
            <button className="secondary-btn" style={{ fontSize: 12.5 }} onClick={() => setShowInactive(s => !s)}
              title="Rejected candidates removed from the board, or rejected more than 90 days ago">
              {showInactive ? 'Hide' : 'Show'} Inactive ({inactive.length})
            </button>
          )}
          <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }} onClick={() => setAddOpen(true)}>
            <Plus size={14} /> Add Candidate
          </button>
        </div>
      </div>

      {/* Pipeline stats */}
      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 18 }}>
        {[['card-blue', 'In pipeline', open.length, 'Applied → Offer'],
          ['card-orange', 'Interviews booked', candidates.filter(c => c.interview && ['scheduled', 'live'].includes(c.interview.status) && !['hired', 'rejected'].includes(c.stage)).length, 'Teams invites out'],
          ['card-purple', 'Offers out', byStage('offer').length, 'Awaiting decision'],
          ['card-green', 'Hired', byStage('hired').length, 'Became employees']].map(([cls, label, value, sub]) => (
          <div key={label} className={`kpi-card ${cls}`}>
            <div className="kpi-label">{label}</div>
            <div className="kpi-value">{value}</div>
            <div className="kpi-delta">{sub}</div>
          </div>
        ))}
      </div>

      {activeOpenings.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', marginRight: 4 }}>Openings</span>
          {[{ id: '', title: 'All Candidates' }, ...activeOpenings].map(o => {
            const on = openingFilter === o.id;
            const n = o.id ? candidates.filter(c => c.openingId === o.id && !c.inactive).length : null;
            return (
              <button key={o.id || 'all'} type="button" aria-pressed={on} onClick={() => setOpeningFilter(o.id)}
                title={o.id ? `${o.statusLabel} - ${o.counts?.hired || 0} of ${o.seats} hired` : 'Every candidate'}
                style={{ fontSize: 12, fontWeight: on ? 700 : 600, padding: '4px 10px', borderRadius: 999, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                  border: `1px solid ${on ? 'var(--pine, #15803d)' : 'var(--line)'}`, background: on ? 'hsla(var(--color-green),0.08)' : 'var(--card)', color: 'var(--ink)' }}>
                {o.title}{n != null && <span style={{ color: 'var(--muted)', fontWeight: 600 }}> · {n}</span>}
              </button>
            );
          })}
        </div>
      )}

      {candidates.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
          <UserPlus size={32} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
          <div style={{ fontSize: 14, fontWeight: 600 }}>No candidates yet.</div>
          <div style={{ fontSize: 12.5, marginTop: 4 }}>Add one and walk them through Applied → Hired - hiring creates the employee record automatically.</div>
        </div>
      ) : isMobile ? (
        /* Phone: stage-grouped stacks, same data as the desktop board */
        <div>
          {LANES.map(s => {
            const items = byStage(s);
            if (!items.length) return null;
            return (
              <div key={s} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 4px 8px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: `hsl(${STAGE_META[s].hue})` }} />
                  <b style={{ fontSize: 11.5, letterSpacing: '.06em', textTransform: 'uppercase' }}>{STAGE_META[s].label}</b>
                  <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 20, padding: '1px 8px', color: 'var(--muted)' }}>{items.length}</span>
                </div>
                {items.map(card)}
              </div>
            );
          })}
        </div>
      ) : (
        /* Desktop: kanban lanes - full height so the board reads as a board */
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${LANES.length}, minmax(170px, 1fr))`, gap: 12, alignItems: 'stretch', overflowX: 'auto' }}>
          {LANES.map(s => {
            const items = byStage(s);
            return (
              <div key={s} role="list" aria-label={`${STAGE_META[s].label} lane`}
                onDragOver={e => { if (e.dataTransfer.types.includes('text/x-candidate')) { e.preventDefault(); if (dragOver !== s) setDragOver(s); } }}
                onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(''); }}
                onDrop={e => { e.preventDefault(); dropOn(e.dataTransfer.getData('text/x-candidate'), s); }}
                style={{ background: dragOver === s ? `hsla(${STAGE_META[s].hue},0.08)` : 'rgba(255,255,255,0.55)',
                  border: dragOver === s ? `1.5px dashed hsl(${STAGE_META[s].hue})` : '1px solid var(--line)', borderRadius: 14, padding: 10,
                  minHeight: 'max(420px, calc(100vh - 470px))', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 4px 10px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: `hsl(${STAGE_META[s].hue})` }} />
                  <b style={{ fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase' }}>{STAGE_META[s].label}</b>
                  <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 20, padding: '0 7px', color: 'var(--muted)' }}>{items.length}</span>
                </div>
                {items.map(card)}
                {items.length === 0 && (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px dashed var(--line)', borderRadius: 10, margin: '2px 2px 4px', minHeight: 90 }}>
                    <span style={{ fontSize: 11.5, color: 'var(--muted)', opacity: 0.8 }}>No one in {STAGE_META[s].label.toLowerCase()}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {showInactive && inactive.length > 0 && (
        <div style={{ marginTop: 16, border: '1px solid var(--line)', borderRadius: 14, padding: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
            Inactive - Rejected And Off The Board ({inactive.length})
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {inactive.map(card)}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>Open one and click Reopen to put them back in the pipeline.</div>
        </div>
      )}

      {addOpen && <CandidateFormModal onClose={() => setAddOpen(false)} toastOk={toastOk} toastErr={toastErr}
        onSaved={c => {
          setCandidates(prev => [c, ...prev]);
          toastOk(c.roleCreated
            ? `${candName(c)} added. "${c.roleCreated}" is now a role of the company - add its hiring documents in Settings > Hiring.`
            : `${candName(c)} added to the pipeline.`);
          refreshBoard();
          if (c.roleCreated) loadNeedPackets();
        }} />}
      {detail && <CandidateDetailModal candidate={detail} onClose={() => setDetail(null)} onStage={moveStage} onSendForSignature={onSendForSignature} busy={busy}
        onMarkHired={c => markHiredByHand(c)}
        refreshKey={packetRefresh}
        onUpdated={u => { if (u) { setCandidates(prev => prev.map(x => x.id === u.id ? { ...x, ...u } : x)); setDetail(d => d && d.id === u.id ? { ...d, ...u } : d); } else refreshBoard(); }}
        onEdit={cand => setEditing(cand)}
        onSchedule={(cand, replace) => setScheduling({ candidate: cand, replace: replace || null })}
        onOpenRoom={cand => { setDetail(null); setIvFor(cand); }}
        onSendPacket={cand => setPacketFor(cand)} onMakeOffer={cand => setOfferFor(cand)} onSignPacket={setSignParty}
        toastOk={toastOk} toastErr={toastErr} />}
      {offerFor && <OfferModal candidate={offerFor} canSeePay={canSeePay} toastErr={toastErr}
        onClose={() => setOfferFor(null)}
        onMoveWithout={cand => { setOfferFor(null); moveStage(cand, 'offer', 'Moved to Offer - no offer letter set up yet'); }}
        onStarted={ev => {
          setOfferFor(null); setPacketRefresh(n => n + 1); refreshBoard();
          setDetail(d => (d && d.id === ev.candidateId ? { ...d, stage: 'offer' } : d));
          // Check the filled-in letter and send it - the same review every packet uses.
          setReviewFor(ev.id);
        }} />}
      {scheduling && <ScheduleInterviewModal candidate={scheduling.candidate} replace={scheduling.replace}
        onClose={() => setScheduling(null)} toastOk={toastOk} toastErr={toastErr}
        onScheduled={() => { setScheduling(null); setPacketRefresh(n => n + 1); refreshBoard(); }} />}
      {editing && <CandidateFormModal candidate={editing} onClose={() => setEditing(null)} toastErr={toastErr}
        onSaved={u => { setCandidates(prev => prev.map(x => x.id === u.id ? u : x)); setDetail(d => d && d.id === u.id ? u : d); toastOk(`${candName(u)} updated.`); }} />}
      {packetFor && <SendHiringPacketModal candidate={packetFor} canSeePay={canSeePay} toastErr={toastErr}
        onClose={() => setPacketFor(null)}
        onSent={ev => {
          setPacketFor(null); setPacketRefresh(n => n + 1);
          if (ev.openReview) setReviewFor(ev.id);
          else if (ev.intakeUrl) toastOk(`Details link sent to ${ev.subjectEmail}. The documents are generated when they fill it in.`);
          else if (ev.senderPartyId) setSignParty(ev.senderPartyId);
          else toastOk(`Hiring packet sent to ${ev.subjectEmail}.`);
        }} />}
      {reviewFor && <PacketReview eventId={reviewFor} onClose={() => setReviewFor(null)}
        onChanged={() => setPacketRefresh(n => n + 1)} onSignNow={setSignParty} toastOk={toastOk} toastErr={toastErr} />}
      <PacketSigner partyId={signParty} toastOk={toastOk} toastErr={toastErr}
        onClose={() => { setSignParty(null); setPacketRefresh(n => n + 1); }}
        onDone={() => {
          setSignParty(null); setPacketRefresh(n => n + 1);
          toastOk('Signed - the new hire has been emailed the packet to sign.');
        }} />
      {lbOpen && <LeaderboardModal onClose={() => setLbOpen(false)} toastOk={toastOk} toastErr={toastErr} />}
      {ivFor && <InterviewPanel candidate={ivFor} onClose={() => { setIvFor(null); refreshBoard(); }} toastOk={toastOk} toastErr={toastErr}
        onDecision={(kind, cand) => {
          // The offer and the rejection wait for the Decision step (Oct 19).
          if (kind === 'another') setScheduling({ candidate: cand, replace: null });
        }} />}
    </div>
  );
}

// ── Org chart (Phase 5) - top-down node chart on a pan/zoom canvas ────────────
// The canvas (layout, connectors, pan, zoom, fit, focus) is the shared
// components/orgchart/OrgChartCanvas, which the Contact Directory's read-only
// Org Chart lens draws with too. This tab adds what only HR may do: drag a
// card to change who someone reports to, and the side panel that edits the
// reporting line, title, department and division head tag.
// Functional divisions colour the chart: a person's division is their own
// head-tag if set, else inherited from the nearest tagged manager above them.
// The palette lives with the canvas so both charts colour a division alike.

// A single node card: fixed width, the photo, and the four lines Neil set
// (Oct 14 2026) - name, role, department, company - each on its own line so
// every card reads the same way. The reports count hangs off the bottom edge
// and doubles as the collapse toggle. data-orgcard lets the canvas tell a
// card press from a pan; data-email lets drop resolve the target across the
// zoom transform. Pass (Neil, 11/07/2026): house chrome only - radius 8, a
// hairline, no color bar (the division colors the connectors below its lead
// instead), a lead marked in words, an external marked in words. It is a
// keyboard stop (Enter / Space open the person), the person whose panel is
// open stays marked, and the x shows on hover or focus only.
function OrgNodeCard({ e, kids, total = 0, isCollapsed, onToggle, onSelect, dnd, entityName, highlight, current = false, selected = false, divName, divColor, isHead, dim, onUnlink = null }) {
  const ext = isExternalPerson(e);
  const email = (e.workEmail || '').toLowerCase();
  const isTarget = dnd.overKey === email && dnd.draggingId && dnd.draggingId !== e.id;
  const isDragging = dnd.draggingId === e.id;
  const company = (ext ? e.externalCompany : entityName(e.company)) || '';
  const line = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
  const ring = isTarget || selected ? 'hsl(var(--color-green))' : current ? 'hsl(var(--color-blue))' : null;
  return (
    <div data-orgcard="1" data-email={email} className="nx-orgcard" style={{ position: 'relative', paddingBottom: kids > 0 ? 11 : 0 }}>
      {/* x = take this person out of the reporting line (Visesh, Aug 11) - the
          direct alternative to dragging them into open space. Outside the
          overflow-hidden card so it can sit on the corner; shown on hover
          and on keyboard focus (style.css "Organizational Chart"). */}
      {onUnlink && !isDragging && (
        <button
          className="nx-orgcard-unlink"
          title="Remove from the reporting line"
          aria-label={`Remove ${fullName(e)} from the reporting line`}
          onPointerDown={ev => ev.stopPropagation()}
          onClick={ev => { ev.stopPropagation(); onUnlink(e); }}
          style={{ position: 'absolute', top: -7, right: -7, zIndex: 2, width: 22, height: 22, borderRadius: '50%',
            border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--muted)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0,
            boxShadow: 'var(--shadow-sm)' }}>
          <X size={11} />
        </button>
      )}
      <div
        data-orgtile="1"
        role="button" tabIndex={0}
        aria-label={`${fullName(e)}${e.jobTitle ? `, ${e.jobTitle}` : ''}${kids ? `, ${kids} direct report${kids === 1 ? '' : 's'}` : ''}`}
        aria-pressed={selected || undefined}
        onPointerDown={ev => dnd.onCardPointerDown(ev, e)}
        onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(e); } }}
        style={{
          position: 'relative', width: 228, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 11,
          background: isTarget ? 'hsla(var(--color-green),0.08)' : 'var(--card)',
          border: `1px solid ${ring || 'var(--line)'}`,
          borderRadius: 8,
          boxShadow: ring ? `0 0 0 3px ${isTarget || selected ? 'hsla(var(--color-green),0.18)' : 'hsla(var(--color-blue),0.18)'}` : highlight ? '0 0 0 3px hsla(var(--color-blue),0.10)' : 'var(--shadow-sm)',
          cursor: 'grab', opacity: dim ? 0.28 : isDragging ? 0.4 : 1, overflow: 'hidden',
          touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
          transition: 'border-color 0.12s, box-shadow 0.12s, opacity 0.15s',
        }}>
        <Avatar e={e} size={40} card={false} />
        <div style={{ flex: 1, minWidth: 0, lineHeight: 1.35 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--ink)', minWidth: 0, ...line }}>{fullName(e)}</span>
            <TierMark tier={e.tier} size={12} />
          </div>
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink)', opacity: e.jobTitle ? 0.82 : 0.4, ...line }}>
            {e.jobTitle || '-'}
            {isHead && divName && <span style={{ color: `hsl(${divColor})`, fontWeight: 600 }}> · {divName} Lead</span>}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', ...line }}>
            {e.department || (ext ? '' : '-')}
            {ext && <span title={e.identityType === 'guest' ? 'Guest account (Microsoft 365 guest)' : 'External user (no Microsoft 365 login)'}>{e.department ? ' · External' : 'External'}</span>}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', ...line }}>{company || '-'}</div>
        </div>
      </div>
      <ReportsPill count={kids} collapsed={isCollapsed} onToggle={() => onToggle(email)}
        title={total > kids ? `${kids} direct report${kids === 1 ? '' : 's'}, ${total} in all` : undefined} />
    </div>
  );
}

// The person on the org chart (Neil, 11/03/2026): read only - who they
// report to, their title, department, company and division, their direct
// reports. Changes are made on their record (Open Record lands on the Job
// tab); dragging a card onto a manager on the chart still reassigns the
// reporting line right there. A sheet from the right (the shared Modal).
// Pass (11/07/2026): the sheet earns its width - the whole chain above them
// (each a step), the team in all, and Teams Message / Call.
function OrgSidePanel({ e, people, externals = [], entityName, inheritedDivision, myEmail = '', mobile = false, onClose, onSelect, onOpenRecord }) {
  const ext = isExternalPerson(e);
  const email = (e.workEmail || '').toLowerCase();
  const everyone = [...people, ...externals];
  const find = (em) => em ? everyone.find(p => (p.workEmail || '').toLowerCase() === em) : null;
  const chain = [];
  for (let cur = find((e.managerEmail || '').toLowerCase()), hops = 0; cur && hops < 20; hops++) {
    chain.push(cur);
    cur = find((cur.managerEmail || '').toLowerCase());
  }
  const reports = people.filter(p => (p.managerEmail || '').toLowerCase() === email && email);
  const kidsOf = (p) => people.filter(k => (k.managerEmail || '').toLowerCase() === (p.workEmail || '').toLowerCase() && p.workEmail);
  const inAll = reports.length ? countBelow(e, kidsOf) : 0;
  const division = (e.division || '').trim();
  const inherited = (inheritedDivision || '').trim();
  const company = ext ? (e.externalCompany || '') : (e.company ? entityName(e.company) : '');
  const row = (label, value) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) 1fr', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--line)', fontSize: 13.5 }}>
      <span style={{ color: 'var(--muted)', fontWeight: 500, fontSize: 12.5 }}>{label}</span>
      <span style={{ color: value ? 'var(--ink)' : 'var(--muted)', minWidth: 0, overflowWrap: 'anywhere' }}>{value || '-'}</span>
    </div>
  );
  const step = (p) => (
    <button key={p.id} type="button" onClick={() => onSelect(p)}
      style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'var(--ink)', textDecoration: 'underline', textUnderlineOffset: 3, textDecorationColor: 'var(--line)' }}>
      {fullName(p)}
    </button>
  );
  return (
    <Modal title={fullName(e)} onClose={onClose} zIndex={4000}
      footer={<>
        <button className="secondary-btn" onClick={onClose}>Close</button>
        {onOpenRecord && (
          <button className="primary-btn" onClick={() => { onOpenRecord(e); onClose(); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ExternalLink size={14} /> Open Record
          </button>
        )}
      </>}>
      <div style={{ fontFamily: 'Inter,sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8 }}>
          <Avatar e={e} size={52} card={false} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              {[e.jobTitle, e.department].filter(Boolean).join(' · ') || '-'}{ext ? ' · External' : ''}
            </div>
            {e.workEmail && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{e.workEmail}</div>}
          </div>
          <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
            <PersonActions email={e.workEmail} name={fullName(e)} external={ext} myEmail={myEmail} variant="pill" />
          </div>
        </div>
        {row('Reports To', chain.length
          ? <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 6px' }}>
              {chain.map((p, i) => <span key={p.id} style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline' }}>{i > 0 && <span style={{ color: 'var(--muted)' }}>then</span>}{step(p)}</span>)}
            </span>
          : (e.managerEmail || 'No manager - top of a tree'))}
        {row('Job Title', e.jobTitle)}
        {row('Department', e.department)}
        {row('Company', company)}
        {row('Division', division ? `Lead of ${division}` : inherited ? `${inherited} (from their manager)` : '')}
        {reports.length > 0 && row('Team', `${reports.length} direct report${reports.length === 1 ? '' : 's'}${inAll > reports.length ? `, ${inAll} in all` : ''}`)}
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10, lineHeight: 1.5 }}>
          Change any of these on their record.{mobile ? '' : ' To move someone to a new manager, drag their card onto that manager on the chart.'}
        </div>

        {reports.length > 0 && (
          <>
            <div style={{ fontSize: 13, fontWeight: 600, margin: '18px 0 8px' }}>Direct Reports ({reports.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {reports.map(p => (
                <button key={p.id} onClick={() => onSelect(p)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', border: 'none', borderBottom: '1px solid var(--line)', background: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'Inter,sans-serif' }}>
                  <Avatar e={p} size={28} card={false} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{fullName(p)}</span>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>{p.jobTitle || p.department || ''}</span>
                  </span>
                  <ChevronRight size={13} style={{ color: 'var(--muted)' }} />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// The phone's chart (Neil, 11/07/2026): no canvas under 641px - the
// reporting line as an indented list, a tap opens the person, the chevron
// folds a team. Reports To is set on the record or by HR on a computer.
function OrgListRows({ nodes, depth = 0, childrenOf, collapsed, onToggle, onSelect, keyOf, selectedId, currentId = '', entityName }) {
  return nodes.map(n => {
    const kids = childrenOf(n);
    const key = keyOf(n);
    const open = kids.length > 0 && !collapsed.has(key);
    return (
      <div key={key}>
        <div data-email={(n.workEmail || '').toLowerCase()} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 8px 9px 0', paddingLeft: 8 + depth * 18, borderBottom: '1px solid var(--line)',
          background: selectedId === n.id ? 'hsla(var(--color-green),0.08)' : currentId === n.id ? 'hsla(var(--color-blue),0.08)' : 'transparent' }}>
          {kids.length > 0
            ? <button type="button" onClick={() => onToggle(key)} aria-label={open ? `Hide ${kids.length} reports` : `Show ${kids.length} reports`} aria-expanded={open}
                style={{ width: 28, height: 28, border: 'none', background: 'none', color: 'var(--muted)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, flex: 'none' }}>
                {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
            : <span aria-hidden="true" style={{ width: 28, flex: 'none' }} />}
          <button type="button" onClick={() => onSelect(n)} style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, border: 'none', background: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', font: 'inherit' }}>
            <Avatar e={n} size={34} card={false} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fullName(n)}</span>
              <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {[n.jobTitle, isExternalPerson(n) ? n.externalCompany : entityName(n.company)].filter(Boolean).join(' · ') || '-'}
              </span>
            </span>
            {kids.length > 0 && <span style={{ fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{kids.length}</span>}
          </button>
        </div>
        {open && <OrgListRows nodes={kids} depth={depth + 1} childrenOf={childrenOf} collapsed={collapsed} onToggle={onToggle} onSelect={onSelect} keyOf={keyOf} selectedId={selectedId} currentId={currentId} entityName={entityName} />}
      </div>
    );
  });
}

// The people with no manager, beside the chart (Neil, 11/07/2026) - each
// with a Reports To picker, so nobody has to drag a card up a scrolling
// page. A row can still be dragged onto a manager on the chart.
function NoManagerDock({ people, rows, dnd, onSetManager, onSelect, selectedId, entityName, mobile = false, below = false }) {
  return (
    <aside aria-label="No manager" style={{ width: below ? '100%' : 272, flex: 'none', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--card)', padding: '12px 14px', alignSelf: below ? 'stretch' : 'flex-start', maxHeight: below ? 'none' : 'max(360px, calc(100vh - 240px))', overflowY: 'auto', boxSizing: 'border-box' }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>No Manager <span style={{ color: 'var(--muted)', fontWeight: 500 }}>{people.length}</span></div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2, marginBottom: 6, lineHeight: 1.4 }}>Pick who they report to{mobile ? '' : ', or drag them onto a manager'}.</div>
      <div style={below ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', columnGap: 20 } : undefined}>
      {people.map(e => {
        const email = (e.workEmail || '').toLowerCase();
        return (
          <div key={e.id} data-email={email} className="nx-orgcard" style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
            <div role="button" tabIndex={0} data-orgtile="1" aria-label={`${fullName(e)}${e.jobTitle ? `, ${e.jobTitle}` : ''}`}
              onPointerDown={mobile ? undefined : ev => dnd.onCardPointerDown(ev, e)} onClick={mobile ? () => onSelect(e) : undefined}
              onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(e); } }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: mobile ? 'pointer' : 'grab', marginBottom: 8, touchAction: 'none', userSelect: 'none',
                outline: selectedId === e.id ? '2px solid hsl(var(--color-green))' : 'none', outlineOffset: 4, borderRadius: 6, opacity: dnd.draggingId === e.id ? 0.4 : 1 }}>
              <Avatar e={e} size={34} card={false} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fullName(e)}</span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[e.jobTitle, entityName(e.company)].filter(Boolean).join(' · ') || '-'}</span>
              </span>
            </div>
            <PersonSelect value={null} onChange={v => v && onSetManager(e, v)} people={rows.filter(r => r.email !== email)} allowNone={false}
              placeholder="Reports to" ariaLabel={`Reports To for ${fullName(e)}`} style={{ height: 34, borderRadius: 8, fontSize: 13 }} />
          </div>
        );
      })}
      </div>
    </aside>
  );
}

const ORG_EXTERNALS_KEY = 'nx-orgchart-externals';
function OrgChartTab({ employees, externals = [], entities = [], onUpdated, onOpenRecord, toastOk, toastErr }) {
  // External users on the chart is an option (Neil, Oct 14 2026): off by
  // default, remembered per device. On, every external with a work email
  // joins the tree under whoever they report to, with a clear External
  // designation on their card.
  const [includeExternal, setIncludeExternal] = useState(() => { try { return localStorage.getItem(ORG_EXTERNALS_KEY) === 'true'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(ORG_EXTERNALS_KEY, String(includeExternal)); } catch { /* storage blocked */ } }, [includeExternal]);
  // Two charts, one tab (Neil, Aug 11): the reporting tree, and the investor
  // book grouped by relationship owner - investors don't report to anyone.
  const { myEmail: viewerEmail } = useRole();
  const mobile = useIsMobile(640);                      // the phone gets a list, not a canvas
  const narrow = useIsMobile(1499);                     // the No Manager dock sits below the chart, not beside it
  const [draggingId, setDraggingId] = useState(null);
  const [overKey, setOverKey] = useState(null); // target workEmail, or '__none__' for the clear zone
  const [selected, setSelected] = useState(null);        // side-panel person
  const [orgQ, setOrgQ] = useState('');                   // name/title search
  const [orgCompany, setOrgCompany] = useState('');       // entity id filter
  const [orgDept, setOrgDept] = useState('');             // department filter
  const [collapsedSet, setCollapsedSet] = useState(new Set());
  const [seeded, setSeeded] = useState(false);
  const [activeDiv, setActiveDiv] = useState('');   // legend highlight filter
  const [dragGhost, setDragGhost] = useState(null);   // {name, x, y} while dragging a card
  const chartRef = useRef(null);                      // the shared canvas: centerView / fitToView / focusOn / bounds
  const dragRef = useRef(null);
  // Externals are active / inactive / staged (never offboarded): only the
  // active ones belong on the chart or in the toggle's count.
  const liveExternals = externals.filter(e => (e.status || 'active') === 'active');
  const people = [...employees.filter(e => e.status !== 'offboarded'), ...(includeExternal ? liveExternals : [])];

  // First render (Neil, 11/07/2026): the whole company, fitted. Leaves stack
  // under their manager now, so even 60 people are one readable screen; past
  // that, teams below the third level start folded behind their count.
  useEffect(() => {
    if (seeded || !people.length) return;
    const folded = new Set();
    if (people.length > 60) {
      const byMail = new Map(people.map(p => [(p.workEmail || '').toLowerCase(), p]));
      const depthOf = (p) => { let d = 0, cur = p; while (cur && (cur.managerEmail || '') && byMail.has((cur.managerEmail || '').toLowerCase()) && d < 30) { cur = byMail.get((cur.managerEmail || '').toLowerCase()); d++; } return d; };
      for (const p of people) {
        const em = (p.workEmail || '').toLowerCase();
        if (em && depthOf(p) >= 3 && people.some(k => (k.managerEmail || '').toLowerCase() === em)) folded.add(em);
      }
    }
    setCollapsedSet(folded);
    setSeeded(true);
  }, [people, seeded]);
  const emails = new Set(people.map(e => (e.workEmail || '').toLowerCase()).filter(Boolean));
  const byEmail = new Map(people.map(e => [(e.workEmail || '').toLowerCase(), e]));
  const childrenMap = new Map();
  for (const e of people) {
    const m = (e.managerEmail || '').toLowerCase();
    if (m && emails.has(m)) {
      if (!childrenMap.has(m)) childrenMap.set(m, []);
      childrenMap.get(m).push(e);
    }
  }

  // Everyone below `email` in the tree - used to refuse drops that would loop
  function descendants(email) {
    const seen = new Set();
    const queue = [email];
    while (queue.length) {
      for (const kid of childrenMap.get(queue.pop()) || []) {
        const ke = (kid.workEmail || '').toLowerCase();
        if (ke && !seen.has(ke)) { seen.add(ke); queue.push(ke); }
      }
    }
    return seen;
  }

  async function drop(targetEmail, dragged) {
    setDraggingId(null); setOverKey(null);
    if (!dragged) return;
    if (targetEmail === '__none__') {
      if (!dragged.managerEmail) return;
      targetEmail = '';
    } else {
      const target = byEmail.get(targetEmail);
      if (!target || target.id === dragged.id) return;
      if ((dragged.managerEmail || '').toLowerCase() === targetEmail) return;
      const myEmail = (dragged.workEmail || '').toLowerCase();
      if (myEmail && descendants(myEmail).has(targetEmail)) {
        toastErr(`${fullName(target)} reports up to ${fullName(dragged)} - that would create a loop.`);
        return;
      }
    }
    const before = dragged.managerEmail || '';
    try {
      const saved = await api.updateEmployee(dragged.id, { manager_email: targetEmail });
      onUpdated(saved);
      // Every change can be taken back (11/07/2026): the toast carries Undo,
      // which puts the previous manager back.
      dialog.undo(targetEmail
        ? `${fullName(dragged)} now reports to ${fullName(byEmail.get(targetEmail))}.`
        : `${fullName(dragged)} removed from the reporting line.`,
      async () => {
        try { onUpdated(await api.updateEmployee(dragged.id, { manager_email: before })); }
        catch (err) { toastErr(err?.message || 'Could not put it back.'); }
      });
    } catch (err) { toastErr(err?.message || 'Could not change the reporting line.'); }
  }

  // Pointer-based drag (works with mouse AND touch - native HTML5 drag does
  // neither on a touch display). A small threshold distinguishes a tap (opens
  // the side panel) from a drag; while dragging we track the card under the
  // pointer via elementFromPoint (robust through the zoom transform) and show a
  // floating name ghost. Drop on a card = re-assign; on the detach zone = unlink.
  const onCardPointerDown = (ev, person) => {
    if (ev.button != null && ev.button > 0) return;   // primary button / touch only
    const start = { x: ev.clientX, y: ev.clientY };
    dragRef.current = { person, start, dragging: false, target: null };
    const move = (m) => {
      const st = dragRef.current; if (!st) return;
      if (!st.dragging) {
        if (Math.hypot(m.clientX - start.x, m.clientY - start.y) < 6) return;
        st.dragging = true; setDraggingId(st.person.id);
      }
      st.last = { x: m.clientX, y: m.clientY };
      const el = document.elementFromPoint(m.clientX, m.clientY);
      const detach = el && el.closest ? el.closest('[data-detach]') : null;
      const card = el && el.closest ? el.closest('[data-email]') : null;
      let em = card && card.getAttribute('data-email');
      // Forgiving drops (Visesh, Aug 11): a drop doesn't have to land ON a
      // card - snap to the nearest card within reach, so "put them roughly
      // there" works. Excludes the dragged person's own card.
      if (!detach && (!em || em === (st.person.workEmail || '').toLowerCase())) {
        let best = null, bestD = 130;   // screen px reach
        for (const node of document.querySelectorAll('[data-email]')) {
          const ne = node.getAttribute('data-email');
          if (!ne || ne === (st.person.workEmail || '').toLowerCase()) continue;
          const r = node.getBoundingClientRect();
          const dx = Math.max(r.left - m.clientX, 0, m.clientX - r.right);
          const dy = Math.max(r.top - m.clientY, 0, m.clientY - r.bottom);
          const d = Math.hypot(dx, dy);
          if (d < bestD) { bestD = d; best = ne; }
        }
        em = best;
      }
      st.target = detach ? '__none__'
        : (em && em !== (st.person.workEmail || '').toLowerCase()) ? em : null;
      setOverKey(st.target);
      setDragGhost({ name: fullName(st.person), x: m.clientX, y: m.clientY });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const st = dragRef.current; dragRef.current = null;
      setDragGhost(null);
      if (st && st.dragging) {
        if (st.target) {
          drop(st.target, st.person);
        } else {
          // Dropped in open space, beyond snapping reach of any card: that IS
          // the gesture for "take them out of the reporting line" - but only
          // inside the chart canvas, so releasing over the toolbar is a no-op.
          const c = chartRef.current && st.last ? chartRef.current.bounds() : null;
          const inCanvas = c && st.last.x >= c.left && st.last.x <= c.right
            && st.last.y >= c.top && st.last.y <= c.bottom;
          if (inCanvas && st.person.managerEmail) drop('__none__', st.person);
          else { setDraggingId(null); setOverKey(null); }
        }
      } else if (st) {
        setSelected(st.person);    // no meaningful movement → treat as a tap
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const dnd = { draggingId, setDraggingId, overKey, setOverKey, drop, onCardPointerDown };
  // Managers (people with reports) before leaves, then alphabetical - keeps
  // wide sibling rows readable
  const kidCount = e => (childrenMap.get((e.workEmail || '').toLowerCase()) || []).length;
  for (const arr of childrenMap.values()) {
    arr.sort((a, b) => (kidCount(b) - kidCount(a)) || fullName(a).localeCompare(fullName(b)));
  }
  // Busacta-style: the unlinked are surfaced below the chart (No Manager), not hidden.

  // ── Functional divisions: a person's division is their own head-tag, else
  // inherited from the nearest tagged manager up the chain. Memoised per email.
  const divisionNames = [...new Set(people.map(e => (e.division || '').trim()).filter(Boolean))].sort();
  const divColor = name => divColorFor(name, divisionNames);
  // Resolved for everyone up front (the cards render inside the shared
  // canvas later, and must not mutate anything of this render then).
  // Every person walked through on the way up takes the answer - not only
  // the lead it ended on (11/03/2026: only leads were ever colored, so a
  // division's color never reached its people and every legend count was 1).
  const _divCache = new Map();
  const _resolveDivision = (person) => {
    const path = [];
    let cur = person, hops = 0, found = '';
    while (cur && hops < 30) {
      const em = (cur.workEmail || '').toLowerCase();
      if (em && _divCache.has(em)) { found = _divCache.get(em); break; }
      if (em) path.push(em);
      const own = (cur.division || '').trim();
      if (own) { found = own; break; }
      const mgr = (cur.managerEmail || '').toLowerCase();
      if (!mgr || !byEmail.has(mgr)) break;
      cur = byEmail.get(mgr); hops++;
    }
    for (const em of path) _divCache.set(em, found);
    return found;
  };
  for (const p of people) _resolveDivision(p);
  const divisionOf = (person) => _divCache.get((person.workEmail || '').toLowerCase()) || '';
  const divisionCounts = {};
  for (const p of people) { const d = divisionOf(p); if (d) divisionCounts[d] = (divisionCounts[d] || 0) + 1; }

  // ── Filters: company (live from the entities table), department, name search.
  // Filtering rebuilds the tree from the filtered set - unmatched managers drop
  // out and their matching reports surface as roots.
  const departments = [...new Set(people.map(e => e.department).filter(Boolean))].sort();
  const q = orgQ.trim().toLowerCase();
  // Company/department FILTER the tree; search FINDS within it (expand + center
  // + highlight) - filtering by name would amputate the person's whole subtree.
  // An external has no entity of ours: for the company filter they belong
  // where the person they report to belongs.
  const companyOf = e => isExternalPerson(e) ? (byEmail.get((e.managerEmail || '').toLowerCase())?.company || '') : e.company;
  const visible = people.filter(e =>
    (!orgCompany || companyOf(e) === orgCompany) &&
    (!orgDept || e.department === orgDept));
  const visEmails = new Set(visible.map(e => (e.workEmail || '').toLowerCase()).filter(Boolean));
  const visChildren = new Map();
  for (const e of visible) {
    const m = (e.managerEmail || '').toLowerCase();
    if (m && visEmails.has(m)) {
      if (!visChildren.has(m)) visChildren.set(m, []);
      visChildren.get(m).push(e);
    }
  }
  for (const arr of visChildren.values()) {
    arr.sort((a, b) => ((visChildren.get((b.workEmail || '').toLowerCase()) || []).length
      - (visChildren.get((a.workEmail || '').toLowerCase()) || []).length)
      || fullName(a).localeCompare(fullName(b)));
  }
  const visHasManager = e => (e.managerEmail || '') && visEmails.has((e.managerEmail || '').toLowerCase());
  const visChildrenOf = (e) => visChildren.get((e.workEmail || '').toLowerCase()) || [];
  // Team size under each person (direct and indirect), for the count's
  // "in all" and for putting the biggest tree first.
  const totals = new Map();
  for (const e of visible) totals.set(e.id, countBelow(e, visChildrenOf));
  // The biggest tree leads, so the chart opens on the company's own top and
  // the smaller separate trees follow it to the right.
  const visRoots = visible.filter(e => !visHasManager(e) && visChildrenOf(e).length > 0)
    .sort((a, b) => (totals.get(b.id) - totals.get(a.id)) || fullName(a).localeCompare(fullName(b)));
  const visUnlinked = visible.filter(e => !visHasManager(e) && !(visChildren.get((e.workEmail || '').toLowerCase()) || []).length);
  const entityName = id => (entities || []).find(en => en.id === id)?.name || '';
  const filtered = !!(orgCompany || orgDept || q);

  const toggle = (email) => setCollapsedSet(s => {
    const n = new Set(s);
    if (n.has(email)) n.delete(email); else n.add(email);
    return n;
  });

  // Search finds by name or title, everyone who matches - Enter (or the
  // arrows beside the box) steps through them, biggest trees first.
  const matchesQ = (e) => !!q && (fullName(e).toLowerCase().includes(q) || (e.jobTitle || '').toLowerCase().includes(q));
  const matches = q ? visible.filter(matchesQ) : [];
  const [matchIdx, setMatchIdx] = useState(0);
  const isHighlight = matchesQ;
  const onUnlink = (person) => drop('__none__', person);
  // Keyed by work email (what collapse, search and drag use); someone with
  // no work email yet falls back to their record id so siblings never share
  // a key. They can have no reports - reports are filed under an email.
  const keyOf = (e) => (e.workEmail || '').toLowerCase() || `id:${e.id}`;
  const childrenOf = (e) => visChildren.get((e.workEmail || '').toLowerCase()) || [];
  const renderCard = (e, meta) => {
    const div = divisionOf(e);
    return (
      <OrgNodeCard e={e} kids={meta.kids} total={totals.get(e.id) || 0} isCollapsed={meta.collapsed}
        onToggle={toggle} onSelect={setSelected} dnd={dnd}
        entityName={entityName} highlight={isHighlight(e)}
        current={!!matchKey && e.id === matchKey} selected={!!selected && selected.id === e.id}
        divName={div} divColor={divColor(div)} isHead={!!(e.division || '').trim()}
        dim={activeDiv && div !== activeDiv}
        onUnlink={e.managerEmail ? onUnlink : null} />
    );
  };

  // The canvas never overflows the page; you pan/zoom within it. It opens
  // fitted when the whole company reads at that size, else at 80% on the top
  // of the biggest tree (a 49-person company fits a wide screen, and pans on
  // a laptop); Fit is a button. Refits on a filter change.
  const fit = () => setTimeout(() => {
    const c = chartRef.current;
    if (!c) return;
    if (c.fitToView({ min: 0.7 })) return;
    c.zoomTo(0.8);
    const top = visRoots[0];
    if (top) setTimeout(() => chartRef.current && chartRef.current.focusOn(keyOf(top), { align: 'top' }), 60);
  }, 60);
  useEffect(() => { if (seeded) fit(); }, [orgCompany, orgDept, seeded, includeExternal]); // eslint-disable-line react-hooks/exhaustive-deps
  const expandAll = () => { setCollapsedSet(new Set()); fit(); };
  const collapseAll = () => { setCollapsedSet(new Set([...visChildren.keys()])); fit(); };
  // Open every team between a person and the top, so their card can show.
  const reveal = (person) => {
    const chain = [];
    let cur = person, hops = 0;
    while (cur && (cur.managerEmail || '') && hops < 20) {
      const m = (cur.managerEmail || '').toLowerCase();
      if (!byEmail.has(m)) break;
      chain.push(m);
      cur = byEmail.get(m);
      hops++;
    }
    const me = (person.workEmail || '').toLowerCase();
    setCollapsedSet(s => { const n = new Set(s); chain.forEach(a => n.delete(a)); if (me) n.delete(me); return n; });
  };
  // A division's name in the legend spotlights it AND brings its lead into
  // view (11/07/2026: before, everything dimmed and nothing moved).
  const spotlight = (d) => {
    const on = activeDiv === d;
    setActiveDiv(on ? '' : d);
    if (on) return;
    const lead = visible.find(p => (p.division || '').trim() === d);
    if (!lead) return;
    reveal(lead);
    setTimeout(() => chartRef.current && chartRef.current.focusOn(keyOf(lead), { align: 'top' }), 80);
  };
  const pickerRows = pickRows(people);
  // Find Me opens every team above the viewer first, so a folded or deep
  // card still comes into view; someone not on the chart is told so.
  const findMe = () => {
    const me = byEmail.get((viewerEmail || '').toLowerCase());
    if (!me || !visEmails.has((me.workEmail || '').toLowerCase())) { toastErr('You are not on this chart.'); return; }
    reveal(me);
    setTimeout(() => chartRef.current && chartRef.current.focusOn(keyOf(me)), 80);
  };

  // Search = find & focus: expand every ancestor of the first match (plus the
  // match's own team), then glide the canvas so their card sits centre-stage.
  const matchKey = matches.length ? matches[matchIdx % matches.length].id : '';
  useEffect(() => {
    if (!q || !seeded) return;
    const match = matches[matchIdx % Math.max(1, matches.length)];
    if (!match) return;
    const byEmailAll = new Map(visible.map(p => [(p.workEmail || '').toLowerCase(), p]));
    const chain = [];
    let cur = match, hops = 0;
    while (cur && (cur.managerEmail || '') && hops < 20) {
      const m = (cur.managerEmail || '').toLowerCase();
      if (!byEmailAll.has(m)) break;
      chain.push(m);
      cur = byEmailAll.get(m);
      hops++;
    }
    const me = (match.workEmail || '').toLowerCase();
    setCollapsedSet(s => {
      const n = new Set(s);
      chain.forEach(a => n.delete(a));
      if (me) n.delete(me);              // show their own team too
      return n;
    });
    // Let the expansion render, then centre the card in the viewport.
    // Someone with no manager is in the No Manager list below the chart.
    const t = setTimeout(() => {
      if (!me || (chartRef.current && chartRef.current.focusOn(me))) return;
      document.querySelector(`[data-email="${CSS.escape(me)}"]`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }, 80);
    return () => clearTimeout(t);
  }, [q, seeded, matchKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const stepMatch = (d) => { if (matches.length) setMatchIdx(i => (i + d + matches.length) % matches.length); };


  if (!people.length) return (
    <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 8 }}>
      <Network size={32} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
      <div style={{ fontSize: 14, fontWeight: 600 }}>Add people first - the chart draws itself from each person's "Reports to".</div>
    </div>
  );
  const lineColorOf = (n) => { const d = divisionOf(n); return d ? `hsl(${divColor(d)})` : null; };
  const dock = visUnlinked.length > 0 && (
    <NoManagerDock people={visUnlinked} rows={pickerRows} dnd={dnd} onSetManager={(person, email) => drop(email, person)}
      onSelect={setSelected} selectedId={selected?.id} entityName={entityName} mobile={mobile} below={mobile || narrow} />
  );
  return (
    <div>
      {/* One toolbar row: find, the two filters, the externals option, the count. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="search-bar" style={{ flex: '1 1 240px', minWidth: 200, maxWidth: 380, height: 34 }}>
          <Search size={13} style={{ flexShrink: 0 }} />
          <input placeholder="Find a name or title…" aria-label="Find a person on the chart" value={orgQ} onChange={ev => { setOrgQ(ev.target.value); setMatchIdx(0); }}
            onKeyDown={ev => { if (ev.key === 'Enter') { ev.preventDefault(); stepMatch(ev.shiftKey ? -1 : 1); } else if (ev.key === 'Escape') setOrgQ(''); }} />
          {q && (
            <span aria-live="polite" style={{ flexShrink: 0, fontSize: 11.5, color: matches.length ? 'var(--muted)' : 'hsl(var(--color-red))', whiteSpace: 'nowrap' }}>
              {matches.length ? `${(matchIdx % matches.length) + 1} of ${matches.length}` : 'No match'}
            </span>
          )}
          {matches.length > 1 && (
            <>
              <button type="button" onClick={() => stepMatch(-1)} aria-label="Previous match" title="Previous (Shift+Enter)" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><ChevronUp size={14} /></button>
              <button type="button" onClick={() => stepMatch(1)} aria-label="Next match" title="Next (Enter)" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><ChevronDown size={14} /></button>
            </>
          )}
          {orgQ && <button type="button" aria-label="Clear search" onClick={() => setOrgQ('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><X size={13} /></button>}
        </div>
        <select className="form-input" value={orgCompany} onChange={ev => setOrgCompany(ev.target.value)} aria-label="Company"
          style={{ width: 160, flex: '0 0 auto', fontSize: 12.5, fontWeight: 500, padding: '7px 26px 7px 10px', height: 34 }}>
          <option value="">All Companies</option>
          {(entities || []).map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
        </select>
        <select className="form-input" value={orgDept} onChange={ev => setOrgDept(ev.target.value)} aria-label="Department"
          style={{ width: 160, flex: '0 0 auto', fontSize: 12.5, fontWeight: 500, padding: '7px 26px 7px 10px', height: 34 }}>
          <option value="">All Departments</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        {/* External users (guests, contractors, outside managers) are an
            option on the chart - off by default, remembered per device. */}
        {liveExternals.length > 0 && (
          <button type="button" className="secondary-btn" aria-pressed={includeExternal} onClick={() => setIncludeExternal(v => !v)}
            title="Show external users (guests and contractors) on the chart, under whoever they report to"
            style={{ fontSize: 12.5, height: 34, flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 6,
              ...(includeExternal ? { borderColor: 'var(--ink)', color: 'var(--ink)', background: 'var(--mist)' } : {}) }}>
            External Users <span style={{ color: 'var(--muted)', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{liveExternals.length}</span>
          </button>
        )}
        <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: '0 0 auto', whiteSpace: 'nowrap', marginLeft: 'auto' }}>
          {visible.length}{filtered ? ` of ${people.length}` : ''} people
          {visUnlinked.length > 0 && ` · ${visUnlinked.length} with no manager`}
        </span>
      </div>

      {/* Division legend - a dot, the name, its count: click one to spotlight
          that division (its lead comes into view, the rest dims). The colors
          match the connectors under each lead. */}
      {divisionNames.length > 0 && (
        <div role="group" aria-label="Divisions" style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginRight: 6 }}>Divisions</span>
          {divisionNames.map(d => {
            const on = activeDiv === d, col = divColor(d);
            return (
              <button key={d} type="button" onClick={() => spotlight(d)} aria-pressed={on}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 9px', border: 'none', borderRadius: 8, background: on ? 'var(--mist)' : 'none', cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 12.5, fontWeight: on ? 600 : 500, color: 'var(--ink)',
                  opacity: activeDiv && !on ? 0.45 : 1, transition: 'opacity 0.15s' }}>
                <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: `hsl(${col})` }} />
                {d}
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{divisionCounts[d] || 0}</span>
              </button>
            );
          })}
          {!mobile && <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>A division is set on its lead's record, under Job</span>}
        </div>
      )}

      {/* Detach zone appears only mid-drag - drag a card here to unlink it */}
      {draggingId && (
        <div data-detach="1"
          style={{ marginBottom: 10, border: `2px dashed ${overKey === '__none__' ? 'hsl(var(--color-red))' : 'var(--line)'}`, borderRadius: 8, padding: '10px 16px', textAlign: 'center', fontSize: 12.5, fontWeight: 600, color: overKey === '__none__' ? 'hsl(var(--color-red))' : 'var(--muted)', background: overKey === '__none__' ? 'hsla(var(--color-red),0.06)' : 'transparent' }}>
          Drag here to remove their reporting line
        </div>
      )}

      {mobile ? (
        <div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 8, background: 'var(--card)', padding: '0 10px', marginBottom: 12 }}>
            {visRoots.length
              ? <OrgListRows nodes={visRoots} childrenOf={childrenOf} collapsed={collapsedSet} onToggle={toggle} onSelect={setSelected} keyOf={keyOf} selectedId={selected?.id} currentId={matchKey} entityName={entityName} />
              : <div style={{ padding: 16, fontSize: 13, color: 'var(--muted)' }}>{visUnlinked.length ? 'No reporting lines yet - everyone is listed below.' : 'No one matches these filters.'}</div>}
          </div>
          {dock}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', gap: 12, alignItems: 'stretch' }}>
          {/* The chart canvas - drag empty space to pan, wheel / pinch / controls
              to zoom. Card drag is pointer-based (see onCardPointerDown), so it
              works with a finger and resolves the drop target through the zoom
              transform; a press on a card is never a pan. */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <OrgChartCanvas ref={chartRef} roots={visRoots} childrenOf={childrenOf} keyOf={keyOf} renderCard={renderCard}
              collapsed={collapsedSet} onToggle={toggle} ariaLabel="Organizational Chart" lineColorOf={lineColorOf}
              onExpandAll={expandAll} onCollapseAll={collapseAll} onFindMe={findMe}
              borderColor={draggingId ? 'hsl(var(--color-green))' : 'var(--line)'}
              emptyText={visUnlinked.length ? 'No reporting lines yet - everyone is listed beside the chart.' : 'No one matches these filters.'} />
          </div>
          {dock}
        </div>
      )}

      {/* Floating drag ghost - follows the pointer/finger while dragging a card */}
      {dragGhost && (
        <div style={{ position: 'fixed', left: dragGhost.x + 14, top: dragGhost.y + 8, zIndex: 2000, pointerEvents: 'none',
          background: 'var(--ink)', color: 'var(--card)', fontSize: 12, fontWeight: 600, padding: '5px 11px', borderRadius: 8,
          boxShadow: 'var(--shadow-lg)', whiteSpace: 'nowrap' }}>
          {dragGhost.name}
          <span style={{ opacity: 0.7, fontWeight: 500 }}>{overKey === '__none__' ? ' → unlink' : overKey ? ' → drop to re-assign' : ''}</span>
        </div>
      )}

      {selected && (
        <OrgSidePanel e={selected} people={people} externals={liveExternals} entityName={entityName} myEmail={viewerEmail} mobile={mobile}
          inheritedDivision={(selected.division || '').trim() ? '' : divisionOf(selected)}
          onClose={() => setSelected(null)} onSelect={setSelected} onOpenRecord={onOpenRecord} />
      )}
    </div>
  );
}

// The People > Leave tab (the Phase 6 leave tracker) is retired (Neil, Oct
// 27 2026): leave is requested, approved and balanced in Time Off. Its rows
// stay readable in People > Time > Time Off > Leave History (Before Time Off)
// - components/LeaveHistory.jsx - and old 'hr-leave' links land on Time Off.

// ── Main view ─────────────────────────────────────────────────────────────────
// ── Companies / legal entities manager (HR Section A) ────────────────────────
// Manage one company's department list (Neil: departments live within a company,
// custom per company - not a Nexus-wide hardcoded list).
export function CompanyDepartments({ entity, toastOk, toastErr }) {
  const [depts, setDepts] = useState(null);
  const [name, setName] = useState('');
  const [head, setHead] = useState('');          // department head for the one being added
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState(null);   // department being renamed
  const [editName, setEditName] = useState('');
  const cancelRef = useRef(false);   // set on Escape so the ensuing onBlur doesn't SAVE
  const [loadErr, setLoadErr] = useState(false);
  const qc = useQueryClient();
  // A dept add/rename/remove changes the choices in every people/department picker
  // and the directory's department labels - refresh the shared caches so they don't
  // show a stale name until the next reload.
  const refreshDirectory = () => qc.invalidateQueries({ queryKey: qk.peopleDirectory });
  const load = () => { setLoadErr(false); return api.getCompanyDepartments(entity.id).then(setDepts).catch(() => setLoadErr(true)); };
  useEffect(() => { setDepts(null); load(); }, [entity.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  // The department head (Oct 15 2026) is THE head everywhere - tickets, hiring,
  // equipment, the directory. Anyone in Nexus People, not only this company: a
  // shared function (IT, Finance) often serves several entities.
  const { data: people = [] } = usePeopleDirectory();
  const nameOf = (email) => people.find(p => (p.email || '').toLowerCase() === (email || '').toLowerCase())?.name || email;
  async function add() {
    const n = name.trim();
    if (!n || busy) return; setBusy(true);
    try { const list = await api.addCompanyDepartment(entity.id, n, head); setDepts(list); setName(''); setHead(''); refreshDirectory(); }
    catch (e) { toastErr(e?.message || 'Could not add department.'); }
    setBusy(false);
  }
  // Head AND backup (Neil, Oct 22: "there's usually a number one and a number
  // two"). HR / IT / Accounting checklist steps go to both.
  async function setDeptPerson(d, field, email) {
    const what = field === 'lead_email' ? 'head' : 'backup';
    try {
      setDepts(await api.updateCompanyDepartment(entity.id, d.id, { [field]: email }));
      toastOk?.(email ? `${nameOf(email)} is now the ${what} of ${d.name}.` : `${d.name} has no ${what} now.`);
    } catch (e) { toastErr(e?.message || `Could not set the ${what}.`); }
  }
  // Weather Calls (Neil, 10/29/2026): rain advisories and weather calls apply
  // only to the people of departments with this on - Construction by default.
  async function setWeather(d, on) {
    setDepts((list) => list.map((x) => (x.id === d.id ? { ...x, weather: on } : x)));
    try {
      setDepts(await api.updateCompanyDepartment(entity.id, d.id, { weather: on }));
      toastOk?.(on ? `Weather calls now apply to ${d.name}.` : `Weather calls no longer apply to ${d.name}.`);
    } catch (e) {
      setDepts((list) => list.map((x) => (x.id === d.id ? { ...x, weather: !on } : x)));
      toastErr(e?.message || 'Could not change Weather Calls.');
    }
  }
  const headPicker = (value, onPick, onClear, label) => value ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 12.5 }}>
      <EmailAvatar email={value} name={nameOf(value)} size={22} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={value}>{nameOf(value)}</span>
      <button onClick={onClear} title={`Clear ${label}`} aria-label={`Clear ${label}`}
        style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'grid', placeItems: 'center', width: 20, height: 20, borderRadius: '50%', padding: 0, flexShrink: 0 }}>
        <X size={12} />
      </button>
    </span>
  ) : <PersonSearchSelect placeholder={label.startsWith('backup') ? 'Backup (optional)' : 'Department head (optional)'} groups={[{ label: 'Nexus People', people }]} onPick={onPick} />;
  async function remove(d) {
    if (!await dialog.confirm(
      `Delete the "${d.name}" department? Anyone currently assigned to it will be left with no department - you can reassign them on their profile.`,
      { title: 'Delete department', confirmText: 'Delete', danger: true })) return;
    try { const list = await api.deleteCompanyDepartment(entity.id, d.id); setDepts(list); refreshDirectory(); }
    catch (e) { toastErr(e?.message || 'Could not remove department.'); }
  }
  async function rename(d) {
    const n = editName.trim();
    setEditId(null);
    if (!n || n === d.name) return;
    try {
      const list = await api.updateCompanyDepartment(entity.id, d.id, { name: n });
      setDepts(list);
      refreshDirectory();
      toastOk?.(`Renamed “${d.name}” to “${n}” - people already in it follow the new name.`);
    } catch (e) { toastErr(e?.message || 'Could not rename department.'); }
  }
  return (
    <div style={{ overflowY: 'auto', flex: 1, padding: '16px 22px' }}>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 14px' }}>
        Departments for <strong>{entity.name}</strong>. These are the only choices when picking a department for someone in this company.
        The department head is the one head Nexus uses everywhere: ticket escalations, hiring screening, equipment reminders and the Directory.
        The head and the backup both get the HR, IT and Accounting steps of every checklist, so set a backup for anyone who can be out.
        Weather Calls: rain advisories and weather calls apply only to the people of departments with it on - on for Construction by default.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <input className="form-input" style={{ flex: '1 1 180px' }} placeholder="e.g. Estimating" value={name}
          onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} maxLength={40} />
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>{headPicker(head, setHead, () => setHead(''), 'department head')}</div>
        <button className="primary-btn" onClick={add} disabled={!name.trim() || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!name.trim() || busy) ? 0.6 : 1 }}>
          <Plus size={14} /> Add
        </button>
      </div>
      {loadErr ? <ErrorBanner message="Couldn't load departments right now." onRetry={load} />
        : depts === null ? <LoadingState compact />
        : depts.length === 0 ? <div style={{ color: 'var(--muted)', fontSize: 13, padding: '10px 0' }}>No departments yet - add the first one above.</div>
        : (
          <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
            {depts.map(d => (
              <div key={d.id} style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', padding: '10px 12px', alignItems: 'center', borderBottom: '1px solid var(--line)' }}>
                <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                {editId === d.id ? (
                  <input className="form-input" autoFocus value={editName} maxLength={40}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur(); } if (e.key === 'Escape') { cancelRef.current = true; setEditId(null); } }}
                    onBlur={() => { if (cancelRef.current) { cancelRef.current = false; return; } rename(d); }}
                    style={{ fontSize: 13, padding: '4px 8px' }} />
                ) : (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                    <button onClick={() => { setEditId(d.id); setEditName(d.name); }} title={`Rename ${d.name}`} aria-label={`Rename ${d.name}`}
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'grid', placeItems: 'center', width: 22, height: 22, borderRadius: '50%', padding: 0, flexShrink: 0 }}
                      onMouseOver={e => { e.currentTarget.style.background = 'var(--paper)'; e.currentTarget.style.color = 'var(--ink)'; }}
                      onMouseOut={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--muted)'; }}>
                      <Pencil size={12} />
                    </button>
                  </span>
                )}
                </div>
                {[['lead_email', 'Head', d.leadEmail, `head of ${d.name}`], ['backup_email', 'Backup', d.backupEmail, `backup for ${d.name}`]].map(([field, cap, value, label]) => (
                  <div key={field} style={{ flex: '1 1 170px', minWidth: 0, display: 'grid', gap: 2 }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.3 }}>{cap}</span>
                    {headPicker(value, (email) => setDeptPerson(d, field, email), () => setDeptPerson(d, field, ''), label)}
                  </div>
                ))}
                <label data-dept-weather={d.id} title="Rain advisories and weather calls apply to this department's people. On for Construction by default."
                  style={{ flex: '0 1 auto', display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.3 }}>Weather Calls</span>
                  <Switch checked={!!d.weather} onChange={(on) => setWeather(d, on)} label={`Weather Calls for ${d.name}`} />
                </label>
                <button onClick={() => remove(d)} title={`Remove ${d.name}`} aria-label={`Remove ${d.name}`}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'grid', placeItems: 'center', width: 24, height: 24, borderRadius: '50%', padding: 0 }}
                  onMouseOver={e => { e.currentTarget.style.background = 'hsla(var(--color-red),0.14)'; e.currentTarget.style.color = 'hsl(var(--color-red))'; }}
                  onMouseOut={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--muted)'; }}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// Tabs inside a company's full-screen editor - Overview is the form that used
// to be the whole modal; Departments/Work Sites/Holidays used to be separate
// entry points (a second modal, or nothing yet) and are now sub-tabs of the
// same "manage this company" screen, since a company has too much on it for
// a popup (Pranshu, Sep 18).
const COMPANY_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'monitoring', label: 'Workforce Analytics Policy' },
  { key: 'departments', label: 'Departments' },
  { key: 'sites', label: 'Locations' },
  { key: 'holidays', label: 'Holiday Calendar' },
  // Checklist set-up lives with the company (Neil, Oct 19: "it should
  // absolutely be under company because every company operates very differently").
  { key: 'checklists', label: 'Checklists' },
];
const COMPANY_ROLES_TAB = { key: 'roles', label: 'Roles' };

// Settings merged into one tab (Neil, Oct 23 2026): `entityId` opens the page
// on that company (the shell's scope picker chose it, so no Back button and
// no title of its own), `tabs` limits it to the tabs the shell's subject
// asked for (Profile / Departments / Holiday Calendar under Companies, the
// sites under Locations, Roles under People & Access...), `onOpen` is what
// the list's Edit does instead of opening in place, and `onDirtyChange`
// tells the shell the Overview form has unsaved edits.
export function CompanySetupPage({ entities, employees = [], sites = [], onChangedEntities, onChangedSites, toastOk, toastErr,
  entityId = '', tabs = null, onOpen, onDirtyChange }) {
  // linkedin_url is deliberately NOT in this form state (Sep 18: removed from
  // the UI) - omitting the key means an update PATCH never sends it, so
  // Pydantic's exclude_unset leaves whatever a company already has in the DB
  // untouched (still rendered in signatures); this form just stops offering
  // a way to view/set it.
  const blank = { name: '', legal_name: '', country: '', region: '', tax_id: '', physical_address: '', mailing_address: '', signatory: '', signatory_email: '', notes: '', domains: '', manager_emails: [], hr_contact_email: '', it_contact_email: '', invoice_recipients: '', logo_url: '', website: '', main_phone: '', main_phone_type: 'phone', main_phone_country: 'US', facebook_url: '', twitter_url: '', instagram_url: '' };
  const [mode, setMode] = useState(null);   // null = list · 'new' · <id> editing
  const [tab, setTab] = useState('overview');
  const { can, hrScope } = useRole();
  // Company-wide People access (hr_scope null). A caller limited to some
  // companies (or to a manager's own team) edits their companies' profiles
  // but never adds or deletes a company, sets the group manager or changes
  // email domains - the server refuses those (_require_unrestricted).
  const companyWide = !Array.isArray(hrScope);
  const allTabs = can('administrator') ? [...COMPANY_TABS, COMPANY_ROLES_TAB] : COMPANY_TABS;
  const companyTabs = tabs ? allTabs.filter(t => tabs.includes(t.key)) : allTabs;
  const firstTab = companyTabs[0]?.key || 'overview';
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  // People directory for the manager pickers + the group manager (one person
  // above all companies; stored server-side as a singleton setting).
  const { data: people = [] } = usePeopleDirectory();
  const [groupMgr, setGroupMgr] = useState('');
  const [groupMgrBusy, setGroupMgrBusy] = useState(false);
  useEffect(() => {
    if (!companyWide) return;
    api.getGroupManager().then(r => setGroupMgr(r?.email || '')).catch(() => {});
  }, [companyWide]);
  // Company Manager(s) may also be external users (Sep 29) - offered in their
  // own group of the picker. HR Contact and the group manager stay Nexus People.
  const { data: withExternal = [] } = usePeopleDirectoryWithExternal();
  const externals = withExternal.filter(p => p.external);
  const personName = email => [...people, ...externals].find(p => (p.email || '').toLowerCase() === (email || '').toLowerCase())?.name || '';
  const isExternal = email => externals.some(p => (p.email || '').toLowerCase() === (email || '').toLowerCase());
  async function saveGroupMgr(email) {
    setGroupMgr(email); setGroupMgrBusy(true);
    try { await api.setGroupManager(email); toastOk(email ? 'Group manager set.' : 'Group manager cleared.'); }
    catch (e) { toastErr(e?.message || 'Could not save group manager.'); }
    setGroupMgrBusy(false);
  }
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const formSnapshotRef = useRef(blank);
  const startNew = () => { setF(blank); formSnapshotRef.current = blank; setTab('overview'); setMode('new'); };
  const startEdit = en => {
    // Fax/telephone are gone from the picker (Neil, Sep 22: "let's not add
    // bloat... nobody is faxing anymore") - a row saved under one of those
    // types before the change just gets treated as a plain phone number now,
    // number and all, rather than the form having to still offer them.
    const phoneType = 'phone';
    // "phone" numbers store the dial code baked into mainPhone itself
    // ("+1 7003313331") - split it back apart here so the country picker and
    // number box seed correctly. No match just means the stored value
    // predates this format, or was fax/telephone (never had a dial code) - it
    // lands whole in the number box, country defaults to US.
    let phoneCountry = 'US', phoneNumber = en.mainPhone || '';
    if (en.mainPhoneType === 'phone' && en.mainPhone) {
      const hit = COUNTRIES.find(c => en.mainPhone.startsWith(c.dial + ' '));
      if (hit) { phoneCountry = hit.code; phoneNumber = en.mainPhone.slice(hit.dial.length + 1); }
    }
    const seeded = { name: en.name, legal_name: en.legalName || '', country: en.country || '', region: en.region || '', tax_id: en.taxId || '',
      physical_address: en.physicalAddress || '', mailing_address: en.mailingAddress || '',
      signatory: en.signatory || '', signatory_email: en.signatoryEmail || '', notes: en.notes || '', domains: en.domains || '',
      manager_emails: en.managerEmails && en.managerEmails.length ? en.managerEmails : (en.managerEmail ? [en.managerEmail] : []),
      hr_contact_email: en.hrContactEmail || '',
      it_contact_email: en.itContactEmail || '',
      invoice_recipients: (en.invoiceRecipients || []).join(', '),
      logo_url: en.logoUrl || '', website: en.website || '', main_phone: phoneNumber, main_phone_type: phoneType, main_phone_country: phoneCountry, facebook_url: en.facebookUrl || '', twitter_url: en.twitterUrl || '', instagram_url: en.instagramUrl || '' };
    setF(seeded); formSnapshotRef.current = seeded; setTab(firstTab); setMode(en.id);
  };
  // Opened on a company by the shell: follow it (and a later switch of the
  // scope picker); a refresh of the same company keeps the form as it is.
  useEffect(() => {
    if (!entityId) return;
    const en = entities.find(e => e.id === entityId);
    if (en && mode !== entityId) startEdit(en);
  }, [entityId, entities]); // eslint-disable-line react-hooks/exhaustive-deps
  async function uploadLogo(file) {
    if (!file || mode === 'new') return;   // logo needs a saved company id - save first
    setLogoBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const updated = await api.uploadEntityLogo(mode, form);
      set('logo_url', updated.logoUrl || '');
      formSnapshotRef.current = { ...formSnapshotRef.current, logo_url: updated.logoUrl || '' };
      await onChangedEntities(); toastOk('Logo uploaded.');
    } catch (e) { toastErr(e?.message || 'Could not upload logo.'); }
    setLogoBusy(false);
  }
  const editingEntity = (mode && mode !== 'new') ? entities.find(e => e.id === mode) : null;

  async function save() {
    if (!f.name.trim() || busy) return; setBusy(true);
    try {
      // main_phone_country is UI-only (drives the dropdown) - the dial code
      // gets baked into main_phone itself before it's sent, so the backend
      // never needs to know the country/dial-code mapping.
      const { main_phone_country, ...rest } = f;
      const dial = COUNTRIES.find(c => c.code === main_phone_country)?.dial || '';
      const payload = {
        ...rest,
        main_phone: f.main_phone_type === 'phone' && f.main_phone.trim() ? `${dial} ${f.main_phone.trim()}` : f.main_phone.trim(),
        invoice_recipients: (f.invoice_recipients || '').split(/[,\s;]+/).filter(Boolean),
      };
      // Domains only when they changed: they re-tag untagged people, and a
      // company-limited caller may not change them at all.
      if (mode !== 'new' && (!companyWide || f.domains === formSnapshotRef.current.domains)) delete payload.domains;
      if (mode === 'new') await api.createEntity(payload); else await api.updateEntity(mode, payload);
      await onChangedEntities(); toastOk('Company saved.'); setMode(null);
    } catch (e) { toastErr(e?.message || 'Could not save company.'); }
    setBusy(false);
  }
  // A company reaches every worker linked to it, so its Delete is a held
  // dialog (Hold to confirm, Neil, Oct 30 2026): the dialog waits for the
  // call and stays open with the reason when it is refused.
  async function remove(en) {
    await dialog.confirm(`Delete "${en.name}"? Workers keep their record but lose this company link.`, {
      title: 'Delete Company', confirmText: 'Delete Company', doneText: 'Deleted', hold: true, holdMs: HOLD_MAJOR_MS,
      onConfirm: async () => {
        try { await api.deleteEntity(en.id); }
        catch (e) { throw new Error(e?.message || 'Could not delete company.', { cause: e }); }
        await onChangedEntities(); toastOk('Company deleted.');
      },
    });
  }
  async function seedDefaults() {
    setBusy(true);
    try {
      for (const [name, country] of [['Greens', 'US'], ['Greens India', 'IN'], ['MCD', 'US'], ['Oversite', 'US']]) await api.createEntity({ name, country });
      await onChangedEntities(); toastOk('Added the 4 default entities.');
    } catch (e) { toastErr(e?.message || 'Could not add defaults.'); }
    setBusy(false);
  }
  const field = (label, key, props = {}) => (
    <div>
      <label style={FL}>{label}</label>
      <input className="form-input" style={{ width: '100%' }} value={f[key]} onChange={e => set(key, e.target.value)} {...props} />
    </div>
  );

  // Only the Overview tab's form carries unsaved state - Departments/Work
  // Sites/Holidays manage and save their own rows independently as you go.
  // The form's edits outlive a switch to another tab, so they stay unsaved
  // (and the shell keeps asking) whichever tab is showing.
  const dirty = !!mode && JSON.stringify(f) !== JSON.stringify(formSnapshotRef.current);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const backToList = () => setMode(null);
  const guard = useUnsavedGuard(dirty, backToList, f.name.trim() ? save : undefined);
  const opened = !!entityId && mode === entityId;   // the shell picked the company

  if (entityId && !opened) {
    return entities.length
      ? <div style={{ padding: '24px 4px', color: 'var(--muted)' }}>Company not found.</div>
      : <SkeletonBlocks count={4} height={56} borderRadius={10} />;
  }

  if (mode) {
    return (
      <div>
        {!opened && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <button onClick={guard.requestClose} className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px' }}>
              <ChevronLeft size={14} /> Back
            </button>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: 'hsla(var(--color-blue),0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Building2 size={17} color="hsl(var(--color-blue))" />
            </div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{mode === 'new' ? 'Add Company' : editingEntity?.name || 'Edit Company'}</h3>
          </div>
        )}

        {mode !== 'new' && companyTabs.length > 1 && <ModuleTabs tabs={companyTabs} active={tab} onChange={setTab} inline />}

        {(mode === 'new' || tab === 'overview') && (
          <>
            <div style={{ padding: '18px 4px', display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ flex: '1 1 560px', maxWidth: 620, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div style={{ gridColumn: '1 / -1' }}>{field('NAME *', 'name', { autoFocus: true, placeholder: 'e.g. Greens India' })}</div>
                {field('LEGAL NAME', 'legal_name', { placeholder: 'full registered name' })}
                <div>
                  <label style={FL}>COUNTRY</label>
                  <select className="form-input" style={{ width: '100%' }} value={f.country} onChange={e => { set('country', e.target.value); if (e.target.value !== 'US') set('region', ''); }}>
                    <option value="">-</option>
                    {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}
                  </select>
                </div>
                {/* Where its people work (Neil, Oct 22): picks the hiring paperwork - California, Texas... */}
                {f.country === 'US' && (
                  <div>
                    <label style={FL}>STATE</label>
                    <select className="form-input" style={{ width: '100%' }} value={f.region || ''} onChange={e => set('region', e.target.value)}>
                      <option value="">-</option>
                      {Object.entries(US_STATE_NAMES).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                    </select>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Picks the hiring documents its new hires get.</div>
                  </div>
                )}
                {field('TAX ID (EIN / GSTIN)', 'tax_id')}
                {field('AUTHORIZED SIGNATORY', 'signatory', { placeholder: 'name, title' })}
                {/* Who signs when an HR packet's signing order says Authorized
                    Signatory (Oct 14). The text above is what a letter prints
                    ({{signatory}}); this is the person who actually signs. */}
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={FL}>AUTHORIZED SIGNATORY (PERSON)</label>
                  <PersonSelect value={(f.signatory_email || '').toLowerCase() || null} onChange={v => set('signatory_email', v || '')}
                    people={dirPickRows(people)} placeholder="Not Set" noneLabel="Not Set"
                    ariaLabel="Authorized Signatory (Person)" style={PICK_BOX} />
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Signs HR packets for the company when a packet's signing order says Authorized Signatory.</div>
                  {f.signatory_email && f.signatory.trim() && personName(f.signatory_email)
                    && !f.signatory.toLowerCase().includes((personName(f.signatory_email).split(' ')[0] || '').toLowerCase()) && (
                    <div style={{ fontSize: 11.5, color: 'hsl(var(--color-orange))', marginTop: 4 }}>
                      Letters print "{f.signatory}" as the signatory, but {personName(f.signatory_email)} signs - make the two match.
                    </div>
                  )}
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={FL}>COMPANY MANAGER(S)</label>
                  {f.manager_emails.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                      {f.manager_emails.map(em => (
                        <span key={em} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--mist)', borderRadius: 999, padding: '4px 6px 4px 10px', fontSize: 12 }}>
                          {personName(em) || em}
                          {isExternal(em) && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)' }}>External</span>}
                          <button type="button" onClick={() => set('manager_emails', f.manager_emails.filter(x => x !== em))}
                            title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}>
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {/* Searchable (Sep 29): type a name or email, or open the list. */}
                  <PersonSearchSelect placeholder="+ add a manager - type a name or email"
                    groups={[
                      { label: 'Nexus People', people: people.filter(p => !f.manager_emails.includes(p.email)) },
                      { label: 'External Users', people: externals.filter(p => !f.manager_emails.includes(p.email)) },
                    ]}
                    onPick={v => { if (v && !f.manager_emails.includes(v)) set('manager_emails', [...f.manager_emails, v]); }} />
                </div>
                {/* Signs every employee's timesheet last and finalizes it for
                    payroll (timesheet review + Nexus Sign, Sep 2026). */}
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={FL}>HR CONTACT</label>
                  <PersonSelect value={(f.hr_contact_email || '').toLowerCase() || null} onChange={v => set('hr_contact_email', v || '')}
                    people={dirPickRows(people)} placeholder="Not Set" noneLabel="Not Set"
                    ariaLabel="HR Contact" style={PICK_BOX} />
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Signs each employee's time sheet after the employee and manager, and finalizes it for payroll.</div>
                </div>
                {/* Named in the welcome email once a new hire's paperwork is signed (Pranshu, 11/04/2026). */}
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={FL}>IT SUPPORT CONTACT</label>
                  <PersonSelect value={(f.it_contact_email || '').toLowerCase() || null} onChange={v => set('it_contact_email', v || '')}
                    people={dirPickRows(people)} placeholder="Not Set" noneLabel="Not Set"
                    ariaLabel="IT Support Contact" style={PICK_BOX} />
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Named in the welcome email a new hire gets once their hiring packet is signed - beside their manager and the HR contact - for their work email, sign-in and equipment.</div>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={FL} htmlFor="entity-invoice-recipients">CONTRACTOR INVOICE RECIPIENTS</label>
                  <input id="entity-invoice-recipients" className="form-input" style={{ width: '100%' }} value={f.invoice_recipients || ''}
                    onChange={e => set('invoice_recipients', e.target.value)} placeholder="accounts@client.com, another@client.com" />
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Comma-separated. Who receives a contractor's approved invoice by email (for example the client's accounts contacts). They do not need a Nexus login.</div>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>{field('PHYSICAL ADDRESS', 'physical_address', { placeholder: 'search or pick a spot on the map, or type it in' })}</div>
                <div style={{ gridColumn: '1 / -1' }}>{field('MAILING ADDRESS', 'mailing_address', { placeholder: 'if different from the physical address' })}</div>
                <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 14 }}>
                  <div style={{ flex: '0 1 200px' }}>{field('WEBSITE', 'website', { placeholder: 'e.g. greensglobal.com' })}</div>
                  <div style={{ flex: '1 1 340px' }}>
                    <label style={FL}>MAIN PHONE</label>
                    {/* Just a phone number now (Neil, Sep 22: "let's not add bloat...
                        nobody is faxing anymore") - fax/telephone dropped from the
                        picker; main_phone_type is always sent as "phone". */}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <select className="form-input" style={{ width: 92, flexShrink: 0 }} value={f.main_phone_country} onChange={e => set('main_phone_country', e.target.value)}>
                        {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.dial}</option>)}
                      </select>
                      <input className="form-input" style={{ flex: 1, minWidth: 160 }} value={f.main_phone} onChange={e => set('main_phone', e.target.value)} placeholder="company main line" />
                    </div>
                  </div>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={FL}>LOGO</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {f.logo_url
                      ? <img src={f.logo_url} alt="" style={{ height: 44, maxWidth: 160, objectFit: 'contain', borderRadius: 6, border: '1px solid var(--line)', background: '#fff' }} />
                      : <div style={{ height: 44, width: 88, borderRadius: 6, border: '1px dashed var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5, color: 'var(--muted)' }}>No logo</div>}
                    <label className="secondary-btn" style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: mode === 'new' ? 'not-allowed' : 'pointer', padding: '5px 12px', opacity: mode === 'new' ? 0.5 : 1 }}>
                      {logoBusy ? <Spinner size={12} /> : <Plus size={12} />} {logoBusy ? 'Uploading…' : 'Upload logo or video'}
                      <input type="file" accept="image/*,video/mp4,video/quicktime,.mov" hidden disabled={mode === 'new' || logoBusy} onChange={e => { uploadLogo(e.target.files?.[0]); e.target.value = ''; }} />
                    </label>
                  </div>
                  {mode === 'new' && <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0' }}>Save the company first, then come back to add a logo.</p>}
                  <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0' }}>MP4 or MOV works too - it's converted to an animated GIF (email clients never play video directly), up to 6s. Converting a video can take a few seconds.</p>
                  {/* Neil, Sep 22: "you should put in some language that please upload
                      your logo, please upload it transparent" - Nexus doesn't process
                      the image, so a solid-background logo will look wrong once it's
                      placed on a colored or dark surface. */}
                  <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '4px 0 0' }}>Please upload your logo as a transparent PNG at your standard resolution - it's used as-is, not auto-processed, so a transparent background keeps it looking right on any surface, dark mode included.</p>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={FL}>SOCIAL LINKS</label>
                  <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '0 0 8px' }}>
                    Shown as icons on every employee's email signature (Sincerely / Kind Regards templates).
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    {field('FACEBOOK', 'facebook_url', { placeholder: 'https://facebook.com/...' })}
                    {field('X (TWITTER)', 'twitter_url', { placeholder: 'https://x.com/...' })}
                    {field('INSTAGRAM', 'instagram_url', { placeholder: 'https://instagram.com/...' })}
                  </div>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  {field('EMAIL DOMAINS', 'domains', { placeholder: 'e.g. aaravconstruction.com - comma-separated', readOnly: !companyWide, 'aria-readonly': !companyWide })}
                  <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0' }}>
                    {companyWide
                      ? 'Sync from M365 imports accounts on these domains and tags them to this company automatically (never overwrites a company already set on a profile).'
                      : 'Email domains are set by someone with access to every company - they tag people to this company automatically.'}
                  </p>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={FL}>NOTES</label>
                  <textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} value={f.notes} onChange={e => set('notes', e.target.value)} />
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, padding: '14px 4px' }}>
              <button className="primary-btn" onClick={save} disabled={!f.name.trim() || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!f.name.trim() || busy) ? 0.6 : 1 }}>
                {busy ? <Spinner size={14} /> : <CheckCircle size={14} />} Save
              </button>
            </div>
          </>
        )}

        {mode !== 'new' && tab === 'monitoring' && (
          editingEntity
            ? (
              <div style={{ padding: '18px 4px', maxWidth: 640 }}>
                <Suspense fallback={<LoadingState compact />}>
                  <MonitoringPolicy companyId={editingEntity.id} />
                </Suspense>
              </div>
            )
            : <div style={{ padding: '24px 4px', color: 'var(--muted)' }}>Company not found.</div>
        )}
        {mode !== 'new' && tab === 'departments' && (
          editingEntity
            ? <CompanyDepartments entity={editingEntity} toastOk={toastOk} toastErr={toastErr} />
            : <div style={{ padding: '24px 4px', color: 'var(--muted)' }}>Company not found.</div>
        )}
        {mode !== 'new' && tab === 'sites' && (
          editingEntity
            ? <CompanyWorkSitesTab entity={editingEntity} sites={sites} onChanged={onChangedSites} toastOk={toastOk} toastErr={toastErr} />
            : <div style={{ padding: '24px 4px', color: 'var(--muted)' }}>Company not found.</div>
        )}
        {mode !== 'new' && tab === 'holidays' && (
          editingEntity
            ? (
              <Suspense fallback={<div style={{ padding: '18px 4px' }}><SkeletonBlocks count={4} height={48} borderRadius={10} /></div>}>
                <CompanyHolidayCalendar entity={editingEntity} toastOk={toastOk} toastErr={toastErr} />
              </Suspense>
            )
            : <div style={{ padding: '24px 4px', color: 'var(--muted)' }}>Company not found.</div>
        )}
        {mode !== 'new' && tab === 'checklists' && (
          editingEntity
            ? <ChecklistSettings entityId={editingEntity.id} entities={entities} onOpenDepartments={() => setTab('departments')} toastOk={toastOk} toastErr={toastErr} embedded={tabs != null} />
            : <div style={{ padding: '24px 4px', color: 'var(--muted)' }}>Company not found.</div>
        )}
        {mode !== 'new' && tab === 'roles' && can('administrator') && (
          editingEntity
            ? (
              <Suspense fallback={<div style={{ padding: '16px 4px' }}><SkeletonBlocks count={4} height={54} /></div>}>
                <CompanyRoles entity={editingEntity} toastOk={toastOk} toastErr={toastErr} />
              </Suspense>
            )
            : <div style={{ padding: '24px 4px', color: 'var(--muted)' }}>Company not found.</div>
        )}

        {guard.confirming && (
          <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={backToList} onSave={f.name.trim() ? guard.saveAndClose : undefined} saving={busy} />
        )}
      </div>
    );
  }

  return (
    <div>
      {companyWide && <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 10px 13px', borderBottom: '1px solid var(--line)', marginBottom: 4 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Group Manager</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Oversees every company - the escalation step above each company's manager.</div>
        </div>
        <div style={{ width: 220, flexShrink: 0 }}>
          <PersonSelect disabled={groupMgrBusy} value={(groupMgr || '').toLowerCase() || null}
            onChange={v => { if ((v || '') !== (groupMgr || '').toLowerCase()) saveGroupMgr(v || ''); }}
            people={dirPickRows(people)} placeholder="Not Set" noneLabel="Not Set"
            ariaLabel="Group Manager" style={{ ...PICK_BOX, fontSize: 12.5 }} />
        </div>
      </div>}
      {entities.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--muted)' }}>
          {companyWide ? (
            <>
              <p style={{ fontSize: 13, marginBottom: 14 }}>No companies yet. Add your legal entities so every worker can be tied to one.</p>
              <button className="secondary-btn" onClick={seedDefaults} disabled={busy} style={{ marginRight: 8 }}>Add Greens · Greens India · MCD · Oversite</button>
            </>
          ) : <p style={{ fontSize: 13 }}>No companies inside your access yet.</p>}
        </div>
      ) : entities.map(en => {
        const mgrEmails = en.managerEmails && en.managerEmails.length ? en.managerEmails : (en.managerEmail ? [en.managerEmail] : []);
        const mgrNames = mgrEmails.map(personName).filter(Boolean).join(', ');
        return (
        <div key={en.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 10px', borderBottom: '1px solid var(--line)' }}>
          <CompanyLogo name={en.name} logoUrl={en.logoUrl} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>{en.name} {en.country && <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>· {en.country}</span>}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[en.legalName, en.taxId && `Tax ${en.taxId}`, en.signatory, mgrNames && `Manager${mgrEmails.length > 1 ? 's' : ''} ${mgrNames}`, en.domains && en.domains.split(',').map(d => '@' + d.trim()).join(' ')].filter(Boolean).join(' · ') || '-'}</div>
          </div>
          <button className="secondary-btn" onClick={() => (onOpen ? onOpen(en.id) : startEdit(en))} style={{ padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Pencil size={13} /> Edit</button>
          {companyWide && <button onClick={() => remove(en)} title="Delete" style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', color: 'hsl(var(--color-red))', display: 'flex', padding: 7 }}><Trash2 size={13} /></button>}
        </div>
        );
      })}
      {companyWide && <div style={{ padding: '14px 4px', display: 'flex', justifyContent: 'flex-end' }}>
        <button className="primary-btn" onClick={startNew} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> Add Company</button>
      </div>}
    </div>
  );
}

// ── Work sites (Neil, Sep 25) - ONE global library (Settings -> Company
// Settings -> Work Site Library), and each company picks the sites its people
// punch at from it: all of them, some, or one (Sacred Natural has one site, so
// its people must not resolve to a Greens office). A site added from a
// company's tab lands in the library too, so it is entered once and every
// other company can pick it. Replaces the Sep 18 single-company `company` tag,
// where claiming a site for one company took it away from every other.
// address_verified: the coordinates came from an address picked in the search
// (Sep 30). verifiedAt is the saved state.
// Google Maps link (Sep 30): location_source 'google_link' + map_link = the
// point came from a pasted Google Maps link (or coordinates) - the accurate
// path for addresses the search misplaces. loc_changed = the point was set in
// this edit, so the source/link are sent (a radius-only edit leaves them).
// addr_manual: the address is being typed by hand (the link had none, or HR
// chose to); link_address: the address the last pasted link gave. Library
// forms also carry company_ids (Oct 1); a company's own tab does not.
const SITE_BLANK = { name: '', address: '', latitude: '', longitude: '', radius_m: 150, notes: '', address_verified: false, verifiedAt: '', verifiedBy: '',
  location_source: '', map_link: '', link_point: null, loc_changed: false, addr_manual: false, link_address: '' };
const siteForm = s => ({ name: s.name, address: s.address || '', latitude: s.latitude || '', longitude: s.longitude || '', radius_m: s.radiusM ?? 150, notes: s.notes || '', address_verified: false,
  verifiedAt: s.addressVerifiedAt || '', verifiedBy: s.addressVerifiedBy || '',
  location_source: s.locationSource || '', map_link: s.mapLink || '', link_point: null, loc_changed: false,
  addr_manual: false, link_address: '',
  saved_point: s.latitude && s.longitude && Number.isFinite(Number(s.latitude)) ? [Number(s.latitude), Number(s.longitude)] : null });
// What a save sends: never the form-only keys, and the location source/link
// only when the point was set in this edit.
const siteBody = f => {
  const { link_point, loc_changed, addr_manual, link_address, verifiedAt, verifiedBy, saved_point, pin_adjusted, location_source, map_link, ...rest } = f;   // eslint-disable-line no-unused-vars
  // The form keeps exact meters (the editor works in feet); the API stores whole meters.
  return { ...rest, radius_m: Math.round(Number(f.radius_m)) || 150, ...(loc_changed ? { location_source, map_link } : {}) };
};
// The list badge: a site whose point came from the old map pin is re-checked
// once by searching its address (Sep 30) - nothing moves until someone does.
function SiteVerifyBadge({ s }) {
  if (s.latitude && s.longitude && s.locationSource === 'google_link') {
    return (
      <a href={s.mapLink && /^https?:/i.test(s.mapLink) ? s.mapLink : googleMapsUrl(s.latitude, s.longitude)} target="_blank" rel="noreferrer"
        onClick={e => e.stopPropagation()} title="Placed from a Google Maps link - open it"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 8, fontSize: 10.5, fontWeight: 700, padding: '1px 8px', borderRadius: 999, verticalAlign: 'middle',
          background: 'rgba(37,99,235,0.1)', color: '#1d4ed8', textDecoration: 'none' }}>
        <Link2 size={10} /> Google Maps
      </a>
    );
  }
  if (s.latitude && s.longitude && s.addressVerifiedAt) return null;
  const noPoint = !(s.latitude && s.longitude);
  return (
    <span title={noPoint ? 'Not placed yet - edit the location and paste its Google Maps link.' : 'This location was placed with the old map pin. Edit it and paste its Google Maps link to confirm where it is.'}
      style={{ display: 'inline-block', marginLeft: 8, fontSize: 10.5, fontWeight: 700, padding: '1px 8px', borderRadius: 999, verticalAlign: 'middle',
        background: 'rgba(180,83,9,0.12)', color: '#b45309' }}>
      {noPoint ? 'No Location' : 'Verify Location'}
    </span>
  );
}
const siteLine = s => [s.address, (s.latitude && s.longitude) ? `${s.latitude}, ${s.longitude} · ${formatDistance(s.radiusM)}` : ''].filter(Boolean).join(' · ') || '-';

// Radius guidance (competitor research, Sep 30): phone GPS drifts ~50 m, so a
// fence under 100 m flags people who are on-site; most sites want 100-300 m.
// Entered and shown in FEET (Oct 2 - US units); stored in meters as before.
const RADIUS_PRESETS_FT = [330, 500, 650, 1000, 1650];
const ftOf = m => Math.round(metersToFeet(m));

// ── The location form (Neil, Oct 1) ─────────────────────────────────────────
// ONE way to place a location: paste the building's Google Maps link. Its
// address fills itself from the same link, written the US way ("25260 N
// Centre City Pkwy, Escondido, CA 92026"), and is typed by hand only when the
// link carries none ("there should be an option to put in a manual address").
// The address search is gone ("keep this very, very simple"). Every input -
// and the how-to - sits on the left, the map on the right; the pin can still
// be nudged, measured from the link's point. The last 30 days of punches are
// an opt-in check, off by default ("that should not be there by default").
const PUNCHES_PREF = 'nexus:locations:showPunches';

function SwitchRow({ on, onChange, label, hint }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
      <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onChange}
        style={{ position: 'relative', width: 34, height: 20, borderRadius: 999, border: 'none', cursor: 'pointer', flexShrink: 0, marginTop: 1,
          background: on ? 'hsl(var(--color-green))' : 'var(--line)', transition: 'background .15s' }}>
        <span style={{ position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff',
          transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
      </button>
      <span style={{ fontSize: 12.5 }}>
        <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{label}</span>
        {hint && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>{hint}</span>}
      </span>
    </label>
  );
}

// Which companies' people punch in at this location (Neil, Oct 1: "option A
// should be all ... or you select some", right here instead of backing into
// each company's settings). A multi-select dropdown (Neil, Oct 2): All at the
// top, then every company with a checkbox. All = every company there is
// today; a company added later picks it from its own Locations tab.
function LocationCompanyPicker({ entities, value, onChange }) {
  const btnRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ids = entities.map(e => e.id);
  const picked = new Set(value);
  const isAll = ids.length > 0 && ids.every(id => picked.has(id));
  const some = !isAll && value.length > 0;
  const names = entities.filter(e => picked.has(e.id)).map(e => e.name);
  const summary = isAll ? 'All Companies'
    : names.length === 0 ? 'Select companies'
    : names.length <= 2 ? names.join(', ')
    : `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
  const needle = q.trim().toLowerCase();
  const shown = needle ? entities.filter(e => (e.name || '').toLowerCase().includes(needle)) : entities;
  const toggle = id => onChange(picked.has(id) ? value.filter(x => x !== id) : [...value, id]);
  const row = { display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 10px', border: 'none', borderRadius: 7,
    background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, color: 'var(--ink)', textAlign: 'left' };
  const box = (on, partial = false) => (
    <span aria-hidden style={{ width: 16, height: 16, borderRadius: 4, flexShrink: 0, display: 'grid', placeItems: 'center',
      border: `1.5px solid ${on || partial ? 'hsl(var(--color-green))' : 'var(--line)'}`, background: on ? 'hsl(var(--color-green))' : 'var(--card)' }}>
      {on ? <Check size={11} color="#fff" strokeWidth={3} /> : partial ? <span style={{ width: 8, height: 2, borderRadius: 1, background: 'hsl(var(--color-green))' }} /> : null}
    </span>
  );
  return (
    <div>
      <label style={FL} id="loc-companies-label">COMPANIES</label>
      <button ref={btnRef} type="button" aria-haspopup="listbox" aria-expanded={open} aria-labelledby="loc-companies-label"
        onClick={() => { setOpen(o => !o); setQ(''); }} className="form-input"
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
          color: value.length ? 'var(--ink)' : 'var(--muted)' }}>
        <Building2 size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
        <ChevronDown size={14} style={{ color: 'var(--muted)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
      <AnchoredMenu anchorRef={btnRef} open={open} onClose={() => setOpen(false)} align="start"
        style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.14)',
          padding: 6, minWidth: Math.max(240, btnRef.current?.offsetWidth || 0), maxHeight: 360, overflowY: 'auto' }}>
        <div role="listbox" aria-multiselectable="true" aria-label="Companies">
          {entities.length > 8 && (
            <input className="form-input" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search companies"
              style={{ width: '100%', fontSize: 12.5, marginBottom: 6 }} />
          )}
          {!needle && (
            <>
              <button type="button" role="option" aria-selected={isAll} onClick={() => onChange(isAll ? [] : ids)} style={{ ...row, fontWeight: 700 }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--mist)'; }} onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                {box(isAll, some)} All
              </button>
              <div style={{ height: 1, background: 'var(--line)', margin: '4px 2px' }} />
            </>
          )}
          {shown.map(e => (
            <button key={e.id} type="button" role="option" aria-selected={picked.has(e.id)} onClick={() => toggle(e.id)} style={row}
              onMouseEnter={ev => { ev.currentTarget.style.background = 'var(--mist)'; }} onMouseLeave={ev => { ev.currentTarget.style.background = 'none'; }}>
              {box(picked.has(e.id))} {e.name}
            </button>
          ))}
          {shown.length === 0 && <div style={{ padding: '8px 10px', fontSize: 12.5, color: 'var(--muted)' }}>No companies match.</div>}
        </div>
      </AnchoredMenu>
      <p style={{ fontSize: 11.5, color: value.length ? 'var(--muted)' : '#b45309', margin: '6px 0 0' }}>
        {isAll ? 'People at every company can punch in here. A company added later picks it from its own Locations tab.'
          : value.length ? `${value.length} of ${entities.length} compan${entities.length === 1 ? 'y' : 'ies'} - their people can punch in here.`
          : 'No company yet - it stays in the library until one is picked.'}
      </p>
    </div>
  );
}

function WorkSiteForm({ f, set, busy, onBack, onSave, hint, siteId = '', entities = null }) {
  const [checkPoints, setCheckPoints] = useState(null);
  const [focus, setFocus] = useState(null);
  // Off by default (Neil); remembered per viewer once turned on.
  const [showPunches, setShowPunches] = useState(() => { try { return localStorage.getItem(PUNCHES_PREF) === '1'; } catch { return false; } });
  const togglePunches = () => {
    const next = !showPunches;
    setShowPunches(next);
    if (!next) setCheckPoints(null);
    try { localStorage.setItem(PUNCHES_PREF, next ? '1' : '0'); } catch { /* storage blocked - just this visit */ }
  };
  const r = Number(f.radius_m) || 0;          // meters, as stored
  const [ftDraft, setFtDraft] = useState(null);   // the feet box while typing
  const setFeet = (ft) => set('radius_m', feetToMeters(ft));
  const hasPoint = f.latitude !== '' && f.longitude !== '' && Number.isFinite(Number(f.latitude)) && Number.isFinite(Number(f.longitude));
  const status = f.loc_changed && f.location_source === 'google_link'
    ? (f.pin_adjusted ? 'Pin fine-tuned from the Google Maps point. Save to keep it.' : 'Placed from the Google Maps link. Save to keep it.')
    : f.loc_changed && f.pin_adjusted ? 'Pin fine-tuned on the map. Save to keep it.'
    : f.location_source === 'google_link' && hasPoint ? `Placed from a Google Maps link${f.verifiedAt ? ` on ${formatDate(f.verifiedAt)}` : ''}${f.verifiedBy ? ` by ${f.verifiedBy}` : ''}.`
    : f.verifiedAt && hasPoint ? `Placed from its address on ${formatDate(f.verifiedAt)}. Paste its Google Maps link to confirm it.`
    : hasPoint ? 'Placed with the old map pin. Paste its Google Maps link to confirm where it is.'
    : 'Not placed yet. Paste the Google Maps link of the building.';
  const good = f.loc_changed || (f.location_source === 'google_link' && hasPoint);
  const linkAddress = f.link_address || '';
  return (
    <div style={{ padding: '18px 4px', display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      {/* Left: every input, top to bottom in the order they are filled in. */}
      <div style={{ flex: '1 1 380px', maxWidth: 500, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {hint && <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: 0 }}>{hint}</p>}
        <div>
          <label style={FL}>NAME *</label>
          <input className="form-input" style={{ width: '100%' }} value={f.name} autoFocus placeholder="e.g. Green Storage Escondido"
            onChange={e => set('name', e.target.value)} />
        </div>

        <div>
          <label style={FL}>GOOGLE MAPS LINK</label>
          <WorkSiteLinkPanel link={f.map_link} point={f.link_point} savedPoint={siteId ? f.saved_point : null}
            onResolved={({ link, point }) => {
              set('latitude', point.lat.toFixed(6)); set('longitude', point.lng.toFixed(6));
              set('location_source', 'google_link'); set('map_link', link); set('link_point', point);
              set('loc_changed', true); set('address_verified', false); set('pin_adjusted', false);
              // The link's address replaces whatever was there - it is the
              // source of truth. None in the link: HR types it.
              set('link_address', point.address || '');
              if (point.address) { set('address', point.address); set('addr_manual', false); } else set('addr_manual', true);
              if (!f.name.trim() && point.placeName) set('name', point.placeName);
              setFocus({ lat: point.lat, lng: point.lng, key: Date.now() });
            }} />
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <label style={FL} htmlFor="loc-address">ADDRESS</label>
            {(f.addr_manual || hasPoint || f.address) && (
              <button type="button" onClick={() => {
                  if (f.addr_manual && linkAddress) set('address', linkAddress);
                  set('addr_manual', !f.addr_manual);
                }}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, color: 'var(--wk-brand, #2b45e1)' }}>
                {f.addr_manual ? (linkAddress ? "Use the Link's Address" : 'Done') : 'Enter Manually'}
              </button>
            )}
          </div>
          <input id="loc-address" className="form-input" value={f.address} readOnly={!f.addr_manual}
            onChange={e => set('address', e.target.value)}
            placeholder={f.addr_manual ? 'e.g. 25260 N Centre City Pkwy, Escondido, CA 92026' : 'Filled in from the Google Maps link'}
            style={{ width: '100%', ...(f.addr_manual ? null : { background: 'var(--mist)' }) }} />
          {f.addr_manual && f.loc_changed && !linkAddress && (
            <p style={{ fontSize: 11.5, color: '#b45309', margin: '5px 0 0' }}>The link does not include an address - type it in.</p>
          )}
          <div style={{ fontSize: 11.5, marginTop: 6, color: good ? 'hsl(var(--color-green))' : '#b45309', lineHeight: 1.45 }}>
            {status}
            {/* The link's result card shows the point while it is fresh. */}
            {hasPoint && !f.link_point && (
              <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}> {Number(f.latitude).toFixed(6)}, {Number(f.longitude).toFixed(6)}</span>
            )}
            {hasPoint && (
              <> <a href={f.location_source === 'google_link' && /^https?:/i.test(f.map_link || '') ? f.map_link : googleMapsUrl(f.latitude, f.longitude)}
                target="_blank" rel="noreferrer" style={{ color: 'var(--wk-brand, #2b45e1)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                Open in Google Maps <ExternalLink size={10} /></a></>
            )}
          </div>
        </div>

        {entities && (
          <LocationCompanyPicker entities={entities} value={f.company_ids || []} onChange={ids => set('company_ids', ids)} />
        )}

        <div>
          <label style={FL}>NOTES</label>
          <textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }}
            value={f.notes} onChange={e => set('notes', e.target.value)} placeholder="e.g. Punch in at the office by the front gate" />
        </div>

        {hasPoint && (
          <div>
            <SwitchRow on={showPunches} onChange={togglePunches} label="Show Punches Here"
              hint="The last 30 days of punches near this location, and which fall inside the circle - dots on the map." />
            {showPunches && (
              <WorkSiteFenceCheck lat={f.latitude} lng={f.longitude} radiusM={f.radius_m} siteId={siteId}
                moved={!!siteId} onPoints={setCheckPoints} />
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button className="secondary-btn" onClick={onBack} disabled={busy}>Back</button>
          <button className="primary-btn" onClick={onSave} disabled={!f.name.trim() || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!f.name.trim() || busy) ? 0.6 : 1 }}>
            {busy ? <Spinner size={14} /> : <CheckCircle size={14} />} Save
          </button>
        </div>
      </div>

      {/* Right: the map, kept in view while the inputs scroll. */}
      <div style={{ flex: '1 1 380px', minWidth: 300, position: 'sticky', top: 12, alignSelf: 'flex-start' }}>
        <WorkSiteAddressMap lat={f.latitude} lng={f.longitude} radiusM={f.radius_m}
          showSearch={false} focus={focus} checkPoints={showPunches ? checkPoints : null}
          anchorLabel={f.location_source === 'google_link' ? 'the Google Maps point' : 'the saved point'}
          adjustable={!!(f.loc_changed || (f.verifiedAt && hasPoint))}
          onAdjust={({ lat, lng }) => {
            set('latitude', lat.toFixed(6)); set('longitude', lng.toFixed(6));
            set('pin_adjusted', true); set('loc_changed', true);
            if (!f.location_source) set('location_source', 'address');
          }} />
        {/* The circle's size sits with the circle (Neil, Oct 2). */}
        <div style={{ marginTop: 14 }}>
          <label style={FL}>GEOFENCE RADIUS</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="range" min={165} max={3300} step={25} value={Math.min(3300, Math.max(165, ftOf(r || 150)))} aria-label="Geofence radius slider"
              onChange={e => { setFtDraft(null); setFeet(Number(e.target.value)); }} style={{ flex: 1, accentColor: 'hsl(217,91%,50%)' }} />
            <input className="form-input" type="number" min={80} max={16400} value={ftDraft ?? (f.radius_m === '' ? '' : ftOf(r))} aria-label="Geofence radius in feet"
              onChange={e => { setFtDraft(e.target.value); setFeet(e.target.value); }} onBlur={() => setFtDraft(null)} style={{ width: 84 }} />
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>ft</span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
            {RADIUS_PRESETS_FT.map(v => {
              const on = ftOf(r) === v;
              return (
                <button key={v} type="button" onClick={() => { setFtDraft(null); setFeet(v); }} aria-pressed={on}
                  style={{ padding: '2px 9px', borderRadius: 999, border: `1px solid ${on ? 'hsl(217,91%,50%)' : 'var(--line)'}`, background: on ? 'rgba(37,99,235,0.1)' : 'var(--card)',
                    color: on ? '#1d4ed8' : 'var(--ink)', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>{v.toLocaleString('en-US')} ft</button>
              );
            })}
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r > 0 ? `= ${formatDistance(2 * r)} across` : ''}</span>
          </div>
          <p style={{ fontSize: 11.5, margin: '6px 0 0', color: r > 0 && r < 100 ? '#b45309' : 'var(--muted)', display: 'flex', gap: 5, alignItems: 'flex-start' }}>
            {r > 0 && r < 100
              ? <><AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 2 }} /> Under 330 ft, normal phone GPS drift will mark people who are on-site as Out of Location.</>
              : 'Most locations work well at 330-1,000 ft. For a large property, put the pin in the middle of it and widen the circle to cover where people work.'}
          </p>
        </div>
      </div>
    </div>
  );
}

function CompanyWorkSitesTab({ entity, sites, onChanged, toastOk, toastErr }) {
  const [mode, setMode] = useState(null); // null | 'new' | site.id
  const [f, setF] = useState(SITE_BLANK);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const onCompany = s => (s.companies || []).includes(entity.id);
  const mySites = sites.filter(onCompany);
  const library = sites.filter(s => !onCompany(s));
  const needle = q.trim().toLowerCase();
  const libraryShown = needle ? library.filter(s => `${s.name} ${s.address || ''}`.toLowerCase().includes(needle)) : library;

  const startNew = () => { setF(SITE_BLANK); setMode('new'); };
  const startEdit = s => { setF(siteForm(s)); setMode(s.id); };

  async function save() {
    if (!f.name.trim() || busy) return; setBusy(true);
    try {
      const body = siteBody(f);
      // New from here = into the library AND onto this company's list.
      if (mode === 'new') await api.createWorkSite({ ...body, company: entity.id }); else await api.updateWorkSite(mode, body);
      await onChanged(); toastOk('Location saved.'); setMode(null);
    } catch (e) { toastErr(e?.message || 'Could not save location.'); }
    setBusy(false);
  }
  async function unlink(s) {
    if (!await dialog.confirm(`Remove "${s.name}" from ${entity.name}? ${entity.name} employees will no longer punch at it. It stays in the Location Library for other companies.`, { title: 'Remove location', confirmText: 'Remove', danger: true })) return;
    try { await api.removeCompanyWorkSite(entity.id, s.id); await onChanged(); toastOk(`Removed from ${entity.name}.`); }
    catch (e) { toastErr(e?.message || 'Could not remove.'); }
  }
  async function add(list) {
    if (!list.length || busy) return; setBusy(true);
    try {
      await api.addCompanyWorkSites(entity.id, list.map(s => s.id)); await onChanged();
      toastOk(list.length === 1 ? `Added ${list[0].name}.` : `Added ${list.length} locations.`);
    } catch (e) { toastErr(e?.message || 'Could not add.'); }
    setBusy(false);
  }

  if (mode) {
    const shared = mode !== 'new' && (sites.find(s => s.id === mode)?.companies || []).length > 1;
    return <WorkSiteForm f={f} set={set} busy={busy} onBack={() => setMode(null)} onSave={save} siteId={mode === 'new' ? '' : mode}
      hint={mode === 'new' ? `Saved to the Location Library and added to ${entity.name}.` : shared ? 'Other companies use this location too - changes apply to them as well.' : ''} />;
  }

  return (
    <div style={{ padding: '18px 4px' }}>
      <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '0 0 12px' }}>{entity.name} employees can only punch at these geofenced sites.</p>
      {mySites.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px 16px', color: 'var(--muted)', fontSize: 13, border: '1px dashed var(--line)', borderRadius: 10 }}>No locations for {entity.name} yet - add them from the library below.</div>
      ) : mySites.map(s => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 10px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>{s.name}<SiteVerifyBadge s={s} /></div>
            <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{siteLine(s)}</div>
          </div>
          <button className="secondary-btn" onClick={() => startEdit(s)} style={{ padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Pencil size={13} /> Edit</button>
          <button className="secondary-btn" onClick={() => unlink(s)} style={{ padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 5, color: 'hsl(var(--color-red))' }}><X size={13} /> Remove</button>
        </div>
      ))}
      <div style={{ paddingTop: 14 }}>
        <button className="primary-btn" onClick={startNew} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> Add New Location</button>
      </div>

      {library.length > 0 && (
        <div style={{ marginTop: 28, paddingTop: 18, borderTop: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Add From Location Library</div>
              <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '2px 0 0' }}>Locations already in Nexus that {entity.name} doesn't use yet.</p>
            </div>
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
              <input className="form-input" value={q} onChange={e => setQ(e.target.value)} placeholder="Search locations" style={{ paddingLeft: 28, width: 200, fontSize: 12.5 }} />
            </div>
            <button className="secondary-btn" onClick={() => add(libraryShown)} disabled={busy || !libraryShown.length} style={{ padding: '5px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Plus size={13} /> Add All ({libraryShown.length})
            </button>
          </div>
          <div style={{ marginTop: 8 }}>
            {libraryShown.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '12px 10px' }}>No locations match "{q}".</div>
            ) : libraryShown.map(s => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 10px', borderBottom: '1px solid var(--line)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.address || '-'}</div>
                </div>
                <button className="secondary-btn" onClick={() => add([s])} disabled={busy} style={{ padding: '5px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={13} /> Add</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Change Status (HR Section B6) - people/StatusChangeSheet.jsx ─────────────
// One way to leave (Neil, 11/03/2026): Onboarding / Active / Inactive only;
// Left is Offboard's alone. The name stays so the record's call site merges.
function StatusChangeModal(props) {
  return <StatusChangeSheet {...props} />;
}

// ── Work Site Library (Neil, Sep 25) - every work site, entered once; each
// company then picks its own from its Work Sites tab. Lives under Settings ->
// Global Settings, not inside any one company.
export function WorkSiteLibrary({ toastOk, toastErr }) {
  const [sites, setSites] = useState(null);
  const [entities, setEntities] = useState([]);
  const [mode, setMode] = useState(null); // null | 'new' | site.id
  const [f, setF] = useState(SITE_BLANK);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const load = useCallback(() => api.getWorkSites().then(setSites).catch(() => setSites([])), []);
  useEffect(() => { load(); api.getEntities().then(setEntities).catch(() => {}); }, [load]);
  const entityName = id => entities.find(en => en.id === id)?.name || '';

  async function save() {
    if (!f.name.trim() || busy) return; setBusy(true);
    try {
      const body = siteBody(f);
      if (mode === 'new') await api.createWorkSite(body); else await api.updateWorkSite(mode, body);
      await load(); toastOk('Location saved.'); setMode(null);
    } catch (e) { toastErr(e?.message || 'Could not save the location.'); }
    setBusy(false);
  }
  async function remove(s) {
    const used = (s.companies || []).map(entityName).filter(Boolean);
    const msg = used.length ? `Delete "${s.name}"? It is removed from ${used.join(', ')} too.` : `Delete "${s.name}"?`;
    if (!await dialog.confirm(msg, { title: 'Delete Location', confirmText: 'Delete', danger: true })) return;
    try { await api.deleteWorkSite(s.id); await load(); toastOk('Location deleted.'); }
    catch (e) { toastErr(e?.message || 'Could not delete.'); }
  }

  if (sites === null) return <SkeletonBlocks count={3} height={48} borderRadius={10} />;
  if (mode) {
    const used = mode === 'new' ? [] : (sites.find(s => s.id === mode)?.companies || []);
    return <WorkSiteForm f={f} set={set} busy={busy} onBack={() => setMode(null)} onSave={save} siteId={mode === 'new' ? '' : mode}
      entities={entities}
      hint={used.length > 1 ? 'Several companies use this location - changes apply to all of them.' : ''} />;
  }
  const needle = q.trim().toLowerCase();
  const shown = needle ? sites.filter(s => `${s.name} ${s.address || ''}`.toLowerCase().includes(needle)) : sites;
  // Every company there is - read as "All Companies" rather than a long list.
  const usedText = (s) => {
    const ids = s.companies || [];
    if (entities.length > 1 && entities.every(en => ids.includes(en.id))) return 'Used by All Companies';
    const used = ids.map(entityName).filter(Boolean);
    return used.length ? `Used by ${used.join(', ')}` : 'Not used by any company yet';
  };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <p style={{ flex: 1, minWidth: 200, fontSize: 11.5, color: 'var(--muted)', margin: 0 }}>Every location, entered once. Pick the companies whose people punch in at each one - here, or under Locations with the company picked.</p>
        <div style={{ position: 'relative' }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input className="form-input" value={q} onChange={e => setQ(e.target.value)} placeholder="Search locations" style={{ paddingLeft: 28, width: 200, fontSize: 12.5 }} />
        </div>
        <button className="primary-btn" onClick={() => { setF({ ...SITE_BLANK, company_ids: [] }); setMode('new'); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> Add Location</button>
      </div>
      {shown.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px 16px', color: 'var(--muted)', fontSize: 13, border: '1px dashed var(--line)', borderRadius: 10 }}>{sites.length ? `No locations match "${q}".` : 'No locations yet.'}</div>
      ) : shown.map(s => {
        const usedLine = usedText(s);
        return (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 10px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>{s.name}<SiteVerifyBadge s={s} /></div>
              <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{siteLine(s)}</div>
              <div style={{ fontSize: 11.5, color: (s.companies || []).length ? 'var(--ink)' : 'var(--muted)', marginTop: 2 }}>{usedLine}</div>
            </div>
            <button className="secondary-btn" onClick={() => { setF({ ...siteForm(s), company_ids: [...(s.companies || [])] }); setMode(s.id); }} style={{ padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Pencil size={13} /> Edit</button>
            <button onClick={() => remove(s)} title="Delete" style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', color: 'hsl(var(--color-red))', display: 'flex', padding: 7 }}><Trash2 size={13} /></button>
          </div>
        );
      })}
    </div>
  );
}

// ── People stat cards (Work OS redesign, Jul 28) ─────────────────────────────
// Three designed cards with real mini-visuals - headcount with employment-type
// composition, status breakdown, department spread - replacing the four
// identical number tiles. Everything is computed from the live employee list;
// nothing is fabricated, and zero/loading states stay designed.





const DEPT_COLORS = ['#2b45e1', '#dc7a18', '#248f4b', '#8a31c9', '#b8860b', '#0e7490', '#be185d'];

// The department ring: a donut with the headcount in the middle; `size` is
// the drawn width, the drawing scales with it.
function StatusDonut({ segments, total, size = 118 }) {
  const R = 30, C = 2 * Math.PI * R, SW = 11, GAP = 2;
  const live = segments.filter(s => s.n > 0);
  let acc = 0;
  return (
    <svg className="pp-donut" viewBox="0 0 84 84" width={size} height={size} role="img" aria-label={`${total} people by department`} style={{ flexShrink: 0 }}>
      <circle cx={42} cy={42} r={R} fill="none" stroke="var(--mist)" strokeWidth={SW} />
      {total > 0 && live.map(s => {
        const frac = s.n / total;
        const len = Math.max(frac * C - (live.length > 1 ? GAP : 0), 1.5);
        const el = (
          <circle key={s.key} cx={42} cy={42} r={R} fill="none" stroke={s.color} strokeWidth={SW}
            strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-acc} transform="rotate(-90 42 42)">
            <title>{`${s.label}: ${s.n}`}</title>
          </circle>
        );
        acc += frac * C;
        return el;
      })}
      <text x={42} y={41} textAnchor="middle" style={{ fontFamily: 'var(--wk-font)', fontSize: 20, fontWeight: 700, fill: 'var(--ink)' }}>{total}</text>
      <text x={42} y={54} textAnchor="middle" style={{ fontFamily: 'var(--wk-font)', fontSize: 8.5, fill: 'var(--muted)' }}>people</text>
    </svg>
  );
}

// One count: label over number, the whole thing a button when it opens the
// people behind it.
function Stat({ label, n, onGo, tone, loading }) {
  return (
    <button type="button" className="pp-stat" onClick={onGo} disabled={!onGo}>
      <span className="pp-stat-label">{label}</span>
      <b style={{ color: tone && n ? tone : 'var(--ink)' }}>{loading || n == null ? <CountSkeleton width="1.2em" /> : n}</b>
    </button>
  );
}

function PeopleStatCards({ employees, externals = [], loading, isMobile, onStatusFilter, onJumpToDirectory, onGoExits, entityName, onOpenPerson, refreshKey }) {
  // Three cards (Neil, 11/08/2026: "the Active tile seems useless", "New
  // Joiners is bloat"): People with its statuses and types, Status with the
  // counts HR acts on, Departments. Left and Inactive people are NOT counted
  // in People (Charmi, Oct 20 2026): Total = Active + Onboarding.
  const isExt = isExternalPerson;
  const current = employees.filter(e => !isExt(e) && !INACTIVE_STATUSES.has(e.status || 'active'));
  const { people: total, active: nActive, onboarding: nOnboarding, external: nExternal } = peopleTallies(employees, externals);
  const nInactive = employees.filter(e => !isExt(e) && e.status === 'inactive').length;
  const nProbation = current.filter(e => ['in_probation', 'extended'].includes(e.probation?.status)).length;
  const types = EMP_TYPES.map(([k, label]) => ({ key: k, label, n: current.filter(e => e.employmentType === k).length })).filter(t => t.n > 0);
  const depts = [...current.reduce((m, e) => {
    if (e.department) m.set(e.department, (m.get(e.department) || 0) + 1);
    return m;
  }, new Map())].sort((a, b) => b[1] - a[1]);
  const deptSegs = depts.map(([name, n], i) => ({ key: name, label: name, color: DEPT_COLORS[i % DEPT_COLORS.length], n }));

  // Exits in progress and who is on leave today - two small reads, HR only
  // (the Team view never shows this row).
  const [exits, setExits] = useState(null);
  const [onLeave, setOnLeave] = useState(null);
  useEffect(() => {
    let alive = true;
    api.exitStatements().then(r => alive && setExits((r?.exits || []).length)).catch(() => alive && setExits(0));
    api.getContactDirectory().then(r => alive && setOnLeave((r?.people || []).filter(p => p.availability?.label === 'On Leave').length)).catch(() => alive && setOnLeave(0));
    return () => { alive = false; };
  }, [refreshKey]);


  return (
    <div className="pp-cards" style={{ gridTemplateColumns: isMobile ? '1fr' : 'minmax(220px, .8fr) minmax(0, 1.5fr) minmax(0, 1.3fr)' }}>
      {/* The headcount keeps its gradient tile (Neil, 11/08/2026). */}
      <button type="button" className="pp-hero" onClick={onJumpToDirectory} title="See the directory">
        <span className="pp-hero-label">People{nExternal ? ` · +${nExternal} external` : ''}</span>
        <span className="pp-hero-n">{loading ? <CountSkeleton /> : total}</span>
        <span className="pp-hero-sub">
          {[`${nActive} active`, nInactive > 0 && `${nInactive} inactive`, ...types.map(t => `${t.n} ${t.label.toLowerCase()}`)].filter(Boolean).join(' · ')}
        </span>
      </button>

      {/* What HR acts on this week; every count opens the people behind it. */}
      <div className="pp-card">
        <div className="pp-card-title">Status</div>
        <div className="pp-stats">
          <Stat loading={loading} label="Onboarding" n={nOnboarding} onGo={() => onStatusFilter?.('onboarding')} />
          <Stat loading={loading} label="Exits" n={exits} onGo={onGoExits} />
          <Stat loading={loading} label="On Leave Today" n={onLeave} />
          <Stat loading={loading} label="On Probation" n={nProbation} onGo={() => onStatusFilter?.('__probation:open__')} />
          <RecordsAudit row entityName={entityName} refreshKey={refreshKey} onOpen={onOpenPerson} />
        </div>
      </div>

      <div className="pp-card">
        <div className="pp-card-title">Departments{depts.length ? <span className="pp-card-meta">{depts.length}</span> : null}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <StatusDonut segments={deptSegs} total={total} size={84} />
          <div className="pp-legend">
            {deptSegs.map(d => (
              <span key={d.key}><i style={{ background: d.color }} /><em>{d.label}</em><b>{loading ? '-' : d.n}</b></span>
            ))}
            {!loading && deptSegs.length === 0 && <span style={{ color: 'var(--muted)' }}>Departments appear as people are added.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

// A role change waiting on approval (Pranshu, Oct 14): the People list marks
// the person so HR sees something is pending for them; a click opens it.
function PendingRoleBadge({ req, onOpen }) {
  if (!req) return null;
  const label = `Role change to ${req.toRoleName} - ${req.canDecide ? 'waiting for your approval' : 'awaiting approval'}`;
  const open = ev => { ev.stopPropagation(); onOpen(req); };
  return (
    <span role="button" tabIndex={0} title={label} aria-label={label} onClick={open}
      onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(ev); } }}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%', flexShrink: 0, cursor: 'pointer',
        background: 'hsla(var(--color-orange),0.16)', color: 'hsl(var(--color-orange))' }}>
      <Hourglass size={11} />
    </span>
  );
}

// A directory filter on a phone: half the row, so four make a 2x2.
// The multi-pick filters line up with the native selects beside them (16px on a phone - the iOS zoom rule).
const FILTER_TRIGGER = (phone) => phone ? { minHeight: 46, fontSize: 16 } : { minHeight: 38, fontSize: 13.5 };
const PHONE_FILTER = { flex: '1 1 calc(50% - 4px)', width: 'auto', minWidth: 0 };

export default function HR({ activeSub, onSubChange }) {
  const waiting = useActionCounts();   // the tab counts - `counts` below is the people tallies
  // Legacy subviews (hr-ms / hr-asana / …) all collapse into People for now.
  // E-Sign moved to its own top-level Documents module (Jul 2026); legacy
  // 'hr-esign*' deep-links are redirected there by the effect below.
  // hr-external intentionally absent (Neil, Aug 24: External tab folded into
  // People) - old deep links fall through to hr-people, where externals live now.
  // hr-access moved to the Admin module (Pranshu, Sep 9) - old deep links
  // redirect there by the effect below, so it's not in this list any more.
  // Dashboard tiles open the Time tab on a specific inner list.
  // 'hr-leave' was the People > Leave tab until Oct 27 2026 - it is Time Off now.
  const TIME_DEEP_LINKS = { 'hr-time-off': 'timeoff', 'hr-leave': 'timeoff', 'hr-time-requests': 'actions', 'hr-time-actions': 'actions', 'hr-time-invoices': 'invoices', 'hr-time-extra': 'extra' };
  // The manager tier sees its own team in People (Oct 6): People and Time only.
  const { hrTeam } = useRole();
  // People Analytics (Oct 27 2026) is HR's: the manager tier's /hr allowlist
  // does not open it either.
  const SUBS = hrTeam ? ['hr-people', 'hr-time'] : ['hr-people', 'hr-hiring', 'hr-org', 'hr-investors', 'hr-time', 'hr-checklists', 'hr-analytics', 'hr-reports', 'hr-exits', 'hr-performance'];
  const sub = TIME_DEEP_LINKS[activeSub] ? 'hr-time'
    : SUBS.includes(activeSub) ? activeSub : 'hr-people';
  const isMobile = useIsMobile();

  // Old notifications/URLs still point at hr/hr-esign* - bounce them to Documents
  // so those links don't dead-end on the People tab. Same for hr-access, now
  // that Roles & Access moved to the Admin module in full.
  useEffect(() => {
    if (String(activeSub || '').startsWith('hr-esign')) {
      const dst = activeSub === 'hr-esign-requests' ? 'documents-esign-requests' : 'documents-esign';
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: dst } }));
    } else if (activeSub === 'hr-time-attendance') {
      // Who is on / off moved to Shifts > Schedule (Neil, 10/06).
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'shifts', sub: 'schedule' } }));
    } else if (activeSub === 'hr-access') {
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'admin-console', sub: 'access' } }));
    }
  }, [activeSub]);

  const [employees, setEmployees] = useState([]);
  // Guest/external people (Aug 24: managed from People, not a separate tab).
  // Kept OUT of `employees` on purpose - counts, org chart, manager pickers and
  // every internal-only list keep reading `employees` unchanged; the directory
  // is the one surface that merges both.
  const [extEmployees, setExtEmployees] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [search,    setSearch]    = useState('');
  // Companies and Departments pick several (Neil, 11/08/2026); [] = all.
  const [deptF,     setDeptF]     = useState([]);
  const [companyF,  setCompanyF]  = useState([]);
  const [statusF,   setStatusF]   = useState('All');
  // Active / Inactive lens on the list (Neil, Oct 12): someone who has Left
  // or is Inactive is not removed, a status change moves them to the
  // Inactive tab. The status dropdown narrows further inside a lens.
  const [listTab,   setListTab]   = useState('active');
  const [typeF,     setTypeF]     = useState('All');   // All | employee | contractor | external
  // More Details (Oct 27 2026): pick a field to see it on every row, and
  // optionally narrow to a value. Only the fields this viewer may see arrive.
  const [cfDefs,    setCfDefs]    = useState([]);
  const [cfKey,     setCfKey]     = useState('');
  const [cfF,       setCfF]       = useState('');
  // DELETED_F is a view, not a status: a removed person keeps whatever status
  // they had, so it cannot live in STATUS_META alongside active/onboarding.
  const [deletedEmployees, setDeletedEmployees] = useState([]);
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [selectedId, setSelectedIdNow] = useState(null);
  // A person record holding unsaved edits asks before another one opens (11/03/2026).
  const setSelectedId = (id) => (id === selectedId ? setSelectedIdNow(id) : guardRecordLeave(() => setSelectedIdNow(id)));
  const [formOpen,  setFormOpen]  = useState(false);
  const [editing,   setEditing]   = useState(null);
  // Company Setup / Work Sites / Sync M365 moved to the Admin module in full
  // (Pranshu, Sep 9) - entities/sites data stays (used throughout this
  // screen for filters, dropdowns, scope names), the editors don't.
  const [entities,  setEntities]  = useState([]);
  const [sites,     setSites]     = useState([]);
  const [toast,     setToast]     = useState(null);
  // Open checklists per person ({employeeId: [progress]}) for the directory
  // and profile chips; refreshed when People or Checklists is opened.
  const [clProgress, setClProgress] = useState({});
  const [openTab, setOpenTab] = useState('overview'); // the profile tab a jump should land on
  // Bell / email "Review Request" on a role change (Pranshu, Oct 13) lands on
  // hr-role-change-<id>: open the decision right away, then People.
  const [roleDecisionId, setRoleDecisionId] = useState(null);
  const [pendingRoles, setPendingRoles] = useState({});   // employeeId -> waiting role change
  useEffect(() => {
    const m = String(activeSub || '').match(/^hr-role-change-(.+)$/);
    if (m) { setRoleDecisionId(m[1]); onSubChange?.('hr-people'); }
  }, [activeSub]);   // eslint-disable-line react-hooks/exhaustive-deps
  // The probation bell / email (Oct 27 2026) lands on hr-probation-<employee id>:
  // their profile, Overview, the Probation section in view.
  const [probationFocus, setProbationFocus] = useState('');
  useEffect(() => {
    const m = String(activeSub || '').match(/^hr-probation-(.+)$/);
    if (m) { setProbationFocus(m[1]); setOpenTab('overview'); setSelectedId(m[1]); onSubChange?.('hr-people'); }
  }, [activeSub]);   // eslint-disable-line react-hooks/exhaustive-deps
  // The federal-form bells ("W-4 Signed - <name>", 11/02/2026) land on
  // hr-documents-<employee id>: the person's Documents tab.
  useEffect(() => {
    const m = String(activeSub || '').match(/^hr-documents-(.+)$/);
    if (m) { setOpenTab('documents'); setSelectedId(m[1]); onSubChange?.('hr-people'); }
  }, [activeSub]);   // eslint-disable-line react-hooks/exhaustive-deps
  const { canAccessModule, can, hrScope } = useRole();
  const canSeeComp = !hrTeam && canAccessModule('hr_comp', 'owner', 'viewer');   // a team view never shows pay
  const isAdmin = can('administrator');   // Roles & Access tab is admin-only
  // People editors (HR grant at editor, or an administrator) - the server
  // checks the same thing on /hr/intacct-codes.
  const canSyncCodes = !hrTeam && canAccessModule('hr', 'administrator', 'editor');
  const [codesOpen, setCodesOpen] = useState(false);
  // Company-scoped People admin (Neil, Aug 25): hrScope = list of HrEntity ids
  // this admin is limited to (server-enforced; the lists that arrive are
  // already filtered). Non-null hides company-wide actions and shows a chip.
  const isScoped = !hrTeam && Array.isArray(hrScope) && hrScope.length > 0;
  const scopeNames = isScoped ? hrScope.map(id => entities.find(en => en.id === id)?.name || null).filter(Boolean) : [];

  // Stable across renders: children key their loaders on these, and a new
  // function per render made every toast reload the Time screens.
  // An error stays long enough to read (Neil, 10/06: the punch-sequence
  // message "disappeared before I could read it"): 10s, plus time for a long
  // message, paused while hovered, and closable. One timer - an older toast's
  // timer can no longer cut a newer one short.
  const toastTimer = useRef(null);
  const showToast = useCallback((msg, kind, ms) => {
    clearTimeout(toastTimer.current);
    setToast({ msg, kind, ms });
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);
  const toastErr = useCallback(msg => showToast(msg, 'error', Math.max(10000, String(msg || '').length * 70)), [showToast]);
  const toastOk  = useCallback(msg => showToast(msg, 'ok', 4000), [showToast]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Deep link from a person hover card anywhere in Nexus (openPersonProfile).
  // Two triggers, because this view may or may not be mounted when the jump
  // fires: the stash covers a cold mount, the event covers an already-open one.
  // Waits for `employees` - the jump carries an email and only the loaded list
  // can resolve it to the row id the detail pane selects on.
  useEffect(() => {
    if (!employees.length) return undefined;
    const openFor = email => {
      const em = (email || '').trim().toLowerCase();
      if (!em) return;
      const match = [...employees, ...extEmployees].find(x => (x.workEmail || '').toLowerCase() === em);
      if (match) setSelectedId(match.id);
      else toastErr(`${em} is not in People.`);
    };
    openFor(takePendingPerson());
    const h = e => openFor(e.detail?.email);
    window.addEventListener('nexus:person', h);
    return () => window.removeEventListener('nexus:person', h);
  }, [employees, extEmployees]);   // eslint-disable-line react-hooks/exhaustive-deps

  function load() {
    api.getEmployees()
      .then(rows => {
        // Split internal vs guest/external. `employees` stays internal-only so
        // the Total/Active/New joiners cards, By department chart, org chart
        // and every picker built on it are unchanged; externals join the
        // DIRECTORY via extEmployees (Neil, Aug 24: one master People list).
        setEmployees(rows.filter(e => !isExternalPerson(e)));
        setExtEmployees(rows.filter(isExternalPerson));
        setError('');
      })
      .catch(err => setError(err?.message || 'Could not load employees.'))
      .finally(() => setLoading(false));
  }
  // Removed people are a SEPARATE list, fetched only when the Deleted filter is
  // chosen. They are deliberately not folded into `employees`: everything else
  // on this screen (counts, org chart, manager lookups, pickers) treats that
  // array as "the people who work here", and a removed person appearing there
  // would be the exact leak the server-side global filter exists to prevent.
  function loadDeleted() {
    setDeletedLoading(true);
    api.getDeletedEmployees()
      .then(rows => { setDeletedEmployees(rows); setError(''); })
      .catch(err => setError(err?.message || 'Could not load removed people.'))
      .finally(() => setDeletedLoading(false));
  }
  const loadEntities = () => api.getEntities().then(setEntities).catch(() => setEntities([]));
  const loadSites = () => api.getWorkSites().then(setSites).catch(() => setSites([]));
  useEffect(load, []);
  useEffect(() => { loadEntities(); loadSites(); }, []);
  useEffect(() => { api.hrCustomFields().then(r => setCfDefs(Array.isArray(r) ? r : [])).catch(() => setCfDefs([])); }, []);
  const cfField = cfDefs.find(f => f.fieldKey === cfKey) || null;
  const cfShown = e => (cfField ? formatFieldValue(cfField, e.customFields?.[cfField.fieldKey]) : '');
  // Every person action (offboard, hire, status change, remove, restore,
  // provision, push to M365...) calls refreshPeople, so the tiles, the
  // directory, its counts, the open profile and the checklist chips all
  // re-read straight away (Charmi, Oct 20 2026: "this should all refresh
  // when an action happens"). One re-read, not a polling loop - the api
  // layer already drops its GET cache on every write, so this reads fresh.
  const [peopleRev, setPeopleRev] = useState(0);
  const refreshPeople = () => { load(); setPeopleRev(n => n + 1); };
  useEffect(() => {
    if (hrTeam || (sub !== 'hr-people' && sub !== 'hr-checklists')) return;
    api.getChecklistProgress().then(r => setClProgress(r.progress || {})).catch(() => {});
  }, [sub, selectedId, hrTeam, peopleRev]);
  useEffect(() => {
    if (sub !== 'hr-people') return;
    api.getRoleChangeRequests()
      .then(rows => setPendingRoles(Object.fromEntries((rows || []).map(r => [r.employeeId, r]))))
      .catch(() => {});
  }, [sub, selectedId, employees, roleDecisionId]);
  const openChecklistOf = (id) => { setOpenTab('checklist'); setSelectedId(id); onSubChange?.('hr-people'); };
  const entityName = id => entities.find(en => en.id === id)?.name || '';

  // Department filter choices are the departments actually in use, scoped to the
  // chosen company - no hardcoded list.
  const deptChoices = useMemo(() => {
    const src = companyF.length === 0 ? employees : employees.filter(e => companyF.includes(e.company));
    return [...new Set(src.map(e => (e.department || '').trim()).filter(Boolean))].sort();
  }, [employees, companyF]);

  const showingDeleted = statusF === DELETED_F;
  const isExtRow = isExternalPerson;
  const filtered = useMemo(() => {
    // The directory is the MASTER list: internal people + guest/external
    // accounts together (Neil, Aug 24), narrowed by the worker-type filter.
    const source = showingDeleted ? deletedEmployees
      : [...employees, ...extEmployees].sort((a, b) => fullName(a).localeCompare(fullName(b)));
    return source.filter(e => {
      if (!showingDeleted && statusF === 'All' && INACTIVE_STATUSES.has(e.status || 'active') !== (listTab === 'inactive')) return false;
      if (statusF === PROBATION_F && (!e.probation?.ending || INACTIVE_STATUSES.has(e.status || 'active'))) return false;
      if (PROBATION_LENS[statusF] && (!PROBATION_LENS[statusF](e.probation) || INACTIVE_STATUSES.has(e.status || 'active'))) return false;
      if (typeF === 'employee' && (isExtRow(e) || e.employmentType === 'contractor')) return false;
      if (typeF === 'contractor' && (isExtRow(e) || e.employmentType !== 'contractor')) return false;
      if (typeF === 'external' && !isExtRow(e)) return false;
      if (companyF.length && !companyF.includes(e.company)) return false;
      if (deptF.length && !deptF.includes((e.department || '').trim())) return false;
      if (cfField && !matchesFieldFilter(cfField, e.customFields?.[cfField.fieldKey], cfF)) return false;
      // Skipped while showing removed people - they keep their old status, so
      // matching on it here would filter the list down to nothing.
      if (!showingDeleted && statusF !== 'All' && statusF !== PROBATION_F && !PROBATION_LENS[statusF] && e.status !== statusF) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        return [fullName(e), e.workEmail, e.employeeCode, e.jobTitle, e.department, e.externalCompany].some(v => (v || '').toLowerCase().includes(q));
      }
      return true;
    });
  }, [employees, extEmployees, deletedEmployees, showingDeleted, typeF, companyF, deptF, statusF, search, listTab, cfField, cfF]);
  // Tab counts over the whole directory (not the other filters), so the
  // Inactive count reads the same whichever company or department is open.
  const tally = useMemo(() => peopleTallies(employees, extEmployees), [employees, extEmployees]);
  const tabCounts = { active: tally.current, inactive: tally.inactive };
  // What each tab count is made of, on hover: the Current tab holds active +
  // onboarding people AND external users, which is why it reads more than
  // the Active tile above (Charmi, Oct 20 2026: "Active 47" vs "Active 58") -
  // and why it is called Current, not Active (Neil, 11/05/2026).
  const tabTitles = {
    active: `${tally.people} people${tally.onboarding ? ` (${tally.onboarding} onboarding)` : ''} + ${tally.external} external`,
    inactive: 'People who have Left or are Inactive - their record stays in Nexus',
  };

  // Pagination over the FILTERED list, so search/filters always reach the whole
  // directory - a match "on page 10" simply becomes page 1 of the results.
  const PAGE_SIZE = 12;
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [search, companyF, deptF, statusF, typeF, cfKey, cfF]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(page, totalPages);
  const paged = useMemo(() => filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE),
    [filtered, curPage]);

  const selected = (showingDeleted ? deletedEmployees : [...employees, ...extEmployees])
    .find(e => e.id === selectedId) || null;

  const onRemovedFromNexus = (id) => {   // Nexus-only removal: drop from the live list and close the profile
    setEmployees(prev => prev.filter(e => e.id !== id));
    setExtEmployees(prev => prev.filter(e => e.id !== id));
    setDeletedEmployees([]);             // stale now; refetched when Deleted is opened
    setSelectedId(null);
    refreshPeople();
  };
  const onRestoredToNexus = (restored) => {
    setDeletedEmployees(prev => prev.filter(e => e.id !== restored.id));
    setEmployees(prev => prev.some(e => e.id === restored.id)
      ? prev
      : [...prev, restored].sort((a, b) => fullName(a).localeCompare(fullName(b))));
    setSelectedId(null);
    refreshPeople();
  };
  const onSaved = saved => {
    const isNew = !employees.some(e => e.id === saved.id) && !extEmployees.some(e => e.id === saved.id);   // add modal shows its own toast
    // Route the row to the list its identity belongs in - an edit can flip a
    // person between internal and guest/external.
    const ext = isExternalPerson(saved);
    const upsert = prev => {
      const i = prev.findIndex(e => e.id === saved.id);
      if (i === -1) return [...prev, saved].sort((a, b) => fullName(a).localeCompare(fullName(b)));
      const next = [...prev]; next[i] = saved; return next;
    };
    const drop = prev => prev.filter(e => e.id !== saved.id);
    setEmployees(ext ? drop : upsert);
    setExtEmployees(ext ? upsert : drop);
    setSelectedId(saved.id);
    refreshPeople();   // the row above is instant; this brings the server's word (counts, chips, side effects)
    // Profile edits auto-mirror to the linked Entra account (backend, best-effort)
    // - tell the user whether M365 actually took the change.
    if (saved.entra) {
      if (saved.entra.synced) toastOk('Saved - profile synced to Microsoft 365.');
      // Dev/localhost never write to Entra (shared tenant - only prod is the
      // source of truth for M365), so that is a plain save, not a failure.
      else if (saved.entra.skipped) toastOk('Saved. Microsoft 365 is only updated from production.');
      else toastErr(`Saved in Nexus, but the M365 sync failed: ${saved.entra.error || 'Graph error'}. Use "Push to M365" to retry.`);
    } else if (!isNew) {
      toastOk('Saved.');
    }
  };

  // People is a dropdown (Neil, 11/03/2026): the directory itself, the
  // Organizational Chart and Performance sit under it; a click on the tab
  // still opens the directory. The sub keys are unchanged, so every deep
  // link lands where it did.
  const PEOPLE_ITEMS = [
    { key: 'hr-people', label: 'People', Icon: Users },
    { key: 'hr-org', label: 'Organizational Chart', Icon: Network },
    // The investor book by relationship owner (Neil, Aug 11) - its own entry
    // since 11/07/2026, not a switch inside the org chart.
    { key: 'hr-investors', label: 'Investor Chart', Icon: Briefcase },
    { key: 'hr-performance', label: 'Performance', Icon: Target },
  ].filter(t => SUBS.includes(t.key));
  const FLAT_TABS = [
    { key: 'hr-people', label: 'People',    Icon: Users },
    { key: 'hr-hiring', label: 'Hiring',    Icon: UserPlus },
    { key: 'hr-org',    label: 'Organizational Chart', Icon: Network },
    { key: 'hr-time',   label: 'Time',      Icon: Clock },
    { key: 'hr-checklists', label: 'Checklists', Icon: ListChecks },
    // People Analytics (Neil, Oct 27 2026): the overview's headcount grown
    // into trends, attrition, tenure, absence and leave liability.
    { key: 'hr-analytics', label: 'Analytics', Icon: BarChart3 },
    // People Reports (Neil, Teams 11/02/2026): Company Directory, Employees,
    // Contractors - with filters and a CSV export.
    { key: 'hr-reports', label: 'Reports', Icon: FileText },
    // Exits In Progress + the final settlement statement (Neil, Oct 27 2026).
    { key: 'hr-exits', label: 'Exits', Icon: LogOut },
    // Performance (Oct 27 2026): review cycles and the company's goals.
    { key: 'hr-performance', label: 'Performance', Icon: Target },
    // The External tab is gone (Neil, Aug 24): external/guest people live in
    // the People directory with a worker-type filter, and their lifecycle
    // actions sit on their profile card.
    // Roles & Access moved to the Admin module in full (Pranshu, Sep 9) - no
    // longer a People tab.
  ].filter(t => SUBS.includes(t.key));
  const IN_PEOPLE = new Set(PEOPLE_ITEMS.map(t => t.key));
  const TABS = PEOPLE_ITEMS.length > 1
    ? [{ key: 'hr-people-menu', label: 'People', Icon: Users, landing: 'hr-people', items: PEOPLE_ITEMS },
      ...FLAT_TABS.filter(t => !IN_PEOPLE.has(t.key))]
    : FLAT_TABS;
  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Full-bleed (owner call, Jul 28): use the whole viewport width - the
          .viewport padding provides the slight edge margin. No page title: the
          module bar names the module and the lit tab (Neil, 11/06/2026). */}
        {/* The page's actions ride the module bar's right end (one page header, 11/05/2026). */}
        {sub === 'hr-people' && (
          <ModuleActions>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap', alignItems: 'center', maxWidth: '100%' }}>
            {hrTeam && (
              <span title="As a manager you see the people who report to you, directly or through your managers - hours and profiles, never pay."
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', fontSize: 12, fontWeight: 700 }}>
                <Users size={13} /> Showing: Your Team
              </span>
            )}
            {isScoped && (
              <span title="Your People access is limited to these companies - people, time and leave outside them are not shown."
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', fontSize: 12, fontWeight: 700 }}>
                <Building2 size={13} /> Showing: {scopeNames.length ? scopeNames.join(', ') : 'your companies'}
              </span>
            )}
            {/* Sync M365 / Company setup / Work sites moved to the Admin
                module in full (Pranshu, Sep 9) - no longer buttons here. */}
            {/* A desk job - not offered on a phone (Neil, 11/08/2026 phone pass). */}
            {canSyncCodes && !isMobile && (
              <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
                onClick={() => setCodesOpen(true)} title="Match People to Intacct employees and update their employee codes">
                <RefreshCw size={14} /> Sync Employee Codes From Intacct
              </button>
            )}
            {/* One Add Person (Neil, 11/03/2026): one sheet asks who you are
                adding - Employee, Independent Contractor, External (admins
                only, as before) or Guest - all into the same master list. */}
            {!hrTeam && (
              <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
                onClick={() => { setEditing(null); setFormOpen(true); }}>
                <Plus size={15} /> Add Person
              </button>
            )}
          </div>
          </ModuleActions>
        )}

      {/* Tabs - desktop renders them in the module bar; phones keep the
          in-page strip (ModuleTabs handles both) */}
      <ModuleTabs tabs={withBadges(TABS, waiting, 'hr')} active={sub} onChange={onSubChange} overflow syncTitle />

      {codesOpen && (
        <Suspense fallback={<ModalLoading />}>
          <IntacctEmployeeCodes onClose={() => setCodesOpen(false)} onApplied={refreshPeople} toastOk={toastOk} toastErr={toastErr} />
        </Suspense>
      )}

      {sub === 'hr-hiring' && (
        <HiringTab isMobile={isMobile} toastOk={toastOk} toastErr={toastErr}
          onEmployeeCreated={emp => { setEmployees(prev => [...prev, emp].sort((a, b) => fullName(a).localeCompare(fullName(b)))); refreshPeople(); }}
          onSendForSignature={c => {
            // E-Sign lives in the Documents module now - stash the offer and jump
            // there; Documents picks up window.__esignPrefill on arrival.
            window.__esignPrefill = {
              candidateId: c.id, title: `Offer - ${candName(c)}`,
              parties: [{ role_key: 'employee', name: candName(c), email: c.email, kind: 'external', ordinal: 2 }],
            };
            window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-esign' } }));
          }} />
      )}
      {sub === 'hr-org' && <OrgChartTab employees={employees} externals={extEmployees} entities={entities} onUpdated={onSaved}
        onOpenRecord={p => { setOpenTab('job'); setSelectedId(p.id); onSubChange?.('hr-people'); }} toastOk={toastOk} toastErr={toastErr} />}
      {sub === 'hr-investors' && <InvestorChart employees={employees} toastOk={toastOk} toastErr={toastErr} />}
      {/* Leave balances, the year end, approval stand-ins and the old Leave
          history sit under Time > Time Off now (hrPanels, Oct 27 2026). */}
      {sub === 'hr-time' && <TimeAdmin key={activeSub} initialView={TIME_DEEP_LINKS[activeSub]} hrPanels toastOk={toastOk} toastErr={toastErr} />}
      {sub === 'hr-analytics' && (
        <Suspense fallback={<SkeletonBlocks count={3} height={140} />}>
          <HrAnalytics onOpenPerson={id => { setOpenTab('overview'); setSelectedId(id); onSubChange?.('hr-people'); }} />
        </Suspense>
      )}
      {/* Operations only (Neil, Oct 19: "once it's set up, we should be just
          operating it") - the steps are set up in Settings. */}
      {sub === 'hr-checklists' && (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--wk-dim)', marginBottom: 14 }}>
            Steps are set up in Settings &gt; Hiring &amp; Onboarding: the Checklist Library for the standard ones, each company&apos;s Checklists with that company picked, and Team &gt; Role Checklists for a role&apos;s own steps.
          </div>
          <ChecklistBoard entities={entities} onOpen={openChecklistOf} />
        </>
      )}

      {sub === 'hr-reports' && (
        <Suspense fallback={<SkeletonBlocks count={3} height={60} />}>
          <PeopleReports employees={employees} externals={extEmployees} entities={entities} />
        </Suspense>
      )}

      {sub === 'hr-exits' && (
        <Suspense fallback={<SkeletonBlocks count={3} height={60} />}>
          <ExitsTab toastOk={toastOk} toastErr={toastErr} />
        </Suspense>
      )}
      {sub === 'hr-performance' && (
        <Suspense fallback={<SkeletonBlocks count={2} height={140} />}>
          <PerformanceAdmin toastOk={toastOk} toastErr={toastErr} />
        </Suspense>
      )}

      {sub === 'hr-people' && (<>
        {!hrTeam && <EmployeeRequestsPanel toastOk={toastOk} toastErr={toastErr} />}
        {/* HR letters waiting on HR (Oct 27 2026) - the server decides who sees them: the company's HR contact, administrators, Full HR. */}
        <LetterRequestsPanel toastOk={toastOk} toastErr={toastErr} />
        {/* Three cards: People, Status (what HR acts on), Departments. A phone
            with a record open shows the record, not the cards above it. */}
        {!hrTeam && !(selected && isMobile) && <PeopleStatCards employees={employees} externals={extEmployees} loading={loading} isMobile={isMobile}
          onStatusFilter={s => { setStatusF(s); setSelectedId(null); }}
          onJumpToDirectory={() => { setSelectedId(null); setStatusF('All'); }}
          onGoExits={() => onSubChange?.('hr-exits')}
          entityName={entityName} refreshKey={peopleRev} onOpenPerson={id => { setOpenTab('documents'); setSelectedId(id); }} />}

        {error && (
          <div style={{ background: 'var(--bad-bg)', color: 'var(--bad-fg)', borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 14 }}>
            {error} <button onClick={() => { setLoading(true); load(); }} style={{ background: 'none', border: 'none', color: 'inherit', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>Retry</button>
          </div>
        )}

        {selected && isMobile ? (
          /* Phones keep the focused full-screen profile with an explicit way
             back; desktop now shows the profile IN PLACE beside the list. */
          <>
          <button onClick={() => setSelectedId(null)} className="secondary-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
            <ChevronLeft size={14} /> Back to directory
          </button>
          <EmployeeDetail key={selected.id} e={selected} employees={[...employees, ...extEmployees]} isMobile={isMobile} teamView={hrTeam}
            companyName={entityName(selected.company)} canSeeComp={canSeeComp} isAdmin={isAdmin}
            initialTab={openTab} checklists={clProgress[selected.id] || []} focusProbation={probationFocus === selected.id}
            toastOk={toastOk} toastErr={toastErr} onEmployeeUpdated={onSaved} onRemoved={onRemovedFromNexus} onRestored={onRestoredToNexus}
            onExternalChanged={refreshPeople} onReload={refreshPeople}
            onEdit={emp => { setEditing(emp); setFormOpen(true); }}
            onBack={() => setSelectedId(null)} />
          </>
        ) : (
          /* Directory - Stella's employee table: card header carries the
             search + filters; gray column-header band; avatar + name + email
             rows; whole row opens the profile. */
          <div className="wkc">
            <div className="wkc-head">
              <span className="wkc-chip"><Users size={14} /></span>
              <span className="wkc-title">Directory</span>
              {!loading && filtered.length > 0 && <span className="dk-count">{filtered.length}</span>}
              {/* Phone (Oct 17): full-width search, then the four filters as a clean 2x2. */}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', ...(isMobile ? { width: '100%' } : {}) }}>
                <div className="search-bar" style={{ width: isMobile ? '100%' : 210 }}>
                  <Search size={13} style={{ flexShrink: 0 }} />
                  <input placeholder="Search people…" value={search} onChange={e => setSearch(e.target.value)} />
                  {search && <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><X size={13} /></button>}
                </div>
                {/* Worker-type filter (Neil, Aug 24): the directory is the master
                    list, this narrows it to a category. */}
                <select className="form-input" value={typeF} onChange={e => { setTypeF(e.target.value); setSelectedId(null); }} style={{ ...(isMobile ? PHONE_FILTER : { width: 140 }), padding: '7px 10px', fontSize: 13.5, height: 38 }}>
                  <option value="All">All People</option>
                  <option value="employee">Employees</option>
                  <option value="contractor">Contractors</option>
                  <option value="external">External &amp; guests</option>
                </select>
                <div style={isMobile ? PHONE_FILTER : { width: 170 }}>
                  <ChipMultiSelect value={companyF} onChange={v => { setCompanyF(v); setDeptF([]); setSelectedId(null); }} placeholder="All Companies" searchPlaceholder="Search companies…" placeholderInk triggerStyle={FILTER_TRIGGER(isMobile)}
                    options={entities.map(en => ({ id: en.id, label: en.name }))} />
                </div>
                <div style={isMobile ? PHONE_FILTER : { width: 170 }}>
                  <ChipMultiSelect value={deptF} onChange={v => { setDeptF(v); setSelectedId(null); }} placeholder="All Departments" searchPlaceholder="Search departments…" placeholderInk triggerStyle={FILTER_TRIGGER(isMobile)}
                    options={deptChoices.map(d => ({ id: d, label: d }))} />
                </div>
                {/* Choosing Deleted fetches that list here rather than in an
                    effect - the dropdown is the only way into the view, so the
                    fetch belongs to the action that causes it. */}
                <select className="form-input" value={statusF}
                  onChange={e => {
                    const next = e.target.value;
                    setStatusF(next);
                    setSelectedId(null);
                    if (next === DELETED_F) loadDeleted();
                  }}
                  style={{ ...(isMobile ? PHONE_FILTER : { width: 135 }), padding: '7px 10px', fontSize: 13.5, height: 38 }}>
                  <option value="All">All Statuses</option>
                  {Object.entries(STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
                  <option value={PROBATION_F}>Probation Ending</option>
                  {PROBATION_LENSES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  <option value={DELETED_F}>Deleted</option>
                </select>
                {cfDefs.length > 0 && (
                  <select className="form-input" aria-label="Show a More Details field" value={cfKey}
                    onChange={e => { setCfKey(e.target.value); setCfF(''); }}
                    title="Show one of the More Details fields on every row, and narrow the list by it"
                    style={{ ...(isMobile ? PHONE_FILTER : { width: 165 }), padding: '7px 10px', fontSize: 13.5, height: 38 }}>
                    <option value="">More Details field</option>
                    {cfDefs.map(f => <option key={f.fieldKey} value={f.fieldKey}>{f.label}</option>)}
                  </select>
                )}
                {cfField && (cfField.fieldType === 'dropdown' || cfField.fieldType === 'checkbox' ? (
                  <select className="form-input" aria-label={`Filter by ${cfField.label}`} value={cfF} onChange={e => setCfF(e.target.value)}
                    style={{ ...(isMobile ? PHONE_FILTER : { width: 150 }), padding: '7px 10px', fontSize: 13.5, height: 38 }}>
                    <option value="">Any {cfField.label}</option>
                    {cfField.fieldType === 'checkbox'
                      ? <><option value="yes">Yes</option><option value="no">No</option></>
                      : <>{(cfField.options || []).map(o => <option key={o} value={o}>{o}</option>)}<option value="__empty">No value</option></>}
                  </select>
                ) : (
                  <input className="form-input" aria-label={`Filter by ${cfField.label}`} value={cfF} onChange={e => setCfF(e.target.value)}
                    placeholder={`${cfField.label} contains…`}
                    style={{ ...(isMobile ? PHONE_FILTER : { width: 160 }), padding: '7px 10px', fontSize: 13.5, height: 38 }} />
                ))}
              </div>
            </div>
            {!showingDeleted && statusF === 'All' && (
              <div className="scroll-tabs" style={{ display: 'flex', gap: 2, padding: '0 14px', borderBottom: '1px solid var(--line)' }}>
                {[['active', 'Current'], ['inactive', 'Inactive']].map(([id, label]) => (
                  <button key={id} onClick={() => { setListTab(id); setSelectedId(null); setPage(1); }}
                    title={tabTitles[id]}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 12px', fontSize: 13, fontWeight: 600, fontFamily: 'Inter,sans-serif', background: 'none', border: 'none', borderBottom: `2px solid ${listTab === id ? 'var(--pine)' : 'transparent'}`, color: listTab === id ? 'var(--ink)' : 'var(--muted)', cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: -1 }}>
                    {label}
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: listTab === id ? 'var(--wk-brand-tint)' : 'var(--mist)', color: listTab === id ? 'var(--pine)' : 'var(--muted)' }}>{loading ? <CountSkeleton width="1.2em" /> : tabCounts[id]}</span>
                  </button>
                ))}
              </div>
            )}
            {(loading || (showingDeleted && deletedLoading)) ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}>
                <Spinner size="section" />
              </div>
            ) : showingDeleted && deletedEmployees.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--muted)' }}>
                <Trash2 size={30} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
                <div style={{ fontSize: 14, fontWeight: 600 }}>Nobody has been removed.</div>
                <div style={{ fontSize: 12.5, marginTop: 4 }}>People removed from Nexus land here, and can be restored with their full record.</div>
              </div>
            ) : !showingDeleted && employees.length + extEmployees.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--muted)' }}>
                <Users size={32} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
                <div style={{ fontSize: 14, fontWeight: 600 }}>No employees yet.</div>
                <div style={{ fontSize: 12.5, marginTop: 4 }}>Add the first one - everything else in HR builds on these records.</div>
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No matches.</div>
            ) : isMobile ? (
              <>
              <table className="ppl-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th className="ppl-col-secondary">Position</th>
                    <th className="ppl-col-secondary">Department</th>
                    {cfField && <th>{cfField.label}</th>}
                    <th>Status</th>
                    <th style={{ width: 34 }} aria-label="Open profile" />
                  </tr>
                </thead>
                <tbody>
                  {paged.map(e => {
                    const sm = STATUS_META[e.status] || STATUS_META.active;
                    return (
                      <tr key={e.id} className={pendingRoles[e.id]?.canDecide ? 'nx-needs-you--row' : undefined} onClick={() => { setOpenTab('overview'); setSelectedId(e.id); }}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
                            <Avatar e={e} card={false} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                                {fullName(e)}{isExtRow(e) && <ExternalBadge />}<TierMark tier={e.tier} />
                                <PendingRoleBadge req={pendingRoles[e.id]} onOpen={r => setRoleDecisionId(r.id)} />
                              </div>
                              <div className="ppl-cell-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {e.workEmail || e.employeeCode}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="ppl-col-secondary">{e.jobTitle || '-'}</td>
                        <td className="ppl-col-secondary">{e.department || '-'}</td>
                        {cfField && <td>{cfShown(e) || '-'}</td>}
                        <td>
                          <span style={{ padding: '4px 11px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, background: sm.bg, color: sm.fg, whiteSpace: 'nowrap' }}>{sm.label}</span>
                          {e.probation?.ending && <div style={{ marginTop: 4 }}><ProbationBadge p={e.probation} /></div>}
                          {(clProgress[e.id] || []).map(p => <div key={p.checklistId} style={{ marginTop: 4 }}><ChecklistChip p={p} compact onClick={() => openChecklistOf(e.id)} /></div>)}
                        </td>
                        <td><ChevronRight size={14} style={{ color: 'var(--wk-faint)' }} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {totalPages > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderTop: '1px solid var(--line)', fontSize: 12.5, color: 'var(--muted)' }}>
                  <span>{(curPage - 1) * PAGE_SIZE + 1}-{Math.min(curPage * PAGE_SIZE, filtered.length)} of {filtered.length}</span>
                  <span style={{ flex: 1 }} />
                  <button className="secondary-btn" style={{ padding: '4px 10px', fontSize: 12 }} disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>Prev</button>
                  <span style={{ fontWeight: 700 }}>Page {curPage} of {totalPages}</span>
                  <button className="secondary-btn" style={{ padding: '4px 10px', fontSize: 12 }} disabled={curPage >= totalPages} onClick={() => setPage(curPage + 1)}>Next</button>
                </div>
              )}
              </>
            ) : (
              /* Desktop master-detail: names on the left, the profile opens in
                 place on the right - no back-navigation. The list paginates;
                 search/filters run over the WHOLE directory before paging. */
              <div style={{ display: 'grid', gridTemplateColumns: '330px 1fr', alignItems: 'stretch' }}>
                <div style={{ borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 460 }}>
                  <div style={{ flex: 1, overflowY: 'auto', maxHeight: '64vh' }}>
                    {paged.map(e => {
                      const sm = STATUS_META[e.status] || STATUS_META.active;
                      const active = selectedId === e.id;
                      return (
                        <button key={e.id} className={pendingRoles[e.id]?.canDecide && !active ? 'nx-needs-you--row' : undefined} onClick={() => { setOpenTab('overview'); setSelectedId(e.id); }}
                          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '9px 14px', border: 'none', borderBottom: '1px solid var(--line)', cursor: 'pointer', background: active ? 'var(--wk-brand-tint)' : 'none', fontFamily: 'inherit' }}>
                          <Avatar e={e} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                              {fullName(e)}{isExtRow(e) && <ExternalBadge />}<TierMark tier={e.tier} />
                                <PendingRoleBadge req={pendingRoles[e.id]} onOpen={r => setRoleDecisionId(r.id)} />
                            </div>
                            <div className="ppl-cell-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.jobTitle || e.externalCompany || e.workEmail || '-'}</div>
                            {cfField && (
                              <div className="ppl-cell-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                <span style={{ fontWeight: 600 }}>{cfField.label}:</span> {cfShown(e) || '-'}
                              </div>
                            )}
                            {e.probation?.ending && <div style={{ marginTop: 4 }}><ProbationBadge p={e.probation} /></div>}
                            {(clProgress[e.id] || []).length > 0 && (
                              <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                                {clProgress[e.id].map(p => <ChecklistChip key={p.checklistId} p={p} compact onClick={() => openChecklistOf(e.id)} />)}
                              </div>
                            )}
                          </div>
                          <span title={sm.label} style={{ width: 8, height: 8, borderRadius: '50%', background: sm.fg, flexShrink: 0 }} />
                          <ChevronRight size={13} style={{ color: 'var(--wk-faint)', flexShrink: 0 }} />
                        </button>
                      );
                    })}
                  </div>
                  {totalPages > 1 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 12px', borderTop: '1px solid var(--line)', fontSize: 12, color: 'var(--muted)' }}>
                      <span>{(curPage - 1) * PAGE_SIZE + 1}-{Math.min(curPage * PAGE_SIZE, filtered.length)} of {filtered.length}</span>
                      <span style={{ flex: 1 }} />
                      <button className="secondary-btn" style={{ padding: '3px 9px', fontSize: 11.5 }} disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>Prev</button>
                      <span style={{ fontWeight: 700 }}>{curPage}/{totalPages}</span>
                      <button className="secondary-btn" style={{ padding: '3px 9px', fontSize: 11.5 }} disabled={curPage >= totalPages} onClick={() => setPage(curPage + 1)}>Next</button>
                    </div>
                  )}
                </div>
                <div style={{ padding: '16px 18px', minWidth: 0 }}>
                  {selected ? (
                    <EmployeeDetail key={selected.id} e={selected} employees={[...employees, ...extEmployees]} isMobile={isMobile} teamView={hrTeam}
                      companyName={entityName(selected.company)} canSeeComp={canSeeComp} isAdmin={isAdmin}
                      initialTab={openTab} checklists={clProgress[selected.id] || []} focusProbation={probationFocus === selected.id}
                      toastOk={toastOk} toastErr={toastErr} onEmployeeUpdated={onSaved} onRemoved={onRemovedFromNexus} onRestored={onRestoredToNexus}
                      onExternalChanged={refreshPeople} onReload={refreshPeople}
                      onEdit={emp => { setEditing(emp); setFormOpen(true); }}
                      onBack={() => setSelectedId(null)} />
                  ) : (
                    <div style={{ padding: '64px 16px', textAlign: 'center', color: 'var(--muted)' }}>
                      <Users size={30} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>Pick a person</div>
                      <div style={{ fontSize: 12.5, marginTop: 4 }}>Their full profile opens right here - no page hopping.</div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </>)}

      {formOpen && !editing && (
        <AddPersonSheet employees={employees} externals={extEmployees} entities={entities} isAdmin={isAdmin} canAddExternal={isAdmin}
          canSeeComp={canSeeComp} onClose={() => setFormOpen(false)} onSaved={onSaved}
          onExternalSaved={(result) => {
            inviteOutcomeToast(result, toastOk, toastErr);
            refreshPeople();   // the new external lands in the directory (master list)
          }}
          toastOk={toastOk} toastErr={toastErr} />
      )}
      {roleDecisionId && <RoleChangeDecisionModal requestId={roleDecisionId} toastOk={toastOk} toastErr={toastErr}
        onClose={() => setRoleDecisionId(null)}
        onDecided={out => { setRoleDecisionId(null); refreshPeople(); setOpenTab('access'); setSelectedId(out.employeeId); }} />}
      {toast && (
        <div role={toast.kind === 'error' ? 'alert' : 'status'}
          onMouseEnter={() => clearTimeout(toastTimer.current)}
          onMouseLeave={() => { clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 4000); }}
          style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 10px 10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: 'min(640px, 90vw)', display: 'flex', alignItems: 'flex-start', gap: 10, lineHeight: 1.45 }}>
          <span style={{ flex: 1 }}>{toast.msg}</span>
          <button type="button" aria-label="Dismiss" onClick={() => { clearTimeout(toastTimer.current); setToast(null); }}
            style={{ background: 'rgba(255,255,255,0.18)', border: 'none', color: '#fff', borderRadius: 6, width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
