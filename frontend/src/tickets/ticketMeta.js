// Ticket Module - types, per-type intake fields, status/SLA policy and the small
// pure helpers built on them. No JSX and no component imports: this is the
// module's configuration layer, imported by every other ticket file.
import { Ticket, Bug, AlertOctagon, Wrench, HelpCircle, ClipboardList, Lightbulb, RefreshCw, KeyRound, ShieldAlert, Timer } from 'lucide-react';
import { fmtDate as fmtDateRaw } from '../tasks/lib';
import { NX } from '../tasks/theme';

export const fmtDate = (iso) => (iso ? fmtDateRaw(iso) : '-');
export const today = () => new Date().toISOString().slice(0, 10);

// ── Ticket issue types ───────────────────────────────────────────────────────
export const TICKET_TYPE_META = {
  bug:             { label: 'Bug Report',      icon: Bug,           color: NX.red },
  incident:        { label: 'Incident',        icon: AlertOctagon,  color: NX.amber },
  service_request: { label: 'Service Request', icon: Wrench,        color: NX.blue },
  feature_request: { label: 'Feature Request', icon: Lightbulb,     color: NX.green },
  task:            { label: 'Task',            icon: ClipboardList, color: NX.purple },
  question:        { label: 'Question',        icon: HelpCircle,    color: NX.dim },
  change_request:  { label: 'Change Request',  icon: RefreshCw,     color: NX.amber },
  access_request:  { label: 'Access Request',  icon: KeyRound,      color: NX.teal },
  request:         { label: 'Request',         icon: Ticket,        color: NX.blue },
  other:           { label: 'Other',           icon: Ticket,        color: NX.dim },
};
// Selectable types at intake, in the order a requester sees them. Everything
// NOT in this list still lives in TICKET_TYPE_META/TYPE_FIELDS so tickets
// already raised as one keep rendering with their own label, icon and answers -
// retiring a type must never turn existing tickets into blanks.
//
// Narrowed to four (Aug 2026). Incident/Feature Request/Question/Change Request
// asked a requester to classify their own problem into distinctions only the
// people triaging them can draw, and a wrong pick routes the ticket wrong.
// `task` and `request` were already absent: `task` asked for
// assignee/project/sprint/estimate, duplicating the Task module and
// contradicting triage routing (tickets arrive unassigned; the department lead
// assigns them). Escalate a ticket into a task instead.
export const TICKET_TYPE_ORDER = ['service_request', 'access_request', 'bug', 'other'];

// Screen recording is for showing a reproducible problem (bugs, incidents) -
// feature and service requests are asks, not something to demonstrate on
// screen, so the Record option is hidden for them (Upload still works).
export const NO_RECORDING_TYPES = ['feature_request', 'service_request', 'access_request', 'other'];

// Per-type intake fields - the extra questions each ticket type asks, on top of
// the common ones: Company, Department and Type (wizard step 1), then Priority,
// Title and Description (step 2). Don't re-ask any of those here.
// Values are stored on the ticket's `typeFields` JSON, keyed by `key`.
// Field types: text · textarea · select · radio · number · date · datetime ·
//              person · multiperson · project · multiselect · checklist. `req`
//              marks required (shown with *), `full` spans both grid columns.
export const TYPE_FIELDS = {
  // WHAT broke -> HOW BADLY -> WHAT HAPPENED -> WHERE. Severity sits second
  // because it is the field triage sorts on; it was last and optional, so the
  // queue had nothing to sort by. Environment (browser/OS) follows the
  // reproduction steps rather than preceding them - it qualifies the report, it
  // is not what the report is about.
  bug: [
    { key: 'module', label: 'Application / Module', type: 'text', req: true },
    { key: 'severity', label: 'Severity', type: 'radio', options: ['Minor', 'Major', 'Critical', 'Blocker'], req: true },
    { key: 'stepsToReproduce', label: 'Steps to Reproduce', type: 'textarea', full: true, req: true, placeholder: '1.\n2.\n3.' },
    { key: 'expectedResult', label: 'Expected Result', type: 'textarea', req: true },
    { key: 'actualResult', label: 'Actual Result', type: 'textarea', req: true },
    // Whether it reproduces is the difference between "fix it now" and "watch
    // it", and it is the first thing an engineer asks the reporter.
    { key: 'reproducibility', label: 'How Often', type: 'radio', options: ['Always', 'Sometimes', 'Saw It Once'] },
    { key: 'browser', label: 'Browser', type: 'select', options: ['Chrome', 'Firefox', 'Safari', 'Edge', 'Other'] },
    { key: 'os', label: 'OS', type: 'select', options: ['Windows', 'macOS', 'Linux', 'iOS', 'Android', 'Other'] },
    { key: 'errorMessage', label: 'Error Message', type: 'textarea', full: true },
  ],
  incident: [
    { key: 'affectedService', label: 'Affected Service', type: 'text', req: true },
    { key: 'occurredAt', label: 'Date & Time Occurred', type: 'datetime', req: true },
    // Impact = how wide the blast radius is. Urgency deliberately lives on the
    // common Priority field (which also derives the SLA date) - asking both here
    // gave three overlapping severity controls on mismatched scales.
    { key: 'impact', label: 'Impact', type: 'radio', options: ['One User', 'Multiple Users', 'Department', 'Entire Organization'], req: true },
    { key: 'affectedUsers', label: 'Affected Users', type: 'multiperson' },
    { key: 'workaroundAvailable', label: 'Workaround Available?', type: 'radio', options: ['Yes', 'No'] },
    { key: 'workaroundDetail', label: 'Workaround (if yes)', type: 'textarea', full: true },
  ],
  // WHAT -> FOR WHOM -> WHY -> WHEN -> COST -> WHERE. Service Category was
  // already removed: step 1's department says which function fulfils it.
  service_request: [
    { key: 'requestedService', label: 'Requested Service', type: 'text', req: true, placeholder: 'e.g. CCTV Installation' },
    // A person, not a Myself/Another User radio. The radio had no follow-up
    // field, so "Another User" produced a request with no way to say WHO it was
    // for and fulfilment had to go and ask. Blank means the requester, the way
    // every service catalogue defaults it.
    { key: 'requestedFor', label: 'Requested For (blank = yourself)', type: 'person' },
    { key: 'businessJustification', label: 'Business Justification', type: 'textarea', full: true, req: true },
    { key: 'requiredBy', label: 'Required By', type: 'date' },
    { key: 'estimatedCost', label: 'Estimated Cost', type: 'number', prefix: '₹' },
    // Optional, and renamed: most requests are software or access and have no
    // physical destination. Required Location made every one of those carry an
    // invented answer.
    { key: 'location', label: 'Delivery Location', type: 'text' },
    // Retired: a requester nominating their own approver is a control weakness
    // an auditor would flag. Approval belongs to the workflow, derived from the
    // requester's department and manager. Kept here so tickets that already
    // captured one still show it.
    { key: 'approver', label: 'Approver', type: 'person', retired: true },
  ],
  feature_request: [
    { key: 'module', label: 'Module', type: 'text', req: true },
    { key: 'currentProblem', label: 'Current Problem', type: 'textarea', full: true, req: true },
    { key: 'proposedSolution', label: 'Proposed Solution', type: 'textarea', full: true, req: true },
    { key: 'businessValue', label: 'Business Value', type: 'radio', options: ['Saves Time', 'Reduces Errors', 'Automation', 'Compliance', 'Reporting'], req: true },
    { key: 'expectedBenefit', label: 'Expected Benefit', type: 'textarea', full: true },
    { key: 'targetUsers', label: 'Target Users', type: 'multiperson' },
  ],
  task: [
    { key: 'project', label: 'Project', type: 'project', req: true },
    { key: 'sprint', label: 'Sprint', type: 'text' },
    { key: 'assignee', label: 'Assignee', type: 'person', req: true },
    { key: 'dueDate', label: 'Due Date', type: 'date', req: true },
    { key: 'estimatedHours', label: 'Estimated Hours', type: 'number', placeholder: '12' },
    { key: 'labels', label: 'Labels', type: 'multiselect', options: ['Backend', 'Frontend', 'Database', 'UI'] },
    { key: 'dependencies', label: 'Dependencies', type: 'text', placeholder: 'Ticket / task refs' },
    { key: 'checklist', label: 'Checklist', type: 'checklist', full: true,
      items: ['Requirement Reviewed', 'Development', 'Code Review', 'Testing', 'Deployment'] },
  ],
  // Title and Description already capture the topic and the question itself, and
  // Priority covers urgency - a question only needs to say what it is about.
  question: [
    { key: 'module', label: 'Application / Module', type: 'text' },
  ],
  change_request: [
    { key: 'affectedSystem', label: 'Affected System', type: 'text', req: true },
    { key: 'currentConfiguration', label: 'Current Configuration', type: 'textarea', full: true, req: true },
    { key: 'requestedChange', label: 'Requested Change', type: 'textarea', full: true, req: true },
    { key: 'reason', label: 'Reason', type: 'textarea', full: true, req: true },
    { key: 'riskAssessment', label: 'Risk Assessment', type: 'radio', options: ['Low', 'Medium', 'High'], req: true },
    { key: 'downtimeRequired', label: 'Downtime Required?', type: 'radio', options: ['Yes', 'No'] },
    { key: 'implementationDate', label: 'Implementation Date', type: 'date' },
    { key: 'rollbackPlan', label: 'Rollback Plan', type: 'textarea', full: true, req: true },
    { key: 'approver', label: 'Approver', type: 'person', req: true },
  ],
  // WHAT system -> WHAT LEVEL -> FOR WHOM -> WHICH environment -> WHY -> UNTIL
  // WHEN. Every field here is something an access reviewer reads back during a
  // quarterly recertification, which is why the justification is required and
  // the expiry is asked for plainly.
  access_request: [
    { key: 'application', label: 'Application / System', type: 'text', req: true },
    { key: 'accessType', label: 'Access Level', type: 'radio', options: ['Read', 'Write', 'Admin'], req: true },
    { key: 'user', label: 'Access For (blank = yourself)', type: 'person' },
    // Prod and UAT are different grants carrying different risk; granting one
    // when the other was meant is the commonest access mistake there is.
    { key: 'environment', label: 'Environment', type: 'select', options: ['Production', 'UAT / Staging', 'Development', 'All'] },
    { key: 'reason', label: 'Business Justification', type: 'textarea', full: true, req: true },
    // Standing access is what audits object to, so the expiry is a first-class
    // question. Blank is allowed - some access genuinely is permanent.
    { key: 'endDate', label: 'Access Until (blank = permanent)', type: 'date' },
    // Retired: self-nominated approval is not approval - same reason as the
    // service-request approver.
    { key: 'managerApproval', label: 'Manager Approval', type: 'person', retired: true },
    // Retired: access starts when it is granted. A required start date was a
    // question with no useful answer, and every requester typed today.
    { key: 'startDate', label: 'Start Date', type: 'date', retired: true },
  ],
  request: [
    { key: 'businessJustification', label: 'Business Justification', type: 'textarea', full: true },
    { key: 'expectedOutcome', label: 'Expected Outcome', type: 'textarea', full: true },
  ],
};

// A type-field counts as empty when it's unset, blank text, or an empty
// multi-value (multiselect / checklist). Drives both required-field validation
// and which values get persisted.
// multiperson values are an array of emails, but tickets created while the field
// was a free-text box hold a comma-separated string - read both.
export function toEmailList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

export function isBlankFieldValue(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === '';
}


export const TICKET_RESOLUTION = [
  { key: 'fixed', label: 'Fixed' }, { key: 'done', label: 'Done' },
  { key: 'wont_fix', label: "Won't Fix" }, { key: 'duplicate', label: 'Duplicate' },
  { key: 'cannot_reproduce', label: 'Cannot Reproduce' },
];
export const resolutionLabel = (k) => (TICKET_RESOLUTION.find((r) => r.key === k) || {}).label || '';
export const LINK_TYPES = [
  { key: 'relates', label: 'Relates to' }, { key: 'duplicate', label: 'Duplicates' },
  { key: 'blocks', label: 'Blocks' }, { key: 'blocked_by', label: 'Blocked by' },
];
export const linkTypeLabel = (k) => (LINK_TYPES.find((l) => l.key === k) || {}).label || k;

// ── Ticket status metadata (sentence-case labels; NX colors) ─────────────────
export const TICKET_STATUS_META = {
  new:         { label: 'New',         color: NX.blue,   tint: 'rgba(37,99,235,0.15)' },
  open:        { label: 'Open',        color: NX.purple, tint: 'rgba(124,58,237,0.15)' },
  in_progress: { label: 'In progress', color: NX.amber,  tint: 'rgba(217,119,6,0.16)' },
  // Waiting states are separate from On hold because they answer "waiting on
  // WHOM", and that is the difference between a clock that should keep running
  // and one that should not: SLA pauses while the ball is in someone else's
  // court. Rolling all three into On hold hid which tickets the team could
  // actually move.
  waiting_user:   { label: 'Waiting for user',   color: NX.blue, tint: 'rgba(37,99,235,0.12)' },
  waiting_vendor: { label: 'Waiting for vendor', color: NX.dim,  tint: NX.border2 },
  on_hold:     { label: 'On hold',     color: NX.dim,    tint: NX.border2 },
  resolved:    { label: 'Resolved',    color: NX.green,  tint: 'rgba(22,163,74,0.15)' },
  closed:      { label: 'Closed',      color: NX.faint,  tint: NX.border2 },
  reopened:    { label: 'Reopened',    color: NX.red,    tint: 'rgba(220,38,38,0.15)' },
};
// Lifecycle order - drives the status picker and the board columns, so it reads
// the way a ticket actually travels.
export const TICKET_STATUS_ORDER = ['new', 'open', 'in_progress', 'waiting_user', 'waiting_vendor', 'on_hold', 'resolved', 'closed', 'reopened'];
export const CLOSED_STATES = ['resolved', 'closed'];

// ── SLA policy - default resolution targets (hours) per priority. Used to
// auto-set a ticket's SLA due date on creation, and to flag breaches/at-risk. ──
export const SLA_TARGET_HOURS = { urgent: 4, high: 24, medium: 72, low: 120 };
export const slaDueFromPriority = (priority) => new Date(Date.now() + (SLA_TARGET_HOURS[priority] ?? 72) * 3600 * 1000).toISOString().slice(0, 10);
// 'breached' | 'at_risk' | 'ok' | 'none'
export function slaState(t) {
  if (!t.slaDueOn || CLOSED_STATES.includes(t.status)) return 'none';
  const now = today();
  if (t.slaDueOn < now) return 'breached';
  const soon = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  if (t.slaDueOn <= soon) return 'at_risk';
  return 'ok';
}
export const SLA_META = {
  breached: { label: 'SLA breached', color: NX.red, tint: 'rgba(220,38,38,0.14)', Icon: ShieldAlert },
  at_risk:  { label: 'Due soon',     color: NX.amber, tint: 'rgba(217,119,6,0.16)', Icon: Timer },
};

// ── Approvals ────────────────────────────────────────────────────────────────
// Service and access requests park the moment they're raised, with no approver
// named. They go to the IT Admin pool, an admin sends the ticket on to whoever
// signs it off, and only once approved can it be assigned. The client never
// picks the approver at intake - see ApprovalPanel in TicketsView.jsx.
//
// Legacy: the retired intake fields old tickets captured an approver in. Kept
// so those values stay identifiable; nothing writes them. Mirrors
// APPROVER_FIELD_BY_TYPE in backend/routers/tickets.py.
export const APPROVER_FIELD_BY_TYPE = {
  service_request: 'approver',
  change_request: 'approver',
  access_request: 'managerApproval',
};

export const APPROVAL_META = {
  pending:  { label: 'Awaiting approval', color: NX.amber, tint: 'rgba(217,119,6,0.16)' },
  approved: { label: 'Approved',          color: NX.green, tint: 'rgba(22,163,74,0.15)' },
  rejected: { label: 'Rejected',          color: NX.red,   tint: 'rgba(220,38,38,0.15)' },
};

// Shared form styles - used by the create wizard, the drawer and the atoms.
export const label = { fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };
export const field = { marginBottom: 14 };

// Inline "Required" note shown under a field after a failed submit.
export const requiredHint = { fontSize: 11.5, color: NX.red, marginTop: 4, fontWeight: 600 };


// The fields INTAKE asks for. A retired field stays in TYPE_FIELDS so a ticket
// that already captured one still displays it - the detail panel renders from
// these definitions, so deleting an entry would hide the answer rather than
// merely stop collecting it - but it is never asked for again.
export const intakeFields = (type) => (TYPE_FIELDS[type] || []).filter((f) => !f.retired);
