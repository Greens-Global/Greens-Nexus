// Ticket Module - types, per-type intake fields, status/SLA policy and the small
// pure helpers built on them. No JSX and no component imports: this is the
// module's configuration layer, imported by every other ticket file.
import { Ticket, Bug, AlertOctagon, Wrench, HelpCircle, ClipboardList, Lightbulb, RefreshCw, KeyRound, ShieldAlert, Timer } from 'lucide-react';
import { fmtDate as fmtDateRaw } from '../tasks/lib';
import { NX } from '../tasks/theme';

export const fmtDate = (iso) => (iso ? fmtDateRaw(iso) : '-');
export const today = () => new Date().toISOString().slice(0, 10);

// ── Ticket issue types ───────────────────────────────────────────────────────
// `hint` is the one-line, plain-English "which one am I?" shown under the Type
// picker at intake. With six types on offer a requester needs to be told the
// difference in the words they would use themselves, not left to infer it from
// a label - that is the whole job of putting six types in front of them.
export const TICKET_TYPE_META = {
  bug:             { label: 'Bug Report',      icon: Bug,           color: NX.red,    hint: 'Something works, but it gives the wrong result.' },
  incident:        { label: 'Incident',        icon: AlertOctagon,  color: NX.amber,  hint: 'Something has stopped working and you cannot carry on.' },
  service_request: { label: 'Service Request', icon: Wrench,        color: NX.blue,   hint: 'You need something set up, installed or provided.' },
  feature_request: { label: 'Feature Request', icon: Lightbulb,     color: NX.green },
  task:            { label: 'Task',            icon: ClipboardList, color: NX.purple },
  question:        { label: 'Question',        icon: HelpCircle,    color: NX.dim },
  change_request:  { label: 'Change / Enhancement', icon: RefreshCw, color: NX.amber, hint: 'Something already works - you want it changed or improved.' },
  access_request:  { label: 'Access Request',  icon: KeyRound,      color: NX.teal,   hint: 'You need an account, a permission, or access removed.' },
  request:         { label: 'Request',         icon: Ticket,        color: NX.blue },
  other:           { label: 'Other',           icon: Ticket,        color: NX.dim,    hint: 'Not sure which of the above - we will sort it out.' },
};
// Selectable types at intake, in the order a requester sees them. Everything
// NOT in this list still lives in TICKET_TYPE_META/TYPE_FIELDS so tickets
// already raised as one keep rendering with their own label, icon and answers -
// retiring a type must never turn existing tickets into blanks.
//
// Six (Neil/Sagar, Aug 31 2026), matching the reviewed intake draft: Incident
// and Change / Enhancement are back alongside the four that were here, and Bug
// Report stays. They are ordered the way a requester scans them - broken first,
// asks second, "not sure" last - and each carries a `hint` above, because six
// types only work if the difference between them is spelled out in plain words.
//
// This reverses the Aug 2026 narrowing to four. That change was made because
// classifying your own problem is hard; the answer here is to keep the choices
// and explain them, and to let the desk re-type anything filed wrongly (which
// it already can, and which re-runs the approval gate).
//
// `task`, `question`, `feature_request` and `request` stay OUT of intake but
// remain in TICKET_TYPE_META/TYPE_FIELDS so tickets already raised as one keep
// their label, icon and answers - retiring a type must never blank an existing
// ticket. `task` in particular asked for assignee/project/sprint/estimate,
// duplicating the Task module and contradicting triage routing (tickets arrive
// unassigned). Escalate a ticket into a task instead.
export const TICKET_TYPE_ORDER = ['incident', 'bug', 'service_request', 'access_request', 'change_request', 'other'];

// Screen recording is for showing a problem happening - a bug or an incident.
// The rest are asks, not something to demonstrate on screen, so the Record
// option is hidden for them (Upload still works).
export const NO_RECORDING_TYPES = ['feature_request', 'service_request', 'access_request', 'change_request', 'other'];

// Per-type intake fields - the extra questions each ticket type asks, on top of
// the common ones: Department, Application and Type (wizard step 1), then
// Priority, Title and Description (step 2). Don't re-ask any of those here.
// Values are stored on the ticket's `typeFields` JSON, keyed by `key`.
// Field types: text · textarea · select · radio · number · date · datetime ·
//              person · multiperson · project · multiselect · checklist. `req`
//              marks required (shown with *), `full` spans both grid columns.
//
// ── Rewritten for a non-IT requester (Sagar, Aug 31 2026) ────────────────────
// Every question is now something the person raising the ticket can answer
// about their own day, asked in the words they would use. The old sets read
// like a developer's bug template - Steps to Reproduce, Expected vs Actual
// Result, Severity on a Minor/Major/Critical/Blocker scale, Environment as
// Production/Development, Risk Assessment, Rollback Plan, Business
// Justification - and someone in Storage or Accounting cannot fill those in
// honestly, so they either guess or give up. At most four questions per type,
// and never more than two of them required.
//
// KEYS ARE REUSED WHEREVER THE MEANING SURVIVES, only the label changes, so
// the answers on the tickets already raised keep displaying under the new
// wording. Where the question itself is gone it is marked `retired` rather
// than deleted - the drawer renders from these definitions, so deleting one
// would hide an existing answer instead of merely ceasing to ask for it.
// Retired radio/select options are left exactly as they were for the same
// reason: changing them would orphan values already stored against them.
export const TYPE_FIELDS = {
  // WHAT broke -> HOW BADLY -> WHAT HAPPENED -> WHERE. Severity sits second
  // because it is the field triage sorts on; it was last and optional, so the
  // queue had nothing to sort by. Environment (browser/OS) follows the
  // reproduction steps rather than preceding them - it qualifies the report, it
  // is not what the report is about.
  // Something works, but gives the wrong result. Three questions, one required.
  bug: [
    // Retired (Aug 2026): step 1 now asks for the Application as a real value
    // picked from the External Links directory, so typing the module name here
    // asked the same question twice and produced a string nothing could group
    // on. Kept so bugs that already captured one still render it.
    { key: 'module', label: 'Application / Module', type: 'text', req: true, retired: true },
    // Retired: a requester cannot rank their own bug on a Minor..Blocker scale
    // and nobody expects them to - Priority is the one urgency control, and it
    // is what sets the SLA date.
    { key: 'severity', label: 'Severity', type: 'radio', options: ['Minor', 'Major', 'Critical', 'Blocker'], req: true, retired: true },
    // Same question a developer means by "steps to reproduce", asked the way a
    // person actually remembers it. Key kept, so old bugs still show theirs.
    { key: 'stepsToReproduce', label: 'What were you doing when it happened?', type: 'textarea', full: true, req: true,
      placeholder: 'e.g. I clicked Save on the invoice screen' },
    { key: 'expectedResult', label: 'What did you expect to happen?', type: 'textarea', full: true },
    // Retired: "what happened instead" is what the Description asks for, one
    // field up. Asking twice made people write the same sentence again.
    { key: 'actualResult', label: 'Actual Result', type: 'textarea', req: true, retired: true },
    // Whether it happens every time is the difference between "fix it now" and
    // "watch it". Options unchanged - old tickets hold these exact values.
    { key: 'reproducibility', label: 'How often does it happen?', type: 'radio', options: ['Always', 'Sometimes', 'Saw It Once'] },
    // Retired: IT can read the browser and OS off the session; asking the
    // requester to name them is homework for no benefit.
    { key: 'browser', label: 'Browser', type: 'select', options: ['Chrome', 'Firefox', 'Safari', 'Edge', 'Other'], retired: true },
    { key: 'os', label: 'OS', type: 'select', options: ['Windows', 'macOS', 'Linux', 'iOS', 'Android', 'Other'], retired: true },
    { key: 'errorMessage', label: 'Error message, if you saw one', type: 'textarea', full: true },
  ],
  // Something has stopped working. Four questions, one required.
  incident: [
    // Retired: step 1's Application is this question.
    { key: 'affectedService', label: 'Affected Service', type: 'text', req: true, retired: true },
    { key: 'impact', label: 'Who is affected?', type: 'radio',
      options: ['One User', 'Multiple Users', 'Department', 'Entire Organization'], req: true },
    { key: 'occurredAt', label: 'When did it start?', type: 'datetime' },
    { key: 'workedBefore', label: 'Was it working before?', type: 'radio',
      options: ['Yes, it stopped recently', 'No, it never worked', 'Not sure'] },
    { key: 'errorMessage', label: 'Error message, if you saw one', type: 'text', full: true },
    // Retired: "is there a workaround" is a triage judgement, not something the
    // person stuck without one can answer; naming every affected colleague in a
    // people picker is work the desk can do faster from the impact answer.
    { key: 'affectedUsers', label: 'Affected Users', type: 'multiperson', retired: true },
    { key: 'workaroundAvailable', label: 'Workaround Available?', type: 'radio', options: ['Yes', 'No'], retired: true },
    { key: 'workaroundDetail', label: 'Workaround (if yes)', type: 'textarea', full: true, retired: true },
  ],
  // WHAT -> FOR WHOM -> WHY -> WHEN -> COST -> WHERE. Service Category was
  // already removed: step 1's department says which function fulfils it.
  // You need something provided. Four questions, one required.
  service_request: [
    { key: 'requestedService', label: 'What do you need?', type: 'text', full: true, req: true,
      placeholder: 'e.g. a second monitor, a new Egnyte folder, a camera installed' },
    // A person, not a Myself/Another User radio. The radio had no follow-up
    // field, so "Another User" produced a request with no way to say WHO it was
    // for and fulfilment had to go and ask. Blank means the requester, the way
    // every service catalogue defaults it.
    { key: 'requestedFor', label: 'Who is it for? (blank = yourself)', type: 'person' },
    // No longer required, and no longer called Business Justification: most
    // requests are ordinary, and demanding a written justification for a
    // monitor cable reads as being asked to argue your case.
    { key: 'businessJustification', label: 'Why do you need it?', type: 'textarea', full: true },
    // Back at the requester's own request (Aug 31 2026) as a plain optional
    // date. Optional is the whole point: it records a real deadline where one
    // exists without inviting everyone else to invent one.
    { key: 'requiredBy', label: 'Needed by, if there is a deadline', type: 'date' },
    { key: 'estimatedCost', label: 'Estimated Cost', type: 'number', prefix: '₹', retired: true },
    // Retired: most requests are software or access and have no physical
    // destination, so this asked the majority of requesters for an address that
    // does not exist. Where it matters, "What do you need?" carries it.
    { key: 'location', label: 'Delivery Location', type: 'text', retired: true },
    // Retired: a requester nominating their own approver is a control weakness
    // an auditor would flag. Approval belongs to the workflow - the ticket
    // parks as pending and the desk routes it. Kept here so tickets that
    // already captured one still show it.
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
    { key: 'module', label: 'Application / Module', type: 'text', retired: true },
  ],
  // Something already works and you want it different. Four questions, two
  // required - and the two required ones are the whole request: how it is now,
  // how it should be.
  change_request: [
    // Retired: step 1's Application is this question.
    { key: 'affectedSystem', label: 'Affected System', type: 'text', req: true, retired: true },
    { key: 'currentConfiguration', label: 'How does it work now?', type: 'textarea', full: true, req: true },
    { key: 'requestedChange', label: 'How should it work instead?', type: 'textarea', full: true, req: true },
    { key: 'reason', label: 'Why does this matter?', type: 'textarea', full: true },
    { key: 'implementationDate', label: 'Needed by, if there is a deadline', type: 'date' },
    // Retired: risk, downtime and a rollback plan are the implementer's
    // assessment, made after reading the request. Asking the person who wants a
    // report column renamed to rate the risk and write a rollback plan is the
    // clearest example of a form written for IT rather than for the requester.
    { key: 'riskAssessment', label: 'Risk Assessment', type: 'radio', options: ['Low', 'Medium', 'High'], req: true, retired: true },
    { key: 'downtimeRequired', label: 'Downtime Required?', type: 'radio', options: ['Yes', 'No'], retired: true },
    { key: 'rollbackPlan', label: 'Rollback Plan', type: 'textarea', full: true, req: true, retired: true },
    // Retired for the same reason as the service-request approver: the approval
    // gate parks this ticket and the desk routes it to whoever signs off.
    { key: 'approver', label: 'Approver', type: 'person', req: true, retired: true },
  ],
  // WHAT system -> WHAT LEVEL -> FOR WHOM -> WHICH environment -> WHY -> UNTIL
  // WHEN. Every field here is something an access reviewer reads back during a
  // quarterly recertification, which is why the justification is required and
  // the expiry is asked for plainly.
  // An account or a permission. Five questions, two required - kept slightly
  // longer than the rest on purpose: every answer here is read back at the
  // quarterly access review, and a grant nobody can explain later is the thing
  // an auditor actually objects to.
  access_request: [
    // Retired (Aug 2026) for the same reason as bug.module: step 1's
    // Application is this question, answered against the real app directory
    // instead of a text box. An access review reads the app it was granted on,
    // so it matters that the two are the same value.
    { key: 'application', label: 'Application / System', type: 'text', req: true, retired: true },
    // What KIND of access change, from the reviewed draft - joiner, leaver,
    // add, remove, role change. It is the first thing the desk needs and the
    // easiest thing for the requester to answer, so it leads.
    { key: 'requestKind', label: 'What do you need?', type: 'radio', req: true,
      options: ['New employee setup', 'Employee leaving', 'Add access', 'Remove access', 'Change their role'] },
    { key: 'user', label: 'Who is this for? (blank = yourself)', type: 'person' },
    // Optional, not required: "Employee leaving" and "Remove access" have no
    // level to give, so demanding one made two of the five request kinds
    // unanswerable without inventing something.
    // Options left as Read/Write/Admin - existing access tickets hold these
    // exact values, and rewording them would orphan those answers against a
    // radio that no longer offers them.
    { key: 'accessType', label: 'What level of access?', type: 'radio', options: ['Read', 'Write', 'Admin'] },
    { key: 'reason', label: 'Why do they need it?', type: 'textarea', full: true, req: true },
    // Standing access is what audits object to, so the expiry stays a
    // first-class question. Blank is allowed - some access genuinely is
    // permanent.
    { key: 'endDate', label: 'Needed until (blank = permanent)', type: 'date' },
    // Retired: Production vs Development means nothing to the person in
    // Accounting who needs into Intacct, and everyone who is not an engineer
    // picked whichever was first. IT decides the environment when granting.
    { key: 'environment', label: 'Environment', type: 'select', options: ['Production', 'Development', 'All'], retired: true },
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

// ── Ticket numbers ───────────────────────────────────────────────────────────
// Stored as a plain zero-padded sequence ("000001"); shown as "Ticket #000001".
// Mirrors backend/ticket_code.py - keep the two in step.
//
// normalizeCode also folds legacy "TKT-12" to "000012", so a row written before
// the change reads identically to one written after it without needing the data
// migration to have run first.
export const TICKET_CODE_DIGITS = 6;
export const normalizeCode = (code) => {
  const digits = String(code || '').replace(/\D/g, '');
  return digits ? digits.padStart(TICKET_CODE_DIGITS, '0') : '';
};
// Blank stays blank rather than becoming "Ticket #" - a ticket with no number
// should look like it has none, not like it has an empty one.
export const ticketNo = (code) => (normalizeCode(code) ? `Ticket #${normalizeCode(code)}` : '');
// Compact form for tight spots (chips, table cells, option lists): "#000001".
export const ticketNoShort = (code) => (normalizeCode(code) ? `#${normalizeCode(code)}` : '');

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


// ── Service areas ────────────────────────────────────────────────────────────
// The desk's triage taxonomy. An app is classified ONCE, on the External Links
// row (ExternalLink.service_area, set where the app is added), and a ticket
// copies that value at intake - the requester is never asked to pick it, since
// they already told us which application they mean.
//
// A constant, not a table: this is how IT sorts its own queue, the same way
// statuses, types and SLA targets are constants here. Mirrors
// SERVICE_AREA_KEYS in backend/routers/external_links.py - keep the two in step.
export const SERVICE_AREAS = [
  { key: 'email',      label: 'Email & Microsoft 365' },
  { key: 'collab',     label: 'Teams & Phone' },
  { key: 'tasks',      label: 'Tasks & Dashboard' },
  { key: 'files',      label: 'Files & Storage' },
  { key: 'knowledge',  label: 'Knowledge & SOPs' },
  { key: 'storageops', label: 'Storage Operations' },
  { key: 'finance',    label: 'Finance Apps' },
  { key: 'hr',         label: 'HR & Payroll' },
  { key: 'assets',     label: 'Assets & Inventory' },
  { key: 'network',    label: 'Network & Internet' },
  { key: 'security',   label: 'Security & Cameras' },
  { key: 'web',        label: 'Website & Marketing' },
  { key: 'hardware',   label: 'Hardware & Remote Help' },
  { key: 'general',    label: 'General' },
];
export const serviceAreaLabel = (k) => (SERVICE_AREAS.find((a) => a.key === k) || {}).label || '';

// The extra questions an area asks, on top of the common and per-type ones.
// Keys are `svc_`-prefixed and stored on the SAME `typeFields` JSON, so there
// is no second column and the drawer renders them through the same input.
// The prefix is what keeps them from ever colliding with a type field's key.
//
// Deliberately sparse: only seven areas ask anything, and none asks more than
// two. For the rest the application name plus the description is the whole
// answer, and a question with a predictable answer is just friction.
//
// ── `types`: the question depends on the TYPE too, not just the app ──────────
// (Sagar, Aug 31 2026 - "why is it available for all ticket types, it should be
// there for Incidents only... when it's for some physical facility or places".)
//
// An area says WHAT the ticket is about; the type says WHAT KIND of thing is
// being asked. A question is only worth asking where both make it meaningful,
// and "which facility?" is the clearest case: it is the right question when a
// camera has stopped working somewhere, and pure noise on a request to change
// how a report is laid out. Asking it on every type is what put a required
// Facility in front of people raising software tickets.
//
// So a field may name the types it applies to. Omitted means every type EXCEPT
// `other` - Other is the "I am not sure" bucket, and the one promise it makes
// is that it will not interrogate someone who already said they do not know.
//
// `optionsFrom: 'sites'` is resolved at render from the work-site list
// (/ticket-sites) - a typed site cannot be filtered, grouped or joined.
const PLACE = ['incident'];          // where is the broken thing - only when something IS broken
export const SERVICE_FIELDS = {
  email: [
    // Whose mailbox is misbehaving. Not asked on a service or access request:
    // those types already ask "Who is it for?" / "Who is this for?", and the
    // same question twice on one form is exactly the confusion being removed.
    { key: 'svc_account', label: 'Whose account is affected? (blank = yours)', type: 'person', types: ['incident', 'bug'] },
  ],
  files: [
    { key: 'svc_folderPath', label: 'Which folder?', type: 'text', full: true, placeholder: '/Shared/…' },
  ],
  storageops: [
    { key: 'svc_facility', label: 'Which facility?', type: 'select', optionsFrom: 'sites', req: true, types: PLACE },
    { key: 'svc_unit', label: 'Unit / tenant, if it is about one', type: 'text', types: PLACE },
  ],
  security: [
    { key: 'svc_facility', label: 'Which facility?', type: 'select', optionsFrom: 'sites', req: true, types: PLACE },
    { key: 'svc_deviceOrGate', label: 'Which camera or gate?', type: 'text', types: PLACE },
  ],
  network: [
    { key: 'svc_facility', label: 'Which site?', type: 'select', optionsFrom: 'sites', req: true, types: PLACE },
    { key: 'svc_connection', label: 'How are you connected?', type: 'radio', options: ['Wi-Fi', 'Wired', 'VPN'], types: PLACE },
  ],
  hardware: [
    // A device is a thing you use, not a place - so unlike the facility
    // questions it is also the right question on a request ("I need a laptop").
    { key: 'svc_device', label: 'Which device?', type: 'select', options: ['Laptop', 'Desktop', 'Monitor', 'Printer', 'Phone', 'Other'], req: true, types: ['incident', 'bug', 'service_request'] },
    // Only meaningful for kit you already have, so incidents and bugs only.
    // Free text for now: a type-ahead against the items table would be better
    // and needs a read-only lookup endpoint in items.py - Visesh's file, so his
    // call to make rather than something to add from here.
    { key: 'svc_assetTag', label: 'Asset tag or serial, if you can see one', type: 'text', types: ['incident', 'bug'] },
  ],
  web: [
    { key: 'svc_url', label: 'Which page?', type: 'text', full: true, placeholder: 'https://' },
  ],
};

// Every intake type a service field applies to when it does not name its own.
const SERVICE_DEFAULT_TYPES = TICKET_TYPE_ORDER.filter((t) => t !== 'other');

// Does this service question apply to this ticket type?
export const serviceFieldApplies = (f, type) => (f.types || SERVICE_DEFAULT_TYPES).includes(type);

// The service questions to ASK for an area on a ticket of this type. Same
// contract as intakeFields: a retired one stays in SERVICE_FIELDS so a ticket
// that captured it still shows the answer, but nobody is asked again.
//
// No type -> no service questions. The type is half of what decides whether a
// question is meaningful, so answering with the whole area's list before one is
// chosen would show questions the finished ticket may never have asked.
export const serviceFields = (area, type) => (SERVICE_FIELDS[area] || [])
  .filter((f) => !f.retired && type && serviceFieldApplies(f, type));

// Field defs with their dynamic options filled in. `sites` is [{id,name}] from
// api.getTicketSites().
//
// A dynamic field whose list comes back EMPTY also stops being required - no
// work sites configured (or the lookup failed) would otherwise leave a
// required select with nothing to select, which is an inescapable form: the
// same reason step 1 only demands a department when the company has any.
export const withDynamicOptions = (fields, { sites = [] } = {}) => fields.map((f) => {
  if (f.optionsFrom !== 'sites') return f;
  const options = sites.map((s) => s.name).filter(Boolean);
  return { ...f, options, req: f.req && options.length > 0 };
});
