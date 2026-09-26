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
// live under Global Settings, grouped into categories (left rail on desktop,
// a select on phones, plus a filter box); everything that belongs to one
// legal entity lives under Company Settings. Sub keys: 'global' (Organization
// category), 'global-<category>' for the other categories, 'company',
// 'tools', 'audit'. The old 'settings' sub still lands on Global Settings.
//
// Access (people, groups, the matrix) is a Global Settings category, not its
// own tab - it is org-wide; job roles are per company, under Company Settings.
// Ticket, task and briefing email settings share one Notifications &
// Communications category. Act As and the Microsoft 365 sync are actions,
// not settings, so they sit on the Tools tab (views/SettingsTools.jsx).
// Old links: 'access' -> the Access category, 'actas' -> Tools, and the
// retired 'global-service-desk' / '-tasks' / '-communications' categories
// -> Notifications & Communications.
import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import {
  Settings2, ChevronDown, Tag, Shield,
  Headset, Bell, Mail, Building2, Loader2, Timer,
  Activity, Signature, Check, Eye, X,
  Plus, Pencil, Trash2, Upload, GripVertical, MapPinned,
  Globe, Package, Search, Wrench, CalendarClock,
} from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import ModuleTabs from '../components/ModuleTabs';
import { SkeletonBlocks } from '../components/AsyncState';
import { useIsMobile } from '../lib/useIsMobile';
import TicketDeskSettings from '../tickets/TicketDeskSettings';
import TicketNotifySettings from '../tickets/TicketNotifySettings';
import TicketTaxonomySettings from '../tickets/TicketTaxonomySettings';
import DailyBriefingSettings from '../components/DailyBriefingSettings';

// Borrowed components, lazy so their home module's chunk only loads once an
// admin actually opens that section.
const ManageTypesModal = lazy(() => import('./InventoryManagement').then(m => ({ default: m.ManageTypesModal })));
const CustomFieldsAdminModal = lazy(() => import('./InventoryManagement').then(m => ({ default: m.CustomFieldsAdminModal })));
const CompanySetupPage = lazy(() => import('./HR').then(m => ({ default: m.CompanySetupPage })));
const WorkSiteLibrary = lazy(() => import('./HR').then(m => ({ default: m.WorkSiteLibrary })));
// Roles & Access moved here whole (Pranshu, Sep 9) - was a People tab
// (HR.jsx's old 'hr-access' sub), now a top-level tab of Admin instead.
// `embedded` skips its own page header, since it gets one from the tab here.
const RolesAccess = lazy(() => import('./RolesAccess'));
const SettingsTools = lazy(() => import('./SettingsTools'));
const HrReminderSettings = lazy(() => import('../components/HrReminderSettings'));
// Audit Logs (Sep 11) - same tab-beside-Roles-&-Access treatment. The old
// header AdminPanel drawer that used to render this is gone; AuditLogs is
// named-exported from that file and embedded directly here now.
const AuditLogs = lazy(() => import('../components/AdminPanel').then(m => ({ default: m.AuditLogs })));
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

function ModalFallback() {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Loader2 size={22} style={{ color: '#fff', animation: 'spin 1s linear infinite' }} />
    </div>
  );
}

function SectionFallback() {
  return <SkeletonBlocks count={2} height={44} borderRadius={10} />;
}

// ── Global Settings: categories + section registry ───────────────────────────
// One place for every org-wide section's title, description and search
// keywords, so the category rail, the filter and the sections themselves
// can never disagree about what a section is called.
const GLOBAL_CATEGORIES = [
  { key: 'organization',   label: 'Organization',   Icon: Building2,
    desc: 'Email signatures and the work sites employees punch in at.' },
  { key: 'notifications',  label: 'Notifications & Communications', Icon: Bell,
    desc: 'Where tickets go and who hears about them, how task emails are sent and batched, the daily briefing, and when HR is reminded about expiring documents.' },
  { key: 'access',         label: 'Access',         Icon: Shield, adminOnly: true,
    desc: 'Who can open which module: each person\'s access, access groups, and the full access matrix. Job roles are set per company, under Company Settings.' },
  { key: 'items',          label: 'Items',          Icon: Package,
    desc: 'The catalog options used when adding items in Item Management.' },
];
const CATEGORY_KEYS = new Set(GLOBAL_CATEGORIES.map(c => c.key));
// Categories that were folded into another one - old links still land.
const LEGACY_CATEGORIES = { 'service-desk': 'notifications', tasks: 'notifications', communications: 'notifications' };

const GLOBAL_SECTIONS = [
  { id: 'email-signature', category: 'organization', icon: Signature, title: 'Email Signature',
    sub: 'Choose each company\'s signature template and set custom signatures for specific addresses. Names, titles and contact details come from each employee\'s directory record, and employees choose their own sign-off in My Profile.',
    keywords: 'template sign-off logo sender override shared inbox branding' },
  { id: 'work-sites', category: 'organization', icon: MapPinned, title: 'Work Site Library',
    sub: 'Every location employees can punch in at, with its geofence. Each company chooses its own sites from this list.',
    keywords: 'geofence location address time clock punch map' },
  { id: 'service-desk', category: 'notifications', icon: Headset, title: 'Ticket Manager',
    sub: 'Everything about tickets: who receives and escalates them, which events send email, and the response targets and ticket types requesters choose from.',
    keywords: 'tickets agents routing queue departments escalation notifications email mailbox cc reply-to auto-close delivery log sla priority hours response types intake questions fields' },
  { id: 'task-notifications', category: 'notifications', icon: Bell, title: 'Task Notifications',
    sub: 'The mailbox task emails come from, due-date reminders, how updates are batched into one email, and how email replies are posted.',
    keywords: 'email mailbox reminders overdue batch replies delivery log' },
  { id: 'daily-briefing', category: 'notifications', icon: Mail, title: 'Daily Briefing',
    sub: 'A daily summary email for each employee. Send it to everyone, or to a few test recipients first.',
    keywords: 'digest summary email morning test recipients' },
  { id: 'hr-reminders', category: 'notifications', icon: CalendarClock, title: 'HR & Compliance Reminders',
    sub: 'Choose how many days ahead HR is warned about visa and right-to-work expiry, contract ends, new starters, expiring documents and unsigned signature requests.',
    keywords: 'hr people visa right to work immigration expiry expiring contract end new starter onboarding document compliance e-sign signature chase nudge reminder days before alerts timing bell' },
  // Rendered whole (not in an accordion): it is a full screen of its own.
  { id: 'access', category: 'access', icon: Shield, title: 'People & Access Groups',
    sub: 'Each person\'s effective access, access groups that add modules on top of a job role, and the full access matrix.',
    keywords: 'roles permissions people groups modules grant level viewer editor owner matrix audit walls' },
  { id: 'item-types', category: 'items', icon: Tag, title: 'Item Types & Custom Fields',
    sub: 'The item types and extra fields available to everyone when adding or editing items.',
    keywords: 'inventory equipment catalog fields types' },
];
const SECTION_META = Object.fromEntries(GLOBAL_SECTIONS.map(s => [s.id, s]));

// Every word typed has to appear somewhere in the section's title,
// description, keywords or category name.
function sectionMatches(s, needle) {
  const cat = GLOBAL_CATEGORIES.find(c => c.key === s.category)?.label || '';
  const hay = `${s.title} ${s.sub} ${s.keywords} ${cat}`.toLowerCase();
  return needle.split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

function Section({ icon: Icon, title, sub, children, defaultOpen = false, onToggle }) {
  const [open, setOpen] = useState(defaultOpen);
  // A section that starts open still needs its lazy load to run.
  useEffect(() => { if (defaultOpen) onToggle?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', marginBottom: 12, overflow: 'hidden' }}>
      <button
        aria-expanded={open}
        onClick={() => { const next = !open; setOpen(next); if (next) onToggle?.(); }}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--paper)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Icon size={14} style={{ color: 'var(--ink)' }} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{title}</div>
          {sub && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
        </span>
        <ChevronDown size={15} style={{ color: 'var(--muted)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
      {open && <div style={{ padding: '0 18px 18px', borderTop: '1px solid var(--line)' }}><div style={{ paddingTop: 16 }}>{children}</div></div>}
    </div>
  );
}

// Branding (accent color) is NOT here - Pranshu, Sep 9: it's an individual
// employee's own choice, not an admin-team decision, so it stays in the
// header's AdminPanel drawer where it originally lived (components/AdminPanel.jsx).

// ── Item Management: types + custom fields ────────────────────────────────────
function ItemSettingsSection({ toast, defaultOpen }) {
  const [itemTypes, setItemTypes]   = useState([]);
  const [typeCounts, setTypeCounts] = useState({});
  const [customFields, setCustomFields] = useState([]);
  const [typesOpen, setTypesOpen]   = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refreshTypes = useCallback(() => { api.getItemTypes().then(setItemTypes).catch(() => {}); }, []);
  const refreshFields = useCallback(() => { api.getItemCustomFields().then(setCustomFields).catch(() => {}); }, []);

  const load = useCallback(() => {
    if (loaded) return;
    setLoaded(true);
    refreshTypes();
    refreshFields();
    api.getItems().then(items => {
      const m = {};
      for (const i of (items || [])) { const t = i.itemType || 'Other'; m[t] = (m[t] || 0) + 1; }
      setTypeCounts(m);
    }).catch(() => {});
  }, [loaded, refreshTypes, refreshFields]);

  return (
    <Section {...SECTION_META['item-types']} defaultOpen={defaultOpen} onToggle={load}>
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
    </Section>
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
];

function ServiceDeskSection({ defaultOpen }) {
  const [tab, setTab] = useState('routing');
  const [seen, setSeen] = useState(() => new Set(['routing']));
  const pick = (key) => { setTab(key); setSeen(prev => (prev.has(key) ? prev : new Set(prev).add(key))); };
  return (
    <Section {...SECTION_META['service-desk']} defaultOpen={defaultOpen}>
      <div role="tablist" aria-label="Ticket Manager" className="scroll-tabs"
        style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)', marginBottom: 16 }}>
        {SERVICE_DESK_TABS.map(({ key, label, Icon }) => {
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
      {SERVICE_DESK_TABS.filter(t => seen.has(t.key)).map(({ key, Panel }) => (
        <div key={key} role="tabpanel" hidden={key !== tab}><Panel /></div>
      ))}
    </Section>
  );
}

function TaskNotificationsSection({ defaultOpen }) {
  return (
    <Section {...SECTION_META['task-notifications']} defaultOpen={defaultOpen}>
      <Suspense fallback={<SectionFallback />}>
        <TaskNotifySettingsWrapped />
      </Suspense>
    </Section>
  );
}

// ── Daily Briefing ─────────────────────────────────────────────────────────
// Global-Admin only (see DailyBriefingSettings.jsx, which shows its own
// "access required" note to anyone else).
function DailyBriefingSection({ defaultOpen }) {
  return (
    <Section {...SECTION_META['daily-briefing']} defaultOpen={defaultOpen}>
      <DailyBriefingSettings />
    </Section>
  );
}

// ── HR & Compliance Reminders ──────────────────────────────────────────────
// Lazy: its chunk only loads when the section is opened. The panel reads its
// own edit permission from the API (canEdit) and goes read-only without it.
function HrRemindersSection({ defaultOpen }) {
  return (
    <Section {...SECTION_META['hr-reminders']} defaultOpen={defaultOpen}>
      <Suspense fallback={<SectionFallback />}>
        <HrReminderSettings />
      </Suspense>
    </Section>
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
      <div style={{ background: 'var(--card)', borderRadius: 12, maxWidth: 560, width: '100%', maxHeight: '80vh', overflow: 'auto', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, flex: 1, color: 'var(--ink)' }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ padding: 20, background: '#fff' }} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}

function EmailSignatureSection({ toastOk, toastErr, defaultOpen }) {
  const [entities, setEntities] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [companyId, setCompanyId] = useState('');
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
  const [overridesLoaded, setOverridesLoaded] = useState(false);
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

  const loadOverrides = useCallback(() => {
    if (overridesLoaded) return;
    setOverridesLoaded(true);
    api.getSignatureSenderOverrides()
      .then(d => { setOverrideTemplates(d.templates || []); setOverrides(d.senderOverrides || []); })
      .catch(() => {});
  }, [overridesLoaded]);

  const load = useCallback(() => {
    if (loaded) return;
    setLoaded(true);
    api.getEntities().then(rows => {
      setEntities(rows || []);
      if (rows?.length) { setCompanyId(rows[0].id); loadPreview(rows[0].id); }
    }).catch(() => {});
    loadOverrides();
  }, [loaded, loadPreview, loadOverrides]);

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
    <Section {...SECTION_META['email-signature']} defaultOpen={defaultOpen} onToggle={load}>
      {entities.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>{loaded ? 'No companies yet. Add one under Company Settings first.' : 'Loading…'}</div>
      ) : (
        <>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--muted)', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Company</label>
            <select className="form-input" style={{ width: '100%', maxWidth: 320 }} value={companyId} onChange={e => pickCompany(e.target.value)}>
              {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
            </select>
          </div>
          {previewBusy && !data ? (
            <Loader2 size={18} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} />
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
                {saveBusy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={14} />} Save
              </button>
            </>
          )}
        </>
      )}

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--line)' }}>
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
          {overridesSaveBusy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={14} />} Save
        </button>
      </div>

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
    </Section>
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
                {logoBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Upload size={13} />}
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
function WorkSiteLibrarySection({ toastOk, toastErr, defaultOpen }) {
  return (
    <Section {...SECTION_META['work-sites']} defaultOpen={defaultOpen}>
      <Suspense fallback={<SectionFallback />}>
        <WorkSiteLibrary toastOk={toastOk} toastErr={toastErr} />
      </Suspense>
    </Section>
  );
}

// ── Company Setup tab (Pranshu, Sep 18) - its own top-level tab, not an
// accordion popup: legal entities, and inside each one's full-screen editor,
// its departments, work sites, and (soon) holiday calendar.
function CompanySetupSection({ toastOk, toastErr }) {
  const [entities, setEntities] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [sites, setSites] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const loadEntities = useCallback(() => api.getEntities().then(setEntities).catch(() => {}), []);
  const loadSites = useCallback(() => api.getWorkSites().then(setSites).catch(() => {}), []);

  useEffect(() => {
    if (loaded) return;
    setLoaded(true);
    loadEntities();
    loadSites();
    api.getEmployees().then(rows => {
      setEmployees((rows || []).filter(e => !['guest', 'external'].includes(e.identityType || 'internal')));
    }).catch(() => {});
  }, [loaded, loadEntities, loadSites]);

  return (
    <Suspense fallback={<SkeletonBlocks count={4} height={56} borderRadius={10} />}>
      <CompanySetupPage entities={entities} employees={employees} sites={sites}
        onChangedEntities={loadEntities} onChangedSites={loadSites} toastOk={toastOk} toastErr={toastErr} />
    </Suspense>
  );
}

// Scope line at the top of Global Settings / Company Settings, so it is
// never ambiguous whether a change hits every company or just one.
function ScopeNote({ icon: Icon, title, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--paper)', marginBottom: 16 }}>
      <Icon size={15} style={{ color: 'var(--muted)', marginTop: 2, flexShrink: 0 }} />
      <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, minWidth: 0 }}>
        <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>{title}</strong> {children}
      </div>
    </div>
  );
}

// ── Global Settings ──────────────────────────────────────────────────────────
// Category rail on the left (desktop), a select on phones, and a filter box
// that searches every category at once. The selected category lives in the
// URL sub (see AdminConsole below); the filter text is local.
function GlobalSettings({ category, onCategory, toast, toastOk, toastErr }) {
  const { can } = useRole();
  const narrow = useIsMobile('(max-width: 900px)');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  // Access is administrator-only (RolesAccess and its routes say so too), so
  // it is left out of the rail and the filter for anyone else.
  const isAdmin = can('administrator');
  const categories = useMemo(() => GLOBAL_CATEGORIES.filter(c => !c.adminOnly || isAdmin), [isAdmin]);
  const sections = useMemo(() => GLOBAL_SECTIONS.filter(s => categories.some(c => c.key === s.category)), [categories]);
  const matches = useMemo(() => (needle ? sections.filter(s => sectionMatches(s, needle)) : null), [needle, sections]);
  const counts = useMemo(() => {
    if (!matches) return null;
    const m = {};
    for (const s of matches) m[s.category] = (m[s.category] || 0) + 1;
    return m;
  }, [matches]);
  const activeCat = categories.find(c => c.key === category) || categories[0];
  const pickCategory = (key) => { setQuery(''); onCategory(key); };

  const groups = matches
    ? categories.map(c => ({ cat: c, sections: matches.filter(s => s.category === c.key) })).filter(g => g.sections.length)
    : [{ cat: activeCat, sections: sections.filter(s => s.category === activeCat.key) }];
  const total = groups.reduce((n, g) => n + g.sections.length, 0);
  // A lone section opens straight away - nothing else to choose between.
  const single = total === 1;

  function renderSection(id) {
    const key = `${id}-${single}`;
    switch (id) {
      case 'email-signature':      return <EmailSignatureSection key={key} defaultOpen={single} toastOk={toastOk} toastErr={toastErr} />;
      case 'work-sites':           return <WorkSiteLibrarySection key={key} defaultOpen={single} toastOk={toastOk} toastErr={toastErr} />;
      case 'service-desk':         return <ServiceDeskSection key={key} defaultOpen={single} />;
      case 'task-notifications':   return <TaskNotificationsSection key={key} defaultOpen={single} />;
      case 'daily-briefing':       return <DailyBriefingSection key={key} defaultOpen={single} />;
      case 'hr-reminders':         return <HrRemindersSection key={key} defaultOpen={single} />;
      case 'item-types':           return <ItemSettingsSection key={key} defaultOpen={single} toast={toast} />;
      case 'access':
        return (
          <Suspense key={key} fallback={<SkeletonBlocks count={4} height={56} borderRadius={10} />}>
            <RolesAccess embedded />
          </Suspense>
        );
      default:                     return null;
    }
  }

  const filterBox = (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
      <input className="form-input" type="search" value={query} onChange={e => setQuery(e.target.value)}
        placeholder="Filter settings" aria-label="Filter settings"
        style={{ width: '100%', paddingLeft: 28, fontSize: 12.5, boxSizing: 'border-box' }} />
    </div>
  );

  const content = (
    <div style={{ minWidth: 0 }}>
      {groups.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--muted)', fontSize: 13, border: '1px dashed var(--line)', borderRadius: 10 }}>
          <div style={{ marginBottom: 12 }}>No settings match "{query.trim()}".</div>
          <button className="secondary-btn" onClick={() => setQuery('')}>Clear Filter</button>
        </div>
      ) : groups.map(g => (
        <section key={g.cat.key} style={{ marginBottom: 20 }}>
          <div style={{ marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>{g.cat.label}</h3>
            {!matches && <p style={{ margin: '3px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>{g.cat.desc}</p>}
          </div>
          {g.sections.map(s => renderSection(s.id))}
        </section>
      ))}
    </div>
  );

  return (
    <>
      <ScopeNote icon={Globe} title="Applies to every company.">
        Changes here affect everyone in Nexus. Settings for a single company are under Company Settings.
      </ScopeNote>

      {narrow ? (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <select className="form-input" aria-label="Category" value={matches ? '' : activeCat.key}
              onChange={e => e.target.value && pickCategory(e.target.value)}
              style={{ flex: '1 1 160px', minWidth: 0 }}>
              {matches && <option value="" disabled>Matching Settings</option>}
              {categories.map(c => (
                <option key={c.key} value={c.key}>{c.label}{counts ? ` (${counts[c.key] || 0})` : ''}</option>
              ))}
            </select>
            <div style={{ flex: '1 1 160px', minWidth: 0 }}>{filterBox}</div>
          </div>
          {content}
        </>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: 24, alignItems: 'start' }}>
          <nav aria-label="Global settings categories" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ marginBottom: 10 }}>{filterBox}</div>
            {categories.map(({ key, label, Icon }) => {
              const active = !matches && key === activeCat.key;
              const n = counts ? (counts[key] || 0) : null;
              return (
                <button key={key} onClick={() => pickCategory(key)} aria-current={active ? 'page' : undefined}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px',
                    borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
                    textAlign: 'left', background: active ? 'var(--wk-brand-tint)' : 'transparent',
                    color: active ? 'var(--wk-brand)' : 'var(--ink)', fontWeight: active ? 600 : 500,
                    opacity: n === 0 ? 0.45 : 1,
                  }}>
                  <Icon size={15} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
                  {n > 0 && <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>{n}</span>}
                </button>
              );
            })}
          </nav>
          {content}
        </div>
      )}
    </>
  );
}

const TOP_TABS = [
  { key: 'global',  label: 'Global Settings',  Icon: Globe },
  { key: 'company', label: 'Company Settings', Icon: Building2 },
  { key: 'tools',   label: 'Tools',            Icon: Wrench },
  { key: 'audit',   label: 'Logs',             Icon: Activity },
];

// activeSub -> { tab, category }. 'global' is the Organization category and
// 'global-<category>' the others; the old 'settings' key (bookmarks, links
// from before the split) and anything unknown land on Global Settings.
function resolveSub(sub) {
  if (!sub || sub === 'settings' || sub === 'global') return { tab: 'global', category: 'organization' };
  if (sub === 'access') return { tab: 'global', category: 'access' };
  if (sub === 'actas') return { tab: 'tools', category: 'organization' };
  if (sub.startsWith('global-')) {
    const c = LEGACY_CATEGORIES[sub.slice('global-'.length)] || sub.slice('global-'.length);
    return { tab: 'global', category: CATEGORY_KEYS.has(c) ? c : 'organization' };
  }
  return { tab: sub, category: 'organization' };
}

export default function AdminConsole({ activeSub, onSubChange }) {
  const [toast, setToast] = useState(null); // { msg, kind }
  const showToast = useCallback((msg, kind = 'success') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3000);
  }, []);
  const toastOk = useCallback((msg) => showToast(msg, 'success'), [showToast]);
  const toastErr = useCallback((msg) => showToast(msg, 'error'), [showToast]);

  const visibleTabs = TOP_TABS;
  const resolved = resolveSub(activeSub);
  const topTab = visibleTabs.some(t => t.key === resolved.tab) ? resolved.tab : 'global';
  const setTopTab = (id) => onSubChange ? onSubChange(id) : undefined;
  const setCategory = (key) => setTopTab(key === 'organization' ? 'global' : `global-${key}`);

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
            <p>Configure Nexus for the whole organization and for each company, and manage who can access what.</p>
          </div>
        </div>
      </div>

      {/* Tabs - desktop renders them centered in the top header; phones keep
          the in-page strip (ModuleTabs handles both) */}
      <ModuleTabs tabs={visibleTabs} active={topTab} onChange={setTopTab} />

      {topTab === 'company' ? (
        <>
          <ScopeNote icon={Building2} title="Applies to one company at a time.">
            Open a company to manage its profile, managers and HR contact, workforce analytics policy, departments, work sites and holiday calendar. Settings shared by every company are under Global Settings.
          </ScopeNote>
          <CompanySetupSection toastOk={toastOk} toastErr={toastErr} />
        </>
      ) : topTab === 'tools' ? (
        <Suspense fallback={<SkeletonBlocks count={3} height={120} borderRadius={12} />}>
          <SettingsTools />
        </Suspense>
      ) : topTab === 'audit' ? (
        <Suspense fallback={<SkeletonBlocks count={4} height={56} borderRadius={10} />}>
          <AuditLogs />
        </Suspense>
      ) : (
        <GlobalSettings category={resolved.category} onCategory={setCategory}
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
