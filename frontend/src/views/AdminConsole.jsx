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
  Settings2, ChevronRight, ChevronLeft, Tag, Shield,
  Headset, Bell, Mail, Building2, Timer,
  Activity, Signature, Check, Eye, X,
  Plus, Pencil, Trash2, Upload, GripVertical, MapPinned,
  Globe, Package, Search, Wrench, CalendarClock, ShieldCheck, Palette, FileCheck,
  Tags,
  Clock, Users, CloudRain, UserPlus, FileText, ClipboardList, ListChecks,
  MessageSquareText, MonitorDot,
  Sparkles,
  Warehouse,
  Target,
  Workflow,
  CalendarDays,
} from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import ModuleTabs from '../components/ModuleTabs';
import { ModalLoading, SkeletonBlocks, Spinner } from '../components/AsyncState';
import { useIsMobile } from '../lib/useIsMobile';
import UnsavedChangesPrompt from '../components/UnsavedChangesPrompt';
import SaveRow from '../components/SaveRow';
import { useDraft } from '../lib/useDraft';
import { GroupDirtyContext, useGroupDirty } from '../lib/groupDirty';
import { setInlineDirty } from '../lib/dialogGuard';
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
import IndiaContractorPolicySettings from '../components/IndiaContractorPolicySettings';
import { SwitchRow, NumberBox } from '../components/settings/SettingsUI';

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
const EmployeeCustomFieldsSettings = lazy(() => import('../components/EmployeeCustomFieldsSettings'));
// Probation (Oct 27 2026): the length, the reminder and the letters - a default, and each company's own.
const ProbationSettings = lazy(() => import('../components/HrProbation').then(m => ({ default: m.ProbationSettings })));
const WorkSiteLibrary = fromHR('WorkSiteLibrary');
// Roles & Access moved here whole (Pranshu, Sep 9) - was a People tab
// (HR.jsx's old 'hr-access' sub), now a top-level tab of Admin instead.
// `embedded` skips its own page header, since it gets one from the tab here.
const RolesAccess = lazy(() => import('./RolesAccess'));
const SettingsTools = lazy(() => import('./SettingsTools'));
const HrReminderSettings = lazy(() => import('../components/HrReminderSettings'));
const EquipmentReminderSettings = lazy(() => import('../components/EquipmentReminderSettings'));
const KbReminderSettings = lazy(() => import('../components/KbReminderSettings'));
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
const TimeOffReasons = fromShifts('TimeOffReasons');
// Phase 3 (Oct 23): settings that lived inside their module's working screens
// - the same components, borrowed from where they are owned.
const ReadinessThresholds = lazy(() => import('../components/PayrollReadiness').then(m => ({ default: m.ReadinessThresholds })));
const MinWageForm = lazy(() => import('../components/CaReview').then(m => ({ default: m.MinWageForm })));
// HR letters employees request from My HR (Oct 27 2026): which a company offers, their templates, the letterhead.
const HrLettersSettings = lazy(() => import('../components/HrLetters').then(m => ({ default: m.HrLettersSettings })));
const LeaveSetup = lazy(() => import('../components/LeaveBalances').then(m => ({ default: m.LeaveSetup })));
// Leave year end and Second Approval By HR (Oct 27 2026, components/LeaveYearEnd.jsx).
const fromLeaveYearEnd = lazyFrom(() => import('../components/LeaveYearEnd'));
const LeaveYearEndSettings = fromLeaveYearEnd('LeaveYearEndSettings');
const TimeOffApprovalSettings = fromLeaveYearEnd('TimeOffApprovalSettings');
const IntacctNightlySync = lazy(() => import('../components/IntacctEmployeeCodes').then(m => ({ default: m.IntacctNightlySync })));
const LetterheadsPanel = lazy(() => import('../components/DocumentTemplates').then(m => ({ default: m.LetterheadsPanel })));
// ...and the three that had no screen of their own (views/SettingsPanels.jsx).
const fromPanels = lazyFrom(() => import('./SettingsPanels'));
const TicketPropertyRulesPanel = fromPanels('TicketPropertyRulesPanel');
const UnitRulesPanel = fromPanels('UnitRulesPanel');
const AppRatingsPanel = fromPanels('AppRatingsPanel');
// Weather Alerts (Weather Call, Oct 2026): the per-company switch and the rain thresholds.
const WeatherSettingsPanel = lazy(() => import('../components/shifts/WeatherSettings'));
// Operations (Oct 21 2026): the Push to Cubby switch, OFF by default.
const OpsSettingsPanel = lazy(() => import('../operations/OpsSettings'));
// Cubby tasks in Nexus Tasks (Neil, Oct 30 2026): the switches and the facility -> project map.
const CubbyTasksSettingsPanel = lazy(() => import('../operations/CubbyTasksSettings'));
// Performance (Oct 27 2026): the goal and 1:1 reminders, layered per company.
const PerformanceReminderSettings = lazy(() => import('../performance/PerformanceSettings').then(m => ({ default: m.PerformanceReminderSettings })));
// Workflows (Oct 28 2026): the switches, ceilings, digest and pause - layered per company.
const WorkflowsSettingsPanel = lazy(() => import('../workflows/WorkflowsSettings').then(m => ({ default: m.WorkflowsSettings })));
// Holiday Policies (Oct 29 2026): the org face of the company holiday calendars.
const HolidayPoliciesPanel = lazy(() => import('../holidays/HolidayPoliciesPanel'));
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
// desc is one line (Oct 25): each group card says the rest.
const SUBJECTS = [
  { key: 'companies', section: 'org', wide: true,  label: 'Companies',           Icon: Building2, faces: 'both',
    desc: 'Each legal entity: its profile, managers, departments and holiday calendar.' },
  { key: 'locations', section: 'org', wide: true,  label: 'Locations',           Icon: MapPinned, faces: 'both',
    desc: 'Where people punch in, and each location\'s geofence.' },
  { key: 'access', section: 'org', wide: true,     label: 'People & Access',     Icon: Shield, faces: 'both',
    desc: 'Who can open which module, access groups and roles.' },
  { key: 'security', section: 'org',   label: 'Security',            Icon: ShieldCheck, faces: 'org',
    desc: 'How people sign in, how long sessions last and the policy everyone accepts.' },
  { key: 'branding', section: 'org',   label: 'Branding & Email',    Icon: Palette, faces: 'both',
    desc: 'The brand color, how emails look, signatures and letterheads.' },
  { key: 'emails', section: 'comms',     label: 'Emails & Reminders',  Icon: Mail, faces: 'org',
    desc: 'Every scheduled email and how early reminders go out.' },
  { key: 'tickets', section: 'comms', wide: true,    label: 'Tickets',             Icon: Headset, faces: 'both',
    desc: 'Where tickets go, who works them and how fast.' },
  // Time Clock pay rules (Charmi, Sep 30): moved off the timecard's Options popover.
  { key: 'pay', section: 'work',        label: 'Time & Pay',          Icon: Clock, faces: 'both',
    desc: 'The rules every time sheet and payroll run follow.' },
  { key: 'analytics', section: 'work',  label: 'Workforce Analytics', Icon: MonitorDot, faces: 'both',
    desc: 'App ratings, the location trail and what each company captures.' },
  { key: 'shifts', section: 'work',     label: 'Shifts & Scheduling', Icon: CalendarClock, faces: 'both',
    desc: 'What staff may request and see, attendance, overtime, rules and sharing.' },
  { key: 'hiring', section: 'work',     label: 'Hiring & Onboarding', Icon: UserPlus, faces: 'both',
    desc: 'Hiring documents, interview questions, onboarding checklists and probation.' },
  { key: 'items', section: 'ops',      label: 'Items & Equipment',   Icon: Package, faces: 'org',
    desc: 'The catalog options used when adding items.' },
  { key: 'operations', section: 'ops', label: 'Operations',          Icon: Warehouse, faces: 'org',
    desc: 'How the storage facilities screens work with Cubby.' },
  // Performance (Oct 27 2026): goals and 1:1s - Workday > Performance.
  { key: 'performance', section: 'work', label: 'Performance',         Icon: Target, faces: 'both',
    desc: 'Goal and 1:1 reminders, the review rating scale and the company values.' },
  // Workflows (Oct 28 2026): the one cross-module automation engine.
  { key: 'workflows', section: 'ops', label: 'Workflows',           Icon: Workflow, faces: 'both',
    desc: 'Automations across every module: the switches, the ceilings and the owner digest.' },
];
const SUBJECT_KEYS = new Set(SUBJECTS.map(s => s.key));
// The rail's four sections (Oct 25). `wide` subjects (whole screens: the
// company pages, the Location Library, People & Access, the Ticket Manager)
// use the full width; the rest read in a column (Pranshu, Sep 9: the big
// embedded panels must not be squeezed).
const SUBJECT_SECTIONS = [
  { key: 'org', label: 'Organization' },
  { key: 'comms', label: 'Communication' },
  { key: 'work', label: 'Workforce' },
  { key: 'ops', label: 'Operations' },
];
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
// needs: who may open the group - what its save route demands, declared once
// here so the shell shows nothing the server would refuse (see mayOpen).
// face: which scope the group shows under ('org' = Every company, 'company'
// = with a company picked, 'both' = either - the panel takes the company
// from the scope). A company-only group asked for at "Every company"
// renders as a company picker.
const GROUPS = [
  // Companies
  { id: 'company-list', subject: 'companies', face: 'org', scope: 'org', icon: Building2, title: 'Companies',
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true, anyScope: true },
    sub: 'Every legal entity, and the group manager above them all. Open a company to set its profile, departments and holiday calendar.',
    keywords: 'company companies legal entity add company group manager escalation list' },
  { id: 'company-profile', subject: 'companies', face: 'company', scope: 'company', icon: Building2, title: 'Company',
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'Profile and logo, managers and HR contact, contractor invoice recipients, email domains, departments and their heads, and the holiday calendar.',
    keywords: 'company profile legal name country tax id ein gstin signatory manager hr contact invoice recipients address phone logo social links email domains notes departments department head holiday calendar holidays weather calls rain' },
  // Holiday policies (Neil, Oct 29 2026): named holiday sets applied to one or
  // more companies; each company's Holiday Calendar can skip or change one.
  { id: 'holiday-policies', subject: 'companies', face: 'org', scope: 'org', icon: CalendarDays, title: 'Holiday Policies',
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'Named sets of holidays and how weekend holidays are observed, applied to one or more companies. A company can skip or change any holiday for itself.',
    keywords: 'holidays holiday policy calendar federal presidents day independence day weekend observed india gazetted restricted diwali apply companies' },
  // Locations
  { id: 'work-sites', subject: 'locations', face: 'org', scope: 'org', icon: MapPinned, title: 'Location Library',
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'Every location employees can punch in at, with its geofence. Pick the companies that use each one right here, or with a company picked.',
    keywords: 'geofence location address time clock punch map work site' },
  { id: 'company-sites', subject: 'locations', face: 'company', scope: 'company', icon: MapPinned, title: 'Locations',
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'The locations this company\'s people punch in at, picked from the library.',
    keywords: 'company locations work sites geofence punch' },
  // People & Access
  // Rendered whole (not in a card): it is a full screen of its own.
  { id: 'access', subject: 'access', face: 'org', scope: 'org', icon: Shield, title: 'People & Access Groups',
    needs: { role: 'administrator' },
    sub: 'Each person\'s effective access, access groups that add modules on top of a job role, the roles shared by every company, and the full access matrix.',
    keywords: 'roles permissions people groups modules grant level viewer editor owner matrix audit walls shared roles' },
  { id: 'company-roles', subject: 'access', face: 'company', scope: 'company', icon: Shield, title: 'Roles',
    needs: { role: 'administrator' },
    sub: 'This company\'s job roles, grouped by department, with what each one opens and the checklist steps it adds.',
    keywords: 'job roles company roles department access checklists' },
  // More Details (Neil, Oct 27 2026): HR's own fields on employee records -
  // every company's at Every company, a company's own with it picked.
  { id: 'employee-custom-fields', subject: 'access', face: 'both', scope: 'org', icon: ListChecks, title: 'More Details Fields', flush: true,
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'Extra fields on employee records - text, number, date, dropdown or checkbox - and who sees each: HR only, or the employee too. Archiving hides a field and keeps its values.',
    keywords: 'custom fields more details employee record extra field dropdown checkbox hr only employee can see employee can edit required archive merge variable documents' },
  // Security
  { id: 'sign-in-sessions', subject: 'security', face: 'org', scope: 'org', icon: ShieldCheck, title: 'Sign-In & Sessions',
    needs: { role: 'administrator' },
    sub: 'How long web, Act As and Credentials sessions last, and guest sign-in codes.',
    keywords: 'session timeout idle act as vault unlock guest partner code lockout invite security' },
  { id: 'signin-policy', subject: 'security', face: 'org', scope: 'org', icon: FileCheck, title: 'Sign-In Policy',
    needs: { role: 'administrator' },
    sub: 'The company policies and monitoring disclosure everyone accepts at sign-in, and who has not accepted the current version.',
    keywords: 'policy terms monitoring disclosure acknowledgment accept consent version publish report' },
  // Branding & Email
  { id: 'brand-color', subject: 'branding', face: 'org', scope: 'org', icon: Palette, title: 'Brand Color',
    needs: { role: 'administrator' },
    sub: 'The accent color used across Nexus and on the sign-in screen.',
    keywords: 'accent theme green blue login color' },
  { id: 'email-appearance', subject: 'branding', face: 'org', scope: 'org', icon: Mail, title: 'Email Appearance',
    needs: { role: 'administrator' },
    sub: 'One logo, accent color and footer for every email Nexus sends: tasks, tickets, Nexus Sign, invitations and welcome emails.',
    keywords: 'email template logo header footer accent color address preview notifications' },
  { id: 'letterheads', subject: 'branding', face: 'org', scope: 'org', icon: FileText, title: 'Letterheads',
    needs: { role: 'administrator' },
    sub: 'The letterheads documents and letters print on, and which one is the default.',
    keywords: 'letterhead logo address default documents templates print' },
  { id: 'email-signature', subject: 'branding', face: 'both', scope: 'company', icon: Signature, title: 'Email Signature',
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'Choose each company\'s signature template and set custom signatures for specific addresses. Names, titles and contact details come from each employee\'s directory record, and employees choose their own sign-off in Profile.',
    keywords: 'template sign-off logo sender override shared inbox branding' },
  // Emails & Reminders
  { id: 'task-notifications', subject: 'emails', face: 'org', scope: 'org', icon: Bell, title: 'Task Notifications',
    needs: { role: 'manager' },
    sub: 'The mailbox task emails come from, due-date reminders, how updates are batched into one email, and how email replies are posted.',
    keywords: 'email mailbox reminders overdue batch replies delivery log tasks notifications' },
  { id: 'daily-briefing', subject: 'emails', face: 'org', scope: 'org', icon: Mail, title: 'Daily Briefing',
    needs: { role: 'administrator' },
    sub: 'A daily summary email for each employee. Send it to everyone, or to a few test recipients first.',
    keywords: 'digest summary email morning test recipients' },
  { id: 'weekly-digest', subject: 'emails', face: 'org', scope: 'org', icon: Mail, title: 'Weekly Digest',
    needs: { role: 'administrator' },
    sub: "A Monday email listing each employee's overdue tasks with their due dates, sent before their shift. Send it to everyone, or to a few test recipients first.",
    keywords: 'weekly digest summary email overdue tasks due dates extend monday shift test recipients' },
  { id: 'workforce-scorecard', subject: 'emails', face: 'org', scope: 'org', icon: Mail, title: 'Workforce Scorecard',
    needs: { role: 'administrator' },
    sub: 'A weekly email to managers scoring each hourly person\'s punched hours against their expected hours (US 8h, India 9h, or their shift) - who worked, who was short, who was absent.',
    keywords: 'workforce analytics scorecard attendance hours expected worked absent late weekly manager email shift standard day india hourly test recipients' },
  { id: 'hr-reminders', subject: 'emails', face: 'org', scope: 'org', icon: CalendarClock, title: 'HR & Compliance Reminders',
    needs: { role: 'administrator', grant: ['hr', 'full'] },
    sub: 'Choose how many days ahead HR is warned about visa and right-to-work expiry, contract ends, new starters, expiring documents and unsigned signature requests.',
    keywords: 'hr people visa right to work immigration expiry expiring contract end new starter onboarding document compliance e-sign signature chase nudge reminder days before alerts timing bell' },
  { id: 'equipment-reminders', subject: 'emails', face: 'org', scope: 'org', icon: CalendarClock, title: 'Equipment Reminders',
    needs: { role: 'administrator', grant: ['inventory', 'full'] },
    sub: 'Chase items that are checked out past their due date, and choose how early asset managers are warned about warranties, inspections, registration, insurance and service.',
    keywords: 'items inventory checkout overdue return late borrower asset property vehicle equipment warranty inspection registration insurance service manager reminder days before alerts timing bell' },
  { id: 'kb-reminders', subject: 'emails', face: 'org', scope: 'org', icon: CalendarClock, title: 'Training Reminders',
    needs: { role: 'administrator', grant: ['sop', 'full'] },
    sub: 'Turn the Knowledge Base training reminders, policy-signing reminders and Monday digests on or off, or keep them in the notification bell without an email.',
    keywords: 'knowledge base kb sop training course policy sign acknowledge overdue due reminder digest manager owner email bell off' },
  // Tickets - one group, seven tabs (Pranshu, Sep 26: routing, ticket email
  // and SLAs are one subject to an admin).
  { id: 'service-desk', subject: 'tickets', face: 'both', scope: 'org', icon: Headset, title: 'Ticket Manager',
    needs: { role: 'manager' },
    sub: 'Everything about tickets: who receives and escalates them, which events send email, and the response targets and ticket types requesters choose from.',
    keywords: 'tickets agents routing queue departments escalation notifications email mailbox cc reply-to auto-close delivery log sla priority hours response types intake questions fields help topics what do you need help with saved replies canned responses default assignee auto assign ai summary suggested help topic' },
  { id: 'ticket-property-rules', subject: 'tickets', face: 'org', scope: 'org', icon: MapPinned, title: 'Property Rules',
    needs: { role: 'administrator', grant: ['tickets', 'full'] },
    sub: 'Which tickets must name the property they are about, by service area and by help topic.',
    keywords: 'property tickets required service area help topic facility unit link suggest' },
  // Time & Pay
  { id: 'timeclock-policy', subject: 'pay', face: 'both', scope: 'layered', icon: CalendarClock, title: 'Pay Rules', flush: true,
    needs: { role: 'administrator' },
    sub: 'Punch rounding (off by default), the auto-lunch deduction and California paid rest breaks - the default for every time sheet, and each company\'s own.',
    keywords: 'time clock punch rounding nearest minutes swipeclock auto lunch deduction meal break paid rest break california time sheet' },
  { id: 'payroll-export-codes', subject: 'pay', face: 'both', scope: 'company', icon: FileText, title: 'Payroll Export Codes',
    needs: { role: 'administrator' },
    sub: 'The payroll item name each pay class carries in the QuickBooks IIF and the Intacct payroll memo, and the QuickBooks company name, per company.',
    keywords: 'payroll export codes earnings codes payroll items quickbooks iif intacct memo company name pay class' },
  { id: 'pay-premiums', subject: 'pay', face: 'both', scope: 'company', icon: Clock, title: 'Shift Differentials & Call-Back Pay',
    needs: { role: 'administrator' },
    sub: 'Extra pay per hour at night, on weekends or at certain sites, and a minimum paid time when someone is called back - per company, off by default.',
    keywords: 'shift differential night weekend site premium call-back callback minimum paid hours hourly' },
  // India Contractor Work Hours and Extra Time Policy (Neil, Oct 27 2026).
  { id: 'india-contractor-policy', subject: 'pay', face: 'both', scope: 'layered', icon: CalendarClock, title: 'India Contractor Policy', flush: true,
    needs: { role: 'administrator' },
    sub: 'How contractors on monthly pay in India are paid: credits by hours worked, the month-end reconciliation and Extra Time at 1.35x - per company, with the month it starts from.',
    keywords: 'india contractor policy extra time 1.35 reconciliation pool half day full day credit weekend pay monthly fee fixed salary policy starts november' },
  { id: 'payroll-readiness', subject: 'pay', face: 'both', scope: 'layered', icon: ClipboardList, title: 'Payroll Readiness', flush: true,
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'What counts as a big change or an unusual week when checking who is ready for payroll - a default, and each company\'s own.',
    keywords: 'payroll readiness thresholds percent hours big change unusual week export check flags' },
  { id: 'ca-min-wage', subject: 'pay', face: 'org', scope: 'org', icon: Clock, title: 'California Minimum Wage',
    needs: { role: 'administrator', grant: ['hr', 'full'], people: true },
    sub: 'The state minimum wage the California review checks pay rates against; it also prices the split-shift premium.',
    keywords: 'california minimum wage ca review split shift premium pay rate' },
  { id: 'leave-policies', subject: 'pay', face: 'org', scope: 'org', icon: CalendarClock, title: 'Leave Policies',
    needs: { role: 'administrator', grant: ['hr', 'full'] },
    sub: 'The vacation and sick policies people are assigned - hours earned per hour worked, caps and carry-over.',
    keywords: 'leave policies vacation sick accrual balance hours earned per hour start date cutover pto carry over' },
  { id: 'time-off-reasons', subject: 'pay', face: 'both', scope: 'layered', icon: CalendarClock, title: 'Time-Off Reasons',
    needs: { role: 'manager', grant: ['hr', 'editor'], people: true },
    sub: 'The reasons staff can pick when requesting time off, beyond the built-in Vacation, Sick, Personal, Unpaid, 1/2 Day and Other.',
    keywords: 'time off reasons request jury duty bereavement custom' },
  { id: 'leave-year-end', subject: 'pay', face: 'both', scope: 'layered', icon: CalendarClock, title: 'Leave Year-End', flush: true,
    needs: { role: 'administrator', grant: ['hr', 'full'] },
    sub: 'What happens to unused vacation and sick time when the leave year ends - Use It Or Lose It by default, or carry everything or up to a cap. California vacation never expires (required by law).',
    keywords: 'leave year end carry over carryover rollover cap use it or lose it expire forfeit vacation sick pto anniversary calendar california labor code 227.3' },
  { id: 'timeoff-approval', subject: 'pay', face: 'both', scope: 'layered', icon: CalendarClock, title: 'Time-Off Approval', flush: true,
    needs: { role: 'administrator', grant: ['hr', 'full'] },
    sub: 'Whether a time-off request needs HR\'s approval after the manager\'s - per company, off by default.',
    keywords: 'time off approval second approval by hr two level manager leave request awaiting hr' },
  { id: 'intacct-nightly', subject: 'pay', face: 'both', scope: 'company', icon: FileText, title: 'Intacct Nightly Sync',
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'Which companies have their employee codes filled in from Intacct once a night, and how the last run went.',
    keywords: 'intacct employee codes nightly sync automatic payroll' },
  // Workforce Analytics
  { id: 'app-ratings', subject: 'analytics', face: 'org', scope: 'org', icon: MonitorDot, title: 'App & Website Ratings',
    needs: { role: 'manager', grant: [['hr', 'editor'], ['employee-tracking', 'full']] },
    sub: 'Every application and website seen on company computers, rated productive, neutral or unproductive - the split the Workforce Analytics dashboard shows.',
    keywords: 'apps websites ratings productive neutral unproductive workforce analytics activity' },
  // Moved out of Shift Settings (Oct 25): managers see the trail in Workforce Analytics.
  { id: 'location-trail', subject: 'analytics', face: 'both', scope: 'layered', icon: MapPinned, title: 'Location Trail', part: 'trail', flush: true,
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'Share each person\'s location while they are clocked in, for managers in Workforce Analytics. Off unless turned on.',
    keywords: 'location trail gps clocked in live position map workforce analytics privacy shifts' },
  { id: 'company-policy', subject: 'analytics', face: 'company', scope: 'company', icon: MonitorDot, title: 'Workforce Analytics Policy',
    needs: { role: 'administrator', grant: ['employee-tracking', 'full'] },
    sub: 'Whether work on company computers is captured for this company, how often, and what is tracked.',
    keywords: 'workforce analytics monitoring policy capture screenshots interval tracking employee tracking' },
  // Shifts & Scheduling
  // The shift settings are one record shown as several groups (Oct 25: one
  // long card was hard to scan); `part` is the slice ShiftSettingsPanel
  // shows. 'shift-settings' keeps its id so old links still land.
  { id: 'shift-settings', subject: 'shifts', face: 'both', scope: 'layered', icon: CalendarClock, title: 'Schedule Basics', part: 'basics', flush: true,
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'The team time zone, the day each schedule week starts on, and the grace before a start counts as late.',
    keywords: 'shifts schedule shift settings time zone week start sunday monday default grace late' },
  { id: 'shift-requests', subject: 'shifts', face: 'both', scope: 'layered', icon: Users, title: 'Requests & Visibility', part: 'requests', flush: true,
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'What staff may request - open shifts, swaps, offers, time off, releasing a shift - and what they see of their teammates.',
    keywords: 'shifts requests swap offer open shift time off release pool across teams visibility teammates notes reasons' },
  { id: 'shift-attendance', subject: 'shifts', face: 'both', scope: 'layered', icon: Clock, title: 'Attendance',
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    part: 'attendance', flush: true, sub: 'No-show and left-early alerts, escalating unapproved time sheets, and the break and meal reminders.',
    keywords: 'attendance no-show no show left early escalate unapproved time sheets break reminder meal reminder california usual hours' },
  { id: 'shift-overtime-alerts', subject: 'shifts', face: 'both', scope: 'layered', icon: Bell, title: 'Overtime Alerts', part: 'overtime', flush: true,
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'Warn managers before someone who is clocked in reaches daily or weekly overtime.',
    keywords: 'overtime alerts warning daily weekly managers clocked in' },
  { id: 'shift-rules', subject: 'shifts', face: 'both', scope: 'layered', icon: ListChecks, title: 'Rules', part: 'rules', flush: true,
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'Rest between shifts, days in a row, overtime and weekly hours - warnings on the schedule, never blocks - and the reason to share past them.',
    keywords: 'shift rules rest days in a row daily overtime weekly overtime most hours week warnings share publish reason' },
  { id: 'shift-sharing', subject: 'shifts', face: 'both', scope: 'layered', icon: CalendarClock, title: 'Sharing', part: 'sharing', flush: true,
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'Shared shifts on people\'s Outlook calendars, and asking people to confirm a shared schedule.',
    keywords: 'sharing outlook calendar free busy confirm schedule share' },
  { id: 'shift-types', subject: 'shifts', face: 'both', scope: 'layered', icon: Clock, title: 'Shift Types',
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'The reusable shifts managers place with one click - name, code, color, times, time zone and days. A person\'s usual hours are one of these.',
    keywords: 'shifts presets shift type code color times usual hours grace break time zone days' },
  { id: 'shift-groups', subject: 'shifts', face: 'both', scope: 'layered', icon: Users, title: 'Groups',
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'Who is scheduled together, the order they appear in, who may build each group\'s schedule, and the Teams chat its BOD / EOD messages go to.',
    keywords: 'shifts groups teams members schedulers order teams chat bod eod' },
  { id: 'shift-weather', subject: 'shifts', face: 'both', scope: 'company', icon: CloudRain, title: 'Weather Alerts',
    needs: { role: 'administrator', grant: ['hr', 'editor'], wide: true },
    sub: 'Which companies the weather watch runs for, what counts as major rain, quiet hours, and the heads-up line in Teams. Nexus advises; a manager makes the weather call.',
    keywords: 'weather rain forecast alerts advisory storm thunderstorm warning nws quiet hours deciders weather call' },
  // Hiring & Onboarding
  { id: 'hiring-documents', subject: 'hiring', face: 'both', scope: 'company', icon: FileText, title: 'Hiring Documents',
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'Offer letters, hiring packets, promotion letters and separation packages: which documents each company sends, for which roles and kind of hire, who signs, and Ready To Send.',
    keywords: 'packets offer letter hiring packet promotion separation nda confidentiality agreement documents signers' },
  { id: 'interview-questionnaires', subject: 'hiring', face: 'org', scope: 'org', icon: ClipboardList, title: 'Interview Questionnaires',
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'The questions asked in each role\'s interview - the Interview Room shows them to the interviewer.',
    keywords: 'questions interview questionnaire role character competence availability' },
  // Neil, Oct 19: "copy from company or have a common library".
  { id: 'checklist-library', subject: 'hiring', face: 'org', scope: 'layered', icon: ListChecks, title: 'Checklist Library',
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'The steps every new onboarding, promotion, offboarding and leave checklist starts with, whatever the role, and who does each step (the head and backup of the HR, IT and Accounting departments). Each company adds its own with the company picked, and each role its own (People & Access > the company > Roles > a role > Checklists).',
    keywords: 'checklist onboarding promotion offboarding leave steps template library owners copy standardize' },
  { id: 'probation', subject: 'hiring', face: 'both', scope: 'layered', icon: CalendarClock, title: 'Probation', flush: true,
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'How long new hires are on probation, when the manager and the HR contact are reminded before it ends, and the confirmation and extension letters the employee signs.',
    keywords: 'probation length months reminder confirmation extension letter end employment new hire trial period' },
  { id: 'company-checklists', subject: 'hiring', face: 'company', scope: 'company', icon: ListChecks, title: 'Checklists',
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'This company\'s baseline steps, which departments own steps, and the steps its onboarding, promotion, offboarding and leave checklists add, role by role.',
    keywords: 'company checklists baseline onboarding promotion offboarding leave steps departments owners roles missing' },
  // HR letters (Neil, Oct 27 2026): an organization default a company may override.
  { id: 'hr-letters', subject: 'hiring', face: 'both', scope: 'layered', icon: FileText, title: 'HR Letters',
    needs: { role: 'administrator', grant: ['hr', 'editor'], people: true },
    sub: 'The letters employees request from My HR - employment verification, salary certificate, experience letter, address proof, visa NOC: which ones a company offers, the Documents template each prints from, and the letterhead.',
    keywords: 'hr letters employment verification salary certificate experience letter address proof visa noc no objection certificate request my hr template letterhead signatory' },
  // Items & Equipment
  { id: 'item-types', subject: 'items', face: 'org', scope: 'org', icon: Tag, title: 'Item Types & Custom Fields',
    needs: { role: 'manager', grant: ['inventory', 'editor'] },
    sub: 'The item types and extra fields available to everyone when adding or editing items.',
    keywords: 'inventory equipment catalog fields types' },
  // Operations
  { id: 'ops-cubby-push', subject: 'operations', face: 'org', scope: 'org', icon: Warehouse, title: 'Push to Cubby',
    needs: { role: 'administrator', grant: ['operations', 'full'] },
    sub: 'Off by default: Nexus only reads from Cubby and staff mark changes Entered in Cubby. On: approved rate and rent changes can be pushed to Cubby from Nexus.',
    keywords: 'cubby push sync write rates rent ecri rate management revenue management storage facilities operations locked switch' },
  { id: 'ops-cubby-tasks', subject: 'operations', face: 'org', scope: 'org', icon: Warehouse, title: 'Cubby Tasks',
    needs: { role: 'administrator', grant: ['operations', 'full'] },
    sub: 'Cubby\'s tasks come into Nexus Tasks after each Cubby sync - each facility\'s into the project you pick here, tasks assigned to people to those people. Completing one in Nexus can complete it in Cubby, behind its own switch.',
    keywords: 'cubby tasks sync facility project map assignee operations to-do workload close complete switch' },
  { id: 'ops-unit-rules', subject: 'operations', face: 'org', scope: 'org', icon: Warehouse, title: 'Unit Rules',
    needs: { role: 'manager', grant: ['operations', 'editor'] },
    sub: 'Which Cubby unit types are mailboxes, and which records are not units at all, by the words in the unit type name.',
    keywords: 'unit types mailbox excluded words cubby facility operations units' },
  // Performance
  // Performance (made simple, Oct 29 2026): one group. Reviews have one
  // 4-word rating and no values, so the scale and values groups are gone.
  // The save route needs HR for the company - a FULL hr grant, not Editor.
  { id: 'performance-reminders', subject: 'performance', face: 'both', scope: 'layered', icon: CalendarClock, title: 'Performance Reminders', flush: true,
    needs: { role: 'administrator', grant: ['hr', 'full'], people: true },
    sub: 'How long a goal kept by hand may go without an update before its owner is reminded, and the reminder the day before a 1:1 with an empty agenda. Review reminders go out by themselves.',
    keywords: 'performance goals check-in reminder one on one 1:1 agenda review rating okr objectives' },
  // Workflows
  { id: 'workflows-config', subject: 'workflows', face: 'both', scope: 'layered', icon: Workflow, title: 'Workflow Settings', flush: true,
    needs: { role: 'administrator', grant: ['workflows', 'full'] },
    sub: 'Whether workflows run for a company, the per-hour and recipient ceilings, the weekly owner digest, and the organization-wide pause.',
    keywords: 'workflows automation pause switch ceilings digest webhooks' },
];
const GROUP_META = Object.fromEntries(GROUPS.map(g => [g.id, g]));

// Who may open a group (Oct 23): each group's `needs` says what its save
// route demands, so the rail, the filter and the page show nothing the
// server would answer 403 to - in one place, instead of a different
// read-only note or hidden button in every panel (those stay as the
// backstop where a panel has one, such as Sign-In & Sessions, which opens
// for an IT Admin but saves only for a Global Admin).
//   role     the role tier that passes outright: 'manager', 'administrator'
//            (IT Admin) or 'owner' (Global Admin)
//   grant    [module, level], or a list of them: an Access Group grant that
//            passes below that tier (canAccessModule)
//   people   a People (/hr) route: the manager tier, which sees only its own
//            team, never passes; a caller whose People access is limited to
//            some companies opens the group with one of those companies
//            picked - at "Every company" the library, the shared records and
//            the tenant default need company-wide access (`anyScope` lets
//            the company list through, since it is how they reach theirs)
//   wide     needs company-wide People access at every scope
// Without `needs`, administrators only. `company` is the picked company's
// id, '' for "Every company", or undefined to ask whether it opens anywhere.
function mayOpen(g, { can, canAccessModule, hrScope, hrTeam }, company) {
  const n = g.needs || { role: 'administrator' };
  const grants = n.grant ? (Array.isArray(n.grant[0]) ? n.grant : [n.grant]) : [];
  if (!can(n.role) && !grants.some(([m, l]) => canAccessModule?.(m, n.role, l))) return false;
  if (!n.people && !n.wide) return true;
  if (hrTeam) return false;
  const limited = Array.isArray(hrScope);
  if (!limited) return true;
  if (n.wide) return false;
  if (company === undefined) return true;
  return company ? hrScope.includes(company) : !!n.anyScope;
}

// Every word typed has to appear somewhere in the group's title,
// description, keywords or subject name.
function groupMatches(g, needle) {
  const subject = SUBJECTS.find(s => s.key === g.subject)?.label || '';
  const hay = `${g.title} ${g.sub} ${g.keywords} ${subject}`.toLowerCase();
  return needle.split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

// What a group's scope chip says. `company` is the picked company's name
// ('' at "Every company"); `override` is what a layered panel reported
// (true: the company has its own; false: inherited; undefined: unknown).
function scopeLabel(scope, company, override) {
  if (company) {
    // A per-company setting has no default to inherit: it is the company's
    // own (Custom) or still the built-in one (Default).
    if (override === true) return scope === 'company' ? 'Custom' : 'Overridden';
    if (override === false) return scope === 'company' ? 'Default' : 'Inherited';
    return company;
  }
  if (scope === 'company') return 'Per Company';
  if (scope === 'layered') return 'All Companies · Overridable';
  return 'All Companies';
}

// Where a group's value comes from, as a quiet badge; orange when the picked
// company has its own.
function ScopeChip({ scope, company, override }) {
  const own = !!company && override === true;
  const title = company && override === false ? `${company} follows the default${scope === 'company' ? '' : ' for every company'}` : undefined;
  return <span className={`nx-set-badge${own ? ' is-own' : ''}`} title={title}>{scopeLabel(scope, company, override)}</span>;
}

// A setting group (Oct 25 2026): its title and description as a heading, and
// its controls on one card under it - always open (Neil, Oct 23: nothing
// behind a click). `bare` drops the heading for a subject's lone group (the
// subject header already names it); `flush` lets a panel built of rows
// (SettingsUI) run edge to edge; `highlight` marks the group a link pointed
// at (sub '<subject>:<group>'). The title takes focus on a jump.
function Group({ id, title, sub, scope, company, override, bare = false, flush = false, highlight = false, footer = null, children }) {
  const ref = useRef(null);
  // A link to a group lands on it - and stays on it while the panels above
  // finish loading and push it down (they are lazy), until the person
  // scrolls, types or clicks themselves, or two seconds pass.
  useEffect(() => {
    const el = ref.current;
    if (!highlight || !el) return undefined;
    let done = false;
    let ours = false;   // a scroll this effect caused, not the person
    const land = () => {
      ours = true;
      el.scrollIntoView?.({ block: 'start' });
      requestAnimationFrame(() => { ours = false; });
    };
    land();
    const quit = () => { done = true; };
    const onScroll = () => { if (!ours) done = true; };   // a scrollbar drag fires no mousedown
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    events.forEach(e => window.addEventListener(e, quit, { passive: true }));
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (!done) land(); }) : null;
    ro?.observe(el.closest('.nx-set-main') || document.body);
    const t = setTimeout(quit, 2000);
    return () => {
      ro?.disconnect(); clearTimeout(t);
      events.forEach(e => window.removeEventListener(e, quit));
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [highlight]);
  if (bare) {
    return (
      <div id={`setting-${id}`} ref={ref} className="nx-set-group">
        <div className={`nx-set-group-body${flush ? ' is-flush' : ''}`}>{children}{footer}</div>
      </div>
    );
  }
  return (
    <section id={`setting-${id}`} ref={ref} aria-label={title} data-highlight={highlight ? 'true' : undefined}
      className={`nx-set-group${highlight ? ' is-highlight' : ''}`}>
      <div className="nx-set-group-head">
        <div className="nx-set-group-head-text">
          <h4 tabIndex={-1}>{title}</h4>
          {sub && <p>{sub}</p>}
        </div>
        <ScopeChip scope={scope} company={company} override={override} />
      </div>
      <div className={`nx-set-group-body${flush ? ' is-flush' : ''}`}>{children}{footer}</div>
    </section>
  );
}

// ── Where each company stands (Oct 25: one company picker, not four) ─────
// A per-company setting at "Every company" lists the companies with where
// each one stands, instead of a company select inside its panel; a layered
// setting names the companies that keep their own under the default. Either
// way, picking a company switches the page's Scope. One loader per group,
// module-level so its identity never changes; `own` = differs from the
// default (or, per company, from the built-in).
const ownState = (own) => ({ own, label: own ? 'Own Settings' : 'Default' });
const COMPANY_STATE = {
  'payroll-export-codes': (cid) => api.timeExportCodesGet(cid).then((d) => {
    const own = (d?.classes || []).some(c => c.custom) || !!d?.quickbooksCompanyName;
    return { own, label: own ? 'Own Codes' : 'Default Codes' };
  }),
  'pay-premiums': (cid) => api.timePremiumsGet(cid).then((d) => {
    if (!d?.enabled) return { own: false, label: 'Off' };
    const n = (d.differentials || []).length;
    const parts = [`${n} ${n === 1 ? 'Differential' : 'Differentials'}`];
    if (d.callBack?.enabled) parts.push('Call-Back Pay');
    return { own: true, label: `On · ${parts.join(' · ')}` };
  }),
  'timeclock-policy': (cid) => Promise.all([api.timeRoundingGet(cid), api.timeAutoLunchGet(cid), api.timeBreakPolicyGet(cid)])
    .then(rules => ownState(rules.some(r => r?.hasOverride))),
  'payroll-readiness': (cid) => api.payrollReadinessSettings(cid).then(m => ownState(!!m?.override)),
  'time-off-reasons': (cid) => api.timeOffTypes(cid).then(r => ownState(!!r?.hasOverride)),
  'probation': (cid) => api.probationSettings(cid).then(r => ownState(!!r?.override)),
  'leave-year-end': (cid) => api.leaveYearEndSettings(cid).then(r => ownState(!!r?.hasOverride)),
  'timeoff-approval': (cid) => api.timeOffApprovalGet(cid).then(r => ownState(!!r?.hasOverride)),
  'shift-settings': (cid) => api.shiftRequestSettingsGetFor(cid).then(r => ownState(!!r?.hasOverride)),
  'hr-letters': (cid) => api.hrLetterSettings(cid).then(r => ownState(!!r?.hasOverride)),
  'performance-reminders': (cid) => api.perfSettings(cid).then(m => ownState(!!m?.override)),
  'india-contractor-policy': (cid) => api.timeIndiaPolicyGet(cid).then(r => ownState(!!r?.hasOverride)),
  'workflows-config': (cid) => api.wfSettings(cid).then(m => ownState(!!m?.override)),
};
// What the layered footer says before the names.
const OWN_LINE = { 'shift-settings': 'Companies with shift settings of their own:' };
// Two companies at a time per group: a subject of several groups at "Every
// company" must not fire every company's loads at once.
const STATE_POOL = 2;

function useCompanyStates(entities, stateOf) {
  const [states, setStates] = useState({});
  useEffect(() => {
    if (!stateOf) return undefined;
    let live = true;
    let i = 0;
    setStates({});
    const next = () => {
      if (!live || i >= entities.length) return Promise.resolve();
      const en = entities[i++];
      return Promise.resolve().then(() => stateOf(en.id))
        .then(st => { if (live) setStates(m => ({ ...m, [en.id]: st })); },
          () => { if (live) setStates(m => ({ ...m, [en.id]: { own: false, label: 'Could Not Load', failed: true } })); })
        .then(next);
    };
    for (let k = 0; k < STATE_POOL; k++) next();
    return () => { live = false; };
  }, [entities, stateOf]);
  return states;
}

// The companies as a list to open; with `stateOf`, each says where it stands.
function CompanyStates({ entities, stateOf = null, onPick, lead = 'Set per company. Open one to change it.' }) {
  const states = useCompanyStates(entities, stateOf);
  if (entities.length === 0) return <div className="nx-set-note" style={{ borderTop: 'none' }}>No companies yet - add one under Companies first.</div>;
  return (
    <>
      <div className="nx-set-note" style={{ borderTop: 'none', borderBottom: '1px solid var(--line)' }}>{lead}</div>
      <div className="nx-set-list">
        {entities.map(en => {
          const st = states[en.id];
          return (
            <button key={en.id} type="button" className="nx-set-list-item" onClick={() => onPick(en.id)} data-company-state={en.id}>
              <span className="nx-set-tile"><Building2 size={14} /></span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{en.name}</span>
              {stateOf && (st ? (
                <span className={`nx-set-badge${st.own ? ' is-own' : ''}`} style={st.failed ? { color: 'hsl(var(--color-red))' } : undefined}>{st.label}</span>
              ) : <Spinner size={12} />)}
              <ChevronRight size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
            </button>
          );
        })}
      </div>
    </>
  );
}

// Under a layered setting's default: which companies keep their own. Says so
// when a company could not be checked rather than guessing it follows.
function CompanyOverrides({ entities, stateOf, onPick, lead = 'Companies with their own:' }) {
  const states = useCompanyStates(entities, stateOf);
  if (entities.length === 0 || !entities.every(en => states[en.id])) return null;
  const own = entities.filter(en => states[en.id].own);
  const failed = entities.filter(en => states[en.id].failed).length;
  return (
    <div className="nx-set-note" data-company-overrides="">
      <Building2 size={13} />
      {own.length === 0 && !failed && 'Every company follows this default.'}
      {own.length > 0 && (
        <>
          {lead}
          {own.map((en, i) => (
            <span key={en.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <button type="button" className="nx-set-inline-link" onClick={() => onPick(en.id)}>{en.name}</button>
              {i < own.length - 1 && <span aria-hidden="true">·</span>}
            </span>
          ))}
        </>
      )}
      {failed > 0 && <span>{`Could not check ${failed} ${failed === 1 ? 'company' : 'companies'}.`}</span>}
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
// A layered panel reports whether the picked company has a value of its own
// (`onOverride`), and the group's chip says Overridden / Inherited; `report`
// passes it up for the subject's "Different for" line.
function LazyPanelSection({ id, Panel, chrome, report, footer, toastOk, toastErr, ...rest }) {
  const [override, setOverride] = useState(undefined);
  const onOverride = useCallback((v) => { setOverride(v); report?.(id, v); }, [id, report]);
  return (
    <Group {...GROUP_META[id]} {...chrome} override={override} footer={footer}>
      <Suspense fallback={<SectionFallback />}>
        <Panel toastOk={toastOk} toastErr={toastErr} onOverride={onOverride} {...rest} />
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
  const [busy, setBusy] = useState(false);
  const [zoomTemplate, setZoomTemplate] = useState(null);   // { label, html } | null - full-size eye-icon preview

  // Sender Template Overrides - global, not per-company (Sep 22, Pranshu:
  // "it will be for all whom email id we are adding so it should not be
  // company specific"), so this block loads/saves independently of the
  // Company picker above. `overrideTemplates` is just {id,label} - no
  // company branding to render a sample against, unlike `data.templates`.
  const [overrideTemplates, setOverrideTemplates] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [savedOverrides, setSavedOverrides] = useState([]);   // what the server holds; `overrides` is the draft
  const [overrideModal, setOverrideModal] = useState(null);   // 'new' | index into `overrides` | null
  // One Save for the group (the Settings save pattern, Oct 23): the template
  // and the overrides are a draft until it is clicked.
  const templateDirty = !!data && !!companyId && selectedTemplate !== data.template;
  const overridesDirty = !company && JSON.stringify(overrides) !== JSON.stringify(savedOverrides);
  const dirty = templateDirty || overridesDirty;
  useGroupDirty(dirty);

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
        .then(d => { setOverrideTemplates(d.templates || []); setOverrides(d.senderOverrides || []); setSavedOverrides(d.senderOverrides || []); })
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

  async function save() {
    if (busy || !dirty) return;
    setBusy(true);
    try {
      if (templateDirty) {
        await api.updateEntity(companyId, { signature_template: selectedTemplate });
        setData(d => (d ? { ...d, template: selectedTemplate } : d));
      }
      if (overridesDirty) {
        const d = await api.saveSignatureSenderOverrides(overrides);
        setOverrideTemplates(d.templates || []);
        setOverrides(d.senderOverrides || []);
        setSavedOverrides(d.senderOverrides || []);
      }
      toastOk(templateDirty && !overridesDirty
        ? 'Signature template saved. It applies to every employee at this company.'
        : 'Email signature settings saved.');
    } catch (e) { toastErr(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  function discard() {
    if (data) setSelectedTemplate(data.template);
    setOverrides(savedOverrides);
  }

  return (
    <Group {...GROUP_META['email-signature']} {...chrome}>
      {entities.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>{loaded ? 'No companies yet. Add one under Settings > Companies first.' : 'Loading…'}</div>
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
      </div>}

      {entities.length > 0 && (
        <SaveRow dirty={dirty} busy={busy} onSave={save} onDiscard={discard}
          note={company ? 'The template applies to every employee at this company.' : 'The template applies to every employee at the company picked; overrides apply in every company.'} />
      )}

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
      <div role="dialog" aria-modal="true" aria-label={grp ? 'Edit Override' : 'Add Override'}
        style={{ background: 'var(--card)', borderRadius: 12, width: '60vw', minWidth: 'min(340px, 100%)', maxWidth: '96vw', maxHeight: '90vh', overflow: 'auto', boxShadow: 'var(--shadow-lg)' }}>
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
// Desktop (Oct 25 2026): a rail of subjects in four sections that stays in
// view, the filter at its top ('/' focuses it) and the subject on screen
// listing its groups as jump links; the subject header sticks to the top with
// the Scope switch in it. Phones: Settings opens on a list of the subjects
// and a subject opens on its own page with a way back. Subject, group and
// company live in the URL sub (see AdminConsole below); the filter text and
// the last jump are local (a jump scrolls, it adds no history entry).
function SettingsBody({ subject, group, company, home = false, onHome, onNavigate, onDirtyChange, entities, refreshEntities, toast, toastOk, toastErr }) {
  const who = useRole();
  const narrow = useIsMobile('(max-width: 900px)');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  // What this person may open (mayOpen, from each group's `needs`): a
  // subject is in the rail when one of its groups opens somewhere; the groups
  // on the page are the ones that open at this scope - a company-only group
  // at "Every company" opens if it opens for some company, since picking the
  // company is the next click.
  const subjects = SUBJECTS.filter(s => GROUPS.some(g => g.subject === s.key && mayOpen(g, who, undefined)));
  const groups = GROUPS.filter(g => mayOpen(g, who, g.face === 'company' && !company ? undefined : company));

  const entity = company ? entities.find(e => e.id === company) : null;
  const companyName = entity?.name || '';
  // With a company picked, only subjects with a company face are live; the
  // rest stay where they are in the rail, dimmed, and open at Every company -
  // the rail never reshuffles when the scope changes.
  const isLive = useCallback((s) => !company || s.faces !== 'org', [company]);
  const live = subjects.filter(isLive);
  const activeSubject = live.find(s => s.key === subject) || live[0];

  // The groups a subject shows at this scope: its company face with a
  // company picked; otherwise its organization face, or (a per-company
  // subject such as Workforce Analytics) its company groups as pickers.
  const groupsFor = (s) => {
    const own = groups.filter(g => g.subject === s.key);
    if (company) return own.filter(g => g.face !== 'org');
    const org = own.filter(g => g.face !== 'company');
    return org.length ? org : own.filter(g => g.face === 'company');
  };
  const searchable = company ? groups.filter(g => g.face !== 'org') : groups;
  const matches = needle ? searchable.filter(g => groupMatches(g, needle)) : null;
  const counts = matches ? matches.reduce((m, g) => ({ ...m, [g.subject]: (m[g.subject] || 0) + 1 }), {}) : null;

  // Every group with unsaved changes (lib/groupDirty.js: a form says so
  // through the context its group binds in renderGroup; the Company profile
  // form through onDirtyChange). Leaving any of them - another subject or
  // scope here, another top tab or module above - asks first.
  const [dirtyIds, setDirtyIds] = useState(() => new Set());
  const reportDirty = useCallback((id, d) => setDirtyIds(prev => {
    if (prev.has(id) === !!d) return prev;
    const next = new Set(prev);
    if (d) next.add(id); else next.delete(id);
    return next;
  }), []);
  const reporters = useRef(new Map());
  const reporterFor = (id) => {
    if (!reporters.current.has(id)) reporters.current.set(id, (d) => reportDirty(id, d));
    return reporters.current.get(id);
  };
  const dirty = dirtyIds.size > 0;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const [pending, setPending] = useState(null);
  const go = useCallback((target) => { setQuery(''); setPending(null); onNavigate(target); }, [onNavigate]);
  const nav = useCallback((target) => { if (dirty) setPending(target); else go(target); }, [dirty, go]);
  const pickSubject = (key) => nav({ subject: key, group: '', company });
  // On the phone home list, a scope change stays on the list.
  const pickScope = (id) => nav(narrow && home ? { home: true, company: id } : { subject: activeSubject?.key || 'companies', group: '', company: id });
  const openSubject = (s) => (isLive(s) ? pickSubject(s.key) : nav({ subject: s.key, group: '', company: '' }));

  // A jump within the subject on screen (rail links, the "Different for"
  // line): scroll there and move focus to the group's title. Nothing
  // unmounts, so there is nothing unsaved to ask about, and no history entry.
  const here = `${activeSubject?.key}|${company}`;
  const [jumped, setJumped] = useState({ at: '', id: '' });
  const current = jumped.at === here ? jumped.id : group;
  const jump = (g) => {
    const el = document.getElementById(`setting-${g.id}`);
    const calm = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    el?.scrollIntoView?.({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
    el?.querySelector?.('h4')?.focus?.({ preventScroll: true });
    setJumped({ at: here, id: g.id });
  };

  // What each group reported about the picked company (true: its own value,
  // false: the default), for the subject's "Different for" line.
  const [overrides, setOverrides] = useState({});
  const report = useCallback((id, v) => {
    const k = `${company}|${id}`;
    setOverrides(m => (m[k] === v ? m : { ...m, [k]: v }));
  }, [company]);

  const sections = matches
    ? live.map(s => ({ s, items: matches.filter(g => g.subject === s.key) })).filter(x => x.items.length)
    : (activeSubject ? [{ s: activeSubject, items: groupsFor(activeSubject) }] : []);
  // A subject's lone group renders bare: the subject header already names it.
  const bareId = !matches && sections[0]?.items.length === 1 ? sections[0].items[0].id : '';

  function renderGroup(g) {
    return (
      <GroupDirtyContext.Provider key={`${g.id}-${company}`} value={reporterFor(g.id)}>
        {renderGroupBody(g)}
      </GroupDirtyContext.Provider>
    );
  }
  function renderGroupBody(g) {
    const id = g.id;
    const chrome = { bare: id === bareId, highlight: id === group, company: companyName, flush: !!g.flush };
    const key = `${id}-${company}`;
    const pickFor = (cid) => nav({ subject: g.subject, group: id, company: cid });
    // A per-company setting at "Every company": the companies and where each stands.
    if (g.scope === 'company' && !company && COMPANY_STATE[id]) {
      return (
        <Group key={key} {...g} {...chrome} flush>
          <CompanyStates entities={entities} stateOf={COMPANY_STATE[id]} onPick={pickFor} />
        </Group>
      );
    }
    // A layered setting at "Every company": the default, and who keeps their own.
    const footer = g.scope === 'layered' && !company && COMPANY_STATE[id]
      ? <CompanyOverrides entities={entities} stateOf={COMPANY_STATE[id]} onPick={pickFor} lead={OWN_LINE[id]} /> : null;
    const layered = { report, footer };
    // The shift settings, one slice per group.
    if (g.part) {
      return <LazyPanelSection key={key} id={id} Panel={ShiftSettingsPanel} part={g.part} chrome={chrome} {...layered} toastOk={toastOk} toastErr={toastErr} company={company} />;
    }
    // A company-only group at "Every company": pick the company first.
    if (g.face === 'company' && !company) {
      return (
        <Group key={key} {...g} {...chrome} flush>
          <CompanyStates entities={entities} onPick={pickFor} lead={`${g.title} is set per company. Open one:`} />
        </Group>
      );
    }
    if (COMPANY_FACE_TABS[id]) {
      return (
        <Group key={key} {...g} {...chrome}>
          <CompanyPage entities={entities} refreshEntities={refreshEntities} entityId={company} tabs={COMPANY_FACE_TABS[id]}
            onDirtyChange={id === 'company-profile' ? reporterFor(id) : undefined} toastOk={toastOk} toastErr={toastErr} />
        </Group>
      );
    }
    switch (id) {
      case 'company-list':
        return (
          <Group key={key} {...g} {...chrome}>
            <CompanyPage entities={entities} refreshEntities={refreshEntities} onOpen={cid => nav({ subject: 'companies', group: '', company: cid })}
              onDirtyChange={reporterFor(id)} toastOk={toastOk} toastErr={toastErr} />
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
      case 'kb-reminders':         return <LazyPanelSection key={key} id={id} Panel={KbReminderSettings} chrome={chrome} />;
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
        return <PayRulesSection key={key} chrome={chrome} company={company} {...layered} toastOk={toastOk} toastErr={toastErr} />;
      case 'hiring-documents':     return <HiringSetupSection key={key} id={id} Modal={PacketsModal} label="Open Hiring Documents" chrome={chrome} toastOk={toastOk} toastErr={toastErr} modalProps={company ? { companyId: company, lockCompany: true } : undefined} />;
      case 'payroll-export-codes': return <LazyPanelSection key={key} id={id} Panel={PayrollExportCodes} chrome={chrome} report={report} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'pay-premiums':         return <LazyPanelSection key={key} id={id} Panel={PayPremiums} chrome={chrome} report={report} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'india-contractor-policy': return <LazyPanelSection key={key} id={id} Panel={IndiaContractorPolicySettings} chrome={chrome} {...layered} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'interview-questionnaires': return <HiringSetupSection key={key} id={id} Modal={QuestionnairesModal} label="Open Questionnaires" chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      case 'checklist-library':    return <LazyPanelSection key={key} id={id} Panel={ChecklistLibrary} chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      case 'probation':            return <LazyPanelSection key={key} id={id} Panel={ProbationSettings} chrome={chrome} {...layered} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'shift-types':          return <LazyPanelSection key={key} id={id} Panel={ShiftTypesPanel} chrome={chrome} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'shift-groups':         return <LazyPanelSection key={key} id={id} Panel={ShiftGroupsPanel} chrome={chrome} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'shift-weather':        return <LazyPanelSection key={key} id={id} Panel={WeatherSettingsPanel} chrome={chrome} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'ops-cubby-push':       return <LazyPanelSection key={key} id={id} Panel={OpsSettingsPanel} chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      case 'ops-cubby-tasks':      return <LazyPanelSection key={key} id={id} Panel={CubbyTasksSettingsPanel} chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      // Phase 3: the strays, each the component its module owns.
      case 'payroll-readiness':    return <LazyPanelSection key={key} id={id} Panel={ReadinessThresholds} chrome={chrome} {...layered} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'ca-min-wage':          return <LazyPanelSection key={key} id={id} Panel={MinWageForm} chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      case 'leave-policies':       return <LazyPanelSection key={key} id={id} Panel={LeaveSetup} chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      case 'time-off-reasons':     return <LazyPanelSection key={key} id={id} Panel={TimeOffReasons} chrome={chrome} {...layered} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'leave-year-end':       return <LazyPanelSection key={key} id={id} Panel={LeaveYearEndSettings} chrome={chrome} {...layered} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'timeoff-approval':     return <LazyPanelSection key={key} id={id} Panel={TimeOffApprovalSettings} chrome={chrome} {...layered} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'intacct-nightly':      return <LazyPanelSection key={key} id={id} Panel={IntacctNightlySync} chrome={chrome} toastOk={toastOk} toastErr={toastErr} company={company} embedded />;
      case 'letterheads':          return <LazyPanelSection key={key} id={id} Panel={LetterheadsPanel} chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      case 'hr-letters':           return <LazyPanelSection key={key} id={id} Panel={HrLettersSettings} chrome={chrome} {...layered} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'ticket-property-rules': return <LazyPanelSection key={key} id={id} Panel={TicketPropertyRulesPanel} chrome={chrome} toastOk={toastOk} toastErr={toastErr} />;
      case 'ops-unit-rules':       return <LazyPanelSection key={key} id={id} Panel={UnitRulesPanel} chrome={chrome} />;
      case 'app-ratings':          return <LazyPanelSection key={key} id={id} Panel={AppRatingsPanel} chrome={chrome} />;
      case 'employee-custom-fields': return <LazyPanelSection key={key} id={id} Panel={EmployeeCustomFieldsSettings} chrome={chrome} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'performance-reminders': return <LazyPanelSection key={key} id={id} Panel={PerformanceReminderSettings} chrome={chrome} {...layered} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'workflows-config':     return <LazyPanelSection key={key} id={id} Panel={WorkflowsSettingsPanel} chrome={chrome} {...layered} toastOk={toastOk} toastErr={toastErr} company={company} />;
      case 'holiday-policies':     return <LazyPanelSection key={key} id={id} Panel={HolidayPoliciesPanel} chrome={chrome} entities={entities} toastOk={toastOk} toastErr={toastErr} />;
      default:                     return null;
    }
  }

  const scopeSwitch = (
    <div className={`nx-set-scope${company ? ' is-company' : ''}`}>
      <Building2 size={14} style={{ color: company ? 'var(--nx-own)' : 'var(--muted)', flexShrink: 0 }} aria-hidden="true" />
      <span className="nx-set-scope-label" aria-hidden="true">Applies To</span>
      <select className="form-input" aria-label="Applies To" value={company} onChange={e => pickScope(e.target.value)}>
        <option value="">Every company</option>
        {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
      </select>
      {company && (
        <button type="button" className="nx-set-scope-clear" onClick={() => pickScope('')} aria-label="Back to every company" title="Back to every company">
          <X size={14} />
        </button>
      )}
    </div>
  );

  // '/' focuses the filter (TopHeader hands the key to a tagged search box).
  const filterBox = (
    <div className="nx-set-search">
      <Search size={13} aria-hidden="true" />
      <input className="form-input" type="search" value={query} onChange={e => setQuery(e.target.value)} data-slash-search=""
        onKeyDown={e => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } }}
        placeholder="Search settings" aria-label="Filter settings" />
      {!query && !narrow && <kbd aria-hidden="true">/</kbd>}
    </div>
  );

  // With a company picked: what this company does differently in the subject
  // on screen, from what its groups reported, with jump links.
  const shown = company && activeSubject && !matches ? groupsFor(activeSubject) : [];
  const heard = shown.filter(g => overrides[`${company}|${g.id}`] !== undefined);
  const different = heard.filter(g => overrides[`${company}|${g.id}`] === true);
  const differs = heard.length > 0 && shown.length > 1 ? (
    <div data-different-here="" className={`nx-set-diff${different.length ? ' is-own' : ''}`}>
      {different.length === 0 ? <><Check size={14} aria-hidden="true" /> {`${companyName} follows the defaults here.`}</> : (
        <>
          <span style={{ color: 'var(--ink)', fontWeight: 600 }}>Different for {companyName}:</span>
          {different.map((g, i) => (
            <span key={g.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <button type="button" onClick={() => jump(g)}>{g.title}</button>
              {i < different.length - 1 && <span aria-hidden="true">·</span>}
            </span>
          ))}
        </>
      )}
    </div>
  ) : null;

  // With a company picked, the subject's organization-wide groups are a line
  // of links under its company face, so nothing seems to have vanished.
  const alsoOrg = company && activeSubject && !matches
    ? groups.filter(g => g.subject === activeSubject.key && g.face === 'org') : [];

  // A subject with nothing to show at this scope: for someone whose access
  // is limited to some companies, Every company holds nothing of theirs.
  const nothingHere = Array.isArray(who.hrScope) && !company
    ? 'These settings are set per company for you - pick one in the Scope box.'
    : 'Nothing to set here.';

  const head = matches ? (
    <div className="nx-set-head">
      <div className="nx-set-head-text">
        <h3>Search Results</h3>
        <p>{`${matches.length} ${matches.length === 1 ? 'setting matches' : 'settings match'} "${query.trim()}"${company ? ` for ${companyName}` : ''}.`}</p>
      </div>
      {scopeSwitch}
    </div>
  ) : activeSubject ? (
    <div className="nx-set-head">
      <div className="nx-set-head-text">
        <h3><activeSubject.Icon size={19} aria-hidden="true" style={{ color: 'var(--muted)' }} />{activeSubject.label}</h3>
        <p>{activeSubject.desc}</p>
      </div>
      {scopeSwitch}
    </div>
  ) : null;

  const content = (
    <div style={{ minWidth: 0 }}>
      {sections.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '36px 16px', color: 'var(--muted)', fontSize: 13, border: '1px dashed var(--line)', borderRadius: 12 }}>
          {matches ? (
            <>
              <Search size={20} style={{ marginBottom: 8, opacity: 0.6 }} aria-hidden="true" />
              <div style={{ marginBottom: 12 }}>No settings match "{query.trim()}"{company ? ` for ${companyName}` : ''}.</div>
              <button className="secondary-btn" onClick={() => setQuery('')}>Clear Filter</button>
            </>
          ) : nothingHere}
        </div>
      ) : sections.map(({ s, items }) => (
        <section key={s.key} aria-label={matches ? s.label : undefined}>
          {matches && (
            <h3 style={{ margin: '4px 0 12px', fontSize: 12, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <s.Icon size={13} aria-hidden="true" /> {s.label}
            </h3>
          )}
          {s === activeSubject && differs}
          {items.map(renderGroup)}
          {items.length === 0 && (
            <div style={{ padding: '20px 16px', color: 'var(--muted)', fontSize: 13, border: '1px dashed var(--line)', borderRadius: 10 }}>{nothingHere}</div>
          )}
          {s === activeSubject && alsoOrg.length > 0 && (
            <div className="nx-set-diff" style={{ marginTop: -8 }}>
              <Globe size={14} aria-hidden="true" />
              <span>Set for every company:</span>
              {alsoOrg.map((g, i) => (
                <span key={g.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <button type="button" className="nx-set-inline-link" onClick={() => nav({ subject: g.subject, group: g.id, company: '' })}>{g.title}</button>
                  {i < alsoOrg.length - 1 && <span aria-hidden="true">·</span>}
                </span>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );

  const wide = !matches && !!activeSubject?.wide;
  const prompt = pending && <UnsavedChangesPrompt onKeepEditing={() => setPending(null)} onDiscard={() => go(pending)} />;

  // ── Phones ──
  if (narrow) {
    if (home && !matches) {
      return (
        <>
          <div style={{ display: 'grid', gap: 10 }}>{filterBox}{scopeSwitch}</div>
          {SUBJECT_SECTIONS.map(sec => {
            const items = subjects.filter(s => s.section === sec.key);
            if (!items.length) return null;
            return (
              <div key={sec.key}>
                <div className="nx-set-home-section">{sec.label}</div>
                <div className="nx-set-card nx-set-list" role="group" aria-label={sec.label}>
                  {items.map(s => (
                    <button key={s.key} type="button" className="nx-set-list-item" onClick={() => openSubject(s)}
                      style={isLive(s) ? undefined : { opacity: 0.55 }}>
                      <span className="nx-set-tile"><s.Icon size={15} /></span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{s.label}</span>
                        <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {isLive(s) ? s.desc : 'Set for every company'}
                        </span>
                      </span>
                      <ChevronRight size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {prompt}
        </>
      );
    }
    return (
      <>
        <button type="button" className="nx-set-back" onClick={() => (matches ? setQuery('') : onHome?.())}>
          <ChevronLeft size={16} /> {matches ? 'Clear Search' : 'All Settings'}
        </button>
        {matches && <div style={{ marginBottom: 12 }}>{filterBox}</div>}
        {head}
        {content}
        {prompt}
      </>
    );
  }

  // ── Desktop ──
  return (
    <>
      <div className="nx-set-shell">
        <nav aria-label="Settings subjects" className="nx-set-rail">
          {filterBox}
          {SUBJECT_SECTIONS.map(sec => {
            const items = subjects.filter(s => s.section === sec.key);
            if (!items.length) return null;
            return (
              <div key={sec.key} role="group" aria-labelledby={`nx-set-sec-${sec.key}`}>
                <div className="nx-set-rail-section" id={`nx-set-sec-${sec.key}`}>{sec.label}</div>
                {items.map(s => {
                  const off = !isLive(s);
                  const active = !matches && s === activeSubject;
                  const inRail = active ? groupsFor(s) : [];
                  const count = counts ? (counts[s.key] || 0) : null;
                  return (
                    <div key={s.key}>
                      <button type="button" onClick={() => openSubject(s)} aria-current={active ? 'page' : undefined}
                        title={off ? 'Set for every company - opens at Every company' : undefined}
                        className={`nx-set-rail-item${active ? ' is-active' : ''}${off || count === 0 ? ' is-off' : ''}`}>
                        <s.Icon size={15} style={{ flexShrink: 0 }} aria-hidden="true" />
                        <span className="nx-set-rail-label">{s.label}</span>
                        {off && <Globe size={12} aria-hidden="true" style={{ flexShrink: 0 }} />}
                        {count > 0 && <span className="nx-set-rail-meta">{count}</span>}
                      </button>
                      {/* Jump links: the subject on screen lists its groups. */}
                      {inRail.length > 1 && (
                        <div role="group" aria-label={`${s.label} settings`} className="nx-set-rail-links">
                          {inRail.map(g => (
                            <button key={g.id} type="button" onClick={() => jump(g)} aria-current={g.id === current ? 'location' : undefined}
                              className={`nx-set-rail-link${g.id === current ? ' is-current' : ''}`}>
                              {g.title}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <div className={`nx-set-main${wide ? '' : ' is-narrow'}`}>
          {head}
          {content}
        </div>
      </div>
      {prompt}
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
  // No subject named: Settings home - a list of the subjects on phones, Companies on a desktop.
  if (!sub || sub === 'settings' || sub === 'global' || sub === 'company') return { ...settings('companies'), home: true };
  // The phone home list with a company picked.
  if (sub.startsWith('settings@')) return { ...settings('companies', '', sub.slice('settings@'.length)), home: true };
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
function buildSub({ subject, group = '', company = '', home = false }) {
  if (home) return company ? `settings@${company}` : 'settings';
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
  const applyTopTab = (id) => onSubChange?.(id === 'settings' ? buildSub(resolved) : id);
  const navigate = useCallback((target) => onSubChange?.(buildSub(target)), [onSubChange]);

  // A Settings group with unsaved changes: the top tabs ask before moving,
  // and lib/dialogGuard.js hears about it so the sidebar and the browser
  // tab ask too.
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [pendingTab, setPendingTab] = useState(null);
  useEffect(() => { setInlineDirty('settings', settingsDirty); return () => setInlineDirty('settings', false); }, [settingsDirty]);
  const setTopTab = (id) => { if (settingsDirty && id !== topTab) setPendingTab(id); else applyTopTab(id); };

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
      {/* On a desktop the header already names the page and carries its tabs (Oct 25). */}
      <div className="view-header nx-set-pagehead" style={{ marginBottom: 18 }}>
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
          home={!!resolved.home} onHome={() => onSubChange?.(resolved.company ? `settings@${resolved.company}` : 'settings')}
          onDirtyChange={setSettingsDirty} entities={entities} refreshEntities={refreshEntities}
          toast={showToast} toastOk={toastOk} toastErr={toastErr} />
      )}

      {pendingTab && (
        <UnsavedChangesPrompt onKeepEditing={() => setPendingTab(null)} onDiscard={() => { const id = pendingTab; setPendingTab(null); applyTopTab(id); }} />
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
// One pay rule (Oct 25 2026): a switch row that saves on click; its numbers
// show under it while it is on, with a Save that appears once one changes.
function PolicyCard({ id, title, desc, enabled, onToggle, busy, foot, children }) {
  return (
    <>
      <SwitchRow id={`pay-rule-${id}`} label={title} title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{title}{busy && <Spinner size={12} />}</span>}
        desc={desc} checked={enabled} disabled={busy} onChange={onToggle}>
        {(enabled && children) || foot ? (
          <>
            {enabled && children}
            {foot && <div style={{ flexBasis: '100%', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)' }}>{foot}</div>}
          </>
        ) : null}
      </SwitchRow>
    </>
  );
}

function PolicyNumber({ label, value, onChange, min = 0, max = 999, unit = 'min', width = 76 }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--muted)' }}>
      {label}
      <NumberBox value={value} onChange={onChange} min={min} max={max} unit={unit} width={width} label={label} />
    </label>
  );
}

// `company` (Settings' scope picker, Oct 23): that company's own rules over
// the defaults - each card says whether the company has one of its own and
// offers the default back; '' edits the defaults for every company.
const RULE_SETTERS = {
  rounding: (body, company) => api.timeRoundingSet(body, company),
  autoLunch: (body, company) => api.timeAutoLunchSet(body, company),
  breakPolicy: (body, company) => api.timeBreakPolicySet(body, company),
};
const RULE_LABELS = { rounding: 'Punch rounding', autoLunch: 'Auto-lunch', breakPolicy: 'CA paid breaks' };
const num = (v, fallback) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fallback; };
// What a save writes: each rule whole, with its numbers clamped (the server
// echoes the saved rule back).
const cleanRules = (d) => ({
  rounding: { enabled: !!d.rounding.enabled, nearestMin: Math.min(30, Math.max(1, num(d.rounding.nearestMin, 5))) },
  autoLunch: { enabled: !!d.autoLunch.enabled, afterMin: num(d.autoLunch.afterMin, 360), deductMin: num(d.autoLunch.deductMin, 30) },
  breakPolicy: { enabled: !!d.breakPolicy.enabled, paidBreakMin: num(d.breakPolicy.paidBreakMin, 10), restMaxMin: num(d.breakPolicy.restMaxMin, 20), longBreakMin: num(d.breakPolicy.longBreakMin, 75) },
});

function TimeClockPolicyPanel({ toastOk, toastErr, company = '', onOverride }) {
  const [cfg, setCfg] = useState(null);     // { rounding, autoLunch, breakPolicy } | null while loading
  // Any rule of the company's own = the group reads Overridden.
  useEffect(() => { if (cfg && company) onOverride?.(['rounding', 'autoLunch', 'breakPolicy'].some(k => cfg[k]?.hasOverride)); }, [cfg, company, onOverride]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState('');   // which card is going back to the default
  const load = useCallback(() => {
    setErr('');
    setCfg(null);
    Promise.all([api.timeRoundingGet(company), api.timeAutoLunchGet(company), api.timeBreakPolicyGet(company)])
      .then(([rounding, autoLunch, breakPolicy]) => setCfg({ rounding, autoLunch, breakPolicy }))
      .catch(e => setErr(e?.message || 'Could not load the Time Clock settings.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);

  // The three cards are one form (the Settings save pattern, Oct 23): the
  // switches and numbers are a draft until Save, which writes only the
  // rules that changed. Use the Default drops a company's own rule at once.
  const { draft, patch, dirty, reset } = useDraft(cfg);
  useGroupDirty(dirty);
  const edit = (key, p) => patch({ [key]: { ...draft[key], ...p } });

  const save = async () => {
    if (!dirty || busy) return;
    const next = cleanRules(draft), was = cleanRules(cfg);
    const changed = Object.keys(next).filter(k => JSON.stringify(next[k]) !== JSON.stringify(was[k]));
    if (!changed.length) { reset(); return; }
    setBusy(true);
    const out = { ...cfg };
    try {
      for (const k of changed) out[k] = await RULE_SETTERS[k](next[k], company);
      setCfg(out);
      toastOk?.(company ? 'Pay rules saved for this company.' : 'Pay rules saved.');
    } catch (e) {
      toastErr?.(e?.message || 'Could not save the pay rules.');
      setCfg(out);   // what did save, saved; the rest stays a draft
    }
    setBusy(false);
  };
  const backToDefault = async (key) => {
    setResetting(key);
    try {
      const saved = await RULE_SETTERS[key]({ reset: true }, company);
      setCfg(c => ({ ...c, [key]: saved }));
      toastOk?.(`${RULE_LABELS[key]}: back to the default.`);
    } catch (e) { toastErr?.(e?.message || `Could not reset ${RULE_LABELS[key].toLowerCase()}.`); }
    setResetting('');
  };
  // With a company picked, only a rule the company has of its own says so
  // (the group's badge says Inherited otherwise), with the way back to the default.
  const foot = (key, rule) => (company && rule.hasOverride ? (
    <>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--nx-own)', flexShrink: 0 }} aria-hidden="true" />
      This company has a rule of its own.
      <button type="button" className="secondary-btn" style={{ fontSize: 11.5 }} disabled={busy || resetting === key} onClick={() => backToDefault(key)}>Use the Default</button>
    </>
  ) : null);

  if (err) return <ErrorLine text={err} onRetry={load} />;
  if (!cfg || !draft) return <SkeletonBlocks count={3} height={64} borderRadius={12} />;
  const { rounding, autoLunch, breakPolicy } = draft;
  return (
    <div>
      <PolicyCard id="rounding" title="Punch Rounding" busy={resetting === 'rounding'} enabled={rounding.enabled} foot={foot('rounding', cfg.rounding)}
        desc={`Round every clock-in and clock-out to the nearest ${rounding.nearestMin || 5} minutes before computing hours (SwipeClock's model; the raw times stay on record and can be shown on the time sheet). Off by default - turn it on only if the company has a rounding policy.`}
        onToggle={on => edit('rounding', { enabled: on })}>
        <PolicyNumber label="Nearest" min={1} max={30} value={rounding.nearestMin} onChange={v => edit('rounding', { nearestMin: v })} />
      </PolicyCard>
      <PolicyCard id="auto-lunch" title="Auto-Lunch Deduction" busy={resetting === 'autoLunch'} enabled={autoLunch.enabled} foot={foot('autoLunch', cfg.autoLunch)}
        desc={`Deduct ${autoLunch.deductMin} minutes of lunch from any shift longer than ${Math.round((autoLunch.afterMin || 0) / 60 * 10) / 10} hours that has no recorded break (the person forgot to clock lunch).`}
        onToggle={on => edit('autoLunch', { enabled: on })}>
        <PolicyNumber label="Shifts over" min={0} max={1440} value={autoLunch.afterMin} onChange={v => edit('autoLunch', { afterMin: v })} />
        <PolicyNumber label="Deduct" min={0} max={240} value={autoLunch.deductMin} onChange={v => edit('autoLunch', { deductMin: v })} />
      </PolicyCard>
      <PolicyCard id="ca-breaks" title="California Paid Rest Breaks" busy={resetting === 'breakPolicy'} enabled={breakPolicy.enabled} foot={foot('breakPolicy', cfg.breakPolicy)}
        desc={`Pay the first ${breakPolicy.paidBreakMin} minutes of each short break (up to ${breakPolicy.restMaxMin} minutes long) - one per 4 hours worked, as California requires. Meal-length breaks stay unpaid. Only employees on the California overtime rule; the long-break flags are always on.`}
        onToggle={on => edit('breakPolicy', { enabled: on })}>
        <PolicyNumber label="Paid per break" min={0} max={60} value={breakPolicy.paidBreakMin} onChange={v => edit('breakPolicy', { paidBreakMin: v })} />
        <PolicyNumber label="Rest break up to" min={1} max={120} value={breakPolicy.restMaxMin} onChange={v => edit('breakPolicy', { restMaxMin: v })} />
        <PolicyNumber label="Flag breaks over" min={15} max={600} value={breakPolicy.longBreakMin} onChange={v => edit('breakPolicy', { longBreakMin: v })} />
      </PolicyCard>
      <SaveRow dirty={dirty} busy={busy} onSave={save} onDiscard={reset} style={{ margin: 0, padding: '12px 18px' }}
        note={company ? 'A rule saved here is this company\'s own.' : 'Saved rules shape every time sheet from then on.'} />
    </div>
  );
}

function PayRulesSection({ chrome, company, report, footer, toastOk, toastErr }) {
  const [override, setOverride] = useState(undefined);
  const onOverride = useCallback((v) => { setOverride(v); report?.('timeclock-policy', v); }, [report]);
  return (
    <Group {...GROUP_META['timeclock-policy']} {...chrome} override={override} footer={footer}>
      <TimeClockPolicyPanel toastOk={toastOk} toastErr={toastErr} company={company} onOverride={onOverride} />
    </Group>
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
