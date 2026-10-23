// Admin - the one place admin-team UI settings live (Pranshu, Sep 9).
// The old search-only "Nexus Access Manager" (module id 'admin') was retired
// Sep 26 - Global Settings > Access replaces it and /admin lands there. The header's
// old AdminPanel drawer (Audit Logs) is gone (Sep 11) - see the Audit Logs
// tab below.
//
// "Build out the module" (Sep 9) means: relocate every admin-only setting
// that's a UI click (not a code change) here, even when it was originally
// built inside its own module's screen. Reuses the EXACT existing
// components/handlers from their home files (named-exported, not
// reimplemented) so behavior can't drift between "here" and "there" - the
// only new code is the layout wiring. Lazy-imported the same way
// Support.jsx borrows Tasks' composers, so this module's chunk doesn't drag
// the whole Item Management / HR bundles in eagerly.
//
// In scope for this pass: Roles & Access (moved here whole, previously a
// People tab), Item Types + Custom Fields, Ticket Desk + Notification
// settings, Ticket SLA & Types (Sep 9 - was Tier 2 in the audit: no UI
// existed, SLA_TARGET_HOURS/TICKET_TYPE_META/TYPE_FIELDS were hardcoded
// constants requiring a code deploy to change; now backed by
// backend/ticket_taxonomy.py + a NexusSetting row, see tickets/ticketConfig.js
// for how the saved override reaches every ticket screen), Task
// Notifications (moved here whole, previously a Tasks → Manage tab), Act As
// and Audit Logs (Sep 11, moved whole out of the header dropdown), and HR's
// Company Setup / Work Sites / Sync M365. Explicitly OUT of scope (Pranshu,
// Sep 9): Branding (an individual employee's own choice, not an admin
// decision - stays in the header's account menu), shift presets, Asana sync,
// overtime rules, QA module toggle - left where they are. The placeholder
// "Other modules" grid (one card per module with no settings yet) was
// dropped (Pranshu, Sep 9) - it only ever said "no configurable options yet"
// for every module not listed above, which isn't useful information; a
// module gets a section here when it actually has one.
//
// Company Alert / "Send Alert" broadcast tool was dropped from here entirely
// (Pranshu, Sep 11) - unused. Workforce Analytics Policy (the old Policy tab
// under Employee Tracking) moved in as its replacement in the Company
// Settings list.
//
// Global Settings / Company Settings split (Neil, Sep 26): org-wide sections
// lived under Global Settings, grouped into categories; everything that
// belongs to one legal entity lived under Company Settings.
//
// One Settings tab (Neil, Oct 23 2026, plan
// https://claude.ai/artifact/UGtPmeFBrfU6wXhd474erx): the two tabs merged.
// Every setting has one scope - the organization, one company, or an
// organization default a company may override - and the screen shows the
// scope instead of guessing it from a tab. A rail of SUBJECTS on the left
// (Companies, Locations, People & Access, Security, Branding & Email, Emails &
// Reminders, Tickets, Time & Pay, Workforce Analytics, Shifts & Scheduling,
// Hiring & Onboarding, Items & Equipment, Operations), a SCOPE picker at the
// top ("Every company" or one company), and under each subject its setting
// GROUPS, all open - no accordions, nothing behind a click. Picking a company
// shows each subject's company face (the old Company Settings tabs, spread
// over the subjects they belong to: Profile / Departments / Holiday Calendar
// under Companies, the company's sites under Locations, its Roles under People
// & Access, its Checklists under Hiring, its policy under Workforce
// Analytics). Subjects with nothing to set for one company are listed under
// "For every company" in the rail and switch the scope back when clicked.
//
// Sub keys: '<subject>', '<subject>:<group>' (jumps to and highlights the
// group), '<subject>@<companyId>' and '<subject>:<group>@<companyId>' for a
// company's face; 'tools' and 'audit' are the other tabs. Every old key still
// lands: 'settings' / 'global' -> Companies, 'global-<category>' -> the
// subject that category became (LEGACY_SUBJECTS), 'company' -> Companies,
// 'access' -> People & Access, 'actas' -> Tools.
//
// Act As and the Microsoft 365 sync are actions, not settings, so they sit
// on the Tools tab (views/SettingsTools.jsx). Every panel is the same
// component it was before the merge - only the wiring here changed.
import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import {
  Settings2, ChevronDown, Tag, Shield,
  Headset, Bell, Mail, Building2, Timer,
  Activity, Signature, Check, Eye, X,
  Plus, Pencil, Trash2, Upload, GripVertical, MapPinned,
  Globe, Package, Search, Wrench, CalendarClock, ShieldCheck, Palette, FileCheck,
  Tags,
  Clock, Users, CloudRain, UserPlus, FileText, ClipboardList, ListChecks,
  MessageSquareText, MonitorDot,
  Sparkles,
  Warehouse,
} from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import ModuleTabs from '../components/ModuleTabs';
import { ModalLoading, SkeletonBlocks, Spinner } from '../components/AsyncState';
import { useIsMobile } from '../lib/useIsMobile';
import UnsavedChangesPrompt from '../components/UnsavedChangesPrompt';
import TicketDeskSettings from '../tickets/TicketDeskSettings';
import TicketNotifySettings from '../tickets/TicketNotifySettings';
import TicketTaxonomySettings from '../tickets/TicketTaxonomySettings';
import TicketHelpTopicsSettings from '../tickets/TicketHelpTopicsSettings';
import TicketDeskAccessSettings from '../tickets/TicketDeskAccessSettings';
import TicketSavedRepliesSettings from '../tickets/TicketSavedRepliesSettings';
import TicketAiSettings from '../tickets/TicketAiSettings';
import DailyBriefingSettings from '../components/DailyBriefingSettings';
import WeeklyDigestSettings from '../components/WeeklyDigestSettings';
import WorkforceScorecardSettings from '../components/WorkforceScorecardSettings';
import PayrollExportCodes from '../components/PayrollExportCodes';
import PayPremiums from '../components/PayPremiums';

// Borrowed components, lazy so their home module's chunk only loads once an
// admin actually opens that subject. One dynamic import per home module,
// shared by every panel borrowed from it: several groups from one module
// now mount at once (nothing is behind an accordion any more), and one
// import keeps them on one chunk request - and one module instance.
function lazyFrom(load) {
  let pending;
  const once = () => (pending ||= load());
  return (name) => lazy(() => once().then(m => ({ default: m[name] })));
}
const fromInventory = lazyFrom(() => import('./InventoryManagement'));
const ManageTypesModal = fromInventory('ManageTypesModal');
const CustomFieldsAdminModal = fromInventory('CustomFieldsAdminModal');
const fromHR = lazyFrom(() => import('./HR'));
const CompanySetupPage = fromHR('CompanySetupPage');
// Hiring setup (Neil, Oct 14): "these are all settings ... I don't want anyone
// editing anything here" - moved off the Hiring board into Settings.
const PacketsModal = lazy(() => import('../components/HiringPacket').then(m => ({ default: m.PacketsModal })));
const QuestionnairesModal = lazy(() => import('../components/Interviews').then(m => ({ default: m.QuestionnairesModal })));
const ChecklistLibrary = lazy(() => import('../components/HrChecklists').then(m => ({ default: m.ChecklistLibrary })));
const WorkSiteLibrary = fromHR('WorkSiteLibrary');
// Roles & Access moved here whole (Pranshu, Sep 9) - was a People tab
// (HR.jsx's old 'hr-access' sub), now a top-level tab of Admin instead.
// `embedded` skips its own page header, since it gets one from the tab here.
const RolesAccess = lazy(() => import('./RolesAccess'));
const SettingsTools = lazy(() => import('./SettingsTools'));
const HrReminderSettings = lazy(() => import('../components/HrReminderSettings'));
const EquipmentReminderSettings = lazy(() => import('../components/EquipmentReminderSettings'));
// Security > Sign-In & Sessions (Sep 26) - lazy like the other admin panels.
const SecuritySettings = lazy(() => import('./SecuritySettings'));
// Branding & Policies (Sep 26) - brand color, email appearance, sign-in policy.
const fromBranding = lazyFrom(() => import('./BrandingPoliciesSettings'));
const BrandColorPanel = fromBranding('BrandColorPanel');
const EmailAppearancePanel = fromBranding('EmailAppearancePanel');
const SignInPolicyPanel = fromBranding('SignInPolicyPanel');
// Shifts (Oct 2026): the settings, shift types and groups that used to be a
// Shifts tab - one self-contained module, three sections.
const fromShifts = lazyFrom(() => import('../components/shifts/ShiftSettingsSections'));
const ShiftSettingsPanel = fromShifts('ShiftSettingsPanel');
const ShiftTypesPanel = fromShifts('ShiftTypesPanel');
const ShiftGroupsPanel = fromShifts('ShiftGroupsPanel');
// Weather Alerts (Weather Call, Oct 2026): the per-company switch and the rain thresholds.
const WeatherSettingsPanel = lazy(() => import('../components/shifts/WeatherSettings'));
// Operations (Oct 21 2026): the Push to Cubby switch, OFF by default.
const OpsSettingsPanel = lazy(() => import('../operations/OpsSettings'));
// Audit Logs (Sep 11) - same tab-beside-Roles-&-Access treatment. The old
// header AdminPanel drawer that used to render this is gone. Since Oct 20 the
// tab is the unified Audit Log (components/audit/AuditLog.jsx): every module,
// Act As, and each change's before -> after; the tab key stays 'audit'.
const AuditLogs = lazy(() => import('../components/audit/AuditLog'));
// TaskNotifySettings needs TasksContext (task lookups for its delivery log's
// "open task" link) - wrapped in its own TasksProvider here, same trick
// Support.jsx uses for its Tasks-borrowed composers, since Admin has no
// TasksProvider ancestor of its own.
const TaskNotifySettingsWrapped = lazy(async () => {
  const [{ TasksProvider }, { default: TaskNotifySettings }] = await Promise.all([
    import('../tasks/TasksContext'),
    import('../tasks/TaskNotifySettings'),
  ]);
  return { default: () => <TasksProvider><TaskNotifySettings /></TasksProvider> };
});

const ModalFallback = ModalLoading;

function SectionFallback() {
  return <SkeletonBlocks count={2} height={44} borderRadius={10} />;
}

// ── Subjects + setting groups ────────────────────────────────────────────────
// One place for every subject's and group's title, description, scope and
// search keywords, so the rail, the filter, the scope chips and the groups
// themselves can never disagree about what a setting is called.
//
// faces: which scopes a subject has something to show for - 'org' (only at
// "Every company"), 'company' (only with a company picked), 'both'.
const SUBJECTS = [
  { key: 'companies',  label: 'Companies',           Icon: Building2, faces: 'both',
    desc: 'The legal entities Nexus runs: each one\'s profile, managers and HR contact, departments and holiday calendar, and the group manager above them all.' },
  { key: 'locations',  label: 'Locations',           Icon: MapPinned, faces: 'both',
    desc: 'Every location employees can punch in at, with its geofence, and which companies use each one.' },
  { key: 'access',     label: 'People & Access',     Icon: Shield, adminOnly: true, faces: 'both',
    desc: 'Who can open which module: each person\'s access, access groups, the roles shared by every company and the full access matrix. Each company\'s own job roles are set with that company picked.' },
  { key: 'security',   label: 'Security',            Icon: ShieldCheck, adminOnly: true, faces: 'org',
    desc: 'How people sign in, how long sessions last, and the policy everyone accepts at sign-in.' },
  { key: 'branding',   label: 'Branding & Email',    Icon: Palette, adminOnly: true, faces: 'both',
    desc: 'The Nexus brand color, how every Nexus email looks, and each company\'s email signature template.' },
  { key: 'emails',     label: 'Emails & Reminders',  Icon: Mail, faces: 'org',
    desc: 'Every scheduled email Nexus sends - task emails, the daily briefing, the weekly digest, the workforce scorecard - and how early HR and asset managers are reminded.' },
  { key: 'tickets',    label: 'Tickets',             Icon: Headset, faces: 'both',
    desc: 'Where tickets go and who works them: routing and escalation, ticket email, response targets and ticket types, help topics, desk access, saved replies and AI features.' },
  // Time Clock pay rules (Charmi, Sep 30): moved off the timecard's Options popover.
  { key: 'pay',        label: 'Time & Pay',          Icon: Clock, adminOnly: true, faces: 'both',
    desc: 'The rules every time sheet is computed with: punch rounding, the auto-lunch deduction, California paid rest breaks, payroll export codes and pay premiums.' },
  { key: 'analytics',  label: 'Workforce Analytics', Icon: MonitorDot, faces: 'company',
    desc: 'What each company captures about work on company computers, and how often. Every company has its own policy.' },
  { key: 'shifts',     label: 'Shifts & Scheduling', Icon: CalendarClock, faces: 'both',
    desc: 'What staff may request and see on the schedule, the team time zone and week start, time-off reasons, the shift types managers place, the groups people are scheduled in, and the weather alerts for their work sites.' },
  { key: 'hiring',     label: 'Hiring & Onboarding', Icon: UserPlus, faces: 'both',
    desc: 'What goes out when someone is hired, promoted or leaves, the interview questionnaires for each role, and the checklists every onboarding, promotion, offboarding and leave starts from. The Hiring board itself is only for moving candidates along.' },
  { key: 'items',      label: 'Items & Equipment',   Icon: Package, faces: 'org',
    desc: 'The catalog options used when adding items in Item Management.' },
  { key: 'operations', label: 'Operations',          Icon: Warehouse, faces: 'org',
    desc: 'How the storage facilities screens work with Cubby.' },
];
const SUBJECT_KEYS = new Set(SUBJECTS.map(s => s.key));
// The Global Settings categories (Sep 26 - Oct 22) and what each became, so
// every 'global-<category>' link, bookmark and bell still lands.
const LEGACY_SUBJECTS = {
  organization: 'companies', notifications: 'emails', access: 'access', items: 'items',
  security: 'security', branding: 'branding', timeclock: 'pay', hiring: 'hiring',
  shifts: 'shifts', operations: 'operations',
  'service-desk': 'tickets', tasks: 'emails', communications: 'emails',
};

// scope: 'org' = one value for all of Nexus; 'company' = one per company;
// 'layered' = an organization default a company may override.
// face: which scope the group shows under ('org' = Every company, 'company'
// = with a company picked, 'both' = either - the panel takes the company
// from the scope). A company-only group asked for at "Every company"
// renders as a company picker.
const GROUPS = [
  // Companies
  { id: 'company-list', subject: 'companies', face: 'org', scope: 'org', icon: Building2, title: 'Companies',
    sub: 'Every legal entity, and the group manager above them all. Open a company to set its profile, departments and holiday calendar.',
    keywords: 'company companies legal entity add company group manager escalation list' },
  { id: 'company-profile', subject: 'companies', face: 'company', scope: 'company', icon: Building2, title: 'Company',
    sub: 'Profile and logo, managers and HR contact, contractor invoice recipients, email domains, departments and their heads, and the holiday calendar.',
    keywords: 'company profile legal name country tax id ein gstin signatory manager hr contact invoice recipients address phone logo social links email domains notes departments department head holiday calendar holidays' },
  // Locations
  { id: 'work-sites', subject: 'locations', face: 'org', scope: 'org', icon: MapPinned, title: 'Location Library',
    sub: 'Every location employees can punch in at, with its geofence. Pick the companies that use each one right here, or with a company picked.',
    keywords: 'geofence location address time clock punch map work site' },
  { id: 'company-sites', subject: 'locations', face: 'company', scope: 'company', icon: MapPinned, title: 'Locations',
    sub: 'The locations this company\'s people punch in at, picked from the library.',
    keywords: 'company locations work sites geofence punch' },
  // People & Access
  // Rendered whole (not in a card): it is a full screen of its own.
  { id: 'access', subject: 'access', face: 'org', scope: 'org', icon: Shield, title: 'People & Access Groups',
    sub: 'Each person\'s effective access, access groups that add modules on top of a job role, the roles shared by every company, and the full access matrix.',
    keywords: 'roles permissions people groups modules grant level viewer editor owner matrix audit walls shared roles' },
  { id: 'company-roles', subject: 'access', face: 'company', scope: 'company', icon: Shield, title: 'Roles', adminOnly: true,
    sub: 'This company\'s job roles, grouped by department, with what each one opens and the checklist steps it adds.',
    keywords: 'job roles company roles department access checklists' },
  // Security
  { id: 'sign-in-sessions', subject: 'security', face: 'org', scope: 'org', icon: ShieldCheck, title: 'Sign-In & Sessions',
    sub: 'How long web, Act As and Credential Vault sessions last, and guest sign-in codes.',
    keywords: 'session timeout idle act as vault unlock guest partner code lockout invite security' },
  { id: 'signin-policy', subject: 'security', face: 'org', scope: 'org', icon: FileCheck, title: 'Sign-In Policy',
    sub: 'The company policies and monitoring disclosure everyone accepts at sign-in, and who has not accepted the current version.',
    keywords: 'policy terms monitoring disclosure acknowledgment accept consent version publish report' },
  // Branding & Email
  { id: 'brand-color', subject: 'branding', face: 'org', scope: 'org', icon: Palette, title: 'Brand Color',
    sub: 'The accent color used across Nexus and on the sign-in screen.',
    keywords: 'accent theme green blue login color' },
  { id: 'email-appearance', subject: 'branding', face: 'org', scope: 'org', icon: Mail, title: 'Email Appearance',
    sub: 'One logo, accent color and footer for every email Nexus sends: tasks, tickets, Nexus Sign, invitations and welcome emails.',
    keywords: 'email template logo header footer accent color address preview notifications' },
  { id: 'email-signature', subject: 'branding', face: 'both', scope: 'company', icon: Signature, title: 'Email Signature',
    sub: 'Choose each company\'s signature template and set custom signatures for specific addresses. Names, titles and contact details come from each employee\'s directory record, and employees choose their own sign-off in Profile.',
    keywords: 'template sign-off logo sender override shared inbox branding' },
  // Emails & Reminders
  { id: 'task-notifications', subject: 'emails', face: 'org', scope: 'org', icon: Bell, title: 'Task Notifications',
    sub: 'The mailbox task emails come from, due-date reminders, how updates are batched into one email, and how email replies are posted.',
    keywords: 'email mailbox reminders overdue batch replies delivery log tasks notifications' },
  { id: 'daily-briefing', subject: 'emails', face: 'org', scope: 'org', icon: Mail, title: 'Daily Briefing',
    sub: 'A daily summary email for each employee. Send it to everyone, or to a few test recipients first.',
    keywords: 'digest summary email morning test recipients' },
  { id: 'weekly-digest', subject: 'emails', face: 'org', scope: 'org', icon: Mail, title: 'Weekly Digest',
    sub: "A Monday email listing each employee's overdue tasks with their due dates, sent before their shift. Send it to everyone, or to a few test recipients first.",
    keywords: 'weekly digest summary email overdue tasks due dates extend monday shift test recipients' },
  { id: 'workforce-scorecard', subject: 'emails', face: 'org', scope: 'org', icon: Mail, title: 'Workforce Scorecard',
    sub: 'A weekly email to managers scoring each hourly person\'s punched hours against their expected hours (US 8h, India 9h, or their shift) - who worked, who was short, who was absent.',
    keywords: 'workforce analytics scorecard attendance hours expected worked absent late weekly manager email shift standard day india hourly test recipients' },
  { id: 'hr-reminders', subject: 'emails', face: 'org', scope: 'org', icon: CalendarClock, title: 'HR & Compliance Reminders',
    sub: 'Choose how many days ahead HR is warned about visa and right-to-work expiry, contract ends, new starters, expiring documents and unsigned signature requests.',
    keywords: 'hr people visa right to work immigration expiry expiring contract end new starter onboarding document compliance e-sign signature chase nudge reminder days before alerts timing bell' },
  { id: 'equipment-reminders', subject: 'emails', face: 'org', scope: 'org', icon: CalendarClock, title: 'Equipment Reminders',
    sub: 'Chase items that are checked out past their due date, and choose how early asset managers are warned about warranties, inspections, registration, insurance and service.',
    keywords: 'items inventory checkout overdue return late borrower asset property vehicle equipment warranty inspection registration insurance service manager reminder days before alerts timing bell' },
  // Tickets - one group, seven tabs (Pranshu, Sep 26: routing, ticket email
  // and SLAs are one subject to an admin).
  { id: 'service-desk', subject: 'tickets', face: 'both', scope: 'org', icon: Headset, title: 'Ticket Manager',
    sub: 'Everything about tickets: who receives and escalates them, which events send email, and the response targets and ticket types requesters choose from.',
    keywords: 'tickets agents routing queue departments escalation notifications email mailbox cc reply-to auto-close delivery log sla priority hours response types intake questions fields help topics what do you need help with saved replies canned responses default assignee auto assign ai summary suggested help topic' },
  // Time & Pay
  { id: 'timeclock-policy', subject: 'pay', face: 'org', scope: 'org', icon: CalendarClock, title: 'Pay Rules',
    sub: 'Punch rounding (off by default), the auto-lunch deduction and California paid rest breaks. Applies to every time sheet.',
    keywords: 'time clock punch rounding nearest minutes swipeclock auto lunch deduction meal break paid rest break california time sheet' },
  { id: 'payroll-export-codes', subject: 'pay', face: 'both', scope: 'company', icon: FileText, title: 'Payroll Export Codes',
    sub: 'The payroll item name each pay class carries in the QuickBooks IIF and the Intacct payroll memo, and the QuickBooks company name, per company.',
    keywords: 'payroll export codes earnings codes payroll items quickbooks iif intacct memo company name pay class' },
  { id: 'pay-premiums', subject: 'pay', face: 'both', scope: 'company', icon: Clock, title: 'Shift Differentials & Call-Back Pay',
    sub: 'Extra pay per hour at night, on weekends or at certain sites, and a minimum paid time when someone is called back - per company, off by default.',
    keywords: 'shift differential night weekend site premium call-back callback minimum paid hours hourly' },
  // Workforce Analytics - per company, nothing to set for every company yet.
  { id: 'company-policy', subject: 'analytics', face: 'company', scope: 'company', icon: MonitorDot, title: 'Workforce Analytics Policy',
    sub: 'Whether work on company computers is captured for this company, how often, and what is tracked.',
    keywords: 'workforce analytics monitoring policy capture screenshots interval tracking employee tracking' },
  // Shifts & Scheduling
  { id: 'shift-settings', subject: 'shifts', face: 'both', scope: 'layered', icon: CalendarClock, title: 'Shift Settings',
    sub: 'What staff may request (open shifts, swaps, offers, time off) and see of their teammates, the team time zone, which day the week starts on, and the time-off reasons.',
    keywords: 'shifts schedule requests swap offer open shift time off reasons time zone week start sunday monday visibility' },
  { id: 'shift-types', subject: 'shifts', face: 'both', scope: 'layered', icon: Clock, title: 'Shift Types',
    sub: 'The reusable shifts managers place with one click - name, code, color, times, time zone and days. A person\'s usual hours are one of these.',
    keywords: 'shifts presets shift type code color times usual hours grace break time zone days' },
  { id: 'shift-groups', subject: 'shifts', face: 'both', scope: 'layered', icon: Users, title: 'Groups',
    sub: 'Who is scheduled together, the order they appear in, who may build each group\'s schedule, and the Teams chat its BOD / EOD messages go to.',
    keywords: 'shifts groups teams members schedulers order teams chat bod eod' },
  { id: 'shift-weather', subject: 'shifts', face: 'both', scope: 'company', icon: CloudRain, title: 'Weather Alerts',
    sub: 'Which companies the weather watch runs for, what counts as major rain, quiet hours, and the heads-up line in Teams. Nexus advises; a manager makes the weather call.',
    keywords: 'weather rain forecast alerts advisory storm thunderstorm warning nws quiet hours deciders weather call' },
  // Hiring & Onboarding
  { id: 'hiring-documents', subject: 'hiring', face: 'both', scope: 'company', icon: FileText, title: 'Hiring Documents',
    sub: 'Offer letters, hiring packets, promotion letters and separation packages: which documents each company sends, for which roles and kind of hire, who signs, and Ready To Send.',
    keywords: 'packets offer letter hiring packet promotion separation nda confidentiality agreement documents signers' },
  { id: 'interview-questionnaires', subject: 'hiring', face: 'org', scope: 'org', icon: ClipboardList, title: 'Interview Questionnaires',
    sub: 'The questions asked in each role\'s interview - the Interview Room shows them to the interviewer.',
    keywords: 'questions interview questionnaire role character competence availability' },
  // Neil, Oct 19: "copy from company or have a common library".
  { id: 'checklist-library', subject: 'hiring', face: 'org', scope: 'layered', icon: ListChecks, title: 'Checklist Library',
    sub: 'The steps every new onboarding, promotion, offboarding and leave checklist starts with, whatever the role, and the default role owners. Each company adds its own with the company picked, and each role its own (People & Access > the company > Roles > a role > Checklists).',
    keywords: 'checklist onboarding promotion offboarding leave steps template library owners copy standardize' },
  { id: 'company-checklists', subject: 'hiring', face: 'company', scope: 'company', icon: ListChecks, title: 'Checklists',
    sub: 'This company\'s role owners and the steps its onboarding, promotion, offboarding and leave checklists add to the library\'s, role by role.',
    keywords: 'company checklists onboarding promotion offboarding leave steps owners roles missing' },
  // Items & Equipment
  { id: 'item-types', subject: 'items', face: 'org', scope: 'org', icon: Tag, title: 'Item Types & Custom Fields',
    sub: 'The item types and extra fields available to everyone when adding or editing items.',
    keywords: 'inventory equipment catalog fields types' },
  // Operations
  { id: 'ops-cubby-push', subject: 'operations', face: 'org', scope: 'org', icon: Warehouse, title: 'Push to Cubby',
    sub: 'Off by default: Nexus only reads from Cubby and staff mark changes Entered in Cubby. On: approved rate and rent changes can be pushed to Cubby from Nexus.',
    keywords: 'cubby push sync write rates rent ecri rate management revenue management storage facilities operations locked switch' },
];
const GROUP_META = Object.fromEntries(GROUPS.map(g => [g.id, g]));

// Every word typed has to appear somewhere in the group's title,
// description, keywords or subject name.
function groupMatches(g, needle) {
  const subject = SUBJECTS.find(s => s.key === g.subject)?.label || '';
  const hay = `${g.title} ${g.sub} ${g.keywords} ${subject}`.toLowerCase();
  return needle.split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

// What a group's scope chip says. `company` is the picked company's name
// ('' at "Every company").
function scopeLabel(scope, company) {
  if (company) return company;
  if (scope === 'company') return 'Per company';
  if (scope === 'layered') return 'Defaults, per company overrides';
  return 'Every company';
}

function ScopeChip({ scope, company }) {
  const own = !!company;
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', whiteSpace: 'nowrap',
      padding: '2px 7px', borderRadius: 4, border: '1px solid',
      borderColor: own ? 'hsl(var(--color-orange))' : 'var(--line)',
      color: own ? 'hsl(var(--color-orange))' : 'var(--muted)',
      background: own ? 'hsla(var(--color-orange),0.08)' : 'transparent',
    }}>
      {scopeLabel(scope, company)}
    </span>
  );
}

// A setting group: a card with the group's title and description, always
// open (Neil, Oct 23: nothing behind a click). `bare` drops the card chrome
// for a subject's lone group, since the subject heading already names it.
// `highlight` marks the group a link pointed at (sub '<subject>:<group>').
function Group({ id, icon: Icon, title, sub, scope, company, bare = false, highlight = false, children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [highlight]);
  if (bare) return <div id={`setting-${id}`} ref={ref}>{children}</div>;
  return (
    <section id={`setting-${id}`} ref={ref} aria-label={title} data-highlight={highlight ? 'true' : undefined} style={{
      border: `1px solid ${highlight ? 'var(--wk-brand)' : 'var(--line)'}`, borderRadius: 12, background: 'var(--card)',
      marginBottom: 12, overflow: 'hidden', boxShadow: highlight ? '0 0 0 3px var(--wk-brand-tint)' : 'none', scrollMarginTop: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px' }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--paper)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Icon size={14} style={{ color: 'var(--ink)' }} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <h4 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{title}</h4>
          {sub && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
        </span>
        <ScopeChip scope={scope} company={company} />
      </div>
      <div style={{ padding: '0 18px 18px', borderTop: '1px solid var(--line)' }}><div style={{ paddingTop: 16 }}>{children}</div></div>
    </section>
  );
}

// A company-only group asked for at "Every company": pick the company first.
function PickCompany({ entities, onPick, what }) {
  return (
    <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
      <div style={{ marginBottom: 10 }}>{what} is set per company. Pick one:</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {entities.map(en => (
          <button key={en.id} type="button" className="secondary-btn" onClick={() => onPick(en.id)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
            <Building2 size={13} /> {en.name}
          </button>
        ))}
        {entities.length === 0 && <span>No companies yet - add one under Companies first.</span>}
      </div>
    </div>
  );
}
// Branding (accent color) was left out on Sep 9 (Pranshu: an individual's
// own choice). The company accent itself - the one saved setting every
// screen and the sign-in page read - now lives under Branding & Policies
// (Sep 26); each person's own Work OS theme stays in My Profile.

// ── Item Management: types + custom fields ────────────────────────────────────
function ItemSettingsSection({ toast, chrome }) {
  const [itemTypes, setItemTypes]   = useState([]);
  const [typeCounts, setTypeCounts] = useState({});
  const [customFields, setCustomFields] = useState([]);
  const [typesOpen, setTypesOpen]   = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);

  const refreshTypes = useCallback(() => { api.getItemTypes().then(setItemTypes).catch(() => {}); }, []);
  const refreshFields = useCallback(() => { api.getItemCustomFields().then(setCustomFields).catch(() => {}); }, []);

  useEffect(() => {
    refreshTypes();
    refreshFields();
    api.getItems().then(items => {
      const m = {};
      for (const i of (items || [])) { const t = i.itemType || 'Other'; m[t] = (m[t] || 0) + 1; }
      setTypeCounts(m);
    }).catch(() => {});
  }, [refreshTypes, refreshFields]);

  return (
    <Group {...GROUP_META['item-types']} {...chrome}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button className="secondary-btn" onClick={() => setTypesOpen(true)}>Manage Item Types</button>
        <button className="secondary-btn" onClick={() => setFieldsOpen(true)}>Manage Custom Fields</button>
      </div>
      {typesOpen && (
        <Suspense fallback={<ModalFallback />}>
          <ManageTypesModal types={itemTypes} counts={typeCounts} onClose={() => setTypesOpen(false)}
            onChanged={t => setItemTypes(Array.isArray(t) && t.length ? t : itemTypes)} toast={toast} />
        </Suspense>
      )}
      {fieldsOpen && (
        <Suspense fallback={<ModalFallback />}>
          <CustomFieldsAdminModal fields={customFields} onClose={() => setFieldsOpen(false)}
            onChanged={refreshFields} toast={toast} />
        </Suspense>
      )}
    </Group>
  );
}

// ── Service Desk + Tasks ───────────────────────────────────────────────────────
// Service Desk is one section with three panels (Pranshu, Sep 26: routing,
// ticket email and SLAs are one subject to an admin). Each panel is
// self-contained (own data fetch, own role gate, own Save). A panel mounts the
// first time its tab is opened and then stays mounted, hidden, so switching
// tabs never throws away edits that haven't been saved yet.
const SERVICE_DESK_TABS = [
  { key: 'routing',       label: 'Routing & Escalation', Icon: Headset, Panel: TicketDeskSettings },
  { key: 'notifications', label: 'Notifications',        Icon: Bell,    Panel: TicketNotifySettings },
  { key: 'sla',           label: 'SLA & Ticket Types',   Icon: Timer,   Panel: TicketTaxonomySettings },
  // Department -> "What do you need help with?" choices (Pranshu, Sep 30).
  { key: 'topics',        label: 'Help Topics',          Icon: Tags,    Panel: TicketHelpTopicsSettings },
  // Who works the desk, and as agent or supervisor (Oct 2026, ticket_roles.py).
  { key: 'access',        label: 'Desk Access',          Icon: ShieldCheck, Panel: TicketDeskAccessSettings },
  // The desk's canned responses (Oct 2026, routers/ticket_saved_replies.py).
  { key: 'replies',       label: 'Saved Replies',        Icon: MessageSquareText, Panel: TicketSavedRepliesSettings },
  // AI Summary + Suggested Help Topic on/off (Oct 2026, routers/ticket_ai.py).
  { key: 'ai',            label: 'AI Features',          Icon: Sparkles, Panel: TicketAiSettings },
];

// With a company picked (Oct 23) only Routing & Escalation applies - that
// company's agents, departments, heads and default assignees - and it opens
// on that company.
function ServiceDeskSection({ chrome, company = '' }) {
  const [tab, setTab] = useState('routing');
  const [seen, setSeen] = useState(() => new Set(['routing']));
  const pick = (key) => { setTab(key); setSeen(prev => (prev.has(key) ? prev : new Set(prev).add(key))); };
  const tabs = company ? SERVICE_DESK_TABS.filter(t => t.key === 'routing') : SERVICE_DESK_TABS;
  return (
    <Group {...GROUP_META['service-desk']} {...chrome}>
      <div role="tablist" aria-label="Ticket Manager" className="scroll-tabs"
        style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)', marginBottom: 16 }}>
        {tabs.map(({ key, label, Icon }) => {
          const active = key === tab;
          return (
            <button key={key} type="button" role="tab" aria-selected={active} onClick={() => pick(key)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', whiteSpace: 'nowrap',
                border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
                fontWeight: 600, color: active ? 'var(--wk-brand)' : 'var(--muted)', marginBottom: -1,
                borderBottom: `2px solid ${active ? 'var(--wk-brand)' : 'transparent'}`,
              }}>
              <Icon size={14} /> {label}
            </button>
          );
        })}
      </div>
      {tabs.filter(t => seen.has(t.key)).map(({ key, Panel }) => (
        <div key={key} role="tabpanel" hidden={key !== tab}><Panel company={company || undefined} /></div>
      ))}
    </Group>
  );
}

function TaskNotificationsSection({ chrome }) {
  return (
    <Group {...GROUP_META['task-notifications']} {...chrome}>
      <Suspense fallback={<SectionFallback />}>
        <TaskNotifySettingsWrapped />
      </Suspense>
    </Group>
  );
}

// ── Daily Briefing ─────────────────────────────────────────────────────────
// Global-Admin only (see DailyBriefingSettings.jsx, which shows its own
// "access required" note to anyone else).
function DailyBriefingSection({ chrome }) {
  return (
    <Group {...GROUP_META['daily-briefing']} {...chrome}>
      <DailyBriefingSettings />
    </Group>
  );
}

// ── Weekly Digest ──────────────────────────────────────────────────────────
// Global-Admin only, like the Daily Briefing (WeeklyDigestSettings.jsx).
function WeeklyDigestSection({ chrome }) {
  return (
    <Group {...GROUP_META['weekly-digest']} {...chrome}>
      <WeeklyDigestSettings />
    </Group>
  );
}

// ── Workforce Scorecard ────────────────────────────────────────────────────
// Global-Admin only, like the Weekly Digest (WorkforceScorecardSettings.jsx).
function WorkforceScorecardSection({ chrome }) {
  return (
    <Group {...GROUP_META['workforce-scorecard']} {...chrome}>
      <WorkforceScorecardSettings />
    </Group>
  );
}

// ── HR & Compliance Reminders ──────────────────────────────────────────────
// Lazy: its chunk only loads when the section is opened. The panel reads its
// own edit permission from the API (canEdit) and goes read-only without it.
function HrRemindersSection({ chrome }) {
  return (
    <Group {...GROUP_META['hr-reminders']} {...chrome}>
      <Suspense fallback={<SectionFallback />}>
        <HrReminderSettings />
      </Suspense>
    </Group>
  );
}

// ── Hiring setup (Oct 14) - the editors the Hiring board used to open,
// reached from Settings now; they open full size, as before.
function HiringSetupSection({ id, Modal, label, chrome, toastOk, toastErr, modalProps }) {
  const [open, setOpen] = useState(false);
  return (
    <Group {...GROUP_META[id]} {...chrome}>
      <button type="button" className="primary-btn" onClick={() => setOpen(true)} style={{ fontSize: 12.5 }}>{label}</button>
      {open && (
        <Suspense fallback={<ModalFallback />}>
          <Modal onClose={() => setOpen(false)} toastOk={toastOk} toastErr={toastErr} {...modalProps} />
        </Suspense>
      )}
    </Group>
  );
}

// ── A lazy panel inside the usual group card (Branding, Shifts, Checklists,
// Operations...): its chunk loads when the subject is opened.
function LazyPanelSection({ id, Panel, chrome, toastOk, toastErr, ...rest }) {
  return (
    <Group {...GROUP_META[id]} {...chrome}>
      <Suspense fallback={<SectionFallback />}>
        <Panel toastOk={toastOk} toastErr={toastErr} {...rest} />
      </Suspense>
    </Group>
  );
}

// Workforce Analytics Policy moved OUT of here (Sep 19, Pranshu: "all
// companies have their different workforce analytics policy") - it's no
// longer one shared setting, so it lives on each company's own tab in
// Settings -> Company Setup instead. See HR.jsx's CompanySetupPage.

// ── Email Signature (Pranshu, Sep 16) ──────────────────────────────────────────
// Template + sign-off are a company-wide admin choice here, not a personal one
// (reverses the Sep 9 "Branding... stays in the header's account menu" note
// above for this specific piece - the underlying signature builder was
// designed around Neil's "consistent across the entire organisation" brief,
// and Pranshu decided the visual pick belongs with the rest of company
// branding). Name/role/e-mail still come from each person's own directory
// record automatically; preferred display name and phone override stay
// self-service in My Profile (header → account menu) since those genuinely
// are personal, just not the template.
// The little rectangle that actually shows a signature's markup is a stand-in
// for how it'll look pasted into an email - always white paper with dark
// text, on purpose, the same in light or dark Nexus (an email client never
// knows or cares what theme the admin's browser is in). Only the card CHROME
// around it (border, label, buttons, the zoom modal's frame) follows Nexus's
// own theme - that's the piece that was stuck hardcoded to white (Sep 19:
// "when i'm changing the mode of NEXUS to dark the template background
// should go black - but it is not").
function SignaturePaper({ html, height = 60, scale = 0.7 }) {
  return (
    <div style={{ background: '#fff', borderRadius: 4, overflow: 'hidden', height, pointerEvents: 'none' }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left', width: `${Math.round(100 / scale)}%` }}
        dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function SignatureZoomModal({ title, html, onClose }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 12, width: 'max(min(100%, 560px), 60vw)', maxWidth: '100%', minHeight: 'min(60vh, 90dvh)', maxHeight: '90dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, flex: 1, color: 'var(--ink)' }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}>
            <X size={18} />
          </button>
        </div>
        <div className="nx-fill" style={{ padding: 20, background: '#fff', overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}

// `company` (the scope picker, Oct 23): that company's template only; the
// sender overrides are for every company and show at "Every company".
function EmailSignatureSection({ toastOk, toastErr, chrome, company = '' }) {
  const [entities, setEntities] = useState([]);
  const [loaded, setLoaded] = useState(false);   // entities answered (even empty)
  const [companyId, setCompanyId] = useState(company);
  const [data, setData] = useState(null);       // { templates (with html), template }
  const [selectedTemplate, setSelectedTemplate] = useState('classic');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [zoomTemplate, setZoomTemplate] = useState(null);   // { label, html } | null - full-size eye-icon preview

  // Sender Template Overrides - global, not per-company (Sep 22, Pranshu:
  // "it will be for all whom email id we are adding so it should not be
  // company specific"), so this block loads/saves independently of the
  // Company picker above. `overrideTemplates` is just {id,label} - no
  // company branding to render a sample against, unlike `data.templates`.
  const [overrideTemplates, setOverrideTemplates] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [overrideModal, setOverrideModal] = useState(null);   // 'new' | index into `overrides` | null
  const [overridesSaveBusy, setOverridesSaveBusy] = useState(false);

  const loadPreview = useCallback((id) => {
    if (!id) return;
    setPreviewBusy(true);
    api.getEntitySignatureTemplates(id)
      .then(d => { setData(d); setSelectedTemplate(d.template); })
      .catch(() => {})
      .finally(() => setPreviewBusy(false));
  }, []);

  // Both halves load once, when the group mounts (it is always open now).
  useEffect(() => {
    api.getEntities().then(rows => {
      setEntities(rows || []);
      const first = (company && rows?.some(r => r.id === company)) ? company : rows?.[0]?.id;
      if (first) { setCompanyId(first); loadPreview(first); }
    }).catch(() => {}).finally(() => setLoaded(true));
    if (!company) {
      api.getSignatureSenderOverrides()
        .then(d => { setOverrideTemplates(d.templates || []); setOverrides(d.senderOverrides || []); })
        .catch(() => {});
    }
  }, [loadPreview, company]);

  function pickCompany(id) {
    setCompanyId(id);
    setData(null);
    loadPreview(id);
  }

  function removeOverride(idx) {
    setOverrides(rows => rows.filter((_, i) => i !== idx));
  }

  async function saveTemplate() {
    if (!companyId || saveBusy) return;
    setSaveBusy(true);
    try {
      await api.updateEntity(companyId, { signature_template: selectedTemplate });
      toastOk('Signature template saved. It applies to every employee at this company.');
    } catch (e) { toastErr(e?.message || 'Could not save.'); }
    setSaveBusy(false);
  }

  async function saveOverrides() {
    if (overridesSaveBusy) return;
    setOverridesSaveBusy(true);
    try {
      const d = await api.saveSignatureSenderOverrides(overrides);
      setOverrideTemplates(d.templates || []);
      setOverrides(d.senderOverrides || []);
      toastOk('Sender template overrides updated.');
    } catch (e) { toastErr(e?.message || 'Could not save.'); }
    setOverridesSaveBusy(false);
  }

  return (
    <Group {...GROUP_META['email-signature']} {...chrome}>
      {entities.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>{loaded ? 'No companies yet. Add one under Company Settings first.' : 'Loading…'}</div>
      ) : (
        <>
          {!company && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--muted)', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Company</label>
              <select className="form-input" style={{ width: '100%', maxWidth: 320 }} value={companyId} onChange={e => pickCompany(e.target.value)}>
                {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
              </select>
            </div>
          )}
          {previewBusy && !data ? (
            <Spinner size="inline" />
          ) : data && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10, marginBottom: 14 }}>
                {data.templates.map(t => {
                  const selected = t.id === selectedTemplate;
                  return (
                    <div key={t.id} role="button" tabIndex={0} onClick={() => setSelectedTemplate(t.id)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedTemplate(t.id); } }}
                      style={{
                        textAlign: 'left', cursor: 'pointer', padding: 10, borderRadius: 8,
                        border: selected ? '2px solid hsl(var(--color-green))' : '1px solid var(--line)',
                        background: 'var(--card)', position: 'relative',
                      }}>
                      <button type="button" title={`Preview ${t.label} full-size`}
                        onClick={e => { e.stopPropagation(); setZoomTemplate(t); }}
                        style={{
                          position: 'absolute', top: 6, right: 6, background: 'var(--card)',
                          border: '1px solid var(--line)', borderRadius: 6, cursor: 'pointer',
                          display: 'flex', padding: 4, color: 'var(--muted)', zIndex: 1,
                        }}>
                        <Eye size={13} />
                      </button>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                        {t.label}
                        {selected && <Check size={12} style={{ color: 'hsl(var(--color-green))' }} />}
                      </div>
                      <SignaturePaper html={t.html} />
                    </div>
                  );
                })}
              </div>

              <button className="primary-btn" onClick={saveTemplate} disabled={saveBusy}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: saveBusy ? 0.6 : 1 }}>
                {saveBusy ? <Spinner size={14} /> : <Check size={14} />} Save
              </button>
            </>
          )}
        </>
      )}

      {!company && <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--line)' }}>
        <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--muted)', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
          Sender Template Overrides
        </label>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 10 }}>
          A custom signature for specific email addresses, such as a shared inbox or someone who needs a different layout. Overrides apply in every company, and every field is entered here rather than taken from the directory.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
          {overrides.map((grp, idx) => (
            <div key={grp.id || idx} style={{ textAlign: 'left', padding: 10, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', position: 'relative' }}>
              <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 4, zIndex: 1 }}>
                <button type="button" title="Edit" onClick={() => setOverrideModal(idx)}
                  style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 6, cursor: 'pointer', display: 'flex', padding: 4, color: 'var(--muted)' }}>
                  <Pencil size={13} />
                </button>
                <button type="button" title="Remove" onClick={() => removeOverride(idx)}
                  style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 6, cursor: 'pointer', display: 'flex', padding: 4, color: 'hsl(var(--color-red))' }}>
                  <Trash2 size={13} />
                </button>
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink)', marginBottom: 4, paddingRight: 50, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {grp.label || grp.emails?.[0] || 'Untitled'}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {(grp.emails || []).join(', ') || 'No addresses yet'}
              </div>
              {grp.previewHtml ? <SignaturePaper html={grp.previewHtml} /> : (
                <div style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>Not saved yet</div>
              )}
            </div>
          ))}
          <div role="button" tabIndex={0} onClick={() => setOverrideModal('new')}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOverrideModal('new'); } }}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
              minHeight: 92, cursor: 'pointer', borderRadius: 8, border: '1.5px dashed var(--line)',
              background: 'transparent', color: 'var(--muted)',
            }}>
            <Plus size={18} />
            <span style={{ fontSize: 11.5, fontWeight: 600 }}>Add Override</span>
          </div>
        </div>
        <button className="primary-btn" onClick={saveOverrides} disabled={overridesSaveBusy}
          style={{ marginTop: 14, display: 'inline-flex', alignItems: 'center', gap: 6, opacity: overridesSaveBusy ? 0.6 : 1 }}>
          {overridesSaveBusy ? <Spinner size={14} /> : <Check size={14} />} Save
        </button>
      </div>}

      {zoomTemplate && (
        <SignatureZoomModal title={zoomTemplate.label} html={zoomTemplate.html} onClose={() => setZoomTemplate(null)} />
      )}
      {overrideModal !== null && (
        <SenderOverrideModal
          templates={overrideTemplates}
          grp={overrideModal === 'new' ? null : overrides[overrideModal]}
          onClose={() => setOverrideModal(null)}
          onSaved={next => {
            setOverrides(rows => overrideModal === 'new' ? [...rows, next] : rows.map((r, i) => i === overrideModal ? next : r));
            setOverrideModal(null);
          }}
          toastOk={toastOk} toastErr={toastErr}
        />
      )}
    </Group>
  );
}

// Reorderable "detail rows" a sender override can show, in whatever order the
// admin drags them into (Sep 22, Pranshu: "i should drag and make the layout
// of template as needed"). Name/logo/social/closing keep each template's own
// fixed position - only this group is reorderable (backend: myhr._ordered_row_values).
const OVERRIDE_ROW_KEYS = ['role', 'phone', 'email', 'website', 'address'];
const OVERRIDE_ROW_LABELS = { role: 'Role', phone: 'Phone', email: 'Email', website: 'Website', address: 'Address' };

// Keeps `order` valid as custom fields are added/removed: drops any key that
// no longer exists (a stale "custom:N" past the end of the list), then
// appends anything valid that's missing (a freshly added custom field, or
// the initial default order for a brand-new override) - nothing is ever
// silently dropped from view just because the admin hasn't dragged it yet.
function reconcileOrder(order, customCount) {
  const valid = [...OVERRIDE_ROW_KEYS, ...Array.from({ length: customCount }, (_, i) => `custom:${i}`)];
  const validSet = new Set(valid);
  const kept = (order || []).filter(k => validSet.has(k));
  const missing = valid.filter(k => !kept.includes(k));
  return [...kept, ...missing];
}

const _OVERRIDE_FIELD_DEFS = [
  ['name', 'Name'], ['role', 'Role'], ['phone', 'Phone'], ['email', 'Email'],
  ['website', 'Website'], ['address', 'Address'],
  ['companyName', 'Company Name'], ['companyPhone', 'Company Phone'],
  ['facebookUrl', 'Facebook URL'], ['linkedinUrl', 'LinkedIn URL'], ['twitterUrl', 'Twitter URL'], ['instagramUrl', 'Instagram URL'],
  ['closing', 'Sign-Off'],
];
// logoUrl isn't in _OVERRIDE_FIELD_DEFS (it gets its own upload widget, not a
// plain text input) but still needs a default in `fields` - the backend's
// _OVERRIDE_FIELD_KEYS and every render function expect the key to exist.
const _EMPTY_OVERRIDE_FIELDS = { logoUrl: '', ...Object.fromEntries(_OVERRIDE_FIELD_DEFS.map(([k]) => [k, ''])) };

function SenderOverrideModal({ templates, grp, onClose, onSaved, toastOk, toastErr }) {
  const [label, setLabel] = useState(grp?.label || '');
  const [emails, setEmails] = useState(grp?.emails || []);
  const [emailDraft, setEmailDraft] = useState('');
  const [template, setTemplate] = useState(grp?.template || templates?.[0]?.id || 'classic');
  const [fields, setFields] = useState({ ..._EMPTY_OVERRIDE_FIELDS, ...(grp?.fields || {}) });
  const [customFields, setCustomFields] = useState(grp?.customFields?.length ? grp.customFields : []);
  const [fieldOrder, setFieldOrder] = useState(() => reconcileOrder(grp?.fieldOrder, grp?.customFields?.length || 0));
  const [dragKey, setDragKey] = useState(null);
  const [previewHtml, setPreviewHtml] = useState(grp?.previewHtml || '');
  const [logoBusy, setLogoBusy] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const debounceRef = useRef(null);

  function setFieldValue(key, val) { setFields(f => ({ ...f, [key]: val })); }

  async function uploadLogo(file) {
    if (!file) return;
    setLogoBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const { logoUrl } = await api.uploadSenderOverrideLogo(form);
      setFieldValue('logoUrl', logoUrl);
      toastOk?.('Logo uploaded.');
    } catch (e) { toastErr?.(e?.message || 'Could not upload logo.'); }
    setLogoBusy(false);
  }

  function addCustomField() {
    const next = [...customFields, { label: '', value: '' }];
    setCustomFields(next);
    setFieldOrder(o => reconcileOrder(o, next.length));
  }
  function setCustomField(i, key, val) {
    setCustomFields(cf => cf.map((r, idx) => idx === i ? { ...r, [key]: val } : r));
  }
  function removeCustomField(i) {
    const next = customFields.filter((_, idx) => idx !== i);
    setCustomFields(next);
    // Indices shift on removal - remap "custom:N" keys onto the new array,
    // then reconcile so nothing stale or out-of-range survives.
    setFieldOrder(o => reconcileOrder(
      o.filter(k => k !== `custom:${i}`).map(k => {
        if (!k.startsWith('custom:')) return k;
        const n = Number(k.slice(7));
        return n > i ? `custom:${n - 1}` : k;
      }),
      next.length,
    ));
  }

  function commitEmailDraft() {
    const v = emailDraft.trim().toLowerCase();
    setEmailDraft('');
    if (v && v.includes('@') && !emails.includes(v)) setEmails(e => [...e, v]);
  }
  function removeEmail(email) { setEmails(e => e.filter(x => x !== email)); }

  function reorderRow(from, to) {
    if (!from || from === to) return;
    setFieldOrder(order => {
      const next = order.filter(k => k !== from);
      const idx = next.indexOf(to);
      next.splice(idx >= 0 ? idx : next.length, 0, from);
      return next;
    });
  }

  // Live preview - debounced, never persisted; mirrors the exact render path
  // a real send takes (backend reuses myhr._render_override_signature).
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      api.previewSenderOverride({ template, fields, custom_fields: customFields, field_order: fieldOrder })
        .then(r => setPreviewHtml(r.html))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(debounceRef.current);
  }, [template, fields, customFields, fieldOrder]);

  function save() {
    onSaved({
      id: grp?.id || '', label, emails, template, fields, customFields, fieldOrder, previewHtml,
    });
  }

  const inputStyle = { width: '100%' };
  const labelStyle = { fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--muted)', textTransform: 'uppercase', display: 'block', marginBottom: 5 };
  const rowKeys = reconcileOrder(fieldOrder, customFields.length);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 12, width: '60vw', minWidth: 340, maxWidth: '96vw', maxHeight: '90vh', overflow: 'auto', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, flex: 1, color: 'var(--ink)' }}>{grp ? 'Edit Override' : 'Add Override'}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={labelStyle}>Label (Optional)</label>
            <input className="form-input" style={inputStyle} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Sales Team" />
          </div>

          <div>
            <label style={labelStyle}>Applies To</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
              {emails.map(email => (
                <span key={email} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 20, padding: '3px 6px 3px 10px' }}>
                  {email}
                  <button type="button" onClick={() => removeEmail(email)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}>
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
            <input className="form-input" style={inputStyle} value={emailDraft} placeholder="Type an email, press Enter or comma to add"
              onChange={e => setEmailDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') { e.preventDefault(); commitEmailDraft(); } }}
              onBlur={commitEmailDraft} />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>An employee's address or a shared inbox. It does not need a Nexus account.</div>
          </div>

          <div>
            <label style={labelStyle}>Template</label>
            <select className="form-input" style={inputStyle} value={template} onChange={e => setTemplate(e.target.value)}>
              {templates.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>

          <div>
            <label style={labelStyle}>Logo</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {fields.logoUrl && <img src={fields.logoUrl} alt="" style={{ height: 32, maxWidth: 120, objectFit: 'contain', borderRadius: 4, background: '#fff', border: '1px solid var(--line)' }} />}
              <label className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', opacity: logoBusy ? 0.6 : 1 }}>
                {logoBusy ? <Spinner size={13} /> : <Upload size={13} />}
                {fields.logoUrl ? 'Replace' : 'Upload'}
                <input type="file" accept="image/*" style={{ display: 'none' }} disabled={logoBusy}
                  onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadLogo(f); }} />
              </label>
              {fields.logoUrl && (
                <button type="button" onClick={() => setFieldValue('logoUrl', '')}
                  style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, cursor: 'pointer', color: 'hsl(var(--color-red))', display: 'flex', alignItems: 'center', padding: '4px 8px' }}>
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {_OVERRIDE_FIELD_DEFS.map(([key, fieldLabel]) => (
              <div key={key}>
                <label style={labelStyle}>{fieldLabel}</label>
                <input className="form-input" style={inputStyle} value={fields[key] || ''} onChange={e => setFieldValue(key, e.target.value)} />
              </div>
            ))}
          </div>

          <div>
            <label style={labelStyle}>Custom Fields</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {customFields.map((f, i) => (
                <div key={i} style={{ display: 'flex', gap: 6 }}>
                  <input className="form-input" style={{ flex: 1 }} placeholder="Label" value={f.label} onChange={e => setCustomField(i, 'label', e.target.value)} />
                  <input className="form-input" style={{ flex: 1 }} placeholder="Value" value={f.value} onChange={e => setCustomField(i, 'value', e.target.value)} />
                  <button type="button" onClick={() => removeCustomField(i)}
                    style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, cursor: 'pointer', color: 'hsl(var(--color-red))', display: 'flex', alignItems: 'center', padding: '0 8px' }}>
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button type="button" className="secondary-btn" onClick={addCustomField}
                disabled={customFields.length >= 12}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}>
                <Plus size={13} /> Add Field
              </button>
            </div>
          </div>

          <div>
            <label style={labelStyle}>Field Order</label>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>Drag to set the order fields appear in. Blank fields are left out.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {rowKeys.map(key => {
                const rowLabel = key.startsWith('custom:')
                  ? (customFields[Number(key.slice(7))]?.label || `Custom Field ${Number(key.slice(7)) + 1}`)
                  : OVERRIDE_ROW_LABELS[key];
                return (
                  <div key={key} draggable
                    onDragStart={() => setDragKey(key)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => { e.preventDefault(); reorderRow(dragKey, key); setDragKey(null); }}
                    onDragEnd={() => setDragKey(null)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6,
                      border: '1px solid var(--line)', background: 'var(--paper)', cursor: 'grab',
                      opacity: dragKey === key ? 0.45 : 1, fontSize: 12.5, color: 'var(--ink)',
                    }}>
                    <GripVertical size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    {rowLabel}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
              Preview
              <button type="button" title="Preview full-size" onClick={() => setZoomed(true)}
                style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, cursor: 'pointer', display: 'flex', padding: 3, color: 'var(--muted)' }}>
                <Eye size={12} />
              </button>
            </label>
            <SignaturePaper html={previewHtml} height={90} scale={0.85} />
          </div>

          <button className="primary-btn" onClick={save} disabled={!emails.length}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}>
            <Check size={14} /> Save
          </button>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>Changes take effect when you click Save under Sender Template Overrides.</div>
        </div>
      </div>
      {zoomed && (
        <SignatureZoomModal title={label || 'Preview'} html={previewHtml} onClose={() => setZoomed(false)} />
      )}
    </div>
  );
}

// ── Work Site Library (Neil, Sep 25) - every site entered once, here; each
// company picks its own from Company Settings -> the company -> Work Sites.
function WorkSiteLibrarySection({ toastOk, toastErr, chrome }) {
  return (
    <Group {...GROUP_META['work-sites']} {...chrome}>
      <Suspense fallback={<SectionFallback />}>
        <WorkSiteLibrary toastOk={toastOk} toastErr={toastErr} />
      </Suspense>
    </Group>
  );
}

// ── Company page ─────────────────────────────────────────────────────────────
// The old Company Settings page (HR.jsx's CompanySetupPage), reused whole: at
// "Every company" it is the company list (Group Manager, Add Company); with a
// company picked it opens on that company and shows only the tabs the
// subject asked for, so Profile / Departments / Holiday Calendar sit under
// Companies, the company's sites under Locations, its Roles under People &
// Access, and so on. Entities come from the shell (the scope picker needs
// them too); sites are loaded here for the Locations tab.
function CompanyPage({ entities, refreshEntities, entityId = '', tabs = null, onOpen, onDirtyChange, toastOk, toastErr }) {
  const [sites, setSites] = useState([]);
  const loadSites = useCallback(() => api.getWorkSites().then(setSites).catch(() => {}), []);
  useEffect(() => { loadSites(); }, [loadSites]);
  return (
    <Suspense fallback={<SkeletonBlocks count={4} height={56} borderRadius={10} />}>
      <CompanySetupPage entities={entities} sites={sites} entityId={entityId} tabs={tabs} onOpen={onOpen} onDirtyChange={onDirtyChange}
        onChangedEntities={refreshEntities} onChangedSites={loadSites} toastOk={toastOk} toastErr={toastErr} />
    </Suspense>
  );
}

// The tabs of the old company page each company-face group shows.
const COMPANY_FACE_TABS = {
  'company-profile':    ['overview', 'departments', 'holidays'],
  'company-sites':      ['sites'],
  'company-roles':      ['roles'],
  'company-policy':     ['monitoring'],
  'company-checklists': ['checklists'],
};

// ── Settings ─────────────────────────────────────────────────────────────────
// Subject rail on the left (desktop) or a select (phones), the scope picker
// and a filter box that searches every subject at once. Subject, group and
// company live in the URL sub (see AdminConsole below); the filter text is
// local.
function SettingsBody({ subject, group, company, onNavigate, entities, refreshEntities, toast, toastOk, toastErr }) {
  const { can } = useRole();
  const narrow = useIsMobile('(max-width: 900px)');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  // Access, Security, Branding and Time & Pay are administrator-only (their
  // panels and routes say so too), so they are left out of the rail and the
  // filter for anyone else.
  const isAdmin = can('administrator');
  const subjects = useMemo(() => SUBJECTS.filter(s => !s.adminOnly || isAdmin), [isAdmin]);
  const groups = useMemo(() => GROUPS.filter(g => (!g.adminOnly || isAdmin) && subjects.some(s => s.key === g.subject)), [subjects, isAdmin]);

  const entity = company ? entities.find(e => e.id === company) : null;
  const companyName = entity?.name || '';
  // With a company picked, only subjects with a company face are live; the
  // rest sit under "For every company" and switch the scope back.
  const live = useMemo(() => subjects.filter(s => !company || s.faces !== 'org'), [subjects, company]);
  const rest = useMemo(() => subjects.filter(s => !live.includes(s)), [subjects, live]);
  const activeSubject = live.find(s => s.key === subject) || live[0];

  // The groups a subject shows at this scope: its company face with a
  // company picked; otherwise its organization face, or (a per-company
  // subject such as Workforce Analytics) its company groups as pickers.
  const groupsFor = useCallback((s) => {
    const own = groups.filter(g => g.subject === s.key);
    if (company) return own.filter(g => g.face !== 'org');
    const org = own.filter(g => g.face !== 'company');
    return org.length ? org : own.filter(g => g.face === 'company');
  }, [groups, company]);
  const searchable = useMemo(() => (company ? groups.filter(g => g.face !== 'org') : groups), [groups, company]);
  const matches = useMemo(() => (needle ? searchable.filter(g => groupMatches(g, needle)) : null), [needle, searchable]);
  const counts = useMemo(() => {
    if (!matches) return null;
    const m = {};
    for (const g of matches) m[g.subject] = (m[g.subject] || 0) + 1;
    return m;
  }, [matches]);

  // The Company profile form is the one group with unsaved state of its own;
  // leaving it mid-edit (another subject, another scope) asks first.
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(null);
  const go = useCallback((target) => { setQuery(''); setPending(null); onNavigate(target); }, [onNavigate]);
  const nav = useCallback((target) => { if (dirty) setPending(target); else go(target); }, [dirty, go]);
  const pickSubject = (key) => nav({ subject: key, group: '', company });
  const pickScope = (id) => nav({ subject: activeSubject?.key || 'companies', group: '', company: id });

  const sections = matches
    ? live.map(s => ({ s, items: matches.filter(g => g.subject === s.key) })).filter(x => x.items.length)
    : (activeSubject ? [{ s: activeSubject, items: groupsFor(activeSubject) }] : []);
  // A subject's lone group renders bare: the subject heading already names it.
  const bareId = !matches && sections[0]?.items.length === 1 ? sections[0].items[0].id : '';

  function renderGroup(g) {
    const id = g.id;
    const chrome = { bare: id === bareId, highlight: id === group, company: companyName };
    const key = `${id}-${company}`;
    // A company-only group at "Every company": pick the company first.
    if (g.face === 'company' && !company) {
      return (
        <Group key={key} {...g} {...chrome}>
          <PickCompany entities={entities} what={g.title} onPick={cid => nav({ subject: g.subject, group: id, company: cid })} />
        </Group>
      );
    }
    if (COMPANY_FACE_TABS[id]) {
      return (
        <Group key={key} {...g} {...chrome}>
          <CompanyPage entities={entities} refreshEntities={refreshEntities} entityId={company} tabs={COMPANY_FACE_TABS[id]}
            onDirtyChange={id === 'company-profile' ? setDirty : undefined} toastOk={toastOk} toastErr={toastErr} />
        </Group>
      );
    }
    switch (id) {
      case 'company-list':
        return (
          <Group key={key} {...g} {...chrome}>
            <CompanyPage entities={entities} refreshEntities={refreshEntities} onOpen={cid => nav({ subject: 'companies', group: '', company: cid })}
              onDirtyChange={setDirty} toastOk={toastOk} toastErr={toastErr} />
          </Group>
        );
      case 'email-signature':      return <EmailSignatureSection key={key} chrome={chrome} company={company} toastOk={toastOk} toastErr={toastErr} />;
      case 'work-sites':           return <WorkSiteLibrarySection key={key} chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      case 'service-desk':         return <ServiceDeskSection key={key} chrome={chrome} company={company} />;
      case 'task-notifications':   return <TaskNotificationsSection key={key} chrome={chrome} />;
      case 'daily-briefing':       return <DailyBriefingSection key={key} chrome={chrome} />;
      case 'weekly-digest':        return <WeeklyDigestSection key={key} chrome={chrome} />;
      case 'workforce-scorecard':  return <WorkforceScorecardSection key={key} chrome={chrome} />;
      case 'hr-reminders':         return <HrRemindersSection key={key} chrome={chrome} />;
      case 'equipment-reminders':  return <LazyPanelSection key={key} id={id} Panel={EquipmentReminderSettings} chrome={chrome} />;
      case 'item-types':           return <ItemSettingsSection key={key} chrome={chrome} toast={toast} />;
      case 'sign-in-sessions':     return <LazyPanelSection key={key} id={id} Panel={SecuritySettings} chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      case 'brand-color':          return <LazyPanelSection key={key} id={id} Panel={BrandColorPanel} chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      case 'email-appearance':     return <LazyPanelSection key={key} id={id} Panel={EmailAppearancePanel} chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      case 'signin-policy':        return <LazyPanelSection key={key} id={id} Panel={SignInPolicyPanel} chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      case 'access':
        return (
          <Group key={key} {...g} {...chrome}>
            <Suspense fallback={<SkeletonBlocks count={4} height={56} borderRadius={10} />}>
              <RolesAccess embedded />
            </Suspense>
          </Group>
        );
      case 'timeclock-policy':
        return (
          <Group key={key} {...g} {...chrome}>
            <TimeClockPolicyPanel toastOk={toastOk} toastErr={toastErr} />
          </Group>
        );
      case 'hiring-documents':     return <HiringSetupSection key={key} id={id} Modal={PacketsModal} label="Open Hiring Documents" chrome={chrome} toastOk={toastOk} toastErr={toastErr} modalProps={company ? { companyId: company, lockCompany: true } : undefined} />;
      case 'payroll-export-codes': return <LazyPanelSection key={key} id={id} Panel={PayrollExportCodes} chrome={chrome} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'pay-premiums':         return <LazyPanelSection key={key} id={id} Panel={PayPremiums} chrome={chrome} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'interview-questionnaires': return <HiringSetupSection key={key} id={id} Modal={QuestionnairesModal} label="Open Questionnaires" chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      case 'checklist-library':    return <LazyPanelSection key={key} id={id} Panel={ChecklistLibrary} chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      case 'shift-settings':       return <LazyPanelSection key={key} id={id} Panel={ShiftSettingsPanel} chrome={chrome} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'shift-types':          return <LazyPanelSection key={key} id={id} Panel={ShiftTypesPanel} chrome={chrome} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'shift-groups':         return <LazyPanelSection key={key} id={id} Panel={ShiftGroupsPanel} chrome={chrome} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'shift-weather':        return <LazyPanelSection key={key} id={id} Panel={WeatherSettingsPanel} chrome={chrome} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'ops-cubby-push':       return <LazyPanelSection key={key} id={id} Panel={OpsSettingsPanel} chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      default:                     return null;
    }
  }

  const scopePicker = (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <Building2 size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      <span style={{ fontSize: 12.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>Scope</span>
      <select className="form-input" aria-label="Scope" value={company} onChange={e => pickScope(e.target.value)}
        style={{ fontSize: 12.5, minWidth: 0, flex: '1 1 180px', maxWidth: 280 }}>
        <option value="">Every company</option>
        {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
      </select>
    </label>
  );

  const filterBox = (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
      <input className="form-input" type="search" value={query} onChange={e => setQuery(e.target.value)}
        placeholder="Filter settings" aria-label="Filter settings"
        style={{ width: '100%', paddingLeft: 28, fontSize: 12.5, boxSizing: 'border-box' }} />
    </div>
  );

  // With a company picked, the subject's organization-wide groups are a line
  // of links under its company face, so nothing seems to have vanished.
  const alsoOrg = company && activeSubject && !matches
    ? groups.filter(g => g.subject === activeSubject.key && g.face === 'org') : [];

  const content = (
    <div style={{ minWidth: 0 }}>
      {sections.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--muted)', fontSize: 13, border: '1px dashed var(--line)', borderRadius: 10 }}>
          {matches ? (
            <>
              <div style={{ marginBottom: 12 }}>No settings match "{query.trim()}"{company ? ` for ${companyName}` : ''}.</div>
              <button className="secondary-btn" onClick={() => setQuery('')}>Clear Filter</button>
            </>
          ) : 'Nothing to set here.'}
        </div>
      ) : sections.map(({ s, items }) => (
        <section key={s.key} style={{ marginBottom: 20 }}>
          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>
                {s.label}{company && <span style={{ color: 'var(--muted)', fontWeight: 500 }}> · {companyName}</span>}
              </h3>
              {!matches && <p style={{ margin: '3px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>{s.desc}</p>}
            </div>
            {items[0]?.id === bareId && <ScopeChip scope={items[0].scope} company={companyName} />}
          </div>
          {items.map(renderGroup)}
          {s === activeSubject && alsoOrg.length > 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Globe size={13} /> For every company:
              {alsoOrg.map(g => (
                <button key={g.id} type="button" onClick={() => nav({ subject: g.subject, group: g.id, company: '' })}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, color: 'var(--wk-brand)', fontWeight: 600 }}>
                  {g.title}
                </button>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );

  const railButton = ({ key, label, Icon }, { active = false, muted = false, count = null, onClick }) => (
    <button key={key} onClick={onClick} aria-current={active ? 'page' : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px',
        borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
        textAlign: 'left', background: active ? 'var(--wk-brand-tint)' : 'transparent',
        color: active ? 'var(--wk-brand)' : 'var(--ink)', fontWeight: active ? 600 : 500,
        opacity: muted || count === 0 ? 0.45 : 1,
      }}>
      <Icon size={15} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      {count > 0 && <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>{count}</span>}
    </button>
  );

  return (
    <>
      {narrow ? (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>{scopePicker}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <select className="form-input" aria-label="Subject" value={matches ? '' : (activeSubject?.key || '')}
              onChange={e => e.target.value && (live.some(s => s.key === e.target.value) ? pickSubject(e.target.value) : nav({ subject: e.target.value, group: '', company: '' }))}
              style={{ flex: '1 1 160px', minWidth: 0 }}>
              {matches && <option value="" disabled>Matching Settings</option>}
              {live.map(s => (
                <option key={s.key} value={s.key}>{s.label}{counts ? ` (${counts[s.key] || 0})` : ''}</option>
              ))}
              {rest.length > 0 && (
                <optgroup label="For every company">
                  {rest.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </optgroup>
              )}
            </select>
            <div style={{ flex: '1 1 160px', minWidth: 0 }}>{filterBox}</div>
          </div>
          {content}
        </>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: 24, alignItems: 'start' }}>
          <nav aria-label="Settings subjects" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ marginBottom: 10 }}>{filterBox}</div>
            {live.map(s => railButton(s, {
              active: !matches && s === activeSubject, count: counts ? (counts[s.key] || 0) : null,
              onClick: () => pickSubject(s.key),
            }))}
            {rest.length > 0 && (
              <>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', padding: '12px 10px 4px' }}>
                  For every company
                </div>
                {rest.map(s => railButton(s, { muted: true, onClick: () => nav({ subject: s.key, group: '', company: '' }) }))}
              </>
            )}
          </nav>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--paper)', marginBottom: 16 }}>
              {scopePicker}
              <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: '1 1 240px', minWidth: 0 }}>
                {company
                  ? `Showing what is set for ${companyName}. Switch to Every company for the settings shared by all.`
                  : 'Showing what applies to every company. Pick a company for its own profile, locations, roles, checklists and policy.'}
              </span>
            </div>
            {content}
          </div>
        </div>
      )}

      {pending && (
        <UnsavedChangesPrompt onKeepEditing={() => setPending(null)} onDiscard={() => go(pending)} />
      )}
    </>
  );
}

const TOP_TABS = [
  { key: 'settings', label: 'Settings', Icon: Settings2 },
  { key: 'tools',    label: 'Tools',    Icon: Wrench },
  { key: 'audit',    label: 'Logs',     Icon: Activity },
];

// activeSub -> { tab, subject, group, company }.
//   '<subject>' | '<subject>:<group>' | '<subject>@<companyId>' |
//   '<subject>:<group>@<companyId>' | 'tools' | 'audit'
// Every key from before the merge still lands (see the note at the top).
function resolveSub(sub) {
  const settings = (subject, group = '', company = '') => ({ tab: 'settings', subject, group, company });
  if (!sub || sub === 'settings' || sub === 'global' || sub === 'company') return settings('companies');
  if (sub === 'tools' || sub === 'audit') return { tab: sub, subject: 'companies', group: '', company: '' };
  if (sub === 'actas') return { tab: 'tools', subject: 'companies', group: '', company: '' };
  if (sub === 'access') return settings('access');
  if (sub.startsWith('global-')) return settings(LEGACY_SUBJECTS[sub.slice('global-'.length)] || 'companies');
  const at = sub.indexOf('@');
  const left = at >= 0 ? sub.slice(0, at) : sub;
  const company = at >= 0 ? sub.slice(at + 1) : '';
  const [subject, group = ''] = left.split(':');
  if (!SUBJECT_KEYS.has(subject)) return settings('companies');
  return settings(subject, GROUP_META[group] ? group : '', company);
}
function buildSub({ subject, group = '', company = '' }) {
  return `${subject}${group ? `:${group}` : ''}${company ? `@${company}` : ''}`;
}

export default function AdminConsole({ activeSub, onSubChange }) {
  const [toast, setToast] = useState(null); // { msg, kind }
  const showToast = useCallback((msg, kind = 'success') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3000);
  }, []);
  const toastOk = useCallback((msg) => showToast(msg, 'success'), [showToast]);
  const toastErr = useCallback((msg) => showToast(msg, 'error'), [showToast]);

  const resolved = resolveSub(activeSub);
  const topTab = TOP_TABS.some(t => t.key === resolved.tab) ? resolved.tab : 'settings';
  const setTopTab = (id) => onSubChange?.(id === 'settings' ? buildSub(resolved) : id);
  const navigate = useCallback((target) => onSubChange?.(buildSub(target)), [onSubChange]);

  // The companies, once, for the scope picker and every company page.
  const [entities, setEntities] = useState([]);
  const refreshEntities = useCallback(() => api.getEntities().then(rows => setEntities(rows || [])).catch(() => {}), []);
  useEffect(() => { refreshEntities(); }, [refreshEntities]);

  // Full-bleed, like every other module (HR, Item Management, Tickets) - no
  // maxWidth cap or extra padding of its own. .viewport (App.jsx) already
  // supplies the edge margin; a centered ~1100px column here just wasted the
  // rest of a wide monitor and forced a lot of scrolling on the bigger
  // embedded panels (Pranshu, Sep 9).
  return (
    <div style={{ fontFamily: 'Inter, sans-serif' }}>
      {/* Icon-chip page title (Work OS grammar), matching every other module's
          .view-header instead of a bespoke h1 (Pranshu, Sep 12). */}
      <div className="view-header" style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Settings2 size={19} />
          </span>
          <div className="view-title-group">
            <h2 style={{ fontFamily: 'var(--wk-font)' }}>Settings</h2>
            <p>Configure Nexus for every company or for one, and manage who can access what.</p>
          </div>
        </div>
      </div>

      {/* Tabs - desktop renders them centered in the top header; phones keep
          the in-page strip (ModuleTabs handles both) */}
      <ModuleTabs tabs={TOP_TABS} active={topTab} onChange={setTopTab} />

      {topTab === 'tools' ? (
        <Suspense fallback={<SkeletonBlocks count={3} height={120} borderRadius={12} />}>
          <SettingsTools />
        </Suspense>
      ) : topTab === 'audit' ? (
        <Suspense fallback={<SkeletonBlocks count={4} height={56} borderRadius={10} />}>
          <AuditLogs />
        </Suspense>
      ) : (
        <SettingsBody subject={resolved.subject} group={resolved.group} company={resolved.company} onNavigate={navigate}
          entities={entities} refreshEntities={refreshEntities}
          toast={showToast} toastOk={toastOk} toastErr={toastErr} />
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Time Clock pay rules (Charmi, Sep 30) ─────────────────────────────────────
// Punch rounding, auto-lunch and CA paid breaks used to be switches inside the
// Payroll timecard's Options popover ("this should all be in global
// settings"). Same three settings rows (nexus_settings), same endpoints - only
// the front door moved. Rounding is OFF for a new tenant; PROD keeps its own
// saved row. Per-company scoping (one rule per hr_entities company) is
// deferred: today each rule is one tenant-wide key.
function PolicyCard({ title, desc, enabled, onToggle, busy, children }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: '14px 16px', marginBottom: 12 }}>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: busy ? 'default' : 'pointer' }}>
        <input type="checkbox" checked={!!enabled} disabled={busy} onChange={e => onToggle(e.target.checked)} style={{ marginTop: 3 }} />
        <span style={{ flex: 1 }}>
          <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{title}</span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>{desc}</span>
        </span>
        {busy && <Spinner size={14} />}
      </label>
      {enabled && children && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 12, paddingLeft: 26 }}>{children}</div>
      )}
    </div>
  );
}

function PolicyNumber({ label, value, onChange, min = 0, max = 999, unit = 'min', width = 80 }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--ink)' }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <input className="form-input" type="number" min={min} max={max} step="1" value={value} onChange={e => onChange(e.target.value)} style={{ width, fontSize: 12.5 }} />
      <span style={{ color: 'var(--muted)' }}>{unit}</span>
    </label>
  );
}

function TimeClockPolicyPanel({ toastOk, toastErr }) {
  const [cfg, setCfg] = useState(null);     // { rounding, autoLunch, breakPolicy } | null while loading
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');     // which card is saving
  const load = useCallback(() => {
    setErr('');
    Promise.all([api.timeRoundingGet(), api.timeAutoLunchGet(), api.timeBreakPolicyGet()])
      .then(([rounding, autoLunch, breakPolicy]) => setCfg({ rounding, autoLunch, breakPolicy }))
      .catch(e => setErr(e?.message || 'Could not load the Time Clock settings.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  // Each save writes the whole rule, so a number typed and a switch flipped
  // never race each other; the server echoes the saved rule back.
  const save = async (key, next, label) => {
    setBusy(key);
    try {
      const saved = key === 'rounding' ? await api.timeRoundingSet(next)
        : key === 'autoLunch' ? await api.timeAutoLunchSet(next)
        : await api.timeBreakPolicySet(next);
      setCfg(c => ({ ...c, [key]: saved }));
      toastOk?.(`${label} saved.`);
    } catch (e) { toastErr?.(e?.message || `Could not save ${label.toLowerCase()}.`); }
    setBusy('');
  };
  const num = (v, fallback) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fallback; };

  if (err) return <ErrorLine text={err} onRetry={load} />;
  if (!cfg) return <SkeletonBlocks count={3} height={64} borderRadius={12} />;
  const { rounding, autoLunch, breakPolicy } = cfg;
  return (
    <div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>
        These rules shape every time sheet the moment they are saved. They apply to every company today; a rule per company is planned.
      </div>
      <PolicyCard title="Punch Rounding" busy={busy === 'rounding'} enabled={rounding.enabled}
        desc={`Round every clock-in and clock-out to the nearest ${rounding.nearestMin || 5} minutes before computing hours (SwipeClock's model; the raw times stay on record and can be shown on the time sheet). Off by default - turn it on only if the company has a rounding policy.`}
        onToggle={on => save('rounding', { enabled: on, nearestMin: rounding.nearestMin || 5 }, 'Punch rounding')}>
        <PolicyNumber label="Nearest" min={1} max={30} value={rounding.nearestMin}
          onChange={v => setCfg(c => ({ ...c, rounding: { ...c.rounding, nearestMin: v } }))} />
        <button type="button" className="secondary-btn" style={{ fontSize: 12 }} disabled={busy === 'rounding'}
          onClick={() => save('rounding', { enabled: true, nearestMin: Math.min(30, Math.max(1, num(rounding.nearestMin, 5))) }, 'Punch rounding')}>Save</button>
      </PolicyCard>
      <PolicyCard title="Auto-Lunch Deduction" busy={busy === 'autoLunch'} enabled={autoLunch.enabled}
        desc={`Deduct ${autoLunch.deductMin} minutes of lunch from any shift longer than ${Math.round((autoLunch.afterMin || 0) / 60 * 10) / 10} hours that has no recorded break (the person forgot to clock lunch).`}
        onToggle={on => save('autoLunch', { enabled: on, afterMin: num(autoLunch.afterMin, 360), deductMin: num(autoLunch.deductMin, 30) }, 'Auto-lunch')}>
        <PolicyNumber label="Shifts over" min={0} max={1440} value={autoLunch.afterMin}
          onChange={v => setCfg(c => ({ ...c, autoLunch: { ...c.autoLunch, afterMin: v } }))} />
        <PolicyNumber label="Deduct" min={0} max={240} value={autoLunch.deductMin}
          onChange={v => setCfg(c => ({ ...c, autoLunch: { ...c.autoLunch, deductMin: v } }))} />
        <button type="button" className="secondary-btn" style={{ fontSize: 12 }} disabled={busy === 'autoLunch'}
          onClick={() => save('autoLunch', { enabled: true, afterMin: num(autoLunch.afterMin, 360), deductMin: num(autoLunch.deductMin, 30) }, 'Auto-lunch')}>Save</button>
      </PolicyCard>
      <PolicyCard title="California Paid Rest Breaks" busy={busy === 'breakPolicy'} enabled={breakPolicy.enabled}
        desc={`Pay the first ${breakPolicy.paidBreakMin} minutes of each short break (up to ${breakPolicy.restMaxMin} minutes long) - one per 4 hours worked, as California requires. Meal-length breaks stay unpaid. Only employees on the California overtime rule; the long-break flags are always on.`}
        onToggle={on => save('breakPolicy', { ...breakPolicy, enabled: on, paidBreakMin: num(breakPolicy.paidBreakMin, 10), restMaxMin: num(breakPolicy.restMaxMin, 20), longBreakMin: num(breakPolicy.longBreakMin, 75) }, 'CA paid breaks')}>
        <PolicyNumber label="Paid per break" min={0} max={60} value={breakPolicy.paidBreakMin}
          onChange={v => setCfg(c => ({ ...c, breakPolicy: { ...c.breakPolicy, paidBreakMin: v } }))} />
        <PolicyNumber label="Rest break up to" min={1} max={120} value={breakPolicy.restMaxMin}
          onChange={v => setCfg(c => ({ ...c, breakPolicy: { ...c.breakPolicy, restMaxMin: v } }))} />
        <PolicyNumber label="Flag breaks over" min={15} max={600} value={breakPolicy.longBreakMin}
          onChange={v => setCfg(c => ({ ...c, breakPolicy: { ...c.breakPolicy, longBreakMin: v } }))} />
        <button type="button" className="secondary-btn" style={{ fontSize: 12 }} disabled={busy === 'breakPolicy'}
          onClick={() => save('breakPolicy', { enabled: true, paidBreakMin: num(breakPolicy.paidBreakMin, 10), restMaxMin: num(breakPolicy.restMaxMin, 20), longBreakMin: num(breakPolicy.longBreakMin, 75) }, 'CA paid breaks')}>Save</button>
      </PolicyCard>
    </div>
  );
}

function ErrorLine({ text, onRetry }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'hsl(var(--color-red))', padding: '10px 0' }}>
      <span style={{ flex: 1 }}>{text}</span>
      <button type="button" className="secondary-btn" style={{ fontSize: 12 }} onClick={onRetry}>Retry</button>
    </div>
  );
}
